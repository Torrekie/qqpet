import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crc32 } from 'node:zlib'

/**
 * Content packs (#28): resources/pet shipped apart from the shell. A pack is a zip in store mode (SWFs are already
 * compressed) holding manifest.json and the files it lists; paths are relative to resources/, e.g. pet/Action/....
 * An incremental pack names the content version it applies on (`base`) and may delete files of the layers below.
 */
export interface PackFile {
  path: string
  size: number
  sha256: string
}

export interface Manifest {
  id: string
  version: string
  /** Oldest shell (app version) that can use the pack. */
  minShell: string
  base?: string
  files: PackFile[]
  deletes?: string[]
}

/** One entry of packs.json, published beside the release's packs. */
export interface PackIndexEntry {
  id: string
  version: string
  base?: string
  minShell: string
  name: string
  url: string
  size: number
  sha256: string
}

export interface PackIndex {
  schema: 1
  packs: PackIndexEntry[]
}

export const MANIFEST = 'manifest.json'
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const SHA = /^[0-9a-f]{64}$/

/** x.y.z compared numerically; pre-release and build metadata are ignored, like the update check. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[+-]/)[0].split('.').map(Number)
  const pb = b.split(/[+-]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** A pack may only write under pet/: relative, forward slashes, no empty, '.' or '..' segments, no drive letters. */
export function checkPath(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('pet/') || p.length > 512 || /[\\:\0]/.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..'))
    throw new Error(`非法路径：${String(p).slice(0, 80)}`)
  return p
}

export function parseManifest(raw: unknown): Manifest {
  const m = raw as Manifest
  if (!m || typeof m !== 'object') throw new Error('manifest 不是对象')
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new Error('manifest.id 无效')
  for (const k of ['version', 'minShell'] as const) if (typeof m[k] !== 'string' || !VERSION.test(m[k])) throw new Error(`manifest.${k} 无效`)
  if (m.base !== undefined && (typeof m.base !== 'string' || !VERSION.test(m.base))) throw new Error('manifest.base 无效')
  if (m.base !== undefined && compareVersion(m.version, m.base) <= 0) throw new Error('manifest.version 必须高于 base')
  if (!Array.isArray(m.files)) throw new Error('manifest.files 无效')
  const seen = new Set<string>()
  for (const f of m.files) {
    const key = checkPath(f?.path).toLowerCase()
    if (seen.has(key)) throw new Error(`重复文件：${f.path}`)
    seen.add(key)
    if (!Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !SHA.test(f.sha256)) throw new Error(`文件信息无效：${f.path}`)
  }
  if (m.deletes !== undefined && (!Array.isArray(m.deletes) || m.base === undefined)) throw new Error('manifest.deletes 只能出现在增量包')
  for (const d of m.deletes ?? []) checkPath(d)
  return { id: m.id, version: m.version, minShell: m.minShell, ...(m.base && { base: m.base }), files: m.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })), ...(m.deletes?.length && { deletes: [...m.deletes] }) }
}

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

// ---- zip, store mode only ----

const u16 = (b: Buffer, v: number, o: number): number => b.writeUInt16LE(v, o)
const u32 = (b: Buffer, v: number, o: number): number => b.writeUInt32LE(v >>> 0, o)

/** Writes `names` (read through `read`) as a store-mode zip, one file at a time; returns the written size. */
export function writeZip(out: string, names: string[], read: (name: string) => Buffer): number {
  if (names.length > 0xffff) throw new Error('too many files for a zip without zip64')
  const fd = openSync(out, 'w')
  const central: Buffer[] = []
  let offset = 0
  try {
    for (const name of names) {
      const data = read(name)
      const n = Buffer.from(name, 'utf8')
      if (offset + data.length > 0xfffffff0) throw new Error('pack too large for a zip without zip64')
      const crc = crc32(data)
      const local = Buffer.alloc(30)
      u32(local, 0x04034b50, 0); u16(local, 20, 4); u16(local, 0x0800, 6); u16(local, 0, 8)
      u32(local, crc, 14); u32(local, data.length, 18); u32(local, data.length, 22); u16(local, n.length, 26)
      const head = Buffer.alloc(46)
      u32(head, 0x02014b50, 0); u16(head, 0x0314, 4); u16(head, 20, 6); u16(head, 0x0800, 8)
      u32(head, crc, 16); u32(head, data.length, 20); u32(head, data.length, 24); u16(head, n.length, 28)
      u32(head, (0o100644 << 16) >>> 0, 38); u32(head, offset, 42)
      central.push(head, n)
      writeSync(fd, local); writeSync(fd, n); writeSync(fd, data)
      offset += 30 + n.length + data.length
    }
    const dir = Buffer.concat(central)
    const end = Buffer.alloc(22)
    u32(end, 0x06054b50, 0); u16(end, names.length, 8); u16(end, names.length, 10); u32(end, dir.length, 12); u32(end, offset, 16)
    writeSync(fd, dir); writeSync(fd, end)
    return offset + dir.length + 22
  } finally {
    closeSync(fd)
  }
}

