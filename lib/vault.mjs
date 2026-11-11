/**
 * Vault writes (design.md §Vault writes, specs/vault-writes). The one place Dial
 * writes into a vault: every write goes through the boundary check against the
 * registry, lands atomically through a hidden temp file in the target's
 * directory, skips unchanged bytes, and is re-read just before the rename so a
 * note another writer changed in between is planned again, never overwritten.
 * Nothing here unlinks a vault file other than its own `.<name>.<pid>.tmp`.
 *
 * Lib functions return data or `{ ok: false, reason }` with a bare reason (the
 * CLI prefixes `dial: `); the one line written directly is the `dial: <path>
 * changed during the write; skipped` warning, through the injectable `warn`.
 *
 * A write is one of
 *   { path, render(existing | null) -> text | null }   planned from the file's bytes, planned again on change
 *   { path, content }                                  fixed bytes; skipped, not overwritten, when the file changed
 *   { from, to, render? }                              the archive move: `render` rewrites `from` in place, then it is renamed
 * with `path`, `from` and `to` relative to the vault, and an optional `verb: 'append'` that names an
 * update of a log file `append` in a plan.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noteName } from './facts.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import {
  formatValue, headingName, joinNote, localDate, narrativeEntries, nextItems, splitNote,
} from './note.mjs'
import { expandHome, resolveRepo, rootVault } from './registry.mjs'

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))

/** The folders Dial may write into, and the root files it may write (specs/vault-writes, boundary). */
const FOLDERS = ['Projects', 'Changes', 'Daily', 'Templates', 'Inbox']
const ROOT_FILES = ['Dial.base', 'Dial Summary.md', 'Dial Queries.md']

const SKELETON = '---\ntype: daily\nstatus: active\ntags: [daily]\naliases: []\n---\n\n## Log\n\n'

const asDate = now => (now instanceof Date ? now : now ? new Date(now) : new Date())

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// --- reading ------------------------------------------------------------------

/**
 * The `NoteView` of what the vault holds for one repo: `Projects/<repo>.md` (key `<repo>`) and every
 * `Changes/<repo>--*.md` (key `<repo>--<change>`), each `{ path, frontmatter, next, narrative }` with
 * `path` relative to the vault. A note whose own `repo` key names another repo is not this repo's.
 * A missing folder is an empty view; `.obsidian/` is never read.
 */
export function readNotes(vaultPath, repo) {
  const view = {}
  const repoKey = noteName(repo)
  const take = (rel, key) => {
    const text = readText(join(vaultPath, rel))
    if (text === null) return
    const parts = splitNote(text)
    const frontmatter = readFrontmatter(parts.frontmatter) ?? {}
    if (frontmatter.repo !== undefined && frontmatter.repo !== repo) return
    const section = name => parts.sections.find(s => headingName(s.heading) === name)
    view[key] = {
      path: rel,
      frontmatter,
      next: nextItems(section('Next')),
      narrative: narrativeEntries(section('Narrative')).map(({ at, source, body }) => ({ at, source, body })),
    }
  }
  take(`Projects/${repoKey}.md`, repoKey)
  let names = []
  try {
    names = readdirSync(join(vaultPath, 'Changes')).filter(n => n.endsWith('.md') && n.startsWith(`${repoKey}--`)).sort()
  } catch {
    names = []
  }
  for (const n of names) take(`Changes/${n}`, n.slice(0, -3))
  return view
}

// --- frontmatter edits --------------------------------------------------------

/**
 * Set flat keys in a note's frontmatter, every other byte kept: an existing key's line is replaced in
 * place, a new key goes last in the block, a note without frontmatter gains one.
 */
