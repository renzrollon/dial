/**
 * Shared helpers for the interactive setup scripts: one question at a time,
 * a default in brackets, and a way to run the checkout's own `dial` so the
 * scripts work before `npm i -g .` has put it on PATH.
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DIAL_BIN = join(CHECKOUT, 'bin', 'dial.mjs')

// Lines are queued as they arrive, so piped answers are not lost between questions.
const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY })
const lines = []
const waiting = []
let closed = false
rl.on('line', line => (waiting.length ? waiting.shift()(line) : lines.push(line)))
rl.on('close', () => {
  closed = true
  while (waiting.length) waiting.shift()(null)
})

function nextLine() {
  if (lines.length) return Promise.resolve(lines.shift())
  if (closed) return Promise.resolve(null)
  return new Promise(res => waiting.push(res))
}

/** Thrown when stdin ends mid-setup: stop rather than take defaults nobody chose. */
export class InputEnded extends Error {
  constructor() {
    super('input ended; stopped. Nothing after the last answered question was done.')
  }
}

/** Ask one question. A blank answer takes the default; end of input throws InputEnded. */
export async function ask(question, def = '') {
  process.stdout.write(def ? `${question} [${def}]: ` : `${question}: `)
  const line = await nextLine()
  if (line === null) {
    process.stdout.write('\n')
    throw new InputEnded()
  }
  return line.trim() || def
}

/** Ask until `check(answer)` returns null; otherwise print its reason and ask again. */
export async function askValid(question, def, check) {
  for (;;) {
    const answer = await ask(question, def)
    const problem = check(answer)
    if (!problem) return answer
    console.log(`  ${problem}`)
  }
}

/** A yes/no question. */
export async function confirm(question, def = true) {
  const answer = (await ask(`${question} (y/n)`, def ? 'y' : 'n')).toLowerCase()
  return answer.startsWith('y')
}

/** Pick one of `choices` by number or by name. */
export async function choose(question, choices, def = choices[0]) {
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
  return askValid(question, def, a => (choices.includes(a) || choices[Number(a) - 1] ? null : `pick one of: ${choices.join(', ')}`)).then(
    a => (choices.includes(a) ? a : choices[Number(a) - 1])
  )
}

/** Run a script's main: exit code from `main`, a clean message on InputEnded. */
export async function runMain(main) {
  try {
    process.exitCode = await main()
  } catch (err) {
    if (!(err instanceof InputEnded)) throw err
    console.log(err.message)
    process.exitCode = 1
  } finally {
    done()
  }
}

export function done() {
  rl.close()
}

export function heading(text) {
  console.log(`\n== ${text} ==`)
}

/** Run a command with inherited stdio. Returns the exit status. */
export function run(cmd, args, opts = {}) {
  console.log(`$ ${[cmd, ...args].map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) console.log(`  could not run ${cmd}: ${r.error.message}`)
  return r.error ? 1 : r.status
}

/** Run the checkout's `dial` with the current Node. */
export function dial(...args) {
  return run(process.execPath, [DIAL_BIN, ...args])
}

/** Capture a command's stdout, or null when it fails. */
export function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
