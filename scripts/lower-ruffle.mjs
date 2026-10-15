import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { patchRuffleAudio } from './patch-ruffle-audio.mjs'
import { RUFFLE_LOWERING_RECIPE, loadRuffleBundle, resolveRuffleBundle, ruffleCacheKey, ruffleCacheRecord, validRuffleCache, verifyCopiedRuffleBundle } from './ruffle-bundle.mjs'

// Ruffle 0.6's fallback is labeled MVP, but has sign-extension instructions.
// Safari 14.0 (iOS 14.0–14.4 / macOS 11.0) needs their equivalent shift form.
const destination = process.argv[2]
if (!destination) throw new Error('Specify the copied Ruffle directory.')
const bundle = await loadRuffleBundle(process.argv[3] || resolveRuffleBundle())
await verifyCopiedRuffleBundle(bundle, destination)
const name = bundle.fallbackWasm
const loader = patchRuffleAudio(await fs.readFile(resolve(bundle.directory, 'ruffle.js')), bundle.version, bundle.loaderHash)
const source = await fs.readFile(resolve(bundle.directory, name))
const directory = resolve('out/ruffle-safari14', ruffleCacheKey(bundle.fallbackHash))
await fs.mkdir(directory, { recursive: true })
const cached = resolve(directory, name)
const manifest = resolve(directory, 'manifest.json')
let lowered
try {
  const record = JSON.parse(await fs.readFile(manifest, 'utf8'))
  const bytes = await fs.readFile(cached)
  if (validRuffleCache(record, bundle.fallbackHash, bytes)) lowered = bytes
} catch { /* First build or an incomplete cache is regenerated. */ }
if (!lowered) {
  const metadata = JSON.parse(await fs.readFile(resolve('node_modules/binaryen/package.json'), 'utf8'))
  if (metadata.version !== RUFFLE_LOWERING_RECIPE.binaryen) throw new Error('Ruffle lowering requires the pinned Binaryen version.')
  const { default: binaryen } = await import('binaryen')
  const module = binaryen.readBinary(source)
  try {
    module.setFeatures(binaryen.Features.MutableGlobals | binaryen.Features.SignExt)
    if (!module.validate()) throw new Error('Ruffle input failed Wasm validation.')
    module.runPasses(['signext-lowering'])
    module.setFeatures(binaryen.Features.MutableGlobals)
    // Validation with SignExt disabled checks instructions, not just metadata.
    if (!module.validate()) throw new Error('Ruffle output exceeds the Safari 14.0 Wasm baseline.')
    lowered = module.emitBinary()
  } finally { module.dispose() }
  await fs.writeFile(cached, lowered)
  await fs.writeFile(manifest, JSON.stringify(ruffleCacheRecord(bundle.fallbackHash, lowered), null, 2) + '\n')
}
await fs.copyFile(cached, resolve(destination, name))
await fs.writeFile(resolve(destination, 'ruffle.js'), loader)
console.log('Ruffle fallback validated for Safari 14.0.')
