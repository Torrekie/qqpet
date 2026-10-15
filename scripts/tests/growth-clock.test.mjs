import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const machineSource = readFileSync(new URL('../../src/renderer/pet/machine.ts', import.meta.url), 'utf8')
const petSource = readFileSync(new URL('../../src/renderer/pet/pet.ts', import.meta.url), 'utf8')
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

// Exercise the real startup and pose scheduling; stub the unrelated DOM and growth arithmetic.
function startup({ paused = false, failLoad = false, buried = false, deferLoad = false } = {}) {
  const intervals = []
  const loads = []
  const transitions = []
  const pendingLoads = []
  const info = { health: 5, growth: 80, sex: 'GG', onlineDataTime: 71 }
  const save = { isBury: buried, settings: { paused: false } }
  let now = 0
  let lastTick = null
  let growCalls = 0
  const interval = (callback, delay) => {
    intervals.push({ callback, delay })
    return intervals.length
  }
  const context = vm.createContext({
    window: { __qqpetHostPaused: paused, setInterval: interval },
    setInterval: interval,
    info, save,
    route: (_sex, _stage, action) => ({ url: `${action}.swf`, opt: {} }),
    applyEdge: () => null,
    stage: () => 'Kid',
    mood: () => 'happy',
    grow() {
      growCalls++
      if (lastTick !== null) info.onlineDataTime += (now - lastTick) / 60_000
      lastTick = now
    },
    advanceTask() {}, refreshTray() {}, bury() {}, setTray() {}, speak() {},
    greeting: () => null, daily() {}, weatherTalk() {},
    DEAD: { tolk: 'dead' },
    addInfo: (key, value) => { info[key] += value },
  })
  const machineScript = machineSource.replace(/^import[^\n]*\n/gm, '').replace('export class Machine', 'class Machine')
  vm.runInContext(stripTypeScriptTypes(machineScript, { mode: 'transform' }) + '\nthis.Machine = Machine', context)
  const swf = {
    front: { currentFrame: 0, totalFrames: 2, isPlaying: true, stops: 0, stop() { this.stops++; this.isPlaying = false } },
    async load(url, accept = () => true) {
      loads.push(url)
      if (failLoad) throw new Error('Animation unavailable')
      if (deferLoad) await new Promise((resolve, reject) => pendingLoads.push({ resolve, reject }))
      if (!accept()) return false
      this.front.currentFrame = 0
      this.front.isPlaying = true
      return true
    },
  }
  context.machine = new context.Machine(swf, (over, next) => { transitions.push(next.a); over.e?.(); next.s?.() })
  const start = petSource.indexOf('let growthTimer')
  assert.notEqual(start, -1, 'load the real growth timer declaration and startup functions')
  const startupScript = petSource.slice(start).replace('export function startPet', 'function startPet')
  vm.runInContext(stripTypeScriptTypes(startupScript) + '\nthis.startPet = startPet', context)
  return {
    context, info, loads, swf, transitions, pendingLoads,
    growthTimers: () => intervals.filter(({ delay }) => delay === 60_000),
    growCalls: () => growCalls,
    async poseTick() {
      intervals.find(({ delay }) => delay === 1000 / 12).callback()
      // Finish both the load promise and Machine's rejection recovery.
      await settle()
    },
    minute() {
      now += 60_000
      const timers = intervals.filter(({ delay }) => delay === 60_000)
      assert.equal(timers.length, 1, 'exactly one game clock must own the minute tick')
      timers[0].callback()
    },
  }
}

test('growth starts while the host is paused and survives presence replacing an unstarted entrance', async () => {
  const app = startup({ paused: true })
  app.context.startPet()
  await app.poseTick()
  assert.deepEqual(app.loads, [], 'the paused host has not played the entrance')
  assert.equal(app.growthTimers().length, 1)
  app.context.window.__qqpetHostPaused = false
  app.context.machine.play({ a: 'appear' })
  await app.poseTick()
  assert.deepEqual(app.loads, ['appear.swf'], 'presence preempted the entrance before it could own a completion hook')
  app.minute()
  assert.equal(app.info.onlineDataTime, 72)
})

test('an entrance load failure does not prevent the online clock from advancing', async () => {
  const app = startup({ failLoad: true })
  app.context.startPet()
  await app.poseTick()
  assert.deepEqual(app.loads, ['enter.swf'])
  assert.deepEqual(app.transitions, [], 'the failed animation never fired its pose callbacks')
  await app.poseTick()
  assert.deepEqual(app.loads, ['enter.swf', 'normal.swf'], 'the real machine attempted its normal-pose recovery')
  app.minute()
  assert.equal(app.info.onlineDataTime, 72)
})

test('repeated startup and a completed entrance keep one growth interval', async () => {
  const app = startup()
  app.context.startPet()
  await app.poseTick()
  app.swf.front.currentFrame = 1
  await app.poseTick()
  app.context.startPet()
  await app.poseTick()
  app.swf.front.currentFrame = 1
  await app.poseTick()
  assert.equal(app.growthTimers().length, 1)
  assert.equal(app.growCalls(), 1, 'startup only initializes the clock once')
  app.minute()
  assert.equal(app.info.onlineDataTime, 72)
  assert.equal(app.growCalls(), 2)
})

test('a buried pet does not start a growth interval', () => {
  const app = startup({ buried: true })
  app.context.startPet()
  assert.equal(app.growthTimers().length, 0)
  assert.equal(app.growCalls(), 0)
})

