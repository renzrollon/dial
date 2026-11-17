import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { get as httpGet } from 'node:http'
import { connect as netConnect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createVoice, listenLoopback } from '../lib/voice/server.mjs'
import { fakeBinary, fakeSpawn, fakeTimers, tmp } from './helpers.mjs'

// Requirements of the `voice` delta ("voice runs in the foreground until it is
// closed", "voice prints its address and opens one window", "Every request is
// checked before it is served", "The page is served from the package under a
// strict policy", "A turn is text posted by a page", "One turn runs at a time",
// "Pages follow the conversation through one event stream", "A page that
// connects is told the settings and the state", "The state follows the
// session, the turn and the speech", "A sentence is shown as written and spoken
// in a plain form", "Without say, or after say fails, replies are only shown",
// "An interrupt stops speech and an unfinished turn") and of the `voice-engine`
// delta ("A command the session runs is shown and not spoken", "The turn ends
// with the session's result", "A refused session is ended and reported, and no
// other is started"). The server runs against plain request and response
// objects, `fakeSpawn` and `fakeTimers`: no socket, no browser, no `claude`.
//
// Choices this suite pins where design section 13 leaves a shape open:
//  - `assets` is `{ page, script, logic, style }`, four strings.
//  - `limits` is `{ voiceTurnSeconds, voiceCloseSeconds, voiceTurnChars }`, all three given.
//  - children are told apart by the base name of the file they run: `claude`, `say`, `open`.
//  - whether `say` is available is read from `env.PATH` (an executable named `say` in it).
//  - `warn` gets the line with or without the `dial: ` prefix; both are accepted.

const T = { timeout: 20_000 }
const PORT = 3425
const TOKEN = '0123456789abcdef'.repeat(2)
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://127.0.0.1:${PORT}`
const ADDRESS = `http://127.0.0.1:${PORT}/?t=${TOKEN}`
const CWD = '/tmp/dial-home/voice'
const PROMPT = 'You are Dial.\nSpeak in short sentences.'
const ASSETS = {
  page: '<!doctype html><title>dial voice PAGE</title>',
  script: '// page.js SCRIPT',
  logic: '// page-logic.mjs LOGIC',
  style: '/* page.css STYLE */'
}
const SAY_DIR = tmp('dial-voice-say-')
fakeBinary(SAY_DIR, 'say')
const NO_SAY_DIR = tmp('dial-voice-nosay-')
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"

// What the session writes, one JSON line each.
const J = JSON.stringify
const REPORT = { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [], permissionMode: 'dontAsk', session_id: '5b1f0c52-2a7e-4f0b-9d3e-6a1c8e4d7b90' }
const report = (extra = {}) => J({ ...REPORT, ...extra })
const delta = text => J({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const blockStop = () => J({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
const toolUse = command => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } })
const toolResult = () => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'secret output' }] } })
const result = (extra = {}) => J({ type: 'result', subtype: 'success', is_error: false, ...extra })

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

function withTimeout(promise, what, ms = 3000) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/** A response object with what the server may use: writeHead, write, end and a close event. */
function fakeRes() {
  const res = new EventEmitter()
  res.status = null
  res.headers = {}
  res.chunks = []
  res.ended = false
  res.closed = false
  res.finished = new Promise(resolve => {
    res.settleFinished = resolve
  })
  res.writeHead = (status, headers = {}) => {
    res.status = status
    for (const [key, value] of Object.entries(headers)) res.headers[key.toLowerCase()] = String(value)
    return res
  }
  res.write = chunk => {
    if (!res.ended) res.chunks.push(String(chunk))
    return true
  }
  res.end = chunk => {
    if (res.ended) return res
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk))
    res.ended = true
    res.settleFinished()
    queueMicrotask(() => res.disconnect())
    return res
  }
  // The other end went away, or the response is over: a real response emits `close` once.
  res.disconnect = () => {
    if (res.closed) return
    res.closed = true
    res.emit('close')
  }
  res.body = () => res.chunks.join('')
  res.json = () => JSON.parse(res.body())
  return res
}

/** A request: a readable stream with method, url and headers. `body` is a string, a Buffer or a list of them. */
function fakeReq({ method, url, headers = {}, body }) {
  const parts = body === undefined ? [] : Array.isArray(body) ? body : [body]
  const req = Readable.from(parts.map(part => (Buffer.isBuffer(part) ? part : Buffer.from(part))), { objectMode: false })
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

/** The events and comment lines of what an event stream carried. */
function parseStream(text) {
  const events = []
  const comments = []
  for (const block of text.split('\n\n')) {
    let name = null
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line)
      else if (line.startsWith('event: ')) name = line.slice('event: '.length)
      else if (line.startsWith('data: ')) data.push(line.slice('data: '.length))
    }
    if (name !== null) events.push({ event: name, data: JSON.parse(data.join('\n')) })
  }
  return { events, comments }
}

const noRepeats = states => {
  for (let i = 1; i < states.length; i++) assert.notDeepEqual(states[i], states[i - 1], `state repeated at ${i}: ${J(states)}`)
}

