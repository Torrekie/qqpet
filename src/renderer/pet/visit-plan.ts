/**
 * A friend's pet visits: the newer client's interact2/<friend>_<host> two-pet clips (300×200 stage), friend on the
 * left. A code is 1, then the stage (0 adult, 1 egg, 2 kid), then the sex (2 GG, 3 MM): checked against Ruffle renders
 * (113 is a pink egg with a bow, 122 a kid with the blue scarf and star, 102 an adult with the red scarf).
 */
export type Sex = 'GG' | 'MM'
export type Stage = 'Egg' | 'Kid' | 'Adult'
export const petCode = (sex: Sex, stage: Stage): string => `1${{ Adult: 0, Egg: 1, Kid: 2 }[stage]}${sex === 'GG' ? 2 : 3}`

/** Frame counts of enter/feed per pairing; tugofwar loops, so only its presence matters. */
export const SCENES: Record<string, { enter: number; feed?: number; tugofwar?: 1 }> = {
  '102_102': { enter: 84, feed: 222, tugofwar: 1 },
  '102_103': { enter: 84, feed: 221, tugofwar: 1 },
  '102_113': { enter: 85, feed: 203, tugofwar: 1 },
  '102_122': { enter: 88, feed: 214, tugofwar: 1 },
  '102_123': { enter: 88, feed: 217, tugofwar: 1 },
  '103_102': { enter: 86, feed: 220 },
  '103_103': { enter: 92, feed: 206, tugofwar: 1 },
  '103_113': { enter: 87, feed: 203, tugofwar: 1 },
  '103_122': { enter: 88, feed: 214, tugofwar: 1 },
  '103_123': { enter: 88, feed: 223, tugofwar: 1 },
  '112_103': { enter: 92, tugofwar: 1 },
  '112_113': { enter: 87, feed: 195, tugofwar: 1 },
  '112_122': { enter: 88, feed: 208, tugofwar: 1 },
  '113_103': { enter: 88, tugofwar: 1 },
  '113_122': { enter: 88, feed: 208, tugofwar: 1 },
  '113_123': { enter: 89, feed: 208, tugofwar: 1 },
  '122_102': { enter: 88 },
  '122_103': { enter: 88, tugofwar: 1 },
  '122_122': { enter: 88, feed: 263 },
  '123_102': { enter: 89 },
  '123_103': { enter: 89, tugofwar: 1 },
  '123_122': { enter: 89, feed: 263, tugofwar: 1 },
  '123_123': { enter: 89, feed: 263, tugofwar: 1 },
}
export const VISIT_STAGE = { w: 300, h: 200 }

export interface VisitStep {
  clip: string
  /** How long the step lasts; multi-frame clips use their length at 12 fps. */
  ms: number
  /** Our dialogue drawn into the two speech bubbles (left = friend, right = our pet). */
  talk?: [string, string]
}

const FPS = 12
const frames = (n: number): number => Math.ceil((n / FPS) * 1000)

export const VISIT_TALK: [string, string][] = [
  ['嗨！我来找你玩啦~', '太好啦，快进来！'],
  ['你家好漂亮呀！', '嘿嘿，[host]帮我收拾的~'],
  ['我们来比力气吧！', '好呀，我可不会输哦！'],
  ['给你带了好吃的~', '谢谢你，好朋友！'],
]

/** Pairings our pet can host: something to play (tug of war or a meal) must be there. */
export function visitScenes(sex: Sex, stage: Stage): string[] {
  const host = petCode(sex, stage)
  return Object.keys(SCENES).filter((k) => k.endsWith(`_${host}`) && (SCENES[k].feed || SCENES[k].tugofwar))
}

export function visitDir(scene: string): string {
  return `pet/interact2/${scene}/`
}

/** enter → idle with a line of dialogue → tug of war or a shared meal. `roll` picks both, in [0, 1). */
export function visitSteps(roll: number, scene = '102_102'): VisitStep[] {
  const c = SCENES[scene]
  const talk = VISIT_TALK[Math.trunc(roll * VISIT_TALK.length)]
  const tug: VisitStep = { clip: 'tugofwar.swf', ms: 8000 }
  const main: VisitStep = c.feed && (roll >= 0.5 || !c.tugofwar) ? { clip: 'feed.swf', ms: frames(c.feed) } : tug
  return [{ clip: 'enter.swf', ms: frames(c.enter) }, { clip: 'idle.swf', ms: 6000, talk }, main, { clip: 'idle.swf', ms: 3000, talk: ['玩得真开心，下次见！', '拜拜~常来玩哦！'] }]
}

/** The scene box, scaled with the pet (whose clips are 140 px), standing where the pet stands and kept on screen. */
export function visitBox(pet: { left: number; bottom: number; width: number }, screenW: number): { x: number; y: number; w: number; h: number } {
  const w = Math.round((pet.width * VISIT_STAGE.w) / 140)
  const h = Math.round((w * VISIT_STAGE.h) / VISIT_STAGE.w)
  const x = Math.min(Math.max(Math.round(pet.left + pet.width / 2 - w / 2), 0), Math.max(screenW - w, 0))
  return { x, y: Math.round(pet.bottom - h), w, h }
}

/** Bubble text areas in stage pixels, measured from a Ruffle render of idle.swf (bubbles ~17-145 / 155-283, y ~12-88). */
export const BUBBLES = [
  { x: 22, y: 18, w: 118, h: 64 },
  { x: 160, y: 18, w: 118, h: 64 },
]
