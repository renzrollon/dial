// lib/watch.mjs against specs/launch-agent (watch): mtime polling, sync on change, one line per sync,
// a failing repo not stopping the loop, abort. Time is an injected clock; ticks are driven by onTick.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newestMtime, sleepUntil, watch } from '../lib/watch.mjs'
import { frozenNow, makeRepo, tmp } from './helpers.mjs'

const touch = (file, seconds) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'x')
  utimesSync(file, seconds, seconds)
}

/** Two repos, katipon with a ship dir and dial with openspec changes, and a registry naming both. */
function setup() {
  const base = tmp('watch-')
  const katipon = makeRepo(join(base, 'katipon'), { git: true, ship: { 'run.json': {} } })
  const dial = makeRepo(join(base, 'dial'), { git: true, changes: { 'a-change': { tasks: { done: 0, total: 1 } } } })
  const bare = makeRepo(join(base, 'bare'), { git: true })
  const registry = {
    dial_schema: 'dial.registry/1',
    vaults: { personal: join(base, 'vault') },
    repos: [katipon, dial, bare].map(path => ({ path, vault: 'personal', host: 'github' })),
    limits: {},
  }
  touch(join(katipon, '.claude/ship/run.json'), 1000)
  utimesSync(join(katipon, '.claude/ship'), 1000, 1000)
  touch(join(dial, 'openspec/changes/a-change/tasks.md'), 1000)
  utimesSync(join(dial, 'openspec/changes/a-change'), 1000, 1000)
  utimesSync(join(dial, 'openspec/changes'), 1000, 1000)
  return { base, katipon, dial, bare, registry }
}

/** Drive `ticks` polls: `act[n]` runs after tick n, the controller aborts after the last. */
async function drive(s, { ticks, act = {}, sync, clock = frozenNow('2026-11-10T14:05:00Z') }) {
  const ac = new AbortController()
  const out = []
  const err = []
  const slept = []
  const result = await watch({
    registry: s.registry,
    pollMs: 30_000,
    signal: ac.signal,
    sync,
    now: clock,
    sleep: async ms => {
      slept.push(ms)
      clock.advance(ms)
    },
    stdout: l => out.push(l),
    stderr: l => err.push(l),
    onTick: ({ tick }) => {
      act[tick]?.()
      if (tick === ticks) ac.abort()
    },
  })
  return { result, out, err, slept }
}

test('newestMtime: the newest file or directory under either watched folder, null with neither', () => {
  const s = setup()
  assert.equal(newestMtime(s.katipon), 1000 * 1000)
  touch(join(s.dial, '.claude/ship/x'), 2000)
  assert.equal(newestMtime(s.dial) >= 2000 * 1000, true)
  assert.equal(newestMtime(s.bare), null)
})

test('three ticks: the first records, a moved repo syncs on the second, nothing moves on the third', async () => {
  const s = setup()
  const calls = []
  const sync = async o => (calls.push(o.repo), { ok: true, needsMe: 2 })
  const { result, out, err, slept } = await drive(s, {
    ticks: 3,
    sync,
    act: { 1: () => touch(join(s.katipon, '.claude/ship/run.json'), 5000) },
  })
  assert.deepEqual(calls, ['katipon'])
  assert.deepEqual(out, ['14:05 synced katipon (needs me 2)'])
  assert.deepEqual(err, [])
  assert.deepEqual(result, { ticks: 3, synced: 1, failed: 0 })
  assert.deepEqual(slept, [30_000, 30_000])
})

test('the first poll syncs nothing and a repo with neither folder is never synced', async () => {
  const s = setup()
  const calls = []
  await drive(s, { ticks: 2, sync: async o => (calls.push(o.repo), { ok: true, needsMe: 0 }) })
  assert.deepEqual(calls, [])
})

test('only the repo whose mtime moved is synced, with the injected clock as now', async () => {
  const s = setup()
  const calls = []
  const clock = frozenNow('2026-11-10T14:05:00Z')
  await drive(s, {
    ticks: 2,
    clock,
    sync: async o => (calls.push({ repo: o.repo, now: o.now.toISOString() }), { ok: true, needsMe: 0 }),
    act: { 1: () => touch(join(s.dial, 'openspec/changes/a-change/tasks.md'), 7000) },
  })
  assert.deepEqual(calls, [{ repo: 'dial', now: '2026-11-10T14:05:30.000Z' }])
})

test('a failing sync is one stderr line and the next poll still runs', async () => {
  const s = setup()
  const calls = []
  const sync = async o => {
    calls.push(o.repo)
    return o.repo === 'katipon' ? { ok: false, reason: 'vault personal for katipon does not exist: /nope' } : { ok: true, needsMe: 1 }
  }
  const { result, out, err } = await drive(s, {
    ticks: 3,
    sync,
    act: {
      1: () => touch(join(s.katipon, '.claude/ship/run.json'), 5000),
      2: () => touch(join(s.dial, 'openspec/changes/a-change/tasks.md'), 6000),
    },
  })
  assert.deepEqual(err, ['dial: katipon: vault personal for katipon does not exist: /nope'])
  assert.equal(out.length, 1)
  assert.match(out[0], /^14:0\d synced dial \(needs me 1\)$/)
  assert.deepEqual(result, { ticks: 3, synced: 1, failed: 1 })
  assert.deepEqual(calls, ['katipon', 'dial'])
})

test('a throwing sync is reported like a failure', async () => {
  const s = setup()
  const { err } = await drive(s, {
    ticks: 2,
    sync: async () => {
      throw new Error('kaboom')
    },
    act: { 1: () => touch(join(s.katipon, '.claude/ship/run.json'), 5000) },
  })
  assert.deepEqual(err, ['dial: katipon: kaboom'])
})

test('an already aborted signal polls nothing', async () => {
  const s = setup()
  const ac = new AbortController()
  ac.abort()
  const result = await watch({ registry: s.registry, pollMs: 1, signal: ac.signal, sync: async () => assert.fail('no sync') })
  assert.deepEqual(result, { ticks: 0, synced: 0, failed: 0 })
})

test('sleepUntil resolves at once when aborted mid-sleep', async () => {
  const ac = new AbortController()
  const started = Date.now()
  const pending = sleepUntil(60_000, ac.signal)
  ac.abort()
  await pending
  assert.ok(Date.now() - started < 5_000)
})

test('the real syncRepo is the default sync', async () => {
  const s = setup()
  const out = []
  const err = []
  const ac = new AbortController()
  await watch({
    registry: s.registry,
    pollMs: 1,
    signal: ac.signal,
    sleep: async () => {},
    syncOpts: { home: join(s.base, 'home'), env: { HOME: s.base }, exec: () => ({ ok: false, code: 1, stdout: '', stderr: 'no' }) },
    stdout: l => out.push(l),
    stderr: l => err.push(l),
    onTick: ({ tick }) => {
      if (tick === 1) touch(join(s.katipon, '.claude/ship/run.json'), 5000)
      if (tick === 2) ac.abort()
    },
  })
  assert.equal(out.length + err.length, 1)
  assert.match((out[0] ?? err[0]), /katipon/)
})
