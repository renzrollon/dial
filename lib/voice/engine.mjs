/**
 * The Claude Code session behind `dial voice` (specs/voice-engine; design §2 to §7). Four parts:
 *
 * - `ALLOWED_TOOLS` and `engineArgs`: how `claude -p` is started, isolated from the owner's setup and held to five
 *   `dial` commands.
 * - `checkStart`: the check of the session's start report (`system`/`init`), fail closed.
 * - `createReducer`: a pure reducer from one stdout line of the stream-json output to effects. Never throws.
 * - `createEngine`: the session manager. It takes `spawn` (the shape of `spawnChild` in `lib/spawn.mjs`) and timers
 *   as arguments and imports no runner, so a test drives it with fakes. It owns the turn timeout, the interrupt and
 *   resume, the fallback to a new conversation, and the refusal rules.
 */
import { randomUUID } from 'node:crypto'

/** The one `--allowedTools` argument: five read-only `dial` commands, comma-separated (D8, D25). */
export const ALLOWED_TOOLS = [
  'Bash(dial next:*)',
  'Bash(dial context:*)',
  'Bash(dial brief:*)',
  'Bash(dial sync:*)',
  'Bash(dial repos:*)'
].join(',')

/**
 * The arguments of the session's `claude` process, in the order the voice-engine delta gives. `resume: true` puts
 * `--resume <id>` in place of `--session-id <id>` and changes nothing else.
 */
export function engineArgs({ model, prompt, sessionId, resume = false }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', '--restricted', '--strict-mcp-config',
    '--tools', 'Bash',
    '--allowedTools', ALLOWED_TOOLS,
    '--permission-mode', 'dontAsk',
    '--append-system-prompt', prompt,
    '--model', model,
    resume ? '--resume' : '--session-id', sessionId
  ]
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nameOf = value => (typeof value === 'string' ? value : JSON.stringify(value))

/**
 * Check a start report: `tools` exactly Bash, no MCP servers, permission mode `dontAsk`. Other fields (`plugins`,
 * `skills`, ...) are not read (D21). → `{ ok: true }` or `{ ok: false, reason }`.
 */
export function checkStart(event) {
  const report = isObject(event) ? event : {}
  const { tools, mcp_servers: servers, permissionMode } = report
  if (!Array.isArray(tools)) return { ok: false, reason: 'it did not report its tools' }
  const others = tools.map(nameOf).filter(name => name !== 'Bash')
  if (others.length > 0) return { ok: false, reason: `it has tools other than Bash: ${others.join(', ')}` }
  if (!tools.includes('Bash')) return { ok: false, reason: 'it does not have the Bash tool' }
  if (!Array.isArray(servers)) return { ok: false, reason: 'it did not report its MCP servers' }
  if (servers.length > 0) {
    const names = servers.map(server => (isObject(server) && typeof server.name === 'string' ? server.name : nameOf(server)))
    return { ok: false, reason: `it has MCP servers: ${names.join(', ')}` }
  }
  if (typeof permissionMode !== 'string') return { ok: false, reason: 'it did not report its permission mode' }
  if (permissionMode !== 'dontAsk') return { ok: false, reason: `its permission mode is ${permissionMode}, not dontAsk` }
  return { ok: true }
}

/**
 * The event reducer: `feed(line)` turns one stdout line into effects, `newTurn()` clears the mark that a text delta
 * arrived in this turn. Effects:
 *   { type: 'start', event }          a start report (checked by the manager)
 *   { type: 'text', text }            reply text, as it arrived
 *   { type: 'flush' }                 a text block ended; text waiting for a sentence end goes out
 *   { type: 'tool', command }         a Bash command the session runs
 *   { type: 'done', sessionId? }      the turn ended well
 *   { type: 'failed', reason, sessionId? }   the turn ended badly; reason is the result text or the subtype
 * A line that is blank, not JSON, not an object, nested (`parent_tool_use_id` set) or of an unnamed shape gives [].
 */
