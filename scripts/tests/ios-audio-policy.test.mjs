import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const policy = readFileSync(new URL('../../ios/audio-policy.js', import.meta.url), 'utf8')
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
let seed = 0
function fixture({ available = true } = {}) {
  const messages = [], callbacks = [], listeners = new Map()
  let milliseconds = 0
  class ForbiddenWebAudio { constructor() { throw new Error('Real WebAudio must never be constructed') } }
  const frameSeed = ++seed
  const window = {
    AudioContext: ForbiddenWebAudio, webkitAudioContext: ForbiddenWebAudio,
    crypto: { getRandomValues: array => { array.fill(frameSeed); return array } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    webkit: available ? { messageHandlers: { qqpetAudio: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) } } } : undefined,
  }
  runInNewContext(policy, {
    window, performance: { now: () => milliseconds }, EventTarget, Event,
    console: { error: (...arguments_) => callbacks.push(arguments_) },
    btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
  })
  const receive = message => window.__qqpetNativeAudioReceive(message)
  const reply = (request, { time = 0, state = 'suspended', error } = {}) =>
    receive({ page: request.page, context: request.context, request: request.request, type: 'reply', time, state, ...(error ? { error } : {}) })
  const source = (context, frames = 1024) => {
    const node = context.createBufferSource()
    node.buffer = context.createBuffer(2, frames, 44100)
    node.connect(context.destination)
    return node
  }
  return { window, messages, callbacks, listeners, receive, reply, source, tick: value => { milliseconds += value } }
}

test('Ruffle queues PCM before create acknowledgement and sends interleaved Float32LE snapshots', async () => {
  const f = fixture()
  const context = new f.window.AudioContext({ sampleRate: 44100 })
  assert.equal(f.window.AudioContext, f.window.webkitAudioContext)
  assert.equal(f.window.__qqpetRespectSystemAudio, true)
  assert.equal(context.state, 'suspended')
  assert.equal(context.sampleRate, 44100)
  const source = f.source(context)
  source.buffer.getChannelData(0).set([0.25, -0.5])
  source.buffer.copyToChannel(new Float32Array([0.75, -1]), 1)
  assert.equal(source.buffer.length, 1024)
  assert.equal(source.buffer.numberOfChannels, 2)
  assert.equal(source.buffer.duration, 1024 / 44100)
  assert.equal(source.start(0), undefined)
  source.buffer.getChannelData(0).fill(1)
  const resumed = context.resume()
  assert.deepEqual(f.messages.map(message => message.op), ['create'])
  assert.equal(f.messages[0].sampleRate, 44100)
  assert.equal(f.messages[0].channels, 2)
  f.reply(f.messages[0])
  await settle()
  assert.deepEqual(f.messages.map(message => message.op), ['create', 'enqueue', 'resume'])
  const enqueue = f.messages[1]
  assert.equal(enqueue.source, 1)
  assert.equal(enqueue.frames, 1024)
  assert.equal(enqueue.sampleRate, 44100)
  assert.equal(enqueue.channels, 2)
  const pcm = Buffer.from(enqueue.pcm, 'base64')
  assert.equal(pcm.length, 1024 * 8)
  assert.deepEqual([0, 4, 8, 12].map(offset => pcm.readFloatLE(offset)), [0.25, 0.75, -0.5, -1])
  f.reply(enqueue)
  f.reply(f.messages[2], { state: 'running' })
  await resumed
  assert.equal(context.state, 'running')
})

test('buffer bounds and unsupported source operations fail explicitly without real WebAudio', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  for (const args of [[1, 1024, 44100], [2, 1023, 44100], [2, 16385, 44100], [2, 1024, 48000]])
    assert.throws(() => context.createBuffer(...args), /stereo 44100/)
  assert.throws(() => new f.window.AudioContext({ sampleRate: 48000 }), /44100/)
  const source = f.source(context, 16384)
  assert.throws(() => source.buffer.getChannelData(2), /channel/)
  assert.throws(() => source.buffer.copyToChannel(new Float32Array([1]), 0, 16384), /offset/)
  assert.throws(() => source.connect({}), /own destination/)
  assert.throws(() => source.start(-1), /time/)
  assert.throws(() => source.start(0, 1), /partial/)
  assert.throws(() => source.stop(), /does not support/)
  assert.throws(() => source.disconnect(), /does not support/)
  source.start()
  assert.throws(() => source.start(), /once/)
  f.reply(f.messages[0])
  await settle()
  assert.equal(Buffer.from(f.messages[1].pcm, 'base64').length, 16384 * 8)
  f.reply(f.messages[1])
})

