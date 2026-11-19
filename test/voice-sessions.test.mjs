import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LOG_LINE_CHARS,
  announcements,
  attachScript,
  callReason,
  countRunning,
  createSessions,
  formatSessions,
  listSessions,
  parseAgents,
  runningIn,
  screenLines
} from '../lib/voice/sessions.mjs'
import { fakeSpawn, fakeTimers } from './helpers.mjs'

// The Claude Code sessions of `dial voice` (voice-sessions delta). lib/voice/sessions.mjs does not exist yet: every
// case here fails until task 2.5 adds it. The pure part comes first, then the manager run against fakeSpawn and
// fakeTimers with a recording writeFile.

const TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
const REPOS = [
  { name: 'katipon', path: '/repos/katipon' },
  { name: 'dial', path: '/repos/dial' }
]
const entry = (over = {}) => ({
  id: 'c7b0ada6',
  cwd: '/repos/katipon',
  kind: 'background',
  startedAt: 1794900099451,
  sessionId: 'c7b0ada6-b039-4dca-8847-cfb263166f6b',
  name: 'dial: /interlock:ship add-parser',
  state: 'blocked',
  waitingFor: 'permission prompt',
  ...over
})
const list = (entries, rows = 12) => listSessions(entries, { repos: REPOS, rows })
const session = (over = {}) => ({
  id: 'c7b0ada6',
  repo: 'katipon',
  cwd: '/repos/katipon',
  state: 'blocked',
  waitingFor: 'permission prompt',
  startedAt: '2026-11-17T07:21:39.451Z',
  prompt: '/interlock:ship add-parser',
  sessionId: 'c7b0ada6-b039-4dca-8847-cfb263166f6b',
  ...over
})

// ---------------------------------------------------------------- parseAgents
test('parseAgents: a JSON array gives its entries', () => {
  assert.deepEqual(parseAgents(JSON.stringify([entry()])), { ok: true, entries: [entry()] })
  assert.deepEqual(parseAgents('[]'), { ok: true, entries: [] })
})

test('parseAgents: {} and text that is not JSON are not a session list', () => {
  const bad = { ok: false, reason: 'claude agents did not print a session list' }
  assert.deepEqual(parseAgents('{}'), bad)
  assert.deepEqual(parseAgents('not json at all'), bad)
  assert.deepEqual(parseAgents(''), bad)
})

// ---------------------------------------------------------------- listSessions
// voice-sessions: "The session list holds the sessions Dial named".
test('one listed session carries the eight fields', () => {
  assert.deepEqual(list([entry()]), [session()])
})

test('a session working in a worktree of the repo shows the repo; one inside no repo has the repo null', () => {
  assert.equal(list([entry({ cwd: '/repos/katipon/.claude/worktrees/add-parser' })])[0].repo, 'katipon')
  assert.equal(list([entry({ cwd: '/elsewhere/x' })])[0].repo, null)
})

test('sessions Dial did not name are left out', () => {
  const out = list([
    entry({ id: 'aaaa1111', name: 'integration apps setup guide' }),
    entry({ id: 'bbbb2222', name: undefined }),
    entry({ id: 'cccc3333', kind: 'interactive' }),
    entry({ id: 'dddd4444' })
  ])
  assert.deepEqual(out.map(s => s.id), ['dddd4444'])
})

test('fields claude does not send become unknown and null', () => {
  const [s] = list([{ id: 'c7b0ada6', cwd: '/repos/katipon', kind: 'background', name: 'dial: x', startedAt: 'yesterday' }])
  assert.equal(s.state, 'unknown')
  assert.equal(s.waitingFor, null)
  assert.equal(s.sessionId, null)
  assert.equal(s.startedAt, null)
})

test('a state Dial does not know is passed through as text', () => {
  assert.equal(list([entry({ state: 'paused' })])[0].state, 'paused')
})

