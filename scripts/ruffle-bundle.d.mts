export interface RuffleBundle {
  directory: string
  version: string
  fallbackWasm: string
  files: Record<string, string>
  loaderHash: string
  fallbackHash: string
}
export function resolveRuffleBundle(env?: Record<string, string | undefined>): string
export function loadRuffleBundle(directory?: string): Promise<RuffleBundle>
export function verifyCopiedRuffleBundle(bundle: RuffleBundle, destination: string): Promise<void>
