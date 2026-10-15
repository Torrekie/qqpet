import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

const iterations = 8
const usage = 'Usage: node scripts/check-ruffle-lifetime.mjs --baseline DIR --fixed DIR --movie FILE --chrome PATH [--renderer canvas]'

function argumentsOf(argv) {
  const options = { renderer: 'canvas' }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] === '--swf' ? '--movie' : argv[index]
    if (!['--baseline', '--fixed', '--movie', '--chrome', '--renderer'].includes(flag) || !argv[index + 1]) throw new Error(usage)
    const key = flag.slice(2)
    if (Object.hasOwn(options, key) && key !== 'renderer') throw new Error(`Duplicate ${flag}.`)
    options[key] = argv[index + 1]
  }
  if (!options.baseline || !options.fixed || !options.movie || !options.chrome) throw new Error(usage)
  if (options.renderer !== 'canvas') throw new Error('The lifetime check requires the canvas renderer to isolate audio ownership.')
  return options
}

function deadline(promise, milliseconds, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds) })])
    .finally(() => clearTimeout(timer))
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

// Installed before Ruffle. The observer holds contexts weakly, never keeps a
// BufferSource, and never closes a context on Ruffle's behalf.
function installProbe() {
  const contexts = new Map()
  let nextContext = 0
  let wasmExports = null
  let wasmMemory = null
  let captureError = null
  const NativeContext = window.AudioContext || window.webkitAudioContext
  if (typeof NativeContext !== 'function' || typeof WeakRef !== 'function') throw new Error('Real WebAudio and WeakRef are required.')
  window.__qqpetRespectSystemAudio = true

  function capture(result) {
    const instance = result instanceof WebAssembly.Instance ? result : result?.instance
    const exports = instance?.exports
    if (typeof exports?.audio_buffer_count === 'function') {
      if (!(exports.memory instanceof WebAssembly.Memory)) captureError = 'The diagnostic Wasm does not export its memory.'
      else if (wasmMemory && wasmMemory !== exports.memory) captureError = 'Ruffle replaced its shared Wasm memory during the test.'
      else { wasmExports = exports; wasmMemory = exports.memory }
    }
    return result
  }
  for (const name of ['instantiate', 'instantiateStreaming']) {
    const original = WebAssembly[name]
    if (typeof original === 'function') WebAssembly[name] = function (...args) { return Reflect.apply(original, this, args).then(capture) }
  }

  let ContextProxy
  ContextProxy = new Proxy(NativeContext, {
    construct(target, args, newTarget) {
      const context = Reflect.construct(target, args, newTarget === ContextProxy ? target : newTarget)
      const record = { weak: new WeakRef(context), ended: 0, sources: 0, closeCalls: 0 }
      record.closed = new Promise((resolve, reject) => { record.resolveClose = resolve; record.rejectClose = reject })
      record.closed.catch(() => {})
      contexts.set(++nextContext, record)
      const createSource = context.createBufferSource
      context.createBufferSource = function (...sourceArgs) {
        const source = Reflect.apply(createSource, this, sourceArgs)
        record.sources++
        source.addEventListener('ended', () => { record.ended++ }, { once: true })
        return source
      }
      const close = context.close
      context.close = function (...closeArgs) {
        record.closeCalls++
        let result
        try { result = Reflect.apply(close, this, closeArgs) }
        catch (error) { record.rejectClose(error); throw error }
        Promise.resolve(result).then(record.resolveClose, record.rejectClose)
        return result
      }
      return context
    },
  })
  window.AudioContext = ContextProxy
  if (typeof window.webkitAudioContext === 'function') window.webkitAudioContext = ContextProxy

  function check(condition, message) { if (!condition) throw new Error(message) }
  async function bounded(promise, milliseconds, label) {
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds) })])
    } finally { clearTimeout(timer) }
  }
  async function until(read, label, milliseconds = 15000) {
    const end = performance.now() + milliseconds
    while (!read()) {
      if (performance.now() >= end) throw new Error(`${label} timed out.`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  function count() {
    if (captureError) throw new Error(captureError)
    check(wasmExports && wasmMemory, 'The diagnostic audio_buffer_count export was not captured.')
    const value = wasmExports.audio_buffer_count()
    check(Number.isInteger(value) && value >= 0, 'Invalid Rust audio buffer count.')
    return value
  }

  window.__qqpetLifetime = {
    async run({ rounds, baseline, renderer }) {
      await until(() => typeof window.RufflePlayer?.newest === 'function', 'Ruffle loader')
      check(document.visibilityState === 'visible', 'The test page must remain visible.')
      const stage = document.getElementById('stage')
      const counts = []
      let constructed = 0, closed = 0, ended = 0
      for (let round = 0; round < rounds; round++) {
        const previousContext = nextContext
        const player = window.RufflePlayer.newest().createPlayer()
        player.style.cssText = 'display:block;width:160px;height:160px'
        stage.appendChild(player)
        let failure = null
        try {
          await bounded(player.ruffle().load({
            url: new URL('/movie.swf', location.href).href, autoplay: 'on',
            preferredRenderer: renderer, splashScreen: false, unmuteOverlay: 'hidden',
            allowScriptAccess: false, contextMenu: 'off', logLevel: 'error',
          }), 30000, 'SWF load')
          await until(() => player.ruffle().metadata != null, 'SWF metadata')
          const metadata = player.ruffle().metadata
          check(metadata.width > 0 && metadata.height > 0 && metadata.numFrames > 0 && metadata.frameRate > 0, 'The SWF metadata is incomplete.')
          check(nextContext === previousContext + 1, 'Each player must construct exactly one real AudioContext.')
          const record = contexts.get(nextContext)
          check(record, 'Missing real AudioContext record.')
          await bounded(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), 10000, 'SWF paint')
          const canvas = player.shadowRoot?.querySelector('canvas')
          check(canvas && canvas.width > 0 && canvas.height > 0, 'The SWF did not create a paintable canvas.')
          await until(() => record.ended > 0, 'Real AudioBufferSource completion')
          check(record.sources >= 2, 'Ruffle did not initialize its two PCM buffers.')
          const expectedLive = baseline ? (round + 1) * 2 : 2
          check(count() === expectedLive, `Round ${round + 1}: unexpected live Rust buffers before destruction.`)
        } catch (error) { failure = error }
        finally {
          // This invokes the real Ruffle custom-element destructor. The probe
          // never forces an AudioContext closed or substitutes a silent backend.
          player.remove()
          const created = [...contexts].filter(([id]) => id > previousContext)
          try {
            await bounded(Promise.all(created.map(([, record]) => record.closed)), 5000, 'Ruffle AudioContext close')
            for (const [id, record] of created) {
              check(record.closeCalls > 0, 'Ruffle did not close its real AudioContext.')
              const context = record.weak.deref()
              check(!context || context.state === 'closed', 'A real AudioContext remained open.')
              constructed++; closed++; ended += record.ended
              contexts.delete(id)
            }
          } catch (error) { failure ||= error }
        }
        if (failure) throw failure
        const after = count()
        const expected = baseline ? (round + 1) * 2 : 0
        check(after === expected, `Round ${round + 1}: expected ${expected} retained Rust buffers, observed ${after}.`)
        counts.push(after)
      }
      check(constructed === rounds && closed === rounds, 'The requested real lifecycles did not complete.')
      return { iterations: rounds, counts, constructed, closed, ended }
    },
  }
}

class CDP {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    this.events = []
    this.waiters = new Set()
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      } else {
        this.events.push(message)
        if (this.events.length > 128) this.events.shift()
        for (const waiter of this.waiters) {
          if (waiter.matches(message)) { this.waiters.delete(waiter); waiter.resolve(message.params) }
        }
      }
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools connection closed.'))
      this.pending.clear()
      for (const waiter of this.waiters) waiter.reject(new Error('Chrome DevTools connection closed.'))
      this.waiters.clear()
    })
  }
  call(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.sequence
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
    return deadline(result, timeout, method).finally(() => this.pending.delete(id))
  }
  waitFor(method, sessionId, predicate) {
    const matches = message => message.method === method && message.sessionId === sessionId && predicate(message.params)
    const prior = this.events.find(matches)
    if (prior) return Promise.resolve(prior.params)
    let waiter
    const promise = new Promise((resolve, reject) => { waiter = { matches, resolve, reject }; this.waiters.add(waiter) })
    return deadline(promise, 30000, method).finally(() => this.waiters.delete(waiter))
  }
}

