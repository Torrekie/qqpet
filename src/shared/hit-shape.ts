export interface ShapeRect { x: number; y: number; width: number; height: number }

/**
 * Page rectangles (CSS px) to the window's input shape (DIP): scaled by the page zoom, snapped outward to whole
 * pixels, clipped to the window and stripped of empty ones. No rectangle at all must still keep the window
 * click-through, and an empty list makes Electron drop the shape, so one zero-sized rectangle stands for none.
 */
export function toShape(rects: readonly ShapeRect[], zoom: number, width: number, height: number): ShapeRect[] {
  const out: ShapeRect[] = []
  for (const r of rects) {
    const x = Math.max(Math.floor(r.x * zoom), 0)
    const y = Math.max(Math.floor(r.y * zoom), 0)
    const right = Math.min(Math.ceil((r.x + r.width) * zoom), width)
    const bottom = Math.min(Math.ceil((r.y + r.height) * zoom), height)
    if (right > x && bottom > y) out.push({ x, y, width: right - x, height: bottom - y })
  }
  return out.length ? out : [{ x: 0, y: 0, width: 0, height: 0 }]
}
