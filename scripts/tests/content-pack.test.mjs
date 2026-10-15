import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MANIFEST, checkPath, compareVersion, installPack, installedLayers, lookup, packBlocker, parseManifest, readPack, sha256, writeZip } from '../../src/main/content-pack.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'qqpet-pack-'))

/** A pack of `files` ({path: text}); `manifest` overrides fields, `raw` adds unlisted zip entries. */
function pack(files, manifest = {}, raw = {}) {
  const data = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]))
  const m = { id: 'core', version: '0.7.0', minShell: '0.6.0', files: Object.entries(data).map(([path, b]) => ({ path, size: b.length, sha256: sha256(b) })), ...manifest }
  const all = { [MANIFEST]: Buffer.from(JSON.stringify(m)), ...data, ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Buffer.from(v)])) }
  const file = join(dir(), 'x.qqpetpack')
  writeZip(file, Object.keys(all), (n) => all[n])
  return file
}

/** Patches the first central-directory entry after the manifest's (the second entry). */
function patchCentral(file, at, write) {
  const b = readFileSync(file)
  let o = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  write(b, o + at)
  writeFileSync(file, b)
}

test('versions compare numerically', () => {
  assert.ok(compareVersion('0.6.10', '0.6.9') > 0)
  assert.equal(compareVersion('0.6.7-beta', '0.6.7'), 0)
  assert.ok(compareVersion('1.0.0', '0.99.99') > 0)
})

test('pack paths stay under pet/, relative and without traversal', () => {
  for (const ok of ['pet/a.swf', 'pet/Action/GG/Kid/Stand.swf']) assert.equal(checkPath(ok), ok)
  for (const bad of ['../pet/a', 'pet/../a', '/pet/a', 'pet\\a', 'C:/pet/a', 'pet//a', 'pet/./a', 'other/a', 'pet/a\0']) assert.throws(() => checkPath(bad), bad)
})

test('a written pack reads back with every file verified', () => {
  const file = pack({ 'pet/a.swf': 'AAA', 'pet/x/b.png': 'BB' })
  const got = {}
  const m = readPack(file, (f, d) => (got[f.path] = d.toString()))
  assert.equal(m.version, '0.7.0')
  assert.deepEqual(got, { 'pet/a.swf': 'AAA', 'pet/x/b.png': 'BB' })
})

test('manifests are validated', () => {
  const base = { id: 'core', version: '0.7.0', minShell: '0.6.0', files: [] }
  assert.deepEqual(parseManifest(base), base)
  for (const bad of [{ id: '../x' }, { version: 'x' }, { minShell: '' }, { base: '0.7.0' }, { files: [{ path: 'pet/a', size: -1, sha256: 'x' }] }, { deletes: ['pet/a'] }, { base: '0.6.0', deletes: ['../a'] }])
    assert.throws(() => parseManifest({ ...base, ...bad }), JSON.stringify(bad))
  assert.throws(() => parseManifest({ ...base, files: [{ path: 'pet/A', size: 0, sha256: '0'.repeat(64) }, { path: 'pet/a', size: 0, sha256: '0'.repeat(64) }] }), /重复/)
})

test('tampered, traversing, symlinked, compressed or padded packs are refused', () => {
  const tampered = pack({ 'pet/a.swf': 'AAA' }, { files: [{ path: 'pet/a.swf', size: 3, sha256: sha256(Buffer.from('BBB')) }] })
  assert.throws(() => readPack(tampered, () => {}), /sha256/)
  assert.throws(() => readPack(pack({}, {}, { 'pet/../evil': 'x' })), /非法路径/)
  assert.throws(() => readPack(pack({}, {}, { '/etc/evil': 'x' })), /非法路径/)
  assert.throws(() => readPack(pack({}, {}, { 'pet/extra.swf': 'x' })), /未列出/)
  const link = pack({ 'pet/a.swf': 'AAA' })
  patchCentral(link, 38, (b, o) => b.writeUInt32LE((0o120777 << 16) >>> 0, o))
  assert.throws(() => readPack(link), /符号链接/)
  const deflated = pack({ 'pet/a.swf': 'AAA' })
  patchCentral(deflated, 10, (b, o) => b.writeUInt16LE(8, o))
  assert.throws(() => readPack(deflated), /store/)
  assert.throws(() => readPack(pack({ 'pet/a.swf': 'AAA' }).replace(/x\.qqpetpack$/, 'missing')), /ENOENT/)
})

