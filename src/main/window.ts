import { BrowserWindow, ipcMain, screen } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { IPC } from '../shared/ipc'
import { APP_ORIGIN } from './protocol'
import { desktopCursor, petDisplay } from './desktop'
import { fullscreenGate } from './fullscreen-gate'
import { getSave } from './save'

const CURSOR_INTERVAL_MS = 33
const PAGES = process.env.ELECTRON_RENDERER_URL ?? APP_ORIGIN

/** Transparent, click-through overlay following the pet's active display. */
export function createPetWindow(): BrowserWindow {
  const initialDisplay = petDisplay(screen, getSave().settings.petDisplayId)
  const win = new BrowserWindow({
    ...initialDisplay.workArea,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Chromium apps (browsers, 抖音...) treat a work-area-sized window as covering them and stop painting
    // once it stops being click-through; a tool window is never counted.
    ...(process.platform === 'win32' && { type: 'toolbar' }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      zoomFactor: getSave().settings.zoom,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Full-screen apps hide the pet: macOS keeps it off full-screen spaces, and
  // Linux window managers stack a focused full-screen window above it.
  win.setVisibleOnAllWorkspaces(true)
  win.setIgnoreMouseEvents(true)
  // On macOS, dock.hide() turns the process into a UI element, which hides
  // windows that are already visible.
  win.once('ready-to-show', () => {
    win.showInactive()
    if (process.platform === 'win32') hideOnFullscreen(win)
  })
  // The pet never navigates; links inside SWFs must not replace the page.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Click-through windows receive no mouse events on Linux, so the renderer
  // cannot hit-test on hover. Pushing the cursor position from here works the
  // same on every platform.
  const position = desktopCursor(win, screen, initialDisplay.id, () => getSave().settings.zoom)
  let dragging = false
  ipcMain.handle(IPC.setDragging, (event, on: boolean) => {
    if (event.sender !== win.webContents) throw new Error('Unknown drag sender')
    // Resolve the final point on the display under the cursor before ending the drag.
    const point = position(dragging || on)
    dragging = on
    return point
  })
  let last = ''
  const timer = setInterval(() => {
    const p = position(dragging)
    const key = JSON.stringify({ ...p, desktop: { ...p.desktop, sequence: 0 } })
    if (key === last) return
    last = key
    win.webContents.send(IPC.cursor, p)
  }, CURSOR_INTERVAL_MS)
  win.on('closed', () => {
    clearInterval(timer)
    ipcMain.removeHandler(IPC.setDragging)
  })

  void win.loadURL(`${PAGES}/index.html`)
  if (process.env.ELECTRON_RENDERER_URL) win.webContents.openDevTools({ mode: 'detach' })
  return win
}

// Prints 1 while another window is full screen, 0 otherwise, -1 while the taskbar (or nothing) is in front, twice a second.
// SHQueryUserNotificationState: 2 busy, 3 Direct3D full screen, 4 presentation mode.
// Otherwise the foreground window counts when it covers its monitor without being maximized: the state flips
// between 2 and 5 on its own (#37), and a maximized browser covers the monitor once the taskbar auto-hides.
// Alt+Tab and the task view cover it too; like the taskbar they keep the current state. The desktop (Progman/WorkerW) always covers it, so it never counts.
// The focused pet counts as full screen when it covers the monitor (auto-hidden taskbar), hence the PET handle.
// A write to the closed pipe stops the script once the app is gone.
const FULLSCREEN_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Q -Name W -MemberDefinition '
public struct R { public int L, T, Rt, B; }
public struct M { public int Size; public R Mon, Work; public int Flags; }
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
[DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref M info);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
public static bool Shell(IntPtr h) {
  if (h == IntPtr.Zero) return true;
  var c = new System.Text.StringBuilder(32); GetClassName(h, c, 32);
  var n = c.ToString();
  return n == "Shell_TrayWnd" || n == "Shell_SecondaryTrayWnd" || n == "MultitaskingViewFrame" || n == "XamlExplorerHostIslandWindow" || n == "ForegroundStaging";
}
public static bool Covers(IntPtr h) {
  var c = new System.Text.StringBuilder(32); GetClassName(h, c, 32);
  if (c.ToString() == "Progman" || c.ToString() == "WorkerW") return false;
  R r; M m = new M(); m.Size = Marshal.SizeOf(m);
  // A maximized window covers the monitor too once the taskbar auto-hides, so one with a caption does not count.
  // Full screen drops the caption but keeps WS_MAXIMIZE when entered from a maximized window (F11 in a maximized browser).
  if ((IsZoomed(h) && (GetWindowLong(h, -16) & 0xC00000) == 0xC00000) || !GetWindowRect(h, out r) || !GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) return false;
  return r.L <= m.Mon.L && r.T <= m.Mon.T && r.Rt >= m.Mon.Rt && r.B >= m.Mon.B;
}'
while ($true) {
  $s = 0
  [void][Q.W]::SHQueryUserNotificationState([ref]$s)
  $f = [Q.W]::GetForegroundWindow()
  if ([Q.W]::Shell($f)) { [Console]::WriteLine(-1) }
  else { [Console]::WriteLine([int]($f -ne [IntPtr]PET -and ($s -eq 3 -or $s -eq 4 -or [Q.W]::Covers($f)))) }
  Start-Sleep -Milliseconds 500
}`

/** Windows keeps topmost windows above full-screen apps, so the pet hides itself while one is in front. */
function hideOnFullscreen(win: BrowserWindow): void {
  const script = FULLSCREEN_PS.replace('PET', `${win.getNativeWindowHandle().readBigUInt64LE()}`)
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  createInterface({ input: ps.stdout }).on('line', fullscreenGate((full) => (full ? win.hide() : win.showInactive())))
  win.on('closed', () => ps.kill())
}

/** A normal, resizable window playing one game; the SWF scales with it. With `parent` it stacks above that window. */
export function openGameWindow(swf: string, parent?: BrowserWindow): BrowserWindow {
  const area = screen.getPrimaryDisplay().workAreaSize
  const scale = Math.min(1, (area.width * 0.9) / 1024, (area.height * 0.9) / 768)
  const win = new BrowserWindow({
    parent,
    width: Math.round(1024 * scale),
    height: Math.round(768 * scale),
    useContentSize: true,
    backgroundColor: '#000',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true },
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void win.loadURL(`${PAGES}/game.html?swf=${encodeURIComponent(swf)}`)
  return win
}
