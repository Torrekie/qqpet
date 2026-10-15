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

function removedCanvasFixture(t) {
  const observers = []
  let current = null
  let finishLoad
  class Observer {
    records = []
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.target = target; this.connected = true }
    takeRecords() { return this.records.splice(0) }
    disconnect() { this.connected = false; this.records.length = 0 }
    notify() { const records = this.takeRecords(); if (this.connected && records.length) this.callback(records) }
  }
  const document = { documentElement: {}, createElement: () => ({}) }
  const root = { getElementById: () => null, appendChild() {},
    querySelector: selector => selector === '#container > canvas' ? current : null }
  const api = {
    metadata: { width: 100, height: 100, frameRate: 12, numFrames: 24 },
    load: async () => {}, suspend() {}, resume() {}, isPlaying: true,
  }
  const shadowObserver = () => observers.find(observer => observer.target === root)
  const detachCanvas = () => {
    const canvas = current
    if (canvas) {
      canvas.isConnected = false
      current = null
      shadowObserver().records.push({ removedNodes: [canvas] })
    }
    return canvas
  }
  const element = {
    style: {}, dataset: {}, ownerDocument: document, isConnected: true, shadowRoot: root,
    ruffle: () => api,
    // Match Ruffle's synchronous disconnectedCallback -> Rust Drop -> canvas.remove.
    // By the time the outer document observer runs, shadow queries find nothing.
    disconnectedCallback() { detachCanvas() },
    remove() { this.isConnected = false; this.disconnectedCallback() },
  }
  document.defaultView = { RufflePlayer: { newest: () => ({ createPlayer: () => element }) } }
  const context = {
    document, window: {}, location: { href: 'http://example.test/index.html' },
    MutationObserver: Observer, readPlayerPanic: () => null, isFatalRufflePanic: () => false,
    URL, performance, setTimeout, clearTimeout,
  }
  const source = readFileSync(new URL('../../src/renderer/swf/player.ts', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export (?=class|function)/g, '')
  runInNewContext(stripTypeScriptTypes(source) + '\nthis.SwfPlayer=SwfPlayer', context)
  const player = new context.SwfPlayer({ ownerDocument: document, appendChild() {} })
  t.after(() => player.destroy())
  const canvas = { nodeType: 1, tagName: 'CANVAS', isConnected: true, losses: 0,
    querySelectorAll: () => [], getContext: type => type === 'webgl2' ? gl : null }
  const gl = { isContextLost: () => canvas.losses > 0, getExtension: () => ({ loseContext: () => canvas.losses++ }) }
  api.load = () => { current = canvas; return new Promise(resolve => { finishLoad = resolve }) }
  return {
    player, canvas, root,
    finishLoad: () => finishLoad(), detachCanvas,
    parentRemove() {
      element.remove()
      observers.find(observer => observer.target === document.documentElement).records.push({ removedNodes: [element] })
    },
    notify: () => observers.forEach(observer => observer.notify()),
    notifyShadow: () => shadowObserver().notify(),
    reinsert() { current = canvas; canvas.isConnected = true },
    shadowObserver,
  }
}

test('parent-first removal releases the canvas after Ruffle has already removed it from its shadow', async t => {
  const f = removedCanvasFixture(t)
  const loading = f.player.load('panel.swf')
  f.finishLoad()
  await loading
  f.parentRemove()
  assert.equal(f.root.querySelector('#container > canvas'), null)
  assert.equal(f.canvas.losses, 0)
  // Observers are delivered in creation order: document before the player's shadow.
  // destroy must drain shadow records before disconnect would discard them.
  f.notify()
  assert.equal(f.canvas.losses, 1)
  assert.equal(f.shadowObserver().connected, false)
  f.player.destroy()
  assert.equal(f.canvas.losses, 1)
})

