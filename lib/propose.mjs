/**
 * The pure core of `dial propose` and of a started session's name: the prompt
 * check, the proposal check, the session name and the text form.
 */
import { resolve } from 'node:path'
import { expandHome, resolveRepo } from './registry.mjs'

/** What every session Dial starts is named with, so the list can tell them apart. */
export const SESSION_PREFIX = 'dial: '
/** How many characters of the prompt the session name keeps. */
export const SESSION_NAME_CHARS = 60

const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/u

/**
 * Whether `text` can become a session prompt: the trimmed prompt, or a reason.
 * @param {unknown} text
 * @param {{ maxChars: number }} caps
 * @returns {{ ok: true, prompt: string } | { ok: false, reason: string }}
 */
export function checkPrompt(text, { maxChars }) {
  const prompt = String(text ?? '').trim()
  if (prompt === '') return { ok: false, reason: 'prompt is empty' }
  if (prompt.length > maxChars) return { ok: false, reason: `prompt longer than ${maxChars} characters` }
  if (prompt.startsWith('-')) return { ok: false, reason: 'prompt cannot start with -' }
  // Line feed and tab are allowed; every other control character (C0, DEL and C1) is not.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(prompt)) return { ok: false, reason: 'prompt holds a control character' }
  // Nor is a character the card and the spoken reading would not show: format characters (zero-width,
  // bidi controls, the tag block), the line and paragraph separators, and the whole tag block U+E0000-E007F.
  if (INVISIBLE.test(prompt)) return { ok: false, reason: 'prompt holds an invisible or format character' }
  return { ok: true, prompt }
}

/**
 * Check a repo and a prompt against the registry.
 * @param {object} registry
 * @param {{ repo: string, prompt: string, cwd?: string }} input
 * @param {{ maxChars: number }} caps
 * @returns {{ ok: true, proposal: { repo: string, prompt: string }, path: string } | { ok: false, reason: string }}
 */
export function checkProposal(registry, { repo, prompt, cwd }, { maxChars }) {
  const arg = typeof repo === 'string' ? repo : ''
  // A registered name first, as `dial context` resolves it; then, only when a cwd is given, a path
  // (relative to the cwd, equal to or inside a repo).
  let found = resolveRepo(registry, arg)
  if (found && found.name !== arg) found = null
  if (!found && cwd && arg) found = resolveRepo(registry, resolve(cwd, expandHome(arg)))
  if (!found) return { ok: false, reason: `${arg} is not a registered repo` }
  const checked = checkPrompt(prompt, { maxChars })
  if (!checked.ok) return checked
  return { ok: true, proposal: { repo: found.name, prompt: checked.prompt }, path: found.path }
}

/** The session name for a prompt: the prefix and the prompt on one line, cut without splitting a character. */
export function sessionName(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  return SESSION_PREFIX + Array.from(flat).slice(0, SESSION_NAME_CHARS).join('')
}

/** The two text lines `dial propose` prints, with a trailing newline. */
export function formatProposal({ repo, prompt }) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  return `proposal for ${repo}: ${flat}\nnothing is started until it is confirmed in the dial voice window\n`
}
