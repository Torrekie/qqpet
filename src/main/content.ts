import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import type { Fetch, PackOffer } from '../shared/ipc'
import { APP_VERSION } from '../shared/version'
import { compareVersion, contentVersion, installPack, installedLayers, lookup, packBlocker, sha256, type PackIndex, type PackIndexEntry } from './content-pack'
import { petsocPath } from './nocase'

// resources/{pet,icons} live next to the app in production (extraResources).
export const resourcesRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
const packsDir = join(app.getPath('userData'), 'packs')
/** The bundled content is the shell's own release. */
const shell = APP_VERSION.replace(/^v/, '')

// Read once: installing a pack relaunches the app, so the layers never change under a running page.
const layers = installedLayers(packsDir, shell, shell)
export const installedContent = (): string => contentVersion(layers, shell)

/** The file for a resources-relative path (pet/...), from the newest installed pack that has it, else the bundle. */
export function resourceFile(path: string): string | null {
  return lookup(layers, resourcesRoot, path, petsocPath)
}

function install(file: string): string {
  const m = installPack(file, packsDir, installedContent(), shell)
  return m.version
}

/** Picks a .qqpetpack and installs it; resolves with the new content version, or null when cancelled. */
export async function importPack(win: BrowserWindow): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'QQ宠物内容包', extensions: ['qqpetpack'] }] })
  if (r.canceled || !r.filePaths[0]) return null
  return install(r.filePaths[0])
}

/** Back to the content shipped with the program. */
export function resetPacks(): void {
  rmSync(packsDir, { recursive: true, force: true })
}

const INDEX = 'https://github.com/AnkioTomas/qqpet/releases/latest/download/packs.json'

let offered: PackIndexEntry | null = null

/** The incremental pack of the latest release that applies right on the installed content, if any. */
export async function findPack(fetch: Fetch, url = INDEX): Promise<PackOffer | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${r.status}`)
  const index = (await r.json()) as PackIndex
  const content = installedContent()
  const fit = (index.packs ?? [])
    .filter((p) => p.base !== undefined && !packBlocker(p, content, shell))
    .sort((a, b) => compareVersion(b.version, a.version))[0]
  offered = fit ?? null
  return fit ? { version: fit.version, base: fit.base!, size: fit.size } : null
}

/** Downloads the pack findPack offered (never a URL from the page), checks its sha256 against packs.json, then installs it like an import. */
export async function downloadPack(fetch: Fetch): Promise<string> {
  const offer = offered
  if (!offer) throw new Error('没有可用的内容更新')
  const r = await fetch(offer.url)
  if (!r.ok) throw new Error(`下载失败：${r.status}`)
  const data = Buffer.from(await r.arrayBuffer())
  if (data.length !== offer.size || sha256(data) !== offer.sha256) throw new Error('下载的内容包校验失败')
  const file = join(tmpdir(), `qqpet-${process.pid}-${offer.version}.qqpetpack`)
  writeFileSync(file, data)
  try {
    return install(file)
  } finally {
    rmSync(file, { force: true })
  }
}