test('an id that is not safe to pass on is not listed', () => {
  assert.deepEqual(list([entry({ id: 'a b' }), entry({ id: '../x' }), entry({ id: '' }), entry({ id: 'x'.repeat(65) })]), [])
  assert.equal(list([entry({ id: 'a_B-9' }), entry({ id: 'x'.repeat(64) })]).length, 2)
})

test('newest first and capped to rows, a null startedAt last', () => {
  const entries = Array.from({ length: 15 }, (_, i) => entry({ id: `s${String(i).padStart(2, '0')}`, startedAt: 1_000_000 + i * 1000 }))
  entries.push(entry({ id: 'nodate', startedAt: undefined }))
  const out = list(entries, 12)
  assert.equal(out.length, 12)
  assert.deepEqual(out.slice(0, 3).map(s => s.id), ['s14', 's13', 's12'])
  assert.equal(out.at(-1).id, 's03')
  const few = list([entry({ id: 'nodate', startedAt: undefined }), entry({ id: 'dated' })], 12)
  assert.deepEqual(few.map(s => s.id), ['dated', 'nodate'])
})

test('a secret in a prompt is redacted', () => {
  const [s] = list([entry({ name: `dial: deploy with token ${TOKEN}` })])
  assert.doesNotMatch(s.prompt, /ghp_/)
})

// ---------------------------------------------------------------- countRunning, runningIn
// voice-sessions: "The number of running sessions is bounded".
test('countRunning counts working and blocked sessions only, and runningIn asks about one repo', () => {
  const sessions = [
    session({ id: 'a1', state: 'working' }),
    session({ id: 'b2', state: 'blocked', repo: 'dial' }),
    session({ id: 'c3', state: 'done' }),
    session({ id: 'd4', state: 'failed' }),
    session({ id: 'e5', state: 'stopped' })
  ]
  assert.equal(countRunning(sessions), 2)
  assert.equal(runningIn(sessions, 'katipon'), true)
  assert.equal(runningIn(sessions, 'dial'), true)
  assert.equal(runningIn(sessions, 'other'), false)
  assert.equal(runningIn(sessions.filter(s => s.repo === 'katipon' && s.state !== 'working'), 'katipon'), false, 'finished sessions do not count')
  assert.equal(countRunning([]), 0)
})

// ---------------------------------------------------------------- announcements
// voice-sessions: "A session that needs the owner or has ended is announced".
test('the first list announces nothing', () => {
  assert.deepEqual(announcements(null, [session({ state: 'blocked' }), session({ id: 'b2', state: 'done' })]), [])
})

test('a permission prompt, with and without a reason', () => {
  const before = [session({ state: 'working', waitingFor: null })]
  assert.deepEqual(announcements(before, [session({ state: 'blocked' })]), ['The session in katipon needs you: permission prompt.'])
  assert.deepEqual(announcements(before, [session({ state: 'blocked', waitingFor: null })]), ['The session in katipon needs you.'])
})

test('a finished turn names the repo, or says A Dial session when there is none', () => {
  const working = [session({ id: 'x1', repo: 'dial', state: 'working', waitingFor: null })]
  assert.deepEqual(announcements(working, [session({ id: 'x1', repo: 'dial', state: 'done', waitingFor: null })]), ['The session in dial has finished its turn.'])
  const orphan = [session({ id: 'x2', repo: null, state: 'working', waitingFor: null })]
  assert.deepEqual(announcements(orphan, [session({ id: 'x2', repo: null, state: 'done', waitingFor: null })]), ['A Dial session has finished its turn.'])
})

test('a session already waiting is not announced again', () => {
  const same = [session({ state: 'blocked' }), session({ id: 'b2', state: 'done', waitingFor: null })]
  assert.deepEqual(announcements(same, same), [])
})

test('a session that appears for the first time failed is announced', () => {
  assert.deepEqual(announcements([], [session({ id: 'n1', state: 'failed', waitingFor: null })]), ['The session in katipon failed.'])
})

