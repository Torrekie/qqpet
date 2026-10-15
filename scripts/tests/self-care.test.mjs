import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pickCare } from '../../src/renderer/pet/care.ts'

const towel = { name: '浴巾', clean: 720 }
const soap = { name: '香皂', clean: 300 }
const gel = { name: '沐浴露', clean: 400 }
const bath = { name: '浴缸', clean: 900 }

test('auto-care uses the biggest good that still fits the deficit (#40)', () => {
  // cleanMax 1100, clean 659: the towel would waste 279.
  assert.equal(pickCare([towel, soap, gel], 'clean', 441), gel)
})

test('when every good overflows, the one that overflows least is used', () => {
  assert.equal(pickCare([bath, towel], 'clean', 200), towel)
})

test('goods that do nothing for the stat are skipped; none left means nothing is used', () => {
  assert.equal(pickCare([{ name: '饼干', hunger: 100 }], 'clean', 300), undefined)
  assert.equal(pickCare([], 'mood', 300), undefined)
})

test('a missing food does not end the round: clean and mood are still checked', () => {
  const src = readFileSync(new URL('../../src/renderer/pet/pet.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function selfCare'), src.indexOf('\n}\n', src.indexOf('function selfCare')))
  assert.match(body, /for \(const need of NEEDS\)/)
  assert.match(body, /if \(!g\) continue/)
})