/** A voice server over fakes, with helpers to drive it as a page and as the session. */
function rig(opts = {}) {
  const { limits = {}, say = true, platform = 'linux', noOpen = true, lang = 'en-US', model = 'sonnet', sayVoice, port = PORT, token = TOKEN } = opts
  const { spawn, children } = fakeSpawn()
  const clock = fakeTimers()
  const warns = []
  let uuids = 0
  const voice = createVoice({
    port,
    token,
    lang,
    model,
    sayVoice,
    limits: { voiceTurnSeconds: 120, voiceCloseSeconds: 10, voiceTurnChars: 2000, ...limits },
    cwd: CWD,
    env: { PATH: say ? SAY_DIR : NO_SAY_DIR },
    prompt: PROMPT,
    assets: ASSETS,
    spawn,
    timers: clock.timers,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`,
    platform,
    noOpen,
    warn: line => warns.push(line)
  })
  let exitCode
  voice.done.then(code => {
    exitCode = code
  })
  const named = name => children.filter(child => basename(child.file) === name)
  const r = {
    voice,
    children,
    warns,
    claudes: () => named('claude'),
    says: () => named('say'),
    opens: () => named('open'),
    finished: () => exitCode !== undefined,
    exitCode: () => exitCode,
    async advance(ms) {
      clock.advance(ms)
      await settle()
    },
    async send(spec) {
      const req = fakeReq(spec)
      const res = fakeRes()
      await withTimeout(Promise.all([Promise.resolve(voice.handle(req, res)), res.finished]), `${spec.method} ${spec.url} did not finish`)
      await settle(1)
      return res
    },
    get(path, headers = {}) {
      return r.send({ method: 'GET', url: path, headers: { host: HOST, ...headers } })
    },
    post(path, body, headers = {}) {
      const merged = { host: HOST, 'x-dial-token': TOKEN, origin: ORIGIN, 'content-type': 'application/json', ...headers }
      for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
      const raw = body !== null && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body) ? J(body) : body
      return r.send({ method: 'POST', url: path, headers: merged, body: raw })
    },
    /** Connect a page to the event stream and return what it has received so far, live. */
    async connect(query = `?t=${TOKEN}`, headers = {}) {
      const req = fakeReq({ method: 'GET', url: `/events${query}`, headers: { host: HOST, ...headers } })
      const res = fakeRes()
      const handled = Promise.resolve(voice.handle(req, res))
      let failure
      handled.catch(err => {
        failure = err
      })
      await settle()
      if (failure) throw failure
      const view = {
        res,
        all: () => parseStream(res.body()),
        events: () => view.all().events,
        comments: () => view.all().comments,
        names: () => view.events().map(e => e.event),
        of: name => view.events().filter(e => e.event === name).map(e => e.data),
        states: () => view.of('state'),
        close: () => res.disconnect()
      }
      return view
    },
    async turn(text = 'hello') {
      const res = await r.post('/turn', { text })
      assert.equal(res.status, 202, `turn refused: ${res.body()}`)
      await settle()
      return res
    },
    /** Start the server and have the session report as asked for. */
    async up() {
      await voice.start()
      await settle()
      r.claudes()[0].line(report())
      await settle()
    },
    async drain() {
      for (let i = 0; i < 20 && !r.finished(); i++) {
        for (const child of children) if (child.killed && !child.exited) child.exit({ code: null, signal: 'SIGTERM' })
        await settle(2)
      }
    },
    async isRunning() {
      await settle()
      return !r.finished()
    }
  }
  return r
}

const sentences = page => page.of('sentence').map(d => d.text)

// ---------------------------------------------------------------------------
// voice: "voice runs in the foreground until it is closed"

test('shutdown sends bye, ends the say and claude children, and done is 0 only once they have exited', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('two repos?')
  r.claudes()[0].line(delta('Two are open. '))
  await settle()
  assert.equal(r.says().length, 1)

  const out = r.voice.shutdown()
  await settle()
  assert.equal(page.names().at(-1), 'bye')
  assert.equal(r.says()[0].killed, true)
  assert.equal(r.claudes()[0].killed, true)
  assert.equal(r.finished(), false, 'done must wait for the children to exit')

  await r.drain()
  assert.equal(await withTimeout(out, 'shutdown'), 0)
  assert.equal(await withTimeout(r.voice.done, 'done'), 0)
  assert.ok(r.children.every(child => child.exited))
  assert.deepEqual(r.warns, [])
})

test('shutdown sends bye to every connected page', T, async () => {
  const r = rig()
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  r.voice.shutdown()
  await settle()
  for (const page of [a, b]) assert.equal(page.names().filter(n => n === 'bye').length, 1)
  await r.drain()
  assert.equal(await r.voice.done, 0)
})

test('a quit request is answered 200 { ok: true }, and after it is sent the command ends 0', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const log = []
  r.voice.done.then(code => log.push(`done:${code}`))
  const res = await r.post('/quit', {})
  log.push('answered')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  await settle()
  assert.equal(page.names().at(-1), 'bye')
  assert.equal(r.claudes()[0].killed, true)
  await r.drain()
  assert.equal(await r.voice.done, 0)
  await settle()
  assert.deepEqual(log, ['answered', 'done:0'])
})

test('interrupt and quit do not read their body: {}, none and bytes that are not JSON are all answered 200', T, async () => {
  for (const body of ['{}', undefined, 'not json {', Buffer.from([0xff, 0xfe, 0x00])]) {
    const r = rig()
    await r.up()
    const interrupt = await r.post('/interrupt', body)
    assert.equal(interrupt.status, 200, `interrupt with ${J(body)}`)
    assert.deepEqual(interrupt.json(), { ok: true })
    const quit = await r.post('/quit', body)
    assert.equal(quit.status, 200, `quit with ${J(body)}`)
    assert.deepEqual(quit.json(), { ok: true })
    await r.drain()
    assert.equal(await r.voice.done, 0)
  }
})

test('the command ends 10 seconds after the last page disconnects, and not before', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  page.close()
  await r.advance(9999)
  assert.equal(await r.isRunning(), true)
  await r.advance(1)
  assert.equal(r.claudes()[0].killed, true)
  await r.drain()
  assert.equal(await r.voice.done, 0)
})

test('a page that connects again within the time keeps the command running and clears the timer', T, async () => {
  const r = rig()
  await r.up()
  const first = await r.connect()
  first.close()
  await r.advance(2000)
  const second = await r.connect()
  await r.advance(60_000)
  assert.equal(await r.isRunning(), true)
  assert.equal(r.claudes()[0].killed, false)
  second.close()
  await r.advance(9999)
  assert.equal(await r.isRunning(), true)
  await r.advance(1)
  await r.drain()
  assert.equal(await r.voice.done, 0)
})

test('with voiceCloseSeconds 3 the command ends 3 seconds after the disconnect and not 2', T, async () => {
  const r = rig({ limits: { voiceCloseSeconds: 3 } })
  await r.up()
  const page = await r.connect()
  page.close()
  await r.advance(2000)
  assert.equal(await r.isRunning(), true)
  await r.advance(1000)
  await r.drain()
  assert.equal(await r.voice.done, 0)
})

test('while one of two pages is still connected the close timer does not run', T, async () => {
  const r = rig()
  await r.up()
  const a = await r.connect()
  await r.connect()
  a.close()
  await r.advance(60_000)
  assert.equal(await r.isRunning(), true)
})

test('before the first page connects the command waits without a time limit', T, async () => {
  const r = rig({ limits: { voiceCloseSeconds: 3 } })
  await r.up()
  await r.advance(3_600_000)
  assert.equal(await r.isRunning(), true)
  assert.equal(r.claudes()[0].killed, false)
})

// ---------------------------------------------------------------------------
// voice-engine: the session's process is started with the server's settings

test('start runs one claude in the working directory with the environment, model and prompt it was given', T, async () => {
  const r = rig({ model: 'opus' })
  await r.voice.start()
  await settle()
  const claudes = r.claudes()
  assert.equal(claudes.length, 1)
  const [child] = claudes
  assert.equal(child.cwd, CWD)
  assert.equal(child.env.PATH, SAY_DIR)
  assert.equal(child.args[child.args.indexOf('--model') + 1], 'opus')
  assert.equal(child.args[child.args.indexOf('--append-system-prompt') + 1], PROMPT)
  assert.equal(child.args.at(-2), '--session-id')
  assert.match(child.args.at(-1), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

// ---------------------------------------------------------------------------
// voice: "voice prints its address and opens one window"

test('on darwin the window is opened once with the exact open arguments, after the session was started', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: false })
  await r.voice.start()
  await settle()
  assert.equal(r.opens().length, 1)
  assert.deepEqual(r.opens()[0].args, ['-na', 'Google Chrome', '--args', `--app=${ADDRESS}`])
  assert.ok(r.children.indexOf(r.claudes()[0]) < r.children.indexOf(r.opens()[0]), 'claude starts before the window opens')
  assert.deepEqual(r.warns, [])
})

test('no opener runs with noOpen, or on linux', T, async () => {
  for (const o of [{ platform: 'darwin', noOpen: true }, { platform: 'linux', noOpen: false }, { platform: 'linux', noOpen: true }]) {
    const r = rig(o)
    await r.voice.start()
    await settle()
    assert.equal(r.opens().length, 0, J(o))
    assert.equal(r.claudes().length, 1, J(o))
  }
})

test('a failed opener is one warning with the first stderr line, and the command keeps running', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: false })
  await r.up()
  r.opens()[0].exit({ code: 1, stderr: "Unable to find application named 'Google Chrome'\nsecond line\n" })
  await settle()
  assert.equal(r.warns.length, 1)
  assert.match(r.warns[0], /^(dial: )?could not open Chrome \(Unable to find application named 'Google Chrome'\); open the address above in Chrome$/)
  assert.equal(await r.isRunning(), true)
  assert.equal(r.claudes()[0].killed, false)
})

test('an opener that succeeds writes no warning', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: false })
  await r.up()
  r.opens()[0].exit({ code: 0 })
  await settle()
  assert.deepEqual(r.warns, [])
})

// ---------------------------------------------------------------------------
// voice: "Every request is checked before it is served"

test('a request the guard refuses is answered with its status and an { ok: false, reason } body', T, async () => {
  const r = rig()
  await r.up()
  const wrongHost = await r.get('/', { host: 'evil.example:3425' })
  assert.equal(wrongHost.status, 403)
  assert.deepEqual(wrongHost.json(), { ok: false, reason: 'wrong host' })
  const unknown = await r.get('/admin')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json().ok, false)
  assert.equal(typeof unknown.json().reason, 'string')
  const method = await r.send({ method: 'PUT', url: '/turn', headers: { host: HOST } })
  assert.equal(method.status, 405)
  assert.equal(method.json().ok, false)
  const form = await r.post('/turn', 'text=hi', { 'content-type': 'text/plain' })
  assert.equal(form.status, 415)
  assert.equal(form.json().ok, false)
})

test('a refused request reaches neither the session nor the speaker', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const claude = r.claudes()[0]

  const refused = [
    await r.post('/turn', { text: 'merge everything' }, { origin: 'https://example.com' }),
    await r.post('/turn', { text: 'merge everything' }, { 'x-dial-token': undefined }),
    await r.post('/turn', { text: 'merge everything' }, { 'x-dial-token': 'wrong' }),
    await r.post('/turn', { text: 'merge everything' }, { host: 'localhost:3425' }),
    await r.post('/turn', 'text=merge+everything', { 'content-type': 'text/plain' })
  ]
  assert.deepEqual(refused.map(res => res.status), [403, 403, 403, 403, 415])
  assert.equal(refused[1].json().reason, 'missing or wrong token')
  assert.deepEqual(claude.written, [])
  assert.equal(page.of('user').length, 0)
  assert.equal(r.says().length, 0)
  assert.deepEqual(page.states(), [{ state: 'idle' }])
})

test('a refused interrupt or quit stops nothing', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hello')
  const claude = r.claudes()[0]
  claude.line(delta('One. '))
  await settle()
  const interrupt = await r.post('/interrupt', {}, { origin: 'https://example.com' })
  const quit = await r.post('/quit', {}, { 'x-dial-token': 'wrong' })
  assert.equal(interrupt.status, 403)
  assert.equal(quit.status, 403)
  assert.equal(claude.killed, false)
  assert.equal(r.says()[0].killed, false)
  assert.equal(page.names().includes('bye'), false)
  assert.equal(await r.isRunning(), true)
})

test('an event stream request with a wrong token or host is answered 403 and joins nothing', T, async () => {
  const r = rig()
  await r.up()
  const noToken = await r.connect('')
  assert.equal(noToken.res.status, 403)
  assert.equal(noToken.names().length, 0)
  const wrongToken = await r.connect('?t=wrong')
  assert.equal(wrongToken.res.status, 403)
  const wrongHost = await r.connect(`?t=${TOKEN}`, { host: 'localhost:3425' })
  assert.equal(wrongHost.res.status, 403)
  assert.equal(wrongHost.names().length, 0)
  const good = await r.connect()
  await r.turn('hi')
  assert.equal(noToken.names().length + wrongToken.names().length + wrongHost.names().length, 0, 'a refused page receives no event')
  assert.ok(good.names().includes('user'))
})

// ---------------------------------------------------------------------------
// voice: "The page is served from the package under a strict policy"

test('the four paths are served from the assets with their content types and the four headers', T, async () => {
  const r = rig()
  await r.up()
  const cases = [
    ['/', 'page', /^text\/html; charset=utf-8$/],
    [`/?t=${TOKEN}`, 'page', /^text\/html; charset=utf-8$/],
    ['/page.js', 'script', /^(text|application)\/javascript\b/],
    ['/page-logic.mjs', 'logic', /^(text|application)\/javascript\b/],
    ['/page.css', 'style', /^text\/css\b/]
  ]
  for (const [path, key, type] of cases) {
    const res = await r.get(path)
    assert.equal(res.status, 200, path)
    assert.match(res.headers['content-type'], type, path)
    assert.equal(res.body(), ASSETS[key], path)
    assert.equal(res.headers['cache-control'], 'no-store', path)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path)
    assert.equal(res.headers['referrer-policy'], 'no-referrer', path)
    assert.equal(res.headers['content-security-policy'], CSP, path)
  }
})

test('the static files need the host and no token', T, async () => {
  const r = rig()
  await r.up()
  const res = await r.send({ method: 'GET', url: '/page.js', headers: { host: HOST } })
  assert.equal(res.status, 200)
  const wrong = await r.send({ method: 'GET', url: '/page.js', headers: { host: 'localhost:3425' } })
  assert.equal(wrong.status, 403)
})

// ---------------------------------------------------------------------------
// voice: "A turn is text posted by a page"

test('an accepted turn is trimmed, answered 202, sent to the pages and written to the session as one line', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const res = await r.post('/turn', { text: '  can I merge katipon?  ' })
  await settle()
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { ok: true })
  assert.deepEqual(page.of('user'), [{ text: 'can I merge katipon?' }])
  assert.deepEqual(r.claudes()[0].written, [`${J({ type: 'user', message: { role: 'user', content: 'can I merge katipon?' }, parent_tool_use_id: null })}\n`])
})

test('every connected page receives the user event', T, async () => {
  const r = rig()
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  await r.turn('hello there')
  assert.deepEqual(a.of('user'), [{ text: 'hello there' }])
  assert.deepEqual(b.of('user'), [{ text: 'hello there' }])
})

test('a turn with quotes and a line break reaches the session as one line that parses back to the text', T, async () => {
  const r = rig()
  await r.up()
  const text = 'say "hi"\nthen go'
  await r.turn(text)
  const written = r.claudes()[0].written.join('')
  assert.equal(written.endsWith('\n'), true)
  assert.equal(written.slice(0, -1).includes('\n'), false)
  assert.equal(JSON.parse(written).message.content, text)
})

test('a body split across chunks, even inside a multi-byte character, is read whole', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const bytes = Buffer.from(J({ text: 'café ☕ ok' }))
  const cut = bytes.indexOf(0xc3) + 1
  const res = await r.post('/turn', [bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.equal(res.status, 202)
  await settle()
  assert.deepEqual(page.of('user'), [{ text: 'café ☕ ok' }])
})

test('a blank turn is 400 empty turn, with no user event and nothing written', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const res = await r.post('/turn', { text: '   ' })
  assert.equal(res.status, 400)
  assert.deepEqual(res.json(), { ok: false, reason: 'empty turn' })
  assert.equal(page.of('user').length, 0)
  assert.deepEqual(r.claudes()[0].written, [])
})

test('a turn of 2001 characters is 413 when voiceTurnChars is 2000', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const res = await r.post('/turn', { text: 'a'.repeat(2001) })
  assert.equal(res.status, 413)
  assert.deepEqual(res.json(), { ok: false, reason: 'turn longer than 2000 characters' })
  assert.equal(page.of('user').length, 0)
  assert.deepEqual(r.claudes()[0].written, [])
  const ok = await r.post('/turn', { text: 'a'.repeat(2000) })
  assert.equal(ok.status, 202)
})

test('the turn length is read from the limits: 500 characters is 202 and 501 is 413', T, async () => {
  const r = rig({ limits: { voiceTurnChars: 500 } })
  await r.up()
  const page = await r.connect()
  const over = await r.post('/turn', { text: 'b'.repeat(501) })
  assert.equal(over.status, 413)
  assert.deepEqual(over.json(), { ok: false, reason: 'turn longer than 500 characters' })
  assert.equal(page.of('user').length, 0)
  const at = await r.post('/turn', { text: 'b'.repeat(500) })
  assert.equal(at.status, 202)
  await settle()
  assert.equal(page.of('user').length, 1)
})

test('a body larger than 6 x voiceTurnChars + 1024 bytes is answered 413 with the same reason and nothing is written', T, async () => {
  const r = rig({ limits: { voiceTurnChars: 100 } })
  await r.up()
  const page = await r.connect()
  const big = await r.post('/turn', { text: 'a'.repeat(2000) })
  assert.equal(big.status, 413)
  assert.deepEqual(big.json(), { ok: false, reason: 'turn longer than 100 characters' })
  const chunks = Array.from({ length: 6 }, () => 'a'.repeat(500))
  const split = await r.post('/turn', chunks)
  assert.equal(split.status, 413)
  assert.equal(split.json().reason, 'turn longer than 100 characters')
  assert.equal(page.of('user').length, 0)
  assert.deepEqual(r.claudes()[0].written, [])
})

test('a turn at the character cap whose JSON escapes every character still fits the body limit', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const text = 'a' + '\u0001'.repeat(1998) + 'z'
  const body = J({ text })
  assert.ok(Buffer.byteLength(body) > 4 * 2000 + 1024)
  const res = await r.post('/turn', body)
  assert.equal(res.status, 202)
  await settle()
  assert.equal(page.of('user').length, 1)
})

test('a body that is not a turn is 400 and nothing is written to the session', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const bodies = ['[]', J({ text: 5 }), 'not json {', Buffer.from([0xff, 0xfe, 0x00]), '', '{}', 'null', '"text"', J({ text: null })]
  for (const body of bodies) {
    const res = await r.post('/turn', body)
    assert.equal(res.status, 400, `body ${J(String(body))}`)
    assert.equal(res.json().ok, false)
  }
  assert.equal(page.of('user').length, 0)
  assert.deepEqual(r.claudes()[0].written, [])
})

// ---------------------------------------------------------------------------
// voice: "One turn runs at a time"

test('a second turn during the first is 409 a turn is running and the first is not disturbed', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('first')
  const claude = r.claudes()[0]
  claude.line(delta('Working on it'))
  await settle()
  const res = await r.post('/turn', { text: 'second' })
  assert.equal(res.status, 409)
  assert.deepEqual(res.json(), { ok: false, reason: 'a turn is running' })
  assert.equal(claude.written.length, 1)
  assert.equal(claude.killed, false)
  assert.deepEqual(page.of('user'), [{ text: 'first' }])
  assert.deepEqual(page.states().at(-1), { state: 'thinking' })
})

test('a turn over the end of a spoken reply stops the speech, drops what waits and is accepted', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('first')
  const claude = r.claudes()[0]
  claude.line(delta('One. '))
  claude.line(delta('Two. '))
  claude.line(delta('Three.'))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  assert.equal(r.says().length, 1, 'only the first sentence is being spoken, two wait')
  assert.deepEqual(page.states().at(-1), { state: 'speaking' })

  const res = await r.post('/turn', { text: 'second' })
  assert.equal(res.status, 202)
  await settle()
  const say = r.says()[0]
  assert.equal(say.killed, true)
  say.exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(r.says().length, 1, 'the waiting sentences were discarded')
  assert.equal(claude.written.length, 2)
  assert.equal(JSON.parse(claude.written[1]).message.content, 'second')
  const events = page.events()
  const afterUser = events.slice(events.map(e => e.event).lastIndexOf('user') + 1).filter(e => e.event === 'state')
  assert.equal(afterUser.some(e => e.data.state === 'idle'), false, 'an accepted turn is not followed by idle')
  assert.deepEqual(page.states().at(-1), { state: 'thinking' })
})

test('a turn after the session was refused is 409 the session was refused, with no user event', T, async () => {
  const r = rig()
  await r.voice.start()
  await settle()
  const page = await r.connect()
  r.claudes()[0].line(report({ tools: ['Bash', 'Read'] }))
  await settle()
  const res = await r.post('/turn', { text: 'hello' })
  assert.equal(res.status, 409)
  assert.deepEqual(res.json(), { ok: false, reason: 'the session was refused' })
  assert.equal(page.of('user').length, 0)
  assert.deepEqual(r.claudes()[0].written, [])
  r.claudes()[0].exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(r.claudes().length, 1, 'no second session is started')
})

// ---------------------------------------------------------------------------
// voice: "Pages follow the conversation through one event stream"

test('the event stream answers text/event-stream', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  assert.equal(page.res.status, 200)
  assert.match(page.res.headers['content-type'], /^text\/event-stream/)
  assert.equal(page.res.ended, false)
})

test('two pages see the same sentence event', T, async () => {
  const r = rig()
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(delta('Two are open. '))
  await settle()
  assert.deepEqual(a.of('sentence'), [{ text: 'Two are open.' }])
  assert.deepEqual(b.of('sentence'), [{ text: 'Two are open.' }])
})

test('an event is an event line, a data line of one JSON object and a blank line', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(delta('Two are open. '))
  await settle()
  assert.ok(page.res.body().includes('event: sentence\ndata: {"text":"Two are open."}\n\n'), page.res.body())
})

test('a comment line is sent to every connected page every 15 seconds and not before', T, async () => {
  const r = rig()
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  await r.advance(14_999)
  assert.equal(a.comments().length, 0)
  await r.advance(1)
  for (const page of [a, b]) {
    assert.equal(page.comments().length, 1)
    assert.match(page.comments()[0], /^:/)
  }
  await r.advance(15_000)
  assert.equal(a.comments().length, 2)
  assert.equal(b.comments().length, 2)
  assert.equal(a.names().filter(n => n !== 'hello' && n !== 'state').length, 0, 'a keepalive is not an event')
})

// ---------------------------------------------------------------------------
// voice: "A page that connects is told the settings and the state"

test('the first two events are hello with the settings and state', T, async () => {
  const r = rig({ lang: 'en-GB', model: 'opus' })
  await r.up()
  const page = await r.connect()
  assert.deepEqual(page.names(), ['hello', 'state'])
  assert.deepEqual(page.of('hello'), [{ lang: 'en-GB', model: 'opus', speech: true }])
  assert.deepEqual(page.states(), [{ state: 'idle' }])
})

test('without say on PATH hello carries speech false', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  assert.deepEqual(page.of('hello'), [{ lang: 'en-US', model: 'sonnet', speech: false }])
})

test('a page that connects late gets hello, the current state, and only events sent after it connected', T, async () => {
  const r = rig()
  await r.up()
  const early = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(delta('Earlier sentence. '))
  await settle()
  assert.deepEqual(early.states().at(-1), { state: 'speaking' })

  const late = await r.connect()
  assert.deepEqual(late.names(), ['hello', 'state'])
  assert.deepEqual(late.states(), [{ state: 'speaking' }])
  r.claudes()[0].line(delta('Later sentence. '))
  await settle()
  assert.deepEqual(late.of('sentence'), [{ text: 'Later sentence.' }])
  assert.deepEqual(late.of('user'), [])
  assert.deepEqual(sentences(early), ['Earlier sentence.', 'Later sentence.'])
})

// ---------------------------------------------------------------------------
// voice: "The state follows the session, the turn and the speech"

test('a spoken reply gives thinking, speaking and idle, idle only after the second say has exited', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('what is open?')
  const claude = r.claudes()[0]
  claude.line(delta('Two are open. '))
  claude.line(delta('One can merge.'))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  assert.deepEqual(page.states(), [{ state: 'idle' }, { state: 'thinking' }, { state: 'speaking' }])
  assert.equal(r.says().length, 1)
  r.says()[0].exit()
  await settle()
  assert.equal(r.says().length, 2)
  assert.deepEqual(page.states().at(-1), { state: 'speaking' })
  r.says()[1].exit()
  await settle()
  assert.deepEqual(page.states(), [{ state: 'idle' }, { state: 'thinking' }, { state: 'speaking' }, { state: 'idle' }])
  noRepeats(page.states())
})

test('a reply that is only shown goes thinking then idle and never speaking', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('Two are open. '))
  claude.line(delta('One can merge.'))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  assert.deepEqual(page.states(), [{ state: 'idle' }, { state: 'thinking' }, { state: 'idle' }])
  assert.deepEqual(sentences(page), ['Two are open.', 'One can merge.'])
  assert.equal(r.says().length, 0)
})

test('a turn that ends at once still goes through thinking, and no state repeats', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(result())
  await settle()
  assert.deepEqual(page.states(), [{ state: 'idle' }, { state: 'thinking' }, { state: 'idle' }])
  noRepeats(page.states())
})

test('a command between two sentences: speaking, thinking until the second arrives, speaking again', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('can I merge katipon?')
  const claude = r.claudes()[0]
  claude.line(delta('Let me check. '))
  await settle()
  claude.line(toolUse('dial sync katipon --remote --json'))
  await settle()
  assert.deepEqual(page.states().at(-1), { state: 'speaking' })
  r.says()[0].exit()
  await settle()
  assert.deepEqual(page.states().at(-1), { state: 'thinking' })
  claude.line(toolResult())
  claude.line(delta('Number 41 can merge. '))
  await settle()
  assert.deepEqual(page.states().at(-1), { state: 'speaking' })
  claude.line(result())
  await settle()
  r.says()[1].exit()
  await settle()
  assert.deepEqual(page.states(), [
    { state: 'idle' },
    { state: 'thinking' },
    { state: 'speaking' },
    { state: 'thinking' },
    { state: 'speaking' },
    { state: 'idle' }
  ])
})

test('the state payloads are exact: reason only on refused', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(report({ mcp_servers: [{ name: 'github', status: 'connected' }] }))
  await settle()
  assert.deepEqual(page.states(), [
    { state: 'idle' },
    { state: 'thinking' },
    { state: 'refused', reason: 'it has MCP servers: github' }
  ])
  for (const s of page.states().slice(0, 2)) assert.equal('reason' in s, false)
})

// ---------------------------------------------------------------------------
// voice: "A sentence is shown as written and spoken in a plain form"

test('a sentence reaches the pages as written and say in its spoken form', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('status?')
  r.claudes()[0].line(delta('**Number 41** is `ready`, needs_me is false. '))
  await settle()
  assert.deepEqual(page.of('sentence'), [{ text: '**Number 41** is `ready`, needs_me is false.' }])
  assert.equal(r.says().length, 1)
  assert.equal(r.says()[0].written.join(''), 'Number 41 is ready, needs me is false.')
})

test('a sentence with nothing to say is shown and no say process is started for it', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('---'))
  claude.line(blockStop())
  claude.line(delta('```'))
  claude.line(blockStop())
  await settle()
  assert.deepEqual(sentences(page), ['---', '```'])
  assert.equal(r.says().length, 0)
  assert.deepEqual(page.states().at(-1), { state: 'thinking' })
})

test('say is started with no argument by default and with -v and the name when one was given', T, async () => {
  const plain = rig()
  await plain.up()
  await plain.turn('hi')
  plain.claudes()[0].line(delta('Hello there. '))
  await settle()
  assert.deepEqual(plain.says()[0].args, [])

  const named = rig({ sayVoice: 'Zoe (Premium)' })
  await named.up()
  await named.turn('hi')
  named.claudes()[0].line(delta('Hello there. '))
  await settle()
  assert.deepEqual(named.says()[0].args, ['-v', 'Zoe (Premium)'])
  assert.equal(named.says()[0].written.join(''), 'Hello there.')
})

test('without say, sentences are shown and no process is started to speak', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(delta('Two are open. '))
  await settle()
  assert.deepEqual(sentences(page), ['Two are open.'])
  assert.equal(r.says().length, 0)
  assert.equal(page.of('error').length, 0)
})