export function setFrontmatter(text, pairs) {
  const entries = Object.entries(pairs)
  const { frontmatter } = splitNote(text)
  if (!frontmatter) {
    return `---\n${entries.map(([k, v]) => `${k}: ${formatValue(v)}`).join('\n')}\n---\n${text}`
  }
  const lines = frontmatter.split('\n')
  let close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---')
  for (const [key, value] of entries) {
    const line = `${key}: ${formatValue(value)}`
    const at = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^${key}:(\\s|$)`).test(l))
    if (at === -1) {
      lines.splice(close, 0, line)
      close++
    } else {
      lines[at] = line
    }
  }
  return lines.join('\n') + text.slice(frontmatter.length)
}

// --- the boundary -------------------------------------------------------------

/** The real path of the nearest existing ancestor of `abs` with the missing tail appended. */
function realTarget(abs) {
  let cur = abs
  const rest = []
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      rest.push(basename(cur))
      cur = parent
    }
  }
}

const inside = (base, p) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep)

/** True when `rel` names a folder or root file Dial may write. */
function allowedRel(rel) {
  if (!rel || isAbsolute(rel)) return false
  const parts = rel.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) return false
  if (parts.length === 1) return ROOT_FILES.includes(parts[0])
  if (parts[0] === 'Archive') return parts.length >= 3 && parts[1] === 'Changes'
  return FOLDERS.includes(parts[0])
}

const targetsOf = write => (write.from !== undefined ? [write.from, write.to] : [write.path])

/**
 * The boundary: every target of `writes` must lie in an allowed place of the vault the registry names for
 * `ctx.repo` (or, with no repo, of a vault named in the registry). Returns `{ ok: true }` or `{ ok: false, reason }`.
 * Reads the disk (existence, real paths) and writes nothing.
 */
function guard(vaultPath, writes, ctx) {
  const { registry, repo } = ctx
  const bad = reason => ({ ok: false, reason })
  if (!registry) return bad('refusing to write into a vault without a registry')
  const root = resolve(vaultPath)
  let registered
  let label
  if (repo !== undefined && repo !== null) {
    const entry = resolveRepo(registry, repo)
    if (!entry) return bad(`no registered repo matches ${repo}`)
    const rv = rootVault(registry, entry.path)
    if (rv && rv.vault !== entry.vault) {
      return bad(`${entry.name} is under ${rv.root}, which belongs to vault ${rv.vault}; refusing to write into vault ${entry.vault}`)
    }
    registered = resolve(expandHome(registry.vaults[entry.vault]))
    if (!isDir(registered)) return bad(`vault ${entry.vault} for ${entry.name} does not exist: ${registered}`)
    label = target => `${entry.name} is registered to vault ${entry.vault}; refusing to write into ${target}`
  } else {
    const names = ctx.vault !== undefined ? [ctx.vault] : Object.keys(registry.vaults ?? {})
    const real = realTarget(root)
    registered = names
      .filter(n => Object.hasOwn(registry.vaults ?? {}, n))
      .map(n => resolve(expandHome(registry.vaults[n])))
      .find(p => realTarget(p) === real)
    if (!registered) return bad(`refusing to write into ${root}: not a vault named in the registry`)
    label = target => `refusing to write into ${target}: outside vault ${registered}`
  }
  const base = realTarget(registered)
  for (const write of writes) {
    for (const rel of targetsOf(write)) {
      const abs = resolve(root, typeof rel === 'string' ? rel : '')
      if (typeof rel !== 'string' || !allowedRel(rel) || !inside(base, realTarget(abs))) return bad(label(abs))
    }
  }
  return { ok: true }
}

// --- planning -----------------------------------------------------------------

function renderOf(write, existing) {
  if (write.render) return write.render(existing)
  return write.content
}

function planOne(vaultPath, write) {
  if (write.from !== undefined) {
    const from = join(vaultPath, write.from)
    const to = join(vaultPath, write.to)
    if (!existsSync(from) || existsSync(to)) return { verb: 'unchanged', path: from, line: `unchanged ${from}` }
    return { verb: 'move', from, to, path: to, line: `move ${from} → ${to}` }
  }
  const path = join(vaultPath, write.path)
  const base = readText(path)
  const next = renderOf(write, base)
  let verb = 'update'
  if (next === null || next === base) verb = 'unchanged'
  else if (base === null) verb = 'create'
  else if (write.verb === 'append') verb = 'append'
  return { verb, path, line: `${verb} ${path}` }
}

/**
 * The dry run: what `applyWrites` would do, as `{ ok: true, plan: [{ verb, path, from?, to?, line }] }`,
 * the verb one of `create`, `update`, `unchanged`, `append`, `move` and `line` the printed form
 * (`<verb> <path>`, a move as `move <from> → <to>`). Runs the same boundary check; writes nothing,
 * not even a folder.
 */
export function planWrites(vaultPath, writes, ctx = {}) {
  const verdict = guard(vaultPath, writes, ctx)
  if (!verdict.ok) return verdict
  return { ok: true, plan: writes.map(w => planOne(resolve(vaultPath), w)) }
}

// --- applying -----------------------------------------------------------------

function unlinkQuiet(path) {
  try {
    unlinkSync(path)
  } catch {
    // the temp file was never created, or is already gone
  }
}

/**
 * One file: render from the bytes on disk, write the hidden temp file, re-read the target, and rename
 * only when the target still holds the bytes the write was planned from. A change is planned once more
 * from the new bytes; a second change skips the file with a warning.
 */
function applyFile(path, write, ctx) {
  const rename = ctx.rename ?? renameSync
  const warn = ctx.warn ?? (line => process.stderr.write(`${line}\n`))
  const beforeRename = ctx.beforeRename ?? (() => {})
  const pid = ctx.pid ?? process.pid

  let base = readText(path)
  let next = renderOf(write, base)
  if (next === null || next === base) return { verb: 'unchanged', path }
  let verb = base === null ? 'create' : write.verb === 'append' ? 'append' : 'update'

  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${pid}.tmp`)
  try {
    for (let attempt = 0; ; attempt++) {
      writeFileSync(tmp, next)
      beforeRename(path, attempt)
      const current = readText(path)
      if (current === base) break
      if (attempt === 1 || !write.render) {
        unlinkQuiet(tmp)
        warn(`dial: ${path} changed during the write; skipped`)
        return { verb: 'skipped', path, reason: 'changed during the write' }
      }
      base = current
      next = write.render(current)
      if (next === null || next === current) {
        unlinkQuiet(tmp)
        return { verb: 'unchanged', path }
      }
      verb = current === null ? 'create' : write.verb === 'append' ? 'append' : 'update'
    }
    rename(tmp, path)
  } catch (err) {
    unlinkQuiet(tmp)
    throw err
  }
  return { verb, path }
}

