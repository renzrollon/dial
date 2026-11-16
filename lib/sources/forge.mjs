/**
 * What the two forge sources share (specs/remote-sources, add-dial-ask delta): the cuts that turn forge text into
 * data, the check roll-up, and `cutPullRequest`, which applies the cuts to one normalised list item. Forge text is
 * chosen by whoever can open a pull request, so it is cut when a list is cached and again when it is read. Every cut
 * is idempotent and none throws on any input. The lengths bound a string's shape; they are not published caps.
 */

const NAMES_LISTED = 3

/**
 * Text as data: only `[A-Za-z0-9 ._:/()-]` kept, each run of others one space, capped at `max` characters with the
 * last three `...` when cut. An empty result reads `empty`.
 */
export function cutText(value, max, empty) {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9 ._:/()-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length > max) return `${clean.slice(0, max - 3).trimEnd()}...`
  return clean || empty
}

/** A branch name: each character outside `[A-Za-z0-9_./-]` becomes `-`, first 100 kept. */
export function cutRef(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_./-]/g, '-').slice(0, 100)
}

/** A url kept only when it starts with `https://`, holds no whitespace and is at most 200 characters, else `''`. */
export function cutUrl(value) {
  const s = typeof value === 'string' ? value : ''
  return s.startsWith('https://') && !/\s/.test(s) && s.length <= 200 ? s : ''
}

/** A forge word: lowercased, null unless it matches `^[a-z_]+$`. */
export function cutWord(value) {
  if (typeof value !== 'string') return null
  const w = value.toLowerCase()
  return /^[a-z_]+$/.test(w) ? w : null
}

/**
 * The check roll-up: `fail` if any bucket is `fail`, else `pending`, else `cancel`, else `pass`; no checks is `none`.
 * `names` holds the cut names of the winning bucket, and is `[]` for `pass` and `none`.
 */
export function rollup(checks) {
  const list = Array.isArray(checks) ? checks.filter(c => c !== null && typeof c === 'object') : []
  if (list.length === 0) return { value: 'none', names: [] }
  const named = bucket => list.filter(c => c.bucket === bucket).map(c => cutText(c.name, 40, 'unnamed'))
  const winner = ['fail', 'pending', 'cancel'].find(b => named(b).length > 0)
  return winner ? { value: winner, names: named(winner) } : { value: 'pass', names: [] }
}

/** The names in the evidence: up to three, else a count. */
export function listed(names) {
  return names.length > NAMES_LISTED ? `${names.length} checks` : names.join(', ')
}

/** One normalised item with every string cut, or null without an integer `number`. */
export function cutPullRequest(item) {
  if (item === null || typeof item !== 'object' || !Number.isInteger(item.number)) return null
  const updated = typeof item.updatedAt === 'string' && item.updatedAt && !Number.isNaN(Date.parse(item.updatedAt)) ? item.updatedAt : null
  return {
    number: item.number,
    title: cutText(item.title, 80, 'untitled'),
    branch: cutRef(item.branch),
    base: cutRef(item.base),
    url: cutUrl(item.url),
    author: cutText(item.author, 40, 'unknown'),
    draft: item.draft === true,
    review: cutWord(item.review),
    mergeState: cutWord(item.mergeState),
    conflicting: item.conflicting === true,
    checks: Array.isArray(item.checks)
      ? item.checks.filter(c => c !== null && typeof c === 'object').map(c => ({ name: cutText(c.name, 40, 'unnamed'), bucket: cutWord(c.bucket) ?? 'pending' }))
      : null,
    updatedAt: updated,
  }
}
