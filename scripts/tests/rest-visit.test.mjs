import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { restPlan } from '../../src/renderer/pet/router.ts'
import { BUBBLES, VISIT_DIR, VISIT_STAGE, visitBox, visitSteps } from '../../src/renderer/pet/visit-plan.ts'

const has = (url) => existsSync(new URL(`../../resources/${url}`, import.meta.url))

test('rest plans point at existing adult clips and exclude juvenile routes to adult artwork', () => {
  for (const sex of ['GG', 'MM']) {
    for (const stage of ['Egg', 'Kid', 'Adult']) {
      const p = restPlan(sex, stage)
      if (stage !== 'Adult') {
        assert.equal(p, null)
        continue
      }
      assert.ok(p, `${sex} ${stage}`)
      for (const url of [p.down, p.lying.url, p.up].filter(Boolean)) assert.ok(has(url), url)
    }
  }
  assert.deepEqual(restPlan('GG', 'Adult'), {
    down: 'pet/Action/GG/Adult/Etoj.swf',
    lying: { url: 'pet/Action/GG/Adult/prostrate/Stand.swf', freeze: undefined },
    up: 'pet/Action/GG/Adult/Jtoc.swf',
  })
})

test('a visit enters, talks, plays one game, says goodbye; every clip exists', () => {
  for (const roll of [0, 0.3, 0.6, 0.99]) {
    const steps = visitSteps(roll)
    assert.equal(steps[0].clip, 'enter.swf')
    assert.equal(steps[1].clip, 'idle.swf')
    assert.equal(steps[1].talk.length, 2)
    assert.equal(steps[2].clip, roll < 0.5 ? 'tugofwar.swf' : 'feed.swf')
    for (const s of steps) {
      assert.ok(has(VISIT_DIR + s.clip), s.clip)
      assert.ok(s.ms > 0)
    }
  }
})

test('the visit box scales with the pet, stands on its baseline and stays on screen', () => {
  assert.deepEqual(visitBox({ left: 500, bottom: 400, width: 140 }, 1920), { x: 420, y: 200, w: 300, h: 200 })
  assert.equal(visitBox({ left: 0, bottom: 400, width: 140 }, 1920).x, 0)
  assert.equal(visitBox({ left: 1850, bottom: 400, width: 70 }, 1920).x, 1920 - 150)
  for (const b of BUBBLES) assert.ok(b.x >= 0 && b.x + b.w <= VISIT_STAGE.w && b.y + b.h <= VISIT_STAGE.h)
})
