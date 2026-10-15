import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { isFatalRufflePanic, readPlayerPanic, readRufflePanic } from '../../src/shared/ruffle-panic.ts'

const playerSource = readFileSync(new URL('../../src/renderer/swf/player.ts', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL('../../src/ios/bridge.ts', import.meta.url), 'utf8')
const details = message => `# Error Info\nError name: Error\nError message: ${message}\nError stack:\noriginal stack`

function movieFixture() {
  const events = [], observers = []
  let panic = null
  const root = {
    getElementById: () => null, appendChild() {},
    querySelector(selector) {
      if (selector === '#panic-details-content textarea') return panic ? { value: panic } : null
      if (selector === '#panic-title') return { textContent: 'Ruffle error' }
      return null
    },
  }
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
  }
  const api = {
    metadata: { width: 100, height: 100, frameRate: 12, numFrames: 24 },
    load: async () => {}, suspend() {}, resume() {}, isPlaying: true,
  }
  const document = { documentElement: {}, createElement: () => ({}) }
  const element = {
    dataset: {}, style: {}, shadowRoot: root, ownerDocument: document,
    isConnected: true, ruffle: () => api,
    remove() { this.isConnected = false; panic = null }, disconnectedCallback() {},
  }
  document.defaultView = { RufflePlayer: { newest: () => ({ createPlayer: () => element }) } }
  const window = { dispatchEvent: event => { events.push({ ...event, connected: element.isConnected }) } }
  const context = {
    document, window, location: { href: 'http://example.test/index.html' },
    MutationObserver: Observer, isFatalRufflePanic, readPlayerPanic,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    URL, performance, setTimeout, clearTimeout,
  }
  const source = playerSource.replace(/^import .*$/gm, '').replace(/export (?=class|function)/g, '')
  runInNewContext(stripTypeScriptTypes(source) + '\nthis.SwfPlayer=SwfPlayer', context)
  const movie = new context.SwfPlayer({ ownerDocument: document, appendChild() {} })
  return { movie, element, api, events, setPanic: value => { panic = value },
    observePanic: () => observers.find(observer => observer.target === root).callback(),
    panicObserver: () => observers.find(observer => observer.target === root),
  }
}

function listenerFixture() {
  class Target {
    entries = []
    addEventListener(type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
      if (!this.entries.some(entry => entry.type === type && entry.listener === listener && entry.capture === capture))
        this.entries.push({ type, listener, capture })
    }
    removeEventListener(type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
      this.entries = this.entries.filter(entry => entry.type !== type || entry.listener !== listener || entry.capture !== capture)
    }
  }
  const document = new Target(), view = new Target(), root = new Target()
  document.documentElement = root
  document.defaultView = view
  // Restore an existing own descriptor as well as inherited native methods.
  Object.defineProperty(root, 'addEventListener', { value: root.addEventListener, configurable: true, writable: false, enumerable: true })
  const descriptors = [document, root, view].map(target => Object.getOwnPropertyDescriptor(target, 'addEventListener'))
  let failCreate = false, failAppend = false, duringCreate = () => {}
  const elements = []
  view.RufflePlayer = { newest: () => ({ createPlayer() {
    const listener = () => {}
    document.addEventListener('visibilitychange', listener)
    root.addEventListener('pointerdown', listener)
    root.addEventListener('pointerdown', listener, { capture: true })
    view.addEventListener('resize', { handleEvent() {} })
    duringCreate()
    if (failCreate) throw new Error('Ruffle constructor failed')
    const el = { style: {}, dataset: {}, shadowRoot: null, ownerDocument: document, isConnected: false,
      remove() { this.isConnected = false } }
    elements.push(el)
    return el
  } }) }
  const parent = { ownerDocument: document, appendChild(el) {
    el.isConnected = true
    if (failAppend) throw new Error('Ruffle append failed')
  } }
  const context = {
    window: { dispatchEvent() {} }, document,
    MutationObserver: class { observe() {} },
    location: { href: 'http://example.test/index.html' }, URL, performance, setTimeout, clearTimeout,
    readPlayerPanic, isFatalRufflePanic,
  }
  const source = playerSource.replace(/^import .*$/gm, '').replace(/export (?=class|function)/g, '')
  runInNewContext(stripTypeScriptTypes(source) + '\nthis.SwfPlayer=SwfPlayer', context)
  return { targets: [document, root, view], descriptors, elements,
    create: () => new context.SwfPlayer(parent),
    failCreate: () => { failCreate = true }, failAppend: () => { failAppend = true },
    duringCreate: callback => { duringCreate = callback },
  }
}

test('destroy removes only its constructor global listeners and restores target descriptors immediately', () => {
  const f = listenerFixture()
  const first = f.create(), sibling = f.create()
  assert.deepEqual(f.targets.map(target => target.entries.length), [2, 4, 2])
  for (let index = 0; index < f.targets.length; index++)
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.targets[index], 'addEventListener'), f.descriptors[index])
  first.destroy()
  assert.deepEqual(f.targets.map(target => target.entries.length), [1, 2, 1])
  first.destroy()
  assert.deepEqual(f.targets.map(target => target.entries.length), [1, 2, 1], 'cleanup is idempotent and leaves the sibling alive')
  sibling.destroy()
  assert.deepEqual(f.targets.map(target => target.entries.length), [0, 0, 0])
})

