import { renameSync, writeFileSync } from 'node:fs'

/** Windows lets antivirus, indexing and sync tools hold a file briefly; renaming over it then fails. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRIES = 5
const RETRY_MS = 20

const pause = (ms: number): void => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) as unknown as void

/** Writes `text` to a temporary file and renames it over `file`, retrying while another process holds the file. */
export function atomicWrite(file: string, text: string, fs = { writeFileSync, renameSync }, sleep = pause): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '') || attempt >= RETRIES) throw e
      sleep(RETRY_MS * (attempt + 1))
    }
  }
}
