/**
 * The caps Dial publishes. Defaults live here; the registry's `limits` block
 * may override a cap by name with a positive integer.
 */

export const LIMITS = Object.freeze({
  staleDays: 14,
  archivedKeepDays: 30,
  briefLines: 40
})

export const DESCRIPTIONS = Object.freeze({
  staleDays: 'days without activity before a change is stale',
  archivedKeepDays: 'days an archived change stays on the board',
  briefLines: 'maximum lines in a brief'
})

/**
 * Merge registry overrides over the defaults. Returns `{ ok: true, limits }` or
 * `{ ok: false, reason }` naming the offending key and `path`.
 */
export function effectiveLimits(overrides, path) {
  if (overrides === undefined || overrides === null) return { ok: true, limits: LIMITS }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, reason: `registry limits: must be an object in ${path}` }
  }
  const limits = { ...LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(LIMITS, key)) return { ok: false, reason: `registry limits: unknown cap ${key} in ${path}` }
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, reason: `registry limits: ${key} must be a positive integer in ${path}` }
    }
    limits[key] = value
  }
  return { ok: true, limits: Object.freeze(limits) }
}

/** One aligned line per cap, with a trailing newline. */
export function formatLimits(limits) {
  const names = Object.keys(limits)
  const width = Math.max(0, ...names.map(n => n.length))
  return names.map(name => `${name.padEnd(width)} = ${String(limits[name]).padStart(9)}  ${DESCRIPTIONS[name] ?? ''}`).join('\n') + '\n'
}
