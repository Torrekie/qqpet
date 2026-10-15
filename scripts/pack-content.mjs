#!/usr/bin/env node
// Builds content packs (#28) from resources/pet and the packs.json index that lists them.
//   node --experimental-strip-types scripts/pack-content.mjs --version 0.6.7 [--base v0.6.6] [--min-shell 0.6.6]
//        [--out dist/packs] [--url-prefix https://github.com/AnkioTomas/qqpet/releases/download/v0.6.7/]
// Without --base: the full "core" pack. With --base <tag>: only what changed in resources/pet since that tag, with
// removed files listed as deletes. Both can be given in one run with --full; packs.json lists everything built.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MANIFEST, checkPath, parseManifest, readPack, sha256, writeZip } from '../src/main/content-pack.ts'

const { values: a } = parseArgs({
  options: {
    version: { type: 'string' },
    base: { type: 'string' },
    full: { type: 'boolean' },
    'min-shell': { type: 'string' },
    out: { type: 'string', default: 'dist/packs' },
    'url-prefix': { type: 'string', default: '' },
  },
})
const version = (a.version ?? '').replace(/^v/, '')
if (!version) throw new Error('--version is required')
const root = resolve('resources')
const out = resolve(a.out)
mkdirSync(out, { recursive: true })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 })
const LFS = Buffer.from('version https://git-lfs')

const read = (path) => {
  const data = readFileSync(join(root, path))
  if (data.subarray(0, LFS.length).equals(LFS)) throw new Error(`${path} is a Git LFS pointer; run git lfs pull`)
  return data
}

function build(name, paths, extra) {
  const files = paths.sort().map((path) => {
    const data = read(checkPath(path))
    return { path, size: data.length, sha256: sha256(data) }
  })
  const manifest = parseManifest({ id: 'core', version, ...extra, files })
  const body = Buffer.from(JSON.stringify(manifest))
  const file = join(out, name)
  writeZip(file, [MANIFEST, ...files.map((f) => f.path)], (n) => (n === MANIFEST ? body : read(n)))
  readPack(file) // the written pack must read back as valid
  const data = readFileSync(file)
  console.log(`${name}: ${files.length} files, ${(data.length / 1e6).toFixed(1)} MB, ${manifest.deletes?.length ?? 0} deletes`)
  return { id: manifest.id, version, ...(manifest.base && { base: manifest.base }), minShell: manifest.minShell, name, url: a['url-prefix'] + name, size: data.length, sha256: sha256(data) }
}

const tracked = (ref) => git('ls-tree', '-r', '--name-only', '-z', ref, '--', 'resources/pet').split('\0').filter(Boolean).map((p) => p.slice('resources/'.length))
const packs = []
if (!a.base || a.full) packs.push(build(`QQPet-content-${version}.qqpetpack`, tracked('HEAD'), { minShell: (a['min-shell'] ?? version).replace(/^v/, '') }))
if (a.base) {
  const base = a.base.replace(/^v/, '')
  const changed = [], deletes = []
  for (const line of git('diff', '--name-status', '--no-renames', '-z', a.base, 'HEAD', '--', 'resources/pet').split('\0').filter(Boolean).reduce((acc, s, i, all) => (i % 2 ? acc : [...acc, [s, all[i + 1]]]), [])) {
    const [status, path] = line
    ;(status === 'D' ? deletes : changed).push(path.slice('resources/'.length))
  }
  if (!changed.length && !deletes.length) console.log(`resources/pet unchanged since ${a.base}: no incremental pack`)
  else packs.push(build(`QQPet-content-${base}-to-${version}.qqpetpack`, changed, { base, minShell: (a['min-shell'] ?? base).replace(/^v/, ''), deletes }))
}
writeFileSync(join(out, 'packs.json'), JSON.stringify({ schema: 1, packs }, null, 2) + '\n')
console.log(`packs.json: ${packs.length} packs`)
for (const p of packs) statSync(join(out, p.name))
