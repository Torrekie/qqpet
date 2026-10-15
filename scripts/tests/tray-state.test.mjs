import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { renderer } from './pet-drag.test.mjs'

function statePanel(focused = false) {
  const events = new EventTarget()
  const focus = []
  const profiles = []
  const timers = new Map()
  let nextTimer = 0
  let cursor = () => {}
  const element = (className, ...children) => {
    const el = {
      className, style: {}, dataset: {}, children: [],
      getBoundingClientRect: () => ({ left: 700, top: 0, right: 900, bottom: 300 }),
      addEventListener(type, listener) { this[type] = listener },
      replaceChildren(...next) {
        this.children = next
        for (const child of next) if (typeof child === 'object') child.parentElement = this
      },
      remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this) },
    }
    el.replaceChildren(...children)
    return el
  }
  const body = element('body')
  body.appendChild = el => { body.children.push(el); el.parentElement = body }
  const source = stripTypeScriptTypes(readFileSync(new URL('../../src/renderer/ui/state.ts', import.meta.url), 'utf8'))
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const ui = runInNewContext(source + '\n;({ openState, closeState })', {
    window: { addEventListener: events.addEventListener.bind(events), qqpet: { setFocusable: on => focus.push(on), onCursor: l => { cursor = l } } },
    setTimeout: (f, ms) => { timers.set(++nextTimer, { f, ms }); return nextTimer }, clearTimeout: id => timers.delete(id),
    document: { body, hasFocus: () => focused }, innerWidth: 1920, innerHeight: 1080,
    div: element, img: element,
    button: (cls, click, ...children) => Object.assign(element(cls, ...children), { click }),
    frame: content => content, progress: () => '',
    info: { health: 5 }, save: { settings: {}, petComputedlInfo: { level: 1 }, selfGoodUseOption: {} },
    activity: () => false, growthPerMinute: () => 1, onInfoChange() {},
    openPetInfo: () => profiles.push(focus.at(-1)),
  })
  const elapse = () => { const due = [...timers.values()]; timers.clear(); for (const t of due) t.f() }
  return { ...ui, body, focus, profiles, timers, elapse, move: (x, y) => cursor({ x, y }), blur: () => events.dispatchEvent(new Event('blur')) }
}

test('the tray status panel takes focus and hides on window blur; closing is idempotent', () => {
  const ui = statePanel()
  ui.openState(800, 0)
  assert.equal(ui.body.children.length, 1)
  assert.deepEqual(ui.focus, [true])
  ui.blur()
  assert.equal(ui.body.children.length, 0)
  assert.deepEqual(ui.focus, [true, false])
  ui.blur()
  ui.closeState()
  assert.deepEqual(ui.focus, [true, false])
  ui.openState(800, 0)
  const head = ui.body.children[0].children[0].children[0].children[0]
  head.children[0].click()
  assert.equal(ui.body.children.length, 0)
  assert.deepEqual(ui.profiles, [false], 'release status focus before the editable profile takes focus')
})

test('left then right tray clicks hide status before opening the menu, even without a blur event', () => {
  const ui = statePanel()
  let menus = 0
  const app = renderer(144, undefined, null, 'Egg', {
    ui: { ...ui, openMenu: () => { assert.equal(ui.body.children.length, 0); menus++ } },
  })
  app.save.havePet = true
  app.trayClick({ kind: 'state', x: 800, y: 0 })
  assert.equal(ui.body.children.length, 1)
  app.trayClick({ kind: 'menu', x: 800, y: 0 })
  assert.equal(ui.body.children.length, 0)
  assert.equal(menus, 1)
  assert.deepEqual(ui.focus, [true, false])
})

test('closing status keeps the focus another panel (chat, setup...) already holds', () => {
  const ui = statePanel(true)
  ui.openState(800, 0)
  ui.blur()
  assert.equal(ui.body.children.length, 0)
  assert.deepEqual(ui.focus, [])
})

test('a Windows tray status panel closes after 3s unless the cursor enters it (#41)', () => {
  const ui = statePanel()
  ui.openState(800, 0, true)
  assert.deepEqual([...ui.timers.values()].map(t => t.ms), [3000])
  ui.elapse()
  assert.equal(ui.body.children.length, 0)
})

test('entering cancels the auto-close, leaving restarts the full 3s, re-entering cancels again', () => {
  const ui = statePanel()
  ui.openState(800, 0, true)
  ui.move(800, 100)
  assert.equal(ui.timers.size, 0)
  ui.move(1200, 600)
  assert.deepEqual([...ui.timers.values()].map(t => t.ms), [3000])
  ui.move(750, 50)
  assert.equal(ui.timers.size, 0)
  ui.elapse()
  assert.equal(ui.body.children.length, 1)
  ui.move(1200, 600)
  ui.elapse()
  assert.equal(ui.body.children.length, 0)
})

test('status opened otherwise never closes by itself; blur still closes the auto-closing one', () => {
  const ui = statePanel()
  ui.openState(800, 0)
  ui.move(1200, 600)
  assert.equal(ui.timers.size, 0)
  ui.openState(800, 0, true)
  ui.blur()
  assert.equal(ui.body.children.length, 0)
  assert.equal(ui.timers.size, 0)
})

test('only the Windows tray left click asks for auto-close', () => {
  const tray = readFileSync(new URL('../../src/main/tray.ts', import.meta.url), 'utf8')
  assert.match(tray, /tray\.on\('click'.*autoClose: process\.platform === 'win32'/)
  assert.doesNotMatch(tray.split('\n').find(l => l.includes("'right-click'")), /autoClose/)
})