test('in-flight and panic canvas removals release GPU state, while a reinserted live canvas is kept', async t => {
  const pending = removedCanvasFixture(t)
  const loading = pending.player.load('unfinished.swf')
  const rejected = assert.rejects(loading, /destroyed|cancelled/)
  pending.parentRemove()
  assert.equal(pending.root.querySelector('#container > canvas'), null)
  pending.notify()
  assert.equal(pending.canvas.losses, 1, 'no successful load exists from which to cache this canvas')
  pending.finishLoad()
  await rejected

  const panic = removedCanvasFixture(t)
  const ready = panic.player.load('panic.swf')
  panic.finishLoad()
  await ready
  panic.detachCanvas()
  panic.notifyShadow()
  assert.equal(panic.canvas.losses, 1, 'a panic can remove the canvas while its player stays connected')
  panic.player.destroy()
  assert.equal(panic.canvas.losses, 1)

  const live = removedCanvasFixture(t)
  const reloaded = live.player.load('live.swf')
  live.finishLoad()
  await reloaded
  live.detachCanvas()
  live.reinsert()
  live.notifyShadow()
  assert.equal(live.canvas.losses, 0, 'a removed record alone does not make a connected canvas retired')
  live.player.destroy()
  assert.equal(live.canvas.losses, 1)
})

function contextRecoveryFixture(t, recoverContext = true, nativePetInput = false) {
  const events = [], calls = [], loads = [], instances = [], timers = new Map(), listeners = new Map()
  let current = null, instance = null, deferred = false, delayedCallbacks = false, complete = null, now = 0, failure = null
  const document = { documentElement: {}, createElement: () => ({}) }
  const root = {
    getElementById: () => null, appendChild() {},
    querySelector: () => current,
    addEventListener(name, callback, capture) { assert.equal(capture, true); listeners.set(name, callback) },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name) },
  }
  function retire() {
    if (instance) instance.alive = false
    if (current) current.isConnected = false
    current = null
  }
  function createCanvas() {
    const canvas = { isConnected: element.isConnected, lost: false, losses: 0,
      getContext: type => type === 'webgl2' ? gl : null }
    const gl = { isContextLost: () => canvas.lost,
      getExtension: () => ({ loseContext() { canvas.lost = true; canvas.losses++ } }) }
    return canvas
  }
  const api = {
    metadata: null, suspended: false, isPlaying: true,
    load(options) {
      retire()
      loads.push(options)
      const fresh = { id: instances.length + 1, alive: true, register: null }
      instances.push(fresh); instance = fresh; current = createCanvas(); this.metadata = null; this.suspended = false
      if (failure) { const error = failure; failure = null; return Promise.reject(error) }
      const register = () => {
        element.speak = (...args) => {
          assert.equal(fresh.alive, true, 'a retired Rust callback must never be invoked')
          calls.push({ generation: fresh.id, args })
        }
      }
      const finish = () => {
        if (!element.isConnected) { current = createCanvas(); fresh.alive = true }
        this.metadata = { width: 100, height: 100, frameRate: 12, numFrames: 24 }
        if (delayedCallbacks) { fresh.register = register; delayedCallbacks = false }
        else register()
      }
      if (deferred) {
        deferred = false
        return new Promise(resolve => { complete = () => { finish(); complete = null; resolve() } })
      }
      finish()
      return Promise.resolve()
    },
    suspend() { this.suspended = true },
    resume() { this.suspended = false; if (instance?.register) { const run = instance.register; instance.register = null; run() } },
  }
  const element = {
    style: {}, dataset: {}, ownerDocument: document, isConnected: true, shadowRoot: root,
    ruffle: () => api, disconnectedCallback: retire,
    remove() { this.isConnected = false; retire() },
  }
  document.defaultView = { RufflePlayer: { newest: () => ({ createPlayer: () => element }) } }
  const context = {
    document, window: { __qqpetNativePetInput: nativePetInput, dispatchEvent: event => events.push(event) }, location: { href: 'http://example.test/index.html' },
    MutationObserver: class { observe() {} disconnect() {} },
    readPlayerPanic: () => null, isFatalRufflePanic: () => false,
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail } },
    URL, performance: { now: () => now },
    setTimeout(run, ms) { const timer = setTimeout(run, ms); timers.set(timer, ms); return timer },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer) },
  }
  const source = readFileSync(new URL('../../src/renderer/swf/player.ts', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export (?=class|function)/g, '')
  runInNewContext(stripTypeScriptTypes(source) + '\nthis.SwfPlayer=SwfPlayer;this.setHostPaused=setHostPaused', context)
  const player = new context.SwfPlayer({ ownerDocument: document, appendChild() {} }, { recoverContext })
  t.after(() => { player.destroy(); for (const timer of timers.keys()) clearTimeout(timer) })
  return {
    player, element, api, loads, instances, calls, events, timers,
    get canvas() { return current },
    lose(canvas = current) { canvas.lost = true; listeners.get('webglcontextlost')?.({ target: canvas }) },
    deferNext() { deferred = true }, delayCallbacks() { delayedCallbacks = true },
    rejectNext(error) { failure = error },
    complete() { assert.ok(complete); complete() },
    setPaused: context.setHostPaused, advance: milliseconds => { now += milliseconds },
    async settle() { for (let i = 0; i < 30; i++) await Promise.resolve() },
  }
}

