export interface RufflePanic {
  url: string | null
  title: string
  body: string
  details: string
}

// Structural interfaces keep this reader usable by both DOM hosts and the
// non-DOM shared-code typecheck without adding browser globals to Node code.
interface PanicPlayer {
  readonly dataset: Readonly<Record<string, string | undefined>>
  readonly shadowRoot: { querySelector(selector: string): { readonly value?: string; readonly textContent?: string | null } | null } | null
}

/** Pinned Ruffle 0.6 renders these details before destroying its Rust instance. */
export function readPlayerPanic(player: PanicPlayer): RufflePanic | null {
  const root = player.shadowRoot
  const details = root?.querySelector('#panic-details-content textarea')?.value
  if (!details?.trim()) return null
  return {
    url: player.dataset.swf ?? null,
    title: (root?.querySelector('#panic-title')?.textContent ?? '').slice(0, 512),
    body: (root?.querySelector('#panic-body')?.textContent ?? '').slice(0, 2048),
    details: details.slice(0, 32768),
  }
}

/** Read this document's existing panic screen, including its hidden details. */
export function readRufflePanic(document: { querySelectorAll(selector: string): ArrayLike<unknown> }): RufflePanic | null {
  for (const player of Array.from(document.querySelectorAll('ruffle-player')) as PanicPlayer[]) {
    const panic = readPlayerPanic(player)
    if (panic) return panic
  }
  return null
}

/** Asset, configuration and cancellation errors do not poison the runtime. */
export function isFatalRufflePanic(panic: RufflePanic): boolean {
  if (!panic.details.trim()) return false
  // Ruffle's errors.tsx subclasses retain Error.name, so inspect its first
  // Error Info message rather than localized UI text or incidental stack text.
  // https://github.com/ruffle-rs/ruffle/blob/cac5c99ce4a17e606f4ee3090389bb878f852055/web/packages/core/src/internal/errors.tsx
  const name = /^Error name: (.*)$/m.exec(panic.details)?.[1]?.trim()
  const message = /^Error message: (.*)$/m.exec(panic.details)?.[1]?.trim() ?? ''
  if (name === 'AbortError' || /^(?:Failed to begin SWF load: )?(?:Error: )?AbortError\b/.test(message)) return false
  return !/^(?:Failed to fetch\b|Not a valid swf:|Invalid options:)/.test(message)
}
