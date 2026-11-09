/**
 * Claude Code permission settings, reduced to what Dial's doctor needs: where
 * the four scopes live, which rules they hold, and whether a Bash requirement
 * is covered by an allow rule or blocked by a deny rule.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MANAGED_PATH = '/Library/Application Support/ClaudeCode/managed-settings.json'

/** The four settings files, least specific first. */
export function settingsSources(cwd, home) {
  return [
    { scope: 'managed', path: MANAGED_PATH },
    { scope: 'user', path: join(home, '.claude', 'settings.json') },
    { scope: 'project', path: join(cwd, '.claude', 'settings.json') },
    { scope: 'local', path: join(cwd, '.claude', 'settings.local.json') }
  ]
}

/** `Bash(x:*)`, `Bash(x *)`, `Bash(x y)`, `Bash`, `Bash(*)` into `{ tool, tokens, open, rule }`; null if not a rule. */
export function parseRule(text) {
  if (typeof text !== 'string') return null
  const rule = text.trim()
  const m = /^([A-Za-z][\w-]*)(?:\(([\s\S]*)\))?$/.exec(rule)
  if (!m) return null
  const tool = m[1]
  if (m[2] === undefined) return { tool, tokens: [], open: true, rule }
  let body = m[2].trim()
  let open = false
  if (body === '*') {
    body = ''
    open = true
  } else if (body.endsWith(':*')) {
    body = body.slice(0, -2)
    open = true
  } else if (body.endsWith(' *')) {
    body = body.slice(0, -2)
    open = true
  }
  return { tool, tokens: body.split(/\s+/).filter(Boolean), open, rule }
}

function isPrefix(prefix, tokens) {
  return prefix.length <= tokens.length && prefix.every((t, i) => t === tokens[i])
}

/** Token-prefix coverage: a rule covers a requirement only if it is at least as broad. */
export function ruleCovers(rule, req) {
  if (!rule || !req || rule.tool !== req.tool) return false
  if (rule.open) return isPrefix(rule.tokens, req.tokens)
  return !req.open && rule.tokens.length === req.tokens.length && isPrefix(rule.tokens, req.tokens)
}

/** Read every source that exists. Never throws: a bad file is an entry in `errors`. */
export function collectPermissions(sources) {
  const rules = { allow: [], deny: [], ask: [] }
  const read = []
  const errors = []
  for (const { scope, path } of sources) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') errors.push({ scope, path, reason: err.message })
      continue
    }
    let json
    try {
      json = JSON.parse(text)
    } catch (err) {
      errors.push({ scope, path, reason: err.message })
      continue
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      errors.push({ scope, path, reason: 'settings file is not a JSON object' })
      continue
    }
    read.push({ scope, path })
    const permissions = json.permissions
    if (permissions === null || typeof permissions !== 'object') continue
    for (const kind of ['allow', 'deny', 'ask']) {
      if (!Array.isArray(permissions[kind])) continue
      for (const entry of permissions[kind]) {
        const parsed = parseRule(entry)
        if (parsed) rules[kind].push({ ...parsed, scope })
      }
    }
  }
  return { rules, read, errors }
}

/** Is `Bash(<command>:*)` allowed, denied, or only allowed more narrowly? */
export function coverage(permissions, command) {
  const req = parseRule(`Bash(${command}:*)`)
  const { allow, deny } = permissions.rules
  const covered = allow.some(r => ruleCovers(r, req))
  const denied = deny.some(r => ruleCovers(r, req))
  const narrower = !covered && allow.some(r => r.tool === req.tool && isPrefix(req.tokens, r.tokens))
  return { covered, denied, narrower, errors: permissions.errors, read: permissions.read }
}
