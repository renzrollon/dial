/**
 * The Interlock source (specs/local-sources): the current run, stage liveness,
 * waves, the trajectory's terminal line, interrupted notes, the merge verdict,
 * outcomes, settle, review-artifacts findings, the resume card and, only when
 * `runDrift` is set, `interlock drift --json`. Files are read under the
 * repository's `.claude/`, except the trajectory, outcomes, metrics and
 * resume card, which follow `run.json`'s `stateHome`. Every leaf is a Fact
 * (lib/facts.mjs); nothing here throws. `orphans` is never read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fact, unobserved } from '../facts.mjs'
import { DEFAULT_TIMEOUT_MS, exec as realExec } from '../subprocess.mjs'
import { collapseHome, expandTilde, homeOf, realOr, withCheckpointUrl } from './paths.mjs'

const RUN_SCHEMA = 'interlock.run/1'
const TRAJECTORY_SCHEMA = 'interlock.ship-run/1'
const INTERRUPTED_SCHEMA = 'interlock.interrupted/1'
const MERGE_SCHEMA = 'interlock.merge-evidence/1'
const TERMINAL_TYPES = new Set(['run-halt', 'run-complete'])

/** True when signal 0 reaches `pid` (EPERM still means the process exists). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Collect `RepoFacts.interlock` for the repository at `repoPath`.
 * @param {{
 *   repoPath: string, env?: NodeJS.ProcessEnv, exec?: Function, timeoutMs?: number,
 *   changes?: string[], runDrift?: boolean, isAlive?: (pid: number) => boolean
 * }} opts `changes` names the changes that get a per-change leaf even when no file mentions them.
 */
export function collectInterlock({ repoPath, env = process.env, exec = realExec, timeoutMs = DEFAULT_TIMEOUT_MS, changes = [], runDrift = false, isAlive = pidAlive }) {
  const userHome = homeOf(env)
  const roots = [repoPath, realOr(repoPath)]
  /** Evidence form of an absolute path: repository-relative, else `~`-collapsed. */
  const show = abs => {
    for (const r of roots) if (abs.startsWith(`${r}/`)) return abs.slice(r.length + 1)
    return collapseHome(abs, userHome)
  }
  const ship = join(repoPath, '.claude', 'ship')

  const run = readRun(join(ship, 'run.json'), show)
  const runValue = run.fact.value !== null && typeof run.fact.value === 'object' ? run.fact.value : null
  const base = runValue?.stateHome ? expandTilde(runValue.stateHome, userHome) : repoPath
  const claude = join(base, '.claude')

  const names = new Set(changes)
  if (runValue) names.add(runValue.change)

  const out = { run: run.fact }
  out.stages = readStages(ship, show, names, isAlive)
  out.waves = readWaves(ship, show)
  const traj = readTrajectory(claude, show, run, runValue, names)
  out.terminal = traj.terminal
  out.trajectoryTs = traj.ts
  out.interrupted = readInterrupted(ship, show)
  out.merge = readMerge(join(ship, 'merge-confidence.json'), show)
  out.outcomes = readOutcomes(join(claude, 'learning', 'outcomes.jsonl'), show, names)
  out.settle = readSettle(join(ship, 'settle'), show)
  out.reviewArtifacts = readReviewArtifacts(join(claude, 'metrics'), show, names, env)
  out.resumeCards = readResumeCards(join(claude, 'handoff'), show, names, run, runValue)
  out.drift = runDrift ? readDrift(repoPath, exec, timeoutMs) : unobserved('interlock drift: not run (sync only)')
  return out
}

// ---- file helpers -------------------------------------------------------------

/** `{ state: 'absent' }`, `{ state: 'invalid' }`, `{ state: 'error', reason }` or `{ state: 'ok', data }`. */
function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return err.code === 'ENOENT' ? { state: 'absent' } : { state: 'error', reason: err.code ?? err.message }
  }
  try {
    const data = JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { state: 'invalid' }
    return { state: 'ok', data }
  } catch {
    return { state: 'invalid' }
  }
}

