/**
 * `dial narrate` (design.md §Handoff, narrate, record; specs/handoff-and-narrative):
 * ask a local model for the five narrative lines from the text turns of a
 * transcript tail, and record a usable reply as a handoff entry with the source
 * `local model (<model id>)`.
 *
 * One call to the primary endpoint and at most one to the fallback, each bounded;
 * an endpoint whose host is not loopback is never called (no cloud model, D25,
 * D67). A failure writes nothing and is reported as `unobserved: <reason>`.
 * The API key is sent only as the primary request's `Authorization` header: it
 * never appears in a returned value, a reason, a vault file or a file Dial writes.
 *
 * `fetch`, the timer and the clock are injected; nothing here touches the process.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handoff, handoffTarget } from './handoff.mjs'
import { LIMITS } from './limits.mjs'
import { redact } from './render.mjs'
import { homeOf } from './sources/paths.mjs'
import { tailTurns } from './transcript.mjs'

export const DEFAULT_PROVIDER = 'mtplx'
export const DEFAULT_FALLBACK_URL = 'http://127.0.0.1:11434/v1'
export const DEFAULT_FALLBACK_MODEL = 'qwen3.6'
export const LABELS = Object.freeze(['Done:', 'Decided:', 'Next:', 'Blocked:', 'Open:'])
export const NO_TIME = 'no time left before the hook deadline'

/** The fixed instruction sent with every call. */
export const PROMPT = [
  'You write the handoff note for one software change from the tail of a coding session.',
  'Reply with exactly five lines and nothing else, each starting with its label:',
  'Done: what this session finished',
  'Decided: what was decided, and why, in one line',
  'Next: the single next concrete step',
  'Blocked: what blocks progress, or none',
  'Open: the open questions, or none',
  'Use only what the conversation says. Do not invent files, commands or results; write none when something is unknown.',
].join('\n')

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** True when `url` parses and its host is loopback. */
export function isLocalEndpoint(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const str = v => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** The first model id of a pi provider: `models: [{ id }]` or `models: ['<id>']`. */
function firstModel(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : []
  for (const m of models) {
    const id = typeof m === 'string' ? m : m?.id
    if (str(id)) return id
  }
  return null
}

/**
 * The endpoints narrate may call. The primary comes from pi's `~/.pi/agent/models.json` (the provider named by
 * the registry's `narrate.provider`, default `mtplx`: `baseUrl`, `apiKey`, the first model id), each value
 * overridden by the registry's `narrate.url`, `narrate.model` and `narrate.apiKeyEnv` (the name of an environment
 * variable holding the key); it is null unless both a URL and a model resolve. The fallback is
 * `narrate.fallbackUrl` / `narrate.fallbackModel` (defaults `http://127.0.0.1:11434/v1`, `qwen3.6`) with no key.
 * Returns `{ primary: { url, model, key, from } | null, fallback: { url, model, key: null, from } }`; `key` is
 * for the request only, never print it (use `describeEndpoints`).
 * @param {{ registry?: object, env?: NodeJS.ProcessEnv }} opts `env.HOME` locates pi's file.
 */
export function resolveEndpoint({ registry, env = process.env } = {}) {
  const cfg = registry?.narrate ?? {}
  const piFile = join(homeOf(env), '.pi', 'agent', 'models.json')
  const data = readJson(piFile)
  const providers = data && typeof data === 'object' ? (data.providers && typeof data.providers === 'object' ? data.providers : data) : {}
  const name = str(cfg.provider) ?? DEFAULT_PROVIDER
  const provider = providers && typeof providers[name] === 'object' ? providers[name] : null

  const url = str(cfg.url) ?? str(provider?.baseUrl)
  const model = str(cfg.model) ?? firstModel(provider)
  const key = cfg.apiKeyEnv !== undefined ? str(env[cfg.apiKeyEnv]) : str(provider?.apiKey)
  const from = [str(cfg.url) || str(cfg.model) ? 'registry narrate' : null, provider ? `pi provider ${name}` : null].filter(Boolean).join(', ')
  const primary = url && model ? { url, model, key, from } : null
  const fallback = {
    url: str(cfg.fallbackUrl) ?? DEFAULT_FALLBACK_URL,
    model: str(cfg.fallbackModel) ?? DEFAULT_FALLBACK_MODEL,
    key: null,
    from: str(cfg.fallbackUrl) || str(cfg.fallbackModel) ? 'registry narrate' : 'built-in fallback',
  }
  return { primary, fallback }
}

/** The endpoints as printable rows `{ role, url, model }`, never a key. */
export function describeEndpoints(endpoints) {
  const out = []
  if (endpoints.primary) out.push({ role: 'primary', url: endpoints.primary.url, model: endpoints.primary.model })
  out.push({ role: 'fallback', url: endpoints.fallback.url, model: endpoints.fallback.model })
  return out
}

const THINK = /<think>[\s\S]*?<\/think>/gi
const LABELLED = /^\s*(?:[-*]\s+)?(?:\*\*)?(Done|Decided|Next|Blocked|Open):(?:\*\*)?\s*(.*)$/

/**
 * The five labelled lines of a reply, `<think>` blocks removed: `{ ok: true, lines }` in label order
 * (`Done: …` first), or `{ ok: false, missing: '<Label:>' }` naming the first absent label.
 */
export function parseFiveLines(content) {
  const found = new Map()
  for (const line of String(content ?? '').replace(THINK, '').split('\n')) {
    const m = LABELLED.exec(line)
    if (m && !found.has(`${m[1]}:`)) found.set(`${m[1]}:`, `${m[1]}: ${m[2].trim()}`.trimEnd())
  }
  for (const label of LABELS) if (!found.has(label)) return { ok: false, missing: label }
  return { ok: true, lines: LABELS.map(l => found.get(l)) }
}

/** The turns as the one user message: `user: …` and `assistant: …` blocks. */
export function turnsText(turns) {
  return turns.map(t => `${t.role}: ${t.text}`).join('\n\n')
}

/**
 * One call. Returns `{ ok: true, lines, model, url }` or `{ ok: false, reason }`, the reason one of
 * `<url> is not a local endpoint`, `<url> unreachable`, `<url> timed out after <n>s`, `<url> HTTP <status>`,
 * `<url> reply is not JSON`, `<url> reply has no content`, `<url> reply missing <label>`.
 */
async function callOnce({ endpoint, turns, fetch, timeoutMs, setTimer, clearTimer }) {
  const { url, model, key } = endpoint
  const fail = reason => ({ ok: false, reason: `${url} ${reason}` })
  if (!isLocalEndpoint(url)) return fail('is not a local endpoint')
  const controller = new AbortController()
  const timer = setTimer(() => controller.abort(), timeoutMs)
  const headers = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  const body = JSON.stringify({
    model,
    stream: false,
    temperature: 0.2,
    messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: turnsText(turns) }],
  })
  let text
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers, body, signal: controller.signal })
    if (!res.ok) return fail(`HTTP ${res.status}`)
    text = await res.text()
  } catch {
    return controller.signal.aborted ? fail(`timed out after ${Math.round(timeoutMs / 1000)}s`) : fail('unreachable')
  } finally {
    clearTimer(timer)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return fail('reply is not JSON')
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') return fail('reply has no content')
  const parsed = parseFiveLines(content)
  if (!parsed.ok) return fail(`reply missing ${parsed.missing}`)
  return { ok: true, lines: parsed.lines, model, url }
}

