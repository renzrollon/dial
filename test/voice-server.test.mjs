import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { connect as netConnect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createVoice, listenLoopback, loadVoiceFiles } from '../lib/voice/server.mjs'
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
// The add-voice-orchestrator change adds, at the end of this file, the requirements of the `voice-sessions`
// delta the server joins (proposals, the reading, confirm and cancel, the bounds, the list, notices, the log,
// stop and attach routes, the bounded claude calls), "Two pages see the same proposal and the same list" of
// the `voice` delta and "A proposal is read from the result of dial propose" of the `voice-engine` delta.
// The add-voice-stage-and-capture change adds "The scripts of the stage" of the `voice` delta near the other static
// files, and, in the proposal section, "An open proposal's event says how long it has left" of the `voice-sessions` delta.
// The rig answers `claude agents` by itself with a canned list (`agents`), so a test that is not about the
// list needs nothing from it; `{ agents: 'manual' }` leaves each read to the test. The session calls
// (`--bg`, `agents`, `logs`, `stop`) are told apart from the voice session by their first argument, and
// `claudes()` holds the voice session's processes only.
//
// Choices this suite pins where design section 13 leaves a shape open:
//  - `assets` is `{ page, script, logic, style }`, four strings; add-voice-stage-and-capture adds `gears`, `scene` and `stage`,
//    seven strings, each served at `/<name>.mjs`.
//  - `now` (milliseconds, `Date.now` when not given) is the clock the proposals count their time left on; the rig gives
//    `fakeTimers`' `now`, so it moves with `advance`.
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
  gears: '// gears.mjs GEARS',
  scene: '// scene.mjs SCENE',
  stage: '// stage.mjs STAGE',
  style: '/* page.css STYLE */'
}
const CLAUDE_PATH = '/opt/homebrew/bin/claude'
const TMP_DIR = '/tmp/dial-voice-tmp'
const SESSION_CALLS = ['--bg', 'agents', 'logs', 'stop']
const REGISTRY = {
  dial_schema: 'dial.registry/1',
  vaults: { work: '/vaults/work' },
  repos: ['katipon', 'dial', 'parser', 'escapement'].map(name => ({ path: `/repos/${name}`, vault: 'work', host: 'github' })),
  limits: {}
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
  const { limits = {}, say = true, platform = 'linux', noOpen = true, lang = 'en-US', model = 'sonnet', sayVoice, port = PORT, token = TOKEN, agents = [] } = opts
  const base = fakeSpawn()
  const { children } = base
  const manual = agents === 'manual'
  // What `claude agents --json --all` prints: set with `r.agents(list)`; a read ends by itself unless the rig is manual.
  const answer = { text: manual ? '[]' : J(agents) }
  const spawn = (file, args = [], options = {}) => {
    const handle = base.spawn(file, args, options)
    if (basename(file) === 'claude' && args[0] === 'agents' && !manual) {
      const child = children.at(-1)
      queueMicrotask(() => {
        child.line(answer.text)
        child.exit({ code: 0 })
      })
    }
    return handle
  }
  const clock = fakeTimers()
  const holder = { registry: opts.registry === undefined ? REGISTRY : opts.registry }
  const writes = []
  const warns = []
  let uuids = 0
  const voice = createVoice({
    port,
    token,
    lang,
    model,
    sayVoice,
    limits: {
      voiceTurnSeconds: 120,
      voiceCloseSeconds: 10,
      voiceTurnChars: 2000,
      subprocessTimeoutSeconds: 10,
      voiceSessions: 3,
      voiceSessionPollSeconds: 5,
      voiceSessionRows: 12,
      voiceLogLines: 200,
      voiceProposalSeconds: 120,
      ...limits
    },
    cwd: CWD,
    env: { PATH: say ? SAY_DIR : NO_SAY_DIR },
    prompt: PROMPT,
    assets: ASSETS,
    spawn,
    timers: clock.timers,
    now: clock.now,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`,
    platform,
    noOpen,
    warn: line => warns.push(line),
    registry: () => holder.registry,
    claudePath: CLAUDE_PATH,
    tmpdir: TMP_DIR,
    writeFile: (...args) => {
      writes.push(args)
    }
  })
  let exitCode
  voice.done.then(code => {
    exitCode = code
  })
  const named = name => children.filter(child => basename(child.file) === name)
  const isCall = child => SESSION_CALLS.includes(child.args[0])
  const calls = sub => named('claude').filter(child => child.args[0] === sub)
  const r = {
    voice,
    children,
    warns,
    writes,
    claudes: () => named('claude').filter(child => !isCall(child)),
    starts: () => calls('--bg'),
    reads: () => calls('agents'),
    logs: () => calls('logs'),
    stops: () => calls('stop'),
    says: () => named('say'),
    opens: () => named('open'),
    attaches: () => named('open').filter(child => child.args.length === 1),
    /** The list the next `claude agents` read prints (a rig that is not manual answers it by itself). */
    agents(list) {
      answer.text = J(list)
    },
    /** The registry `registry()` returns from now on (null is a registry that cannot be read). */
    setRegistry(next) {
      holder.registry = next
    },
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

// Re-pinned for add-voice-stage-and-capture, voice: "The page is served from the package under a strict policy" (four
// served paths and the page became seven: the page, the five scripts and the style).
test('the seven paths are served from the assets with their content types and the four headers', T, async () => {
  const r = rig()
  await r.up()
  const cases = [
    ['/', 'page', /^text\/html; charset=utf-8$/],
    [`/?t=${TOKEN}`, 'page', /^text\/html; charset=utf-8$/],
    ['/page.js', 'script', /^(text|application)\/javascript\b/],
    ['/page-logic.mjs', 'logic', /^(text|application)\/javascript\b/],
    ['/gears.mjs', 'gears', /^(text|application)\/javascript\b/],
    ['/scene.mjs', 'scene', /^(text|application)\/javascript\b/],
    ['/stage.mjs', 'stage', /^(text|application)\/javascript\b/],
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

// voice: "The scripts of the stage": 200, `text/javascript; charset=utf-8`, the four headers and the bytes of the shipped
// file, with the right Host and no token.
test('the scripts of the stage answer 200 text/javascript; charset=utf-8 with the four headers, the assets and no token', T, async () => {
  const r = rig()
  await r.up()
  for (const name of ['gears', 'scene', 'stage']) {
    const res = await r.send({ method: 'GET', url: `/${name}.mjs`, headers: { host: HOST } })
    assert.equal(res.status, 200, name)
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8', name)
    assert.equal(res.body(), ASSETS[name], name)
    assert.equal(res.headers['cache-control'], 'no-store', name)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', name)
    assert.equal(res.headers['referrer-policy'], 'no-referrer', name)
    assert.equal(res.headers['content-security-policy'], CSP, name)
    const wrong = await r.send({ method: 'GET', url: `/${name}.mjs`, headers: { host: 'localhost:3425' } })
    assert.equal(wrong.status, 403, `${name} with another host`)
    const posted = await r.post(`/${name}.mjs`, {})
    assert.equal(posted.status, 405, `${name} by POST`)
  }
})

// voice: "The scripts of the stage": "the bytes of the shipped file". The loader reads the three files beside the others.
test('loadVoiceFiles reads gears.mjs, scene.mjs and stage.mjs from the package as the assets gears, scene and stage', () => {
  const out = loadVoiceFiles()
  assert.equal(out.ok, true, out.reason)
  for (const name of ['gears', 'scene', 'stage']) {
    assert.equal(out.assets[name], readFileSync(new URL(`../lib/voice/${name}.mjs`, import.meta.url), 'utf8'), name)
  }
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
  // Re-pinned for add-voice-orchestrator, voice-sessions: "A page that connects is sent the list and the open proposal"
  // (the `sessions` event a connecting page receives is not a keepalive either).
  assert.equal(a.names().filter(n => n !== 'hello' && n !== 'state' && n !== 'sessions').length, 0, 'a keepalive is not an event')
})

// ---------------------------------------------------------------------------
// voice: "A page that connects is told the settings and the state"

// Re-pinned for add-voice-orchestrator, voice-sessions: "A page that connects is sent the list and the open proposal"
// (a page now receives a `sessions` event after `hello` and `state`, so its events are three, not two).
test('the first events are hello with the settings, state and the session list', T, async () => {
  const r = rig({ lang: 'en-GB', model: 'opus' })
  await r.up()
  const page = await r.connect()
  assert.deepEqual(page.names(), ['hello', 'state', 'sessions'])
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
  // Re-pinned for add-voice-orchestrator, voice-sessions: "A page that connects is sent the list and the open proposal".
  assert.deepEqual(late.names(), ['hello', 'state', 'sessions'])
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

// Re-pinned for add-voice-orchestrator, voice-engine: "A command the session runs is shown and not spoken" (the output
// of a command other than `dial propose` is still neither shown nor spoken; the one use made of an output is the proposal).
test('a command other than dial propose is sent to every page as a tool event and never spoken, and its output is not shown', T, async () => {
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
  // Re-pinned for add-voice-orchestrator, voice-sessions: "A page that connects is sent the list and the open proposal"
  // (the list is sent to a page of a refused session too: "The voice session was refused").
  assert.deepEqual(later.names(), ['hello', 'state', 'sessions'])
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

// ===========================================================================
// add-voice-orchestrator: the `voice-sessions` delta as the server joins it.

const SHIP = '/interlock:ship add-parser'
const entry = (o = {}) => ({
  id: 'c7b0ada6',
  cwd: '/repos/katipon',
  kind: 'background',
  startedAt: 1794900099451,
  sessionId: 'c7b0ada6-b039-4dca-8847-cfb263166f6b',
  name: `dial: ${SHIP}`,
  state: 'working',
  ...o
})
const proposeUse = (repo, prompt, id = 'toolu_p1') =>
  J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `dial propose ${repo} --prompt ${J(prompt)} --json` } }] } })
const resultOf = (id, content, extra = {}) =>
  J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } })
const proposeResult = (repo, prompt, id = 'toolu_p1') => resultOf(id, J({ proposal: { repo, prompt } }))

/** The session proposes `prompt` for `repo`, says `reply` and, with `end`, ends its turn. */
async function draft(r, { repo = 'katipon', prompt = SHIP, reply = 'I have drafted that.', end = true, id = 'toolu_p1' } = {}) {
  const claude = r.claudes()[0]
  claude.line(proposeUse(repo, prompt, id))
  claude.line(proposeResult(repo, prompt, id))
  if (reply) {
    claude.line(delta(`${reply} `))
    claude.line(blockStop())
  }
  if (end) claude.line(result())
  await settle()
}

/** Every say process that is waiting runs to its end with exit 0, one after the other. */
async function speakAll(r) {
  for (let i = 0; i < 50; i++) {
    const next = r.says().find(child => !child.exited)
    if (!next) return
    next.exit({ code: 0 })
    await settle()
  }
}

const spoken = r => r.says().map(child => child.written.join(''))
const statuses = page => page.of('proposal').map(p => p.status)
const shape = p => ({ repo: p.repo, prompt: p.prompt, status: p.status })
const confirm = (r, id, spokenFlag = false) => r.post('/confirm', { id, spoken: spokenFlag })

/** A server with one page, a turn in progress and a proposal drafted for `katipon`; with `say` it is read aloud. */
async function drafted(opts = {}, proposal = {}) {
  const r = rig(opts)
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r, proposal)
  return { r, page, id: page.of('proposal')[0]?.id }
}

// ---------------------------------------------------------------------------
// voice-engine: "A proposal is read from the result of dial propose" (the server side)

test('a propose command is shown as a tool event before its proposal event, and its output is not shown', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r, { reply: null })
  const command = `dial propose katipon --prompt ${J(SHIP)} --json`
  assert.deepEqual(page.of('tool'), [{ command }])
  assert.ok(page.names().indexOf('tool') < page.names().indexOf('proposal'), page.names().join(','))
  assert.equal(page.res.body().includes('\\"proposal\\":{'), false, 'the result text is not an event')
})

test('a propose result that is not a proposal gives one error and no proposal', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  const claude = r.claudes()[0]
  claude.line(proposeUse('katipon', 'run the tests'))
  claude.line(resultOf('toolu_p1', 'proposal for katipon: run the tests'))
  await settle()
  assert.deepEqual(page.of('error'), [{ message: 'a proposal could not be read; nothing is pending' }])
  assert.deepEqual(page.of('proposal'), [])
})

test('a propose result that is an error gives no error event and no proposal', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in nowhere')
  const claude = r.claudes()[0]
  claude.line(proposeUse('nowhere', 'x'))
  claude.line(resultOf('toolu_p1', 'dial: nowhere is not a registered repo', { is_error: true }))
  await settle()
  assert.deepEqual(page.of('error'), [])
  assert.deepEqual(page.of('proposal'), [])
})

test('the output of another command is never a proposal', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('what is next')
  const claude = r.claudes()[0]
  claude.line(toolUse('dial context katipon --json'))
  claude.line(resultOf('toolu_1', J({ proposal: { repo: 'katipon', prompt: SHIP } })))
  await settle()
  assert.deepEqual(page.of('proposal'), [])
  assert.deepEqual(page.of('error'), [])
})

// ---------------------------------------------------------------------------
// voice-sessions: "A proposal from the voice session becomes the one open proposal"

test('a proposal is sent to every page as pending with an 8-character id', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r)
  for (const page of [a, b]) {
    assert.equal(page.of('proposal').length, 1)
    const [p] = page.of('proposal')
    assert.match(p.id, /^[0-9a-f]{8}$/)
    // Re-pinned for add-voice-stage-and-capture, voice-sessions: "An open proposal's event says how long it has left"
    // (an open proposal's event also carries `seconds` and `secondsLeft`).
    assert.deepEqual(Object.keys(p).sort(), ['id', 'prompt', 'repo', 'secondsLeft', 'seconds', 'status'].sort())
    assert.deepEqual(shape(p), { repo: 'katipon', prompt: SHIP, status: 'pending' })
  }
  assert.equal(a.of('proposal')[0].id, b.of('proposal')[0].id)
})

test('a proposal for a repo unregistered meanwhile is one error and no proposal is open', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  r.setRegistry({ ...REGISTRY, repos: REGISTRY.repos.filter(repo => !repo.path.endsWith('/katipon')) })
  await draft(r)
  assert.deepEqual(page.of('error'), [{ message: 'proposal refused: katipon is not a registered repo' }])
  assert.deepEqual(page.of('proposal'), [])
  assert.deepEqual(page.of('notice'), [])
  assert.deepEqual(spoken(r), ['I have drafted that.'], 'no reading, and the error is not spoken')
  const res = await confirm(r, '00000000')
  assert.equal(res.status, 409)
  assert.equal(res.json().reason, 'no such proposal')
  assert.equal(r.starts().length, 0)
})

test('a prompt that fails the check is refused with its reason', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('ship it')
  await draft(r, { prompt: '--dangerously-skip-permissions', reply: null })
  assert.deepEqual(page.of('error'), [{ message: 'proposal refused: prompt cannot start with -' }])
  assert.deepEqual(page.of('proposal'), [])
})

test('a proposal is checked against the registry as it is at that moment, not as it was at start', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('ship it')
  r.setRegistry({ ...REGISTRY, repos: [...REGISTRY.repos, { path: '/repos/newrepo', vault: 'work', host: 'github' }] })
  await draft(r, { repo: 'newrepo', reply: null })
  assert.deepEqual(page.of('error'), [])
  assert.deepEqual(page.of('proposal').map(shape), [{ repo: 'newrepo', prompt: SHIP, status: 'pending' }])
})

test('a newer proposal replaces the open one: the first is replaced, then the second is pending with another id', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  await r.turn('ship it')
  await draft(r, { reply: null, end: false })
  await draft(r, { repo: 'dial', prompt: 'run the tests', reply: null, id: 'toolu_p2' })
  assert.deepEqual(page.of('proposal').map(p => [p.repo, p.status]), [['katipon', 'pending'], ['katipon', 'replaced'], ['dial', 'pending']])
  const [first, , second] = page.of('proposal')
  assert.notEqual(first.id, second.id)
  assert.equal((await confirm(r, first.id)).status, 409, 'the replaced proposal is closed')
  assert.equal((await confirm(r, second.id)).status, 202)
})

// ---------------------------------------------------------------------------
// voice-sessions: "An open proposal's event says how long it has left"

const timeLeft = p => ({ seconds: p.seconds, secondsLeft: p.secondsLeft })
const hasTime = p => Object.hasOwn(p, 'seconds') || Object.hasOwn(p, 'secondsLeft')

test('a new proposal is sent pending with seconds 120 and secondsLeft 120', T, async () => {
  const { page } = await drafted({ say: false })
  assert.deepEqual(page.of('proposal').map(p => [p.status, ...Object.values(timeLeft(p))]), [['pending', 120, 120]])
})

test('seconds is the value of voiceProposalSeconds: 30 gives seconds 30 and secondsLeft 30', T, async () => {
  const { page } = await drafted({ say: false, limits: { voiceProposalSeconds: 30 } })
  assert.deepEqual(timeLeft(page.of('proposal')[0]), { seconds: 30, secondsLeft: 30 })
})

test('read aloud later: the read event says seconds 120 and secondsLeft 30 after 90 seconds', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r, { end: false })
  await r.advance(90_000)
  r.claudes()[0].line(result())
  await settle()
  await speakAll(r)
  assert.deepEqual(statuses(page), ['pending', 'read'])
  assert.deepEqual(timeLeft(page.of('proposal')[0]), { seconds: 120, secondsLeft: 120 }, 'the pending event keeps its number')
  assert.deepEqual(timeLeft(page.of('proposal')[1]), { seconds: 120, secondsLeft: 30 })
})

test('a page that connects 100 seconds after the proposal became open is sent secondsLeft 20', T, async () => {
  const { r, page } = await drafted({ say: false })
  await r.advance(100_000)
  const late = await r.connect()
  assert.deepEqual(late.of('proposal').map(p => [p.status, ...Object.values(timeLeft(p))]), [['pending', 120, 20]])
  assert.equal(page.of('proposal')[0].secondsLeft, 120, 'the page that was there keeps the event it was sent')
})

test('a page that connects 99.5 seconds after the proposal became open is sent secondsLeft 21, rounded up', T, async () => {
  const { r } = await drafted({ say: false })
  await r.advance(99_500)
  const late = await r.connect()
  assert.deepEqual(timeLeft(late.of('proposal')[0]), { seconds: 120, secondsLeft: 21 })
})

test('a proposal that closed holds neither seconds nor secondsLeft, whichever status closed it', T, async () => {
  const cancelled = await drafted({ say: false })
  await cancelled.r.post('/cancel', { id: cancelled.id })
  const expired = await drafted({ say: false })
  await expired.r.advance(120_000)
  const started = await drafted({ say: false })
  await confirm(started.r, started.id)
  started.r.starts()[0].exit({ code: 0 })
  await settle()
  const failed = await drafted({ say: false })
  await confirm(failed.r, failed.id)
  failed.r.starts()[0].exit({ code: 1, stderr: 'boom\n' })
  await settle()
  const replaced = await drafted({ say: false })
  await replaced.r.turn('and another')
  await draft(replaced.r, { repo: 'dial', prompt: 'run the tests', reply: null, id: 'toolu_p2' })
  for (const [name, { page }, last] of [
    ['cancelled', cancelled, 'cancelled'],
    ['expired', expired, 'expired'],
    ['started', started, 'started'],
    ['failed', failed, 'failed'],
    ['replaced', replaced, 'replaced']
  ]) {
    const closed = page.of('proposal').find(p => p.status === last)
    assert.ok(closed, `${name}: ${statuses(page)}`)
    assert.equal(hasTime(closed), false, `${name} holds neither number`)
    for (const p of page.of('proposal')) assert.equal(hasTime(p), p.status === 'pending' || p.status === 'read', `${name}: ${p.status}`)
  }
})

test('a late page after the proposal closed is sent no time and no proposal', T, async () => {
  const { r } = await drafted({ say: false })
  await r.advance(120_000)
  const late = await r.connect()
  assert.deepEqual(late.of('proposal'), [])
})

// ---------------------------------------------------------------------------
// voice-sessions: "Dial reads an open proposal aloud in its own words"

test('the reading follows the reply, and the status becomes read after the last say has exited', T, async () => {
  const { r, page } = await drafted()
  assert.deepEqual(page.of('notice'), [{ text: `Proposal for katipon: ${SHIP}` }])
  assert.deepEqual(spoken(r), ['I have drafted that.'], 'one say at a time')
  const id = page.of('proposal')[0].id
  r.says()[0].exit({ code: 0 })
  await settle()
  r.says()[1].exit({ code: 0 })
  await settle()
  assert.deepEqual(spoken(r), ['I have drafted that.', `Proposal for katipon: ${SHIP}`, 'Say confirm or cancel.'])
  assert.deepEqual(statuses(page), ['pending'], 'not read until the last sentence was spoken')
  r.says()[2].exit({ code: 0 })
  await settle()
  assert.deepEqual(page.of('proposal').map(shape), [
    { repo: 'katipon', prompt: SHIP, status: 'pending' },
    { repo: 'katipon', prompt: SHIP, status: 'read' }
  ])
  assert.equal(page.of('proposal')[1].id, id)
})

test('a prompt of several sentences is read sentence by sentence and is read only after the third say', T, async () => {
  const { r, page } = await drafted({}, { prompt: 'Fix the parser. Then run the tests.', reply: null })
  await settle()
  await speakAll(r)
  assert.deepEqual(spoken(r), ['Proposal for katipon: Fix the parser.', 'Then run the tests.', 'Say confirm or cancel.'])
  assert.deepEqual(statuses(page), ['pending', 'read'])
})

test('the status is not read while any sentence of the reading is still being spoken', T, async () => {
  const { r, page } = await drafted({}, { prompt: 'Fix the parser. Then run the tests.', reply: null })
  r.says()[0].exit({ code: 0 })
  await settle()
  r.says()[1].exit({ code: 0 })
  await settle()
  assert.equal(r.says().length, 3)
  assert.deepEqual(statuses(page), ['pending'])
  r.says()[2].exit({ code: 0 })
  await settle()
  assert.deepEqual(statuses(page), ['pending', 'read'])
})

test('the words of the reading are Dial\'s: the session\'s reply naming another repo does not change them', T, async () => {
  const { r, page } = await drafted({}, { reply: 'This proposal is for dial.' })
  await speakAll(r)
  assert.deepEqual(spoken(r), ['This proposal is for dial.', `Proposal for katipon: ${SHIP}`, 'Say confirm or cancel.'])
  assert.deepEqual(page.of('notice'), [{ text: `Proposal for katipon: ${SHIP}` }])
  assert.equal(page.of('proposal')[0].repo, 'katipon')
})

test('without say the notice is sent, nothing is spoken and the status stays pending', T, async () => {
  const { r, page } = await drafted({ say: false })
  assert.deepEqual(page.of('notice'), [{ text: `Proposal for katipon: ${SHIP}` }])
  assert.equal(r.says().length, 0)
  await r.advance(60_000)
  assert.deepEqual(statuses(page), ['pending'])
})

test('after say failed the notice is sent, no say process is started and the status stays pending', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('hello')
  r.claudes()[0].line(delta('Hello there. '))
  r.claudes()[0].line(result())
  await settle()
  r.says()[0].exit({ code: 1, stderr: 'say: no voice\n' })
  await settle()
  assert.equal(page.of('error').length, 1)
  await r.turn('ship it')
  await draft(r, { reply: 'I have drafted that.' })
  assert.equal(r.says().length, 1, 'no say after the failure')
  assert.deepEqual(page.of('notice'), [{ text: `Proposal for katipon: ${SHIP}` }])
  assert.deepEqual(statuses(page), ['pending'])
})

test('an interrupt while the proposal is being read stops the speech and the status stays pending', T, async () => {
  const { r, page } = await drafted()
  r.says()[0].exit({ code: 0 })
  await settle()
  const reading = r.says()[1]
  assert.ok(reading && !reading.exited)
  const res = await r.post('/interrupt', {})
  assert.equal(res.status, 200)
  assert.equal(reading.killed, true)
  reading.exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(r.says().length, 2, 'the rest of the reading is dropped')
  assert.deepEqual(statuses(page), ['pending'])
})

test('a new turn while the proposal is being read stops the speech and the status stays pending', T, async () => {
  const { r, page } = await drafted()
  r.says()[0].exit({ code: 0 })
  await settle()
  const reading = r.says()[1]
  await r.turn('wait, what is next')
  assert.equal(reading.killed, true)
  reading.exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.equal(r.says().length, 2)
  assert.deepEqual(statuses(page), ['pending'])
})

test('a turn that was interrupted before it ended reads nothing and the status stays pending', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r, { end: false })
  assert.deepEqual(statuses(page), ['pending'])
  const res = await r.post('/interrupt', {})
  assert.equal(res.status, 200)
  r.claudes()[0].exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.deepEqual(page.of('notice'), [])
  assert.deepEqual(spoken(r), ['I have drafted that.'])
  assert.deepEqual(statuses(page), ['pending'])
})

test('a turn stopped after voiceTurnSeconds reads nothing and the status stays pending', T, async () => {
  const r = rig({ limits: { voiceTurnSeconds: 30 } })
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r, { end: false, reply: null })
  await r.advance(30_000)
  assert.deepEqual(page.of('error'), [{ message: 'the turn was stopped after 30 seconds' }])
  assert.deepEqual(page.of('notice'), [])
  assert.equal(r.says().length, 0)
  assert.deepEqual(statuses(page), ['pending'])
})

// ---------------------------------------------------------------------------
// voice-sessions: "Confirm starts the open proposal"

test('a click confirms a pending proposal: 202, the status starting, claude started once', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  const res = await confirm(r, id)
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { ok: true })
  assert.deepEqual(statuses(page), ['pending', 'starting'])
  assert.equal(r.starts().length, 1)
})

test('a spoken confirmation before the reading is 409 and claude is not started', T, async () => {
  const { r, page, id } = await drafted()
  assert.deepEqual(statuses(page), ['pending'])
  const res = await confirm(r, id, true)
  assert.equal(res.status, 409)
  assert.equal(res.json().ok, false)
  assert.equal(res.json().reason, 'the proposal was not read aloud; confirm it on screen')
  assert.equal(r.starts().length, 0)
  assert.deepEqual(statuses(page), ['pending'])
})

test('a spoken confirmation after the reading is 202 and the session is started', T, async () => {
  const { r, page, id } = await drafted()
  await speakAll(r)
  assert.deepEqual(statuses(page), ['pending', 'read'])
  const res = await confirm(r, id, true)
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(r.starts().length, 1)
  assert.deepEqual(statuses(page), ['pending', 'read', 'starting'])
})

test('a click confirms a proposal that has been read as well', T, async () => {
  const { r, id } = await drafted()
  await speakAll(r)
  assert.equal((await confirm(r, id, false)).status, 202)
})

test('a proposal that is not open is 409 no such proposal and claude is not started', T, async () => {
  const unknown = await drafted({ say: false })
  const res = await confirm(unknown.r, '00000000')
  assert.equal(res.status, 409)
  assert.equal(res.json().reason, 'no such proposal')

  const cancelled = await drafted({ say: false })
  assert.equal((await cancelled.r.post('/cancel', { id: cancelled.id })).status, 200)
  assert.equal((await confirm(cancelled.r, cancelled.id)).json().reason, 'no such proposal')

  const expired = await drafted({ say: false })
  await expired.r.advance(120_000)
  assert.equal((await confirm(expired.r, expired.id)).status, 409)

  const replaced = await drafted({ say: false, agents: [] }, { reply: null, end: false })
  await draft(replaced.r, { repo: 'dial', prompt: 'run the tests', reply: null, id: 'toolu_p2' })
  assert.equal((await confirm(replaced.r, replaced.id)).json().reason, 'no such proposal')

  const started = await drafted({ say: false })
  assert.equal((await confirm(started.r, started.id)).status, 202)
  started.r.starts()[0].exit({ code: 0 })
  await settle()
  const again = await confirm(started.r, started.id)
  assert.equal(again.status, 409)
  assert.equal(again.json().reason, 'no such proposal')
  assert.equal(started.r.starts().length, 1)

  for (const rig2 of [unknown, cancelled, expired]) assert.equal(rig2.r.starts().length, 0)
  assert.equal(replaced.r.starts().length, 0)
})

test('a second confirmation while the first is starting is 409 and claude is started once', T, async () => {
  const { r, id } = await drafted({ say: false })
  const first = await confirm(r, id)
  const second = await confirm(r, id)
  assert.equal(first.status, 202)
  assert.equal(second.status, 409)
  assert.equal(second.json().reason, 'no such proposal')
  assert.equal(r.starts().length, 1)
})

test('a body that is not a confirmation is 400 and nothing is started', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  for (const body of [{ id: 5 }, { id: 'ab12cd34' }, [], 'not json {', { id, spoken: 'yes' }, { spoken: false }]) {
    const res = await r.post('/confirm', body)
    assert.equal(res.status, 400, J(body))
    assert.equal(res.json().ok, false, J(body))
  }
  assert.equal(r.starts().length, 0)
  assert.deepEqual(statuses(page), ['pending'])
  assert.equal((await confirm(r, id)).status, 202, 'the proposal is still open')
})

// ---------------------------------------------------------------------------
// voice-sessions: "Cancel and time close a proposal"

test('cancel is 200 and the status cancelled, and a later confirm is 409', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  const res = await r.post('/cancel', { id })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.deepEqual(statuses(page), ['pending', 'cancelled'])
  assert.equal((await confirm(r, id)).status, 409)
  assert.equal(r.starts().length, 0)
})

test('cancel with another id is 409 no such proposal and the proposal stays open', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  const res = await r.post('/cancel', { id: '00000000' })
  assert.equal(res.status, 409)
  assert.equal(res.json().reason, 'no such proposal')
  assert.deepEqual(statuses(page), ['pending'])
  assert.equal((await confirm(r, id)).status, 202)
})

test('a proposal expires after voiceProposalSeconds and is no longer open', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  await r.advance(119_999)
  assert.deepEqual(statuses(page), ['pending'])
  await r.advance(1)
  assert.deepEqual(statuses(page), ['pending', 'expired'])
  assert.equal((await confirm(r, id)).status, 409)
})

test('reading does not extend the time: open 100 s ago and read 10 s ago it expires 20 s later', T, async () => {
  const r = rig()
  await r.up()
  const page = await r.connect()
  await r.turn('ship add-parser in katipon')
  await draft(r, { end: false })
  await r.advance(90_000)
  r.claudes()[0].line(result())
  await settle()
  await speakAll(r)
  assert.deepEqual(statuses(page), ['pending', 'read'])
  await r.advance(10_000)
  await r.advance(19_999)
  assert.deepEqual(statuses(page), ['pending', 'read'])
  await r.advance(1)
  assert.deepEqual(statuses(page), ['pending', 'read', 'expired'])
})

test('the expiry is read from the limits: 30 seconds when voiceProposalSeconds is 30', T, async () => {
  const { r, page } = await drafted({ say: false, limits: { voiceProposalSeconds: 30 } })
  await r.advance(29_999)
  assert.deepEqual(statuses(page), ['pending'])
  await r.advance(1)
  assert.deepEqual(statuses(page), ['pending', 'expired'])
})

// ---------------------------------------------------------------------------
// voice-sessions: "The number of running sessions is bounded"

test('with three sessions running a fourth is 409 n sessions are already running and the proposal stays open', T, async () => {
  const running = [
    entry({ id: 'aaaaaaa1', cwd: '/repos/katipon', state: 'working', startedAt: 1000 }),
    entry({ id: 'aaaaaaa2', cwd: '/repos/dial', state: 'blocked', waitingFor: 'permission prompt', startedAt: 2000 }),
    entry({ id: 'aaaaaaa3', cwd: '/repos/parser', state: 'working', startedAt: 3000 })
  ]
  const { r, page, id } = await drafted({ say: false, agents: running }, { repo: 'escapement', prompt: 'run the tests', reply: null })
  const res = await confirm(r, id)
  assert.equal(res.status, 409)
  assert.equal(res.json().reason, '3 sessions are already running')
  assert.equal(r.starts().length, 0)
  assert.deepEqual(statuses(page), ['pending'])

  r.agents([running[0], running[1]])
  await r.advance(5000)
  assert.equal((await confirm(r, id)).status, 202, 'the proposal was kept, and a slot is free')
})

test('the cap is read from the limits: voiceSessions 1 refuses a second session with 1 sessions are already running', T, async () => {
  const { r, id } = await drafted({ say: false, limits: { voiceSessions: 1 }, agents: [entry({ cwd: '/repos/dial' })] })
  const res = await confirm(r, id)
  assert.equal(res.status, 409)
  assert.equal(res.json().reason, '1 sessions are already running')
})

test('a blocked session in the proposal\'s repo is 409 a session is already running in the repo', T, async () => {
  const { r, id } = await drafted({ say: false, agents: [entry({ state: 'blocked', waitingFor: 'permission prompt' })] })
  const res = await confirm(r, id)
  assert.equal(res.status, 409)
  assert.equal(res.json().reason, 'a session is already running in katipon')
  assert.equal(r.starts().length, 0)
})

test('finished sessions do not count: done, failed and stopped in the repo do not stop a confirmation', T, async () => {
  for (const state of ['done', 'failed', 'stopped']) {
    const { r, id } = await drafted({ say: false, agents: [entry({ state })] })
    assert.equal((await confirm(r, id)).status, 202, state)
    assert.equal(r.starts().length, 1, state)
  }
})

// ---------------------------------------------------------------------------
// voice-sessions: "A confirmed proposal starts one claude background session"

test('claude is run in the repo\'s registered path with exactly four arguments and the server\'s environment', T, async () => {
  const { r, id } = await drafted({ say: false })
  await confirm(r, id)
  const [child] = r.starts()
  assert.equal(child.file, CLAUDE_PATH)
  assert.deepEqual(child.args, ['--bg', '--name', `dial: ${SHIP}`, SHIP])
  assert.equal(child.cwd, '/repos/katipon')
  assert.deepEqual(child.env, { PATH: NO_SAY_DIR })
})

test('a long prompt of several lines is passed unchanged and named by its first 60 characters on one line', T, async () => {
  const prompt = `${'alpha beta gamma delta\n'.repeat(13)}end`.slice(0, 300)
  const { r, id } = await drafted({ say: false }, { prompt, reply: null })
  await confirm(r, id)
  const [child] = r.starts()
  assert.equal(child.args[3], prompt)
  assert.equal(child.args[2], `dial: ${prompt.replace(/\s+/g, ' ').slice(0, 60)}`)
  assert.equal(child.args.length, 4)
})

test('none of the owner\'s settings is overridden by an argument of the start', T, async () => {
  const { r, id } = await drafted({ say: false })
  await confirm(r, id)
  const args = r.starts()[0].args
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', '--model', '--settings', '--worktree', '--safe-mode', '--restricted', '-p']) {
    assert.equal(args.includes(flag), false, flag)
  }
})

test('a session that started: the status started, the notice Started in the repo, and the list is read at once', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  await confirm(r, id)
  const reads = r.reads().length
  r.starts()[0].exit({ code: 0 })
  await settle()
  assert.deepEqual(statuses(page), ['pending', 'starting', 'started'])
  assert.ok(page.of('notice').some(n => n.text === 'Started in katipon.'), J(page.of('notice')))
  assert.equal(r.reads().length, reads + 1, 'no wait for the next interval')
  assert.deepEqual(r.reads().at(-1).args, ['agents', '--json', '--all'])
})

// ---------------------------------------------------------------------------
// voice-sessions: "A start that fails is reported in claude's own words"

test('a repo Claude Code does not trust: the status failed with claude\'s own line, and nothing is spoken', T, async () => {
  const { r, page, id } = await drafted()
  await speakAll(r)
  const before = r.says().length
  await confirm(r, id, true)
  const line = 'Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.'
  r.starts()[0].exit({ code: 1, stderr: `${line}\n` })
  await settle()
  const last = page.of('proposal').at(-1)
  assert.equal(last.status, 'failed')
  assert.equal(last.reason, `claude --bg failed (exit 1): ${line}`)
  assert.equal(r.says().length, before, 'no say process for a failure')
  assert.equal(page.of('notice').some(n => /^Started/.test(n.text)), false)
})

test('the line is on stdout: it is the reason when stderr is empty, and without any line the reason is the exit alone', T, async () => {
  const one = await drafted({ say: false })
  await confirm(one.r, one.id)
  one.r.starts()[0].line('Workspace not trusted.')
  one.r.starts()[0].exit({ code: 1 })
  await settle()
  assert.equal(one.page.of('proposal').at(-1).reason, 'claude --bg failed (exit 1): Workspace not trusted.')

  const none = await drafted({ say: false })
  await confirm(none.r, none.id)
  none.r.starts()[0].exit({ code: 1 })
  await settle()
  assert.equal(none.page.of('proposal').at(-1).reason, 'claude --bg failed (exit 1)')
})

test('claude that cannot be started gives the reason claude could not be started with the code', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  await confirm(r, id)
  r.starts()[0].exit({ code: null, error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) })
  await settle()
  const last = page.of('proposal').at(-1)
  assert.equal(last.status, 'failed')
  assert.ok(last.reason.startsWith('claude could not be started (ENOENT: '), last.reason)
})

test('a start that hangs is ended after subprocessTimeoutSeconds and the reason is the time waited', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  await confirm(r, id)
  await r.advance(9_999)
  assert.equal(r.starts()[0].killed, false)
  await r.advance(1)
  assert.equal(r.starts()[0].killed, true)
  r.starts()[0].exit({ code: null, signal: 'SIGTERM' })
  await settle()
  const last = page.of('proposal').at(-1)
  assert.equal(last.status, 'failed')
  assert.equal(last.reason, 'claude --bg did not answer in 10 seconds')
})

test('a failed start is not tried again until another proposal is confirmed', T, async () => {
  const { r, page, id } = await drafted({ say: false })
  await confirm(r, id)
  r.starts()[0].exit({ code: 1, stderr: 'boom\n' })
  await settle()
  await r.advance(60_000)
  assert.equal(r.starts().length, 1)
  assert.equal((await confirm(r, id)).status, 409)
  assert.equal(r.starts().length, 1)
  assert.equal(page.of('proposal').at(-1).status, 'failed')
})

// ---------------------------------------------------------------------------
// voice-sessions: "A page that connects is sent the list and the open proposal"

test('a late page gets hello, state, the two sessions and the proposal that was read, in that order', T, async () => {
  const list = [entry({ id: 'c7b0ada6', state: 'blocked', waitingFor: 'permission prompt', startedAt: 2000 }), entry({ id: '0f3e9a11', cwd: '/repos/dial', state: 'done', startedAt: 1000 })]
  const { r, id } = await drafted({ agents: list })
  await speakAll(r)
  const late = await r.connect()
  assert.deepEqual(late.names(), ['hello', 'state', 'sessions', 'proposal'])
  const [sessions] = late.of('sessions')
  assert.deepEqual(sessions.sessions.map(s => s.id), ['c7b0ada6', '0f3e9a11'])
  assert.equal(sessions.pollSeconds, 5)
  assert.deepEqual(late.of('proposal').map(shape), [{ repo: 'katipon', prompt: SHIP, status: 'read' }])
  assert.equal(late.of('proposal')[0].id, id)
})

test('the first page is sent an empty list at once, and a second sessions event when the first read finds sessions', T, async () => {
  const r = rig({ agents: 'manual' })
  await r.up()
  const page = await r.connect()
  assert.deepEqual(page.names(), ['hello', 'state', 'sessions'])
  assert.deepEqual(page.of('sessions')[0].sessions, [])
  assert.equal(r.reads().length, 1)
  r.reads()[0].line(J([entry()]))
  r.reads()[0].exit({ code: 0 })
  await settle()
  assert.equal(page.of('sessions').length, 2)
  assert.deepEqual(page.of('sessions')[1].sessions.map(s => s.id), ['c7b0ada6'])
})

test('a page that connects while no proposal is open is sent no proposal event', T, async () => {
  const r = rig({ say: false })
  await r.up()
  const page = await r.connect()
  assert.deepEqual(page.of('proposal'), [])
})

// ---------------------------------------------------------------------------
// voice: "Two pages see the same proposal and the same list"

test('two pages receive the same proposal event and the same sessions event', T, async () => {
  const r = rig({ say: false, agents: [entry({ state: 'working' })] })
  await r.up()
  const a = await r.connect()
  const b = await r.connect()
  await r.turn('ship add-parser in dial')
  await draft(r, { repo: 'dial', reply: null })
  r.agents([entry({ state: 'done' })])
  await r.advance(5000)
  assert.equal(a.of('proposal').length, 1)
  assert.deepEqual(a.of('proposal'), b.of('proposal'))
  assert.ok(a.of('sessions').length >= 2)
  assert.deepEqual(a.of('sessions').at(-1), b.of('sessions').at(-1))
  assert.equal(a.of('sessions').at(-1).sessions[0].state, 'done')
})

// ---------------------------------------------------------------------------
// voice-sessions: "A notice is shown, and spoken only when no turn is running"

test('a notice while Dial is idle is shown and spoken, and the state is speaking and then idle', T, async () => {
  const r = rig({ agents: [entry({ cwd: '/repos/dial', state: 'working' })] })
  await r.up()
  const page = await r.connect()
  r.agents([entry({ cwd: '/repos/dial', state: 'done' })])
  await r.advance(5000)
  assert.deepEqual(page.of('notice'), [{ text: 'The session in dial has finished its turn.' }])
  assert.deepEqual(spoken(r), ['The session in dial has finished its turn.'])
  assert.deepEqual(page.states().at(-1), { state: 'speaking' })
  r.says()[0].exit({ code: 0 })
  await settle()
  assert.deepEqual(page.states(), [{ state: 'idle' }, { state: 'speaking' }, { state: 'idle' }])
})

test('a notice during a turn is shown and not spoken', T, async () => {
  const r = rig({ agents: [entry({ state: 'working' })] })
  await r.up()
  const page = await r.connect()
  await r.turn('what needs me')
  assert.deepEqual(page.states().at(-1), { state: 'thinking' })
  r.agents([entry({ state: 'blocked', waitingFor: 'permission prompt' })])
  await r.advance(5000)
  assert.deepEqual(page.of('notice'), [{ text: 'The session in katipon needs you: permission prompt.' }])
  assert.equal(r.says().length, 0)
  assert.deepEqual(page.states().at(-1), { state: 'thinking' })
})

test('without say a notice is shown and the state does not change', T, async () => {
  const r = rig({ say: false, agents: [entry({ state: 'working' })] })
  await r.up()
  const page = await r.connect()
  r.agents([entry({ state: 'failed' })])
  await r.advance(5000)
  assert.deepEqual(page.of('notice'), [{ text: 'The session in katipon failed.' }])
  assert.equal(r.says().length, 0)
  assert.deepEqual(page.states(), [{ state: 'idle' }])
})

test('the first read of a run announces nothing', T, async () => {
  const r = rig({ agents: [entry({ state: 'blocked', waitingFor: 'permission prompt' }), entry({ id: '0f3e9a11', state: 'blocked' })] })
  await r.up()
  const page = await r.connect()
  await r.advance(5000)
  assert.deepEqual(page.of('notice'), [])
  assert.equal(r.says().length, 0)
})

test('an error is never spoken: a list that cannot be read is shown once', T, async () => {
  const r = rig({ agents: 'manual' })
  await r.up()
  const page = await r.connect()
  r.reads()[0].exit({ code: 1, stderr: "error: unknown option '--json'\n" })
  await settle()
  assert.deepEqual(page.of('error'), [{ message: "could not list sessions: claude agents failed (exit 1): error: unknown option '--json'" }])
  assert.equal(r.says().length, 0)
})

// ---------------------------------------------------------------------------
// voice-sessions: "The list is read while a page is connected and sent when it changes" (the server's part)

test('the list is read when the first page connects and every voiceSessionPollSeconds, and not when no page is connected', T, async () => {
  const r = rig({ limits: { voiceCloseSeconds: 60 } })
  await r.up()
  assert.equal(r.reads().length, 0)
  const page = await r.connect()
  assert.equal(r.reads().length, 1)
  await r.advance(5000)
  assert.equal(r.reads().length, 2)
  page.close()
  await settle()
  await r.advance(20_000)
  assert.equal(r.reads().length, 2, 'no read with no page')
  await r.connect()
  assert.equal(r.reads().length, 3, 'a page connects again')
})

test('a second page does not start a second reading', T, async () => {
  const r = rig({ agents: 'manual' })
  await r.up()
  await r.connect()
  await r.connect()
  assert.equal(r.reads().length, 1)
  await r.advance(5000)
  assert.equal(r.reads().length, 1, 'no second read while one is running')
})

// ---------------------------------------------------------------------------
// voice-sessions: "The page can read a session's screen as text"

const logUrl = (id = 'c7b0ada6') => `/log?t=${TOKEN}&id=${id}`

test('the log of a listed session is claude logs with escape sequences and control characters removed', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = r.get(logUrl())
  await settle()
  assert.equal(r.logs().length, 1)
  assert.deepEqual(r.logs()[0].args, ['logs', 'c7b0ada6'])
  assert.equal(r.logs()[0].file, CLAUDE_PATH)
  r.logs()[0].line('\u001b[1m\u001b[32m● Running tests\u001b[0m')
  r.logs()[0].line('\u001b]0;title\u0007  12 passed')
  r.logs()[0].exit({ code: 0 })
  const res = await pending
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true, id: 'c7b0ada6', lines: ['● Running tests', '  12 passed'] })
})

test('only the last voiceLogLines lines are answered', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = r.get(logUrl())
  await settle()
  for (let i = 1; i <= 500; i++) r.logs()[0].line(`line ${i}`)
  r.logs()[0].exit({ code: 0 })
  const { lines } = (await pending).json()
  assert.equal(lines.length, 200)
  assert.equal(lines[0], 'line 301')
  assert.equal(lines.at(-1), 'line 500')
})

test('a secret on the screen is redacted from the reply', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = r.get(logUrl())
  await settle()
  r.logs()[0].line('export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345')
  r.logs()[0].exit({ code: 0 })
  const res = await pending
  assert.equal(res.status, 200)
  assert.equal(res.body().includes('ghp_0123456789abcdefghij'), false, res.body())
})

test('a session that is not listed, or no id, is 404 no such session and claude is not run', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  for (const url of [logUrl('ffffffff'), `/log?t=${TOKEN}`]) {
    const res = await r.get(url)
    assert.equal(res.status, 404, url)
    assert.deepEqual(res.json(), { ok: false, reason: 'no such session' }, url)
  }
  assert.equal(r.logs().length, 0)
})

test('a log request without the token is 403 missing or wrong token and claude is not run', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const res = await r.get('/log?id=c7b0ada6')
  assert.equal(res.status, 403)
  assert.equal(res.json().reason, 'missing or wrong token')
  assert.equal(r.logs().length, 0)
})

test('claude logs that fails is 502 with its first stderr line', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = r.get(logUrl())
  await settle()
  r.logs()[0].exit({ code: 1, stderr: 'No such session\n' })
  const res = await pending
  assert.equal(res.status, 502)
  assert.deepEqual(res.json(), { ok: false, reason: 'claude logs failed (exit 1): No such session' })
})

test('the screen stays out of the conversation: no event, no write to the session, no say, and no other page sees it', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  const asking = await r.connect()
  const other = await r.connect()
  const eventsBefore = [asking.events().length, other.events().length]
  const pending = r.get(logUrl())
  await settle()
  r.logs()[0].line('SCREEN-MARKER the owner\'s terminal shows this')
  r.logs()[0].exit({ code: 0 })
  const res = await pending
  assert.ok(res.body().includes('SCREEN-MARKER'))
  await settle()
  assert.equal(asking.events().length, eventsBefore[0])
  assert.equal(other.events().length, eventsBefore[1])
  for (const page of [asking, other]) assert.equal(page.res.body().includes('SCREEN-MARKER'), false)
  assert.deepEqual(r.claudes()[0].written, [])
  assert.equal(r.says().length, 0)
})

// ---------------------------------------------------------------------------
// voice-sessions: "Stop ends a session through claude"

const stopSession = (r, id = 'c7b0ada6') => r.post('/stop', { id })

test('stop runs claude stop for a listed session, is 200 and reads the list at once', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const reads = r.reads().length
  const pending = stopSession(r)
  await settle()
  assert.equal(r.stops().length, 1)
  assert.equal(r.stops()[0].file, CLAUDE_PATH)
  assert.deepEqual(r.stops()[0].args, ['stop', 'c7b0ada6'])
  r.stops()[0].exit({ code: 0 })
  const res = await pending
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  await settle()
  assert.equal(r.reads().length, reads + 1, 'no wait for the next interval')
})

test('stop of an id that is not listed is 409 no such session and claude is not run', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const res = await stopSession(r, 'ffffffff')
  assert.equal(res.status, 409)
  assert.deepEqual(res.json(), { ok: false, reason: 'no such session' })
  assert.equal(r.stops().length, 0)
})

test('claude stop that fails is 502 with its first stderr line', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = stopSession(r)
  await settle()
  r.stops()[0].exit({ code: 1, stderr: 'already stopped\n' })
  const res = await pending
  assert.equal(res.status, 502)
  assert.deepEqual(res.json(), { ok: false, reason: 'claude stop failed (exit 1): already stopped' })
})

test('a stop request without the token or the origin is refused and claude is not run', T, async () => {
  const r = rig({ agents: [entry()] })
  await r.up()
  await r.connect()
  assert.equal((await r.post('/stop', { id: 'c7b0ada6' }, { 'x-dial-token': undefined })).status, 403)
  assert.equal((await r.post('/stop', { id: 'c7b0ada6' }, { origin: 'https://example.com' })).status, 403)
  assert.equal(r.stops().length, 0)
})

// ---------------------------------------------------------------------------
// voice-sessions: "The Terminal control opens a session in a terminal window"

const attachSession = (r, id = 'c7b0ada6') => r.post('/attach', { id })

test('on macOS attach writes the command file and runs open once with its path', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: true, agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = attachSession(r)
  await settle()
  const file = `${TMP_DIR}/dial-attach-c7b0ada6.command`
  assert.equal(r.writes.length, 1)
  assert.equal(r.writes[0][0], file)
  assert.equal(r.writes[0][1], `#!/bin/sh\nexec '${CLAUDE_PATH}' attach c7b0ada6\n`)
  assert.equal(r.attaches().length, 1)
  assert.deepEqual(r.attaches()[0].args, [file])
  r.attaches()[0].exit({ code: 0 })
  const res = await pending
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, true)
})