test('releasing a drag before its movie loads preserves the visible pose and skips stale callbacks', async () => {
  const app = startup({ deferLoad: true })
  const calls = []
  app.context.machine.pose = { a: 'normal', e: () => calls.push('old-end') }
  app.context.machine.start()
  app.context.machine.play({ a: 'drag', s: () => calls.push('drag-start'), e: () => calls.push('drag-end') })
  await app.poseTick()
  app.context.machine.play({ a: 'normal', s: () => calls.push('normal-start') })
  app.pendingLoads[0].resolve()
  await settle()
  assert.equal(app.context.machine.pose.a, 'normal')
  assert.deepEqual(app.transitions, [])
  assert.deepEqual(calls, [], 'a discarded candidate cannot end the currently visible pose')

  await app.poseTick()
  assert.deepEqual(app.loads, ['drag.swf', 'normal.swf'])
  app.pendingLoads[1].resolve()
  await settle()
  assert.deepEqual(app.transitions, ['normal'])
  assert.deepEqual(calls, ['old-end', 'normal-start'])
})

test('a failed older load cannot replace a pending explicit drag or apply its uncommitted pose rules', async () => {
  const app = startup({ deferLoad: true })
  app.context.machine.start()
  app.context.machine.play({ a: 'play', opt: { url: 'broken.swf', opt: { opt: { afterState: [], overCurrentFrame: 1 } } } })
  await app.poseTick()
  app.swf.front.currentFrame = 1
  await app.poseTick()
  assert.equal(app.swf.front.stops, 0, 'candidate freeze rules cannot affect the still-visible front')

  let started = 0
  app.context.machine.play({ a: 'drag', opt: { url: 'selected-drag.swf', opt: {} }, s: () => started++ })
  app.pendingLoads[0].reject(new Error('Animation unavailable'))
  await settle()
  await app.poseTick()
  assert.deepEqual(app.loads, ['broken.swf', 'selected-drag.swf'])
  app.pendingLoads[1].resolve()
  await settle()
  assert.equal(app.context.machine.pose.a, 'drag')
  assert.equal(started, 1)
})

test('queued actions do not supersede an in-flight pose and committed freeze rules remain in effect', async () => {
  const app = startup({ deferLoad: true })
  app.context.machine.start()
  app.context.machine.play({ a: 'normal', opt: { url: 'held.swf', opt: { opt: { overCurrentFrame: 1 } } } })
  await app.poseTick()
  app.context.machine.add({ a: 'play' })
  app.context.machine.add({ a: 'clean' })
  app.pendingLoads[0].resolve()
  await settle()
  assert.deepEqual(app.transitions, ['normal'], 'add preserves the current candidate')

  app.swf.front.currentFrame = 1
  await app.poseTick()
  assert.equal(app.swf.front.stops, 1, 'successfully committed pose rules still freeze that pose')
  app.pendingLoads[1].resolve()
  await settle()
  assert.deepEqual(app.transitions, ['normal', 'play'])

  app.swf.front.currentFrame = 1
  await app.poseTick()
  assert.equal(app.swf.front.stops, 1, 'the previous pose rules cannot freeze its replacement')
  app.pendingLoads[2].resolve()
  await settle()
  assert.deepEqual(app.loads, ['held.swf', 'play.swf', 'clean.swf'])
  assert.deepEqual(app.transitions, ['normal', 'play', 'clean'])
})

test('a drag forbidden by Die cannot cancel an in-flight revival and is reconsidered afterwards', async () => {
  for (const health of [0, 1]) {
    const app = startup({ deferLoad: true })
    const calls = []
    app.info.health = health
    app.context.machine.start()
    app.context.machine.play({
      a: 'die', opt: { url: 'die.swf', opt: { opt: { afterState: ['revival', 'bury'] } } },
      s: () => calls.push('die-start'), e: () => calls.push('die-end'),
    })
    await app.poseTick()
    app.pendingLoads[0].resolve()
    await settle()

    app.context.machine.play({
      a: 'revival', s: () => { calls.push('revival-start'); app.info.health = 5 },
      e: () => calls.push('revival-end'),
    })
    await app.poseTick()
    app.context.machine.play({ a: 'drag', s: () => calls.push('drag-start') })
    app.pendingLoads[1].resolve()
    await settle()
    assert.deepEqual(app.transitions, ['die', 'revival'])
    assert.deepEqual(calls, ['die-start', 'die-end', 'revival-start'])

    await app.poseTick()
    assert.deepEqual(app.loads, ['die.swf', 'revival.swf', 'drag.swf'])
    app.pendingLoads[2].resolve()
    await settle()
    assert.deepEqual(app.transitions, ['die', 'revival', 'drag'])
    assert.deepEqual(calls, ['die-start', 'die-end', 'revival-start', 'revival-end', 'drag-start'])
  }
})

test('preemption admission uses the same health-one dying action as the movie transition', async () => {
  const app = startup({ deferLoad: true })
  app.info.health = 1
  app.context.machine.start()
  app.context.machine.play({ a: 'dying', opt: { url: 'dying.swf', opt: { opt: { afterState: ['dying', 'cure'] } } } })
  await app.poseTick()
  app.pendingLoads[0].resolve()
  await settle()

  app.context.machine.play({ a: 'cure', s: () => assert.fail('the preempted cure cannot start') })
  await app.poseTick()
  app.context.machine.play({ a: 'drag' })
  app.pendingLoads[1].resolve()
  await settle()
  assert.deepEqual(app.transitions, ['dying'])
  await app.poseTick()
  assert.deepEqual(app.loads, ['dying.swf', 'cure.swf', 'dying.swf'])
  app.pendingLoads[2].resolve()
  await settle()
  assert.deepEqual(app.transitions, ['dying', 'dying'])
})
