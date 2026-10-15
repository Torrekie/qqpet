import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { abortReason, cloneJson, findLast, withTimeoutSignal } from '../../src/shared/compat.ts'
import { createPetInput } from '../../src/renderer/pet/input.ts'
import { visibleContent } from '../../src/mobile/visibility.ts'

// Production uses bundler resolution; these existing direct source imports
// need the same extensionless helper resolved when Node runs the tests.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '../../shared/ruffle-panic' && context.parentURL?.endsWith('/src/renderer/swf/player.ts'))
    return nextResolve(new URL('../../shared/ruffle-panic.ts', context.parentURL).href, context)
  return nextResolve(specifier, context)
} })

test('mood movie loads on first demand, shares concurrent requests and retries a failed generation', async () => {
  const instances = []
  const values = []
  class Movie {
    constructor() { instances.push(this) }
    load() { return new Promise((resolve, reject) => { this.complete = resolve; this.fail = reject }) }
    async callback(name) { assert.equal(name, 'setdata'); return value => values.push(value) }
    destroy() { this.destroyed = true }
  }
  const context = {
    SwfPlayer: Movie,
    document: { createElement: () => ({}), getElementById: () => ({ appendChild() {} }) },
  }
  const source = readFileSync(new URL('../../src/renderer/ui/float.ts', import.meta.url), 'utf8')
  runInNewContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '').replace('export async function', 'async function')) + '\nthis.floatMood = floatMood', context)
  assert.equal(instances.length, 0, 'bootstrapping the pet must not allocate a mood runtime')
  const first = context.floatMood(1)
  const second = context.floatMood(2)
  assert.equal(instances.length, 1)
  const failed = Promise.all([assert.rejects(first, /unavailable/), assert.rejects(second, /unavailable/)])
  instances[0].fail(new Error('Movie unavailable'))
  await failed
  assert.equal(instances[0].destroyed, true)

  const retry = context.floatMood(3)
  const concurrent = context.floatMood(4)
  assert.equal(instances.length, 2, 'retry requests share one replacement runtime')
  instances[1].complete()
  await Promise.all([retry, concurrent])
  await context.floatMood(5)
  assert.deepEqual(values, [3, 4, 5])
  assert.equal(instances.length, 2, 'later requests reuse the successful movie')
})

test('pet swaps after paint, retires the previous runtime and preserves its front when loading fails', async () => {
  const instances = []
  class Movie {
    constructor() {
      this.el = { style: { setProperty() {} } }
      this.waitingForPaint = new Promise(resolve => { this.beginPaint = resolve })
      instances.push(this)
    }
    setMuted(value) { this.muted = value }
    async load(url) { this.url = url; if (this.failure) throw this.failure }
    nextPaint() {
      const painted = new Promise(resolve => { this.paint = resolve })
      this.beginPaint()
      return painted
    }
    destroy() { this.destroyed = true }
  }
  const save = { settings: { sound: true } }
  const context = { save, SwfPlayer: Movie }
  const source = readFileSync(new URL('../../src/renderer/swf/pet-swf.ts', import.meta.url), 'utf8')
  runInNewContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '').replace('export class', 'class')) + '\nthis.PetSwf = PetSwf', context)
  const pet = new context.PetSwf({ isConnected: true })
  const first = pet.load('first.swf')
  await instances[1].waitingForPaint
  assert.equal(pet.front, instances[0], 'keep the previous front until the hidden canvas paints')
  assert.equal(instances[0].destroyed, undefined)
  assert.equal(instances[1].el.style.opacity, '0')
  instances[1].paint()
  await first
  assert.equal(pet.front, instances[1])
  assert.equal(pet.front.el.style.opacity, '1')
  assert.equal(instances[0].destroyed, true)
  assert.equal(instances[2].url, undefined, 'the new back element must not allocate a runtime yet')

  instances[2].failure = new Error('Movie unavailable')
  await assert.rejects(pet.load('broken.swf'), /unavailable/)
  assert.equal(instances[2].destroyed, true)
  assert.equal(pet.front, instances[1])
  assert.equal(pet.front.destroyed, undefined)
  assert.equal(pet.front.el.style.opacity, '1')

  save.settings.sound = false
  pet.applySound()
  assert.equal(instances[1].muted, true)
  assert.equal(instances[3].muted, true)
  const retry = pet.load('retry.swf')
  await instances[3].waitingForPaint
  instances[3].paint()
  await retry
  assert.equal(pet.front, instances[3])
  assert.equal(instances[1].destroyed, true)
  assert.equal(instances[4].url, undefined)
  assert.equal(instances[4].muted, true)
  assert.equal(instances.filter(movie => movie.url && !movie.destroyed).length, 1)

  let current = true
  const stale = pet.load('released-drag.swf', () => current)
  await instances[4].waitingForPaint
  current = false
  instances[4].paint()
  assert.equal(await stale, false, 'a superseded movie must not swap even after it paints')
  assert.equal(pet.front, instances[3])
  assert.equal(pet.front.destroyed, undefined)
  assert.equal(pet.front.el.style.opacity, '1')
  assert.equal(instances[4].destroyed, true)
  assert.equal(instances[5].url, undefined, 'the next request gets a fresh empty back')
})

