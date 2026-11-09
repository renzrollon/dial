/**
 * Contract pinned here (design.md, Permissions; shapes follow Interlock's settings reader):
 *   settingsSources(cwd, home)  -> [{ scope, path }] in order managed, user, project, local
 *   collectPermissions(sources) -> { rules: { allow, deny, ask }, read: [{ scope, path }], errors: [{ scope, path, reason }] }
 *                                  absent files are skipped; an unreadable or unparseable file is an error, never a throw
 *   parseRule(text)             -> { tool, tokens, open, rule } | null
 *   ruleCovers(rule, req)       -> boolean, token-prefix semantics; req comes from parseRule
 *   coverage(permissions, 'dial') -> { covered, denied, narrower, errors, read }
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { collectPermissions, coverage, parseRule, ruleCovers, settingsSources } from '../lib/settings.mjs'
import { FIXTURES, tmp, writeJson } from './helpers.mjs'

/** Copy a fixture to `<dir>/<name>` and return the source record for it. */
function place(scope, dir, name, fixture) {
  const path = join(dir, name)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(FIXTURES, fixture), path)
  return { scope, path }
}

const REQ = parseRule('Bash(dial:*)')

test('settingsSources lists the four scopes, least specific first', () => {
  const cwd = '/work/repo'
  const home = '/users/someone'
  const sources = settingsSources(cwd, home)
  assert.deepEqual(sources.map(s => s.scope), ['managed', 'user', 'project', 'local'])
  const by = Object.fromEntries(sources.map(s => [s.scope, s.path]))
  assert.equal(by.user, join(home, '.claude', 'settings.json'))
  assert.equal(by.project, join(cwd, '.claude', 'settings.json'))
  assert.equal(by.local, join(cwd, '.claude', 'settings.local.json'))
  assert.match(by.managed, /^\/.*managed-settings\.json$/)
  if (process.platform === 'darwin') assert.equal(by.managed, '/Library/Application Support/ClaudeCode/managed-settings.json')
})

test('collectPermissions skips absent files without error', () => {
  const dir = tmp()
  const out = collectPermissions([
    { scope: 'managed', path: join(dir, 'nope-managed.json') },
    { scope: 'user', path: join(dir, 'nope-user.json') }
  ])
  assert.deepEqual(out.rules, { allow: [], deny: [], ask: [] })
  assert.deepEqual(out.read, [])
  assert.deepEqual(out.errors, [])
})

