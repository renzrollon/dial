/**
 * The remote facts (specs/remote-sources): `pr`, `ci` and `remote` for one
 * repository. Under a remote sync they come from `gh` or `glab` (by the
 * registry's host) and a completed fetch writes the cache; otherwise, and when
 * a fetch fails, they come from `cache/remote/<repo>.json` with evidence ending
 * `as of <fetchedAt>`. A failed fetch leaves the cache untouched. Nothing here
 * throws, and without `remote: true` neither CLI is ever run.
 */
import { readCache, writeCache } from './cache.mjs'
import { fact, unobserved } from './facts.mjs'
import { describeGithub, fetchGithub } from './sources/github.mjs'
import { describeGitlab, fetchGitlab } from './sources/gitlab.mjs'
import { DEFAULT_TIMEOUT_MS, exec as realExec } from './subprocess.mjs'

const FORGES = {
  github: { fetch: fetchGithub, describe: describeGithub },
  gitlab: { fetch: fetchGitlab, describe: describeGitlab },
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
      if (doWrite) writeCache(home, repo.name, data)
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

function fromData(forge, data, suffix, remoteEvidence) {
  const d = forge.describe({ branch: data.branch, pr: data.pr, checks: data.checks })
  return {
    pr: fact(d.pr.value, d.pr.evidence + suffix),
    ci: fact(d.ci.value, d.ci.evidence + suffix),
    remote: fact('ok', remoteEvidence),
  }
}
