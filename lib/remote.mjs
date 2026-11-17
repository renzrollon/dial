/**
 * The remote facts (specs/remote-sources): `pr`, `ci` and `remote` for one
 * repository. Under a remote sync they come from `gh` or `glab` (by the
 * registry's host) and a completed fetch writes the cache; otherwise, and when
 * a fetch fails, they come from `cache/remote/<repo>.json` with evidence ending
 * `as of <fetchedAt>`. A failed fetch leaves the cache untouched. Nothing here
 * throws, and without `remote: true` neither CLI is ever run.
 *
 * After a complete fetch that writes the cache, one list call records the open
 * pull requests as the cache's `prs` (add-dial-ask delta). The list is its own
 * observation: a failed list keeps the previous `prs` for the same host and
 * writes `prsError`, never failing the fetch, and the three facts returned do
 * not change. `openPullRequests` is the offline reader of that list.
 */
import { readCache, writeCache } from './cache.mjs'
import { fact, unobserved } from './facts.mjs'
import { LIMITS } from './limits.mjs'
import { cutPullRequest } from './sources/forge.mjs'
import { describeGithub, fetchGithub, listGithub } from './sources/github.mjs'
import { describeGitlab, fetchGitlab, listGitlab } from './sources/gitlab.mjs'
import { DEFAULT_TIMEOUT_MS, exec as realExec } from './subprocess.mjs'

const FORGES = {
  github: { fetch: fetchGithub, describe: describeGithub, list: listGithub },
  gitlab: { fetch: fetchGitlab, describe: describeGitlab, list: listGitlab },
}

const allUnobserved = reason => ({ pr: unobserved(reason), ci: unobserved(reason), remote: unobserved(reason) })

/**
 * True when `--due-remote` should fetch: no usable cache, or its `fetchedAt` is
 * older than `limits.remoteIntervalMinutes`.
 * @param {{ home: string, repo: string, limits: { remoteIntervalMinutes: number }, now: Date }} opts
 */
export function dueRemote({ home, repo, limits, now }) {
  const cached = readCache(home, repo)
  if (!cached.ok) return true
  const at = Date.parse(cached.data.fetchedAt)
  if (Number.isNaN(at)) return true
  return now.getTime() - at > limits.remoteIntervalMinutes * 60_000
}

/**
 * Build the remote facts.
 * @param {{
 *   repo: { name: string, path: string, host: string }, git: { branch: object, detached?: object },
 *   home: string, limits: { subprocessTimeoutSeconds: number }, now: Date,
 *   remote?: boolean, writeCache?: boolean, exec?: Function
 * }} opts `git` is the git source's facts; the branch looked up is its `branch`.
 *   `writeCache: false` (a dry run) fetches without writing.
 * @returns {{ pr: object, ci: object, remote: object }}
 */