test('only native iOS persistent players prefer WebGL and explicit renderer options still win', async t => {
  const native = contextRecoveryFixture(t, true, true)
  await native.player.load('pet.swf')
  assert.equal(native.loads[0].preferredRenderer, 'webgl')
  native.lose(); await native.settle()
  assert.equal(native.loads[1].preferredRenderer, 'webgl', 'context recovery keeps the host renderer policy')
  await native.player.load('override.swf', './', { preferredRenderer: 'canvas' })
  assert.equal(native.loads[2].preferredRenderer, 'canvas')
  native.lose(); await native.settle()
  assert.equal(native.loads[3].preferredRenderer, 'canvas', 'recovery also retains an explicit override')

  const game = contextRecoveryFixture(t, false, true)
  await game.player.load('game.swf')
  assert.equal(Object.hasOwn(game.loads[0], 'preferredRenderer'), false, 'ordinary games retain the Ruffle default')
  const otherPlatform = contextRecoveryFixture(t, true, false)
  await otherPlatform.player.load('pet.swf')
  assert.equal(Object.hasOwn(otherPlatform.loads[0], 'preferredRenderer'), false, 'other platform hosts retain the Ruffle default')
  const nonBoolean = contextRecoveryFixture(t, true, 1)
  await nonBoolean.player.load('pet.swf')
  assert.equal(Object.hasOwn(nonBoolean.loads[0], 'preferredRenderer'), false, 'the native host flag must be explicitly true')
})

test('opt-in context loss synchronously retires Rust, rebuilds and replays only the latest callback', async t => {
  const f = contextRecoveryFixture(t)
  await f.player.load('bubble.swf', './skins/', { parameters: { skin: 2 } })
  const speak = await f.player.callback('speak')
  speak('before', [])
  const oldCanvas = f.canvas
  f.deferNext()
  f.lose()
  assert.equal(f.instances[0].alive, false, 'destroy the old instance in the context-loss event stack')
  assert.equal(f.loads.length, 2)
  assert.equal(f.player.isRecovering, true)
  assert.notEqual(f.canvas, oldCanvas)
  speak('latest', ['button'])
  assert.equal(f.calls.length, 1, 'a function obtained before loss must not call the retired instance')
  f.complete()
  await f.settle()
  assert.equal(f.player.isRecovering, false)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1], { generation: 2, args: ['latest', ['button']] })
  assert.equal(f.loads[1].url, f.loads[0].url)
  assert.equal(f.loads[1].base, f.loads[0].base)
  assert.equal(f.loads[1].parameters.skin, 2)
  speak('after', [])
  assert.equal(f.calls.at(-1).generation, 2)

  f.deferNext()
  const replacement = f.player.load('different.swf')
  assert.equal(f.element.speak, undefined, 'normal replacement must delete the replayed generation callback')
  f.complete()
  await replacement
  assert.throws(() => speak('stale', []), /replaced|destroyed/)
})

