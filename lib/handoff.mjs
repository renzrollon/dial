/**
 * `dial handoff` (design.md §Handoff, narrate, record; specs/handoff-and-narrative):
 * prepend one dated, labelled entry to the `## Narrative` of a change note (or the
 * repo note), append each `--next` as an unticked box to `## Next`, and add the
 * daily handoff line. The frontmatter is never touched; the next `sync` bumps
 * `updated`. A missing note is created from the vault's `Templates/Dial Change.md`,
 * else from the packaged skeleton.
 *
 * Every write goes through `applyWrites` and `appendDaily`, so the one boundary
 * check against the registry holds. Lib functions return data or
 * `{ ok: false, reason }` with a bare reason (the CLI prefixes `dial: `).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noteName } from './facts.mjs'
import { headingName, joinNote, narrativeHeading, splitNote } from './note.mjs'
import { expandHome, resolveRepo } from './registry.mjs'
import { notePath, redact, renderDailyLine } from './render.mjs'
import { appendDaily, applyWrites } from './vault.mjs'

export const DEFAULT_SOURCE = 'dial handoff'

const PACKAGED_TEMPLATE = fileURLToPath(new URL('../templates/Dial Change.md', import.meta.url))

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

/** True when `openspec/changes/<change>/` or an `archive/<YYYY-MM-DD>-<change>/` exists in the repo. */
function changeExists(repoPath, change) {
  const changes = join(repoPath, 'openspec', 'changes')
  if (change !== 'archive' && isDir(join(changes, change))) return true
  let names = []
  try {
    names = readdirSync(join(changes, 'archive'))
  } catch {
    return false
  }
  return names.some(n => n === `${n.slice(0, 10)}-${change}` && /^\d{4}-\d{2}-\d{2}$/.test(n.slice(0, 10)) && isDir(join(changes, 'archive', n)))
}

/**
 * The note a handoff writes to: `{ ok: true, entry, vaultPath, rel, name, wikilink, exists }` or
 * `{ ok: false, reason }` for an unknown repo or a change with neither a note nor a change directory.
 * Reads the disk and writes nothing, so `narrate` can check its target before calling a model.
 * @param {{ registry: object, repo: string, change?: string|null }} opts
 */
export function handoffTarget({ registry, repo, change = null }) {
  const entry = resolveRepo(registry, repo)
  if (!entry) return { ok: false, reason: `no registered repo matches ${repo}` }
  const vaultPath = resolve(expandHome(registry.vaults[entry.vault]))
  const hasChange = change !== null && change !== undefined
  const rel = notePath(entry.name, hasChange ? change : undefined)
  const name = noteName(entry.name, hasChange ? change : undefined)
  const exists = readText(join(vaultPath, rel)) !== null
  if (hasChange && !exists && !changeExists(entry.path, change)) return { ok: false, reason: `${entry.name} has no change ${change}` }
  return { ok: true, entry, vaultPath, rel, name, wikilink: `[[${name}]]`, change: hasChange ? change : null, exists }
}

/** One narrative entry: its heading, the body with trailing whitespace trimmed, then one empty line. */
export function formatEntry(heading, body) {
  return `${heading}\n${entryBody(String(body).trimEnd())}\n\n`
}

const SECTION_LINE = /^## /
const ENTRY_LINE = /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} · /
const FENCE_LINE = /^\s*(```|~~~)/

/**
 * An entry body that cannot change the note's structure: outside a fenced block, a `## ` line (which `splitNote`
 * would take as a new section, so the next sync would drop or move the rest of the entry) and a dated `### ` line
 * (which would start a new entry) are demoted one level; an unclosed fence is closed, so the note's own headings
 * after the entry are still seen.
 */
export function entryBody(body) {
  let inFence = false
  const lines = String(body).split('\n').map(line => {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      return line
    }
    if (!inFence && (SECTION_LINE.test(line) || ENTRY_LINE.test(line))) return `#${line}`
    return line
  })
  if (inFence) lines.push('```')
  return lines.join('\n')
}

