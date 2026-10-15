import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { patchRuffleAudio } from '../patch-ruffle-audio.mjs'
import { RUFFLE_RUNTIME_RECIPE, loadRuffleBundle, resolveRuffleBundle, ruffleCacheKey, ruffleCacheRecord, validRuffleCache, verifyCopiedRuffleBundle } from '../ruffle-bundle.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t, variant = '') {
  const directory = await fs.mkdtemp(join(tmpdir(), 'qqpet-ruffle-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const files = {
    'ruffle.js': Buffer.from('class Player{unmuteAudioContext(){return 1}}'),
    'core.ruffle.fixture.js': Buffer.from('/* matching generated glue */'),
    'fallback-fixture.wasm': Buffer.from('fallback' + variant),
    'simd-fixture.wasm': Buffer.from('simd' + variant),
  }
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(join(directory, name), bytes)
  const manifest = { ...structuredClone(RUFFLE_RUNTIME_RECIPE), fallbackWasm: 'fallback-fixture.wasm', files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) }
  const writeManifest = () => fs.writeFile(join(directory, 'qqpet-runtime.json'), JSON.stringify(manifest))
  await writeManifest()
  return { directory, files, manifest, writeManifest }
}

test('bundle source defaults to the pinned npm package and accepts an explicit directory', () => {
  assert.equal(resolveRuffleBundle({}), resolve('node_modules/@ruffle-rs/ruffle'))
  assert.equal(resolveRuffleBundle({ QQPET_RUFFLE_BUNDLE: 'custom-bundle' }), resolve('custom-bundle'))
})

test('a complete audited custom bundle supplies its own paired loader and fallback name', async t => {
  const f = await fixture(t)
  const bundle = await loadRuffleBundle(f.directory)
  assert.equal(bundle.directory, f.directory)
  assert.equal(bundle.version, '0.6.0')
  assert.equal(bundle.fallbackWasm, 'fallback-fixture.wasm')
  assert.equal(bundle.fallbackHash, hash(f.files[bundle.fallbackWasm]))
  const patched = patchRuffleAudio(f.files['ruffle.js'], bundle.version, bundle.loaderHash)
  assert.equal(patched.split('__qqpetRespectSystemAudio').length, 2)
  assert.throws(() => patchRuffleAudio(f.files['ruffle.js'], bundle.version), /loader changed/)
})

test('missing, mixed or modified chunks are rejected instead of combining bundles', async t => {
  for (const mutation of ['missing', 'mixed', 'modified', 'hash']) {
    const f = await fixture(t)
    if (mutation === 'missing') await fs.unlink(join(f.directory, 'simd-fixture.wasm'))
    if (mutation === 'mixed') await fs.writeFile(join(f.directory, 'core.ruffle.other.js'), 'another build')
    if (mutation === 'modified') await fs.writeFile(join(f.directory, 'core.ruffle.fixture.js'), 'different glue')
    if (mutation === 'hash') { f.manifest.files['fallback-fixture.wasm'] = '0'.repeat(64); await f.writeManifest() }
    await assert.rejects(loadRuffleBundle(f.directory), /file set|checksum mismatch/)
  }
})

test('custom bundles must match the source, repository patch and exact build toolchain', async t => {
  for (const field of ['source', 'patch', 'toolchain']) {
    const f = await fixture(t)
    const key = Object.keys(f.manifest[field])[0]
    f.manifest[field][key] = 'unreviewed change'
    await f.writeManifest()
    await assert.rejects(loadRuffleBundle(f.directory), /pinned recipe/)
  }
  const f = await fixture(t)
  f.manifest.patch.sha256 = '0'.repeat(64)
  await f.writeManifest()
  await assert.rejects(loadRuffleBundle(f.directory), /patch.*pinned recipe/)
})

test('unsafe file paths and a fallback outside the bundle root are rejected', async t => {
  for (const path of ['../escape.js', '/absolute.js', 'nested/../escape.js', 'C:\\outside.js', 'nested//chunk.js']) {
    const f = await fixture(t)
    f.manifest.files[path] = '0'.repeat(64)
    await f.writeManifest()
    await assert.rejects(loadRuffleBundle(f.directory), /file hash or path/)
  }
  const f = await fixture(t)
  f.manifest.fallbackWasm = '../fallback.wasm'
  await f.writeManifest()
  await assert.rejects(loadRuffleBundle(f.directory), /fallbackWasm/)
})

test('bundle files and its root cannot be symlinks', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.unlink(join(f.directory, 'core.ruffle.fixture.js'))
  await fs.symlink('ruffle.js', join(f.directory, 'core.ruffle.fixture.js'))
  await assert.rejects(loadRuffleBundle(f.directory), /symlink/)
  const other = await fixture(t)
  const link = join(f.directory, 'linked-bundle')
  await fs.symlink(other.directory, link)
  await assert.rejects(loadRuffleBundle(link), /real directory/)
})

test('the copied directory must still be the entire selected bundle before lowering', async t => {
  const first = await fixture(t, 'first')
  const second = await fixture(t, 'second')
  const bundle = await loadRuffleBundle(first.directory)
  await verifyCopiedRuffleBundle(bundle, first.directory)
  await assert.rejects(verifyCopiedRuffleBundle(bundle, second.directory), /checksum mismatch/)
})

test('lowering cache separates fallback bytes and rejects another recipe or damaged output', () => {
  const first = hash('first fallback'), second = hash('second fallback'), lowered = Buffer.from('lowered')
  assert.notEqual(ruffleCacheKey(first), ruffleCacheKey(second))
  const record = ruffleCacheRecord(first, lowered)
  assert.equal(validRuffleCache(record, first, lowered), true)
  assert.equal(validRuffleCache(record, second, lowered), false)
  assert.equal(validRuffleCache({ ...record, recipe: 'older' }, first, lowered), false)
  assert.equal(validRuffleCache({ ...record, binaryen: 'other' }, first, lowered), false)
  assert.equal(validRuffleCache(record, first, Buffer.from('corrupted')), false)
})
