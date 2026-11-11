/**
 * The OpenSpec source (specs/local-sources): pure filesystem. Active and
 * archived changes, then per active change the task counts, the manual test
 * plan, the `needs_human` decisions, the checkpoint and the newest mtime.
 * Every leaf is a Fact (lib/facts.mjs); nothing here throws.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fact, unobserved } from '../facts.mjs'
import { isoSeconds, withCheckpointUrl } from './paths.mjs'

const ARCHIVE_DIR = /^(\d{4}-\d{2}-\d{2})-(.+)$/
const TASK_LINE = /^\s*- \[(.)\]\s/
const RESULT_LINE = /^Result:\s*(pass|fail)/

/**
 * Collect the `RepoFacts.openspec` object for the repository at `repoPath`.
 * With no `openspec/` directory every leaf is `unobserved: no openspec dir`. A `needs_human` evidence carries
 * `ESCAPEMENT_CHECKPOINT_URL` from `env` (D50).
 * @param {{ repoPath: string, env?: NodeJS.ProcessEnv }} opts
 */
export function collectOpenspec({ repoPath, env = process.env }) {
  const root = join(repoPath, 'openspec')
  if (!isDir(root)) {
    const reason = 'no openspec dir'
    return { active: unobserved(reason), archived: unobserved(reason), changes: {} }
  }
  const changesDir = join(root, 'changes')
  let names
  try {
    names = readdirSync(changesDir, { withFileTypes: true })
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const reason = `openspec/changes: ${err.code ?? err.message}`
      return { active: unobserved(reason), archived: unobserved(reason), changes: {} }
    }
    names = []
  }
  const active = names
    .filter(d => d.isDirectory() && d.name !== 'archive')
    .map(d => d.name)
    .sort()
  const archived = readArchive(join(changesDir, 'archive'))
  const changes = {}
  for (const name of active) changes[name] = collectChange(repoPath, name, env)
  return {
    active: fact(active, `openspec/changes/: ${active.length} active`),
    archived: fact(
      archived,
      archived.length === 1
        ? `openspec/changes/archive/${archived[0].date}-${archived[0].name}/`
        : `openspec/changes/archive/: ${archived.length} archived`
    ),
    changes,
  }
}

function readArchive(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const d of entries) {
    if (!d.isDirectory()) continue
    const m = ARCHIVE_DIR.exec(d.name)
    if (m) out.push({ name: m[2], date: m[1] })
  }
  return out.sort((a, b) => (a.date + a.name < b.date + b.name ? -1 : 1))
}

function collectChange(repoPath, change, env) {
  const rel = `openspec/changes/${change}`
  const dir = join(repoPath, rel)
  return {
    tasks: readTasks(dir, rel),
    manualTest: readManualTest(dir, rel),
    needsHuman: readDecisions(dir, rel, env),
    checkpoint: readCheckpoint(dir, rel),
    lastMtime: newestMtime(dir, rel),
  }
}

function readText(file) {
  try {
    return { text: readFileSync(file, 'utf8') }
  } catch (err) {
    return err.code === 'ENOENT' ? { absent: true } : { error: err.code ?? err.message }
  }
}

function readTasks(dir, rel) {
  const at = `${rel}/tasks.md`
  const r = readText(join(dir, 'tasks.md'))
  if (r.absent) return fact({ done: 0, total: 0 }, `${at}: absent`)
  if (r.error) return unobserved(`${at}: ${r.error}`)
  let done = 0
  let total = 0
  for (const line of r.text.split('\n')) {
    const m = TASK_LINE.exec(line)
    if (!m) continue
    total++
    if (m[1] === 'x' || m[1] === 'X') done++
  }
  return fact({ done, total }, `${at}: ${done}/${total}`)
}

function readManualTest(dir, rel) {
  const at = `${rel}/manual-test-plan.md`
  const r = readText(join(dir, 'manual-test-plan.md'))
  if (r.absent) return fact('absent', `${at}: absent`)
  if (r.error) return unobserved(`${at}: ${r.error}`)
  let result = null
  for (const line of r.text.split('\n')) {
    const m = RESULT_LINE.exec(line)
    if (m) result = m[1]
  }
  return result === null
    ? fact('present, no result', `${at}: no Result: line`)
    : fact(result, `${at}: Result: ${result}`)
}

function readDecisions(dir, rel, env) {
  const at = `${rel}/decisions.md`
  const r = readText(join(dir, 'decisions.md'))
  if (r.absent) return fact([], `${at}: absent`)
  if (r.error) return unobserved(`${at}: ${r.error}`)
  const ids = []
  for (const line of r.text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.length >= 3 && cells[2] === 'needs_human' && cells[0]) ids.push(cells[0])
  }
  return ids.length ? fact(ids, withCheckpointUrl(`${at}: needs_human ${ids.join(' ')}`, env)) : fact([], `${at}: no needs_human rows`)
}

function readCheckpoint(dir, rel) {
  const at = `${rel}/checkpoint.json`
  const r = readText(join(dir, 'checkpoint.json'))
  if (r.absent) return fact('absent', `${at}: absent`)
  if (r.error) return unobserved(`${at}: ${r.error}`)
  let data
  try {
    data = JSON.parse(r.text)
  } catch {
    return unobserved(`${at} not valid JSON`)
  }
  if (data === null || typeof data !== 'object' || data.schema !== 'interlock.checkpoint/1') {
    return unobserved(`${at} schema ${data?.schema} not understood`)
  }
  const state = data.decision?.state
  if (state === 'approved' || state === 'returned') return fact(state, `${at} decision.state: ${state}`)
  return fact('absent', `${at} decision.state: none`)
}

function newestMtime(dir, rel) {
  let best = null
  const walk = (abs, r) => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) {
      const a = join(abs, d.name)
      const rr = `${r}/${d.name}`
      if (d.isDirectory()) walk(a, rr)
      else if (d.isFile()) {
        // A file removed between the readdir and the stat (an editor's swap file, a tool's temp file) is skipped.
        let ms
        try {
          ms = statSync(a).mtimeMs
        } catch {
          continue
        }
        if (best === null || ms > best.ms) best = { ms, rel: rr }
      }
    }
  }
  walk(dir, rel)
  return best === null ? unobserved(`no files under ${rel}`) : fact(isoSeconds(best.ms), best.rel)
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
