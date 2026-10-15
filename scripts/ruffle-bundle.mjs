import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestName = 'qqpet-runtime.json'
const digest = /^[a-f0-9]{64}$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

// npm's 0.6.0 gitHead; the source archive and toolchain are pinned by the
// same Linux recipe which produces the optional complete selfhosted bundle.
export const RUFFLE_RUNTIME_RECIPE = Object.freeze({
  schemaVersion: 1,
  ruffleVersion: '0.6.0',
  source: Object.freeze({ commit: 'cac5c99ce4a17e606f4ee3090389bb878f852055', archiveSha256: '0eeb2575b3eca698939364b0cbb38505cc7fa773ac07fb33985089e92c97c5cc' }),
  patch: Object.freeze({ path: 'scripts/patches/ruffle-audio-lifetime.patch', sha256: '2f37aca77342e75ffaf3278fa69b92f18425c7dc8ef689155dfa8f462ce959bc' }),
  toolchain: Object.freeze({ rust: '1.98.0', wasmBindgen: '0.2.127', binaryen: '129', node: '24.22.0' }),
})

// Every file in the published npm tarball, after checking its SHA512 against
// package-lock.json's integrity. Names alone do not establish JS/Wasm pairing.
const npmFiles = {
  LICENSE_APACHE: '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
  LICENSE_MIT: '4de9338a7879c68e911742a7d691f0797ff1ef8d8a6fb978b0c711e258fe959c',
  'core.ruffle.c80159b526e567babaf5.js': '624b0b23bc4460d73e789e608fd1274546a5a411f71f7e873414aca94bc5bc4f',
  'core.ruffle.f000070ea72f8ae4fe3a.js': '08ce4ff032b61d2014ba52bdc6f5d8f6adb0aacdc1e6e3fd5e68281c958bd90d',
  'ruffle.js': 'a686a305345b06542dddedada71869104916a61e393f174687571528ac4225f5',
  'package.json': 'acd3bbc02b675d971d5b0218572cdb57727079f8b4bd1a7e5eb9ec433e53aa49',
  'core.ruffle.c80159b526e567babaf5.js.map': '61a9d62a7cb726c18ddf19528da37ef6952e508e37ae859b9a4bcc02ffd1dea6',
  'core.ruffle.f000070ea72f8ae4fe3a.js.map': '92d87318e15784a740448b32edb7fbca6c2824c8b8eecaf927283a01f811a699',
  'ruffle.js.map': '031fe55d7f17dde1f9628110c6c78d2ad487e2dec1d3fdb42ec0a5d74cdf3d86',
  'README.md': 'cdbeefd04e27a2fe80f735210fa4c054e376802eb43a16d9b6eeae78500f2bde',
  '72a20ef1c0b8ceb37720.wasm': 'adabc1696a2f1f95715ede6be0ac00a73364895c8e599039e60fef3b2f52efa4',
  '826bb0938097485a2c9d.wasm': 'e4ba64aa1dc9f7f2368602dd0fc2c51046f3e35baba8116d6cf3ae930a63aa02',
}

export function resolveRuffleBundle(env = process.env) {
  return resolve(env.QQPET_RUFFLE_BUNDLE || 'node_modules/@ruffle-rs/ruffle')
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function sameFields(actual, expected, label) {
  if (!record(actual) || Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value))
    throw new Error(`Ruffle ${label} does not match the pinned recipe.`)
}
function safePath(name) {
  return typeof name === 'string' && name.length > 0 && !/[\\\0:]/.test(name) &&
    name.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
async function filesIn(directory, prefix = '') {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Ruffle bundle must be a real directory, without symlinks.')
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (!safePath(name)) throw new Error('Unsafe Ruffle bundle path.')
    if (entry.isDirectory()) files.push(...await filesIn(resolve(directory, entry.name), name + '/'))
    else if (entry.isFile()) files.push(name)
    else throw new Error('Ruffle bundle contains a symlink or a non-regular file.')
  }
  return files.sort()
}
async function fileHash(path) {
  const value = createHash('sha256')
  for await (const chunk of createReadStream(path)) value.update(chunk)
  return value.digest('hex')
}
async function verifyFiles(directory, expected) {
  const names = Object.keys(expected).sort()
  if (names.some(name => !safePath(name) || !digest.test(expected[name]))) throw new Error('Invalid Ruffle file hash or path.')
  const actual = await filesIn(directory)
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error('Ruffle file set differs from its complete bundle; missing or mixed chunks.')
  for (const name of names) {
    if (await fileHash(resolve(directory, name)) !== expected[name]) throw new Error(`Ruffle file checksum mismatch: ${name}`)
  }
}

