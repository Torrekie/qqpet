export interface RuffleRuntimeManifest {
  schemaVersion: number
  ruffleVersion: string
  source: { commit: string; archiveSha256: string }
  patch: { path: string; sha256: string }
  toolchain: { rust: string; wasmBindgen: string; binaryen: string; node: string }
  fallbackWasm: string
  files: Record<string, string>
}
export interface RuffleBundle {
  directory: string
  version: string
  fallbackWasm: string
  files: Record<string, string>
  loaderHash: string
  fallbackHash: string
  manifest?: RuffleRuntimeManifest
}
export function resolveRuffleBundle(env?: Record<string, string | undefined>): string
export function loadRuffleBundle(directory?: string): Promise<RuffleBundle>
export function verifyCopiedRuffleBundle(bundle: RuffleBundle, destination: string): Promise<void>
export function recordPatchedRuffleOutput(bundle: RuffleBundle, destination: string): Promise<void>
export function verifyPatchedRuffleOutput(directory: string): Promise<void>
