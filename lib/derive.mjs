/**
 * The state machine (design.md §The state machine, specs/state-model). Pure:
 * reads the facts, the parsed vault notes and the `now` it is given, and no
 * other clock, file, network or randomness. Never mutates its input.
 */
import {
  APPROVED_SUGGESTED, NEEDS_ME, STALE_SUGGESTED, STATE_TABLE, SUGGESTED,
  fact, isUnobserved, noteName, unobserved,
} from './facts.mjs'
import { LIMITS } from './limits.mjs'

const DAY_MS = 86_400_000

const observed = f => !isUnobserved(f)
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
/** The value of an observed leaf, else undefined. */
const val = f => (observed(f) ? f.value : undefined)
/** A missing leaf reads as unobserved, so no signal can match on it. */
const leaf = (f, reason) => (f === undefined || f === null ? unobserved(reason) : f)
/** A row value for a leaf: `unobserved: <reason>` or the formatted value. */
const shown = (f, fmt = v => String(v)) => (observed(f) ? fmt(f.value) : `unobserved: ${f?.unobserved ?? 'missing'}`)
const row = (name, value, evidence) => ({ fact: name, value, evidence: evidence ?? null })
/** A copy of a leaf, so an item never aliases the input. */
const copy = f => structuredClone(f)

function parseTime(v) {
  if (typeof v !== 'string') return NaN
  return Date.parse(v)
}

/** The local calendar date of `d` as a day number (days since the epoch). */
function localDay(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS)
}

/** A `YYYY-MM-DD` date as a day number, NaN when malformed. */
function dateDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''))
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS) : NaN
}

/**
 * The change the checked-out branch, its conflicts, PR, checks and settle record
 * belong to (D30), or null.
 */
function attribute(facts, active) {
  const branch = val(facts.git?.branch)
  const detached = val(facts.git?.detached) === true
  if (typeof branch === 'string' && !detached) {
    const segments = branch.split('/')
    const hits = active.filter(n => segments.some(s => s === n || s.endsWith(`-${n}`)))
    if (hits.length) return [...hits].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0]
  }
  const run = val(facts.interlock?.run)
  if (isObj(run) && active.includes(run.change)) return run.change
  if (active.length === 1) return active[0]
  return null
}

/** The newest observed activity among `[iso, evidence]` candidates. */
function newest(candidates) {
  let best = null
  for (const [iso, evidence] of candidates) {
    const t = parseTime(iso)
    if (Number.isNaN(t)) continue
    if (!best || t > best.t) best = { t, evidence }
  }
  return best
}

function overlay(best, now, staleDays, canBeStale) {
  if (!best) return { lastActivity: null, idleDays: null, stale: false, activityEvidence: null }
  const idleDays = Math.floor((now.getTime() - best.t) / DAY_MS)
  return {
    lastActivity: new Date(best.t).toISOString(),
    idleDays,
    stale: canBeStale && idleDays > staleDays,
    activityEvidence: best.evidence,
  }
}

/** The branch facts, shared by every item and the repo-level item. */
function branchFacts(facts) {
  const git = facts.git ?? {}
  const remote = facts.remote ?? {}
  const pr = leaf(remote.pr, 'no pr fact')
  const ci = leaf(remote.ci, 'no ci fact')
  const inProgress = leaf(git.inProgress, 'no git fact')
  const unmerged = leaf(git.unmerged, 'no git fact')
  const prObj = isObj(val(pr)) ? pr.value : null
  const ciValue = isObj(val(ci)) ? ci.value.value : undefined

  let conflict = null
  if (['rebase', 'merge'].includes(val(inProgress))) conflict = { value: inProgress.value, evidence: inProgress.evidence }
  else if (Array.isArray(val(unmerged)) && unmerged.value.length) conflict = { value: `${unmerged.value.length} unmerged`, evidence: unmerged.evidence }
  else if (prObj && prObj.conflicting === true) conflict = { value: `pr ${prObj.number} conflicting`, evidence: pr.evidence }

  let conflictRow
  if (conflict) conflictRow = row('conflict', conflict.value, conflict.evidence)
  else if (observed(inProgress) || observed(unmerged) || prObj) {
    conflictRow = row('conflict', 'none', observed(inProgress) ? inProgress.evidence : observed(unmerged) ? unmerged.evidence : pr.evidence)
  } else conflictRow = row('conflict', shown(inProgress), inProgress.evidence)

  return {
    pr, ci, prObj, ciValue, conflict, conflictRow,
    ciRed: observed(ci) && (ciValue === 'fail' || ciValue === 'failed'),
    prRow: row('pr', shown(pr, v => (isObj(v) ? `${v.number} ${v.state}` : String(v))), pr.evidence),
    ciRow: row('ci', shown(ci, v => (isObj(v) ? String(v.value) : String(v))), ci.evidence),
  }
}