export function createReducer() {
  let sawDelta = false

  const streamEvent = inner => {
    if (!isObject(inner)) return []
    if (inner.type === 'content_block_stop') return [{ type: 'flush' }]
    if (inner.type !== 'content_block_delta' || !isObject(inner.delta)) return []
    if (inner.delta.type !== 'text_delta' || typeof inner.delta.text !== 'string') return []
    sawDelta = true
    return inner.delta.text === '' ? [] : [{ type: 'text', text: inner.delta.text }]
  }

  const assistant = message => {
    if (!isObject(message) || !Array.isArray(message.content)) return []
    const effects = []
    for (const block of message.content) {
      if (!isObject(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '' && !sawDelta) {
        // A claude that sends no deltas: the whole block is the reply text, and it is complete.
        effects.push({ type: 'text', text: block.text }, { type: 'flush' })
      } else if (block.type === 'tool_use' && block.name === 'Bash' && isObject(block.input) && typeof block.input.command === 'string') {
        effects.push({ type: 'tool', command: block.input.command })
      }
    }
    return effects
  }

  const result = event => {
    const id = typeof event.session_id === 'string' ? { sessionId: event.session_id } : {}
    if (event.subtype === 'success' && event.is_error !== true) return [{ type: 'flush' }, { type: 'done', ...id }]
    const reason = typeof event.result === 'string' && event.result.trim() !== '' ? event.result : String(event.subtype ?? 'unknown')
    return [{ type: 'flush' }, { type: 'failed', reason, ...id }]
  }

  const feed = line => {
    try {
      if (typeof line !== 'string' || line.trim() === '') return []
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return []
      }
      if (!isObject(event) || event.parent_tool_use_id != null) return []
      switch (event.type) {
        case 'system':
          return event.subtype === 'init' ? [{ type: 'start', event }] : []
        case 'stream_event':
          return streamEvent(event.event)
        case 'assistant':
          return assistant(event.message)
        case 'result':
          return result(event)
        default:
          return []
      }
    } catch {
      return []
    }
  }

  return {
    feed,
    newTurn() {
      sawDelta = false
    }
  }
}

