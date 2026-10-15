import type { Sex } from '../../shared/save'
import type { Stage } from './level'

export type Mood = 'happy' | 'peaceful' | 'upset' | 'sad'

export interface PoseOpt {
  /** Only these actions may follow; anything else is dropped. */
  afterState?: string[]
  /** Freeze the animation on this frame. */
  overCurrentFrame?: number
  /** A single-root-frame clip (animated inside a MovieClip) ends after this many ms instead of holding. */
  holdMs?: number
}

/** `<name><n>.swf` with n random in [start, end] unless notNum, else `<name>.swf`. */
interface Route {
  name: string
  start?: number
  end?: number
  notNum?: boolean
  opt?: PoseOpt
}

export interface Target {
  url: string
  opt: { opt?: PoseOpt }
}

type Range = { end?: number; notNum?: boolean }
type Table = Record<string, Route>

function common(o: { enter?: Range; eat?: Range; exit?: Range; clean?: Range; sick?: Range; cure?: Range; bury: number }): Table {
  return {
    enter: { name: 'Enter', start: 1, end: o.enter?.end ?? 3 },
    clean: { name: 'Clean', start: 1, end: 2, notNum: o.clean?.notNum },
    eat: { name: 'Eat', start: 1, end: o.eat?.end ?? 2 },
    first: { name: 'First' },
    levUp: { name: 'LevUp' },
    exit: { name: 'Exit', start: 1, end: o.exit?.end ?? 4 },
    sick: { name: 'Sick', start: 1, end: 2, notNum: o.sick?.notNum },
    die: { name: 'Die', opt: { afterState: ['revival', 'bury'] } },
    revival: { name: 'Revival' },
    bury: { name: 'Bury', opt: { afterState: [], overCurrentFrame: o.bury } },
    dying: { name: 'Dying', opt: { afterState: ['dying', 'die', 'cure', 'revival', 'bury', 'hide', 'appear'] } },
    cure: { name: 'Cure', start: 1, end: 2, notNum: o.cure?.notNum },
    hideleft: { name: 'Hide_left', start: 1, end: 1 },
    hideright: { name: 'Hide_right', start: 1, end: 1 },
    hungry: { name: 'Hungry' },
    dirty: { name: 'Dirty' },
    poor: { name: 'Poor' },
  }
}

function moodActions(play: number, speak: Range = { notNum: true }): Table {
  return {
    normal: { name: 'Stand' },
    // Keep the pet's own appearance when no matching drag artwork is available.
    drag: { name: 'Stand' },
    play: { name: 'play/P', start: 1, end: play },
    speak: { name: 'Speak', start: 1, end: speak.end ?? 1, notNum: speak.notNum },
    hide: { name: 'Hide' },
    appear: { name: 'Appear' },
  }
}

/**
 * Per-pet action content, kept as plain data so it can later move into the content pack (#28).
 * Paths are relative to `pet/Action/<sex>/<stage>/`, without `.swf`. A missing entry keeps the default clip.
 */
export interface ActionData {
  /** Numbered idle plays: Egg/Kid `play/P1..n`, Adult `peaceful/play/P1..n`. */
  play: { egg: number; kid: number; peaceful: number }
  /**
   * Alternatives picked at random for an action key (`walk_left`, `walk_right`, `drag`, `dirty`, `poor`,
   * `hideleft`, `hideright`, and `look_left` / `look_right` after a walk).
   */
  variants: Partial<Record<Stage, Record<string, string[]>>>
  /** Extra idle plays mixed into the numbered ones, one slot each. `single`: one root frame, animated inside. */
  extraPlay?: Partial<Record<Stage, { clip: string; single?: boolean }[]>>
  /** Lie down and rest: optional `down` clip, a held `lying` pose (frozen on `freeze` if set), optional `up` clip. */
  rest?: Partial<Record<Stage, RestClips>>
}

export interface RestClips {
  down?: string
  lying: string
  freeze?: number
  up?: string
}

/** Single-root-frame clips loop inside a MovieClip; this is roughly one loop. */
export const SINGLE_FRAME_HOLD = 3000

const walks = (n: number): Record<string, string[]> => ({
  walk_left: Array.from({ length: n }, (_, i) => `walk/walk_left${i ? i + 1 : ''}`),
  walk_right: Array.from({ length: n }, (_, i) => `walk/walk_right${i ? i + 1 : ''}`),
})

const looks = (): Record<string, string[]> => ({
  look_left: ['walk/left_stop2', 'walk/left_stop3', 'walk/lplay', 'walk/lplay2', 'walk/lplay3'],
  look_right: ['walk/right_stop2', 'walk/right_stop3', 'walk/rplay', 'walk/rplay2', 'walk/rplay3'],
})

const DRAG = (ids: number[]): string[] => ids.map((i) => `motion/drag${i}101213`)