/**
 * The primary once, then the fallback at most once. `timeoutFor()` is each call's bound in milliseconds, or
 * null when no call may be made (record's deadline), which counts as a failed attempt with `NO_TIME`.
 * Returns `{ ok: true, lines, model, url, attempts }` or `{ ok: false, reason (the last attempt's), attempts }`.
 */
export async function askModel({ endpoints, turns, fetch, timeoutFor, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const order = [endpoints.primary, { ...endpoints.fallback, key: null }].filter(Boolean)
  let reason = null
  let attempts = 0
  for (const endpoint of order) {
    const timeoutMs = timeoutFor()
    if (timeoutMs === null || timeoutMs === undefined) {
      reason = NO_TIME
      continue
    }
    attempts++
    const r = await callOnce({ endpoint, turns, fetch, timeoutMs, setTimer, clearTimer })
    if (r.ok) return { ...r, attempts }
    reason = r.reason
  }
  return { ok: false, reason, attempts }
}

const fixedTimeout = limits => {
  const seconds = Number.isInteger(limits?.narrateTimeoutSeconds) ? limits.narrateTimeoutSeconds : LIMITS.narrateTimeoutSeconds
  return () => seconds * 1000
}

const turnCap = (limits, turns) => (Number.isInteger(turns) && turns > 0 ? turns : limits?.narrateTurns ?? LIMITS.narrateTurns)

/**
 * Narrate one note from a transcript.
 * @param {{ registry: object, repo: string, change?: string|null, transcript: string, turns?: number, limits?: object,
 *   env?: object, fetch: Function, now?: Date, dryRun?: boolean, timeoutFor?: () => number|null,
 *   setTimer?: Function, clearTimer?: Function, warn?: Function }} opts
 * @returns {Promise<object>} `{ ok: false, reason }` for an unknown repo or change or a failed write (the CLI
 *   exits 1); otherwise `{ ok: true, written: true, note, wikilink, heading, model }`,
 *   `{ ok: true, written: false, unobserved }`, or under `dryRun` `{ ok: true, dryRun: true, prompt, endpoints, turns }`.
 */
export async function narrate(opts) {
  const { registry, change = null, limits, env = process.env } = opts
  const target = handoffTarget({ registry, repo: opts.repo, change })
  if (!target.ok) return target
  const tail = tailTurns(opts.transcript, turnCap(limits, opts.turns))
  const endpoints = resolveEndpoint({ registry, env })
  if (opts.dryRun) {
    return { ok: true, dryRun: true, prompt: PROMPT, endpoints: describeEndpoints(endpoints), turns: tail.ok ? tail.turns : [], unobserved: tail.ok ? undefined : tail.reason }
  }
  if (!tail.ok) return { ok: true, written: false, unobserved: tail.reason }
  if (!tail.turns.length) return { ok: true, written: false, unobserved: 'transcript has no text turns' }

  const asked = await askModel({
    endpoints, turns: tail.turns, fetch: opts.fetch, timeoutFor: opts.timeoutFor ?? fixedTimeout(limits),
    setTimer: opts.setTimer, clearTimer: opts.clearTimer,
  })
  if (!asked.ok) return { ok: true, written: false, unobserved: asked.reason }
  const written = handoff({
    registry, repo: target.entry.name, change: target.change, text: asked.lines.join('\n'),
    source: `local model (${asked.model})`, now: opts.now, warn: opts.warn,
  })
  if (!written.ok) return written
  return { ok: true, written: true, note: written.note, wikilink: written.wikilink, heading: written.heading, model: asked.model }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The labels file as the last row per id: `[{ id, nextCorrect, nothingInvented }]`, or null when absent. */
function readLabels(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const byId = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row)
    } catch {
      // a malformed line is not a label
    }
  }
  return [...byId.values()]
}

