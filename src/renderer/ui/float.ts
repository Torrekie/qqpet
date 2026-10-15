import { SwfPlayer } from '../swf/player'

const el = document.createElement('div')
el.className = 'float-mood'
document.getElementById('pet')!.appendChild(el)
let loaded: Promise<SwfPlayer> | null = null

function moodPlayer(): Promise<SwfPlayer> {
  if (!loaded) {
    const player = new SwfPlayer(el)
    loaded = player.load('pet/float/mood.swf').then(() => player).catch((error) => {
      player.destroy()
      loaded = null
      throw error
    })
  }
  return loaded
}

/** "+v" mood animation above the pet. */
export async function floatMood(v: number): Promise<void> {
  const player = await moodPlayer()
  const setdata = await player.callback('setdata')
  setdata(v)
}