test('JSON bridge clones remain independent and greeting search preserves its source', () => {
  const original = { pet: { name: '企鹅' }, goods: [1, 2] }
  const copy = cloneJson(original)
  copy.pet.name = 'new'
  copy.goods.push(3)
  assert.deepEqual(original, { pet: { name: '企鹅' }, goods: [1, 2] })
  const hours = [0, 6, 12, 18]
  assert.equal(findLast(hours, value => value <= 15), 12)
  assert.equal(findLast(hours, value => value < 0), undefined)
  assert.deepEqual(hours, [0, 6, 12, 18])
  assert.equal(abortReason({}).name, 'AbortError')
})

test('movie replacement releases retired GPU contexts without losing the live or paused renderer', async () => {
  const saved = Object.fromEntries(['window', 'document', 'location', 'MutationObserver'].map(key => [key, globalThis[key]]))
  const canvases = []
  let current = null
  let finishBuild
  let loads = 0
  const canvas = connected => {
    const value = { isConnected: connected, losses: 0, getContext: type => type === 'webgl2' ? gl : null }
    const gl = { isContextLost: () => value.losses > 0, getExtension: () => ({ loseContext: () => value.losses++ }) }
    canvases.push(value)
    return value
  }
  const doc = { documentElement: {}, createElement: () => ({}) }
  const api = {
    metadata: { width: 100, height: 100, frameRate: 12, numFrames: 24 },
    load() {
      if (current) current.isConnected = false
      current = canvas(element.isConnected)
      if (++loads === 1) return Promise.resolve()
      return new Promise(resolve => { finishBuild = () => {
        // A timed-out or detached async builder can still finish constructing a renderer.
        if (!element.isConnected) current = canvas(false)
        resolve()
      } })
    },
    suspend() {}, resume() {}, isPlaying: true,
  }
  const element = {
    style: {}, dataset: {}, ownerDocument: doc, isConnected: true,
    shadowRoot: { getElementById: () => null, querySelector: () => current, appendChild() {} },
    ruffle: () => api,
    remove() { this.isConnected = false; if (current) current.isConnected = false },
    disconnectedCallback() {},
  }
  doc.defaultView = { RufflePlayer: { newest: () => ({ createPlayer: () => element }) } }
  globalThis.window = {}
  globalThis.document = doc
  globalThis.location = { href: 'http://127.0.0.1/index.html' }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  let player
  try {
    const { SwfPlayer, setHostPaused } = await import('../../src/renderer/swf/player.ts')
    player = new SwfPlayer({ ownerDocument: doc, appendChild() {} })
    await player.load('first.swf')
    setHostPaused(true)
    setHostPaused(false)
    assert.equal(canvases[0].losses, 0, 'suspending a retained movie must preserve its GPU context')
    const replacement = player.load('second.swf')
    const rejected = assert.rejects(replacement, /destroyed|cancelled/)
    assert.equal(canvases[0].losses, 1, 'release the old context before the next async renderer finishes')
    assert.equal(canvases[1].losses, 0, 'the new renderer remains live')
    player.destroy()
    assert.equal(canvases[1].losses, 1)
    finishBuild()
    await rejected
    assert.deepEqual(canvases.map(value => value.losses), [1, 1, 1], 'a late detached renderer also releases its context once')
  } finally {
    finishBuild?.()
    player?.destroy()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
  }
})