test('installing gates on shell and content version and leaves nothing behind on failure', () => {
  assert.equal(packBlocker({ version: '0.7.0', minShell: '0.6.0' }, '0.6.6', '0.6.6'), null)
  assert.match(packBlocker({ version: '0.7.0', minShell: '0.7.0' }, '0.6.6', '0.6.6'), /需要 v0\.7\.0/)
  assert.match(packBlocker({ version: '0.6.6', minShell: '0.6.0' }, '0.6.6', '0.6.6'), /已经是/)
  assert.match(packBlocker({ version: '0.7.0', base: '0.6.5', minShell: '0.6.0' }, '0.6.6', '0.6.6'), /增量包/)

  const packs = dir()
  const m = installPack(pack({ 'pet/a.swf': 'AAA' }, { base: '0.6.6' }), packs, '0.6.6', '0.6.6')
  assert.equal(m.version, '0.7.0')
  assert.deepEqual(readdirSync(packs), ['core@0.7.0'])
  assert.equal(readFileSync(join(packs, 'core@0.7.0/pet/a.swf'), 'utf8'), 'AAA')

  const bad = pack({ 'pet/b.swf': 'BBB', 'pet/c.swf': 'CCC' }, { version: '0.8.0', base: '0.7.0' })
  patchCentral(bad, 16, (b, o) => b.writeUInt32LE(0, o)) // the last file's crc: fails after the first was extracted
  assert.throws(() => installPack(bad, packs, '0.7.0', '0.6.6'), /校验失败/)
  assert.deepEqual(readdirSync(packs), ['core@0.7.0'])
})

test('layers chain from the bundle, newest first; stale or too-new packs drop out', () => {
  const packs = dir()
  const put = (m, files = {}) => {
    const d = join(packs, `${m.id}@${m.version}`)
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(d, p, '..'), { recursive: true })
      writeFileSync(join(d, p), t)
    }
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, MANIFEST), JSON.stringify({ id: 'core', minShell: '0.6.0', files: [], ...m }))
  }
  put({ id: 'core', version: '0.6.7', base: '0.6.6' })
  put({ id: 'core', version: '0.6.8', base: '0.6.7' })
  put({ id: 'core', version: '0.6.9', base: '0.6.5' }) // not on the chain
  put({ id: 'core', version: '0.7.0', base: '0.6.8', minShell: '0.7.0' }) // needs a newer shell
  writeFileSync(join(packs, '.tmp-x'), '')
  assert.deepEqual(installedLayers(packs, '0.6.6', '0.6.6').map((l) => l.manifest.version), ['0.6.8', '0.6.7'])
  // A shell that bundles 0.6.8 content already: the old packs no longer apply.
  assert.deepEqual(installedLayers(packs, '0.6.8', '0.6.8'), [])
  assert.deepEqual(installedLayers(join(packs, 'none'), '0.6.6', '0.6.6'), [])
})

test('lookup takes the top layer that has the file; deletes hide what is below', () => {
  const root = dir()
  const bundle = join(root, 'bundle')
  const layer = (name, files, deletes) => {
    const d = join(root, name)
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(d, p, '..'), { recursive: true })
      writeFileSync(join(d, p), t)
    }
    return { dir: d, manifest: { id: 'core', version: name, minShell: '0.6.0', files: [], ...(deletes && { base: '0', deletes }) } }
  }
  mkdirSync(join(bundle, 'pet'), { recursive: true })
  for (const f of ['a', 'b', 'c', 'd']) writeFileSync(join(bundle, 'pet', f), 'bundle')
  const layers = [layer('0.6.8', { 'pet/a': 'new' }, ['pet/c']), layer('0.6.7', { 'pet/a': 'old', 'pet/b': 'old' }, ['pet/D'])]
  const read = (p) => {
    const f = lookup(layers, bundle, p)
    return f && existsSync(f) ? readFileSync(f, 'utf8') : null
  }
  assert.equal(read('pet/a'), 'new')
  assert.equal(read('pet/b'), 'old')
  assert.equal(read('pet/c'), null)
  assert.equal(read('pet/d'), null)
  assert.equal(read('pet/zz'), null)
  assert.equal(lookup([], bundle, 'pet/a'), join(bundle, 'pet/a'))
})