test('context recovery defers missing callbacks while host-paused and preserves explicit stop', async t => {
  const f = contextRecoveryFixture(t)
  await f.player.load('bubble.swf')
  ;(await f.player.callback('speak'))('retained', [])
  f.player.stop()
  f.setPaused(true)
  f.delayCallbacks()
  f.lose()
  await f.settle()
  assert.equal(f.player.isRecovering, true)
  assert.equal(f.api.suspended, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0, 'waiting for foreground must not consume the callback timeout')
  f.advance(60_000)
  f.setPaused(false)
  await f.settle()
  assert.equal(f.player.isRecovering, false)
  assert.equal(f.calls[1].generation, 2)
  assert.equal(f.api.suspended, true, 'the explicit stop survives initialization and callback replay')
  assert.equal(f.player.isPlaying, false)
})

test('retired/removed canvas losses and non-opt-in games never start recovery', async t => {
  const f = contextRecoveryFixture(t)
  await f.player.load('first.swf')
  const old = f.canvas
  await f.player.load('second.swf')
  f.lose(old)
  assert.equal(f.loads.length, 2)
  const removed = f.canvas
  f.element.remove()
  f.lose(removed)
  assert.equal(f.loads.length, 2)

  const game = contextRecoveryFixture(t, false)
  await game.player.load('game.swf')
  game.lose()
  assert.equal(game.loads.length, 1)
  assert.equal(game.player.isRecovering, false)
})

test('loading loss and explicit replacement/destroy cancel recovery without late resurrection', async t => {
  const partial = contextRecoveryFixture(t)
  partial.deferNext()
  const first = partial.player.load('unfinished.swf')
  const rejected = assert.rejects(first, /lost while loading/)
  partial.lose()
  assert.equal(partial.instances[0].alive, false)
  assert.equal(partial.element.isConnected, false)
  partial.complete()
  await rejected
  await partial.settle()
  assert.equal(partial.instances[0].alive, false)
  assert.equal(partial.events.length, 1)
  assert.equal(partial.events[0].detail.terminal, undefined, 'an initial back load failure must remain recoverable by its consumer')

  for (const action of ['replace', 'destroy']) {
    const f = contextRecoveryFixture(t)
    await f.player.load('bubble.swf')
    ;(await f.player.callback('speak'))('before', [])
    f.deferNext(); f.lose()
    if (action === 'replace') await assert.rejects(f.player.load('replacement.swf'), /unfinished/)
    else f.player.destroy()
    f.complete()
    await f.settle()
    assert.equal(f.loads.length, 2)
    assert.equal(f.player.isRecovering, false)
    assert.equal(f.element.isConnected, false)
    assert.equal(f.instances.at(-1).alive, false)
    assert.equal(f.calls.length, 1, 'a cancelled recovery must not replay into a late builder')
    assert.equal(f.events.length, 0, 'explicit replacement or removal must not stop the host')
  }

  const replay = contextRecoveryFixture(t)
  await replay.player.load('bubble.swf')
  ;(await replay.player.callback('speak'))('before', [])
  replay.setPaused(true); replay.delayCallbacks(); replay.lose()
  await replay.settle()
  assert.equal(replay.player.isRecovering, true)
  await replay.player.load('replacement.swf')
  await replay.settle()
  replay.setPaused(false)
  await replay.settle()
  assert.equal(replay.element.isConnected, true, 'cancelling old replay must not destroy a newer successful movie')
  assert.equal(replay.instances.at(-1).alive, true)
  assert.equal(replay.player.isRecovering, false)
  assert.equal(replay.calls.length, 1)
})