/** Make sure the previous text ends with a newline before a section is inserted after it. */
function endLine(text) {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/** The index of the first `## <name>` section, or -1. */
const sectionAt = (parts, name) => parts.sections.findIndex(s => headingName(s.heading) === name)

/**
 * Give `parts` a `## Next` and a `## Narrative` section when either is missing: `Next` goes before
 * `Narrative` (or first), `Narrative` right after `Next`. Existing bytes are kept.
 */
function ensureSections(parts) {
  if (sectionAt(parts, 'Next') === -1) {
    const at = Math.max(0, sectionAt(parts, 'Narrative'))
    if (at === 0) parts.preamble = endLine(parts.preamble)
    else parts.sections[at - 1].body = endLine(parts.sections[at - 1].body)
    if (at === 0 && parts.sections.length === 0 && parts.preamble === '' && !parts.frontmatter.endsWith('\n') && parts.frontmatter) {
      parts.frontmatter += '\n'
    }
    parts.sections.splice(at, 0, { heading: 'Next', body: '\n' })
  }
  if (sectionAt(parts, 'Narrative') === -1) {
    const next = sectionAt(parts, 'Next')
    const s = parts.sections[next]
    if (s.eol === '') s.eol = '\n'
    s.body = endLine(s.body)
    parts.sections.splice(next + 1, 0, { heading: 'Narrative', body: '\n' })
  }
  for (const s of parts.sections) if (s.eol === '' && s !== parts.sections.at(-1)) s.eol = '\n'
  return parts
}

/**
 * `text` with `entry` (from `formatEntry`) inserted at the top of `## Narrative`, after the blank line
 * that follows the heading; every older entry's bytes stay below it.
 */
export function appendEntry(text, entry) {
  const parts = ensureSections(splitNote(text))
  const s = parts.sections[sectionAt(parts, 'Narrative')]
  if (s.eol === '') s.eol = '\n'
  const lead = /^\n*/.exec(s.body)[0].length
  s.body = `\n${entry}${s.body.slice(lead)}`
  return joinNote(parts)
}

/**
 * `text` with `- [ ] <item>` appended for each item, in order, after the last non-blank line of
 * `## Next`; every existing line stays byte for byte. No items returns `text` unchanged.
 */
export function appendNext(text, items = []) {
  const list = items.filter(i => typeof i === 'string' && i.trim() !== '')
  if (!list.length) return text
  const parts = ensureSections(splitNote(text))
  const s = parts.sections[sectionAt(parts, 'Next')]
  if (s.eol === '') s.eol = '\n'
  const block = list.map(i => `- [ ] ${i.replace(/\r?\n/g, ' ').trim()}`).join('\n')
  const tailAt = /(?:\n[ \t]*)*$/.exec(s.body).index
  const core = s.body.slice(0, tailAt)
  const tail = s.body.slice(tailAt)
  if (core === '') s.body = `\n${block}\n${tail.length > 1 ? tail.slice(1) : '\n'}`
  else s.body = `${core}\n${block}${tail === '' ? '\n' : tail}`
  return joinNote(parts)
}

/**
 * Record one handoff.
 * @param {{ registry: object, repo: string, change?: string|null, text: string, source?: string,
 *   next?: string[], now?: Date, warn?: Function, templateText?: string }} opts
 * @returns {{ ok: true, note: string, wikilink: string, heading: string, nextAdded: number, path: string, results: object[] }
 *   | { ok: false, reason: string }}
 */
export function handoff(opts) {
  const { registry, change = null, source = DEFAULT_SOURCE, next = [] } = opts
  const body = String(opts.text ?? '').trimEnd()
  if (body.trim() === '') return { ok: false, reason: 'handoff text is empty' }
  const target = handoffTarget({ registry, repo: opts.repo, change })
  if (!target.ok) return target
  const { entry, vaultPath, rel, wikilink } = target
  const now = asDate(opts.now)
  const keep = [entry.name, target.change]
  const label = redact(String(source).replace(/\r?\n/g, ' ').trim() || DEFAULT_SOURCE, keep)
  const heading = narrativeHeading(now, label)
  const text = formatEntry(heading, redact(body, keep))
  const items = next.map(n => redact(n, keep))
  const template = () => opts.templateText ?? readText(join(vaultPath, 'Templates', 'Dial Change.md')) ?? readText(PACKAGED_TEMPLATE)

  const warnings = []
  const ctx = { registry, repo: entry.name, now, warn: line => warnings.push(line) }
  const written = applyWrites(vaultPath, [{
    path: rel,
    render: existing => appendNext(appendEntry(existing ?? template(), text), items),
  }], ctx)
  if (!written.ok) return written
  const [result] = written.results
  if (result.verb === 'skipped') return { ok: false, reason: `${result.path} changed during the write; skipped` }

  const line = renderDailyLine({ kind: 'handoff', repo: entry.name, change: target.change, source: label, at: now })
  const daily = appendDaily(vaultPath, [line], ctx)
  if (!daily.ok) return daily
  for (const w of warnings) opts.warn?.(w)
  return { ok: true, note: rel, wikilink, heading, nextAdded: items.length, path: result.path, results: [...written.results, ...daily.results] }
}
