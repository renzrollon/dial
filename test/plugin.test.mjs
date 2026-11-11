/**
 * The plugin's shipped files (specs/claude-plugin): manifests in lockstep with package.json, the hook table, the
 * two skills, and what `npm pack` would publish.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { tmp } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const json = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
const text = rel => readFileSync(join(ROOT, rel), 'utf8')

test('plugin.json names dial at the package version', () => {
  const plugin = json('.claude-plugin/plugin.json')
  assert.equal(plugin.name, 'dial')
  assert.equal(plugin.version, json('package.json').version)
  for (const key of ['description', 'author', 'license']) assert.ok(plugin[key], key)
})

test('marketplace.json offers one plugin from renzrollon/dial', () => {
  const market = json('.claude-plugin/marketplace.json')
  assert.equal(market.name, 'dial')
  assert.ok(market.owner)
  assert.equal(market.plugins.length, 1)
  assert.equal(market.plugins[0].name, 'dial')
  assert.deepEqual(market.plugins[0].source, { source: 'github', repo: 'renzrollon/dial' })
})

test('hooks.json registers exactly the four events, commands and timeouts', () => {
  const { hooks } = json('hooks/hooks.json')
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreCompact', 'SessionEnd', 'SessionStart'])
  const one = event => {
    assert.equal(hooks[event].length, 1, event)
    assert.equal(hooks[event][0].hooks.length, 1, event)
    return hooks[event][0].hooks[0]
  }
  const run = file => `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${file}"`
  assert.deepEqual(one('SessionStart'), { type: 'command', command: run('brief.mjs'), timeout: 10 })
  assert.deepEqual(one('SessionEnd'), { type: 'command', command: `${run('record.mjs')} --event SessionEnd`, timeout: 60 })
  assert.deepEqual(one('PreCompact'), { type: 'command', command: `${run('record.mjs')} --event PreCompact`, timeout: 60 })
  assert.deepEqual(one('PostToolUse'), { type: 'command', command: run('sync-on-event.mjs'), timeout: 30 })
  assert.equal(hooks.PostToolUse[0].matcher, 'Bash')
  for (const event of ['SessionStart', 'SessionEnd', 'PreCompact']) assert.equal('matcher' in hooks[event][0], false, event)
})

test('hooks.json names only files that exist', () => {
  const { hooks } = json('hooks/hooks.json')
  const files = Object.values(hooks).flat().flatMap(g => g.hooks).map(h => /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(h.command)?.[1])
  assert.equal(files.length, 4)
  for (const file of files) assert.ok(file && existsSync(join(ROOT, file)), String(file))
})

test('skills have their frontmatter and name the commands the spec requires', () => {
  for (const name of ['handoff', 'next']) {
    const body = text(`skills/${name}/SKILL.md`)
    const front = readFrontmatter(body)
    assert.ok(front, name)
    assert.equal(front.name, name)
    for (const key of ['description', 'argument-hint', 'allowed-tools']) assert.ok(front[key], `${name} ${key}`)
    assert.equal(/bin\/dial\.mjs|\$\{CLAUDE_PLUGIN_ROOT\}/.test(body), false, `${name} uses the PATH binary`)
  }
  const handoff = text('skills/handoff/SKILL.md')
  for (const needle of ['dial handoff', '--stdin', '--source "/dial:handoff (claude)"', '--next', 'dial sync', 'Done:', 'Decided:', 'Next:', 'Blocked:', 'Open:']) {
    assert.ok(handoff.includes(needle), needle)
  }
  assert.match(handoff, /sandbox/i)
  assert.match(handoff, /Dial home/)
  assert.match(handoff, /vault/)
  assert.match(handoff, /permission/)
  const next = text('skills/next/SKILL.md')
  assert.ok(next.includes('dial next --json'))
  assert.ok(next.includes('`suggested`'))
  for (const field of ['repo', 'change', 'state', 'idleDays', 'evidence']) assert.ok(next.includes(`\`${field}\``), field)
})

test('package.json files lists the plugin directories', () => {
  const { files } = json('package.json')
  for (const entry of ['bin/', 'lib/', 'README.md', 'hooks/', 'skills/', 'templates/', '.claude-plugin/']) assert.ok(files.includes(entry), entry)
})

test('npm pack lists every hook, skill and template', async () => {
  const cache = tmp('npm-cache-')
  const stdout = await new Promise((resolve, reject) => {
    execFile('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: tmp('npm-home-'), TMPDIR: process.env.TMPDIR, npm_config_cache: cache }, timeout: 60_000 },
      (err, out) => (err ? reject(err) : resolve(out)))
  })
  const packed = new Set(JSON.parse(stdout)[0].files.map(f => f.path))
  const expected = [
    ...['hooks/hooks.json', 'hooks/brief.mjs', 'hooks/record.mjs', 'hooks/sync-on-event.mjs', 'hooks/common.mjs'],
    'skills/handoff/SKILL.md', 'skills/next/SKILL.md',
    '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
    ...['AGENTS-dial-section.md', 'Daily.md', 'Dial Change.md', 'Dial Queries.md', 'Dial.base'].map(f => `templates/${f}`),
  ]
  for (const path of expected) assert.ok(packed.has(path), `${path} is packed`)
})