export const ACTIONS: Record<Sex, ActionData> = {
  // GG has the newer client's extra clips (#25).
  GG: {
    play: { egg: 47, kid: 127, peaceful: 127 },
    variants: {
      Egg: {
        ...walks(2),
        hideleft: ['Hide_left1', 'motion/hide_left130906'],
        hideright: ['Hide_right1', 'motion/hide_right130906'],
        look_left: ['walk/lplay'],
        look_right: ['walk/rplay'],
      },
      Kid: {
        ...walks(3),
        dirty: ['Dirty', 'lead/dirty20110805'],
        poor: ['Poor', 'lead/poor20110826'],
        ...looks(),
      },
      // The imported Egg/Kid motion/drag movies also draw adult GG, despite their directory names.
      Adult: { ...walks(3), drag: DRAG([1, 2, 3]), hideright: ['Hide_right1', 'motion/hide_right130906'], ...looks() },
    },
    extraPlay: {
      // Imported Egg extras draw adult GG and have no age-dependent initialization.
      Adult: [{ clip: 'motion/005', single: true }, { clip: 'motion/009', single: true }, { clip: 'motion/017' }, { clip: 'motion/021' }],
    },
    rest: {
      // The imported Egg/Kid turn clips also draw adult GG.
      Adult: { down: 'Etoj', lying: 'prostrate/Stand', up: 'Jtoc' },
    },
  },
  // MM only has the adult lying pose.
  MM: { play: { egg: 29, kid: 111, peaceful: 100 }, variants: {}, rest: { Adult: { lying: 'prostrate/Stand' } } },
}

const KID = { exit: { end: 3 }, eat: { end: 1 }, clean: { notNum: true }, sick: { notNum: true }, cure: { notNum: true } }
const EGG = { enter: { end: 2 }, exit: { end: 3 }, clean: { notNum: true }, sick: { notNum: true }, cure: { notNum: true } }

const MOOD_PLAY: Record<Mood, number> = { happy: 47, peaceful: 100, upset: 23, sad: 22 }

type PlayCount = ActionData['play']

type Tables = Record<Stage, Table>

const tables = (adultBury: number, play: PlayCount): Tables => ({
  Adult: common({ bury: adultBury }),
  Kid: { ...common({ ...KID, bury: 134 }), ...moodActions(play.kid) },
  Egg: { ...common({ ...EGG, bury: 140 }), ...moodActions(play.egg, { end: 3 }) },
})

const TABLES: Record<Sex, Tables> = { GG: tables(76, ACTIONS.GG.play), MM: tables(142, ACTIONS.MM.play) }
const adultMoods = (sex: Sex) =>
  Object.fromEntries(
    Object.entries(MOOD_PLAY).map(([m, n]) => [m, moodActions(m === 'peaceful' ? ACTIONS[sex].play.peaceful : n)]),
  ) as Record<Mood, Table>
const ADULT_MOODS: Record<Sex, Record<Mood, Table>> = { GG: adultMoods('GG'), MM: adultMoods('MM') }

/** Adult animations for these live in a per-mood directory. */
const BY_MOOD = ['normal', 'drag', 'play', 'speak', 'appear', 'hide']

export function route(sex: Sex, stage: Stage, action: string, mood: Mood): Target {
  let dir = `pet/Action/${sex}/${stage}/`
  let routes: Table = TABLES[sex][stage]
  if (stage === 'Adult' && BY_MOOD.includes(action)) {
    routes = ADULT_MOODS[sex][mood]
    dir += `${mood}/`
  }
  const r = routes[action]
  if (action === 'play') {
    const extra = extraPlay(sex, stage, r.end ?? 0)
    if (extra) return { url: `pet/Action/${sex}/${stage}/${extra.clip}.swf`, opt: { ...r, opt: extra.single ? { holdMs: SINGLE_FRAME_HOLD } : undefined } }
  }
  const alt = stage === 'Adult' && BY_MOOD.includes(action) && action !== 'drag' ? null : variant(sex, stage, action)
  if (alt) return { url: `pet/Action/${sex}/${stage}/${alt}.swf`, opt: r }
  const n = r.start && r.end && !r.notNum ? Math.trunc(Math.random() * r.end + r.start) : ''
  return { url: `${dir}${r.name}${n}.swf`, opt: r }
}

/** A random alternative clip (relative to the stage directory), or null when this pet has none. */
export function variant(sex: Sex, stage: Stage, key: string, pick: (n: number) => number = (n) => Math.trunc(Math.random() * n)): string | null {
  const list = ACTIONS[sex].variants[stage]?.[key]
  return list?.length ? list[pick(list.length)] : null
}

/** One of the extra plays, with the same odds as any single numbered play; null otherwise. */
export function extraPlay(sex: Sex, stage: Stage, numbered: number, roll: number = Math.random()): { clip: string; single?: boolean } | null {
  const list = ACTIONS[sex].extraPlay?.[stage] ?? []
  const i = Math.trunc(roll * (numbered + list.length)) - numbered
  return i >= 0 ? list[i] : null
}

/** Walk cycle for a direction; GG has extra gait variants. */
export function walkUrl(sex: Sex, stage: Stage, dir: 'left' | 'right'): string {
  return `pet/Action/${sex}/${stage}/${variant(sex, stage, `walk_${dir}`) ?? `walk/walk_${dir}`}.swf`
}

/** A short look-around after a walk in that direction, or null (MM, or no clip). */
export function lookUrl(sex: Sex, stage: Stage, dir: 'left' | 'right'): string | null {
  const v = variant(sex, stage, `look_${dir}`)
  return v ? `pet/Action/${sex}/${stage}/${v}.swf` : null
}

export interface RestPlan {
  down?: string
  lying: { url: string; freeze?: number }
  up?: string
}

/** URLs for lying down to rest, or null when this pet has no lying pose. */
export function restPlan(sex: Sex, stage: Stage): RestPlan | null {
  const r = ACTIONS[sex].rest?.[stage]
  if (!r) return null
  const url = (clip: string): string => `pet/Action/${sex}/${stage}/${clip}.swf`
  return { down: r.down && url(r.down), lying: { url: url(r.lying), freeze: r.freeze }, up: r.up && url(r.up) }
}