test('repeated losses stop after three recoveries per thirty seconds', async t => {
  const f = contextRecoveryFixture(t)
  await f.player.load('bubble.swf')
  for (let i = 0; i < 3; i++) {
    f.lose(); await f.settle()
    assert.equal(f.player.isRecovering, false)
  }
  assert.equal(f.loads.length, 4)
  f.lose()
  assert.equal(f.loads.length, 4, 'the limit must retire the failed renderer without starting another builder')
  assert.equal(f.element.isConnected, false)
  assert.equal(f.instances.at(-1).alive, false)
  assert.match(f.events[0].detail.message, /recovery limit/)
  assert.equal(f.events[0].detail.terminal, 'context-recovery-exhausted')
  assert.equal(f.events.length, 1)
  await assert.rejects(f.player.load('again.swf'), /destroyed/)
})

test('a recovery load rejection reports one terminal failure even after it destroys the player', async t => {
  const f = contextRecoveryFixture(t)
  await f.player.load('bubble.swf')
  f.rejectNext(new Error('Renderer rebuild failed'))
  f.lose()
  await f.settle()
  assert.equal(f.element.isConnected, false)
  assert.equal(f.player.isRecovering, false)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].detail.terminal, 'context-recovery-failed')
  assert.match(f.events[0].detail.message, /Renderer rebuild failed/)
})

test('losing a rebuilding context reports one terminal failure and retires the late builder', async t => {
  const f = contextRecoveryFixture(t)
  await f.player.load('bubble.swf')
  f.deferNext(); f.lose(); f.lose()
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].detail.terminal, 'context-recovery-failed')
  f.complete()
  await f.settle()
  assert.equal(f.events.length, 1, 'the cancelled outer recovery cannot report the same failure again')
  assert.equal(f.instances.at(-1).alive, false)
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

test('failed overlay readback stays conservative, throttles retries and recovers its sampled bounds', () => {
  let clock = 1000
  let attempts = 0
  let fail = false
  const pixels = new Uint8ClampedArray(64 * 64 * 4)
  pixels[(20 * 64 + 20) * 4 + 3] = 255
  const pen = {
    clearRect() {},
    drawImage() { attempts++; clock += 3; if (fail) throw new Error('Canvas readback unavailable') },
    getImageData: () => ({ data: pixels }),
  }
  class Canvas { getContext() { return pen } }
  const box = { left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 }
  const player = {
    id: '', tagName: 'RUFFLE-PLAYER', dataset: { swf: 'animated.swf' },
    getBoundingClientRect: () => box, closest: () => ({}), matches: () => false,
    shadowRoot: { querySelector: () => ({}) }, ruffle: () => ({ metadata: { numFrames: 1, frameRate: 12 } }),
  }
  const context = {
    document: { createElement: () => new Canvas() }, HTMLCanvasElement: Canvas,
    visibleContent: () => true, performance: { now: () => clock },
  }
  const source = readFileSync(new URL('../../src/mobile/overlay.ts', import.meta.url), 'utf8')
  runInNewContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '').replace(/export (?=interface|function)/g, '')) + '\nthis.cover=cover;this.coverageTiming=coverageTiming', context)
  assert.notEqual(context.cover(player), box, 'the successful sample finds a narrower painted region')
  assert.equal(attempts, 1)
  assert.equal(context.coverageTiming().lastReadbackMs, 3)

  fail = true
  clock = 1200
  assert.equal(context.cover(player), box)
  for (clock = 1216; clock < 1350; clock += 16) assert.equal(context.cover(player), box, 'failure must not reuse the earlier narrow sample')
  assert.equal(attempts, 2, 'adjacent animation frames must not repeat a failed readback')
  assert.equal(context.coverageTiming().readbackFailures, 1)
  clock = 1351
  assert.equal(context.cover(player), box)
  assert.equal(attempts, 3)
  assert.equal(context.coverageTiming().readbackFailures, 2)

  fail = false
  clock = 1367
  assert.equal(context.cover(player), box, 'recovery also waits for the retry interval')
  clock = 1502
  assert.notEqual(context.cover(player), box)
  assert.equal(attempts, 4)
  assert.equal(context.coverageTiming().readbackFailures, 2)
})

