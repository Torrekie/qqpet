import assert from 'node:assert/strict'
import test from 'node:test'
import { fullscreenGate } from '../../src/main/fullscreen-gate.ts'

const run = (lines) => {
  const out = []
  const feed = fullscreenGate((full) => out.push(full))
  for (const l of lines) feed(l)
  return out
}

test('a full-screen app hides the pet at once and shows it only after it has really left (#37)', () => {
  assert.deepEqual(run(['0', '1', '1', '0', '0', '0', '0']), [true, false])
})

test('the brief "not full screen" Windows reports after hiding the pet does not start a hide/show loop (#37)', () => {
  assert.deepEqual(run(['1', '0', '1', '0', '0', '1', '0', '1']), [true])
})

test('the taskbar in front keeps the current state', () => {
  assert.deepEqual(run(['1', '-1', '-1', '-1', '-1', '-1']), [true])
  assert.deepEqual(run(['-1', '-1']), [])
})
