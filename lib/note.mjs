/**
 * Note parsing and the frontmatter writer (design.md §Notes, specs/note-rendering).
 * Pure. `splitNote` and `joinNote` are lossless: joinNote(splitNote(t)) === t.
 */

const HEADING = /^## (.*)$/
const FENCE = /^\s*(```|~~~)/

/**
 * Cut a note at its `##` headings (outside fenced code).
 * @returns {{ frontmatter: string, preamble: string, sections: { heading: string, body: string, eol?: string }[] }}
 *   `frontmatter` is the raw fenced block including its closing line ('' when absent); `preamble` the text
 *   between it and the first heading; each `body` the exact text after its heading line up to the next one.
 */
export function splitNote(text) {
  const src = String(text ?? '')
  let frontmatter = ''
  let rest = src
  if (src.startsWith('---\n') || src === '---') {
    const lines = src.split('\n')
    let offset = lines[0].length + 1
    for (let i = 1; i < lines.length; i++) {
      const end = offset + lines[i].length
      if (lines[i].trimEnd() === '---') {
        const cut = end < src.length ? end + 1 : end
        frontmatter = src.slice(0, cut)
        rest = src.slice(cut)
        break
      }
      offset = end + 1
    }
  }

  const sections = []
  let preamble = null
  let cursor = 0
  let current = null
  let inFence = false
  let pos = 0
  while (pos <= rest.length) {
    const nl = rest.indexOf('\n', pos)
    const lineEnd = nl === -1 ? rest.length : nl
    const line = rest.slice(pos, lineEnd)
    if (FENCE.test(line)) inFence = !inFence
    const m = inFence ? null : HEADING.exec(line)
    if (m) {
      const before = rest.slice(cursor, pos)
      if (current) current.body = before
      else preamble = before
      current = { heading: m[1], body: '' }
      if (nl === -1) current.eol = ''
      sections.push(current)
      cursor = nl === -1 ? rest.length : nl + 1
    }
    if (nl === -1) break
    pos = nl + 1
  }
  if (current) current.body = rest.slice(cursor)
  else preamble = rest
  return { frontmatter, preamble: preamble ?? '', sections }
}

/** The inverse of splitNote. */
export function joinNote(parts) {
  let out = (parts.frontmatter ?? '') + (parts.preamble ?? '')
  for (const s of parts.sections ?? []) out += `## ${s.heading}${s.eol ?? '\n'}${s.body ?? ''}`
  return out
}

/** A section heading without any trailing HTML comment, e.g. `State`. */
export function headingName(heading) {
  return String(heading).replace(/<!--[\s\S]*?-->/g, '').trim()
}

/**
 * The key groups of a raw frontmatter block, in order: `{ key, lines }`, where `lines` are the key's
 * line and any continuation lines (an indented or `- ` list under it), exactly as written.
 */
export function frontmatterEntries(raw) {
  const lines = String(raw ?? '').split('\n')
  if (lines[0] !== '---') return []
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimEnd() === '---') break
    const m = /^([A-Za-z_][\w.-]*):(?:\s|$)/.exec(line)
    if (m) out.push({ key: m[1], lines: [line] })
    else if (out.length) out[out.length - 1].lines.push(line)
    else out.push({ key: null, lines: [line] })
  }
  return out
}

const INDICATOR = /^[-?[\]{},&*!|>'"%@`]/
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i
const NUMBERISH = /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^0[xob][0-9a-fA-F]+$/

/** One frontmatter value on one line under the quoting rule of specs/note-rendering. */
export function formatValue(value) {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(formatListItem).join(', ')}]`
  const s = String(value ?? '').replace(/\r?\n/g, ' ')
  const quote = s === ''
    || s.includes(': ') || s.includes('#') || s.endsWith(':')
    || INDICATOR.test(s) || RESERVED.test(s) || NUMBERISH.test(s)
    || s !== s.trim()
  return quote ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}

function formatListItem(item) {
  const s = formatValue(item)
  return /[,\]]/.test(s) && !s.startsWith('"') ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}

/** `---\nkey: value\n…---\n` in insertion order; undefined and null values are left out. */
export function writeFrontmatter(obj) {
  const lines = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${formatValue(value)}`)
  }
  return `---\n${lines.join('\n')}${lines.length ? '\n' : ''}---\n`
}

const CHECKBOX = /^\s*[-*+] \[(.)\] (.*)$/

/** The checkboxes of a `## Next` section: `[{ checked, text }]`, checked only on `x`/`X`. */
export function nextItems(section) {
  const out = []
  for (const line of String(section?.body ?? '').split('\n')) {
    const m = CHECKBOX.exec(line)
    if (m) out.push({ checked: m[1] === 'x' || m[1] === 'X', text: m[2].trimEnd() })
  }
  return out
}

const ENTRY = /^### (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) · (.+)$/

/**
 * The entries of a `## Narrative` section in the order written (newest first by convention):
 * `[{ heading, at (ISO, the heading read as local time), source, body }]`.
 */
export function narrativeEntries(section) {
  const out = []
  let current = null
  for (const line of String(section?.body ?? '').split('\n')) {
    const m = ENTRY.exec(line)
    if (m) {
      const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
      current = { heading: line, at: at.toISOString(), source: m[6].trim(), body: '' }
      out.push(current)
    } else if (current) {
      current.body += `${line}\n`
    }
  }
  return out
}

const pad = n => String(n).padStart(2, '0')

/** The local date of `at` as `YYYY-MM-DD`. */
export function localDate(at) {
  const d = at instanceof Date ? at : new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local time of `at` as `HH:mm`. */
export function localTime(at) {
  const d = at instanceof Date ? at : new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `### YYYY-MM-DD HH:mm · <source>` in local time (D23). */
export function narrativeHeading(at, source) {
  return `### ${localDate(at)} ${localTime(at)} · ${source}`
}