function geometryFixture() {
  let now = 1000, nextFrame = 0
  const frames = new Map(), messages = [], reads = new Map()
  let currentCanvas
  const pen = {
    clearRect() {},
    drawImage(canvas) {
      currentCanvas = canvas
      reads.set(canvas, (reads.get(canvas) ?? 0) + 1)
      if (canvas.fail) throw new Error('Readback unavailable')
    },
    getImageData() {
      const data = new Uint8ClampedArray(64 * 64 * 4)
      const a = currentCanvas.alpha
      if (a) for (let y = a.top; y < a.bottom; y++) for (let x = a.left; x < a.right; x++) data[(y * 64 + x) * 4 + 3] = 255
      return { data }
    },
  }
  class Canvas { getContext() { return pen } }
  const document = { defaultView: { getComputedStyle: el => el.style }, createElement: () => new Canvas(), addEventListener() {}, removeEventListener() {} }
  const element = (id, tagName, box, parentElement = null) => ({
    id, tagName, parentElement, ownerDocument: document, getRootNode: () => ({}),
    style: { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', backgroundImage: '' },
    getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }),
    closest(selector) { return selector === '#pet' ? (id === 'pet' ? this : parentElement?.closest(selector) ?? null) : null },
    matches: selector => selector === '.point' && id === 'point',
  })
  const pet = element('pet', 'DIV', { left: 100, top: 100, width: 160, height: 160 })
  const movie = (name, parent, alpha) => {
    const el = element('', 'RUFFLE-PLAYER', { left: 100, top: 100, width: 160, height: 160 }, parent)
    el.dataset = { swf: name }
    el.canvas = { alpha }
    el.metadata = { numFrames: 240, frameRate: 12 }
    el.shadowRoot = { querySelector: () => el.canvas }
    el.ruffle = () => ({ metadata: el.metadata })
    return el
  }
  const front = movie('peek.swf', pet, { left: 0, top: 16, right: 8, bottom: 56 })
  const back = movie('incoming.swf', pet, { left: 0, top: 0, right: 64, bottom: 64 })
  back.style.opacity = '0'
  const decoration = element('mood', 'DIV', { left: 100, top: 100, width: 160, height: 160 }, pet)
  const mood = movie('mood.swf', decoration, { left: 0, top: 0, right: 64, bottom: 64 })
  mood.style.opacity = '0'
  const point = element('point', 'DIV', { left: 140, top: 180, width: 10, height: 10 }, pet)
  const toolbar = element('toolbar', 'DIV', { left: 200, top: 300, width: 0, height: 0 })
  const button = element('button', 'BUTTON', { left: 200, top: 300, width: 30, height: 30 }, toolbar)
  const menu = element('menu', 'DIV', { left: 400, top: 200, width: 100, height: 100 })
  const controls = [point, toolbar, button, menu]
  for (const el of controls) el.style.display = 'none'
  const all = [pet, front, back, decoration, mood, ...controls]
  document.body = { querySelectorAll: selector => selector === '*' ? all : [front, back, mood, ...controls] }
  const context = {
    document, window: {}, HTMLCanvasElement: Canvas, visibleContent,
    performance: { now: () => now }, getComputedStyle: el => el.style,
    innerWidth: 1000, innerHeight: 800,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id),
  }
  const overlay = readFileSync(new URL('../../src/mobile/overlay.ts', import.meta.url), 'utf8')
  const geometry = readFileSync(new URL('../../src/ios/geometry.ts', import.meta.url), 'utf8')
  const source = [overlay, geometry].map(code => stripTypeScriptTypes(code.replace(/^import .*$/gm, '').replace(/^export /gm, ''))).join('\n')
  // Both modules share a realm, just as the production geometry imports the
  // overlay's cached sampler. JSON snapshots normalize cross-realm prototypes.
  const fixtureContext = { ...context, messages }
  runInNewContext(source + '\nthis.geometry=startGeometry({notify:(op,args)=>messages.push({op,args})})', fixtureContext)
  return {
    front, back, mood, pet, point, button, menu, reads, geometry: fixtureContext.geometry,
    frame(ms = 16) {
      now += ms
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
      return JSON.parse(JSON.stringify(messages.at(-1).args))
    },
    controls(on) { for (const el of controls) el.style.display = on ? 'block' : 'none' },
  }
}

