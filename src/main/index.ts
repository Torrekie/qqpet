import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app, clipboard, dialog, ipcMain, net, powerMonitor, session, shell } from 'electron'
import { IPC, type TrayMenuItem, type TrayState } from '../shared/ipc'
import type { SavePatch, Sex } from '../shared/save'
import { aiChat, aiModels } from '../shared/ai'
import { calendar } from '../shared/calendar'
import { latestRelease } from '../shared/update'
import { toShape, type ShapeRect } from '../shared/hit-shape'
import { weather } from '../shared/weather'
import { downloadPack, findPack, importPack, installedContent, resetPacks } from './content'
import { handleScheme, registerScheme } from './protocol'
import { APP_VERSION } from '../shared/version'
import { exportSave, getSave, importSave, loadSave, patchSave, resetSave } from './save'
import { createPetTray } from './tray'
import { frontName } from './front'
import { createPetWindow, openGameWindow } from './window'

// A click-through window on Wayland never learns where the cursor is, and its input region cannot be shaped, so
// nothing on the pet could ever be clicked (#45). Under XWayland, as on X11, an input shape does the hit testing.
// Electron picks the platform (and records it as the ozone-platform switch) before this script runs, so the app
// restarts itself with the switch before taking the single-instance lock. An AppImage restarts through its own file,
// since its mount goes away with this process; app.relaunch() dies with that mount, hence a detached spawn.
// A platform the user chose on the command line stays.
const toX11 =
  process.platform === 'linux' && !!process.env.DISPLAY && app.commandLine.getSwitchValue('ozone-platform') === 'wayland' &&
  !process.argv.some((a) => a.startsWith('--ozone-platform'))
if (toX11) {
  const args = [process.env.APPIMAGE || process.execPath, ...process.argv.slice(1), '--ozone-platform=x11']
  // Electron keeps app.asar, icudtl.dat... open across the spawn, which would pin the old AppImage mount; bash drops them.
  const closeFds = 'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n<&-"; done 2>/dev/null; exec "$0" "$@"'
  const [file, argv] = existsSync('/bin/bash') ? ['/bin/bash', ['-c', closeFds, ...args]] : [args[0], args.slice(1)]
  spawn(file, argv, { detached: true, stdio: 'inherit' }).unref()
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) app.exit(0)

registerScheme()

