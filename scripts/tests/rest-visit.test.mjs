import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { restPlan } from '../../src/renderer/pet/router.ts'
import { BUBBLES, SCENES, VISIT_STAGE, petCode, visitBox, visitDir, visitScenes, visitSteps } from '../../src/renderer/pet/visit-plan.ts'

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
      assert.ok(has(visitDir('102_102') + s.clip), s.clip)
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

test('interact2 codes are stage then sex; every hostable pairing has its clips (QPet2 import)', () => {
  assert.equal(petCode('GG', 'Adult'), '102')
  assert.equal(petCode('MM', 'Adult'), '103')
  assert.equal(petCode('MM', 'Egg'), '113')
  assert.equal(petCode('GG', 'Kid'), '122')
  assert.equal(Object.keys(SCENES).length, 23)
  for (const sex of ['GG', 'MM'])
    for (const stage of ['Kid', 'Adult']) {
      const scenes = visitScenes(sex, stage)
      assert.ok(scenes.length >= 2, `${sex} ${stage}`)
      for (const scene of scenes) {
        assert.ok(scene.endsWith('_' + petCode(sex, stage)), scene)
        for (const roll of [0, 0.7])
          for (const s of visitSteps(roll, scene)) {
            const file = new URL(`../../resources/${visitDir(scene)}${s.clip}`, import.meta.url)
            assert.ok(existsSync(file), scene + '/' + s.clip)
            // CI checks out without LFS, so a clip may be a pointer file there.
            const head = readFileSync(file).subarray(0, 40).toString()
            assert.match(head, /^([CFZ]WS|version https:\/\/git-lfs)/, scene + '/' + s.clip)
          }
      }
    }
  // Without a meal or a tug of war the pairing cannot be a visit.
  assert.ok(!visitScenes('GG', 'Adult').includes('122_102'))
})