test('working and stopped are not announced', () => {
  assert.deepEqual(announcements([session({ state: 'blocked' })], [session({ state: 'working', waitingFor: null })]), [])
  assert.deepEqual(announcements([session({ state: 'working', waitingFor: null })], [session({ state: 'stopped', waitingFor: null })]), [])
})

// ---------------------------------------------------------------- screenLines
// voice-sessions: "The page can read a session's screen as text".
test('colour codes, an OSC title and CRLF are removed', () => {
  assert.deepEqual(screenLines('\u001b[1m\u001b[32m● Running tests\u001b[0m\r\n\u001b]0;title\u0007  12 passed', { lines: 200 }), ['● Running tests', '  12 passed'])
})

test('an OSC title ended by ESC backslash is removed too', () => {
  assert.deepEqual(screenLines('\u001b]0;title\u001b\\hello', { lines: 200 }), ['hello'])
})

test('only the last lines are kept', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const out = screenLines(text, { lines: 200 })
  assert.equal(out.length, 200)
  assert.equal(out[0], 'line 300')
  assert.equal(out.at(-1), 'line 499')
})

test('each line is cut to LOG_LINE_CHARS, which is 400', () => {
  assert.equal(LOG_LINE_CHARS, 400)
  const [line] = screenLines('x'.repeat(1000), { lines: 200 })
  assert.equal(line.length, 400)
})

test('trailing blank lines are dropped', () => {
  assert.deepEqual(screenLines('a\nb\n\n\n', { lines: 200 }), ['a', 'b'])
  assert.deepEqual(screenLines('\n\n', { lines: 200 }), [])
})

test('a secret on the screen is redacted', () => {
  const out = screenLines(`export GITHUB_TOKEN=${TOKEN}\nok`, { lines: 200 })
  assert.doesNotMatch(out.join('\n'), /ghp_/)
  assert.equal(out.at(-1), 'ok')
})

test('a lone escape character and an unfinished sequence at the end leave no control character behind', () => {
  for (const text of ['abc\u001b', 'abc\u001b[', 'abc\u001b[1;3', 'abc\u001b]0;tit', 'a\u0007b\u0000c']) {
    const out = screenLines(text, { lines: 200 })
    assert.doesNotMatch(out.join('\n'), /[\u0000-\u0008\u000b-\u001f\u007f]/, JSON.stringify(text))
  }
  assert.deepEqual(screenLines('abc\u001b', { lines: 200 }), ['abc'])
  assert.deepEqual(screenLines('abc\u001b[1;3', { lines: 200 }), ['abc'])
  assert.deepEqual(screenLines('a\u0007b\u0000c', { lines: 200 }), ['abc'])
})

// ---------------------------------------------------------------- attachScript
// voice-sessions: "The Terminal control opens a session in a terminal window".
test('attachScript: the two lines with the path in single quotes', () => {
  assert.equal(attachScript('/opt/homebrew/bin/claude', 'c7b0ada6'), "#!/bin/sh\nexec '/opt/homebrew/bin/claude' attach c7b0ada6\n")
})

test('attachScript: a quote in the path is closed, escaped and opened again', () => {
  assert.equal(attachScript("/Users/o'brien/bin/claude", 'c7b0ada6'), "#!/bin/sh\nexec '/Users/o'\\''brien/bin/claude' attach c7b0ada6\n")
})

// ---------------------------------------------------------------- formatSessions
// voice-sessions: "Two sessions as text", "No sessions".
test('formatSessions: one line per session in the order given, and a dash for no repo', () => {
  const out = formatSessions([
    session(),
    session({ id: '0f3e9a11', repo: 'dial', state: 'done', waitingFor: null, startedAt: '2026-11-17T06:02:10.000Z', prompt: '/interlock:spec add voice capture' })
  ])
  assert.equal(
    out,
    'c7b0ada6  katipon  blocked (permission prompt)  2026-11-17T07:21:39.451Z  /interlock:ship add-parser\n' +
      '0f3e9a11  dial  done  2026-11-17T06:02:10.000Z  /interlock:spec add voice capture\n'
  )
  assert.match(formatSessions([session({ repo: null })]), /^c7b0ada6 {2}- {2}blocked/)
})