test('network deadline aborts decoding and is disposed after completion', async () => {
  let completedSignal
  assert.equal(await withTimeoutSignal(5, async signal => { completedSignal = signal; return 7 }), 7)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(completedSignal.aborted, false)
  await assert.rejects(withTimeoutSignal(5, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)))
  })), { name: 'AbortError' })
})

test('native and DOM drag use one anchor/velocity path and cancellation cannot fling', () => {
  let now = 0
  let box = { x: 20, y: 30, size: 100 }
  const releases = []
  let lifts = 0
  const input = createPetInput({
    position: () => box, begin() {}, hold() {}, active() {}, clock: () => now,
    lift: size => { lifts++; return { dx: size * .73, dy: size * .14 } },
    move: (x, y) => { box = { ...box, x, y } },
    end: (...args) => releases.push(args),
  })
  input.send({ phase: 'begin', id: 1, x: 50, y: 60, source: 'native' })
  now = 20
  input.send({ phase: 'move', id: 1, x: 70, y: 80, source: 'dom' })
  assert.equal(lifts, 0, 'another route must not duplicate a native gesture')
  input.send({ phase: 'move', id: 1, x: 70, y: 80, source: 'native' })
  assert.deepEqual(box, { x: -3, y: 66, size: 100 })
  assert.equal(lifts, 1)
  input.send({ phase: 'end', id: 1, x: 70, y: 80, source: 'native' })
  assert.deepEqual(releases[0], [true, 1000, 1000, false])
  input.send({ phase: 'begin', id: 2, x: 0, y: 0, source: 'dom' })
  now = 40
  input.send({ phase: 'move', id: 2, x: 20, y: 20, source: 'dom' })
  input.cancel()
  assert.deepEqual(releases[1], [true, 0, 0, true])
  assert.equal(input.active, false)
})

test('young pet keeps its grab point and long press is cancelled by movement', async () => {
  let box = { x: 10, y: 10, size: 100 }, held = 0
  const input = createPetInput({
    position: () => box, begin() {}, active() {}, lift: () => null,
    move: (x, y) => { box = { ...box, x, y } }, end() {}, hold: () => held++,
  }, 5)
  input.send({ phase: 'begin', id: 1, x: 25, y: 25 })
  input.send({ phase: 'move', id: 1, x: 45, y: 45 })
  assert.deepEqual(box, { x: 30, y: 30, size: 100 })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(held, 0)
  input.cancel()
})

test('overlay visibility honors ancestor opacity and an explicitly visible child', () => {
  const view = { getComputedStyle: el => el.style }
  const el = { ownerDocument: { defaultView: view }, parentElement: null, getRootNode: () => ({}), getBoundingClientRect: () => ({ width: 10, height: 10 }), style: { opacity: '1', display: 'block', visibility: 'visible' } }
  assert.equal(visibleContent(el), true)
  el.parentElement = { ...el, style: { opacity: '0', display: 'block', visibility: 'visible' } }
  assert.equal(visibleContent(el), false)
  el.parentElement.style = { opacity: '1', display: 'block', visibility: 'hidden' }
  assert.equal(visibleContent(el), true, 'CSS permits a child to override inherited visibility')
  el.style.visibility = 'hidden'
  assert.equal(visibleContent(el), false)
})