test('native clocks drive interpolation, suspend freezes, and an external interruption updates state', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  const states = []
  context.onstatechange = () => states.push(context.state)
  f.tick(5000)
  assert.equal(context.currentTime, 0)
  f.reply(f.messages[0])
  const resume = context.resume()
  await settle()
  f.reply(f.messages[1], { time: 2, state: 'running' })
  await resume
  f.tick(500)
  assert.equal(context.currentTime, 2.5)
  const pause = context.suspend()
  await settle()
  f.reply(f.messages[2], { time: 2.3, state: 'suspended' })
  await pause
  f.tick(10000)
  assert.equal(context.currentTime, 2.5, 'pause freezes the last observed time even if its native snapshot arrives late')
  const again = context.resume()
  await settle()
  f.reply(f.messages[3], { time: 2.3, state: 'running' })
  await again
  f.tick(100)
  assert.equal(context.currentTime, 2.5)
  f.receive({ page: f.messages[0].page, context: f.messages[0].context, type: 'state', time: 2.35, state: 'suspended' })
  f.tick(10000)
  assert.equal(context.currentTime, 2.5)
  assert.deepEqual(states, ['running', 'suspended', 'running', 'suspended'])
})

test('only native ended dispatches onended, and reentrant refill retains the new source', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  const source = f.source(context)
  let ended = 0
  source.onended = () => { ended++; f.source(context).start(context.currentTime) }
  source.start()
  f.reply(f.messages[0])
  await settle()
  f.reply(f.messages[1], { state: 'running' })
  f.tick(100000)
  assert.equal(ended, 0, 'elapsed wall time never simulates a native completion')
  const message = { page: f.messages[0].page, context: f.messages[0].context, type: 'ended', source: 1, time: 0.03, state: 'running' }
  f.receive(message)
  await settle()
  assert.equal(ended, 1)
  assert.equal(context.currentTime, 0.03, 'completion corrects the interpolated clock to native output')
  assert.equal(f.messages[2].source, 2)
  f.receive(message)
  assert.equal(ended, 1, 'duplicate or unknown completions cannot fire twice')
  f.reply(f.messages[2], { time: 0.03, state: 'running' })
  f.receive({ ...message, source: 2, time: 0.06 })
  assert.equal(context.currentTime, 0.06)
})

test('source IDs follow start order and resume/suspend requests preserve their submission order', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  const first = f.source(context), second = f.source(context)
  second.start()
  first.start()
  const resume = context.resume(), pause = context.suspend(), resumeAgain = context.resume()
  f.reply(f.messages[0])
  await settle()
  assert.deepEqual(f.messages.map(message => message.op), ['create', 'enqueue', 'enqueue', 'resume', 'suspend', 'resume'])
  assert.deepEqual(f.messages.filter(message => message.op === 'enqueue').map(message => message.source), [1, 2])
  for (const message of f.messages.slice(1)) f.reply(message, { state: message.op === 'resume' ? 'running' : 'suspended' })
  await Promise.all([resume, pause, resumeAgain])
  assert.equal(context.state, 'running')
})

test('close clears queued sources, ignores late completions and rejects later resumes', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  let ended = 0
  const source = f.source(context)
  source.onended = () => ended++
  source.start()
  f.reply(f.messages[0])
  await settle()
  f.reply(f.messages[1])
  const closed = context.close()
  assert.equal(context.state, 'closed')
  assert.equal(source.onended, null)
  await settle()
  const message = { page: f.messages[0].page, context: f.messages[0].context, type: 'ended', source: 1, time: 4, state: 'running' }
  f.receive(message)
  assert.equal(ended, 0)
  assert.equal(context.state, 'closed')
  f.reply(f.messages[2], { state: 'closed' })
  await closed
  f.receive(message)
  await assert.rejects(context.resume(), /closed/)
  assert.equal(ended, 0)
})

test('native errors close the context, clear sources and reject every pending operation', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  const source = f.source(context)
  source.onended = () => assert.fail('late onended after native failure')
  source.start()
  f.reply(f.messages[0])
  const resumed = context.resume(), paused = context.suspend()
  await settle()
  const rejections = Promise.all([assert.rejects(resumed, /AudioQueue reset/), assert.rejects(paused, /AudioQueue reset/)])
  f.receive({ page: f.messages[0].page, context: f.messages[0].context, type: 'state', time: 0, state: 'closed', error: 'AudioQueue reset' })
  await rejections
  assert.equal(context.state, 'closed')
  assert.equal(source.onended, null)
  assert.equal(f.window.__qqpetAudioPolicyState, 'native-audioqueue-error')
  assert.match(f.window.__qqpetAudioPolicyError, /AudioQueue reset/)
  f.receive({ page: f.messages[0].page, context: f.messages[0].context, type: 'ended', source: 1, time: 3, state: 'running' })
})