/** CI consumes the artifact produced by the pinned source recipe in the same run. */
export async function loadRuffleBundle(directory = resolveRuffleBundle()) {
  directory = resolve(directory)
  let manifest
  try { manifest = JSON.parse(await fs.readFile(resolve(directory, manifestName), 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT' || directory !== resolve('node_modules/@ruffle-rs/ruffle')) throw error
  }
  if (!manifest) {
    await verifyFiles(directory, npmFiles)
    return { directory, version: '0.6.0', fallbackWasm: '72a20ef1c0b8ceb37720.wasm', files: { ...npmFiles }, loaderHash: npmFiles['ruffle.js'], fallbackHash: npmFiles['72a20ef1c0b8ceb37720.wasm'] }
  }
  if (!record(manifest) || manifest.schemaVersion !== RUFFLE_RUNTIME_RECIPE.schemaVersion || manifest.ruffleVersion !== RUFFLE_RUNTIME_RECIPE.ruffleVersion)
    throw new Error('Ruffle manifest requires the pinned 0.6.0 schema.')
  for (const field of ['source', 'patch', 'toolchain']) sameFields(manifest[field], RUFFLE_RUNTIME_RECIPE[field], field)
  if (await fileHash(resolve(root, RUFFLE_RUNTIME_RECIPE.patch.path)) !== manifest.patch.sha256)
    throw new Error('Ruffle patch checksum differs from the repository patch.')
  if (!safePath(manifest.fallbackWasm) || manifest.fallbackWasm.includes('/') || !manifest.fallbackWasm.endsWith('.wasm'))
    throw new Error('Ruffle fallbackWasm must name a bundle-root Wasm file.')
  if (!record(manifest.files) || !Object.hasOwn(manifest.files, 'ruffle.js') || !Object.hasOwn(manifest.files, manifest.fallbackWasm) || Object.hasOwn(manifest.files, manifestName))
    throw new Error('Ruffle manifest must cover its loader and fallback, excluding itself.')
  const files = { ...manifest.files, [manifestName]: await fileHash(resolve(directory, manifestName)) }
  await verifyFiles(directory, files)
  return { directory, version: manifest.ruffleVersion, fallbackWasm: manifest.fallbackWasm, files, loaderHash: manifest.files['ruffle.js'], fallbackHash: manifest.files[manifest.fallbackWasm] }
}

/** Check the actual copied directory before either loader or Wasm is transformed. */
export async function verifyCopiedRuffleBundle(bundle, destination) {
  await verifyFiles(resolve(destination), bundle.files)
}

export const RUFFLE_LOWERING_RECIPE = Object.freeze({ recipe: 'signext-lowering-v1', binaryen: '123.0.0' })
export function ruffleCacheKey(source) {
  if (!digest.test(source)) throw new Error('Invalid Ruffle cache source hash.')
  return `${source}-${RUFFLE_LOWERING_RECIPE.binaryen}-${RUFFLE_LOWERING_RECIPE.recipe}`
}
export function ruffleCacheRecord(source, bytes) {
  return { source, ...RUFFLE_LOWERING_RECIPE, features: ['mutable-globals'], output: hash(bytes) }
}
export function validRuffleCache(record, source, bytes) {
  return record?.source === source && record.recipe === RUFFLE_LOWERING_RECIPE.recipe && record.binaryen === RUFFLE_LOWERING_RECIPE.binaryen &&
    JSON.stringify(record.features) === '["mutable-globals"]' && record.output === hash(bytes)
}
