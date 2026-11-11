/**
 * `dial narrate` (specs/handoff-and-narrative, the narrate requirements): endpoint
 * resolution, one call plus one fallback, the five-line validation, the dry run,
 * the eval set, and the API key never leaving the primary request. Every model
 * call goes through `fakeFetch`; nothing here opens a socket.
 */
// Local times in these in-process tests are read in UTC, as the harness runs the CLI.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { main } from '../bin/dial.mjs'
import { evalSet, narrate, parseFiveLines, PROMPT, resolveEndpoint } from '../lib/narrate.mjs'
import { splitNote } from '../lib/note.mjs'
import { fakeFetch, makeHome, makeRepo, makeVault, snapshotTree, tmp, writeJson } from './helpers.mjs'

const FIVE = 'Done: wired the form\nDecided: keep the session cookie\nNext: run the plan\nBlocked: none\nOpen: none'
const reply = content => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content } }] } })
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

/** A user home holding pi's models file, a registry, a vault and repo `katipon` with change `add-login`. */
function setup({ pi = { providers: { mtplx: { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'sk-local-123', models: [{ id: 'mtplx-qwen38-27b-optimized-speed' }] } } }, narrateCfg, limits = {} } = {}) {
  const root = tmp('narrate-')
  const userHome = join(root, 'user')
  if (pi) writeJson(join(userHome, '.pi', 'agent', 'models.json'), pi)
  const vault = makeVault(join(root, 'personal'), [{
    path: 'Changes/katipon--add-login.md',
    frontmatter: 'type: change\nrepo: katipon\nchange: add-login',
    body: '\n## Next\n\n## Narrative\n\n',
  }])
  const repo = makeRepo(join(root, 'code', 'katipon'), { changes: { 'add-login': { tasks: { done: 0, total: 1 } } } })
  const registry = {
    dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: repo, vault: 'personal', host: 'github' }], limits,
    ...(narrateCfg ? { narrate: narrateCfg } : {}),
  }
  const home = makeHome({ registry })
  const transcript = join(root, 't.jsonl')
  writeTranscript(transcript, 4)
  return { root, userHome, vault, repo, registry, home, transcript, env: { HOME: userHome, DIAL_HOME: home } }
}

