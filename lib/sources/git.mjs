/**
 * The git source (specs/local-sources): branch, cleanliness, position,
 * conflicts, worktrees and the last commit, over an injected `exec`. Only
 * read-only git commands run; nothing here fetches, pulls or pushes. Every
 * leaf is a Fact (lib/facts.mjs); nothing here throws.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fact, unobserved } from '../facts.mjs'
import { exec as realExec, DEFAULT_TIMEOUT_MS } from '../subprocess.mjs'

const LEAVES = ['branch', 'detached', 'dirty', 'ahead', 'behind', 'stash', 'inProgress', 'unmerged', 'worktrees', 'lastCommit']

/** First non-empty stderr line, or the exit code when stderr is empty. */
function firstLine(r) {
  const line = String(r.stderr ?? '').split('\n').map(s => s.trim()).find(Boolean)
  return line ?? `exit ${r.code}`
}

/** `git: <why>` for a failed run: not on PATH, timed out, or the first stderr line. */
function failure(r, timeoutMs) {
  if (r.missing) return 'git: not on PATH'
  if (r.timedOut) return `git: timed out after ${Math.round(timeoutMs / 1000)}s`
  return `git: ${firstLine(r)}`
}

const allUnobserved = reason => Object.fromEntries(LEAVES.map(k => [k, unobserved(reason)]))

/**
 * Collect `RepoFacts.git` for the work tree at `repoPath`.
 * @param {{ repoPath: string, exec?: Function, timeoutMs?: number }} opts
 */
export function collectGit({ repoPath, exec = realExec, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // GIT_OPTIONAL_LOCKS=0: `git status` would otherwise refresh the index under .git/index.lock, which a background
  // sync can hold against the user's own commit, or leave behind when the timeout kills it.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  const run = args => exec('git', args, { cwd: repoPath, timeoutMs, env })
  const out = allUnobserved('git: not a work tree')

  const head = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.missing) return allUnobserved('git: not on PATH')
  if (!head.ok && /not a git repository/i.test(head.stderr ?? '')) return out

  // branch and detached
  let branchName = null
  if (head.ok) {
    const name = head.stdout.trim()
    if (name === 'HEAD') {
      const short = run(['rev-parse', '--short', 'HEAD'])
      if (short.ok) {
        branchName = short.stdout.trim()
        out.branch = fact(branchName, `git rev-parse --short HEAD: ${branchName} (detached)`)
        out.detached = fact(true, 'git rev-parse --abbrev-ref HEAD: HEAD')
      } else {
        out.branch = unobserved(failure(short, timeoutMs))
        out.detached = fact(true, 'git rev-parse --abbrev-ref HEAD: HEAD')
      }
    } else {
      branchName = name
      out.branch = fact(name, `git rev-parse --abbrev-ref HEAD: ${name}`)
      out.detached = fact(false, `git rev-parse --abbrev-ref HEAD: ${name}`)
    }
  } else {
    const reason = failure(head, timeoutMs)
    out.branch = unobserved(reason)
    out.detached = unobserved(reason)
  }

  // status: dirty, ahead/behind, unmerged
  const status = run(['status', '--porcelain=v2', '--branch'])
  const STATUS = 'git status --porcelain=v2 --branch'
  if (status.ok) {
    const lines = status.stdout.split('\n').filter(Boolean)
    const entries = lines.filter(l => !l.startsWith('#'))
    out.dirty = fact(entries.length, `${STATUS}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`)
    const ab = lines.map(l => /^# branch\.ab \+(\d+) -(\d+)$/.exec(l)).find(Boolean)
    if (ab) {
      const evidence = `${STATUS}: branch.ab +${ab[1]} -${ab[2]}`
      out.ahead = fact(Number(ab[1]), evidence)
      out.behind = fact(Number(ab[2]), evidence)
    } else {
      const reason = `git: no upstream for ${branchName ?? 'HEAD'}`
      out.ahead = unobserved(reason)
      out.behind = unobserved(reason)
    }
    const unmerged = entries.filter(l => l.startsWith('u ')).map(l => l.split(' ').slice(10).join(' '))
    out.unmerged = fact(unmerged, unmerged.length ? `${STATUS}: unmerged ${unmerged.join(', ')}` : `${STATUS}: no unmerged files`)
  } else {
    const reason = failure(status, timeoutMs)
    for (const k of ['dirty', 'ahead', 'behind', 'unmerged']) out[k] = unobserved(reason)
  }

  // stash
  const stash = run(['stash', 'list'])
  if (stash.ok) {
    const n = stash.stdout.split('\n').filter(Boolean).length
    out.stash = fact(n, `git stash list: ${n}`)
  } else out.stash = unobserved(failure(stash, timeoutMs))

  // in progress
  const gitDir = run(['rev-parse', '--git-dir'])
  if (gitDir.ok) {
    const dir = gitDir.stdout.trim()
    const abs = isAbsolute(dir) ? dir : join(repoPath, dir)
    const hit = ['rebase-merge', 'rebase-apply'].find(n => existsSync(join(abs, n)))
    if (hit) out.inProgress = fact('rebase', `${dir}/${hit}: present`)
    else if (existsSync(join(abs, 'MERGE_HEAD'))) out.inProgress = fact('merge', `${dir}/MERGE_HEAD: present`)
    else out.inProgress = fact('none', `${dir}: no rebase or merge in progress`)
  } else out.inProgress = unobserved(failure(gitDir, timeoutMs))

  // worktrees
  const wt = run(['worktree', 'list', '--porcelain'])
  if (wt.ok) {
    const linked = wt.stdout
      .split(/\n\s*\n/)
      .map(parseWorktree)
      .filter(Boolean)
      .slice(1)
    const names = linked.map(w => w.branch)
    out.worktrees = fact(linked, `git worktree list --porcelain: ${linked.length} linked${names.length ? ` (${names.join(', ')})` : ''}`)
  } else out.worktrees = unobserved(failure(wt, timeoutMs))

  // last commit
  const log = run(['log', '-1', '--format=%H%x09%cI'])
  if (log.ok) {
    const [sha, date] = log.stdout.trim().split('\t')
    if (sha && date) {
      const sha7 = sha.slice(0, 7)
      out.lastCommit = fact({ sha7, head: sha, date }, `git log -1: ${sha7} ${date}`)
    } else out.lastCommit = unobserved('git: log -1 printed no commit')
  } else out.lastCommit = unobserved(failure(log, timeoutMs))

  return out
}

function parseWorktree(block) {
  let path = null
  let branch = 'detached'
  for (const line of block.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
  }
  return path === null ? null : { path, branch }
}
