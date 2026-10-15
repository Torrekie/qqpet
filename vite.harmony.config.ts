import { resolve } from 'node:path'
import { defineConfig, normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { ruffleSafari14 } from './scripts/ruffle-vite'
import { resolveRuffleBundle } from './scripts/ruffle-bundle.mjs'
import { appVersion } from './scripts/app-version'

// Same pages as Android: window.qqpet comes from src/harmony/bridge.ts.
// resources/pet is packed into the HAP as rawfile by scripts/pack-harmony.mjs.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  publicDir: false,
  build: {
    target: 'safari14',
    cssTarget: 'safari14',
    outDir: resolve('out/harmony'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve('src/renderer/index.html'), game: resolve('src/renderer/game.html'), swf: resolve('src/renderer/swf.html') } },
  },
  plugins: [
    appVersion(),
    ruffleSafari14(),
    {
      name: 'harmony-bridge',
      transformIndexHtml: {
        order: 'pre',
        handler: (html, ctx) =>
          ctx.filename.endsWith('index.html') ? html.replace('<script type="module" src="./bootstrap.ts">', '<script type="module" src="../harmony/bridge.ts"></script>\n    $&') : html,
      },
    },
    viteStaticCopy({
      targets: [{ src: normalizePath(resolveRuffleBundle()) + '/*', dest: 'ruffle', rename: { stripBase: true } }],
    }),
  ],
})
