#!/usr/bin/env node
// Screenshot a URL through headless Edge/Chrome over the DevTools protocol, with
// device emulation so phone widths render truthfully (a plain --window-size
// screenshot silently clamps to Chromium's ~500px minimum window width).
// Optional clicks let you capture UI states such as an opened sidebar.
//
//   node tools/capture-cdp.mjs --url http://localhost:5173/ --out shots/01.png \
//        --width 375 --height 812 [--scale 2] [--mobile] [--settle 1500] \
//        [--click "button[aria-label='Show sidebar']" --click "..."] [--eval "js"]
//
// No dependencies: Node 22+ (global WebSocket) and an installed Edge, Chrome or Chromium
// (Windows, macOS or Linux).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const opts = {
  url: '',
  out: '',
  width: 1440,
  height: 900,
  scale: 1,
  mobile: false,
  settle: 1500,
  click: [],
  eval: [],
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '')
  if (k === 'mobile') opts.mobile = true
  else if (k === 'click' || k === 'eval') opts[k].push(argv[++i])
  else if (k in opts) opts[k] = typeof opts[k] === 'number' ? Number(argv[++i]) : argv[++i]
  else throw new Error(`Unknown option --${k}`)
}
if (!opts.url || !opts.out) {
  console.error(
    'Usage: --url <url> --out <png> [--width --height --scale --mobile --settle --click <selector>... --eval <js>...]',
  )
  process.exit(2)
}

// Forward slashes: Windows accepts them and bash shells drop the parenthesised env name.
const pf = process.env['ProgramFiles'] ?? 'C:/Program Files',
  pf86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'
const candidates = {
  win32: [
    `${pf86}/Microsoft/Edge/Application/msedge.exe`,
    `${pf}/Microsoft/Edge/Application/msedge.exe`,
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Google/Chrome/Application/chrome.exe`,
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
}
const browser = (candidates[process.platform] ?? []).find((p) => existsSync(p))
if (!browser) throw new Error(`No Edge, Chrome or Chromium found for ${process.platform}.`)

const profile = mkdtempSync(join(tmpdir(), 'ak-review-cdp-'))
const proc = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
const wsUrl = await new Promise((res, rej) => {
  let buf = ''
  proc.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m) res(m[1])
  })
  proc.on('exit', (c) => rej(new Error(`browser exited (${c}) before DevTools came up:\n${buf}`)))
  setTimeout(() => rej(new Error('timed out waiting for DevTools endpoint')), 15000)
})

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map(),
  listeners = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
  } else if (msg.method) listeners.forEach((l) => l(msg))
}
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
const once = (method, sessionId) =>
  new Promise((res) =>
    listeners.push((m) => {
      if (m.method === method && m.sessionId === sessionId) res(m.params)
    }),
  )
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: opts.width, height: opts.height, deviceScaleFactor: opts.scale, mobile: opts.mobile },
    sessionId,
  )
  if (opts.mobile)
    await send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
      sessionId,
    )
  const loaded = once('Page.loadEventFired', sessionId)
  await send('Page.navigate', { url: opts.url }, sessionId)
  await loaded
  await sleep(opts.settle)
  // Wrapped in an async IIFE so --eval snippets may use `await`.
  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (r.exceptionDetails)
      throw new Error(
        `eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`,
      )
    return r.result.value
  }
  for (const sel of opts.click) {
    const ok = await evaluate(
      `const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true`,
    )
    if (!ok) throw new Error(`--click: no element matches ${sel}`)
    await sleep(600)
  }
  for (const js of opts.eval) {
    await evaluate(js)
    await sleep(400)
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const out = resolve(opts.out)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(
    `Saved ${out} (${opts.width}x${opts.height}@${opts.scale}${opts.mobile ? ', mobile' : ''})`,
  )
} finally {
  try {
    await send('Browser.close')
  } catch {
    /* already gone */
  }
  ws.close()
  // Wait for the browser to let go of its profile before deleting it; a
  // leftover temp profile is harmless, so cleanup failures are not fatal.
  await Promise.race([
    new Promise((r) => proc.once('exit', r)),
    sleep(5000).then(() => proc.kill()),
  ])
  await sleep(200)
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* ignore */
  }
}