/** The run that counts for `change` and the halted / shipping / ship-row reading of it (D32, D74). */
function shipSignals(facts, change) {
  const il = facts.interlock ?? {}
  const runF = leaf(il.run, 'no run fact')
  const run = isObj(val(runF)) ? runF.value : null
  const terminalF = leaf(il.terminal, 'no trajectory fact')
  const terminal = val(terminalF)
  const stageF = leaf(il.stages?.[change], 'no stage fact')
  const stage = val(stageF)
  const stageAlive = isObj(stage) && stage.alive === true
  const stageDead = observed(stageF) && !stageAlive
  const outcomeF = leaf(il.outcomes?.[change], 'no outcome fact')
  const outcome = isObj(val(outcomeF)) ? outcomeF.value : null
  const notesF = leaf(il.interrupted, 'no interrupted fact')
  const notes = Array.isArray(val(notesF)) ? notesF.value.filter(n => n && n.change === change) : []

  const ownsRun = !!run && run.change === change
  let halted = null
  let shipValue
  let shipEvidence
  let latestRunId = null

  if (ownsRun) {
    latestRunId = run.runId
    const closed = !!run.closedAt || !!run.ended
    const termHalt = isObj(terminal) && terminal.type === 'run-halt'
    const hasTerminal = isObj(terminal)
    const note = notes.find(n => n.runId === run.runId)
    if (termHalt) halted = { value: `halted: ${terminal.reason ?? 'run-halt'}`, evidence: terminalF.evidence }
    else if (run.ended === 'run-halt' || run.halted) halted = { value: `halted: ${run.halted ?? 'run-halt'}`, evidence: runF.evidence }
    else if (note) halted = { value: 'halted: interrupted', evidence: `${note.file}: ${change}` }
    else if (!closed && !hasTerminal && observed(terminalF) && stageDead) {
      halted = { value: 'halted: interrupted', evidence: stageF.evidence }
    }
    if (!halted) {
      shipValue = closed ? `run ${run.runId} ${run.ended ?? 'closed'}` : `run ${run.runId} open`
      shipEvidence = runF.evidence
    }
  } else if (notes.length) {
    const sorted = [...notes].sort((a, b) => parseTime(b.at) - parseTime(a.at))
    const note = sorted[0]
    const outTs = outcome ? parseTime(outcome.ts) : NaN
    if (Number.isNaN(outTs) || parseTime(note.at) > outTs) {
      latestRunId = note.runId
      halted = { value: 'halted: interrupted', evidence: `${note.file}: ${change}` }
    }
  }

  if (!halted && shipValue === undefined) {
    shipValue = run ? `run ${run.runId} for ${run.change}` : shown(runF)
    shipEvidence = runF.evidence
  }
  if (!halted) {
    const ignored = notes.find(n => n.runId !== latestRunId)
    if (ignored) shipEvidence = `${ignored.file}: run ${ignored.runId}, not the latest run`
  }

  const shipRow = halted ? row('ship', halted.value, halted.evidence) : row('ship', shipValue, shipEvidence)
  const liveRun = ownsRun && !run.closedAt && !run.ended && !run.halted && stageAlive
  return { halted, shipRow, liveRun, stageF, stage, outcomeF, outcome }
}

