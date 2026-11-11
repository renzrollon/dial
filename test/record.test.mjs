/**
 * `dial record` (specs/handoff-and-narrative, the record requirements; specs/dial-home,
 * "A writing command ensures the home before it writes anything else"): the hook
 * payload, sync then a conditional narrate, the 55-second deadline driven by an
 * injected clock, and exit 0 on every path.
 */
// Local times in these in-process tests are read in UTC, as the harness runs the CLI.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NO_TIME } from '../lib/narrate.mjs'
import { callBudget, parsePayload, record, transcriptPath } from '../lib/record.mjs'
import { slugOf } from '../lib/sources/sessions.mjs'
import { BIN, fakeExec, fakeFetch, makeHome, makeRepo, makeVault, snapshotTree, tmp } from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const FIVE = 'Done: a\nDecided: b\nNext: c\nBlocked: none\nOpen: none'
const reply = content => ({ status: 200, body: { choices: [{ message: { content } }] } })

/** A vault, a repo `katipon` with one active change `add-login`, a registry, a home, and a transcript starting 14:00Z. */
function setup({ notes = [] } = {}) {
  const root = tmp('record-')
  const vault = makeVault(join(root, 'personal'), notes)
  const repo = makeRepo(join(root, 'code', 'katipon'), { changes: { 'add-login': { tasks: { done: 0, total: 1 } } } })
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: repo, vault: 'personal', host: 'github' }], limits: {} }
  const home = makeHome({ registry })
  const userHome = join(root, 'user')
  mkdirSync(userHome)
  const transcript = join(root, 'session.jsonl')
  writeTranscript(transcript, '2026-11-10T14:00:00.000Z')
  return { root, vault, repo, registry, home, userHome, transcript, env: { HOME: userHome, DIAL_HOME: home } }
}

function writeTranscript(path, start) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    { type: 'user', timestamp: start, message: { content: 'please wire the form' } },
    { type: 'assistant', timestamp: start, message: { id: 'm1', content: [{ type: 'text', text: 'wired' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
}

const changeNote = entryHeading => ({
  path: 'Changes/katipon--add-login.md',
  frontmatter: 'type: change\nrepo: katipon\nchange: add-login\nstate: spec-draft',
  body: `\n## Next\n\n## Narrative\n\n${entryHeading}\nDone: earlier\n\n`,
})

/** A clock in milliseconds and a timer that fires at once, moving the clock by the bound it was given. */
function virtualTime(startMs = Date.parse('2026-11-10T16:00:00Z')) {
  let ms = startMs
  const bounds = []
  return {
    start: startMs,
    clock: () => ms,
    advance: by => { ms += by },
    bounds,
    setTimer: (fn, bound) => {
      bounds.push(bound)
      ms += bound
      return setTimeout(fn, 0)
    },
    clearTimer: clearTimeout,
  }
}

function runRecord(s, payload, extra = {}) {
  return record({
    event: 'SessionEnd', payload, registry: s.registry, env: s.env, home: s.home, now: new Date('2026-11-10T16:50:00Z'),
    exec: fakeExec({}), ...extra,
  })
}

/** Run the CLI with `input` piped to stdin. */
function runWithInput(args, env, input) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('cli-home-'), TZ: 'UTC', ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    child.stdin.end(input)
  })
}

// --- the pieces -------------------------------------------------------------------

test('a payload is a JSON object; empty, malformed or non-object input is {}', () => {
  assert.deepEqual(parsePayload('{"cwd":"/x"}'), { cwd: '/x' })
  for (const bad of ['', '  ', '{nope', '[1]', 'null', '42']) assert.deepEqual(parsePayload(bad), {})
})

test('each call is bounded by the smaller of the timeout and the time left minus two seconds; none under five', () => {
  let now = 0
  const budget = callBudget({ clock: () => now, deadline: 55_000, limits: { narrateTimeoutSeconds: 30 } })
  assert.equal(budget(), 30_000)
  now = 40_000
  assert.equal(budget(), 13_000)
  now = 50_001
  assert.equal(budget(), null)
})

