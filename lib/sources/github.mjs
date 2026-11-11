/**
 * The GitHub source (specs/remote-sources): the pull request and its checks
 * through `gh`, only ever called by lib/remote.mjs under a remote sync.
 * `fetchGithub` returns the data a cache holds (`{ ok: true, pr, checks }`) or
 * `{ ok: false, reason }`; `describeGithub` turns that data into facts' values
 * and evidence, the same way for a fresh fetch and a cached one. Never throws.
 */

const PR_FIELDS = 'number,state,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,updatedAt,headRefName'
const CHECK_FIELDS = 'name,bucket,state,link'
const NO_PR = /no pull requests found/i
const NO_CHECKS = /no checks reported on the '.*' branch/i

/** `gh: <why>` for a command that returned no result, or null when it ran and printed something. */
function failure(r, timeoutMs) {
  if (r.missing) return 'gh: not on PATH'
  if (r.timedOut) return `gh: timed out after ${Math.round(timeoutMs / 1000)}s`
  const line = String(r.stderr ?? '').split('\n').map(s => s.trim()).find(Boolean)
  return `gh: ${line ?? `exit ${r.code}`}`
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const realDate = v => (typeof v === 'string' && v && !v.startsWith('0001-') ? v : null)

/**
 * Run `gh pr view` then, when a PR exists, `gh pr checks`.
 * `pr` is null for "no pull request" (and `checks` is then `[]`); `checks` is `[{ name, bucket }]`.
 * @param {{ cwd: string, branch: string, exec: Function, timeoutMs: number }} opts
 */
export function fetchGithub({ cwd, branch, exec, timeoutMs }) {
  const view = exec('gh', ['pr', 'view', branch, '--json', PR_FIELDS], { cwd, timeoutMs })
  if (!view.ok) {
    if (!view.missing && !view.timedOut && NO_PR.test(`${view.stderr}\n${view.stdout}`)) return { ok: true, pr: null, checks: [] }
    return { ok: false, reason: failure(view, timeoutMs) }
  }
  const d = parseJson(view.stdout)
  if (d === null || typeof d !== 'object' || !Number.isInteger(d.number)) return { ok: false, reason: 'gh: pr view output not valid JSON' }
  const state = String(d.state ?? '').toLowerCase()
  const pr = {
    number: d.number,
    state,
    url: String(d.url ?? ''),
    conflicting: state === 'open' && d.mergeable === 'CONFLICTING',
    mergedAt: realDate(d.mergedAt),
    updatedAt: String(d.updatedAt ?? ''),
  }

  // Exit 8 means checks pending and still prints JSON: stdout that parses as an array is a result whatever the exit code.
  const checksRun = exec('gh', ['pr', 'checks', branch, '--json', CHECK_FIELDS], { cwd, timeoutMs })
  const arr = checksRun.missing || checksRun.timedOut ? undefined : parseJson(checksRun.stdout)
  if (Array.isArray(arr)) {
    return { ok: true, pr, checks: arr.map(c => ({ name: String(c?.name ?? ''), bucket: String(c?.bucket ?? '') })) }
  }
  if (!checksRun.missing && !checksRun.timedOut && !checksRun.ok && NO_CHECKS.test(`${checksRun.stderr}\n${checksRun.stdout}`)) {
    return { ok: true, pr, checks: [] }
  }
  return { ok: false, reason: checksRun.ok ? 'gh: pr checks output not valid JSON' : failure(checksRun, timeoutMs) }
}

/**
 * The facts for cached-shape data: `{ pr: { value, evidence }, ci: { value, evidence } }`.
 * `ci` is `fail` if any bucket is `fail`, else `pending`, else `cancel`, else `pass`; `[]` is `none`.
 */
export function describeGithub({ branch, pr, checks }) {
  if (pr === null) {
    const evidence = `gh pr view ${branch}: no pull request`
    return { pr: { value: 'none', evidence }, ci: { value: { value: 'none', failing: [] }, evidence } }
  }
  let prEvidence
  if (pr.state === 'merged') prEvidence = `gh pr view ${pr.number}: MERGED ${pr.mergedAt ?? ''}`.trimEnd()
  else if (pr.conflicting) prEvidence = `gh pr view ${pr.number} mergeable: CONFLICTING`
  else prEvidence = `gh pr view ${pr.number}: ${pr.state.toUpperCase()}`
  const prefix = `gh pr checks ${branch}`
  if (checks.length === 0) return { pr: { value: pr, evidence: prEvidence }, ci: { value: { value: 'none', failing: [] }, evidence: `${prefix}: no checks` } }
  const named = bucket => checks.filter(c => c.bucket === bucket).map(c => c.name)
  const winner = ['fail', 'pending', 'cancel'].find(b => named(b).length > 0)
  if (!winner) return { pr: { value: pr, evidence: prEvidence }, ci: { value: { value: 'pass', failing: [] }, evidence: `${prefix}: pass` } }
  const names = named(winner)
  return {
    pr: { value: pr, evidence: prEvidence },
    ci: { value: { value: winner, failing: winner === 'fail' ? names : [] }, evidence: `${prefix}: ${winner} (${names.join(', ')})` },
  }
}
