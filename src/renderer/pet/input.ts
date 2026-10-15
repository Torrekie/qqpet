export interface PetPointerInput {
  phase: 'begin' | 'move' | 'end' | 'cancel'
  id: number
  /** Full page CSS coordinates, including a native crop offset. */
  x: number
  y: number
  /** Stable desktop coordinates for movement/velocity while the page origin changes. */
  globalX?: number
  globalY?: number
  /** Desktop display changes resize the pet; preserve the fractional grab point. */
  scaleGrab?: boolean
  /** Optional performance.now() milliseconds; omit if the native clock differs. */
  time?: number
  source?: 'dom' | 'native'
}

export interface PetInputActions {
  position(): { x: number; y: number; size: number }
  begin(): void
  /** align may run when the asynchronous lift animation is actually visible. */
  lift(size: number, align: (anchor: { dx: number; dy: number; duration?: number }) => void): { dx: number; dy: number } | null
  move(x: number, y: number, lifted: boolean): void
  end(lifted: boolean, vx: number, vy: number, cancelled: boolean): void
  hold(x: number, y: number): void
  active(on: boolean): void
  clock?(): number
  requestFrame?: typeof requestAnimationFrame
  cancelFrame?: typeof cancelAnimationFrame
}

/** Both DOM and native gestures use the same grab point, lift threshold and velocity accounting. */
export function createPetInput(actions: PetInputActions, holdMilliseconds = 0) {
  let press: { id: number; source: string; x: number; y: number; startX: number; startY: number; dx: number; dy: number; grabX: number; grabY: number; scaleGrab: boolean; px: number; py: number; at: number; vx: number; vy: number; lifted: boolean } | null = null
  let hold: ReturnType<typeof setTimeout> | null = null
  let anchorFrame = 0
  const clock = actions.clock ?? (() => performance.now())
  const requestFrame = actions.requestFrame ?? ((callback) => requestAnimationFrame(callback))
  const cancelFrame = actions.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const clearHold = (): void => { if (hold !== null) clearTimeout(hold); hold = null }
  const finish = (cancelled: boolean, now: number): void => {
    if (!press) return
    const over = press
    press = null
    if (anchorFrame) cancelFrame(anchorFrame)
    anchorFrame = 0
    clearHold()
    actions.active(false)
    const stale = cancelled || now - over.at > 80
    actions.end(over.lifted, stale ? 0 : over.vx, stale ? 0 : over.vy, cancelled)
  }
  return {
    get active(): boolean { return press !== null },
    cancel(): void { finish(true, clock()) },
    send(input: PetPointerInput): void {
      if (!['begin', 'move', 'end', 'cancel'].includes(input.phase) || ![input.id, input.x, input.y].every(Number.isFinite)) return
      const globalX = input.globalX ?? input.x
      const globalY = input.globalY ?? input.y
      if (![globalX, globalY].every(Number.isFinite)) return
      const now = input.time !== undefined && Number.isFinite(input.time) ? input.time : clock()
      const source = input.source ?? 'dom'
      if (input.phase === 'cancel' && input.id === -1) return finish(true, now)
      if (input.phase === 'begin') {
        if (press) return
        actions.begin()
        const box = actions.position()
        const dx = input.x - box.x, dy = input.y - box.y
        press = { id: input.id, source, x: input.x, y: input.y, startX: globalX, startY: globalY, dx, dy, grabX: dx / box.size, grabY: dy / box.size, scaleGrab: Boolean(input.scaleGrab), px: globalX, py: globalY, at: now, vx: 0, vy: 0, lifted: false }
        actions.active(true)
        if (holdMilliseconds > 0) hold = setTimeout(() => { if (press) actions.hold(press.x, press.y) }, holdMilliseconds)
        return
      }
      if (!press || input.id !== press.id || source !== press.source) return
      if (input.phase === 'cancel') return finish(true, now)
      const dt = (now - press.at) / 1000
      // A stationary final native sample must not erase a recent fling or refresh its age.
      if (dt > 0 && (globalX !== press.px || globalY !== press.py)) {
        press.vx = (globalX - press.px) / dt
        press.vy = (globalY - press.py) / dt
        press.at = now
      }
      press.px = globalX
      press.py = globalY
      press.x = input.x
      press.y = input.y
      const box = actions.position()
      if (!press.lifted && Math.hypot(globalX - press.startX, globalY - press.startY) > 8) {
        clearHold()
        press.lifted = true
        const gesture = press
        const align = (anchor: { dx: number; dy: number; duration?: number }): void => {
          // A late SWF load must never reposition a released pet or a new gesture.
          if (press !== gesture) return
          if (anchorFrame) cancelFrame(anchorFrame)
          const fromX = gesture.grabX, fromY = gesture.grabY
          const toX = anchor.dx / box.size, toY = anchor.dy / box.size
          const started = clock()
          const paint = (): void => {
            anchorFrame = 0
            if (press !== gesture) return
            const t = anchor.duration ? Math.min(1, Math.max(0, (clock() - started) / anchor.duration)) : 1
            const ease = 1 - (1 - t) ** 3
            gesture.grabX = fromX + (toX - fromX) * ease
            gesture.grabY = fromY + (toY - fromY) * ease
            gesture.dx = gesture.grabX * box.size
            gesture.dy = gesture.grabY * box.size
            const currentSize = actions.position().size
            actions.move(gesture.x - (gesture.scaleGrab ? gesture.grabX * currentSize : gesture.dx), gesture.y - (gesture.scaleGrab ? gesture.grabY * currentSize : gesture.dy), true)
            if (t < 1) anchorFrame = requestFrame(paint)
          }
          paint()
        }
        const anchor = actions.lift(box.size, align)
        if (anchor) align(anchor)
      }
      actions.move(input.x - (press.scaleGrab ? press.grabX * box.size : press.dx), input.y - (press.scaleGrab ? press.grabY * box.size : press.dy), press.lifted)
      if (input.phase === 'end') finish(false, now)
    },
  }
}