/** Parse every JSON-object line of a `.jsonl` file; unreadable lines are skipped. `null` when the file is absent. */
function readJsonl(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(v)
    } catch {
      /* skipped */
    }
  }
  return out
}

function listDir(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

const bad = (r, label) => (r.state === 'invalid' ? `${label} not valid JSON` : `${label}: ${r.reason}`)

// ---- run ----------------------------------------------------------------------

function readRun(file, show) {
  const label = show(file)
  const r = readJson(file)
  if (r.state === 'absent') return { fact: fact('absent', `${label}: absent`), reason: null }
  if (r.state !== 'ok') {
    const reason = bad(r, label)
    return { fact: unobserved(reason), reason }
  }
  const d = r.data
  if (d.schema !== RUN_SCHEMA) {
    const reason = `${label} schema ${d.schema} not understood`
    return { fact: unobserved(reason), reason }
  }
  const halted = typeof d.halted === 'string' && d.halted ? d.halted : d.halted ? 'halted' : null
  const closedAt = typeof d.closedAt === 'string' && d.closedAt ? d.closedAt : null
  const value = {
    runId: String(d.runId ?? ''),
    change: String(d.change ?? ''),
    ended: halted ? 'run-halt' : closedAt ? 'closed' : null,
    halted,
    closedAt,
    stateHome: typeof d.stateHome === 'string' && d.stateHome ? d.stateHome : null,
  }
  return { fact: fact(value, `${label}: run ${value.runId}`), reason: null }
}

// ---- stages and waves ---------------------------------------------------------

function readStages(ship, show, names, isAlive) {
  const all = new Set(names)
  for (const d of listDir(ship)) if (existsSync(join(ship, d, 'stage.json'))) all.add(d)
  const stages = {}
  for (const change of all) {
    const file = join(ship, change, 'stage.json')
    const label = show(file)
    const r = readJson(file)
    if (r.state === 'absent') stages[change] = fact('absent', `${label}: absent`)
    else if (r.state !== 'ok') stages[change] = unobserved(bad(r, label))
    else if (!Number.isInteger(r.data.pid) || r.data.pid <= 0) stages[change] = unobserved(`${label} has no pid`)
    else {
      const alive = isAlive(r.data.pid) === true
      stages[change] = fact({ pid: r.data.pid, alive }, `${label} pid ${r.data.pid}: ${alive ? 'alive' : 'dead'}`)
    }
  }
  return stages
}

function readWaves(ship, show) {
  const stateFile = join(ship, 'state.json')
  const label = show(stateFile)
  const s = readJson(stateFile)
  if (s.state === 'absent') return fact('absent', `${label}: absent`)
  if (s.state !== 'ok') return unobserved(bad(s, label))
  const p = readJson(join(ship, 'plan.json'))
  const planLabel = show(join(ship, 'plan.json'))
  let total = null
  if (p.state === 'ok') total = Number.isInteger(p.data.waveCount) ? p.data.waveCount : Array.isArray(p.data.waves) ? p.data.waves.length : null
  if (total === null && Array.isArray(s.data.waves)) total = s.data.waves.length
  const idx = s.data.cursor?.waveIndex
  if (total === null) return unobserved(`${planLabel}: no wave count`)
  if (!Number.isInteger(idx)) return unobserved(`${label} has no cursor.waveIndex`)
  const done = Math.min(Math.max(idx, 0), total)
  return fact({ done, total }, `${label} cursor.waveIndex ${idx} of ${total}`)
}

// ---- trajectory ---------------------------------------------------------------

function readTrajectory(claude, show, run, runValue, names) {
  const noTraj = fact('none', '.claude/ship/runs: no trajectory')
  const ts = Object.fromEntries([...names].map(c => [c, fact('absent', '.claude/ship/runs: no trajectory')]))
  if (run.reason) {
    const reason = run.reason
    return { terminal: unobserved(reason), ts: Object.fromEntries([...names].map(c => [c, unobserved(reason)])) }
  }
  if (!runValue || !runValue.runId) return { terminal: noTraj, ts }
  const file = join(claude, 'ship', 'runs', `${runValue.runId}.jsonl`)
  const label = show(file)
  const lines = readJsonl(file)
  if (lines === null) {
    const absent = fact('none', `${label}: absent`)
    ts[runValue.change] = fact('absent', `${label}: absent`)
    return { terminal: absent, ts }
  }
  const valid = lines.filter(l => l.schema === TRAJECTORY_SCHEMA)
  const last = valid.filter(l => typeof l.ts === 'string').at(-1)
  if (last) ts[runValue.change] = fact(last.ts, `${label}: last line ${last.ts}`)
  const term = [...valid].reverse().find(l => TERMINAL_TYPES.has(l.type))
  if (!term) return { terminal: fact('none', `${label}: no terminal line`), ts }
  return {
    terminal: fact({ type: term.type, reason: term.type === 'run-halt' ? String(term.reason ?? '') : null, ts: String(term.ts ?? '') }, `${label} ${term.type} ${term.ts}`),
    ts,
  }
}

// ---- interrupted, merge, outcomes ---------------------------------------------

function readInterrupted(ship, show) {
  const dir = join(ship, 'interrupted')
  const notes = []
  for (const f of listDir(dir).filter(n => n.endsWith('.json'))) {
    const r = readJson(join(dir, f))
    if (r.state !== 'ok' || r.data.schema !== INTERRUPTED_SCHEMA) continue
    const { runId, change, at, spokenAt } = r.data
    if (typeof runId !== 'string' || typeof change !== 'string' || typeof at !== 'string') continue
    const note = { runId, change, at, file: show(join(dir, f)) }
    if (typeof spokenAt === 'string') note.spokenAt = spokenAt
    notes.push(note)
  }
  const label = show(dir)
  if (notes.length === 0) return fact([], `${label}: absent`)
  return fact(notes, notes.length === 1 ? `${notes[0].file}: ${notes[0].change}` : `${label}: ${notes.length} notes`)
}

function readMerge(file, show) {
  const label = show(file)
  const r = readJson(file)
  if (r.state === 'absent') return fact('absent', `${label}: absent`)
  if (r.state !== 'ok') return unobserved(bad(r, label))
  if (r.data.schema !== MERGE_SCHEMA) return unobserved(`${label} schema ${r.data.schema} not understood`)
  const verdict = r.data.result?.verdict
  if (typeof verdict !== 'string') return unobserved(`${label} has no result.verdict`)
  return fact({ change: String(r.data.change ?? ''), verdict }, `${label} result.verdict: ${verdict}`)
}

function readOutcomes(file, show, names) {
  const label = show(file)
  const lines = readJsonl(file)
  const out = {}
  if (lines === null) {
    for (const c of names) out[c] = fact('absent', `${label}: absent`)
    return out
  }
  const last = new Map()
  for (const l of lines) if (typeof l.change === 'string' && String(l.schema ?? '').startsWith('interlock.outcome/')) last.set(l.change, l)
  for (const c of new Set([...names, ...last.keys()])) {
    const l = last.get(c)
    if (!l) {
      out[c] = fact('absent', `${label}: no outcome for ${c}`)
      continue
    }
    const commit = typeof l.observed?.commit === 'string' ? l.observed.commit : null
    const mergeVerdict = typeof l.observed?.mergeVerdict === 'string' ? l.observed.mergeVerdict : null
    out[c] = fact({ commit, mergeVerdict, ts: String(l.ts ?? '') }, `${label}: ${c} commit ${commit ?? 'none'} verdict ${mergeVerdict ?? 'none'}`)
  }
  return out
}

// ---- settle, review-artifacts, resume card ------------------------------------

function readSettle(dir, show) {
  const rounds = listDir(dir)
    .map(f => ({ f, m: /^review-r(\d+)\.json$/.exec(f) }))
    .filter(x => x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]))
  if (rounds.length === 0) return fact('absent', `${show(dir)}: absent`)
  const file = join(dir, rounds[0].f)
  const label = show(file)
  const r = readJson(file)
  if (r.state !== 'ok') return unobserved(bad(r, label))
  if (!Array.isArray(r.data.surviving) || typeof r.data.head !== 'string') return unobserved(`${label} has no surviving list and head`)
  return fact({ surviving: r.data.surviving.length, head: r.data.head, file: label }, `${label}: ${r.data.surviving.length} surviving`)
}

