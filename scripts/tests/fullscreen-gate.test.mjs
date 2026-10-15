import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('full screen means covering the monitor without a maximized caption, whatever the flipping notification state says (#37)', () => {
  const src = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
  const ps = src.slice(src.indexOf('const FULLSCREEN_PS'), src.indexOf('function hideOnFullscreen'))
  // F11 from a maximized browser keeps WS_MAXIMIZE but drops the caption, so it must still count.
  assert.match(ps, /\(IsZoomed\(h\) && \(GetWindowLong\(h, -16\) & 0xC00000\) == 0xC00000\)/)
  assert.doesNotMatch(ps, /\$s -eq 2/)
  for (const cls of ['Shell_TrayWnd', 'MultitaskingViewFrame', 'XamlExplorerHostIslandWindow']) assert.ok(ps.includes(`"${cls}"`), cls)
})