function deriveItem(facts, change, ctx) {
  const { attributed, branch, now, limits, notes, archivedNames, activeSet } = ctx
  const repoName = facts.repo?.name ?? ''
  const os = facts.openspec ?? {}
  const il = facts.interlock ?? {}
  const ch = os.changes?.[change] ?? {}
  const isActive = activeSet.has(change)
  const mine = attributed === change
  const notAttributed = `branch ${val(facts.git?.branch) ?? 'unobserved'} is not attributed to ${change}`
  const name = noteName(repoName, change)
  const note = notes[name]
  const notePath = `Changes/${name}.md`

  const tasksF = leaf(ch.tasks, `openspec/changes/${change}: not active`)
  const manualF = leaf(ch.manualTest, `openspec/changes/${change}: not active`)
  const needsHumanF = leaf(ch.needsHuman, `openspec/changes/${change}: not active`)
  const checkpointF = leaf(ch.checkpoint, `openspec/changes/${change}: not active`)
  const mergeF = leaf(il.merge, 'no merge-confidence fact')
  const settleF = leaf(il.settle, 'no settle fact')
  const reviewF = leaf(il.reviewArtifacts?.[change], 'no review-artifacts fact')
  const resumeF = leaf(il.resumeCards?.[change], 'no resume card fact')
  const entryF = leaf(facts.escapement?.entries?.[change], 'no queue fact')
  const lastCommitF = leaf(facts.git?.lastCommit, 'no git fact')
  const sessionF = leaf(facts.sessions?.lastSession, 'no sessions fact')
  const head = isObj(val(lastCommitF)) ? lastCommitF.value.head : undefined

  const ship = shipSignals(facts, change)
  const rows = []
  const matches = {}

  // archive
  const archivedF = leaf(os.archived, 'no openspec fact')
  const archEntry = archivedNames.get(change)
  if (archEntry) matches.archived = archivedF.evidence
  rows.push(row('archive', archEntry ? `archived ${archEntry.date}` : shown(archivedF, v => (Array.isArray(v) ? 'none' : String(v))), archivedF.evidence))

  // dropped
  const fm = note?.frontmatter
  const hasDropped = !!fm && Object.hasOwn(fm, 'dropped')
  if (hasDropped) matches.dropped = `${notePath}: dropped ${fm.dropped}`
  rows.push(row('dropped', hasDropped ? `dropped ${fm.dropped}` : 'none',
    hasDropped ? `${notePath}: dropped ${fm.dropped}` : `${notePath}: no dropped key`))

  // tasks + archive-pending (tasks or merged PR)
  const tasks = isObj(val(tasksF)) ? tasksF.value : null
  rows.push(row('tasks', shown(tasksF, v => (isObj(v) ? `${v.done}/${v.total}` : String(v))), tasksF.evidence))
  const b = branch
  if (isActive) {
    if (tasks && tasks.total > 0 && tasks.done === tasks.total) matches['archive-pending'] = tasksF.evidence
    else if (mine && b.prObj && b.prObj.state === 'merged') matches['archive-pending'] = b.pr.evidence
  }

  // pr
  rows.push(mine ? b.prRow : row('pr', 'none', notAttributed))
  if (mine && b.prObj && b.prObj.state === 'open') matches['pr-open'] = b.pr.evidence

  // conflict
  rows.push(mine ? b.conflictRow : row('conflict', 'none', notAttributed))
  if (mine && b.conflict) matches.conflict = b.conflict.evidence

  // ci
  rows.push(mine ? b.ciRow : row('ci', 'none', notAttributed))
  if (mine && b.ciRed) matches['ci-red'] = b.ci.evidence

  // settle + merge verdict -> needs-fix
  const settle = isObj(val(settleF)) ? settleF.value : null
  let settleEvidence = settleF.evidence
  if (settle && settle.surviving > 0) {
    if (!mine) settleEvidence = `${settleF.evidence}; ${notAttributed}`
    else if (head === undefined) settleEvidence = `${settleF.evidence}; HEAD unobserved`
    else if (settle.head !== head) settleEvidence = `${settleF.evidence} for head ${String(settle.head).slice(0, 7)}, not HEAD`
    else matches['needs-fix'] = settleF.evidence
  }
  rows.push(row('settle', shown(settleF, v => (isObj(v) ? `${v.surviving} surviving` : String(v))), settleEvidence))

  const merge = isObj(val(mergeF)) ? mergeF.value : null
  const mergeMine = merge && merge.change === change ? merge : null
  if (mergeMine && mergeMine.verdict === 'BLOCK' && !matches['needs-fix']) matches['needs-fix'] = mergeF.evidence
  const outcome = ship.outcome
  let verdict = null
  let verdictEvidence
  if (mergeMine) { verdict = mergeMine.verdict ?? null; verdictEvidence = mergeF.evidence }
  else if (outcome && outcome.mergeVerdict) { verdict = outcome.mergeVerdict; verdictEvidence = ship.outcomeF.evidence }
  let mergeRow
  if (verdict) mergeRow = row('merge_verdict', verdict, verdictEvidence)
  else if (merge) mergeRow = row('merge_verdict', 'none', `${mergeF.evidence}: names ${merge.change}`)
  else mergeRow = row('merge_verdict', shown(mergeF), mergeF.evidence)
  rows.push(mergeRow)

  // manual test
  const ticked = (note?.next ?? []).some(n => n && n.checked && /manual test/i.test(String(n.text ?? '')))
  if (val(manualF) === 'present, no result' && !ticked) matches['manual-test'] = manualF.evidence
  rows.push(row('manual test', shown(manualF), manualF.evidence))

  // outcome -> shipped (an unobserved PR reads as no PR)
  const hasPr = mine && !!b.prObj
  if (outcome && outcome.commit && !hasPr) matches.shipped = ship.outcomeF.evidence
  rows.push(row('outcome', shown(ship.outcomeF, v => (isObj(v) ? `commit ${v.commit ?? 'null'} verdict ${v.mergeVerdict ?? 'none'}` : String(v))), ship.outcomeF.evidence))

  // ship -> halted
  if (ship.halted) matches.halted = ship.halted.evidence
  rows.push(ship.shipRow)

  // stage + running entry -> shipping
  const entry = isObj(val(entryF)) ? entryF.value : null
  if (ship.liveRun) matches.shipping = ship.stageF.evidence
  else if (entry && entry.state === 'running') matches.shipping = entryF.evidence
  rows.push(row('stage', shown(ship.stageF, v => (isObj(v) ? `pid ${v.pid} ${v.alive ? 'alive' : 'dead'}` : String(v))), ship.stageF.evidence))

  // queue -> queued
  if (entry && entry.state === 'pending') matches.queued = entryF.evidence
  rows.push(row('queue', shown(entryF, v => (isObj(v) ? String(v.state) : String(v))), entryF.evidence))

  // decisions, review-artifacts, checkpoint -> checkpoint
  const needsHuman = val(needsHumanF)
  const review = isObj(val(reviewF)) ? reviewF.value : null
  const cp = val(checkpointF)
  if (Array.isArray(needsHuman) && needsHuman.length) matches.checkpoint = needsHumanF.evidence
  else if (review && (cp === 'absent' || cp === 'returned')) matches.checkpoint = reviewF.evidence
  rows.push(row('decisions', shown(needsHumanF, v => (Array.isArray(v) ? (v.length ? `needs_human ${v.join(', ')}` : 'none') : String(v))), needsHumanF.evidence))
  rows.push(row('review-artifacts', shown(reviewF, v => (isObj(v) ? `${v.blockers} blockers` : String(v))), reviewF.evidence))
  rows.push(row('checkpoint', shown(checkpointF), checkpointF.evidence))
  rows.push(row('resume card', shown(resumeF), resumeF.evidence))

  // spec-draft: any active change nothing above matched
  if (isActive) matches['spec-draft'] = tasksF.evidence ?? `unobserved: ${tasksF.unobserved}`

  const chosen = STATE_TABLE.find(r => Object.hasOwn(matches, r.state)) ?? STATE_TABLE[STATE_TABLE.length - 1]
  const state = chosen.state
  let needsMe = NEEDS_ME[state] === 'verdict' ? verdict !== 'MERGE' : NEEDS_ME[state]
  let suggested = SUGGESTED[state]
  if (state === 'spec-draft' && cp === 'approved') suggested = APPROVED_SUGGESTED
  suggested = suggested === null ? null : suggested.replace('<change>', change)

  // last activity (D36); the note's own `updated` never counts
  const lastCommit = val(lastCommitF)
  const session = val(sessionF)
  const trajF = leaf(il.trajectoryTs?.[change], 'no trajectory fact')
  const mtimeF = leaf(ch.lastMtime, 'no mtime fact')
  const candidates = [
    [isObj(lastCommit) ? lastCommit.date : undefined, lastCommitF.evidence],
    [isObj(session) ? session.mtime : undefined, sessionF.evidence],
    [mine && b.prObj ? b.prObj.updatedAt : undefined, b.pr.evidence],
    [val(trajF), trajF.evidence],
    [outcome ? outcome.ts : undefined, ship.outcomeF.evidence],
    [entry ? entry.lastTs : undefined, entryF.evidence],
    [val(mtimeF), mtimeF.evidence],
    ...(note?.narrative ?? []).map(n => [n?.at, `${notePath}: narrative ${n?.at}${n?.source ? ` · ${n.source}` : ''}`]),
  ]
  const canBeStale = state !== 'archived' && state !== 'dropped'
  const ov = overlay(newest(candidates), now, limits.staleDays, canBeStale)
  rows.push(ov.lastActivity
    ? row('last activity', ov.lastActivity, ov.activityEvidence)
    : row('last activity', 'unobserved: no activity observed', null))
  if (ov.stale) { needsMe = true; suggested = STALE_SUGGESTED }

  // the frontmatter leaves
  const prLeaf = !mine
    ? fact('none', notAttributed)
    : b.prObj ? fact(b.prObj.number, b.pr.evidence) : copy(b.pr)
  const prStateLeaf = !mine
    ? fact('none', notAttributed)
    : b.prObj ? fact(String(b.prObj.state).toLowerCase(), b.pr.evidence) : copy(b.pr)
  const ciLeaf = !mine
    ? fact('none', notAttributed)
    : observed(b.ci) ? fact(b.ciValue ?? 'none', b.ci.evidence) : copy(b.ci)
  const countLeaf = key => (tasks ? fact(tasks[key], tasksF.evidence) : observed(tasksF) ? fact(null, tasksF.evidence) : copy(tasksF))

  return {
    change,
    state,
    needsMe,
    stale: ov.stale,
    idleDays: ov.idleDays,
    lastActivity: ov.lastActivity,
    suggested,
    evidence: matches[state] ?? null,
    rows,
    branch: copy(leaf(facts.git?.branch, 'no git fact')),
    pr: prLeaf,
    prState: prStateLeaf,
    ci: ciLeaf,
    mergeVerdict: fact(verdict ?? 'none', verdictEvidence ?? mergeF.evidence ?? mergeRow.evidence),
    tasksDone: countLeaf('done'),
    tasksTotal: countLeaf('total'),
    lastCommit: isObj(lastCommit) ? fact(lastCommit.sha7, lastCommitF.evidence) : copy(lastCommitF),
    lastSession: isObj(session) ? fact(session.mtime, sessionF.evidence) : copy(sessionF),
  }
}