test('constructor and append failures clean global registrations and restore descriptors', () => {
  for (const failure of ['failCreate', 'failAppend']) {
    const f = listenerFixture()
    f[failure]()
    assert.throws(() => f.create(), /Ruffle (constructor|append) failed/)
    assert.deepEqual(f.targets.map(target => target.entries.length), [0, 0, 0])
    assert.ok(f.elements.every(element => !element.isConnected))
    for (let index = 0; index < f.targets.length; index++)
      assert.deepEqual(Object.getOwnPropertyDescriptor(f.targets[index], 'addEventListener'), f.descriptors[index])
  }
})

test('nested construction keeps each player global listener ownership separate', () => {
  const f = listenerFixture()
  let sibling
  f.duringCreate(() => { f.duringCreate(() => {}); sibling = f.create() })
  const first = f.create()
  first.destroy()
  assert.deepEqual(f.targets.map(target => target.entries.length), [1, 2, 1])
  sibling.destroy()
  assert.deepEqual(f.targets.map(target => target.entries.length), [0, 0, 0])
})

test('a failed load publishes its original panic before removing the shadow DOM', async () => {
  const f = movieFixture()
  const original = details('panicked at core/src/player.rs: first failure')
  f.api.load = async () => { f.setPanic(original); throw new Error('secondary stream_from failure') }
  await assert.rejects(f.movie.load('pet.swf'), /secondary/)
  const panic = f.events.find(event => event.type === 'qqpet-ruffle-panic')
  assert.equal(panic.connected, true)
  assert.equal(panic.detail.details, original)
  assert.equal(panic.detail.fatal, true)
  assert.equal(f.element.isConnected, false)
  assert.equal(f.panicObserver().disconnected, true)
})

test('an already running movie reports panic once without waiting for a save or another load', async () => {
  const f = movieFixture()
  await f.movie.load('running.swf')
  f.setPanic(details('memory access out of bounds'))
  f.observePanic()
  f.observePanic()
  f.movie.destroy()
  assert.equal(f.events.filter(event => event.type === 'qqpet-ruffle-panic').length, 1)
  assert.equal(f.events[0].detail.url, 'running.swf')
})

test('an ordinary missing movie is diagnostic and a cancelled late load cannot become fatal', async () => {
  const missing = movieFixture()
  missing.api.load = async () => { missing.setPanic(details('Failed to fetch missing.swf')); throw new Error('404') }
  await assert.rejects(missing.movie.load('missing.swf'), /404/)
  assert.equal(missing.events.find(event => event.type === 'qqpet-ruffle-panic').detail.fatal, false)
  assert.equal(missing.events.find(event => event.type === 'qqpet-swf-error').detail.terminal, undefined)

  const cancelled = movieFixture()
  let finish
  cancelled.api.load = () => new Promise(resolve => { finish = resolve })
  const loading = cancelled.movie.load('removed.swf')
  const rejected = assert.rejects(loading, /destroyed/)
  cancelled.movie.destroy()
  cancelled.setPanic(details('Failed to begin SWF load: TypeError: null instance'))
  cancelled.observePanic()
  finish()
  await rejected
  assert.equal(cancelled.events.length, 0)
})

function bridgeFixture({ failingNativePosts = 0, failingSWFPosts = 0, throwSuspend = false } = {}) {
  const posts = [], order = [], listeners = new Map(), errors = []
  let attempts = 0, swfAttempts = 0
  const window = { addEventListener: (name, callback) => listeners.set(name, callback), __qqpetSetPaused: paused => {
    order.push(['paused', paused])
    if (throwSuspend) throw new Error('poisoned WASM suspend')
  } }
  const context = {
    window, document: { querySelectorAll: () => [] }, Date,
    rpc: { page: 'test-page', notify: (op, args) => {
      if (op === 'rufflePanic' && ++attempts <= failingNativePosts) throw new Error('native transport unavailable')
      if (op === 'swfTerminalFailure' && ++swfAttempts <= failingSWFPosts) throw new Error('native transport unavailable')
      posts.push({ op, args }); order.push(op)
    } },
    geometry: { pause: paused => order.push(['geometry-pause', paused]), stop: () => order.push('geometry-stop') },
    readRufflePanic, isFatalRufflePanic, console: { error: (...args) => errors.push(args) },
  }
  const policy = bridgeSource.slice(bridgeSource.indexOf('let publishedRufflePanic ='), bridgeSource.indexOf('function savedStatus()'))
  const failure = bridgeSource.slice(bridgeSource.indexOf("window.addEventListener('qqpet-swf-error'"), bridgeSource.indexOf('function requireOwner()'))
  const pause = bridgeSource.slice(bridgeSource.indexOf('function setPaused('), bridgeSource.indexOf('\nwindow.__qqpetIOS ='))
  runInNewContext(stripTypeScriptTypes(policy + failure + pause) + '\nthis.setHostPaused=setPaused;this.publishPanic=publishRufflePanic', context)
  return { posts, order, window, errors, attempts: () => attempts, publish: context.publishPanic,
    pause: context.setHostPaused, panic: detail => listeners.get('qqpet-ruffle-panic')({ detail }),
    swfError: detail => listeners.get('qqpet-swf-error')({ detail }), swfAttempts: () => swfAttempts }
}

