import { createHash } from 'node:crypto'

// Published @ruffle-rs/ruffle 0.6.0 ruffle.js, verified against package-lock integrity.
// Only its system-audio unmute workaround is guarded; WebAudio remains unchanged.
const version = '0.6.0'
const expected = 'a686a305345b06542dddedada71869104916a61e393f174687571528ac4225f5'
const method = 'unmuteAudioContext(){'
const guard = 'if(window.__qqpetRespectSystemAudio===true)return;'

export function guardRuffleSystemAudio(source) {
  if (source.split(method).length !== 2) throw new Error('Ruffle unmuteAudioContext must match exactly once.')
  return source.replace(method, method + guard)
}

export function patchRuffleAudio(source, packageVersion, expectedHash = expected) {
  if (packageVersion !== version) throw new Error('Ruffle audio policy requires the pinned 0.6.0 package.')
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || createHash('sha256').update(source).digest('hex') !== expectedHash)
    throw new Error('Ruffle loader changed. Audit its audio workaround before updating the pinned compatibility recipe.')
  return guardRuffleSystemAudio(source.toString())
}