// ---------------------------------------------------------------------------
// voice: "Without say, or after say fails, replies are only shown"

test('a say that fails sends one error with its first stderr line and nothing is spoken afterwards', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('Voice test. '))
  await settle()
  r.says()[0].exit({ code: 1, stderr: "Voice `Nobody' not found.\nsecond line\n" })
  await settle()
  assert.deepEqual(page.of('error'), [{ message: "Voice `Nobody' not found." }])
  claude.line(delta('Next one. '))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  assert.deepEqual(sentences(page), ['Voice test.', 'Next one.'])
  assert.equal(r.says().length, 1, 'nothing is spoken for the rest of the run')
  assert.equal(page.of('error').length, 1)
})

test('a say that was stopped is not a failure and the next reply is spoken', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('first')
  const claude = r.claudes()[0]
  claude.line(delta('One. '))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  const stopped = await r.post('/interrupt', {})
  assert.equal(stopped.status, 200)
  r.says()[0].exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(page.of('error').length, 0)
  await r.turn('second')
  claude.line(delta('Two. '))
  await settle()
  assert.equal(r.says().length, 2)
  assert.equal(r.says()[1].written.join(''), 'Two.')
  assert.equal(page.of('error').length, 0)
})

// ---------------------------------------------------------------------------
// voice: "An interrupt stops speech and an unfinished turn"