test('iOS peeking uses the current alpha box without another readback or waiting for the full movie', () => {
  const f = geometryFixture()
  let payload = f.frame()
  assert.equal(payload.dragRegions.length, 1)
  assert.ok(payload.dragRegions[0].width < 32, 'a thin peek must not retain its 160px SWF input box')
  assert.ok(payload.bounds.width >= 160, 'the visual crop remains conservative for unseen later frames')
  assert.equal(f.reads.get(f.front.canvas), 1, 'drawing and hit bounds reuse the same sample')
  assert.equal(f.reads.get(f.back.canvas), undefined, 'an opacity-zero incoming movie is not sampled')
  const left = payload.dragRegions[0].x
  f.front.canvas.alpha = { left: 56, top: 16, right: 64, bottom: 56 }
  f.frame(16)
  assert.equal(f.reads.get(f.front.canvas), 1)
  payload = f.frame(151)
  assert.equal(f.reads.get(f.front.canvas), 2)
  assert.ok(payload.dragRegions[0].x > left + 100, 'the live hit box follows the latest edge rather than a movie-wide union')
  f.front.canvas.alpha = null
  payload = f.frame(151)
  assert.deepEqual(payload.dragRegions, [], 'an empty sampled frame does not swallow the old pet rectangle')
  f.geometry.stop()
})

test('iOS unknown or hidden movies do not claim an empty SWF box; read failures keep only the last alpha hit', () => {
  const f = geometryFixture()
  const first = f.frame().dragRegions
  f.front.canvas.fail = true
  assert.deepEqual(f.frame(151).dragRegions, first)
  f.front.metadata = null
  assert.deepEqual(f.frame().dragRegions, [], 'metadata not ready must not become a full pet drag target')
  f.front.style.opacity = '0'
  f.back.style.opacity = '1'
  f.back.canvas = null
  assert.deepEqual(f.frame().dragRegions, [], 'a loading front without pixels must not capture its empty layout box')
  f.geometry.stop()
})

test('iOS keeps point and overflowing control regions separate and captures an existing drag across blank space', () => {
  const f = geometryFixture()
  f.controls(true)
  f.mood.style.opacity = '1'
  let payload = f.frame()
  assert.equal(payload.dragRegions.length, 1, 'the decorative mood renderer is not a pet drag target')
  assert.ok(payload.interactiveRegions.some(r => r.x === 140 && r.width === 10), 'face points keep their own input region')
  assert.ok(payload.interactiveRegions.some(r => r.x === 200 && r.width === 30), 'overflowing children of a zero-sized toolbar remain interactive')
  assert.ok(payload.interactiveRegions.some(r => r.x === 400 && r.width === 100), 'menus remain interactive across the visual crop')
  f.geometry.pointer({ phase: 'begin', id: 1, x: 110, y: 160 })
  f.geometry.pointer({ phase: 'move', id: 1, x: 800, y: 700 })
  payload = f.frame()
  assert.equal(payload.dragging, true)
  assert.deepEqual(payload.bounds, { x: 0, y: 0, width: 1000, height: 800 })
  f.geometry.pointer({ phase: 'end', id: 1, x: 800, y: 700 })
  payload = f.frame()
  assert.equal(payload.dragging, false)
  assert.ok(payload.bounds.width < 1000)
  f.geometry.stop()
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