/** The repo-level item for branch facts no change is attributed to (D29). */
function deriveRepo(facts, ctx, items) {
  const { attributed, branch: b, now, limits, notes } = ctx
  const free = attributed === null
  let state = 'idle'
  let evidence = null
  if (free) {
    if (b.conflict) { state = 'conflict'; evidence = b.conflict.evidence }
    else if (b.ciRed) { state = 'ci-red'; evidence = b.ci.evidence }
    else if (b.prObj && b.prObj.state === 'open') { state = 'pr-open'; evidence = b.pr.evidence }
    else if (b.prObj && b.prObj.state === 'merged') { state = 'merged'; evidence = b.pr.evidence }
  }
  let needsMe = ['conflict', 'ci-red', 'pr-open'].includes(state)
  let suggested = needsMe ? SUGGESTED[state] : null

  const lastCommitF = leaf(facts.git?.lastCommit, 'no git fact')
  const sessionF = leaf(facts.sessions?.lastSession, 'no sessions fact')
  const lastCommit = val(lastCommitF)
  const session = val(sessionF)
  const ov = overlay(newest([
    [isObj(lastCommit) ? lastCommit.date : undefined, lastCommitF.evidence],
    [isObj(session) ? session.mtime : undefined, sessionF.evidence],
    [free && b.prObj ? b.prObj.updatedAt : undefined, b.pr.evidence],
  ]), now, limits.staleDays, needsMe)
  if (ov.stale) { needsMe = true; suggested = STALE_SUGGESTED }

  const note = `attributed to ${attributed}`
  const branchF = leaf(facts.git?.branch, 'no git fact')
  const rows = [
    row('branch', shown(branchF), branchF.evidence),
    free ? b.conflictRow : row('conflict', 'none', note),
    free ? b.ciRow : row('ci', 'none', note),
    free ? b.prRow : row('pr', 'none', note),
    ov.lastActivity
      ? row('last activity', ov.lastActivity, ov.activityEvidence)
      : row('last activity', 'unobserved: no activity observed', null),
  ]

  const prefix = `${noteName(facts.repo?.name ?? '')}--`
  const recent = []
  for (const key of Object.keys(notes).sort()) {
    if (!key.startsWith(prefix)) continue
    const n = notes[key]
    const change = n?.frontmatter?.change ?? key.slice(prefix.length)
    for (const e of n?.narrative ?? []) {
      if (Number.isNaN(parseTime(e?.at))) continue
      recent.push({ change, at: e.at, source: e.source ?? null, body: e.body ?? '' })
    }
  }
  recent.sort((x, y) => parseTime(y.at) - parseTime(x.at) || (x.change < y.change ? -1 : x.change > y.change ? 1 : 0))

  return {
    state,
    needsMe,
    stale: ov.stale,
    idleDays: ov.idleDays,
    lastActivity: ov.lastActivity,
    suggested,
    evidence,
    rows,
    items: items.map(i => ({ change: i.change, state: i.state, needsMe: i.needsMe, lastActivity: i.lastActivity })),
    recentNarrative: recent.slice(0, 3),
  }
}