test('an interrupt after the turn has ended stops speech, leaves the process running and the state becomes idle', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('One. '))
  claude.line(delta('Two.'))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  const res = await r.post('/interrupt', {})
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(r.says()[0].killed, true)
  r.says()[0].exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(r.says().length, 1, 'the waiting sentence is not spoken')
  assert.equal(claude.killed, false)
  assert.equal(r.claudes().length, 1)
  assert.deepEqual(page.states().at(-1), { state: 'idle' })
  noRepeats(page.states())
})

test('an interrupt during a turn ends the turn, late text reaches no page and the state becomes idle', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('First one. '))
  claude.line(delta('Second unfin'))
  await settle()
  const say = r.says()[0]
  assert.deepEqual(sentences(page), ['First one.'])

  const res = await r.post('/interrupt', {})
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(say.killed, true)
  assert.equal(claude.killed, true)

  claude.line(delta('ished sentence. '))
  claude.line(delta('And a third.'))
  claude.line(blockStop())
  claude.line(result())
  await settle()
  assert.deepEqual(sentences(page), ['First one.'], 'text the stopped session writes afterwards reaches no page')

  say.exit({ code: null, signal: 'SIGTERM' })
  claude.exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.deepEqual(page.states().at(-1), { state: 'idle' })
  assert.equal(r.says().length, 1)
  assert.equal(page.of('error').length, 0)
  noRepeats(page.states())
  assert.equal(r.claudes().length, 2, 'the conversation is resumed after the old process exited')
  assert.ok(r.claudes()[1].args.includes('--resume'))
})

