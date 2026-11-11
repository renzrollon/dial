/**
 * The three hook scripts (specs/claude-plugin), each run as a subprocess with a piped payload. Most cases run
 * a copy of `hooks/` under a throwaway plugin root whose `bin/dial.mjs` logs its argv and stdin, so what the
 * hook ran is read, not inferred; the envelope cases run the real CLI.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, makeRepo, makeVault, snapshotTree, tmp } from './helpers.mjs'

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENVELOPE = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"brief text"}}'

/** A plugin root with the real hooks and lib and a fake CLI that appends `{argv, stdin}` to `calls.jsonl`. */
function fakePlugin({ exit = 0, stderr = '', stdout = '' } = {}) {
  const root = tmp('plugin-')
  cpSync(join(REAL_ROOT, 'hooks'), join(root, 'hooks'), { recursive: true })
  symlinkSync(join(REAL_ROOT, 'lib'), join(root, 'lib'))
  mkdirSync(join(root, 'bin'))
  const calls = join(root, 'calls.jsonl')
  writeFileSync(join(root, 'bin', 'dial.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs'
let stdin = ''
try { stdin = readFileSync(0, 'utf8') } catch {}
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n')
process.stderr.write(${JSON.stringify(stderr)})
process.stdout.write(${JSON.stringify(stdout)})
process.exit(${exit})
`)
  const readCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [])
  return { root, readCalls }
}

/** Run `<root>/hooks/<script>` with `stdin` text, `cwd` and env; resolves `{ code, stdout, stderr }`. */
function run(root, script, args, { stdin = '', cwd, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(root, 'hooks', script), ...args], {
      cwd,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('hook-home-'), TZ: 'UTC', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

/** A vault, a registered repo `katipon` and its home. */
function world() {
  const base = tmp('hooks-')
  const vault = makeVault(join(base, 'personal'))
  const repo = makeRepo(join(base, 'code', 'katipon'), { git: true })
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: repo, vault: 'personal', host: 'github' }], limits: {} }
  const home = makeHome({ registry })
  return { base, vault, repo, home, env: { DIAL_HOME: home } }
}

const payload = (w, extra = {}) => JSON.stringify({ session_id: 's1', cwd: join(w.repo, 'lib'), ...extra })

test('brief: runs brief --hook with the session and relays the envelope verbatim', async () => {
  const w = world()
  const p = fakePlugin({ stdout: `${ENVELOPE}\n` })
  for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    const r = await run(p.root, 'brief.mjs', [], { stdin: payload(w, { source }), env: w.env })
    assert.equal(r.code, 0)
    assert.equal(r.stdout, `${ENVELOPE}\n`)
    assert.equal(r.stderr, '')
  }
  assert.deepEqual(p.readCalls()[0].argv, ['brief', 'katipon', '--hook', '--session', 's1'])
})

test('brief: no session_id omits --session', async () => {
  const w = world()
  const p = fakePlugin({ stdout: ENVELOPE })
  await run(p.root, 'brief.mjs', [], { stdin: JSON.stringify({ cwd: w.repo }), env: w.env })
  assert.deepEqual(p.readCalls()[0].argv, ['brief', 'katipon', '--hook'])
})

test('brief: the CLI failing prints nothing on stdout, one stderr line, exit 0', async () => {
  const w = world()
  const p = fakePlugin({ exit: 1, stderr: 'dial: broke\n' })
  const r = await run(p.root, 'brief.mjs', [], { stdin: payload(w), env: w.env })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial brief hook error (ignored): dial: broke\n')
})

test('brief: output that is not JSON is dropped', async () => {
  const w = world()
  const p = fakePlugin({ stdout: 'not json' })
  const r = await run(p.root, 'brief.mjs', [], { stdin: payload(w), env: w.env })
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
})

test('every hook: an unregistered cwd starts no subprocess and writes nothing', async () => {
  const w = world()
  const scratch = tmp('scratch-')
  const p = fakePlugin({ stdout: ENVELOPE })
  const before = snapshotTree(w.base)
  const cases = [
    ['brief.mjs', [], {}],
    ['record.mjs', ['--event', 'SessionEnd'], {}],
    ['record.mjs', ['--event', 'PreCompact'], {}],
    ['sync-on-event.mjs', [], { tool_input: { command: 'openspec archive x' } }],
  ]
  for (const [script, args, extra] of cases) {
    const r = await run(p.root, script, args, { stdin: JSON.stringify({ cwd: scratch, ...extra }), env: w.env })
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], script)
  }
  assert.deepEqual(p.readCalls(), [])
  assert.deepEqual(snapshotTree(w.base), before)
})

test('every hook: no registry file is silent and does not create the home', async () => {
  const home = join(tmp('nohome-'), 'dial')
  const p = fakePlugin()
  for (const [script, args] of [['brief.mjs', []], ['record.mjs', ['--event', 'SessionEnd']], ['sync-on-event.mjs', []]]) {
    const r = await run(p.root, script, args, { stdin: JSON.stringify({ cwd: tmp('x-'), tool_input: { command: 'interlock settle' } }), env: { DIAL_HOME: home } })
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], script)
  }
  assert.equal(existsSync(home), false)
  assert.deepEqual(p.readCalls(), [])
})

test('record: forwards the payload unchanged on stdin with the event', async () => {
  const w = world()
  const p = fakePlugin()
  const text = payload(w, { reason: 'exit', transcript_path: '/t.jsonl' })
  const end = await run(p.root, 'record.mjs', ['--event', 'SessionEnd'], { stdin: text, env: w.env })
  const pre = await run(p.root, 'record.mjs', ['--event', 'PreCompact'], { stdin: payload(w, { trigger: 'auto' }), env: w.env })
  assert.deepEqual([end.code, end.stdout, end.stderr], [0, '', ''])
  assert.deepEqual([pre.code, pre.stdout], [0, ''])
  const calls = p.readCalls()
  assert.deepEqual(calls[0], { argv: ['record', '--event', 'SessionEnd'], stdin: text })
  assert.deepEqual(calls[1].argv, ['record', '--event', 'PreCompact'])
  assert.equal(JSON.parse(calls[1].stdin).trigger, 'auto')
})

test('record: a failing CLI is one stderr line and exit 0', async () => {
  const w = world()
  const p = fakePlugin({ exit: 1, stderr: 'dial: boom\n' })
  const r = await run(p.root, 'record.mjs', ['--event', 'SessionEnd'], { stdin: payload(w), env: w.env })
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', 'dial record hook error (ignored): dial: boom\n'])
})

test('sync-on-event: runs sync for close commands only', async () => {
  const w = world()
  const p = fakePlugin()
  const send = command => run(p.root, 'sync-on-event.mjs', [], { stdin: payload(w, { tool_input: { command } }), env: w.env })
  for (const command of ['  openspec archive add-login --yes', 'interlock settle --review', 'interlock run close x']) {
    const r = await send(command)
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], command)
  }
  assert.deepEqual(p.readCalls().map(c => c.argv), [['sync', 'katipon'], ['sync', 'katipon'], ['sync', 'katipon']])
  for (const command of ['git status', 'echo openspec archive x', 'openspec archived', 'interlock settled']) {
    const r = await send(command)
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], command)
  }
  assert.equal((await run(p.root, 'sync-on-event.mjs', [], { stdin: payload(w), env: w.env })).code, 0)
  assert.equal(p.readCalls().length, 3)
})

test('malformed, empty and non-object stdin exit 0 silently', async () => {
  const w = world()
  const p = fakePlugin({ stdout: ENVELOPE })
  const elsewhere = tmp('elsewhere-')
  for (const stdin of ['{not json', '', '[1]', 'null']) {
    for (const [script, args] of [['brief.mjs', []], ['record.mjs', ['--event', 'SessionEnd']], ['sync-on-event.mjs', []]]) {
      const r = await run(p.root, script, args, { stdin, cwd: elsewhere, env: w.env })
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], `${script} ${JSON.stringify(stdin)}`)
    }
  }
  assert.deepEqual(p.readCalls(), [])
})

test('an exception inside the hook is one stderr line and exit 0', async () => {
  const w = world()
  const p = fakePlugin()
  const r = await run(p.root, 'record.mjs', ['--event', 'Bogus'], { stdin: payload(w), env: w.env })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial record hook error (ignored): record needs --event SessionEnd or PreCompact\n')
})

test('an invalid registry is one stderr line and exit 0', async () => {
  const home = makeHome({ registry: '{not json' })
  const p = fakePlugin()
  const r = await run(p.root, 'brief.mjs', [], { stdin: '{}', env: { DIAL_HOME: home } })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^dial brief hook error \(ignored\): registry is not valid json/)
  assert.equal(r.stderr.trim().split('\n').length, 1)
})

test('real CLI: a registered cwd produces the SessionStart envelope, with no dial on PATH', async () => {
  const w = world()
  const r = await run(REAL_ROOT, 'brief.mjs', [], { stdin: payload(w, { source: 'startup' }), env: { ...w.env, PATH: dirname(process.execPath) } })
  assert.equal(r.code, 0)
  assert.equal(r.stderr, '')
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string')
})

test('real CLI: empty stdin from a registered repo (process.cwd() is the /private path) gives the envelope', async () => {
  const w = world()
  const r = await run(REAL_ROOT, 'brief.mjs', [], { stdin: '', cwd: w.repo, env: w.env })
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'SessionStart')
})

test('real CLI: a repo registered under a symlinked directory, hook started in the physical directory', async () => {
  const base = tmp('sym-')
  const physical = join(base, 'physical')
  makeRepo(join(physical, 'katipon'), { git: true })
  const link = join(base, 'link')
  symlinkSync(physical, link)
  const vault = makeVault(join(base, 'personal'))
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: join(link, 'katipon'), vault: 'personal', host: 'github' }], limits: {} }
  const home = makeHome({ registry })
  const r = await run(REAL_ROOT, 'brief.mjs', [], { stdin: '', cwd: join(physical, 'katipon'), env: { DIAL_HOME: home } })
  assert.equal(r.code, 0)
  assert.equal(r.stderr, '')
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'SessionStart')
})