const turnLine = text => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`

const firstLine = stderr =>
  String(stderr ?? '')
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''

const howItEnded = ({ code, signal }) => (code == null && signal ? `signal ${signal}` : `exit ${code}`)

const withLine = (text, stderr) => {
  const first = firstLine(stderr)
  return first ? `${text}: ${first}` : text
}

const TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval }

/**
 * The session manager. `on(event)` receives:
 *   { type: 'text', text } | { type: 'flush' } | { type: 'tool', command } | { type: 'error', message }
 *   { type: 'end', stopped }     once per turn: false after a result, true when the turn was cut
 *   { type: 'refused', reason }  once
 * → `{ start(), turn(text), stop() → boolean, shutdown() → Promise<void>, busy, refused }`.
 */
export function createEngine({ spawn, cwd, env, model, prompt, turnMs, uuid = randomUUID, timers = TIMERS, on = () => {} }) {
  const reducer = createReducer()
  let proc = null // the current process record; at most one is alive
  let sessionId = null // the id the conversation was started with (--session-id)
  let reportedId = null // the session_id the session last reported (start report or result)
  let busy = false
  let refused = false
  let ending = false // shutdown was asked for
  let queued = null // a turn accepted while a stopped process has not exited yet
  let timer = null
  let shutdownPromise = null
  let resolveShutdown = null

  const emit = event => {
    try {
      on(event)
    } catch {
      // A listener that throws must not break the session.
    }
  }

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  const alive = () => proc !== null && !proc.exited

  // End a process Dial chose to end: what it still writes is ignored, and its exit is not a crash.
  const end = record => {
    record.ignored = true
    if (!record.killed) {
      record.killed = true
      record.handle.kill()
    }
  }

  const write = (record, text) => {
    if (!record.reported) record.waiting = text
    record.handle.write(turnLine(text))
  }

  // mode: 'new' (a new --session-id), 'resume' (--resume the reported id), 'fresh' (a new id after a failed resume).
  const launch = mode => {
    let args
    if (mode === 'resume') {
      args = engineArgs({ model, prompt, sessionId: reportedId ?? sessionId, resume: true })
    } else {
      sessionId = uuid()
      reportedId = null
      args = engineArgs({ model, prompt, sessionId })
    }
    const record = { mode, handle: null, reported: false, ignored: false, killed: false, exited: false, waiting: null }
    proc = record
    record.handle = spawn('claude', args, {
      cwd,
      env,
      onLine: line => onLine(record, line),
      onExit: result => onExit(record, result)
    })
    return record
  }

  const refuse = reason => {
    if (refused) return
    refused = true
    busy = false
    queued = null
    clearTimer()
    if (proc) end(proc)
    emit({ type: 'refused', reason })
  }

  // Cut the running turn: the state is idle at once, and the process is ended and resumed after its exit.
  const cut = () => {
    busy = false
    queued = null
    clearTimer()
    if (alive()) end(proc)
    emit({ type: 'end', stopped: true })
  }

  const finish = () => {
    busy = false
    clearTimer()
    emit({ type: 'end', stopped: false })
  }

  const onLine = (record, line) => {
    if (record !== proc || record.ignored || refused || ending) return
    for (const effect of reducer.feed(line)) {
      if (record.ignored || refused || ending) return
      if (effect.type === 'start') {
        const check = checkStart(effect.event)
        if (!check.ok) return refuse(check.reason)
        record.reported = true
        record.waiting = null
        if (typeof effect.event.session_id === 'string') reportedId = effect.event.session_id
        continue
      }
      if (effect.type === 'flush' && !record.reported) continue
      if (!record.reported) return refuse('it answered before it reported how it started')
      if (effect.type === 'done' || effect.type === 'failed') {
        if (effect.sessionId) reportedId = effect.sessionId
        if (!busy) continue
        if (effect.type === 'failed') emit({ type: 'error', message: `the turn failed: ${effect.reason}` })
        finish()
        continue
      }
      if (busy) emit(effect)
    }
  }

  const onExit = (record, result) => {
    record.exited = true
    if (record !== proc) return
    if (ending) {
      resolveShutdown?.()
      return
    }
    if (refused) return
    if (record.ignored) {
      // Dial ended it (an interrupt or a timeout): resume at once so the next turn finds a warm session.
      const next = launch('resume')
      if (queued !== null) {
        const text = queued
        queued = null
        write(next, text)
      }
      return
    }
    // It ended by itself: end what remains of its group.
    record.killed = true
    record.handle.kill()
    if (!record.reported) {
      if (record.mode === 'resume') {
        emit({ type: 'error', message: 'the earlier conversation could not be resumed; this is a new one' })
        const next = launch('fresh')
        if (busy && record.waiting !== null) write(next, record.waiting)
        return
      }
      const reason = result?.error
        ? `claude could not be started (${result.error.code}: ${result.error.message})`
        : withLine(`claude exited before it started (${howItEnded(result ?? {})})`, result?.stderr)
      return refuse(reason)
    }
    if (busy) {
      emit({ type: 'error', message: withLine(`the session stopped (${howItEnded(result ?? {})})`, result?.stderr) })
      busy = false
      queued = null
      clearTimer()
      emit({ type: 'end', stopped: true })
    }
  }

  const engine = {
    /** Start the session once; a no-op with a live process, after a refusal, or on the way out. */
    start() {
      if (refused || ending || alive()) return
      launch(sessionId === null ? 'new' : 'resume')
    },

    /** Accept one turn and write it to the session, starting or resuming a process when none is alive. */
    turn(text) {
      if (refused) return { ok: false, reason: 'the session was refused' }
      if (busy) return { ok: false, reason: 'a turn is running' }
      if (ending) return { ok: false, reason: 'the session is ending' }
      busy = true
      reducer.newTurn()
      clearTimer()
      timer = timers.setTimeout(() => {
        timer = null
        if (!busy) return
        emit({ type: 'error', message: `the turn was stopped after ${Math.round(turnMs / 1000)} seconds` })
        cut()
      }, turnMs)
      if (alive() && proc.ignored) {
        queued = text // written to the process that replaces the stopped one
      } else if (alive()) {
        write(proc, text)
      } else {
        write(launch(sessionId === null ? 'new' : 'resume'), text)
      }
      return { ok: true }
    },

    /** Interrupt the running turn. → true when a turn was running and was cut. */
    stop() {
      if (refused || ending || !busy) return false
      cut()
      return true
    },

    /** End the live process and resolve once it has exited. Nothing is started afterwards. */
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      ending = true
      busy = false
      queued = null
      clearTimer()
      if (!alive()) {
        shutdownPromise = Promise.resolve()
        return shutdownPromise
      }
      shutdownPromise = new Promise(resolve => {
        resolveShutdown = resolve
      })
      end(proc)
      return shutdownPromise
    }
  }

  Object.defineProperties(engine, {
    busy: { get: () => busy, enumerable: true },
    refused: { get: () => refused, enumerable: true }
  })
  return engine
}