interface ZipEntry {
  name: string
  size: number
  crc: number
  /** Offset of the local header. */
  at: number
}

function readAt(fd: number, at: number, length: number): Buffer {
  const b = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = readSync(fd, b, got, length - got, at + got)
    if (!n) throw new Error('文件被截断')
    got += n
  }
  return b
}

/** The central directory; rejects compression, encryption, symlinks and directory entries. */
function zipEntries(fd: number): Map<string, ZipEntry> {
  const size = fstatSync(fd).size
  const tail = readAt(fd, Math.max(0, size - 65557), Math.min(size, 65557))
  const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (e < 0) throw new Error('不是 zip 文件')
  const count = tail.readUInt16LE(e + 10)
  const dirSize = tail.readUInt32LE(e + 12)
  const dirAt = tail.readUInt32LE(e + 16)
  if (dirAt + dirSize > size) throw new Error('zip 目录损坏')
  const dir = readAt(fd, dirAt, dirSize)
  const out = new Map<string, ZipEntry>()
  for (let o = 0, i = 0; i < count; i++) {
    if (dir.readUInt32LE(o) !== 0x02014b50) throw new Error('zip 目录损坏')
    const flags = dir.readUInt16LE(o + 8)
    const method = dir.readUInt16LE(o + 10)
    const csize = dir.readUInt32LE(o + 20)
    const usize = dir.readUInt32LE(o + 24)
    const nl = dir.readUInt16LE(o + 28)
    const xl = dir.readUInt16LE(o + 30)
    const cl = dir.readUInt16LE(o + 32)
    const mode = dir.readUInt32LE(o + 38) >>> 16
    const name = dir.toString('utf8', o + 46, o + 46 + nl)
    if (flags & 1) throw new Error('不支持加密的 zip')
    if (method !== 0 || csize !== usize) throw new Error('内容包必须是不压缩（store）的 zip')
    if ((mode & 0o170000) === 0o120000) throw new Error(`内容包不能含符号链接：${name}`)
    if (name.endsWith('/')) throw new Error(`内容包不能含目录项：${name}`)
    if (name !== MANIFEST) checkPath(name)
    if (out.has(name)) throw new Error(`重复文件：${name}`)
    out.set(name, { name, size: usize, crc: dir.readUInt32LE(o + 16), at: dir.readUInt32LE(o + 42) })
    o += 46 + nl + xl + cl
  }
  return out
}

