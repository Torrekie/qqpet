import { resolve } from 'node:path'
import { defineConfig, normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { ruffleSafari14 } from './scripts/ruffle-vite'
import { resolveRuffleBundle } from './scripts/ruffle-bundle.mjs'
import { appVersion } from './scripts/app-version'

/** The complete renderer, with WK RPC in place of Electron's preload. Native packaging adds resources/pet. */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  publicDir: false,
  build: {
    target: 'safari14',
    outDir: resolve('out/ios'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve('src/renderer/index.html'), game: resolve('src/renderer/game.html'), swf: resolve('src/renderer/swf.html') } },
  },
  plugins: [
    appVersion(),
    ruffleSafari14(),
    {
      name: 'ios-bridge',
      transformIndexHtml: {
        order: 'pre',
        handler(html, context) {
          if (!context.filename.endsWith('index.html') && !context.filename.endsWith('game.html')) return html
          const entry = /<script type="module" src="\.\/(?:bootstrap|main|game)\.ts">/
          if (!entry.test(html)) throw new Error('The iOS page entry was not found; cannot install its native bridge.')
          const withBridge = html.replace(entry, '<script type="module" src="../ios/bridge.ts"></script>\n    $&')
          return withBridge.replace('<head>', '<head>\n    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">')
        },
      },
    },
    viteStaticCopy({
      targets: [{ src: normalizePath(resolveRuffleBundle()) + '/*', dest: 'ruffle', rename: { stripBase: true } }],
    }),
  ],
})