test('the transcript is transcript_path, else ~/.claude/projects/<slug>/<session_id>.jsonl', () => {
  assert.equal(transcriptPath({ transcript_path: '/t.jsonl', session_id: 'abc' }, '/r', { HOME: '/h' }), '/t.jsonl')
  assert.equal(transcriptPath({ session_id: 'abc' }, '/Users/caro/IdeaProjects/katipon', { HOME: '/h' }), '/h/.claude/projects/-Users-caro-IdeaProjects-katipon/abc.jsonl')
  assert.equal(transcriptPath({}, '/r', { HOME: '/h' }), null)
})

// --- the deadline -----------------------------------------------------------------

test('a slow primary leaves the fallback only the time left, and record ends inside the deadline', async () => {
  const s = setup()
  mkdirSync(join(s.userHome, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(s.userHome, '.pi', 'agent', 'models.json'), JSON.stringify({ providers: { mtplx: { baseUrl: 'http://127.0.0.1:8000/v1', models: [{ id: 'm' }] } } }))
  const time = virtualTime()
  const sync = () => {
    time.advance(10_000)
    return { ok: true }
  }
  const fetch = fakeFetch(['hang', 'hang'])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, {
    sync, fetch, clock: time.clock, setTimer: time.setTimer, clearTimer: time.clearTimer, limits: { narrateTimeoutSeconds: 30, narrateTurns: 20 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.narrated, false)
  assert.equal(fetch.calls.length, 2)
  assert.deepEqual(time.bounds, [30_000, 13_000])
  assert.ok(time.clock() - time.start <= 55_000, `ended ${time.clock() - time.start}ms after the start`)
  assert.equal(r.unobserved, 'http://127.0.0.1:11434/v1 timed out after 13s')
})

test('no model call when under five seconds remain, nothing written, no error', async () => {
  const s = setup()
  const time = virtualTime()
  const sync = () => {
    time.advance(52_000)
    return { ok: true }
  }
  const before = snapshotTree(s.vault)
  const fetch = fakeFetch([])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, { sync, fetch, clock: time.clock, setTimer: time.setTimer })
  assert.equal(fetch.calls.length, 0)
  assert.deepEqual(r, { ok: true, repo: 'katipon', synced: true, narrated: false, unobserved: NO_TIME })
  assert.deepEqual(snapshotTree(s.vault), before)
})

// --- sync, then narrate only when no handoff was written --------------------------

test('a session already handed off is synced and not narrated', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-10 16:40 · /dial:handoff (claude)')] })
  const fetch = fakeFetch([])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, { fetch })
  assert.equal(r.ok, true)
  assert.equal(r.synced, true)
  assert.equal(r.narrated, false)
  assert.equal(fetch.calls.length, 0)
  assert.ok(existsSync(join(s.vault, 'Projects', 'katipon.md')), 'the sync wrote the repo note')
})

test('a session with no handoff since it began is synced, then narrated onto the attributed note', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-09 10:00 · dial handoff')] })
  const fetch = fakeFetch([reply(FIVE)])
  const r = await runRecord(s, { cwd: join(s.repo), transcript_path: s.transcript }, { fetch })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.narrated, true)
  assert.equal(r.wikilink, '[[katipon--add-login]]')
  assert.equal(fetch.calls.length, 1)
  const text = readFileSync(join(s.vault, 'Changes', 'katipon--add-login.md'), 'utf8')
  assert.match(text, /## Narrative\n\n### 2026-11-10 16:50 · local model \(qwen3\.6\)\nDone: a\n/)
  assert.match(text, /### 2026-11-09 10:00 · dial handoff\nDone: earlier\n/)
})