/** The archive move: rewrite in place when asked, then rename into the target's folder; never over a file. */
function applyMove(vaultPath, write, ctx) {
  const from = join(vaultPath, write.from)
  const to = join(vaultPath, write.to)
  if (!existsSync(from) || existsSync(to)) return { verb: 'unchanged', path: from }
  if (write.render) {
    const rewritten = applyFile(from, { render: write.render }, ctx)
    if (rewritten.verb === 'skipped') return rewritten
  }
  mkdirSync(dirname(to), { recursive: true })
  if (existsSync(to)) return { verb: 'unchanged', path: from }
  ;(ctx.rename ?? renameSync)(from, to)
  return { verb: 'move', from, to, path: to }
}

/**
 * Apply `writes` into `vaultPath` after the boundary check: `{ ok: true, results: [{ verb, path, from?, to? }] }`
 * with the verb `create`, `update`, `append`, `move`, `unchanged` or `skipped`, or `{ ok: false, reason }`
 * for a refusal (nothing written) or a failed write (`results` holds what landed before it).
 * `ctx = { registry, repo, vault?, warn?, pid?, rename?, beforeRename? }`; `beforeRename(path, attempt)` runs
 * between a temp file's write and the re-read, where another writer can land.
 */
export function applyWrites(vaultPath, writes, ctx = {}) {
  const verdict = guard(vaultPath, writes, ctx)
  if (!verdict.ok) return verdict
  const root = resolve(vaultPath)
  const results = []
  for (const write of writes) {
    try {
      results.push(write.from !== undefined ? applyMove(root, write, ctx) : applyFile(join(root, write.path), write, ctx))
    } catch (err) {
      return { ok: false, reason: `cannot write ${write.path ?? write.to}: ${err.message}`, results }
    }
  }
  return { ok: true, results }
}