test('formatSessions: no sessions', () => {
  assert.equal(formatSessions([]), 'no dial sessions\n')
})

// ---------------------------------------------------------------- callReason
// voice-sessions: "A start that fails is reported in claude's own words", "A list that cannot be read is reported once".
const failed = (over = {}) => ({ ok: false, code: 1, signal: null, stdout: '', stderr: '', missing: false, timedOut: false, error: null, ...over })

test('callReason: an exit code with the first stderr line', () => {
  assert.equal(
    callReason('--bg', failed({ stderr: 'Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.\nmore\n' }), 10),
    'claude --bg failed (exit 1): Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.'
  )
  assert.equal(callReason('agents', failed({ stderr: "\n  error: unknown option '--json'\n" }), 10), "claude agents failed (exit 1): error: unknown option '--json'")
})

test('callReason: stdout only, and nothing at all', () => {
  assert.equal(callReason('--bg', failed({ stdout: '\nWorkspace not trusted.\nnext' }), 10), 'claude --bg failed (exit 1): Workspace not trusted.')
  assert.equal(callReason('--bg', failed(), 10), 'claude --bg failed (exit 1)')
})

test('callReason: a signal', () => {
  const reason = callReason('logs', failed({ code: null, signal: 'SIGKILL' }), 10)
  assert.ok(reason.startsWith('claude logs failed ('), reason)
  assert.match(reason, /SIGKILL/)
})

test('callReason: a timeout names the seconds waited', () => {
  assert.equal(callReason('--bg', failed({ code: null, signal: 'SIGTERM', timedOut: true }), 10), 'claude --bg did not answer in 10 seconds')
  assert.equal(callReason('agents', failed({ code: null, timedOut: true }), 10), 'claude agents did not answer in 10 seconds')
})

test('callReason: a program that could not be started', () => {
  const reason = callReason('--bg', failed({ code: null, missing: true, error: { code: 'ENOENT', message: 'spawn claude ENOENT' } }), 10)
  assert.ok(reason.startsWith('claude could not be started (ENOENT: '), reason)
})

// ---------------------------------------------------------------- the manager
const LIMITS = { voiceSessions: 3, voiceSessionPollSeconds: 5, voiceSessionRows: 12, voiceLogLines: 200, subprocessTimeoutSeconds: 10 }
const CLAUDE = '/opt/homebrew/bin/claude'
const ENV = { PATH: '/usr/bin', HOME: '/home/o' }
const flush = () => new Promise(resolve => setImmediate(resolve))

function make({ platform = 'darwin', limits = LIMITS, repos = () => REPOS } = {}) {
  const { spawn, children } = fakeSpawn()
  const clock = fakeTimers()
  const events = []
  const writes = []
  const manager = createSessions({
    spawn,
    timers: clock.timers,
    env: ENV,
    limits,
    repos,
    claudePath: CLAUDE,
    platform,
    tmpdir: '/tmp/dialtmp',
    writeFile: (path, text, options) => {
      writes.push({ path, text, options })
    },
    on: event => events.push(event)
  })
  const ofType = type => events.filter(e => e.type === type)
  const calls = (...args) => children.filter(c => args.every((a, i) => c.args[i] === a))
  return { manager, children, events, writes, advance: clock.advance, ofType, calls }
}

// Answer the newest child with a list of entries and let the manager settle.
async function answer(t, entries, child = t.children.at(-1)) {
  assert.deepEqual(child.args.slice(0, 3), ['agents', '--json', '--all'])
  child.line(JSON.stringify(entries))
  child.exit({ code: 0 })
  await flush()
}
// A manager that has read one list.
async function loaded(entries = [entry({ state: 'working', waitingFor: undefined })], options) {
  const t = make(options)
  const read = t.manager.read()
  await answer(t, entries)
  await read
  return t
}