/**
 * `dial narrate --eval <dir>`: narrate each `<dir>/items/<id>.jsonl`, write the five lines or the
 * `unobserved: <reason>` line to `<dir>/outputs/<id>.md`, write no vault file, and score `<dir>/labels.jsonl`.
 * Returns `{ ok: true, items: [{ id, written, unobserved? }], score: { nextCorrect: { k, n }, nothingInvented: { k, n } }
 * | null, lines }` or `{ ok: false, reason: '<dir>/items is not a directory' }`.
 */
export async function evalSet(opts) {
  const { registry, limits, env = process.env } = opts
  const dir = String(opts.dir).replace(/\/+$/, '') || '/'
  const items = `${dir}/items`
  if (!isDir(items)) return { ok: false, reason: `${items} is not a directory` }
  const endpoints = resolveEndpoint({ registry, env })
  const outputs = join(dir, 'outputs')
  const ids = readdirSync(items).filter(n => n.endsWith('.jsonl')).sort().map(n => n.slice(0, -6))
  const results = []
  for (const id of ids) {
    const tail = tailTurns(join(items, `${id}.jsonl`), turnCap(limits, opts.turns))
    let unobserved = !tail.ok ? tail.reason : !tail.turns.length ? 'transcript has no text turns' : null
    let lines = null
    if (!unobserved) {
      const asked = await askModel({
        endpoints, turns: tail.turns, fetch: opts.fetch, timeoutFor: opts.timeoutFor ?? fixedTimeout(limits),
        setTimer: opts.setTimer, clearTimer: opts.clearTimer,
      })
      if (asked.ok) lines = asked.lines
      else unobserved = asked.reason
    }
    mkdirSync(outputs, { recursive: true })
    writeFileSync(join(outputs, `${id}.md`), `${redact(lines ? lines.join('\n') : `unobserved: ${unobserved}`)}\n`)
    results.push(lines ? { id, written: true } : { id, written: false, unobserved })
  }
  const labels = readLabels(join(dir, 'labels.jsonl'))
  const out = results.map(r => (r.written ? `${r.id}: written` : `${r.id}: unobserved: ${r.unobserved}`))
  let score = null
  if (labels) {
    const count = key => labels.filter(l => l[key] === true).length
    score = { nextCorrect: { k: count('nextCorrect'), n: labels.length }, nothingInvented: { k: count('nothingInvented'), n: labels.length } }
    out.push(`nextCorrect: ${score.nextCorrect.k} of ${score.nextCorrect.n}`, `nothingInvented: ${score.nothingInvented.k} of ${score.nothingInvented.n}`)
  } else {
    out.push('unobserved: no labels')
  }
  return { ok: true, items: results, score, lines: out }
}