test('Ruffle wrapper freezes its frame clock, keeps first-load callbacks, and cancels destroyed waits', async () => {
  const saved = Object.fromEntries(['window', 'document', 'location', 'MutationObserver', 'performance'].map(key => [key, globalThis[key]]))
  let now = 0
  const styles = []
  const doc = { documentElement: {}, createElement: () => ({}) }
  const api = { metadata: null, load: async () => { api.metadata = { width: 100, height: 100, frameRate: 10, numFrames: 100 }; element.initial = () => 1 }, suspend() {}, resume() {}, isPlaying: true }
  const element = { style: {}, dataset: {}, ownerDocument: doc, isConnected: true, shadowRoot: { getElementById: () => null, querySelector: () => null, appendChild: style => styles.push(style) }, ruffle: () => api, remove() { this.isConnected = false } }
  doc.defaultView = { RufflePlayer: { newest: () => ({ createPlayer: () => element }) } }
  globalThis.window = {}
  globalThis.document = doc
  globalThis.location = { href: 'http://127.0.0.1/index.html' }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.performance = { now: () => now }
  try {
    const { SwfPlayer, setHostPaused } = await import('../../src/renderer/swf/player.ts')
    const player = new SwfPlayer({ ownerDocument: doc, appendChild() {} })
    const initial = player.callback('initial')
    await player.load('test.swf')
    assert.equal((await initial)(), 1)
    assert.match(styles[0].textContent, /top:0;right:0;bottom:0;left:0/)
    assert.match(styles[0].textContent, /#panic-details-modal/)
    now = 1000
    assert.equal(player.currentFrame, 10)
    setHostPaused(true)
    now = 6000
    assert.equal(player.currentFrame, 10)
    setHostPaused(false)
    assert.equal(player.currentFrame, 10)
    now = 6500
    assert.equal(player.currentFrame, 15)
    const pending = player.callback('neverRegistered')
    player.destroy()
    await assert.rejects(pending, /destroyed/)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
  }
})

test('timed-out Ruffle generation is retired and a late build cannot replace its retry', async () => {
  const saved = Object.fromEntries(['window', 'document', 'location', 'MutationObserver', 'performance', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]))
  const deadlines = new Set()
  globalThis.setTimeout = (run, milliseconds, ...args) => {
    if (milliseconds !== 30_000) return saved.setTimeout(run, milliseconds, ...args)
    const timer = { run }
    deadlines.add(timer)
    return timer
  }
  globalThis.clearTimeout = timer => {
    if (!deadlines.delete(timer)) saved.clearTimeout(timer)
  }
  let completeOld
  const oldOperation = new Promise(resolve => { completeOld = resolve })
  const elements = []
  const errors = []
  const doc = { documentElement: {}, createElement: () => ({}) }
  const createPlayer = () => {
    const index = elements.length
    const api = {
      metadata: null, options: null, suspended: false,
      load(options) {
        this.options = options
        if (!index) return oldOperation
        this.metadata = { width: 120, height: 100, frameRate: 20, numFrames: 80 }
        return Promise.resolve()
      },
      suspend() { this.suspended = true }, resume() { this.suspended = false }, isPlaying: true,
    }
    const element = {
      style: {}, dataset: {}, ownerDocument: doc, isConnected: true, volume: 1, released: 0,
      shadowRoot: { getElementById: () => null, querySelector: () => null, appendChild() {} },
      ruffle: () => api,
      disconnectedCallback() { this.released++ },
      remove() { this.isConnected = false; this.disconnectedCallback() },
    }
    elements.push(element)
    return element
  }
  doc.defaultView = { RufflePlayer: { newest: () => ({ createPlayer }) } }
  globalThis.window = { dispatchEvent: event => errors.push(event) }
  globalThis.document = doc
  globalThis.location = { href: 'http://127.0.0.1/index.html' }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.performance = { now: () => 0 }
  const parent = { ownerDocument: doc, appendChild() {} }
  let retry
  try {
    const { SwfPlayer } = await import('../../src/renderer/swf/player.ts')
    const original = new SwfPlayer(parent)
    const failed = original.load('old.swf')
    const rejected = assert.rejects(failed, /timed out/)
    deadlines.values().next().value.run()
    await rejected
    assert.equal(original.el.isConnected, false)
    assert.equal(errors[0].type, 'qqpet-swf-error')
    assert.deepEqual(errors[0].detail, { url: 'old.swf', message: 'SWF load timed out' })
    await assert.rejects(original.load('new.swf'), /destroyed/)

    retry = new SwfPlayer(parent)
    await retry.load('new.swf', './replacement/', { wmode: 'opaque', parameters: { mode: 'new' } })
    const active = retry.el
    assert.notEqual(active, original.el)
    assert.equal(active.ruffle().options.wmode, 'opaque')
    assert.deepEqual(active.ruffle().options.parameters, { mode: 'new' })
    assert.equal(active.ruffle().options.base, 'http://127.0.0.1/replacement/')
    assert.equal(active.ruffle().options.fontSources[0], 'http://127.0.0.1/pet/qqfont.ttf')

    original.el.ruffle().metadata = { width: 1, height: 1, frameRate: 1, numFrames: 1 }
    completeOld()
    await oldOperation
    await Promise.resolve()
    assert.equal(original.el.volume, 0)
    assert.equal(original.el.ruffle().suspended, true)
    assert.equal(original.el.released, 2, 'release the instance created after its first disconnect')
    assert.equal(retry.el, active)
    assert.equal(retry.totalFrames, 80)
    assert.equal(active.isConnected, true)
  } finally {
    completeOld()
    retry?.destroy()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
  }
})
