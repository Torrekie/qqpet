export interface RufflePanic {
  url: string | null
  title: string
  body: string
  details: string
}

/** Read only this document's existing panic screen, including its hidden details. */
export function readRufflePanic(document: Pick<Document, 'querySelectorAll'>): RufflePanic | null {
  for (const player of Array.from(document.querySelectorAll<HTMLElement>('ruffle-player'))) {
    const root = player.shadowRoot
    const details = root?.querySelector<HTMLTextAreaElement>('#panic-details-content textarea')?.value
    if (!details?.trim()) continue
    return {
      url: player.dataset.swf ?? null,
      title: (root?.querySelector('#panic-title')?.textContent ?? '').slice(0, 512),
      body: (root?.querySelector('#panic-body')?.textContent ?? '').slice(0, 2048),
      details: details.slice(0, 32768),
    }
  }
  return null
}
