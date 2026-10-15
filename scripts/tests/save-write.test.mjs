import assert from 'node:assert/strict'
import test from 'node:test'
import { atomicWrite } from '../../src/main/atomic-write.ts'

const busy = (code) => Object.assign(new Error(code), { code })

test('a save file briefly held by another process is renamed once it is free (#38)', () => {
  const calls = []
  let failures = 2
  const fs = {
    writeFileSync: (f, t) => calls.push(['write', f, t]),
    renameSync: (a, b) => { calls.push(['rename', a, b]); if (failures-- > 0) throw busy('EPERM') },
  }
  const sleeps = []
  atomicWrite('save.json', '{}', fs, (ms) => sleeps.push(ms))
  assert.deepEqual(calls.filter(([op]) => op === 'rename').length, 3)
  assert.deepEqual(sleeps, [20, 40])
})

test('a file that stays locked, or any other error, still throws for the caller to handle', () => {
  const fs = { writeFileSync: () => {}, renameSync: () => { throw busy('EBUSY') } }
  assert.throws(() => atomicWrite('save.json', '{}', fs, () => {}), { code: 'EBUSY' })
  const enospc = { writeFileSync: () => {}, renameSync: () => { throw busy('ENOSPC') } }
  let slept = 0
  assert.throws(() => atomicWrite('save.json', '{}', enospc, () => slept++), { code: 'ENOSPC' })
  assert.equal(slept, 0)
})