test('different documents and contexts cannot consume one another replies or source events', async () => {
  const a = fixture(), b = fixture()
  const first = new a.window.AudioContext(), second = new b.window.AudioContext()
  assert.notEqual(a.messages[0].page, b.messages[0].page)
  a.reply(b.messages[0], { time: 9, state: 'running' })
  assert.equal(first.state, 'suspended')
  assert.equal(first.currentTime, 0)
  a.reply(a.messages[0])
  b.reply(b.messages[0])
  const sibling = new a.window.AudioContext()
  assert.equal(a.messages[1].context, 2)
  a.reply({ ...a.messages[1], request: a.messages[0].request }, { time: 9, state: 'running' })
  assert.equal(sibling.state, 'suspended')
  a.reply(a.messages[1])
  await settle()
  assert.equal(second.state, 'suspended')
})

test('pagehide closes native queues even before create acknowledgement, without waiting for a timer', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  f.source(context).start()
  f.listeners.get('pagehide')()
  assert.deepEqual(f.messages.map(message => message.op), ['create', 'close'])
  assert.equal(context.state, 'closed')
  f.reply(f.messages[0])
  f.reply(f.messages[1], { state: 'closed' })
  await settle()
  assert.equal(f.messages.length, 2, 'the cancelled pending enqueue never reaches native')
})

test('bridge absence is explicit and aliases/subclasses never call the original AudioContext', async () => {
  const unavailable = fixture({ available: false })
  assert.throws(() => new unavailable.window.AudioContext(), /bridge is unavailable/)
  assert.equal(unavailable.window.__qqpetAudioPolicyState, 'native-audioqueue-error')
  const f = fixture()
  class Extended extends f.window.webkitAudioContext {}
  const context = new Extended({ sampleRate: 44100 })
  assert.equal(context instanceof Extended, true)
  assert.equal(context instanceof f.window.AudioContext, true)
  f.reply(f.messages[0])
  await settle()
  assert.equal(f.window.__qqpetAudioPolicyState, 'native-audioqueue')
})

test('throwing event properties cannot interrupt completion, close or pending promise cleanup', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  const source = f.source(context)
  source.onended = () => { throw new Error('Content ended callback failed') }
  source.start()
  f.reply(f.messages[0])
  await settle()
  context.onstatechange = () => { throw new Error('Content state callback failed') }
  f.reply(f.messages[1], { state: 'running' })
  f.receive({ page: f.messages[0].page, context: f.messages[0].context, type: 'ended', source: 1, time: 0.03, state: 'running' })
  assert.equal(context.state, 'running')
  assert.equal(f.window.__qqpetAudioPolicyState, 'native-audioqueue')
  const pause = context.suspend()
  await settle()
  const rejected = assert.rejects(pause, /AudioQueue reset/)
  f.receive({ page: f.messages[0].page, context: f.messages[0].context, type: 'state', time: 0.03, state: 'closed', error: 'AudioQueue reset' })
  await rejected
  assert.equal(context.state, 'closed')
  assert.equal(f.callbacks.length, 3)
  f.reply(f.messages[2], { state: 'running' })
  assert.equal(context.state, 'closed', 'late pending reply cannot revive a failed context')
  assert.equal(f.window.__qqpetAudioPolicyState, 'native-audioqueue-error')
})

test('reentrant close posts once and a healthy sibling cannot clear a native error', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  f.reply(f.messages[0])
  await settle()
  context.onstatechange = () => { if (context.state === 'closed') context.close() }
  const closed = context.close()
  await settle()
  assert.deepEqual(f.messages.map(message => message.op), ['create', 'close'])
  f.reply(f.messages[1], { state: 'closed' })
  await closed

  const failed = new f.window.AudioContext(), healthy = new f.window.AudioContext()
  f.reply(f.messages[2], { state: 'closed', error: 'Native failure' })
  f.reply(f.messages[3])
  await settle()
  assert.equal(failed.state, 'closed')
  assert.equal(healthy.state, 'suspended')
  assert.equal(f.window.__qqpetAudioPolicyState, 'native-audioqueue-error')
  assert.match(f.window.__qqpetAudioPolicyError, /Native failure/)
})

test('late running snapshots never rewind reads or accumulate an artificial native clock offset', async () => {
  const f = fixture()
  const context = new f.window.AudioContext()
  f.reply(f.messages[0])
  const resumed = context.resume()
  await settle()
  f.reply(f.messages[1], { time: 10, state: 'running' })
  await resumed
  f.tick(400)
  assert.equal(context.currentTime, 10.4)
  const snapshot = { page: f.messages[0].page, context: f.messages[0].context, type: 'state' }
  f.receive({ ...snapshot, time: 10.2, state: 'running' })
  assert.equal(context.currentTime, 10.4)
  f.tick(100)
  assert.equal(context.currentTime, 10.4)
  f.tick(200)
  assert.equal(context.currentTime, 10.5, 'interpolation still uses the actual 10.2 native anchor')
  f.receive({ ...snapshot, time: 10.45, state: 'suspended' })
  f.tick(20000)
  assert.equal(context.currentTime, 10.5, 'paused time never extrapolates')
})
