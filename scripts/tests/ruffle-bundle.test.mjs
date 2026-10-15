import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { patchRuffleAudio } from '../patch-ruffle-audio.mjs'
import { RUFFLE_LOWERING_RECIPE, RUFFLE_RUNTIME_RECIPE, loadRuffleBundle, recordPatchedRuffleOutput, resolveRuffleBundle, ruffleCacheKey, ruffleCacheRecord, validRuffleCache, verifyCopiedRuffleBundle, verifyPatchedRuffleOutput } from '../ruffle-bundle.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const wasmHeader = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
const wasm = variant => {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(variant)])
  return Buffer.concat([wasmHeader, Buffer.from([0, payload.length]), payload])
}
const counterWasm = () => {
  const name = Buffer.from('audio_buffer_count')
  const exports = Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([2, 0])])
  return Buffer.concat([wasmHeader, Buffer.from([5, 3, 1, 0, 1, 7, exports.length]), exports])
}

async function fixture(t, variant = '') {
  const directory = await fs.mkdtemp(join(tmpdir(), 'qqpet-ruffle-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const files = {
    'ruffle.js': Buffer.from('class Player{unmuteAudioContext(){return 1}}'),
    'ruffle.js.map': Buffer.from('{}'),
    'core.ruffle.fixture.js': Buffer.from('/* matching generated glue */'),
    'fallback-fixture.wasm': wasm('fallback' + variant),
    'simd-fixture.wasm': wasm('simd' + variant),
  }
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(join(directory, name), bytes)
  const manifest = { ...structuredClone(RUFFLE_RUNTIME_RECIPE), fallbackWasm: 'fallback-fixture.wasm', files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) }
  const writeManifest = () => fs.writeFile(join(directory, 'qqpet-runtime.json'), JSON.stringify(manifest))
  await writeManifest()
  return { directory, files, manifest, writeManifest }
}

async function processedFixture(t) {
  const f = await fixture(t)
  const bundle = await loadRuffleBundle(f.directory)
  await fs.writeFile(join(f.directory, 'ruffle.js'), patchRuffleAudio(f.files['ruffle.js'], bundle.version, bundle.loaderHash))
  await fs.writeFile(join(f.directory, bundle.fallbackWasm), wasm('lowered'))
  await recordPatchedRuffleOutput(bundle, f.directory)
  const manifest = JSON.parse(await fs.readFile(join(f.directory, 'qqpet-runtime.json'), 'utf8'))
  return { ...f, inputManifest: f.manifest, manifest, writeManifest: () => fs.writeFile(join(f.directory, 'qqpet-runtime.json'), JSON.stringify(manifest)) }
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

test('processed output preserves the raw inventory and records the complete final directory separately', async t => {
  const f = await processedFixture(t)
  assert.deepEqual(f.manifest.files, f.inputManifest.files)
  assert.deepEqual(Object.keys(f.manifest.processed.files).sort(), Object.keys(f.inputManifest.files).sort())
  const { files, ...recipe } = f.manifest.processed
  assert.deepEqual(recipe, RUFFLE_LOWERING_RECIPE)
  assert.notEqual(files['ruffle.js'], f.manifest.files['ruffle.js'])
  assert.notEqual(files[f.manifest.fallbackWasm], f.manifest.files[f.manifest.fallbackWasm])
  assert.equal(files['core.ruffle.fixture.js'], f.manifest.files['core.ruffle.fixture.js'])
  assert.equal(Object.hasOwn(files, 'qqpet-runtime.json'), false)
  assert.equal(await verifyPatchedRuffleOutput(f.directory), undefined)
  await assert.rejects(loadRuffleBundle(f.directory), /Processed.*raw bundle input/)
})

test('packaging rejects raw bundles and legacy output without a custom processing manifest', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyPatchedRuffleOutput(f.directory), /raw bundles are not accepted/)
  await fs.unlink(join(f.directory, 'qqpet-runtime.json'))
  await recordPatchedRuffleOutput({ manifest: undefined }, f.directory)
  await assert.rejects(verifyPatchedRuffleOutput(f.directory), /requires a custom runtime manifest/)
})

test('processed output still requires the exact lowering, source, Weak patch and build toolchain recipes', async t => {
  for (const field of ['source', 'patch', 'toolchain', 'processed']) {
    const f = await processedFixture(t)
    const key = Object.keys(f.manifest[field]).find(key => key !== 'files')
    f.manifest[field][key] = 'unreviewed change'
    await f.writeManifest()
    await assert.rejects(verifyPatchedRuffleOutput(f.directory), /pinned recipe/)
  }
})

test('processed output rejects edits, extra chunks and inventory changes after lowering', async t => {
  for (const mutation of ['modified', 'extra', 'missing', 'inventory']) {
    const f = await processedFixture(t)
    if (mutation === 'modified') await fs.appendFile(join(f.directory, 'ruffle.js'), '/* changed */')
    if (mutation === 'extra') await fs.writeFile(join(f.directory, 'core.ruffle.other.js'), 'another build')
    if (mutation === 'missing') await fs.unlink(join(f.directory, 'simd-fixture.wasm'))
    if (mutation === 'inventory') {
      const bytes = Buffer.from('different unprocessed glue')
      await fs.writeFile(join(f.directory, 'core.ruffle.fixture.js'), bytes)
      f.manifest.processed.files['core.ruffle.fixture.js'] = hash(bytes)
      await f.writeManifest()
    }
    await assert.rejects(verifyPatchedRuffleOutput(f.directory), /checksum mismatch|file set|unprocessed chunk/)
  }
})

test('production output rejects the diagnostic counter even when its output checksum matches', async t => {
  for (const name of ['ruffle.js', 'ruffle.js.map', 'fallback-fixture.wasm']) {
    const f = await processedFixture(t)
    const bytes = name.endsWith('.wasm') ? counterWasm() : Buffer.from('/* audio_buffer_count */')
    await fs.writeFile(join(f.directory, name), bytes)
    f.manifest.processed.files[name] = hash(bytes)
    // Maps are not lowered; model a diagnostic raw build with a matching map.
    if (name.endsWith('.map')) f.manifest.files[name] = hash(bytes)
    await f.writeManifest()
    await assert.rejects(verifyPatchedRuffleOutput(f.directory), /diagnostic audio counter/)
  }
})

test('processing cannot certify an accidentally mixed unprocessed chunk', async t => {
  const f = await fixture(t)
  const bundle = await loadRuffleBundle(f.directory)
  await fs.appendFile(join(f.directory, 'core.ruffle.fixture.js'), '/* other build */')
  await assert.rejects(recordPatchedRuffleOutput(bundle, f.directory), /unprocessed chunk/)
  const manifest = JSON.parse(await fs.readFile(join(f.directory, 'qqpet-runtime.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest, 'processed'), false)
})
