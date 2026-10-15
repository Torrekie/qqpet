/**
 * Turns the twice-a-second full-screen samples into hide/show decisions.
 * Hiding or showing a topmost window over a full-screen app makes Windows re-check that app (the taskbar flashes
 * and the state reads "not full screen" for a moment), so showing again at once starts an endless hide/show loop.
 * A full-screen sample hides at once; showing waits for `calm` samples in a row that are not full screen.
 * An unknown sample ('-1': the taskbar or no window in front) keeps the current state.
 */
export function fullscreenGate(apply: (full: boolean) => void, calm = 4): (line: string) => void {
  let full = false
  let clear = 0
  return (line) => {
    if (line === '1') {
      clear = 0
      if (!full) apply((full = true))
    } else if (line === '0' && full && ++clear >= calm) {
      clear = 0
      apply((full = false))
    }
  }
}
