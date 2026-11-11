import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { cachePath, readCache, writeCache } from '../lib/cache.mjs'
import { makeHome, snapshotTree, tmp } from './helpers.mjs'

const entry = { fetchedAt: '2026-11-10T08:00:00.000Z', host: 'github', branch: 'feat/add-login', pr: { number: 38 }, checks: [{ name: 'unit', bucket: 'pass' }] }

test('the first write creates cache/remote and the file carries the marker', () => {
  const home = makeHome()
  assert.equal(existsSync(join(home, 'cache')), false)
  const w = writeCache(home, 'katipon', entry)
  assert.equal(w.ok, true)
  assert.equal(w.path, join(home, 'cache', 'remote', 'katipon.json'))
  const body = JSON.parse(readFileSync(w.path, 'utf8'))
  assert.equal(body.dial_schema, 'dial.cache/1')
  assert.equal(Object.keys(body)[0], 'dial_schema')
  assert.equal(body.pr.number, 38)
  assert.deepEqual(readdirSync(join(home, 'cache', 'remote')), ['katipon.json'])
})

test('read returns what was written', () => {
  const home = makeHome()
  writeCache(home, 'katipon', entry)
  const r = readCache(home, 'katipon')
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, { dial_schema: 'dial.cache/1', ...entry })
})

test('a caller-supplied dial_schema cannot override the marker', () => {
  const home = makeHome()
  writeCache(home, 'katipon', { ...entry, dial_schema: 'dial.cache/9' })
  assert.equal(readCache(home, 'katipon').ok, true)
})

test('no file is absent, and reading creates nothing', () => {
  const home = makeHome()
  const before = snapshotTree(home)
  const r = readCache(home, 'katipon')
  assert.equal(r.ok, false)
  assert.equal(r.absent, true)
  assert.deepEqual(snapshotTree(home), before)
})

test('an unknown schema names the file and the value', () => {
  const home = makeHome()
  writeCache(home, 'katipon', entry)
  writeFileSync(cachePath(home, 'katipon'), JSON.stringify({ dial_schema: 'dial.cache/9' }))
  const r = readCache(home, 'katipon')
  assert.equal(r.ok, false)
  assert.equal(r.absent, false)
  assert.equal(r.reason, 'cache/remote/katipon.json schema dial.cache/9 not understood')
})

test('malformed JSON is a result, not a throw', () => {
  const home = makeHome()
  writeCache(home, 'katipon', entry)
  writeFileSync(cachePath(home, 'katipon'), '{ nope')
  const r = readCache(home, 'katipon')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cache/remote/katipon.json not valid JSON')
})

test('a rewrite leaves no temp file and replaces the content', () => {
  const home = makeHome()
  writeCache(home, 'katipon', entry)
  writeCache(home, 'katipon', { ...entry, branch: 'main' })
  assert.deepEqual(readdirSync(join(home, 'cache', 'remote')), ['katipon.json'])
  assert.equal(readCache(home, 'katipon').data.branch, 'main')
})

test('a write into an unwritable home is { ok: false }, not a throw', () => {
  const dir = tmp()
  const file = join(dir, 'a-file')
  writeFileSync(file, '')
  const w = writeCache(file, 'katipon', entry)
  assert.equal(w.ok, false)
  assert.match(w.reason, /ENOTDIR|EEXIST/)
})
