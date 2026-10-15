import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

test('the pose sequencer keeps pending input while its front renderer recovers', async () => {
  const loads = []
  const front = { isRecovering: true, currentFrame: -1, totalFrames: 0, isPlaying: false }
  const swf = { front, async load(url) { loads.push(url); return true } }
  const context = {
    info: { health: 5, sex: 'GG' },
    applyEdge: () => null,
    stage: () => 'Egg',
    mood: () => 'happy',
    route: (_sex, _stage, action) => ({ url: `${action}.swf`, opt: {} }),
    window: { __qqpetHostPaused: false },
  }
  const source = readFileSync(new URL('../../src/renderer/pet/machine.ts', import.meta.url), 'utf8')
  runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^import .*$/gm, '').replace('export class', 'class') + '\nthis.Machine=Machine', context)
  const changed = []
  const machine = new context.Machine(swf, (_previous, next) => changed.push(next.a))
  machine.play({ a: 'drag' })
  machine.tick()
  machine.tick()
  assert.deepEqual(loads, [], 'missing recovery metadata must not advance the pose')

  front.isRecovering = false
  machine.tick()
  await Promise.resolve()
  assert.deepEqual(loads, ['drag.swf'])
  assert.deepEqual(changed, ['drag'])
  assert.equal(machine.pose.a, 'drag', 'input received during recovery is applied afterward')
})