test('an interrupt with nothing to stop is answered 200 and sends no event', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  const before = page.events().length
  const res = await r.post('/interrupt', {})
  await settle()
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(page.events().length, before)
  assert.equal(r.claudes()[0].killed, false)
  assert.equal(r.says().length, 0)
})

// ---------------------------------------------------------------------------
// voice-engine: "A command the session runs is shown and not spoken"

test('a command is sent to every page as a tool event and never spoken, and its output is not shown', T, async () => {
  const r = rig()
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  await r.turn('can I merge katipon?')
  const claude = r.claudes()[0]
  claude.line(toolUse('dial context katipon --json'))
  await settle()
  for (const page of [a, b]) assert.deepEqual(page.of('tool'), [{ command: 'dial context katipon --json' }])
  assert.equal(r.says().length, 0)

  const before = a.events().length
  claude.line(toolResult())
  await settle()
  assert.equal(a.events().length, before)
  assert.equal(r.says().length, 0)
})

// ---------------------------------------------------------------------------
// voice-engine: "The turn ends with the session's result"

test('a result that succeeds sends no error and a new turn is accepted', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('Done'))
  claude.line(result())
  await settle()
  assert.deepEqual(sentences(page), ['Done'])
  assert.equal(page.of('error').length, 0)
  const again = await r.post('/turn', { text: 'again' })
  assert.equal(again.status, 202)
})