/**
 * derive(facts, { now, limits, notes }) -> { items, repo }
 * @param {import('./facts.mjs').RepoFacts} facts
 * @param {{ now: Date, limits?: { staleDays?: number, archivedKeepDays?: number }, notes?: import('./facts.mjs').NoteView }} opts
 */
export function derive(facts, { now, limits = {}, notes = {} } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  const lim = {
    staleDays: limits?.staleDays ?? LIMITS.staleDays,
    archivedKeepDays: limits?.archivedKeepDays ?? LIMITS.archivedKeepDays,
  }
  const noteView = notes ?? {}
  const os = facts.openspec ?? {}
  const active = Array.isArray(val(os.active)) ? [...os.active.value] : []
  const today = localDay(at)
  const archivedNames = new Map()
  for (const a of Array.isArray(val(os.archived)) ? os.archived.value : []) {
    if (a && typeof a.name === 'string') archivedNames.set(a.name, a)
  }
  const names = new Set(active)
  for (const [name, a] of archivedNames) {
    const day = dateDay(a.date)
    if (!Number.isNaN(day) && today - day <= lim.archivedKeepDays) names.add(name)
  }

  const ctx = {
    attributed: attribute(facts, active),
    branch: branchFacts(facts),
    now: at,
    limits: lim,
    notes: noteView,
    archivedNames,
    activeSet: new Set(active),
  }
  const items = [...names].sort().map(change => deriveItem(facts, change, ctx))
  return { items, repo: deriveRepo(facts, ctx, items) }
}