function entryData(fd: number, e: ZipEntry): Buffer {
  const h = readAt(fd, e.at, 30)
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip 项损坏：${e.name}`)
  const data = readAt(fd, e.at + 30 + h.readUInt16LE(26) + h.readUInt16LE(28), e.size)
  if (crc32(data) !== e.crc) throw new Error(`校验失败：${e.name}`)
  return data
}

/** Opens a pack and returns its validated manifest; `each` gets every listed file once its size and sha256 match. */
export function readPack(file: string, each?: (f: PackFile, data: Buffer) => void): Manifest {
  const fd = openSync(file, 'r')
  try {
    const entries = zipEntries(fd)
    const me = entries.get(MANIFEST)
    if (!me) throw new Error('缺少 manifest.json')
    let raw: unknown
    try {
      raw = JSON.parse(entryData(fd, me).toString('utf8'))
    } catch (e) {
      throw new Error(`manifest.json 无法解析：${(e as Error).message}`)
    }
    const m = parseManifest(raw)
    if (entries.size !== m.files.length + 1) throw new Error('内容包里有 manifest 未列出的文件')
    for (const f of m.files) {
      const e = entries.get(f.path)
      if (!e) throw new Error(`缺少文件：${f.path}`)
      if (e.size !== f.size) throw new Error(`大小不符：${f.path}`)
      if (each) {
        const data = entryData(fd, e)
        if (sha256(data) !== f.sha256) throw new Error(`sha256 不符：${f.path}`)
        each(f, data)
      }
    }
    return m
  } finally {
    closeSync(fd)
  }
}

// ---- installed packs ----

export interface Layer {
  dir: string
  manifest: Manifest
}

const readManifest = (dir: string): Manifest | null => {
  try {
    return parseManifest(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')))
  } catch {
    return null
  }
}

/**
 * Installed packs that apply on top of the bundled content, newest first. They chain up from `bundled`: a full pack
 * must be newer than what is below it, an incremental one must sit exactly on it. Packs a newer shell's bundle
 * already covers, or that need a newer shell, are left out, so a shell upgrade or downgrade never mixes content.
 */
export function installedLayers(packsDir: string, bundled: string, shell: string): Layer[] {
  let names: string[] = []
  try {
    names = readdirSync(packsDir)
  } catch {
    return []
  }
  const all = names
    .filter((n) => !n.startsWith('.'))
    .map((n) => ({ dir: join(packsDir, n), manifest: readManifest(join(packsDir, n)) }))
    .filter((l): l is Layer => !!l.manifest && compareVersion(l.manifest.minShell, shell) <= 0)
    .sort((a, b) => compareVersion(a.manifest.version, b.manifest.version))
  const out: Layer[] = []
  let at = bundled
  for (const l of all) {
    const m = l.manifest
    if (compareVersion(m.version, at) > 0 && (m.base === undefined || m.base === at)) {
      out.unshift(l)
      at = m.version
    }
  }
  return out
}

export const contentVersion = (layers: Layer[], bundled: string): string => layers[0]?.manifest.version ?? bundled

/** Why the pack cannot go on the current content, or null when it can. */
export function packBlocker(m: Pick<Manifest, 'version' | 'minShell' | 'base'>, content: string, shell: string): string | null {
  if (compareVersion(m.minShell, shell) > 0) return `需要 v${m.minShell} 或更新的程序（当前 v${shell}）`
  if (compareVersion(m.version, content) <= 0) return `已经是 v${content} 内容，不需要 v${m.version}`
  if (m.base !== undefined && m.base !== content) return `这是 v${m.base} → v${m.version} 的增量包，当前内容是 v${content}`
  return null
}

/** Verifies every file, extracts to a temporary folder beside the packs and renames it in; nothing is left on failure. */
export function installPack(file: string, packsDir: string, content: string, shell: string): Manifest {
  const head = readPack(file)
  const why = packBlocker(head, content, shell)
  if (why) throw new Error(why)
  mkdirSync(packsDir, { recursive: true })
  const tmp = join(packsDir, `.tmp-${randomBytes(6).toString('hex')}`)
  try {
    const m = readPack(file, (f, data) => {
      const to = join(tmp, f.path)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, data)
    })
    writeFileSync(join(tmp, MANIFEST), JSON.stringify(m))
    const final = join(packsDir, `${m.id}@${m.version}`)
    rmSync(final, { recursive: true, force: true })
    renameSync(tmp, final)
    return m
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/**
 * Finds `path` (pet/..., as asked) in the layers, top first, then in `bundledRoot`. `cased` maps a path to a root's
 * on-disk casing (petsoc). A layer that deleted the path hides it from everything below. Null when nothing has it.
 */
export function lookup(layers: Layer[], bundledRoot: string, path: string, cased: (root: string, path: string) => string = (_r, p) => p): string | null {
  for (const l of layers) {
    const p = cased(l.dir, '/' + path).replace(/^\//, '')
    const file = join(l.dir, p)
    if (existsSync(file) && lstatSync(file).isFile()) return file
    if (l.manifest.deletes?.some((d) => d.toLowerCase() === path.toLowerCase())) return null
  }
  return join(bundledRoot, cased(bundledRoot, '/' + path).replace(/^\//, ''))
}