test('the iOS bridge isolates only the first fatal panic and cannot resume it on a presence change', () => {
  const f = bridgeFixture()
  f.panic({ details: '' })
  assert.equal(f.posts.length, 0)
  f.panic({ details: details('Failed to fetch missing.swf') })
  assert.equal(f.posts.some(post => post.op === 'rufflePanic'), false)
  assert.equal(f.window.__qqpetHostPaused, undefined)
  const original = { url: 'pet.swf', title: 'runtime', body: 'failed', details: details('panicked at first failure') }
  f.panic(original)
  f.panic({ ...original, details: details('secondary failure') })
  assert.equal(f.posts.filter(post => post.op === 'rufflePanic').length, 1)
  assert.equal(f.posts.find(post => post.op === 'rufflePanic').args.details, original.details)
  assert.equal(f.window.__qqpetHostPaused, true)
  assert.ok(f.order.indexOf('rufflePanic') < f.order.findIndex(event => Array.isArray(event) && event[0] === 'paused'))
  f.pause(false)
  assert.equal(f.window.__qqpetHostPaused, true)
})

test('poisoned suspend cannot prevent native isolation or geometry cleanup', () => {
  const f = bridgeFixture({ throwSuspend: true })
  assert.doesNotThrow(() => f.panic({ details: details('panicked at first failure') }))
  assert.equal(f.posts.filter(post => post.op === 'rufflePanic').length, 1)
  assert.equal(f.window.__qqpetHostPaused, true)
  assert.equal(f.order.at(-1), 'geometry-stop')
  assert.equal(f.errors.length, 1)
})

test('failed native notification retries only through existing status publication and stays bounded', () => {
  const f = bridgeFixture({ failingNativePosts: 1 })
  const original = details('panicked at original failure')
  f.panic({ details: original })
  assert.equal(f.posts.some(post => post.op === 'rufflePanic'), false)
  f.publish()
  f.publish()
  assert.equal(f.attempts(), 2)
  assert.equal(f.posts.find(post => post.op === 'rufflePanic').args.details, original)

  const disconnected = bridgeFixture({ failingNativePosts: Infinity })
  disconnected.panic({ details: original })
  for (let i = 0; i < 8; i++) disconnected.publish()
  assert.equal(disconnected.attempts(), 3)
  assert.equal(disconnected.window.__qqpetHostPaused, true)
})

test('only typed terminal context recovery failures stop the iOS renderer without fabricating a panic', () => {
  const f = bridgeFixture()
  f.swfError({ url: 'back.swf', message: '404' })
  f.swfError({ url: 'back.swf', message: 'SWF load was cancelled' })
  f.swfError({ url: 'back.swf', message: 'unrecognized failure', terminal: 'other' })
  assert.equal(f.posts.some(post => post.op === 'swfTerminalFailure'), false)
  assert.equal(f.window.__qqpetHostPaused, undefined)
  const first = { url: 'front.swf', message: 'Recovery limit exceeded', terminal: 'context-recovery-exhausted' }
  f.swfError(first)
  f.swfError({ ...first, message: 'Secondary error' })
  f.publish()
  assert.equal(f.posts.filter(post => post.op === 'swfTerminalFailure').length, 1)
  assert.equal(f.posts.find(post => post.op === 'swfTerminalFailure').args.message, first.message)
  assert.equal(f.posts.some(post => post.op === 'rufflePanic'), false)
  assert.equal(f.posts.some(post => post.args.lastRufflePanic), false)
  assert.ok(f.order.indexOf('swfTerminalFailure') < f.order.findIndex(item => Array.isArray(item) && item[0] === 'paused'))
  assert.equal(f.order.filter(item => item === 'geometry-stop').length, 1)
  f.pause(false)
  assert.equal(f.window.__qqpetHostPaused, true)
})

test('terminal recovery notification retries remain bounded even if suspending the damaged renderer throws', () => {
  const f = bridgeFixture({ failingSWFPosts: 1, throwSuspend: true })
  f.swfError({ url: 'bubble.swf', message: 'Rebuild failed', terminal: 'context-recovery-failed' })
  assert.equal(f.window.__qqpetHostPaused, true)
  assert.equal(f.order.at(-1), 'geometry-stop')
  f.publish()
  f.publish()
  assert.equal(f.swfAttempts(), 2)
  assert.equal(f.posts.filter(post => post.op === 'swfTerminalFailure').length, 1)
  const disconnected = bridgeFixture({ failingSWFPosts: Infinity })
  disconnected.swfError({ url: 'front.swf', message: 'Rebuild failed', terminal: 'context-recovery-failed' })
  for (let i = 0; i < 8; i++) disconnected.publish()
  assert.equal(disconnected.swfAttempts(), 3)
})