test('a failed turn sends one error with the subtype, after the waiting text, unspoken, and a new turn is accepted', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  const claude = r.claudes()[0]
  claude.line(delta('Almost'))
  claude.line(J({ type: 'result', subtype: 'error_during_execution', is_error: true }))
  await settle()
  assert.deepEqual(page.events().filter(e => e.event === 'sentence' || e.event === 'error').map(e => e.event), ['sentence', 'error'])
  assert.deepEqual(page.of('error'), [{ message: 'the turn failed: error_during_execution' }])
  assert.deepEqual(sentences(page), ['Almost'])
  assert.equal(r.says().length, 1, 'only the sentence is spoken, the error is not')
  r.says()[0].exit()
  await settle()
  assert.deepEqual(page.states().at(-1), { state: 'idle' })
  const again = await r.post('/turn', { text: 'again' })
  assert.equal(again.status, 202)
})

test('a failure with its own text carries it in the error message', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(J({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' }))
  await settle()
  assert.deepEqual(page.of('error'), [{ message: 'the turn failed: Credit balance is too low' }])
})

test('a turn that hangs is stopped after voiceTurnSeconds with one error, and the state becomes idle', T, async () => {
  const r = rig({ say: false, limits: { voiceTurnSeconds: 30 } })
  await r.up()
  const page = await r.connect()
  await r.turn('hi')
  await r.advance(29_999)
  assert.equal(page.of('error').length, 0)
  await r.advance(1)
  assert.deepEqual(page.of('error'), [{ message: 'the turn was stopped after 30 seconds' }])
  assert.equal(r.claudes()[0].killed, true)
  assert.deepEqual(page.states().at(-1), { state: 'idle' })
})

// ---------------------------------------------------------------------------
// voice-engine: "A refused session is ended and reported, and no other is started" (the page side)

test('a refused session reaches present and later pages, is warned once and ends 1', T, async () => {
  const r = rig()
  await r.voice.start()
  await settle()
  const present = await r.connect()
  const claude = r.claudes()[0]
  claude.line(report({ tools: ['Bash', 'Read'] }))
  await settle()
  const refused = { state: 'refused', reason: 'it has tools other than Bash: Read' }
  assert.deepEqual(present.states(), [{ state: 'idle' }, refused])
  assert.equal(claude.killed, true)
  assert.equal(r.warns.length, 1)
  assert.match(r.warns[0], /^(dial: )?voice session refused: it has tools other than Bash: Read$/)

  const later = await r.connect()
  assert.deepEqual(later.names(), ['hello', 'state'])
  assert.deepEqual(later.states(), [refused])

  claude.exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(r.claudes().length, 1, 'claude is not started again')
  assert.equal(await r.isRunning(), true, 'the command keeps serving its pages')

  const out = r.voice.shutdown()
  await r.drain()
  assert.equal(await withTimeout(out, 'shutdown'), 1)
  assert.equal(await r.voice.done, 1)
  assert.equal(r.warns.length, 1, 'no second failure line')
})

test('a session that ends before its start report is refused with its first stderr line', T, async () => {
  const r = rig()
  await r.voice.start()
  await settle()
  const page = await r.connect()
  r.claudes()[0].exit({ code: 1, stderr: '\nInvalid API key · Please run /login\nmore\n' })
  await settle()
  const reason = 'claude exited before it started (exit 1): Invalid API key · Please run /login'
  assert.deepEqual(page.states().at(-1), { state: 'refused', reason })
  assert.equal(r.warns.length, 1)
  assert.match(r.warns[0], /^(dial: )?voice session refused: claude exited before it started \(exit 1\): Invalid API key · Please run \/login$/)
  assert.equal(r.claudes().length, 1)
})

test('text that arrives before the start report refuses the session and is neither shown nor spoken', T, async () => {
  const r = rig()
  await r.voice.start()
  await settle()
  const page = await r.connect()
  await r.turn('hi')
  r.claudes()[0].line(delta('Hello there. '))
  await settle()
  assert.deepEqual(page.states().at(-1), { state: 'refused', reason: 'it answered before it reported how it started' })
  assert.equal(page.of('sentence').length, 0)
  assert.equal(r.says().length, 0)
  assert.equal(r.claudes()[0].killed, true)
})

test('a refused session ended by a quit request exits 1', T, async () => {
  const r = rig()
  await r.voice.start()
  await settle()
  r.claudes()[0].line(report({ permissionMode: 'default' }))
  await settle()
  const res = await r.post('/quit', {})
  assert.equal(res.status, 200)
  await r.drain()
  assert.equal(await r.voice.done, 1)
  assert.equal(r.warns.length, 1)
  assert.match(r.warns[0], /voice session refused: its permission mode is default, not dontAsk$/)
})

// ---------------------------------------------------------------------------
// voice: "The listener binds loopback on one port": `listenLoopback`, on a real socket
// where one may be bound (skipped where the bind is refused with EPERM).

const BINDING_REFUSED = 'binding is refused here (EPERM)'

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function pickPort(t) {
  try {
    return await freePort()
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip(BINDING_REFUSED)
      return null
    }
    throw err
  }
}

const hello = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('hello')
}