test('on another platform attach is 409 run this in a terminal and writes and runs nothing', T, async () => {
  const r = rig({ platform: 'linux', agents: [entry()] })
  await r.up()
  await r.connect()
  const res = await attachSession(r)
  assert.equal(res.status, 409)
  assert.deepEqual(res.json(), { ok: false, reason: 'run this in a terminal: claude attach c7b0ada6' })
  assert.equal(r.writes.length, 0)
  assert.equal(r.opens().length, 0)
})

test('attach of an id that is not listed is 409 no such session', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: true, agents: [entry()] })
  await r.up()
  await r.connect()
  const res = await attachSession(r, 'ffffffff')
  assert.equal(res.status, 409)
  assert.deepEqual(res.json(), { ok: false, reason: 'no such session' })
  assert.equal(r.writes.length, 0)
  assert.equal(r.attaches().length, 0)
})

test('an opener that fails is 502 could not open a terminal with its stderr line', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: true, agents: [entry()] })
  await r.up()
  await r.connect()
  const pending = attachSession(r)
  await settle()
  r.attaches()[0].exit({ code: 1, stderr: 'The application cannot be opened\n' })
  const res = await pending
  assert.equal(res.status, 502)
  assert.deepEqual(res.json(), { ok: false, reason: 'could not open a terminal: The application cannot be opened' })
})