// --- the daily log ------------------------------------------------------------

/** `text` with `lines` added at the end of its `## Log` section, the section added last when missing. */
function addLogLines(text, lines) {
  const parts = splitNote(text)
  const at = parts.sections.findIndex(s => headingName(s.heading) === 'Log')
  const block = lines.join('\n')
  if (at === -1) {
    let out = text
    if (out !== '' && !out.endsWith('\n')) out += '\n'
    if (out !== '' && !out.endsWith('\n\n')) out += '\n'
    return `${out}## Log\n\n${block}\n`
  }
  const section = parts.sections[at]
  const tailAt = /(?:\n[ \t]*)*$/.exec(section.body).index
  const core = section.body.slice(0, tailAt)
  const tail = section.body.slice(tailAt)
  if (section.eol === '') section.eol = '\n'
  if (core === '') section.body = `\n${block}\n${tail.startsWith('\n') ? tail.slice(1) : tail}`
  else section.body = `${core}\n${block}${tail.startsWith('\n') ? tail : `\n${tail}`}`
  return joinNote(parts)
}

/**
 * Append transition or handoff lines to today's daily note under `## Log`. The note is created from the
 * vault's `Templates/Daily.md` byte for byte when present, else from Dial's skeleton; a missing `## Log` is
 * added last; an existing `updated` key becomes today and no other byte changes. Goes through `applyWrites`,
 * so the same boundary and re-read rules hold. `ctx = { now, registry, repo, … }` as for `applyWrites`.
 */
export function appendDaily(vaultPath, lines, ctx = {}) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(l => typeof l === 'string' && l !== '')
  if (!list.length) return { ok: true, results: [] }
  const today = localDate(asDate(ctx.now))
  const template = () => readText(join(vaultPath, 'Templates', 'Daily.md'))
  return applyWrites(vaultPath, [{
    path: `Daily/${today}.md`,
    verb: 'append',
    render: existing => {
      if (existing === null) return addLogLines(template() ?? SKELETON, list)
      const added = addLogLines(existing, list)
      return readFrontmatter(splitNote(added).frontmatter)?.updated !== undefined ? setFrontmatter(added, { updated: today }) : added
    },
  }], ctx)
}

// --- archive and drop ---------------------------------------------------------

const DAY = 86_400_000

/**
 * The moves of archived change notes out of `Changes/`: a note whose `state` is `archived` and whose OpenSpec
 * archive date (`archived`, the `openspec.archived` fact's `[{ name, date }]`) is more than `archivedKeepDays`
 * days before today goes to `Archive/Changes/<same name>.md` with `status: archived` and `archived: <today>`,
 * every other byte kept. Returns writes for `planWrites` / `applyWrites`; a move whose target exists is a no-op
 * there. Nothing is unlinked. `opts = { repo, archived, archivedKeepDays, now, notes? }`.
 */
export function archiveNotes(vaultPath, opts) {
  const { repo, archivedKeepDays } = opts
  const list = Array.isArray(opts.archived) ? opts.archived : []
  const today = localDate(asDate(opts.now))
  const notes = opts.notes ?? readNotes(vaultPath, repo)
  const writes = []
  for (const { name, date } of list) {
    const key = noteName(repo, name)
    if (notes[key]?.frontmatter?.state !== 'archived') continue
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY
    if (!(age > archivedKeepDays)) continue
    writes.push({
      from: `Changes/${key}.md`,
      to: `Archive/Changes/${key}.md`,
      render: text => setFrontmatter(text, { status: 'archived', archived: today }),
    })
  }
  return writes
}

/**
 * `dial drop`: set `dropped: <today>`, `state: dropped`, `needs_me: false` and `updated: <today>` in the change
 * note's frontmatter, every other byte kept. A note already dropped keeps its first date and is not rewritten.
 * Returns `{ ok: true, link, dropped (false when it already was), results }` or `{ ok: false, reason }`.
 * `ctx = { now, registry, … }` as for `applyWrites`; `repo` is the registered repo's name.
 */
