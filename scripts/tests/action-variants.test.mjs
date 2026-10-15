import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { ACTIONS, extraPlay, lookUrl, route, variant, walkUrl } from '../../src/renderer/pet/router.ts'

const has = (url) => existsSync(new URL(`../../resources/${url}`, import.meta.url))
const STAGES = ['Egg', 'Kid', 'Adult']

test('every variant clip listed in ACTIONS exists on disk', () => {
  for (const [sex, data] of Object.entries(ACTIONS)) {
    for (const [stage, keys] of Object.entries(data.variants)) {
      for (const [key, list] of Object.entries(keys)) {
        assert.ok(list.length, `${sex}/${stage}/${key}`)
        for (const clip of list) assert.ok(has(`pet/Action/${sex}/${stage}/${clip}.swf`), `${sex}/${stage}/${clip}`)
      }
    }
  }
})

test('numbered play counts match the files on disk for both sexes', () => {
  for (const [sex, { play }] of Object.entries(ACTIONS)) {
    const dirs = { egg: `pet/Action/${sex}/Egg/play`, kid: `pet/Action/${sex}/Kid/play`, peaceful: `pet/Action/${sex}/Adult/peaceful/play` }
    for (const [k, dir] of Object.entries(dirs)) {
      for (let i = 1; i <= play[k]; i++) assert.ok(has(`${dir}/P${i}.swf`), `${dir}/P${i}.swf`)
      assert.ok(!has(`${dir}/P${play[k] + 1}.swf`), `${dir} has more than ${play[k]} plays`)
    }
  }
})

test('variant picks by index and returns null without variants', () => {
  assert.equal(variant('GG', 'Kid', 'dirty', () => 1), 'lead/dirty20110805')
  assert.equal(variant('GG', 'Kid', 'poor', () => 0), 'Poor')
  assert.equal(variant('MM', 'Kid', 'dirty'), null)
  assert.equal(variant('GG', 'Egg', 'drag'), null)
  assert.equal(variant('GG', 'Kid', 'drag'), null)
  for (let i = 0; i < 3; i++) assert.equal(variant('GG', 'Adult', 'drag', () => i), `motion/drag${i + 1}101213`)
})

test('walk URLs exist for every sex/stage/direction, MM keeps the single gait', () => {
  for (const sex of ['GG', 'MM']) {
    for (const stage of STAGES) {
      for (const dir of ['left', 'right']) {
        for (let i = 0; i < 20; i++) assert.ok(has(walkUrl(sex, stage, dir)), walkUrl(sex, stage, dir))
        if (sex === 'MM') assert.equal(walkUrl(sex, stage, dir), `pet/Action/MM/${stage}/walk/walk_${dir}.swf`)
      }
    }
  }
})

test('variant-bearing actions resolve to an existing clip', () => {
  const actions = ['dirty', 'poor', 'drag', 'play']
  for (const sex of ['GG', 'MM']) {
    for (const stage of STAGES) {
      for (const mood of ['happy', 'peaceful', 'upset', 'sad']) {
        for (const a of actions) {
          for (let i = 0; i < 10; i++) {
            const { url } = route(sex, stage, a, mood)
            // Adult never routes dirty (leadClip falls back to speak).
            if (a === 'dirty' && stage === 'Adult') continue
            if (['dirty', 'poor', 'drag', 'play'].includes(a)) assert.ok(has(url), url)
          }
        }
      }
    }
  }
})

test('extra plays exist, take one slot each, and only single-frame ones carry holdMs', () => {
  for (const [sex, data] of Object.entries(ACTIONS)) {
    for (const [stage, list] of Object.entries(data.extraPlay ?? {})) {
      for (const e of list) assert.ok(has(`pet/Action/${sex}/${stage}/${e.clip}.swf`), e.clip)
    }
  }
  // The imported Egg extras contain adult artwork, so every roll keeps a numbered play.
  for (const roll of [0, 0.5, 47 / 49, 0.9999]) assert.equal(extraPlay('GG', 'Egg', 47, roll), null)
  assert.equal(extraPlay('GG', 'Adult', 127, (127 + 0.25) / 131)?.clip, 'motion/005')
  assert.equal(extraPlay('GG', 'Adult', 127, 0.9999)?.clip, 'motion/021')
  assert.equal(extraPlay('MM', 'Egg', 29, 0.9999), null)
  for (let i = 0; i < 400; i++) {
    const t = route('GG', 'Adult', 'play', 'happy')
    assert.ok(has(t.url), t.url)
    if (t.url.includes('/motion/')) assert.equal(!!t.opt.opt?.holdMs, /\/00[59]\.swf$/.test(t.url), t.url)
  }
})

test('look-around clips after a walk exist for GG and are absent for MM', () => {
  for (const stage of STAGES) {
    for (const dir of ['left', 'right']) {
      for (let i = 0; i < 20; i++) {
        const u = lookUrl('GG', stage, dir)
        assert.ok(u && has(u), `${stage} ${dir} ${u}`)
      }
      assert.equal(lookUrl('MM', stage, dir), null)
    }
  }
})

test('hide variants resolve to existing clips', () => {
  for (const sex of ['GG', 'MM']) {
    for (const stage of STAGES) {
      for (const a of ['hideleft', 'hideright']) {
        for (let i = 0; i < 10; i++) assert.ok(has(route(sex, stage, a, 'happy').url), `${sex} ${stage} ${a}`)
      }
    }
  }
})

test('small-game icons exist', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../src/renderer/ui/smallgame.ts', import.meta.url), 'utf8')
  for (const [, icon] of src.matchAll(/icon: '([a-z]+)'/g)) assert.ok(has(`pet/quickBar/TickleSystem/${icon}00.png`), icon)
})
