import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const policy = readFileSync(new URL('../../ios/audio-policy.js', import.meta.url), 'utf8')
function fixture(options = {}) {
  const { local = true, prepare } = options
  const required = Object.hasOwn(options, 'required') ? options.required : true
  const calls = []
  class NativeAudioContext {
    static marker = 'native'
    constructor(options) { this.options = options; calls.push('create') }
    suspend() { calls.push('suspend'); return Promise.resolve() }
    resume() { calls.push('resume'); return Promise.resolve('resumed') }
  }
  const window = {
    AudioContext: NativeAudioContext, webkitAudioContext: NativeAudioContext,
    __qqpetRequireNativeAudioPolicy: required, __qqpetLocalAudioOutput: local,
    __qqpetPrepareAudio: prepare ?? (() => { calls.push('prepare'); return true }),
  }
  runInNewContext(policy, { window })
  return { window, calls, NativeAudioContext }
}

test('iOS 15 confirms native Ambient before every constructor without starting or pausing output', async () => {
  const { window, calls } = fixture()
  assert.equal(window.__qqpetAudioPolicyState, 'required')
  const first = new window.AudioContext({ sampleRate: 44100 })
  const second = new window.webkitAudioContext()
  assert.deepEqual(calls, ['prepare', 'create', 'prepare', 'create'])
  assert.equal(first.options.sampleRate, 44100)
  assert.equal(window.__qqpetAudioPolicyState, 'ready')
  assert.equal(window.__qqpetAudioPolicyError, undefined)
  assert.equal(await first.resume(), 'resumed')
  await second.suspend()
  assert.deepEqual(calls, ['prepare', 'create', 'prepare', 'create', 'resume', 'suspend'])
})

test('missing local output or native bridge cannot create an AudioContext', () => {
  for (const local of [false, undefined, 1]) {
    const { window, calls } = fixture({ local: false })
    window.__qqpetLocalAudioOutput = local
    assert.throws(() => new window.AudioContext(), /WebContent audio output was not configured/)
    assert.deepEqual(calls, [])
    assert.equal(window.__qqpetAudioPolicyState, 'local-output-unavailable')
  }
  const { window, calls } = fixture()
  delete window.__qqpetPrepareAudio
  assert.throws(() => new window.AudioContext(), /native Ambient audio policy is unavailable/)
  assert.deepEqual(calls, [])
  assert.equal(window.__qqpetAudioPolicyState, 'native-bridge-unavailable')
})

test('native category failure or exception cannot construct and a later successful check can retry', () => {
  for (const result of [false, undefined, 1, Promise.resolve(true)]) {
    const { window, calls } = fixture({ prepare: () => result })
    assert.throws(() => new window.AudioContext(), /did not confirm Ambient/)
    assert.deepEqual(calls, [])
    assert.equal(window.__qqpetAudioPolicyState, 'native-category-failed')
  }
  const { window, calls } = fixture({ prepare: () => { throw new Error('Native failure') } })
  assert.throws(() => new window.AudioContext(), /native Ambient audio policy failed/)
  assert.deepEqual(calls, [])
  assert.equal(window.__qqpetAudioPolicyState, 'native-call-failed')
  window.__qqpetPrepareAudio = () => { calls.push('prepare'); return true }
  new window.AudioContext()
  assert.deepEqual(calls, ['prepare', 'create'])
  assert.equal(window.__qqpetAudioPolicyState, 'ready')
  assert.equal(window.__qqpetAudioPolicyError, undefined)
})

test('native options, static properties, aliases and subclasses survive the guard', () => {
  const { window, calls, NativeAudioContext } = fixture()
  class Extended extends window.AudioContext {}
  const context = new Extended({ sampleRate: 48000 })
  assert.equal(context instanceof Extended, true)
  assert.equal(context instanceof NativeAudioContext, true)
  assert.equal(context.options.sampleRate, 48000)
  assert.equal(window.AudioContext.marker, 'native')
  assert.equal(window.AudioContext, window.webkitAudioContext)
  assert.deepEqual(calls, ['prepare', 'create'])
  assert.throws(() => window.AudioContext(), TypeError)
})

test('separate documents and prefixed-only constructors each install their own native guard', () => {
  for (let frame = 0; frame < 2; frame++) {
    const calls = []
    class Prefixed { constructor() { calls.push('create') } }
    const window = {
      webkitAudioContext: Prefixed, __qqpetRequireNativeAudioPolicy: true, __qqpetLocalAudioOutput: true,
      __qqpetPrepareAudio: () => { calls.push('prepare'); return true },
    }
    runInNewContext(policy, { window })
    assert.equal(window.AudioContext, undefined)
    assert.equal(new window.webkitAudioContext() instanceof Prefixed, true)
    assert.deepEqual(calls, ['prepare', 'create'])
  }
})

test('distinct native aliases retain their own prototypes and construction behavior', () => {
  const calls = []
  class Standard { constructor() { calls.push('standard') } }
  class Prefixed { constructor() { calls.push('prefixed') } }
  const window = {
    AudioContext: Standard, webkitAudioContext: Prefixed,
    __qqpetRequireNativeAudioPolicy: true, __qqpetLocalAudioOutput: true,
    __qqpetPrepareAudio: () => { calls.push('prepare'); return true },
  }
  runInNewContext(policy, { window })
  assert.equal(new window.AudioContext() instanceof Standard, true)
  assert.equal(new window.webkitAudioContext() instanceof Prefixed, true)
  assert.deepEqual(calls, ['prepare', 'standard', 'prepare', 'prefixed'])
})

test('other iOS releases keep native constructors and still disable the Ruffle unmute hack', () => {
  for (const required of [false, undefined]) {
    const { window, calls, NativeAudioContext } = fixture({ required, local: false })
    assert.equal(window.__qqpetRespectSystemAudio, true)
    assert.equal(window.AudioContext, NativeAudioContext)
    assert.equal(window.webkitAudioContext, NativeAudioContext)
    assert.equal(window.__qqpetAudioPolicyState, 'system-default')
    new window.AudioContext()
    assert.deepEqual(calls, ['create'])
  }
  const window = { __qqpetRequireNativeAudioPolicy: true }
  runInNewContext(policy, { window })
  assert.equal(window.__qqpetRespectSystemAudio, true)
  assert.equal(window.__qqpetAudioPolicyState, 'audio-context-unavailable')
})
