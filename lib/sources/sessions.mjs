/**
 * The sessions source (specs/local-sources): the last Claude Code session
 * from transcript mtimes alone. Contents are never read.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fact, unobserved } from '../facts.mjs'
import { collapseHome, homeOf, isoSeconds, realOr } from './paths.mjs'

/** Claude Code's project slug: every character outside `[A-Za-z0-9-]` becomes `-`. */
export function slugOf(path) {
  return path.replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * Collect `RepoFacts.sessions`. Reads depth-1 `*.jsonl` under
 * `~/.claude/projects/<slug>/` for the registered path's slug, the slug of its
 * real path when that differs, each linked worktree's slug, and every
 * `<slug>--claude-worktrees-*` directory. The newest mtime wins; with
 * `excludeSession` the file `<id>.jsonl` is ignored.
 * @param {{ repoPath: string, worktrees?: (string|{path:string})[], env?: NodeJS.ProcessEnv, excludeSession?: string|null }} opts
 */
export function collectSessions({ repoPath, worktrees = [], env = process.env, excludeSession = null }) {
  const userHome = homeOf(env)
  const projects = join(userHome, '.claude', 'projects')
  const paths = [repoPath, realOr(repoPath), ...worktrees.map(w => (typeof w === 'string' ? w : w.path))]
  const slugs = [...new Set(paths.flatMap(p => [slugOf(p), slugOf(realOr(p))]))]
  const primary = slugOf(repoPath)

  let present = []
  try {
    present = readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    /* no projects directory: no sessions */
  }
  const dirs = present.filter(name => slugs.some(s => name === s || name.startsWith(`${s}--claude-worktrees-`))).sort()

  let best = null
  const skip = excludeSession ? `${excludeSession}.jsonl` : null
  for (const dir of dirs) {
    let files
    try {
      files = readdirSync(join(projects, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name === skip) continue
      const file = join(projects, dir, f.name)
      let ms
      try {
        ms = statSync(file).mtimeMs
      } catch {
        continue
      }
      if (best === null || ms > best.ms) best = { ms, file }
    }
  }
  if (best === null) {
    return { lastSession: unobserved(`no sessions under ${collapseHome(join(projects, primary), userHome)}`) }
  }
  return { lastSession: fact({ file: best.file, mtime: isoSeconds(best.ms) }, collapseHome(best.file, userHome)) }
}