// ---------------------------------------------------------------------------
// voice-sessions: "The list is read while a page is connected" (scenario: The voice session was refused)

test('a refused voice session still has its list read and sent, and Log, Stop and Terminal still answer', T, async () => {
  const r = rig({ platform: 'darwin', noOpen: true, agents: [entry()] })
  await r.voice.start()
  await settle()
  const page = await r.connect()
  r.claudes()[0].line(report({ tools: ['Bash', 'Read'] }))
  await settle()
  assert.equal(page.states().at(-1).state, 'refused')
  assert.equal(r.reads().length >= 1, true)
  assert.deepEqual(page.of('sessions').at(-1).sessions.map(s => s.id), ['c7b0ada6'])

  const log = r.get(logUrl())
  await settle()
  r.logs()[0].line('still readable')
  r.logs()[0].exit({ code: 0 })
  assert.deepEqual((await log).json().lines, ['still readable'])

  const stop = stopSession(r)
  await settle()
  r.stops()[0].exit({ code: 0 })
  assert.equal((await stop).status, 200)

  const attach = attachSession(r)
  await settle()
  r.attaches()[0].exit({ code: 0 })
  assert.equal((await attach).status, 200)
})

// ---------------------------------------------------------------------------
// voice-sessions: "Every claude call is bounded and started sessions are left running"

