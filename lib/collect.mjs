/**
 * `collectRepo`: every source for one registered repository, assembled into a
 * `RepoFacts` bundle (lib/facts.mjs). A source that is absent answers with
 * unobserved facts and a source that throws is caught and reported as
 * unobserved; this function never throws.
 */
import { LIMITS } from './limits.mjs'
import { resolveHome } from './home.mjs'
import { unobserved } from './facts.mjs'
import { remoteFacts } from './remote.mjs'
import { collectEscapement } from './sources/escapement.mjs'
import { collectGit } from './sources/git.mjs'
import { collectInterlock } from './sources/interlock.mjs'
import { collectOpenspec } from './sources/openspec.mjs'
import { realOr } from './sources/paths.mjs'
import { collectSessions } from './sources/sessions.mjs'
import { exec as realExec } from './subprocess.mjs'

const GIT_LEAVES = ['branch', 'detached', 'dirty', 'ahead', 'behind', 'stash', 'inProgress', 'unmerged', 'worktrees', 'lastCommit']
const INTERLOCK_LEAVES = ['run', 'waves', 'terminal', 'interrupted', 'merge', 'settle', 'drift']
const INTERLOCK_MAPS = ['stages', 'outcomes', 'reviewArtifacts', 'resumeCards', 'trajectoryTs']

const failedGit = reason => Object.fromEntries(GIT_LEAVES.map(k => [k, unobserved(reason)]))
const failedOpenspec = reason => ({ active: unobserved(reason), archived: unobserved(reason), changes: {} })
const failedInterlock = reason => ({
  ...Object.fromEntries(INTERLOCK_LEAVES.map(k => [k, unobserved(reason)])),
  ...Object.fromEntries(INTERLOCK_MAPS.map(k => [k, {}])),
})
const failedRemote = reason => ({ pr: unobserved(reason), ci: unobserved(reason), remote: unobserved(reason) })

/** Run `fn`; on a throw return `fallback(<source>: <message>)`. */
function guard(source, fn, fallback) {
  try {
    return fn()
  } catch (err) {
    return fallback(`${source}: ${err?.message ?? err}`)
  }
}

/**
 * Collect the facts for one repository.
 * @param {{
 *   repo: { name: string, path: string, vault: string, host: string },
 *   registry?: object, limits?: object, env?: NodeJS.ProcessEnv, now?: Date, home?: string,
 *   exec?: Function, remote?: boolean, writeCache?: boolean, runDrift?: boolean, excludeSession?: string|null
 * }} opts `remote` fetches from `gh`/`glab` (else the cache is read); `writeCache: false` is a dry run;
 *   `runDrift` runs `interlock drift --json` (sync only).
 * @returns {import('./facts.mjs').RepoFacts}
 */
export function collectRepo({
  repo,
  limits = LIMITS,
  env = process.env,
  now = new Date(),
  home,
  exec = realExec,
  remote = false,
  writeCache = true,
  runDrift = false,
  excludeSession = null,
}) {
  const repoPath = repo.path
  const timeoutMs = (limits.subprocessTimeoutSeconds ?? LIMITS.subprocessTimeoutSeconds) * 1000
  const dialHome = home ?? resolveHome(env)

  const git = guard('git', () => collectGit({ repoPath, exec, timeoutMs }), failedGit)
  const openspec = guard('openspec', () => collectOpenspec({ repoPath }), failedOpenspec)
  const active = Array.isArray(openspec.active?.value) ? openspec.active.value : []
  const interlock = guard('interlock', () => collectInterlock({ repoPath, env, exec, timeoutMs, changes: active, runDrift }), failedInterlock)
  const escapement = guard(
    'escapement',
    () => ({ entries: collectEscapement({ repoPath, env, now, changes: active }).entries }),
    reason => ({ entries: Object.fromEntries(active.map(c => [c, unobserved(reason)])) })
  )
  const worktrees = Array.isArray(git.worktrees?.value) ? git.worktrees.value : []
  const sessions = guard('sessions', () => collectSessions({ repoPath, worktrees, env, excludeSession }), reason => ({ lastSession: unobserved(reason) }))
  const forge = guard('remote', () => remoteFacts({ repo, git, home: dialHome, limits, now, remote, writeCache, exec }), failedRemote)

  return {
    repo: { name: repo.name, path: repoPath, realPath: realOr(repoPath), vault: repo.vault, host: repo.host },
    git,
    openspec,
    interlock,
    escapement,
    sessions,
    remote: forge,
  }
}
