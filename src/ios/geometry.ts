import { cover, resetCoverage, type Box } from '../mobile/overlay'
import type { IOSRPC } from './rpc'

export interface Rect { x: number; y: number; width: number; height: number }
export interface PetPointer { phase: 'begin' | 'move' | 'end' | 'cancel'; id: number; x: number; y: number; time?: number }
interface GeometryTiming { framesPerSecond: number; lastFrameAgoMs: number | null; maxFrameGapMs: number }

const rect = (box: Box): Rect => ({ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top })
const visible = (element: Element): boolean => {
  const box = element.getBoundingClientRect()
  if (!box.width || !box.height) return false
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  }
  return true
}

/** Full page CSS coordinates remain fixed while the native surface is cropped. */
export function startGeometry(rpc: IOSRPC): { pointer(input: PetPointer): void; pause(paused: boolean): void; stop(): void; bounds(): Rect; timing(): GeometryTiming } {
  const presses = new Map<number, { x: number; y: number }>()
  let dragging = false
  let stopped = false
  let paused = Boolean(window.__qqpetHostPaused)
  let frame = 0
  let previous = ''
  let bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  let lastFrame: number | null = null
  let sampleStart = performance.now()
  let sampleFrames = 0
  let framesPerSecond = 0
  let maxFrameGapMs = 0

  const pointer = (input: PetPointer): void => {
    if (input.phase === 'cancel' && input.id === -1) { presses.clear(); dragging = false }
    else if (input.phase === 'begin') presses.set(input.id, { x: input.x, y: input.y })
    else if (input.phase === 'move') {
      const press = presses.get(input.id)
      if (press && Math.hypot(input.x - press.x, input.y - press.y) > 6) dragging = true
    } else {
      presses.delete(input.id)
      if (!presses.size) dragging = false
    }
  }
  const phases = { pointerdown: 'begin', pointermove: 'move', pointerup: 'end', pointercancel: 'cancel' } as const
  const fromDOM = (event: PointerEvent): void => pointer({ phase: phases[event.type as keyof typeof phases], id: event.pointerId, x: event.clientX, y: event.clientY })
  for (const type of Object.keys(phases)) document.addEventListener(type, fromDOM as EventListener, true)

  const track = (): void => {
    if (stopped) return
    frame = requestAnimationFrame(track)
    if (paused) return
    const now = performance.now()
    if (lastFrame !== null) maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame)
    lastFrame = now
    sampleFrames++
    if (now - sampleStart >= 1000) {
      framesPerSecond = Math.round(sampleFrames * 10000 / (now - sampleStart)) / 10
      sampleStart = now
      sampleFrames = 0
    }
    let left = innerWidth, top = innerHeight, right = 0, bottom = 0
    for (const element of document.body.querySelectorAll('*')) {
      let box: Box | null
      try { box = cover(element) } catch {
        // An unreadable WebGL buffer keeps a conservative rectangle, never disables the host.
        box = visible(element) ? element.getBoundingClientRect() : null
      }
      if (!box) continue
      left = Math.min(left, box.left); top = Math.min(top, box.top)
      right = Math.max(right, box.right); bottom = Math.max(bottom, box.bottom)
    }
    const x = Math.max(Math.floor(left), 0), y = Math.max(Math.floor(top), 0)
    bounds = dragging ? { x: 0, y: 0, width: innerWidth, height: innerHeight } : {
      x, y,
      width: Math.max(Math.min(Math.ceil(right), innerWidth) - x, 0),
      height: Math.max(Math.min(Math.ceil(bottom), innerHeight) - y, 0),
    }
    const pet = document.getElementById('pet')
    const dragRegions = pet && visible(pet) ? [rect(pet.getBoundingClientRect())] : []
    const interactiveRegions: Rect[] = []
    // A hit root may be a zero-sized anchor with visible, overflowing children
    // (the pet toolbar). Those controls must also bypass the native drag plane.
    for (const element of document.body.querySelectorAll('[data-hit], [data-hit] *, .point, input, textarea, select, button, iframe, ruffle-player')) {
      if (element.closest('#pet') && !element.matches('.point')) continue
      if (!visible(element) || getComputedStyle(element).pointerEvents === 'none') continue
      interactiveRegions.push(rect(element.getBoundingClientRect()))
    }
    const payload = { bounds, dragRegions, interactiveRegions, viewport: { width: innerWidth, height: innerHeight }, dragging }
    const signature = JSON.stringify(payload)
    if (signature !== previous) {
      rpc.notify('setGeometry', payload)
      previous = signature
    }
  }
  frame = requestAnimationFrame(track)
  return {
    pointer,
    bounds: () => bounds,
    timing: () => ({ framesPerSecond, lastFrameAgoMs: lastFrame === null ? null : Math.round(performance.now() - lastFrame), maxFrameGapMs: Math.round(maxFrameGapMs) }),
    pause(value) {
      if (paused !== value) {
        resetCoverage()
        lastFrame = null
        sampleStart = performance.now()
        sampleFrames = 0
        framesPerSecond = 0
        maxFrameGapMs = 0
      }
      paused = value
      if (paused) pointer({ phase: 'cancel', id: -1, x: 0, y: 0 })
    },
    stop() {
      stopped = true
      cancelAnimationFrame(frame)
      for (const type of Object.keys(phases)) document.removeEventListener(type, fromDOM as EventListener, true)
    },
  }
}