test('a read that hangs is ended after subprocessTimeoutSeconds and counts as failed', T, async () => {
  const r = rig({ agents: 'manual' })
  await r.up()
  const page = await r.connect()
  await r.advance(9_999)
  assert.equal(r.reads()[0].killed, false)
  await r.advance(1)
  assert.equal(r.reads()[0].killed, true)
  r.reads()[0].exit({ code: null, signal: 'SIGTERM' })
  await settle()
  assert.deepEqual(page.of('error'), [{ message: 'could not list sessions: claude agents did not answer in 10 seconds' }])
})

test('the command ends during a read: that process is ended and done waits until it has exited', T, async () => {
  const r = rig({ agents: 'manual' })
  await r.up()
  await r.connect()
  assert.equal(r.reads().length, 1)
  const out = r.voice.shutdown()
  await settle()
  assert.equal(r.reads()[0].killed, true)
  assert.equal(r.finished(), false, 'done must wait for the read to exit')
  for (const child of r.children) if (child.killed && !child.exited) child.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(await withTimeout(out, 'shutdown'), 0)
  assert.equal(r.finished(), true)
})

test('sessions outlive the window: claude stop is not run and no start is ended', T, async () => {
  const running = [entry({ id: 'aaaaaaa1', state: 'working' }), entry({ id: 'aaaaaaa2', cwd: '/repos/dial', state: 'working' })]
  const r = rig({ agents: running })
  await r.up()
  await r.connect()
  const out = r.voice.shutdown()
  await r.drain()
  assert.equal(await withTimeout(out, 'shutdown'), 0)
  assert.equal(r.stops().length, 0)
  assert.equal(r.starts().length, 0)
  assert.equal(r.finished(), true)
})

test('a start still running when the command ends is ended and the proposal is dropped', T, async () => {
  const { r, id } = await drafted({ say: false })
  await confirm(r, id)
  const out = r.voice.shutdown()
  await settle()
  assert.equal(r.starts()[0].killed, true)
  assert.equal(r.finished(), false)
  await r.drain()
  assert.equal(await withTimeout(out, 'shutdown'), 0)
  assert.equal(r.stops().length, 0)
})
