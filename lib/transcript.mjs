/**
 * The text turns of a Claude Code transcript (a `.jsonl`, one event per line).
 * Only what a person said and what the assistant wrote: no `tool_result`,
 * `tool_use` or `thinking` content, no `isMeta` or `isSidechain` lines.
 */
import { readFileSync } from 'node:fs'

/**
 * The last `n` text turns of the transcript at `path`.
 * Returns `{ ok: true, turns: [{ role, text }], firstTimestamp }` (`turns` may be
 * empty), or `{ ok: false, reason: 'no transcript at <path>' }` when unreadable.
 * Assistant text blocks that share a `message.id` are one turn. Malformed lines
 * are skipped.
 * @param {string} path
 * @param {number} [n] omit for every turn
 */
export function tailTurns(path, n = Infinity) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: `no transcript at ${path}` }
  }
  const turns = []
  const byMessage = new Map()
  let firstTimestamp = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec === null || typeof rec !== 'object') continue
    if (firstTimestamp === null && typeof rec.timestamp === 'string') firstTimestamp = rec.timestamp
    if ((rec.type !== 'user' && rec.type !== 'assistant') || rec.isMeta === true || rec.isSidechain === true) continue
    const text = textOf(rec.message?.content)
    if (!text) continue
    if (rec.type === 'user') {
      turns.push({ role: 'user', text })
      continue
    }
    const id = rec.message?.id
    const prior = typeof id === 'string' ? byMessage.get(id) : undefined
    if (prior) prior.text += `\n\n${text}`
    else {
      const turn = { role: 'assistant', text }
      turns.push(turn)
      if (typeof id === 'string') byMessage.set(id, turn)
    }
  }
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : turns.length
  return { ok: true, turns: count === 0 ? [] : turns.slice(-count), firstTimestamp }
}

/** Text from string content or `text` blocks; every other block type contributes nothing. */
function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text.trim())
    .filter(Boolean)
    .join('\n\n')
}