// voice-sessions: "The list is read while a page is connected and sent when it changes".
test('the first page: agents --json --all runs once with claude at claudePath, and again every pollSeconds', async () => {
  const t = make()
  t.manager.watch(true)
  assert.equal(t.children.length, 1)
  assert.equal(t.children[0].file, CLAUDE)
  assert.deepEqual(t.children[0].args, ['agents', '--json', '--all'])
  await answer(t, [])
  t.advance(5000)
  assert.equal(t.children.length, 2)
  await answer(t, [])
  t.advance(5000)
  assert.equal(t.children.length, 3)
})

test('the poll interval is read from the caps', async () => {
  const t = make({ limits: { ...LIMITS, voiceSessionPollSeconds: 2 } })
  t.manager.watch(true)
  await answer(t, [])
  t.advance(1999)
  assert.equal(t.children.length, 1)
  t.advance(1)
  assert.equal(t.children.length, 2)
})

test('a read that is still running is not started twice', async () => {
  const t = make()
  t.manager.watch(true)
  t.advance(15_000)
  assert.equal(t.children.length, 1, 'the first read has not returned')
  const second = t.manager.read()
  assert.equal(t.children.length, 1, 'read() while a read runs starts nothing')
  await answer(t, [])
  await second
})

test('no page connected: nothing is read after watch(false)', async () => {
  const t = make()
  t.manager.watch(true)
  await answer(t, [])
  t.manager.watch(false)
  t.advance(60_000)
  assert.equal(t.children.length, 1)
  t.manager.watch(true)
  assert.equal(t.children.length, 2, 'a page connecting again reads at once')
})

test('a changed list is sent whole, an unchanged one is not sent again', async () => {
  const t = make()
  t.manager.watch(true)
  await answer(t, [entry({ state: 'working', waitingFor: undefined })])
  assert.equal(t.ofType('sessions').length, 1)
  assert.deepEqual(t.ofType('sessions')[0].sessions.map(s => [s.id, s.state]), [['c7b0ada6', 'working']])
  t.advance(5000)
  await answer(t, [entry({ state: 'working', waitingFor: undefined })])
  assert.equal(t.ofType('sessions').length, 1, 'nothing changed')
  t.advance(5000)
  await answer(t, [entry({ state: 'done', waitingFor: undefined })])
  assert.equal(t.ofType('sessions').length, 2)
  assert.equal(t.ofType('sessions')[1].sessions[0].state, 'done')
})

test('list holds the list last read', async () => {
  const t = await loaded([entry({ state: 'working', waitingFor: undefined }), entry({ id: 'b2b2b2b2', startedAt: 5 })])
  assert.deepEqual(t.manager.list.map(s => s.id), ['c7b0ada6', 'b2b2b2b2'])
})

// voice-sessions: "A list that cannot be read is reported once".
test('a failing read keeps the list and sends one error in claude\'s words, not again until a read succeeds', async () => {
  const t = await loaded()
  const before = t.manager.list
  // the watch is off, so every read here is explicit
  const failRead = async () => {
    const p = t.manager.read()
    const child = t.children.at(-1)
    child.exit({ code: 1, stderr: "error: unknown option '--json'\n" })
    await p
  }
  await failRead()
  assert.deepEqual(t.ofType('error').map(e => e.message), ["could not list sessions: claude agents failed (exit 1): error: unknown option '--json'"])
  assert.deepEqual(t.manager.list, before)
  await failRead()
  await failRead()
  await failRead()
  assert.equal(t.ofType('error').length, 1, 'the same failure is not reported again')
  const ok = t.manager.read()
  await answer(t, [entry({ state: 'working', waitingFor: undefined })])
  await ok
  await failRead()
  assert.equal(t.ofType('error').length, 2, 'reported again after a read succeeded')
})

