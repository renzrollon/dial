// Sentence segmenter and spoken form for dial voice. Pure: no I/O, no timers.

export const MAX_SENTENCE_CHARS = 300

const TERMINATORS = new Set(['.', '?', '!', '…'])
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’'])
const LIST_NUMBER = /^\d+\.$/

function opensParen(text) {
  return text.split('(').length > text.split(')').length
}

/**
 * Find the first sentence in `buf` (which has no leading whitespace). Returns
 * `{ end, next }` — the sentence is buf.slice(0, end), the rest starts at
 * `next` — or null when nothing is complete yet.
 */
function findBoundary(buf) {
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]
    if (ch === '\n') return { end: i, next: i + 1 }
    if (!TERMINATORS.has(ch)) continue
    let j = i
    while (j < buf.length && TERMINATORS.has(buf[j])) j++
    const afterMarks = j
    while (j < buf.length && CLOSERS.has(buf[j])) j++
    // At the end of the buffer the next character decides, so wait for it.
    if (j >= buf.length) return null
    if (!/\s/.test(buf[j])) {
      i = j - 1
      continue
    }
    // A question or exclamation that closes a parenthesis opened in this sentence is an aside, not an end.
    if (buf[afterMarks - 1] !== '.' && buf.slice(afterMarks, j).includes(')') && opensParen(buf.slice(0, i))) {
      i = j - 1
      continue
    }
    const sentence = buf.slice(0, j)
    if (LIST_NUMBER.test(sentence.trim())) {
      i = j - 1
      continue
    }
    return { end: j, next: j }
  }
  return null
}

/** Cut a run that has no boundary: on the last space within the limit, else hard at the limit. */
function cutLong(buf) {
  const space = buf.lastIndexOf(' ', MAX_SENTENCE_CHARS)
  if (space > 0) return { end: space, next: space + 1 }
  // Never cut between the two halves of a surrogate pair.
  const code = buf.charCodeAt(MAX_SENTENCE_CHARS - 1)
  const at = code >= 0xd800 && code <= 0xdbff ? MAX_SENTENCE_CHARS - 1 : MAX_SENTENCE_CHARS
  return { end: at, next: at }
}

export function createSegmenter() {
  let buf = ''

  function drain() {
    const out = []
    for (;;) {
      buf = buf.trimStart()
      if (buf === '') break
      let cut = findBoundary(buf)
      if (cut && buf.slice(0, cut.end).trim().length > MAX_SENTENCE_CHARS) cut = null
      if (!cut && buf.length > MAX_SENTENCE_CHARS) cut = cutLong(buf)
      if (!cut) break
      const sentence = buf.slice(0, cut.end).trim()
      buf = buf.slice(cut.next)
      if (sentence !== '') out.push(sentence)
    }
    return out
  }

  return {
    push(text) {
      buf += String(text ?? '')
      return drain()
    },
    flush() {
      const out = drain()
      const rest = buf.trim()
      buf = ''
      if (rest !== '') out.push(rest)
      return out
    },
    reset() {
      buf = ''
    }
  }
}

/** The plain form of a sentence for `say`; '' when there is nothing to say. */
export function speakable(sentence) {
  let text = String(sentence ?? '')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/https?:\/\/\S+/g, 'link')
  text = text.replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+\.\s+)/, '')
  text = text.replace(/[*`~]/g, '').replace(/_/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return /[\p{L}\p{N}]/u.test(text) ? text : ''
}
