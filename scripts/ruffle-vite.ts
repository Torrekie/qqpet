import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { loadRuffleBundle, resolveRuffleBundle } from './ruffle-bundle.mjs'

/** Runs after static copying, in a serial child so Binaryen's Wasm heap is released. */
export function ruffleSafari14(): Plugin {
  let output = ''
  const source = resolveRuffleBundle()
  return {
    name: 'ruffle-safari14', apply: 'build',
    configResolved(config) { output = resolve(config.root, config.build.outDir, 'ruffle') },
    async buildStart() { await loadRuffleBundle(source) },
    async closeBundle() {
      await new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, ['--max-old-space-size=512', resolve('scripts/lower-ruffle.mjs'), output, source], { stdio: 'inherit' })
        child.on('error', fail)
        child.on('exit', code => code === 0 ? done() : fail(new Error(`Ruffle compatibility build failed (${code}).`)))
      })
    },
  }
}