function readReviewArtifacts(dir, show, names, env) {
  const files = listDir(dir)
  const out = {}
  for (const change of names) {
    const re = new RegExp(`^review-artifacts-${escapeRe(change)}-\\d{8}-\\d{6}\\.json$`)
    const newest = files.filter(f => re.test(f)).at(-1)
    if (!newest) {
      out[change] = fact('absent', `${show(dir)}/review-artifacts-${change}-*.json: absent`)
      continue
    }
    const file = join(dir, newest)
    const label = show(file)
    const r = readJson(file)
    if (r.state !== 'ok') out[change] = unobserved(bad(r, label))
    else {
      const blockers = Array.isArray(r.data.findings) ? r.data.findings.filter(f => f?.severity === 'blocker').length : 0
      out[change] = fact({ blockers, file: label }, withCheckpointUrl(`${label}: ${blockers} ${blockers === 1 ? 'blocker' : 'blockers'}`, env))
    }
  }
  return out
}

function readResumeCards(dir, show, names, run, runValue) {
  const out = {}
  for (const change of names) {
    if (run.reason) {
      out[change] = unobserved(run.reason)
      continue
    }
    const file = runValue && runValue.change === change ? join(dir, `ship-${change}-${runValue.runId}.md`) : null
    if (file && existsSync(file)) out[change] = fact(show(file), `${show(file)}: present`)
    else out[change] = fact('absent', `${show(dir)}/ship-${change}-*.md: absent`)
  }
  return out
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- drift --------------------------------------------------------------------

function readDrift(repoPath, exec, timeoutMs) {
  const r = exec('interlock', ['drift', '--json'], { cwd: repoPath, timeoutMs })
  if (r.missing) return unobserved('interlock: not on PATH')
  if (r.timedOut) return unobserved(`interlock: timed out after ${Math.round(timeoutMs / 1000)}s`)
  if (!r.ok) return unobserved(`interlock: ${String(r.stderr ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? `exit ${r.code}`}`)
  let d
  try {
    d = JSON.parse(r.stdout)
  } catch {
    return unobserved('interlock drift: output not valid JSON')
  }
  if (d === null || typeof d !== 'object' || !Array.isArray(d.unarchived) || typeof d.stale !== 'object' || d.stale === null) {
    return unobserved('interlock drift: unexpected output shape')
  }
  const unarchived = d.unarchived.map(u => u?.change).filter(c => typeof c === 'string')
  const skipped = d.stale.skipped === true
  const evidence = 'interlock drift --json'
  if (skipped) {
    const reason = `interlock drift: ${d.stale.reason ?? 'stale check skipped'}`
    return fact({ unarchived, broken: unobserved(reason), aging: unobserved(reason) }, `${evidence}: ${unarchived.length} unarchived, stale skipped`)
  }
  const broken = Array.isArray(d.stale.broken) ? d.stale.broken.length : 0
  const aging = Array.isArray(d.stale.aging) ? d.stale.aging.length : 0
  return fact(
    { unarchived, broken: fact(broken, `${evidence}: stale.broken ${broken}`), aging: fact(aging, `${evidence}: stale.aging ${aging}`) },
    `${evidence}: ${unarchived.length} unarchived, ${broken} broken, ${aging} aging`
  )
}