test('collectPermissions reads allow, deny and ask rules with their scope, in source order', () => {
  const dir = tmp()
  const user = place('user', dir, 'user.json', 'settings-allow-dial.json')
  const project = place('project', dir, 'project.json', 'settings-allow-narrow.json')
  const localPath = join(dir, 'local.json')
  writeJson(localPath, { permissions: { deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'] } })
  const out = collectPermissions([
    { scope: 'managed', path: join(dir, 'absent.json') },
    user,
    project,
    { scope: 'local', path: localPath }
  ])
  assert.deepEqual(out.read.map(r => r.scope), ['user', 'project', 'local'])
  assert.deepEqual(out.errors, [])
  assert.deepEqual(out.rules.allow.map(r => [r.scope, r.rule]), [
    ['user', 'Bash(dial:*)'],
    ['project', 'Bash(dial doctor:*)']
  ])
  assert.deepEqual(out.rules.deny.map(r => [r.scope, r.rule]), [['local', 'Bash(rm:*)']])
  assert.deepEqual(out.rules.ask.map(r => [r.scope, r.rule]), [['local', 'Bash(git push:*)']])
})

test('an unparseable settings file is reported, not thrown', () => {
  const dir = tmp()
  const broken = place('user', dir, 'broken.json', 'settings-broken.json')
  const good = place('project', dir, 'good.json', 'settings-allow-dial.json')
  let out
  assert.doesNotThrow(() => {
    out = collectPermissions([broken, good])
  })
  assert.equal(out.errors.length, 1)
  assert.equal(out.errors[0].scope, 'user')
  assert.equal(out.errors[0].path, broken.path)
  assert.equal(typeof out.errors[0].reason, 'string')
  assert.ok(out.errors[0].reason.length > 0)
  assert.deepEqual(out.rules.allow.map(r => r.rule), ['Bash(dial:*)'])
})

test('parseRule handles Bash(x:*), Bash(x *), Bash, Bash(*)', () => {
  const pick = text => {
    const r = parseRule(text)
    return r && { tool: r.tool, tokens: r.tokens, open: r.open }
  }
  assert.deepEqual(pick('Bash(dial:*)'), { tool: 'Bash', tokens: ['dial'], open: true })
  assert.deepEqual(pick('Bash(dial *)'), { tool: 'Bash', tokens: ['dial'], open: true })
  assert.deepEqual(pick('Bash(dial doctor:*)'), { tool: 'Bash', tokens: ['dial', 'doctor'], open: true })
  assert.deepEqual(pick('Bash(dial)'), { tool: 'Bash', tokens: ['dial'], open: false })
  assert.deepEqual(pick('Bash'), { tool: 'Bash', tokens: [], open: true })
  assert.deepEqual(pick('Bash(*)'), { tool: 'Bash', tokens: [], open: true })
  assert.deepEqual(pick('Read(./x)'), { tool: 'Read', tokens: ['./x'], open: false })
})

test('parseRule returns null for something that is not a rule', () => {
  assert.equal(parseRule(''), null)
  assert.equal(parseRule('   '), null)
  assert.equal(parseRule(undefined), null)
  assert.equal(parseRule(42), null)
  assert.equal(parseRule('???'), null)
})

test('ruleCovers: a rule at least as broad as the requirement covers it', () => {
  assert.equal(ruleCovers(parseRule('Bash(dial:*)'), REQ), true)
  assert.equal(ruleCovers(parseRule('Bash(dial *)'), REQ), true)
  assert.equal(ruleCovers(parseRule('Bash'), REQ), true)
  assert.equal(ruleCovers(parseRule('Bash(*)'), REQ), true)
})

test('ruleCovers: a narrower rule never covers a broader requirement', () => {
  assert.equal(ruleCovers(parseRule('Bash(dial doctor:*)'), REQ), false)
  assert.equal(ruleCovers(parseRule('Bash(dial repos)'), REQ), false)
})

test('ruleCovers: a closed rule does not cover an open requirement, an unrelated or non-Bash rule never does', () => {
  assert.equal(ruleCovers(parseRule('Bash(dial)'), REQ), false)
  assert.equal(ruleCovers(parseRule('Bash(git:*)'), REQ), false)
  assert.equal(ruleCovers(parseRule('Read(dial:*)'), REQ), false)
  assert.equal(ruleCovers(null, REQ), false)
})

test('ruleCovers: token-prefix semantics, not substring', () => {
  assert.equal(ruleCovers(parseRule('Bash(dia:*)'), REQ), false)
  assert.equal(ruleCovers(parseRule('Bash(dialer:*)'), REQ), false)
  const deeper = parseRule('Bash(dial doctor --json)')
  assert.equal(ruleCovers(parseRule('Bash(dial:*)'), deeper), true)
})

test('coverage: Bash(dial:*) in allow covers the dial requirement', () => {
  const dir = tmp()
  const perms = collectPermissions([place('user', dir, 'u.json', 'settings-allow-dial.json')])
  const out = coverage(perms, 'dial')
  assert.equal(out.covered, true)
  assert.equal(out.denied, false)
  assert.equal(out.narrower, false)
  assert.deepEqual(out.errors, [])
  assert.deepEqual(out.read.map(r => r.scope), ['user'])
})

test('coverage: Bash(dial doctor:*) is narrower and does not cover', () => {
  const dir = tmp()
  const perms = collectPermissions([place('project', dir, 'p.json', 'settings-allow-narrow.json')])
  const out = coverage(perms, 'dial')
  assert.equal(out.covered, false)
  assert.equal(out.narrower, true)
  assert.equal(out.denied, false)
})

test('coverage: no settings files means not covered and nothing read', () => {
  const dir = tmp()
  const out = coverage(collectPermissions([{ scope: 'user', path: join(dir, 'absent.json') }]), 'dial')
  assert.equal(out.covered, false)
  assert.equal(out.narrower, false)
  assert.equal(out.denied, false)
  assert.deepEqual(out.read, [])
  assert.deepEqual(out.errors, [])
})

test('coverage: a matching deny rule is reported as denied', () => {
  const dir = tmp()
  const path = join(dir, 'deny.json')
  writeJson(path, { permissions: { allow: ['Bash(dial:*)'], deny: ['Bash(dial:*)'] } })
  const out = coverage(collectPermissions([{ scope: 'local', path }]), 'dial')
  assert.equal(out.denied, true)
})

test('coverage: an unparseable file is carried in errors and covers nothing', () => {
  const dir = tmp()
  const broken = place('user', dir, 'broken.json', 'settings-broken.json')
  const out = coverage(collectPermissions([broken]), 'dial')
  assert.equal(out.covered, false)
  assert.equal(out.errors.length, 1)
  assert.equal(out.errors[0].path, broken.path)
})
