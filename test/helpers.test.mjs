import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { FIXTURES, fakeBinary, fakeExec, fakeFetch, frozenNow, makeRepo, tmp } from './helpers.mjs'

test('makeRepo builds the declared tree', () => {
  const root = makeRepo(join(tmp(), 'r'), {
    git: true,
    changes: { 'add-login': { tasks: { done: 1, total: 2 }, files: { 'decisions.md': 'x\n' } } },
    archive: { '2026-11-09-old': {} },
    ship: { 'run.json': { schema: 'interlock.run/1' }, 'add-login/stage.json': { pid: 1 } },
    outcomes: [{ change: 'add-login' }],
  })
  assert.ok(existsSync(join(root, '.git')))
  assert.equal(readFileSync(join(root, 'openspec/changes/add-login/tasks.md'), 'utf8'), '# Tasks\n\n- [x] 1.1 Task 1\n- [ ] 1.2 Task 2\n')
  assert.ok(existsSync(join(root, 'openspec/changes/add-login/decisions.md')))
  assert.ok(existsSync(join(root, 'openspec/changes/archive/2026-11-09-old')))
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/ship/run.json'), 'utf8')), { schema: 'interlock.run/1' })
  assert.equal(readFileSync(join(root, '.claude/learning/outcomes.jsonl'), 'utf8'), '{"change":"add-login"}\n')
})

test('fakeExec answers canned replies and records every call', () => {
  const exec = fakeExec({ 'git stash list': { stdout: 'a\n' }, 'gh --version': 'missing', 'git log': () => ({ code: 2, stderr: 'no' }) })
  assert.deepEqual(exec('git', ['stash', 'list']), { ok: true, code: 0, stdout: 'a\n', stderr: '', missing: false })
  assert.equal(exec('gh', ['--version']).missing, true)
  assert.equal(exec('git', ['log']).ok, false)
  assert.match(exec('git', ['nope']).stderr, /no canned reply for: git nope/)
  assert.equal(exec.calls.length, 4)
})

test('fakeBinary writes an executable script that runs from PATH', async () => {
  const dir = tmp()
  fakeBinary(dir, 'gh', 'echo "$@" >> "$0.log"')
  const { execFileSync } = await import('node:child_process')
  execFileSync(join(dir, 'gh'), ['pr', 'view'])
  assert.equal(readFileSync(join(dir, 'gh.log'), 'utf8'), 'pr view\n')
})

test('fakeFetch replays replies in order, rejects errors and honours abort on hang', async () => {
  const fetch = fakeFetch([{ body: { a: 1 } }, { status: 500, body: 'no' }, new Error('down'), 'hang'])
  assert.deepEqual(await (await fetch('http://x/1')).json(), { a: 1 })
  const r = await fetch('http://x/2')
  assert.equal(r.status, 500)
  await assert.rejects(fetch('http://x/3'), /down/)
  const ac = new AbortController()
  const hung = fetch('http://x/4', { signal: ac.signal })
  ac.abort()
  await assert.rejects(hung, { name: 'AbortError' })
  await assert.rejects(fetch('http://x/5'), /no reply left/)
  assert.deepEqual(fetch.calls.map(c => c.url), ['http://x/1', 'http://x/2', 'http://x/3', 'http://x/4', 'http://x/5'])
})

test('frozenNow is frozen until advanced and refuses an instant without an offset', () => {
  const now = frozenNow('2026-11-10T09:00:00Z')
  assert.equal(now().toISOString(), '2026-11-10T09:00:00.000Z')
  assert.equal(now.advance(1500).iso, '2026-11-10T09:00:01.500Z')
  assert.throws(() => frozenNow('2026-11-10T09:00:00'), /no offset/)
})

test('every facts fixture parses and carries the envelope and the RepoFacts sources', () => {
  const names = readdirSync(join(FIXTURES, 'facts')).filter(n => n.endsWith('.json'))
  assert.equal(names.length, 21)
  for (const name of names) {
    const fx = JSON.parse(readFileSync(join(FIXTURES, 'facts', name), 'utf8'))
    assert.deepEqual(Object.keys(fx).sort(), ['expect', 'facts', 'limits', 'notes', 'now'], name)
    assert.deepEqual(Object.keys(fx.facts), ['repo', 'git', 'openspec', 'interlock', 'escapement', 'sessions', 'remote'], name)
  }
})