test('output that is not a list is reported as such', async () => {
  const t = make()
  const p = t.manager.read()
  t.children[0].line('{}')
  t.children[0].exit({ code: 0 })
  await p
  assert.deepEqual(t.ofType('error').map(e => e.message), ['could not list sessions: claude agents did not print a session list'])
})

test('a read that hangs is ended after subprocessTimeoutSeconds and counts as failed', async () => {
  const t = make()
  const p = t.manager.read()
  t.advance(9999)
  assert.equal(t.children[0].killed, false)
  t.advance(1)
  assert.equal(t.children[0].killed, true)
  t.children[0].exit({ code: null, signal: 'SIGTERM' })
  await p
  assert.deepEqual(t.ofType('error').map(e => e.message), ['could not list sessions: claude agents did not answer in 10 seconds'])
})

test('a claude that cannot be started is reported', async () => {
  const t = make()
  const p = t.manager.read()
  t.children[0].exit({ code: null, error: { code: 'ENOENT', message: 'spawn claude ENOENT' } })
  await p
  assert.match(t.ofType('error')[0].message, /^could not list sessions: claude could not be started \(ENOENT: /)
})

// voice-sessions: "A session that needs the owner or has ended is announced".
test('the first read announces nothing and a later change raises its notice', async () => {
  const t = make()
  t.manager.watch(true)
  await answer(t, [entry({ state: 'blocked' })])
  assert.deepEqual(t.ofType('notice'), [], 'sessions that were already waiting are not announced')
  t.advance(5000)
  await answer(t, [entry({ state: 'blocked' })])
  assert.deepEqual(t.ofType('notice'), [])
  t.advance(5000)
  await answer(t, [entry({ state: 'working', waitingFor: undefined })])
  t.advance(5000)
  await answer(t, [entry({ state: 'blocked' })])
  assert.deepEqual(t.ofType('notice'), [{ type: 'notice', text: 'The session in katipon needs you: permission prompt.' }])
})

// voice-sessions: "A confirmed proposal starts one claude background session".
const PROPOSAL = { repo: 'katipon', path: '/repos/katipon', prompt: '/interlock:ship add-parser' }

test('start runs claude with exactly the four arguments in the repo path with the env, and reads the list at once on exit 0', async () => {
  const t = make()
  const started = t.manager.start(PROPOSAL)
  assert.equal(t.children.length, 1)
  const [child] = t.children
  assert.equal(child.file, CLAUDE)
  assert.deepEqual(child.args, ['--bg', '--name', 'dial: /interlock:ship add-parser', '/interlock:ship add-parser'])
  assert.equal(child.cwd, '/repos/katipon')
  assert.deepEqual(child.env, ENV)
  child.line('backgrounded · c7b0ada6')
  child.exit({ code: 0 })
  assert.deepEqual(await started, { ok: true })
  assert.equal(t.children.length, 2, 'the list is read at once')
  assert.deepEqual(t.children[1].args, ['agents', '--json', '--all'])
})

test('start passes a long prompt unchanged and names the session from its first 60 characters', async () => {
  const t = make()
  const prompt = `${'a'.repeat(100)}\n${'b'.repeat(100)}\n${'c'.repeat(100)}`
  void t.manager.start({ ...PROPOSAL, prompt })
  assert.equal(t.children[0].args[3], prompt)
  assert.equal(t.children[0].args[2], `dial: ${'a'.repeat(60)}`)
})

test('start passes no flag that overrides the owner\'s setup', async () => {
  const t = make()
  void t.manager.start(PROPOSAL)
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', '--model', '--settings', '--worktree', '--safe-mode', '--restricted', '-p']) {
    assert.equal(t.children[0].args.includes(flag), false, flag)
  }
})

