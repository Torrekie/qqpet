import assert from 'node:assert/strict'
import test from 'node:test'
import { isFatalRufflePanic, readPlayerPanic, readRufflePanic } from '../../src/shared/ruffle-panic.ts'

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

test('ordinary movie downloads, invalid assets, options and cancellation are not fatal runtime panics', () => {
  for (const message of ['Failed to fetch http://example.test/missing.swf', 'Not a valid swf: missing.swf', 'Invalid options: missing url', 'Failed to begin SWF load: AbortError: cancelled']) {
    const panic = readPlayerPanic(player({ details: `# Error Info\nError name: Error\nError message: ${message}\nError stack:\nother details` }))
    assert.equal(isFatalRufflePanic(panic), false, message)
  }
  assert.equal(isFatalRufflePanic({ details: '' }), false)
  assert.equal(isFatalRufflePanic({ details: '# Error Info\nError name: AbortError\nError message: operation cancelled' }), false)
})

test('Rust panic and invalid runtime state retain their real stack as fatal evidence', () => {
  for (const message of ["panicked at web/src/audio.rs: already borrowed", "Failed to begin SWF load: TypeError: null is not an object (evaluating 'this.instance.stream_from')", 'memory access out of bounds']) {
    const details = `# Error Info\nError name: Error\nError message: ${message}\nError stack:\nfirst stack`
    const panic = readPlayerPanic(player({ details }))
    assert.equal(isFatalRufflePanic(panic), true)
    assert.equal(panic.details, details)
  }
})
