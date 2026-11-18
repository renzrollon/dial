/**
 * `dial capture` (specs/capture, add-voice-stage-and-capture): one piece of text becomes one new note under
 * `Inbox/` of a registered vault. The functions up to `renderCapture` are pure; `capture` reads the registry,
 * checks in the order of the spec and writes through `planWrites` and `applyWrites`, so the vault boundary,
 * the hidden temporary file and the re-read before the rename all hold. It never overwrites, appends or deletes.
 *
 * Returns data or `{ ok: false, reason }` with a bare reason (the CLI prefixes `dial: `).
 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { localDate, writeFrontmatter } from './note.mjs'
import { expandHome } from './registry.mjs'
import { redact } from './render.mjs'
import { applyWrites, planWrites } from './vault.mjs'

export const TITLE_CHARS = 60

const FORBIDDEN = /[:/\\?*"<>|#^[\]]/g
const pad = n => String(n).padStart(2, '0')

/** Line endings as `\n`, control characters other than `\n` and `\t` dropped, the ends trimmed. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim()
}

const isHigh = unit => unit >= 0xd800 && unit <= 0xdbff

/** The title of a cleaned, redacted text: its first non-blank line, made safe for a file name. */
export function noteTitle(text) {
  const line = String(text ?? '').split('\n').find(l => l.trim() !== '') ?? ''
  const tidy = s => s.replace(/^\.+/, '').replace(/[. ]+$/, '').trim()
  let title = tidy(line.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim())
  if (title.length > TITLE_CHARS) {
    const space = title.slice(0, TITLE_CHARS + 1).lastIndexOf(' ')
    let end = space > 0 ? space : TITLE_CHARS
    if (space <= 0 && isHigh(title.charCodeAt(end - 1))) end -= 1
    title = tidy(title.slice(0, end))
  }
  return title === '' ? 'Note' : title
}

/** `Inbox/<title> <YYYY-MM-DD HHmm>.md` in local time. */
export function noteFile(title, at) {
  const d = at instanceof Date ? at : new Date(at)
  return `Inbox/${title} ${localDate(d)} ${pad(d.getHours())}${pad(d.getMinutes())}.md`
}

/** The note's bytes: frontmatter, a blank line, the text and one line feed. */
export function renderCapture({ title, text, created }) {
  const frontmatter = writeFrontmatter({
    title,
    created,
    type: 'note',
    status: 'inbox',
    tags: ['capture'],
    dial_schema: 'dial.capture/1'
  })
  return `${frontmatter}\n${text}\n`
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Write one note. Checks, in order: empty text, length, the vault's name, the vault's directory, the note's name.
 * `{ ok: true, vault, path, note, wikilink, title, text, written }` or `{ ok: false, reason }`.
 */
export function capture({ registry, vault, text, now, maxChars, dryRun = false, warn, beforeRename }) {
  const cleaned = cleanText(text)
  if (cleaned === '') return { ok: false, reason: 'capture text is empty' }
  if (cleaned.length > maxChars) return { ok: false, reason: `note longer than ${maxChars} characters` }
  const vaults = registry?.vaults ?? {}
  if (!Object.hasOwn(vaults, vault)) {
    const names = Object.keys(vaults)
    return { ok: false, reason: `no vault named ${vault} in the registry${names.length ? `; vaults: ${names.join(', ')}` : ''}` }
  }
  const vaultPath = resolve(expandHome(vaults[vault]))
  if (!isDir(vaultPath)) return { ok: false, reason: `vault ${vault} does not exist: ${vaultPath}` }

  const body = redact(cleaned)
  const title = noteTitle(body)
  const at = now instanceof Date ? now : now ? new Date(now) : new Date()
  const note = noteFile(title, at)
  const bytes = renderCapture({ title, text: body, created: localDate(at) })
  const writes = [{ path: note, render: existing => existing ?? bytes }]
  const ctx = { registry, vault, warn, beforeRename }
  const exists = { ok: false, reason: `${note} already exists in vault ${vault}` }

  const planned = planWrites(vaultPath, writes, ctx)
  if (!planned.ok) return planned
  if (planned.plan[0].verb === 'unchanged') return exists
  if (!dryRun) {
    const applied = applyWrites(vaultPath, writes, ctx)
    if (!applied.ok) return applied
    if (applied.results[0].verb !== 'create') return exists
  }
  const file = note.slice('Inbox/'.length, -'.md'.length)
  return {
    ok: true,
    vault,
    path: resolve(vaultPath, note),
    note,
    wikilink: `[[${file}]]`,
    title,
    text: body,
    written: !dryRun
  }
}