async function main() {
  const options = argumentsOf(process.argv.slice(2))
  const roots = { baseline: await realpath(options.baseline), fixed: await realpath(options.fixed) }
  for (const root of Object.values(roots)) await access(join(root, 'ruffle.js'), constants.R_OK)
  const movie = await readFile(options.movie)
  if (movie.length < 8 || !['FWS', 'CWS', 'ZWS'].includes(movie.subarray(0, 3).toString('ascii'))) throw new Error('The movie must contain actual SWF bytes, not a Git LFS pointer.')
  await access(options.chrome, constants.X_OK)
  const profile = await mkdtemp(join(tmpdir(), 'qqpet-ruffle-lifetime-'))
  let chrome, exited, cdp, socket
  let chromeError = null
  let primaryFailure = null
  let stderr = ''
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname === '/movie.swf') { response.writeHead(200, { 'Content-Type': 'application/x-shockwave-flash', 'Content-Length': movie.length }); response.end(movie); return }
      const match = /^\/(baseline|fixed)\/(.*)$/.exec(pathname)
      if (!match) { response.writeHead(404); response.end(); return }
      if (match[2] === 'index.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><head><meta charset="utf-8"><title>Ruffle lifetime</title><script src="./ruffle.js"></script></head><body><div id="stage"></div></body></html>')
        return
      }
      const root = roots[match[1]], path = resolve(root, match[2])
      if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) { response.writeHead(404); response.end(); return }
      const body = await readFile(path)
      const type = extname(path) === '.wasm' ? 'application/wasm' : extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length }); response.end(body)
    })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end() })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    chrome = spawn(options.chrome, [
      '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--crash-dumps-dir=${join(profile, 'crashes')}`, 'about:blank',
    ], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
    exited = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', error => { chromeError = error; resolve() }) })
    chrome.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192) })
    const end = Date.now() + 15000
    let endpoint
    while (!endpoint) {
      if (chromeError) throw chromeError
      if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chrome exited before connecting: ${stderr}`)
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
        if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) endpoint = `ws://127.0.0.1:${port}${path}`
      } catch { /* Chrome writes this file after starting its DevTools endpoint. */ }
      if (Date.now() >= end) throw new Error(`Chrome DevTools startup timed out: ${stderr}`)
      if (!endpoint) await delay(50)
    }
    socket = new WebSocket(endpoint)
    await deadline(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome DevTools.')), { once: true }) }), 10000, 'Chrome DevTools connect')
    cdp = new CDP(socket)
    const results = {}
    for (const name of ['baseline', 'fixed']) {
      const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
      try {
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
        await cdp.call('Page.enable', {}, sessionId)
        await cdp.call('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
        await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installProbe.toString()})();` }, sessionId)
        const navigation = await cdp.call('Page.navigate', { url: `${origin}/${name}/index.html` }, sessionId)
        if (navigation.errorText) throw new Error(`The ${name} test page could not load: ${navigation.errorText}`)
        await cdp.waitFor('Page.lifecycleEvent', sessionId, event => event.name === 'load' && event.loaderId === navigation.loaderId)
        const response = await cdp.call('Runtime.evaluate', {
          expression: `window.__qqpetLifetime.run(${JSON.stringify({ rounds: iterations, baseline: name === 'baseline', renderer: options.renderer })})`,
          awaitPromise: true, returnByValue: true,
        }, sessionId, 120000)
        if (response.exceptionDetails) throw new Error(`${name}: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`)
        if (!response.result?.value || response.result.value.iterations !== iterations) throw new Error(`${name}: missing completed lifecycle result.`)
        results[name] = response.result.value
      } finally { await cdp.call('Target.closeTarget', { targetId }).catch(() => {}) }
    }
    return results
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (cdp) await cdp.call('Browser.close', {}, undefined, 2000).catch(() => {})
    const cleanupErrors = []
    async function clean(operation) { try { await operation() } catch (error) { cleanupErrors.push(error) } }
    await clean(() => socket?.close())
    await clean(async () => {
      if (!chrome?.pid) return
      const kill = signal => {
        try { if (process.platform === 'win32') chrome.kill(signal); else process.kill(-chrome.pid, signal) }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      kill('SIGTERM')
      try { await deadline(exited, 2000, 'Chrome exit') }
      catch { kill('SIGKILL'); await deadline(exited, 2000, 'Chrome termination') }
    })
    await clean(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    await clean(() => rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    if (cleanupErrors.length) {
      const message = `Lifetime check cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`
      if (primaryFailure) process.stderr.write(`${message}\n`)
      else throw new Error(message)
    }
  }
}

main().then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
