import type { Good } from './data/goods'

/**
 * The good that wastes least of its effect on `stat` with `deficit` points missing: the biggest one that still
 * fits, otherwise the one that overflows least. Goods that do nothing for the stat are never picked.
 */
export function pickCare<G extends Pick<Good, 'hunger' | 'clean' | 'mood'>>(goods: G[], stat: 'hunger' | 'clean' | 'mood', deficit: number): G | undefined {
  let fit: G | undefined
  let over: G | undefined
  for (const g of goods) {
    const v = g[stat] ?? 0
    if (v <= 0) continue
    if (v <= deficit) {
      if (!fit || v > (fit[stat] ?? 0)) fit = g
    } else if (!over || v < (over[stat] ?? 0)) over = g
  }
  return fit ?? over
}