export function remoteFacts({ repo, git, home, limits, now, remote = false, writeCache: doWrite = true, exec = realExec }) {
  const forge = FORGES[repo.host]
  if (!forge) return allUnobserved(`host ${repo.host} has no remote CLI`)
  if (git?.detached?.value === true) return allUnobserved('detached HEAD, no branch to look up')
  const branchFact = git?.branch
  if (!branchFact || typeof branchFact.value !== 'string') return allUnobserved(branchFact?.unobserved ?? 'no branch to look up')
  const branch = branchFact.value

  let failed = null
  if (remote) {
    const timeoutMs = (limits?.subprocessTimeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000
    const got = forge.fetch({ cwd: repo.path, branch, exec, timeoutMs })
    if (got.ok) {
      const data = { fetchedAt: now.toISOString(), host: repo.host, branch, pr: got.pr, checks: got.checks }
      if (doWrite) writeCache(home, repo.name, { ...data, ...listStep({ forge, repo, home, limits, now, exec, timeoutMs }) })
      return fromData(forge, data, '', `remote cache: fetched ${data.fetchedAt}`)
    }
    failed = got.reason
  }

  const cached = readCache(home, repo.name)
  if (!cached.ok) return allUnobserved(failed ?? (cached.absent ? 'no remote cache, run dial sync --remote' : cached.reason))
  const data = cached.data
  if (data.host !== repo.host || data.branch !== branch) {
    return allUnobserved(failed ?? `remote cache is for ${data.host} branch ${data.branch}`)
  }
  if (!(data.pr === null || (typeof data.pr === 'object' && Number.isInteger(data.pr?.number))) || !Array.isArray(data.checks)) {
    return allUnobserved(failed ?? `cache/remote/${repo.name}.json malformed`)
  }
  const out = fromData(forge, data, ` as of ${data.fetchedAt}`, `remote cache: fetched ${data.fetchedAt}`)
  if (failed) out.remote = unobserved(failed)
  return out
}

/**
 * The list step of a complete fetch: `{ prs }` on success; on failure `{ prsError }`, plus the previous cache's
 * `prs` when that cache was written for the same host.
 */
function listStep({ forge, repo, home, limits, now, exec, timeoutMs }) {
  const at = now.toISOString()
  const max = limits?.remotePullRequests ?? LIMITS.remotePullRequests
  const listed = forge.list({ cwd: repo.path, exec, timeoutMs, max })
  if (listed.ok) return { prs: { fetchedAt: at, items: listed.items, more: listed.more === true } }
  const prev = readCache(home, repo.name)
  const kept = prev.ok && prev.data.host === repo.host && prev.data.prs !== undefined ? { prs: prev.data.prs } : {}
  return { ...kept, prsError: { at, reason: listed.reason } }
}

/**
 * The open pull requests of the last list, read offline. The cache's `branch` is ignored: the list is repo-wide.
 * Observed: `{ observed: true, fetchedAt, ageMinutes, stale, more, error, items }`, each item re-cut because the
 * cache is a plain file. Otherwise `{ observed: false, reason, error }`.
 * @param {{ repo: { name: string, host: string }, home: string, limits?: { remoteIntervalMinutes?: number }, now: Date }} opts
 */
export function openPullRequests({ repo, home, limits, now }) {
  const none = (reason, error = null) => ({ observed: false, reason, error })
  const cached = readCache(home, repo.name)
  if (!cached.ok) return none(cached.absent ? 'no remote cache, run dial sync --remote' : cached.reason)
  const data = cached.data
  if (data.host !== repo.host) return none(`remote cache is for ${data.host}`)
  const error = listError(data.prsError)
  if (data.prs === undefined) return none('open pull requests not listed yet, run dial sync --remote', error)
  const prs = data.prs
  const at = prs !== null && typeof prs === 'object' && typeof prs.fetchedAt === 'string' ? Date.parse(prs.fetchedAt) : NaN
  if (Number.isNaN(at) || !Array.isArray(prs.items)) return none(`cache/remote/${repo.name}.json malformed`)
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000))
  const interval = limits?.remoteIntervalMinutes ?? LIMITS.remoteIntervalMinutes
  return {
    observed: true,
    fetchedAt: new Date(at).toISOString(),
    ageMinutes,
    stale: ageMinutes > interval,
    more: prs.more === true,
    error,
    items: prs.items.map(cutPullRequest).filter(Boolean),
  }
}

/** The cache's `prsError` as `{ at, reason }`, or null when it is absent or not that shape. */
function listError(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.at !== 'string' || typeof value.reason !== 'string') return null
  return { at: value.at, reason: value.reason }
}

function fromData(forge, data, suffix, remoteEvidence) {
  const d = forge.describe({ branch: data.branch, pr: data.pr, checks: data.checks })
  return {
    pr: fact(d.pr.value, d.pr.evidence + suffix),
    ci: fact(d.ci.value, d.ci.evidence + suffix),
    remote: fact('ok', remoteEvidence),
  }
}