test('without transcript_path the transcript is found from session_id under the cwd slug', async () => {
  const s = setup()
  writeTranscript(join(s.userHome, '.claude', 'projects', slugOf(s.repo), 'abc.jsonl'), '2026-11-10T14:00:00.000Z')
  const fetch = fakeFetch([reply(FIVE)])
  const r = await runRecord(s, { cwd: s.repo, session_id: 'abc' }, { fetch })
  assert.equal(r.narrated, true, JSON.stringify(r))
  assert.equal(fetch.calls.length, 1)
})

test('an unregistered cwd is silent and touches nothing', async () => {
  const s = setup()
  const before = { vault: snapshotTree(s.vault), home: snapshotTree(s.home) }
  const sync = () => assert.fail('no sync for an unregistered cwd')
  const r = await runRecord(s, { cwd: tmp('scratch-') }, { sync, fetch: fakeFetch([]) })
  assert.deepEqual(r, { ok: true, silent: true })
  assert.deepEqual({ vault: snapshotTree(s.vault), home: snapshotTree(s.home) }, before)
})

test('a failed sync is the one error and narrate is not run', async () => {
  const s = setup()
  s.registry.vaults.personal = join(s.root, 'gone')
  const fetch = fakeFetch([])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, { fetch })
  assert.equal(r.ok, false)
  assert.equal(r.error, `vault personal for katipon does not exist: ${join(s.root, 'gone')}`)
  assert.equal(fetch.calls.length, 0)
})

test('a bad event is refused in the result', async () => {
  const s = setup()
  assert.deepEqual(await record({ event: 'Stop', payload: {}, registry: s.registry }), { ok: false, error: 'record needs --event SessionEnd or PreCompact' })
})

// --- the command ------------------------------------------------------------------

test('record from an unregistered cwd prints nothing, exits 0 and creates no home', async () => {
  const home = join(tmp(), 'never-created')
  const r = await runWithInput(['record', '--event', 'SessionEnd'], { DIAL_HOME: home }, JSON.stringify({ cwd: tmp('scratch-') }))
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' })
  assert.ok(!existsSync(home))
})

test('record --event Stop is one stderr line and exit 0; so is empty stdin from a missing vault', async () => {
  const s = setup()
  const bad = await runWithInput(['record', '--event', 'Stop'], s.env, '')
  assert.deepEqual(bad, { code: 0, stdout: '', stderr: 'dial: record needs --event SessionEnd or PreCompact\n' })
  const registry = { ...s.registry, vaults: { personal: join(s.root, 'gone') } }
  writeFileSync(join(s.home, 'registry.json'), JSON.stringify(registry))
  const failed = await runWithInput(['record', '--event', 'PreCompact'], s.env, JSON.stringify({ cwd: s.repo }))
  assert.equal(failed.code, 0)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, `dial: vault personal for katipon does not exist: ${join(s.root, 'gone')}\n`)
})

test('record syncs a registered repo from the payload cwd and exits 0', async () => {
  const s = setup()
  const r = await runWithInput(['record', '--event', 'SessionEnd'], { ...s.env, DIAL_NOW: '2026-11-10T16:50:00Z' }, JSON.stringify({ cwd: s.repo }))
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' })
  assert.ok(existsSync(join(s.vault, 'Projects', 'katipon.md')))
  assert.ok(existsSync(join(s.home, 'logs', 'sync.jsonl')))
})

test('record with an unwritable home names the home on one stderr line, exits 0 and changes no vault file', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const s = setup()
  const before = snapshotTree(s.vault)
  chmodSync(s.home, 0o555)
  try {
    const r = await runWithInput(['record', '--event', 'SessionEnd'], s.env, JSON.stringify({ cwd: s.repo }))
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.split('\n').length, 2, 'one line and its newline')
    assert.ok(r.stderr.startsWith('dial: dial home is not writable: '), r.stderr)
    assert.ok(r.stderr.includes(s.home))
  } finally {
    chmodSync(s.home, 0o755)
  }
  assert.deepEqual(snapshotTree(s.vault), before)
})