app.whenReady().then(() => {
  handleScheme()
  app.dock?.hide()
  loadSave()
  // CSS keeps decoded images per stylesheet, so @2x bitmaps follow the hd setting as of launch only.
  if (getSave().settings.hd) {
    session.defaultSession.webRequest.onBeforeSendHeaders((d, cb) => cb({ requestHeaders: { ...d.requestHeaders, 'X-HD': '1' } }))
  }

  const win = createPetWindow()
  const tray = createPetTray((click) => {
    const b = win.getBounds()
    const z = getSave().settings.zoom
    win.webContents.send(IPC.trayClick, click.x === undefined ? click : { ...click, x: (click.x - b.x) / z, y: (click.y! - b.y) / z })
  })
  app.on('before-quit', () => tray.destroy())
  ipcMain.on(IPC.trayMenu, (event, items: TrayMenuItem[]) => {
    if (event.sender !== win.webContents) return
    tray.popupMenu(items, (action) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.trayMenuAction, action)
    })
  })

  let copied = ''
  void clipboard.readText().then((t) => (copied = t))
  setInterval(async () => {
    const text = await clipboard.readText()
    if (text === copied) return
    copied = text
    if (text.trim() && getSave().settings.clip) win.webContents.send(IPC.clipboard, text)
  }, 500)

  ipcMain.handle(IPC.load, () => getSave())
  ipcMain.on(IPC.save, (_e, patch: SavePatch) => {
    patchSave(patch)
    if (patch.petInfo) tray.retip(getSave().petInfo)
    if (patch.settings?.hd !== undefined) tray.setState(getSave())
    if (patch.settings?.zoom !== undefined) win.webContents.setZoomFactor(getSave().settings.zoom)
    if (patch.settings?.watchApp !== undefined) watchFront(getSave().settings.watchApp)
  })
  ipcMain.on(IPC.resetPet, (_e, sex?: Sex) => {
    resetSave(sex)
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle(IPC.exportSave, async () => {
    const day = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog(win, { defaultPath: `QQPet-${day}.json`, filters: [{ name: 'QQ宠物存档', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    exportSave(r.filePath)
    return true
  })
  ipcMain.handle(IPC.importSave, async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'QQ宠物存档', extensions: ['json'] }] })
    if (r.canceled) return
    importSave(r.filePaths[0])
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle(IPC.calendar, () => calendar(net.fetch))
  ipcMain.handle(IPC.aiModels, (_e, c) => aiModels(net.fetch, c))
  ipcMain.handle(IPC.aiChat, (_e, c, messages) => aiChat(net.fetch, c, messages))
  ipcMain.handle(IPC.weather, (_e, city: string) => weather(net.fetch, city))
  ipcMain.handle(IPC.latestRelease, () => latestRelease(net.fetch))
  ipcMain.handle(IPC.packInfo, () => ({ content: installedContent(), shell: APP_VERSION }))
  ipcMain.handle(IPC.importPack, () => importPack(win))
  ipcMain.handle(IPC.resetPacks, () => resetPacks())
  ipcMain.handle(IPC.findPack, () => findPack(net.fetch))
  ipcMain.handle(IPC.downloadPack, () => downloadPack(net.fetch))
  ipcMain.on(IPC.relaunch, () => {
    app.relaunch()
    app.exit(0)
  })
  // A focusable pet window holds a full panel (社区, 密室...) that would cover a normal game window.
  let panel = false
  ipcMain.on(IPC.openGame, (_e, swf: string) => {
    const start = Date.now()
    // Quitting with a game open closes the pet window first.
    openGameWindow(swf, panel ? win : undefined).on('closed', () => win.isDestroyed() || win.webContents.send(IPC.gamePlayed, (Date.now() - start) / 60000))
  })
  ipcMain.on(IPC.quit, () => app.quit())
  ipcMain.on(IPC.copyText, (_e, text: string) => clipboard.writeText(text))
  ipcMain.on(IPC.openUrl, (_e, url: string) => /^https?:\/\//.test(url) && void shell.openExternal(url))
  // Linux shapes the window's input instead: ignoring the mouse would also hide the cursor from the pet (#45).
  ipcMain.on(IPC.setClickThrough, (_e, on: boolean) => process.platform === 'linux' || win.setIgnoreMouseEvents(on))
  ipcMain.on(IPC.setHitShape, (e, rects: ShapeRect[]) => {
    if (process.platform !== 'linux' || e.sender !== win.webContents || !Array.isArray(rects)) return
    const { width, height } = win.getContentBounds()
    win.setShape(toShape(rects, win.webContents.getZoomFactor(), width, height))
  })
  ipcMain.on(IPC.setAlwaysOnTop, (_e, on: boolean) => win.setAlwaysOnTop(on, 'screen-saver'))
  ipcMain.on(IPC.setFocusable, (_e, on: boolean) => {
    panel = on
    win.setFocusable(on)
    // macOS draws IME candidates below screen-saver level; drop under them while a panel takes typing.
    if (process.platform === 'darwin') win.setAlwaysOnTop(true, on ? 'floating' : 'screen-saver')
    // The window is born unfocusable; setFocusable alone does not make it key, so IME stays on the previous app.
    if (on) {
      if (process.platform === 'darwin') app.focus({ steal: true })
      win.focus()
    }
  })
  ipcMain.on(IPC.setAutoStart, (_e, on: boolean) => app.setLoginItemSettings({ openAtLogin: on }))
  ipcMain.on(IPC.setTrayState, (_e, state: TrayState) => tray.setState(getSave(), state))

  const AWAY_S = 300
  let away = false
  const presence = (on: boolean): void => {
    if (on === away) return
    away = on
    win.webContents.send(IPC.presence, away)
  }
  setInterval(() => presence(powerMonitor.getSystemIdleTime() >= AWAY_S), 5000)
  powerMonitor.on('lock-screen', () => presence(true))
  powerMonitor.on('unlock-screen', () => presence(false))
  powerMonitor.on('suspend', () => presence(true))
  powerMonitor.on('resume', () => presence(false))

  let frontTimer: ReturnType<typeof setInterval> | undefined
  let lastFront = ''
  const watchFront = (on: boolean): void => {
    clearInterval(frontTimer)
    frontTimer = undefined
    lastFront = ''
    if (!on) return
    const tick = (): void => {
      void frontName().then((name) => {
        if (!name || name === lastFront) return
        lastFront = name
        win.webContents.send(IPC.front, name)
      })
    }
    tick()
    frontTimer = setInterval(tick, 15_000)
  }
  watchFront(getSave().settings.watchApp)
})

app.on('window-all-closed', () => app.quit())
