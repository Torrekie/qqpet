import { net, protocol } from 'electron'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hidpiSvg } from './hidpi'
import { resourceFile } from './content'

// The renderer and every SWF are served from app://bundle/. Ruffle loads SWFs,
// XML configs and wasm through fetch(), which file:// does not support.
export const APP_ORIGIN = 'app://bundle'

const rendererRoot = join(import.meta.dirname, '../renderer')

export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

export function handleScheme(): void {
  protocol.handle('app', (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname)
    // Pet content comes from the newest installed content pack that has the file, else the bundle (#28).
    let file: string | null
    if (path.startsWith('/pet/')) {
      const rel = normalize(path.slice(1)).replace(/\\/g, '/')
      if (!rel.startsWith('pet/') || isAbsolute(rel)) return new Response(null, { status: 403 })
      file = resourceFile(rel)
    } else {
      file = normalize(join(rendererRoot, path))
      if (!file.startsWith(rendererRoot + sep)) return new Response(null, { status: 403 })
    }
    if (!file) return new Response(null, { status: 404 })
    // X-HD: the hd setting is on. Only <img>/CSS image loads accept SVG; Ruffle's fetch() must get the original bytes.
    const svg = req.headers.has('x-hd') && req.headers.get('accept')?.includes('image/svg+xml') && hidpiSvg(file)
    if (svg) return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
    return net.fetch(pathToFileURL(file).toString())
  })
}
