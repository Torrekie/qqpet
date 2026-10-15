import { join, normalize, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { ruffleSafari14 } from './scripts/ruffle-vite'
import { resolveRuffleBundle } from './scripts/ruffle-bundle.mjs'
import { appVersion } from './scripts/app-version'
import { hidpiSvg } from './src/main/hidpi'
import { petsocPath } from './src/main/nocase'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
    // content.ts compares packs against the shell's version (#28).
    plugins: [appVersion()],
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    // resources/ holds pet/ (235MB). Served as-is in dev, shipped via
    // extraResources in production, never copied into the renderer bundle.
    publicDir: resolve('resources'),
    build: {
      target: 'safari14',
      cssTarget: 'safari14',
      copyPublicDir: false,
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), game: resolve('src/renderer/game.html'), swf: resolve('src/renderer/swf.html') } },
    },
    plugins: [
      appVersion(),
      ruffleSafari14(),
      // Dev counterpart of the @2x handling in src/main/protocol.ts.
      {
        name: 'hidpi',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const [raw, query] = (req.url ?? '').split('?')
            const asked = decodeURIComponent(raw)
            const url = petsocPath(resolve('resources'), asked)
            if (url !== asked) req.url = encodeURI(url) + (query == null ? '' : '?' + query)
            const svg =
              req.headers['x-hd'] && req.headers.accept?.includes('image/svg+xml') && url.startsWith('/pet/') && hidpiSvg(join(resolve('resources'), normalize(url)))
            if (!svg) return next()
            res.setHeader('Content-Type', 'image/svg+xml')
            res.end(svg)
          })
        },
      },
      viteStaticCopy({
        // Globs need forward slashes; resolve() yields backslashes on Windows.
        targets: [{ src: normalizePath(resolveRuffleBundle()) + '/*', dest: 'ruffle', rename: { stripBase: true } }],
      }),
    ],
  },
})