export function dropNote(vaultPath, repo, change, ctx = {}) {
  const today = localDate(asDate(ctx.now))
  const name = noteName(repo, change)
  const rel = `Changes/${name}.md`
  const checked = guard(vaultPath, [{ path: rel }], { ...ctx, repo })
  if (!checked.ok) return checked
  const vault = resolveRepo(ctx.registry, repo)?.vault
  const existing = readText(join(vaultPath, rel))
  if (existing === null) return { ok: false, reason: `no note for ${repo}/${change} in vault ${vault}` }
  const already = readFrontmatter(splitNote(existing).frontmatter)?.dropped !== undefined
  const written = applyWrites(vaultPath, [{
    path: rel,
    render: text => {
      if (readFrontmatter(splitNote(text).frontmatter)?.dropped !== undefined) return text
      return setFrontmatter(text, { dropped: today, state: 'dropped', needs_me: false, updated: today })
    },
  }], { ...ctx, repo })
  if (!written.ok) return written
  return { ok: true, link: `[[${name}]]`, dropped: !already, results: written.results }
}

// --- vault init ---------------------------------------------------------------

/** The four copied files: vault-relative path and the shipped template it comes from. */
const INIT_FILES = [
  ['Dial.base', 'Dial.base'],
  ['Templates/Dial Change.md', 'Dial Change.md'],
  ['Dial Queries.md', 'Dial Queries.md'],
  ['Templates/Daily.md', 'Daily.md'],
]

/**
 * `dial vault init <name> [--force]`: ensure `Projects/`, `Changes/` and `Templates/`, copy the four shipped
 * files when absent (`force` rewrites a differing one), and report one `{ verb, path }` per path in order, the
 * verb `created`, `unchanged` or `rewritten`, then the instruction to append the AGENTS section by hand.
 * Returns `{ ok: true, entries, lines }` (`lines` the printed lines) or `{ ok: false, reason }`. Never reads or
 * writes `.obsidian/` or `AGENTS.md`. `ctx = { force, templatesDir?, registry, warn? }`.
 */
export function vaultInit(name, ctx = {}) {
  const { registry, force = false } = ctx
  const templatesDir = ctx.templatesDir ?? TEMPLATES
  if (!registry || !Object.hasOwn(registry.vaults ?? {}, name)) return { ok: false, reason: `no vault named ${name} in the registry` }
  const vaultPath = resolve(expandHome(registry.vaults[name]))
  if (!isDir(vaultPath)) return { ok: false, reason: `vault ${name} does not exist: ${vaultPath}` }

  const sources = {}
  for (const [, source] of INIT_FILES) {
    const text = readText(join(templatesDir, source))
    if (text === null) return { ok: false, reason: `template missing: ${join(templatesDir, source)}` }
    sources[source] = text
  }

  const entries = []
  for (const dir of ['Projects', 'Changes', 'Templates']) {
    const made = !isDir(join(vaultPath, dir))
    if (made) mkdirSync(join(vaultPath, dir), { recursive: true })
    entries.push({ verb: made ? 'created' : 'unchanged', path: `${dir}/` })
  }
  const applied = applyWrites(vaultPath, INIT_FILES.map(([rel, source]) => ({
    path: rel,
    render: existing => (existing === null || force ? sources[source] : existing),
  })), { ...ctx, vault: name })
  if (!applied.ok) return applied
  INIT_FILES.forEach(([rel], i) => {
    const verb = applied.results[i].verb
    entries.push({ verb: verb === 'create' ? 'created' : verb === 'update' ? 'rewritten' : 'unchanged', path: rel })
  })
  const lines = entries.map(e => `${e.verb} ${e.path}`)
  lines.push(`append ${join(templatesDir, 'AGENTS-dial-section.md')} to ${vaultPath}/AGENTS.md by hand`)
  return { ok: true, entries, lines }
}
