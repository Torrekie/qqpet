import assert from 'node:assert/strict'
import test from 'node:test'
import { readRufflePanic } from '../../src/ios/diagnostics.ts'

function player({ url, title = '', body = '', details, shadow = true } = {}) {
  const elements = {
    '#panic-title': { textContent: title },
    '#panic-body': { textContent: body },
    '#panic-details-content textarea': details === undefined ? null : { value: details },
  }
  return { dataset: url === undefined ? {} : { swf: url }, shadowRoot: shadow ? { querySelector: (selector) => elements[selector] ?? null } : null }
}
function page(...players) {
  return { querySelectorAll(selector) { assert.equal(selector, 'ruffle-player'); return players } }
}

test('healthy players and empty panic details produce no diagnostic', () => {
  assert.equal(readRufflePanic(page()), null)
  assert.equal(readRufflePanic(page(player({ shadow: false }), player(), player({ details: '' }), player({ details: ' \n\t' }))), null)
})

test('the first player with actual panic details supplies its existing DOM text', () => {
  const first = { url: 'pet/Action/GG/Egg/Stand.swf', title: 'Ruffle panic', body: 'The movie failed', details: '# Error Info\nfirst panic stack' }
  const later = { url: 'later.swf', details: 'later secondary error' }
  assert.deepEqual(readRufflePanic(page(player({ title: 'empty screen' }), player(first), player(later))), first)
})

test('panic fields are bounded and missing optional fields stay empty', () => {
  const diagnostic = readRufflePanic(page(player({ title: 't'.repeat(513), body: 'b'.repeat(2049), details: 'd'.repeat(32769) })))
  assert.deepEqual(diagnostic, { url: null, title: 't'.repeat(512), body: 'b'.repeat(2048), details: 'd'.repeat(32768) })
  assert.deepEqual(readRufflePanic(page(player({ details: 'stack' }))), { url: null, title: '', body: '', details: 'stack' })
})