/** `n` text turns alternating user and assistant, plus a tool line and a thinking block that must never be sent. */
function writeTranscript(path, n) {
  const lines = []
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.parse('2026-11-10T14:00:00.000Z') + i * 1000).toISOString()
    if (i % 2 === 0) lines.push({ type: 'user', timestamp: ts, message: { role: 'user', content: `user turn ${i}` } })
    else {
      lines.push({
        type: 'assistant', timestamp: ts,
        message: { id: `m${i}`, role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET-THOUGHT' }, { type: 'tool_use', name: 'Bash', input: { command: 'TOOL-USE' } }, { type: 'text', text: `assistant turn ${i}` }] },
      })
      lines.push({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL-RESULT' }] } })
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

/** A timer that fires at once and records the bound it was given. */
function instantTimer() {
  const bounds = []
  const setTimer = (fn, ms) => {
    bounds.push(ms)
    return setTimeout(fn, 0)
  }
  return { bounds, setTimer, clearTimer: clearTimeout }
}

const note = s => readFileSync(join(s.vault, 'Changes', 'katipon--add-login.md'), 'utf8')
const narrative = s => splitNote(note(s)).sections.find(x => x.heading === 'Narrative').body
const sentTurns = call => JSON.parse(call.init.body).messages[1].content
const authOf = call => call.init.headers?.authorization

function run(s, opts = {}) {
  return narrate({ registry: s.registry, repo: 'katipon', change: 'add-login', transcript: s.transcript, env: s.env, now: new Date('2026-11-10T16:00:00Z'), ...opts })
}

// --- endpoint resolution --------------------------------------------------------

test('pi provider mtplx is the primary, the built-in fallback has no key', () => {
  const s = setup()
  const e = resolveEndpoint({ registry: s.registry, env: s.env })
  assert.equal(e.primary.url, 'http://127.0.0.1:8000/v1')
  assert.equal(e.primary.model, 'mtplx-qwen38-27b-optimized-speed')
  assert.equal(e.primary.key, 'sk-local-123')
  assert.deepEqual([e.fallback.url, e.fallback.model, e.fallback.key], ['http://127.0.0.1:11434/v1', 'qwen3.6', null])
})

test('the registry narrate block overrides pi: model and the key from an environment variable', () => {
  const s = setup({ narrateCfg: { model: 'qwen-next', apiKeyEnv: 'NARRATE_KEY', fallbackModel: 'small' } })
  const e = resolveEndpoint({ registry: s.registry, env: { ...s.env, NARRATE_KEY: 'k-from-env' } })
  assert.equal(e.primary.model, 'qwen-next')
  assert.equal(e.primary.key, 'k-from-env')
  assert.equal(e.fallback.model, 'small')
})

test('nothing configured: no primary, the only call goes to the fallback with no Authorization header', async () => {
  const s = setup({ pi: null })
  assert.equal(resolveEndpoint({ registry: s.registry, env: s.env }).primary, null)
  const fetch = fakeFetch([reply(FIVE)])
  const r = await run(s, { fetch })
  assert.equal(r.written, true)
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(JSON.parse(fetch.calls[0].init.body).model, 'qwen3.6')
  assert.equal(authOf(fetch.calls[0]), undefined)
})

// --- the reply --------------------------------------------------------------------

test('a usable reply holds the five labels; a think block is ignored; a missing label is named', () => {
  assert.deepEqual(parseFiveLines(`<think>Done: not this</think>\n${FIVE}`), { ok: true, lines: FIVE.split('\n') })
  assert.deepEqual(parseFiveLines('Done: a\nDecided: b\nNext: c\nBlocked: d'), { ok: false, missing: 'Open:' })
})

test('the primary answers: one request, the entry headed local model (<model>) with the five lines', async () => {
  const s = setup()
  const fetch = fakeFetch([reply(FIVE)])
  const r = await run(s, { fetch })
  assert.equal(r.ok, true)
  assert.equal(r.written, true)
  assert.equal(r.wikilink, '[[katipon--add-login]]')
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:8000/v1/chat/completions')
  assert.equal(fetch.calls[0].init.method, 'POST')
  const body = JSON.parse(fetch.calls[0].init.body)
  assert.equal(body.model, 'mtplx-qwen38-27b-optimized-speed')
  assert.equal(body.messages[0].content, PROMPT)
  assert.ok(narrative(s).startsWith(`\n### 2026-11-10 16:00 · local model (mtplx-qwen38-27b-optimized-speed)\n${FIVE}\n\n`))
})

test('the turns sent hold the text blocks only, never tool or thinking content', async () => {
  const s = setup()
  const fetch = fakeFetch([reply(FIVE)])
  await run(s, { fetch })
  const sent = sentTurns(fetch.calls[0])
  assert.match(sent, /user: user turn 0/)
  assert.match(sent, /assistant: assistant turn 1/)
  for (const bad of ['SECRET-THOUGHT', 'TOOL-USE', 'TOOL-RESULT']) assert.ok(!sent.includes(bad), bad)
})

test('the turn cap: the last narrateTurns turns, or the last --turns', async () => {
  const s = setup({ limits: { narrateTurns: 20 } })
  writeTranscript(s.transcript, 50)
  const capped = fakeFetch([reply(FIVE)])
  await run(s, { fetch: capped, limits: { narrateTurns: 20 } })
  assert.equal(sentTurns(capped.calls[0]).split('\n\n').length, 20)
  assert.match(sentTurns(capped.calls[0]), /^user: user turn 30/)
  const five = fakeFetch([reply(FIVE)])
  await run(s, { fetch: five, limits: { narrateTurns: 20 }, turns: 5 })
  assert.equal(sentTurns(five.calls[0]).split('\n\n').length, 5)
})

test('primary down, fallback answers: two requests, the second to the fallback and without the key', async () => {
  const s = setup()
  const fetch = fakeFetch([refused(), reply(FIVE)])
  const r = await run(s, { fetch })
  assert.equal(r.written, true)
  assert.equal(fetch.calls.length, 2)
  assert.equal(fetch.calls[1].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(authOf(fetch.calls[0]), 'Bearer sk-local-123')
  assert.equal(authOf(fetch.calls[1]), undefined)
  assert.match(narrative(s), /· local model \(qwen3\.6\)\n/)
})

test('a primary that never answers is aborted at narrateTimeoutSeconds and the fallback is called once', async () => {
  const s = setup()
  const timer = instantTimer()
  const fetch = fakeFetch(['hang', reply(FIVE)])
  const r = await run(s, { fetch, limits: { narrateTimeoutSeconds: 30, narrateTurns: 20 }, ...timer })
  assert.equal(r.written, true)
  assert.equal(fetch.calls.length, 2)
  assert.deepEqual(timer.bounds, [30_000, 30_000])
})

test('a reply without Open: is unusable and the fallback is called once', async () => {
  const s = setup()
  const fetch = fakeFetch([reply('Done: a\nDecided: b\nNext: c\nBlocked: d'), reply(FIVE)])
  const r = await run(s, { fetch })
  assert.equal(r.written, true)
  assert.equal(fetch.calls.length, 2)
})

test('both endpoints down: nothing written, the last failure as unobserved, no third call', async () => {
  const s = setup()
  const before = snapshotTree(s.vault)
  const fetch = fakeFetch([refused(), refused()])
  const r = await run(s, { fetch })
  assert.deepEqual(r, { ok: true, written: false, unobserved: 'http://127.0.0.1:11434/v1 unreachable' })
  assert.equal(fetch.calls.length, 2)
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('a 200 that is not JSON from both is unobserved; a non-2xx names its status', async () => {
  const s = setup()
  const r = await run(s, { fetch: fakeFetch([{ status: 200, body: '<html>' }, { status: 200, body: 'nope' }]) })
  assert.equal(r.written, false)
  assert.match(r.unobserved, /^http:\/\/127\.0\.0\.1:11434\/v1 reply is not JSON$/)
  const http = await run(s, { fetch: fakeFetch([{ status: 500, body: 'x' }, { status: 503, body: 'x' }]) })
  assert.equal(http.unobserved, 'http://127.0.0.1:11434/v1 HTTP 503')
})

test('a non-local endpoint is never called and counts as a failed attempt', async () => {
  const s = setup({ pi: null, narrateCfg: { url: 'https://api.example.com/v1', model: 'cloud', fallbackUrl: 'http://10.0.0.5:11434/v1' } })
  const fetch = fakeFetch([])
  const r = await run(s, { fetch })
  assert.deepEqual(r, { ok: true, written: false, unobserved: 'http://10.0.0.5:11434/v1 is not a local endpoint' })
  assert.equal(fetch.calls.length, 0)
})

test('a missing transcript or one with no text turns makes no call and writes nothing', async () => {
  const s = setup()
  const fetch = fakeFetch([])
  assert.deepEqual(await run(s, { fetch, transcript: '/nope.jsonl' }), { ok: true, written: false, unobserved: 'no transcript at /nope.jsonl' })
  writeFileSync(s.transcript, JSON.stringify({ type: 'system', content: 'x' }) + '\n')
  assert.deepEqual(await run(s, { fetch }), { ok: true, written: false, unobserved: 'transcript has no text turns' })
  assert.equal(fetch.calls.length, 0)
})

test('a dry run returns the prompt, the endpoints and the turns, and calls nothing', async () => {
  const s = setup()
  const before = snapshotTree(s.vault)
  const fetch = fakeFetch([])
  const r = await run(s, { fetch, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.equal(r.prompt, PROMPT)
  assert.deepEqual(r.endpoints.map(e => e.url), ['http://127.0.0.1:8000/v1', 'http://127.0.0.1:11434/v1'])
  assert.deepEqual(r.turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(fetch.calls.length, 0)
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('an unknown repo or change is refused before any call', async () => {
  const s = setup()
  const fetch = fakeFetch([])
  assert.deepEqual(await run(s, { fetch, repo: 'nothing-here' }), { ok: false, reason: 'no registered repo matches nothing-here' })
  assert.deepEqual(await run(s, { fetch, change: 'add-logn' }), { ok: false, reason: 'katipon has no change add-logn' })
  assert.equal(fetch.calls.length, 0)
})

// --- the eval set -----------------------------------------------------------------

test('eval writes one output per item and prints the score with denominators', async () => {
  const s = setup()
  const dir = join(s.root, 'eval')
  for (let i = 0; i < 20; i++) writeTranscript(join(dir, 'items', `item-${String(i).padStart(2, '0')}.jsonl`), 2)
  writeFileSync(join(dir, 'labels.jsonl'), Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: `item-${String(i).padStart(2, '0')}`, nextCorrect: i < 14, nothingInvented: i < 18 })).join('\n') + '\n')
  const before = snapshotTree(s.vault)
  const fetch = fakeFetch(() => reply(FIVE))
  const r = await evalSet({ dir, registry: s.registry, env: s.env, fetch })
  assert.equal(r.ok, true)
  assert.equal(Object.keys(snapshotTree(join(dir, 'outputs'))).filter(k => k.endsWith('.md')).length, 20)
  assert.equal(readFileSync(join(dir, 'outputs', 'item-00.md'), 'utf8'), `${FIVE}\n`)
  assert.ok(r.lines.includes('nextCorrect: 14 of 20'))
  assert.ok(r.lines.includes('nothingInvented: 18 of 20'))
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('eval without labels says unobserved: no labels; a failed item writes its unobserved line', async () => {
  const s = setup()
  const dir = join(s.root, 'eval')
  writeTranscript(join(dir, 'items', 'a.jsonl'), 2)
  const r = await evalSet({ dir, registry: s.registry, env: s.env, fetch: fakeFetch([refused(), refused()]) })
  assert.ok(r.lines.includes('unobserved: no labels'))
  assert.equal(readFileSync(join(dir, 'outputs', 'a.md'), 'utf8'), 'unobserved: http://127.0.0.1:11434/v1 unreachable\n')
  assert.deepEqual(await evalSet({ dir: join(s.root, 'none'), registry: s.registry, env: s.env, fetch: fakeFetch([]) }), {
    ok: false, reason: `${join(s.root, 'none')}/items is not a directory`,
  })
})

// --- the command, in-process with a recording fetch --------------------------------

function sink() {
  let text = ''
  return { write: t => { text += t }, get text() { return text } }
}

async function cli(s, args, fetch, extraEnv = {}) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(args, { env: { ...s.env, TZ: 'UTC', ...extraEnv }, cwd: s.root, stdout, stderr, fetch })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

test('the command: success prints the wikilink, both down prints unobserved, --json has written false, exit 0', async () => {
  const s = setup()
  const ok = await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript], fakeFetch([reply(FIVE)]))
  assert.deepEqual(ok, { code: 0, stdout: '[[katipon--add-login]]\n', stderr: '' })
  const down = await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript], fakeFetch([refused(), refused()]))
  assert.deepEqual(down, { code: 0, stdout: 'unobserved: http://127.0.0.1:11434/v1 unreachable\n', stderr: '' })
  const js = await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript, '--json'], fakeFetch([refused(), refused()]))
  assert.deepEqual(JSON.parse(js.stdout), { written: false, unobserved: 'http://127.0.0.1:11434/v1 unreachable' })
  const missing = await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', '/nope.jsonl'], fakeFetch([]))
  assert.deepEqual(missing, { code: 0, stdout: 'unobserved: no transcript at /nope.jsonl\n', stderr: '' })
})

test('the command: --dry-run prints the prompt and user:/assistant: lines; refusals exit 1', async () => {
  const s = setup()
  const fetch = fakeFetch([])
  const dry = await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript, '--dry-run'], fetch)
  assert.equal(dry.code, 0)
  assert.ok(dry.stdout.startsWith(PROMPT))
  assert.match(dry.stdout, /^user: user turn 0$/m)
  assert.match(dry.stdout, /^assistant: assistant turn 1$/m)
  assert.equal(fetch.calls.length, 0)
  assert.equal((await cli(s, ['narrate', 'katipon'], fetch)).stderr, 'dial: narrate needs <repo> and --transcript <path>\n')
  assert.equal((await cli(s, ['narrate', 'katipon', '--transcript', s.transcript, '--turns', '0'], fetch)).stderr, 'dial: --turns must be a positive integer\n')
  const noItems = await cli(s, ['narrate', '--eval', join(s.root, 'none')], fetch)
  assert.equal(noItems.code, 1)
  assert.equal(noItems.stderr, `dial: ${join(s.root, 'none')}/items is not a directory\n`)
})

test('the API key appears only in the primary request Authorization header', async () => {
  const s = setup()
  const KEY = 'sk-local-123'
  const calls = []
  const record = inner => {
    const f = (url, init) => {
      calls.push({ url, init })
      return inner(url, init)
    }
    return f
  }
  const outputs = []
  outputs.push(await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript], record(fakeFetch([reply(FIVE)]))))
  outputs.push(await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript, '--json'], record(fakeFetch([refused(), refused()]))))
  outputs.push(await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript], record(fakeFetch([{ status: 401, body: `bad key ${KEY}` }, refused()]))))
  outputs.push(await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript, '--dry-run'], record(fakeFetch([]))))
  outputs.push(await cli(s, ['narrate', 'katipon', 'add-login', '--transcript', s.transcript, '--dry-run', '--json'], record(fakeFetch([]))))
  for (const o of outputs) {
    assert.ok(!o.stdout.includes(KEY), o.stdout)
    assert.ok(!o.stderr.includes(KEY), o.stderr)
  }
  const primary = calls.filter(c => c.url.startsWith('http://127.0.0.1:8000/'))
  assert.equal(primary.length, 3)
  for (const c of calls) {
    assert.ok(!String(c.init.body).includes(KEY), 'never in a body')
    const isPrimary = c.url.startsWith('http://127.0.0.1:8000/')
    assert.equal(c.init.headers.authorization, isPrimary ? `Bearer ${KEY}` : undefined)
    for (const [name, value] of Object.entries(c.init.headers)) if (name !== 'authorization') assert.ok(!String(value).includes(KEY))
  }
  const files = dir => Object.entries(snapshotTree(dir)).filter(([, v]) => v !== '<dir>' && v !== '<symlink>').map(([k]) => k)
  for (const f of files(s.vault)) assert.ok(!readFileSync(join(s.vault, f), 'utf8').includes(KEY), `vault ${f}`)
  for (const f of files(s.home)) assert.ok(!readFileSync(join(s.home, f), 'utf8').includes(KEY), `home ${f}`)
})
