import { speak } from '../pet/pet'
import { info, playingDesk, busy, refreshTray, save, setDeskGame, setInfo, stage } from '../pet/store'
import { BUBBLES, VISIT_STAGE, visitBox, visitDir, visitScenes, visitSteps } from '../pet/visit-plan'
import { SwfPlayer } from '../swf/player'
import './css/visit.css'
import { div } from './dom'
import { floatMood } from './float'

const MOOD = 10
let box: HTMLDivElement | null = null
let timer = 0

function finish(): void {
  clearTimeout(timer)
  if (!box) return
  box.remove()
  box = null
  setDeskGame('')
  document.getElementById('pet')!.hidden = false
  refreshTray()
}

/** A friend's pet drops by for a short scene; clicking it ends the visit. */
export function visitFriend(): void {
  if (box || playingDesk()) return
  if (stage() === 'Egg') return speak({ s: '[host]，等我破壳了再请朋友来玩吧~', now: true }, 'speak')
  if (busy() || info.health < 5) return speak({ s: '[host]，我现在不方便招待朋友呢~', now: true }, 'speak')
  const scenes = visitScenes(info.sex, stage())
  if (!scenes.length) return speak({ s: '[host]，朋友们今天都没空呢~', now: true }, 'speak')
  const scene = scenes[Math.trunc(Math.random() * scenes.length)]
  const pet = document.getElementById('pet')!
  const r = visitBox(pet.getBoundingClientRect(), innerWidth)
  setDeskGame('visit')
  pet.hidden = true
  const scale = r.w / VISIT_STAGE.w
  const bubbles = BUBBLES.map((b) =>
    Object.assign(div('visitBubble fc'), {
      style: `left:${b.x * scale}px;top:${b.y * scale}px;width:${b.w * scale}px;height:${b.h * scale}px;font-size:${Math.max(10, 13 * scale)}px`,
    }),
  )
  const stageEl = div('visitStage')
  box = div('visitWin', stageEl, ...bubbles)
  box.dataset.hit = ''
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
  box.addEventListener('click', finish)
  document.body.append(box)
  const player = new SwfPlayer(stageEl)
  const steps = visitSteps(Math.random(), scene)
  const run = (i: number): void => {
    if (!box) return
    const s = steps[i]
    if (!s) {
      setInfo('mood', Math.min(info.mood + MOOD, save.petComputedlInfo.moodMax))
      void floatMood(MOOD)
      return finish()
    }
    bubbles.forEach((b, k) => {
      b.textContent = s.talk ? s.talk[k].replace(/\[host]/g, info.host) : ''
      b.hidden = !s.talk
    })
    void player.load(visitDir(scene) + s.clip).catch(() => finish())
    timer = window.setTimeout(() => run(i + 1), s.ms)
  }
  run(0)
}