test('a start that exits non-zero gives claude\'s own words, with stderr first and stdout second, and no second run', async () => {
  const t = make()
  const started = t.manager.start(PROPOSAL)
  t.children[0].exit({ code: 1, stderr: 'Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.\n' })
  assert.deepEqual(await started, {
    ok: false,
    reason: 'claude --bg failed (exit 1): Workspace not trusted. Run claude in /repos/katipon once and accept the trust prompt, then retry.'
  })
  const second = make()
  const again = second.manager.start(PROPOSAL)
  second.children[0].line('Workspace not trusted.')
  second.children[0].exit({ code: 1 })
  assert.equal((await again).reason, 'claude --bg failed (exit 1): Workspace not trusted.')
  assert.equal(t.calls('--bg').length, 1, 'no second run')
  assert.equal(t.children.length, 1)
})

test('a start that cannot run claude says so, and one that hangs is ended after subprocessTimeoutSeconds', async () => {
  const missing = make()
  const a = missing.manager.start(PROPOSAL)
  missing.children[0].exit({ code: null, error: { code: 'ENOENT', message: 'spawn claude ENOENT' } })
  const lost = await a
  assert.equal(lost.ok, false)
  assert.ok(lost.reason.startsWith('claude could not be started (ENOENT: '), lost.reason)
  const hung = make()
  const b = hung.manager.start(PROPOSAL)
  hung.advance(10_000)
  assert.equal(hung.children[0].killed, true)
  hung.children[0].exit({ code: null, signal: 'SIGTERM' })
  assert.deepEqual(await b, { ok: false, reason: 'claude --bg did not answer in 10 seconds' })
  assert.equal(hung.calls('--bg').length, 1)
})

// voice-sessions: "The page can read a session's screen as text", "Stop ends a session through claude".
test('log runs claude logs <id> and answers the cleaned lines', async () => {
  const t = await loaded()
  const p = t.manager.log('c7b0ada6')
  const child = t.children.at(-1)
  assert.deepEqual(child.args, ['logs', 'c7b0ada6'])
  child.line('\u001b[1m● Running tests\u001b[0m')
  child.line('  12 passed')
  child.exit({ code: 0 })
  assert.deepEqual(await p, { status: 200, body: { ok: true, id: 'c7b0ada6', lines: ['● Running tests', '  12 passed'] } })
})

test('log of an id that is not listed is 404 no such session and runs nothing', async () => {
  const t = await loaded()
  const before = t.children.length
  const answerFor = await t.manager.log('ffffffff')
  assert.equal(answerFor.status, 404)
  assert.equal(answerFor.body.reason, 'no such session')
  assert.equal((await t.manager.log(undefined)).status, 404)
  assert.equal(t.children.length, before)
})

test('log that fails is 502 with claude\'s own words', async () => {
  const t = await loaded()
  const p = t.manager.log('c7b0ada6')
  t.children.at(-1).exit({ code: 1, stderr: 'No such session\n' })
  const out = await p
  assert.equal(out.status, 502)
  assert.equal(out.body.reason, 'claude logs failed (exit 1): No such session')
})

test('stop runs claude stop <id>, answers 200 and reads the list at once', async () => {
  const t = await loaded()
  const p = t.manager.stop('c7b0ada6')
  const child = t.children.at(-1)
  assert.deepEqual(child.args, ['stop', 'c7b0ada6'])
  child.exit({ code: 0 })
  const out = await p
  assert.deepEqual(out, { status: 200, body: { ok: true } })
  assert.deepEqual(t.children.at(-1).args, ['agents', '--json', '--all'])
})

test('stop of an id that is not listed is 409 no such session and runs nothing', async () => {
  const t = await loaded()
  const before = t.children.length
  const out = await t.manager.stop('ffffffff')
  assert.equal(out.status, 409)
  assert.equal(out.body.reason, 'no such session')
  assert.equal(t.children.length, before)
})

test('stop that fails is 502 with the first stderr line', async () => {
  const t = await loaded()
  const p = t.manager.stop('c7b0ada6')
  t.children.at(-1).exit({ code: 1, stderr: 'already stopped\n' })
  const out = await p
  assert.equal(out.status, 502)
  assert.equal(out.body.reason, 'claude stop failed (exit 1): already stopped')
})

