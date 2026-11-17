// The dial voice server: routes, the event stream, the state, the close timer,
// start and shutdown. It joins the segmenter, the request guard, the session
// manager and the speaker; the socket itself is `listenLoopback`.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { findOnPath } from '../spawn.mjs'
import { createEngine } from './engine.mjs'
import { checkRequest } from './guard.mjs'
import { createSegmenter, speakable } from './segment.mjs'
import { createSpeaker } from './speech.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEEPALIVE_MS = 15_000
const TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval }

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
const SECURITY = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': CSP
}

const STATIC = {
  page: { key: 'page', type: 'text/html; charset=utf-8' },
  script: { key: 'script', type: 'text/javascript; charset=utf-8' },
  logic: { key: 'logic', type: 'text/javascript; charset=utf-8' },
  style: { key: 'style', type: 'text/css; charset=utf-8' }
}

const FILES = { page: 'page.html', script: 'page.js', logic: 'page-logic.mjs', style: 'page.css' }

/**
 * Read the four page files and the voice prompt that ship beside this module.
 * → `{ ok: true, assets: { page, script, logic, style }, prompt }` | `{ ok: false, reason }`
 */
export function loadVoiceFiles(dir = HERE) {
  const read = name => readFileSync(join(dir, name), 'utf8')
  const assets = {}
  for (const [key, name] of [...Object.entries(FILES), ['prompt', 'prompt.md']]) {
    try {
      assets[key] = read(name)
    } catch (err) {
      return { ok: false, reason: `cannot read ${join(dir, name)} (${err.code ?? 'error'}: ${err.message})` }
    }
  }
  const { prompt, ...page } = assets
  return { ok: true, assets: page, prompt }
}

const firstLine = text =>
  String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? null

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The voice server over injected parts. `limits` is
 * `{ voiceTurnSeconds, voiceCloseSeconds, voiceTurnChars }`; `assets` is
 * `{ page, script, logic, style }`. `warn(line)` gets each stderr line without
 * its `dial: ` prefix.
 * → `{ handle(req, res), start(), shutdown() → Promise<number>, done, address }`
 */
