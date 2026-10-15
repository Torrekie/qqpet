import { save } from '../pet/store'
import { SwfPlayer } from './player'

/** Ruffle's :host { all: initial } and SWF cursor commands both beat document CSS. */
function pinCursor(el: HTMLElement): void {
  el.style.setProperty('cursor', 'inherit', 'important')
  const sr = el.shadowRoot
  if (!sr || sr.getElementById('qqpet-cursor')) return
  const s = el.ownerDocument.createElement('style')
  s.id = 'qqpet-cursor'
  s.textContent = ':host, canvas { cursor: inherit !important }'
  sr.append(s)
}

/**
 * Pet action player. Ruffle tears down its instance on every load(), which
 * blanks the pet for a few frames, so the next action loads in a hidden back
 * player and is swapped in once it has painted. Retire the previous instance
 * after the swap; an empty back element needs no renderer, font or audio state.
 */
export class PetSwf {
  front: SwfPlayer
  private back: SwfPlayer
  private readonly parent: HTMLElement

  constructor(parent: HTMLElement) {
    this.parent = parent
    this.front = new SwfPlayer(parent, { recoverContext: true })
    this.back = this.createBack()
    pinCursor(this.front.el)
  }

  private createBack(): SwfPlayer {
    const back = new SwfPlayer(this.parent, { recoverContext: true })
    // Keep the upcoming canvas paintable on older WebKit, without accepting its input.
    back.el.style.opacity = '0'
    back.el.style.pointerEvents = 'none'
    back.setMuted(!save.settings.sound)
    pinCursor(back.el)
    return back
  }

  /** Both stacked players, so a toggle also cuts off a laugh that is already playing. */
  applySound(): void {
    const muted = !save.settings.sound
    this.front.setMuted(muted)
    this.back.setMuted(muted)
  }

  async load(url: string, accept: () => boolean = () => true): Promise<boolean> {
    this.applySound()
    const next = this.back
    try {
      await next.load(url)
      pinCursor(next.el)
      await next.nextPaint()
      // A drag can end while its movie is loading. Keep the current front
      // visible until the latest requested pose is ready instead of showing the outdated one.
      if (!accept()) {
        next.destroy()
        if (this.back === next && this.parent.isConnected) this.back = this.createBack()
        return false
      }
    } catch (error) {
      next.destroy()
      // Leave the last good front visible. Machine's existing recovery retries in a fresh element.
      if (this.back === next && this.parent.isConnected) this.back = this.createBack()
      throw error
    }
    next.el.style.opacity = '1'
    next.el.style.pointerEvents = 'auto'
    const previous = this.front
    this.front = next
    previous.destroy()
    this.back = this.createBack()
    return true
  }
}