// voice-sessions: "The Terminal control opens a session in a terminal window".
test('attach on macOS writes the .command file with mode 0700 and runs open with its path', async () => {
  const t = await loaded()
  const p = t.manager.attach('c7b0ada6')
  await flush()
  assert.equal(t.writes.length, 1)
  assert.equal(t.writes[0].path, '/tmp/dialtmp/dial-attach-c7b0ada6.command')
  assert.equal(t.writes[0].text, attachScript(CLAUDE, 'c7b0ada6'))
  assert.equal(t.writes[0].options.mode, 0o700)
  const child = t.children.at(-1)
  assert.equal(child.file, 'open')
  assert.deepEqual(child.args, ['/tmp/dialtmp/dial-attach-c7b0ada6.command'])
  child.exit({ code: 0 })
  assert.deepEqual(await p, { status: 200, body: { ok: true } })
})

test('attach on Linux is 409 with the command to run, and writes and runs nothing', async () => {
  const t = await loaded(undefined, { platform: 'linux' })
  const before = t.children.length
  const out = await t.manager.attach('c7b0ada6')
  assert.equal(out.status, 409)
  assert.equal(out.body.reason, 'run this in a terminal: claude attach c7b0ada6')
  assert.equal(t.writes.length, 0)
  assert.equal(t.children.length, before)
})

test('attach of an id that is not listed is 409 no such session', async () => {
  const t = await loaded()
  const out = await t.manager.attach('ffffffff')
  assert.equal(out.status, 409)
  assert.equal(out.body.reason, 'no such session')
  assert.equal(t.writes.length, 0)
})

test('attach whose opener fails is 502 could not open a terminal with its line', async () => {
  const t = await loaded()
  const p = t.manager.attach('c7b0ada6')
  await flush()
  t.children.at(-1).exit({ code: 1, stderr: 'The application cannot be opened\n' })
  const out = await p
  assert.equal(out.status, 502)
  assert.equal(out.body.reason, 'could not open a terminal: The application cannot be opened')
})

// voice-sessions: "Every claude call is bounded and started sessions are left running".
test('a log call that outlives subprocessTimeoutSeconds is killed', async () => {
  const t = await loaded()
  const p = t.manager.log('c7b0ada6')
  t.advance(10_000)
  assert.equal(t.children.at(-1).killed, true)
  t.children.at(-1).exit({ code: null, signal: 'SIGTERM' })
  assert.equal((await p).status, 502)
})

test('shutdown kills calls in flight, resolves after they exit, and never runs claude stop', async () => {
  const t = make()
  t.manager.watch(true)
  const started = t.manager.start(PROPOSAL)
  let done = false
  const shut = t.manager.shutdown().then(() => {
    done = true
  })
  assert.ok(t.children.every(c => c.killed), 'every call in flight was killed')
  await flush()
  assert.equal(done, false, 'it waits for the exits')
  for (const child of t.children) child.exit({ code: null, signal: 'SIGTERM' })
  await shut
  await started
  assert.equal(done, true)
  assert.equal(t.calls('stop').length, 0)
  t.advance(60_000)
  assert.equal(t.children.length, 2, 'nothing is read after shutdown')
})

test('shutdown with nothing running resolves at once', async () => {
  const t = make()
  await t.manager.shutdown()
  assert.equal(t.children.length, 0)
})

test('the registry is asked at every read, so a change is seen', async () => {
  let repos = []
  const t = make({ repos: () => repos })
  const first = t.manager.read()
  await answer(t, [entry({ state: 'working', waitingFor: undefined })])
  await first
  assert.equal(t.manager.list[0].repo, null)
  repos = REPOS
  const second = t.manager.read()
  await answer(t, [entry({ state: 'working', waitingFor: undefined })])
  await second
  assert.equal(t.manager.list[0].repo, 'katipon')
})