export function createVoice({
  port,
  token,
  lang,
  model,
  sayVoice,
  limits,
  cwd,
  env,
  prompt,
  assets,
  spawn,
  timers = TIMERS,
  uuid = randomUUID,
  platform = process.platform,
  noOpen = false,
  warn = () => {}
}) {
  const address = `http://127.0.0.1:${port}/?t=${token}`
  const turnChars = limits.voiceTurnChars
  const bodyLimit = 4 * turnChars + 1024
  const sayAvailable = findOnPath(env, 'say') !== null

  const pages = new Set()
  const segmenter = createSegmenter()
  let refusedReason = null
  let speechFailed = false
  let ending = false
  let started = false
  let shutdownPromise = null
  let keepalive = null
  let closeTimer = null
  let opener = null // { handle, exited, waiters }
  let lastState = { state: 'idle' }
  let holding = 0

  let resolveDone
  const done = new Promise(resolve => {
    resolveDone = resolve
  })

  const frame = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

  const broadcast = (name, data) => {
    if (ending) return
    const text = frame(name, data)
    for (const res of pages) res.write(text)
  }

  const currentState = () => {
    if (refusedReason !== null) return { state: 'refused', reason: refusedReason }
    if (speaker.busy) return { state: 'speaking' }
    if (engine.busy) return { state: 'thinking' }
    return { state: 'idle' }
  }

  const update = () => {
    if (holding > 0 || ending) return
    const next = currentState()
    if (next.state === lastState.state && next.reason === lastState.reason) return
    lastState = next
    broadcast('state', next)
  }

  // Run `fn` and send at most one state change for all it did.
  const held = fn => {
    holding += 1
    try {
      return fn()
    } finally {
      holding -= 1
      update()
    }
  }

  const sendSentence = sentence => {
    broadcast('sentence', { text: sentence })
    const spoken = speakable(sentence)
    if (spoken !== '') speaker.say(spoken)
  }

  const stopReply = () => {
    segmenter.reset()
    speaker.stop()
  }

  const speaker = createSpeaker({
    spawn,
    voice: sayVoice,
    enabled: sayAvailable,
    on: event => {
      if (event.type === 'error') {
        speechFailed = true
        broadcast('error', { message: event.message })
      }
      update()
    }
  })

  const engine = createEngine({
    spawn,
    cwd,
    env,
    model,
    prompt,
    turnMs: limits.voiceTurnSeconds * 1000,
    uuid,
    timers,
    on: event =>
      held(() => {
        switch (event.type) {
          case 'text':
            for (const sentence of segmenter.push(event.text)) sendSentence(sentence)
            break
          case 'flush':
            for (const sentence of segmenter.flush()) sendSentence(sentence)
            break
          case 'tool':
            broadcast('tool', { command: event.command })
            break
          case 'error':
            broadcast('error', { message: event.message })
            break
          case 'end':
            if (event.stopped) stopReply()
            else for (const sentence of segmenter.flush()) sendSentence(sentence)
            break
          case 'refused':
            if (refusedReason !== null) break
            refusedReason = event.reason
            stopReply()
            warn(`voice session refused: ${event.reason}`)
            break
        }
      })
  })

  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY, ...headers })
    res.end(JSON.stringify(body))
  }

  const clearCloseTimer = () => {
    if (closeTimer !== null) timers.clearTimeout(closeTimer)
    closeTimer = null
  }

  const stopKeepalive = () => {
    if (keepalive !== null) timers.clearInterval(keepalive)
    keepalive = null
  }

  const openStream = res => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...SECURITY })
    if (ending) {
      res.end(frame('bye', {}))
      return
    }
    clearCloseTimer()
    pages.add(res)
    res.write(frame('hello', { lang, model, speech: sayAvailable && !speechFailed }))
    res.write(frame('state', lastState))
    if (keepalive === null) {
      keepalive = timers.setInterval(() => {
        for (const page of pages) page.write(': keepalive\n\n')
      }, KEEPALIVE_MS)
    }
    res.on('close', () => {
      if (!pages.delete(res)) return
      if (pages.size > 0 || ending) return
      stopKeepalive()
      clearCloseTimer()
      closeTimer = timers.setTimeout(() => {
        closeTimer = null
        if (pages.size === 0) shutdown()
      }, limits.voiceCloseSeconds * 1000)
    })
  }

  // Read a body of at most `bodyLimit` bytes. → { ok: true, bytes } | { ok: false, tooLarge: true }
  const readBody = req =>
    new Promise(resolve => {
      const chunks = []
      let size = 0
      let over = false
      req.on('data', chunk => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buf.length
        if (size > bodyLimit) over = true
        if (!over) chunks.push(buf)
      })
      req.on('end', () => resolve(over ? { ok: false, tooLarge: true } : { ok: true, bytes: Buffer.concat(chunks) }))
      req.on('error', () => resolve({ ok: false, tooLarge: false }))
    })

  const tooLong = () => `turn longer than ${turnChars} characters`

  const takeTurn = async (req, res) => {
    const body = await readBody(req)
    if (!body.ok) {
      if (body.tooLarge) return reply(res, 413, { ok: false, reason: tooLong() })
      return reply(res, 400, { ok: false, reason: 'the turn could not be read' })
    }
    let parsed
    try {
      parsed = JSON.parse(strictUtf8.decode(body.bytes))
    } catch {
      parsed = undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.text !== 'string') {
      return reply(res, 400, { ok: false, reason: 'a turn is a JSON object with a text string' })
    }
    const text = parsed.text.trim()
    if (text === '') return reply(res, 400, { ok: false, reason: 'empty turn' })
    if ([...text].length > turnChars) return reply(res, 413, { ok: false, reason: tooLong() })
    if (refusedReason !== null || engine.refused) return reply(res, 409, { ok: false, reason: 'the session was refused' })
    if (engine.busy) return reply(res, 409, { ok: false, reason: 'a turn is running' })
    if (ending) return reply(res, 409, { ok: false, reason: 'dial voice is closing' })

    const accepted = held(() => {
      stopReply()
      const outcome = engine.turn(text)
      if (outcome.ok) broadcast('user', { text })
      return outcome
    })
    if (!accepted.ok) return reply(res, 409, { ok: false, reason: accepted.reason })
    return reply(res, 202, { ok: true })
  }

  const interrupt = res => {
    held(() => {
      stopReply()
      engine.stop()
    })
    reply(res, 200, { ok: true })
  }

  const handle = async (req, res) => {
    try {
      const check = checkRequest({ method: req.method, url: req.url, headers: req.headers }, { port, token })
      if (!check.ok) {
        req.resume?.()
        return reply(res, check.status, { ok: false, reason: check.reason })
      }
      const route = check.route
      if (STATIC[route]) {
        req.resume?.()
        res.writeHead(200, { 'content-type': STATIC[route].type, ...SECURITY })
        res.end(assets[STATIC[route].key])
        return
      }
      if (route === 'events') {
        req.resume?.()
        return openStream(res)
      }
      if (route === 'turn') return await takeTurn(req, res)
      // The bodies of interrupt and quit are not read.
      req.resume?.()
      if (route === 'interrupt') return interrupt(res)
      if (route === 'quit') {
        reply(res, 200, { ok: true })
        shutdown()
        return
      }
      return reply(res, 404, { ok: false, reason: 'not found' })
    } catch (err) {
      try {
        reply(res, 500, { ok: false, reason: err?.message ?? String(err) })
      } catch {
        // The response could not be written.
      }
    }
  }

  const openWindow = () => {
    const record = { handle: null, exited: false, killed: false, waiters: [] }
    opener = record
    record.handle = spawn('open', ['-na', 'Google Chrome', '--args', `--app=${address}`], {
      onLine() {},
      onExit({ code, stderr, error }) {
        record.exited = true
        for (const resolve of record.waiters.splice(0)) resolve()
        if (record.killed || ending) return
        let why = null
        if (error) why = `${error.code ?? 'error'}: ${error.message}`
        else if (code !== 0) why = firstLine(stderr) ?? `exit ${code}`
        if (why !== null) warn(`could not open Chrome (${why}); open the address above in Chrome`)
      }
    })
    record.handle.end()
  }

  const start = () => {
    if (started || ending) return
    started = true
    engine.start()
    if (platform === 'darwin' && !noOpen) openWindow()
  }

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    const bye = frame('bye', {})
    for (const res of pages) {
      res.write(bye)
      res.end()
    }
    ending = true
    pages.clear()
    stopKeepalive()
    clearCloseTimer()
    const waits = [speaker.shutdown(), engine.shutdown()]
    if (opener && !opener.exited) {
      const record = opener
      record.killed = true
      record.handle.kill()
      waits.push(new Promise(resolve => record.waiters.push(resolve)))
    }
    shutdownPromise = Promise.all(waits).then(() => {
      const code = refusedReason !== null || engine.refused ? 1 : 0
      resolveDone(code)
      return code
    })
    return shutdownPromise
  }

  return { handle, start, shutdown, done, address }
}

/**
 * Listen on 127.0.0.1 only. `close()` ends open connections, event streams
 * included, and resolves once the listener is closed.
 * → `Promise<{ ok: true, close() } | { ok: false, code, message }>`
 */
export function listenLoopback(handler, { port }) {
  return new Promise(resolve => {
    const server = createServer(handler)
    const onError = err => resolve({ ok: false, code: err.code ?? 'error', message: err.message })
    server.once('error', onError)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.off('error', onError)
      server.on('error', () => {})
      let closing = null
      resolve({
        ok: true,
        close() {
          if (closing) return closing
          closing = new Promise(done => {
            server.close(() => done())
            server.closeAllConnections()
          })
          return closing
        }
      })
    })
  })
}
