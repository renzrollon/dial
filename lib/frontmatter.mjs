/**
 * Flat frontmatter reader. Only `key: value` scalars; nested YAML, lists and
 * multi-line values are not understood and their lines are ignored.
 */

const KEY_LINE = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    if ((first === '"' || first === "'") && value[value.length - 1] === first) return value.slice(1, -1)
  }
  return value
}

/**
 * Returns `{ [key]: string }` for the block between the opening `---` and the
 * next `---` line, `{}` for an empty block, and `null` when the text has no
 * (terminated) frontmatter.
 */
export function readFrontmatter(text) {
  if (typeof text !== 'string') return null
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return null
  const out = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimEnd() === '---') return out
    const m = KEY_LINE.exec(line.trimEnd())
    if (m) out[m[1]] = unquote((m[2] ?? '').trim())
  }
  return null
}
