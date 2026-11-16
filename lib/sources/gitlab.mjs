/**
 * The GitLab source (specs/remote-sources): the merge request and its pipeline
 * through `glab`, only ever called by lib/remote.mjs under a remote sync. The
 * pipeline is cached as one check named `pipeline`. Same contract as
 * lib/sources/github.mjs. Never throws.
 */

import { cutPullRequest, cutWord } from './forge.mjs'

const NO_MR = /no open merge request/i
const NO_PIPELINE = /no pipelines? (running or available on branch|found|available)/i

const STATE = { opened: 'open', locked: 'closed', closed: 'closed', merged: 'merged' }
const BUCKET = { failed: 'fail', success: 'pass', canceled: 'cancel', skipped: 'skipping' }
const RAW_STATE = { open: 'opened', closed: 'closed', merged: 'merged' }
const RAW_BUCKET = { fail: 'failed', pass: 'success', cancel: 'canceled', skipping: 'skipped', pending: 'pending' }

function failure(r, timeoutMs) {
  if (r.missing) return 'glab: not on PATH'
  if (r.timedOut) return `glab: timed out after ${Math.round(timeoutMs / 1000)}s`
  const line = String(r.stderr ?? '').split('\n').map(s => s.trim()).find(Boolean)
  return `glab: ${line ?? `exit ${r.code}`}`
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const realDate = v => (typeof v === 'string' && v ? v : null)

/**
 * Run `glab mr view` then, when a merge request exists, `glab ci status`.
 * @param {{ cwd: string, branch: string, exec: Function, timeoutMs: number }} opts
 */
export function fetchGitlab({ cwd, branch, exec, timeoutMs }) {
  const view = exec('glab', ['mr', 'view', branch, '-F', 'json'], { cwd, timeoutMs })
  if (!view.ok) {
    if (!view.missing && !view.timedOut && NO_MR.test(`${view.stderr}\n${view.stdout}`)) return { ok: true, pr: null, checks: [] }
    return { ok: false, reason: failure(view, timeoutMs) }
  }
  const d = parseJson(view.stdout)
  if (d === null || typeof d !== 'object' || !Number.isInteger(d.iid)) return { ok: false, reason: 'glab: mr view output not valid JSON' }
  const state = STATE[String(d.state ?? '').toLowerCase()] ?? String(d.state ?? '').toLowerCase()
  const pr = {
    number: d.iid,
    state,
    url: String(d.web_url ?? ''),
    conflicting: state === 'open' && d.has_conflicts === true,
    mergedAt: realDate(d.merged_at),
    updatedAt: String(d.updated_at ?? ''),
  }

  const ci = exec('glab', ['ci', 'status', '-b', branch, '-F', 'json'], { cwd, timeoutMs })
  if (!ci.missing && !ci.timedOut && NO_PIPELINE.test(`${ci.stderr}\n${ci.stdout}`)) return { ok: true, pr, checks: [] }
  if (!ci.ok) return { ok: false, reason: failure(ci, timeoutMs) }
  const parsed = parseJson(ci.stdout)
  const obj = Array.isArray(parsed) ? parsed.find(p => p && typeof p.status === 'string') : parsed
  if (obj === null || typeof obj !== 'object' || typeof obj.status !== 'string') return { ok: false, reason: 'glab: ci status output not valid JSON' }
  const status = obj.status.toLowerCase()
  return { ok: true, pr, checks: [{ name: 'pipeline', bucket: BUCKET[status] ?? 'pending' }] }
}

/** The facts for cached-shape data, as `describeGithub` does. */
export function describeGitlab({ branch, pr, checks }) {
  if (pr === null) {
    const evidence = `glab mr view ${branch}: no pull request`
    return { pr: { value: 'none', evidence }, ci: { value: { value: 'none', failing: [] }, evidence } }
  }
  let prEvidence
  if (pr.state === 'merged') prEvidence = `glab mr view ${pr.number}: merged ${pr.mergedAt ?? ''}`.trimEnd()
  else prEvidence = `glab mr view ${pr.number}: ${RAW_STATE[pr.state] ?? pr.state}${pr.conflicting ? ', has_conflicts' : ''}`
  const prefix = `glab ci status -b ${branch}`
  if (checks.length === 0) return { pr: { value: pr, evidence: prEvidence }, ci: { value: { value: 'none', failing: [] }, evidence: `${prefix}: no pipeline` } }
  const bucket = checks[0].bucket
  return {
    pr: { value: pr, evidence: prEvidence },
    ci: { value: { value: bucket, failing: bucket === 'fail' ? ['pipeline'] : [] }, evidence: `${prefix}: ${RAW_BUCKET[bucket] ?? bucket}` },
  }
}

function listItem(d) {
  return cutPullRequest({
    number: d.iid,
    title: d.title,
    branch: d.source_branch,
    base: d.target_branch,
    url: d.web_url,
    author: d.author?.username,
    draft: d.draft === true || d.work_in_progress === true,
    review: null,
    mergeState: cutWord(d.detailed_merge_status),
    conflicting: d.has_conflicts === true,
    checks: null,
    updatedAt: d.updated_at,
  })
}

/**
 * Run `glab mr list` for `max + 1` merge requests. Same contract as `listGithub`; the list reports no review
 * decision and no pipeline, so both are null.
 * @param {{ cwd: string, exec: Function, timeoutMs: number, max: number }} opts
 */
export function listGitlab({ cwd, exec, timeoutMs, max }) {
  const run = exec('glab', ['mr', 'list', '-F', 'json', '-P', String(max + 1)], { cwd, timeoutMs })
  if (!run.ok) return { ok: false, reason: failure(run, timeoutMs) }
  const arr = parseJson(run.stdout)
  if (!Array.isArray(arr)) return { ok: false, reason: 'glab: mr list output not valid JSON' }
  const items = []
  for (const d of arr.slice(0, max)) {
    const item = d !== null && typeof d === 'object' ? listItem(d) : null
    if (item) items.push(item)
  }
  return { ok: true, items, more: arr.length > max }
}