function fetchText(port, path = '/', host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host, port, path, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
  })
}

test('listenLoopback binds 127.0.0.1 and no other address', T, async t => {
  const port = await pickPort(t)
  if (port === null) return
  const listener = await listenLoopback(hello, { port })
  if (!listener.ok && listener.code === 'EPERM') return t.skip(BINDING_REFUSED)
  assert.equal(listener.ok, true, J(listener))
  try {
    const reply = await withTimeout(fetchText(port), 'GET on loopback')
    assert.deepEqual(reply, { status: 200, body: 'hello' })
    const external = Object.values(networkInterfaces())
      .flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)
    if (external) {
      const code = await withTimeout(
        new Promise(resolve => {
          const socket = netConnect({ host: external.address, port })
          socket.once('connect', () => {
            socket.destroy()
            resolve('connected')
          })
          socket.once('error', err => resolve(err.code))
        }),
        'connect on the external address'
      )
      assert.equal(code, 'ECONNREFUSED', `${external.address} must not reach the listener`)
    }
  } finally {
    await withTimeout(listener.close(), 'close')
  }
})

test('a second bind of the same port answers { ok: false, code: EADDRINUSE }', T, async t => {
  const port = await pickPort(t)
  if (port === null) return
  const first = await listenLoopback(hello, { port })
  if (!first.ok && first.code === 'EPERM') return t.skip(BINDING_REFUSED)
  assert.equal(first.ok, true, J(first))
  try {
    const second = await listenLoopback(hello, { port })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'EADDRINUSE')
    assert.equal(typeof second.message, 'string')
  } finally {
    await withTimeout(first.close(), 'close')
  }
})

test('closing the listener ends the event streams that are open', T, async t => {
  const port = await pickPort(t)
  if (port === null) return
  const stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': open\n\n')
  }
  const listener = await listenLoopback(stream, { port })
  if (!listener.ok && listener.code === 'EPERM') return t.skip(BINDING_REFUSED)
  assert.equal(listener.ok, true, J(listener))
  let ended
  const gone = new Promise(resolve => {
    ended = resolve
  })
  const req = httpGet({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
    res.on('data', () => {})
    res.on('end', () => ended('end'))
    res.on('close', () => ended('close'))
    res.on('error', () => ended('error'))
  })
  req.on('error', () => ended('error'))
  try {
    await withTimeout(new Promise(resolve => setTimeout(resolve, 100)), 'let the stream open')
    await withTimeout(listener.close(), 'close must not wait for an open event stream')
    await withTimeout(gone, 'the stream must end')
  } finally {
    req.destroy()
  }
})
