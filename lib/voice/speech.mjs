// The say queue for dial voice: one `say` process per sentence, text on stdin.

/**
 * `spawn` is the child runner of lib/spawn.mjs. `on` receives
 * `{ type: 'busy', busy }` on each change and `{ type: 'error', message }` once,
 * after which nothing more is spoken. `say(text, done)` calls the optional `done(spoken)` exactly once:
 * true when that sentence's `say` process exited 0 and was not stopped, false otherwise (stopped, failed,
 * dropped from the queue, or speech is off or quiet).
 */
export function createSpeaker({ spawn, voice, enabled, on }) {
  const queue = []
  let current = null // { handle, stopped, exited }
  let failed = false
  let closed = false
  let lastBusy = false
  let waiters = []

  // Run a sentence's callback once; a throwing callback must not break the queue.
  const finishWith = (entry, spoken) => {
    const done = entry?.done
    if (!done) return
    entry.done = null
    try {
      done(spoken)
    } catch {}
  }
  const dropQueue = () => {
    const dropped = queue.splice(0)
    for (const entry of dropped) finishWith(entry, false)
  }

  const isBusy = () => queue.length > 0 || (current !== null && !current.stopped)

  function update() {
    const busy = enabled !== false && isBusy()
    if (busy === lastBusy) return
    lastBusy = busy
    on?.({ type: 'busy', busy })
  }

  function settle() {
    if (current !== null) return
    const list = waiters
    waiters = []
    for (const resolve of list) resolve()
  }

  function pump() {
    if (current !== null || failed || closed || queue.length === 0) return
    const entry = queue.shift()
    const child = { handle: null, stopped: false }
    current = child
    child.handle = spawn('say', voice ? ['-v', voice] : [], {
      onLine() {},
      onExit({ code, stderr, error }) {
        current = null
        const spoken = !child.stopped && !failed && !closed && !error && code === 0
        if (!child.stopped && !failed && !closed) {
          const line = String(stderr ?? '').split('\n').find(l => l.trim() !== '')
          if (error) fail(error.message || 'could not start say')
          else if (code !== 0) fail(line?.trim() || `say exited with code ${code}`)
        }
        finishWith(entry, spoken)
        pump()
        update()
        settle()
      }
    })
    child.handle.write(entry.text)
    child.handle.end()
  }

  function fail(message) {
    failed = true
    dropQueue()
    on?.({ type: 'error', message })
  }

  return {
    say(text, done) {
      if (enabled === false || failed || closed) return finishWith({ done }, false)
      queue.push({ text: String(text), done })
      pump()
      update()
    },
    stop() {
      dropQueue()
      if (current && !current.stopped) {
        current.stopped = true
        current.handle.kill()
      }
      update()
    },
    shutdown() {
      closed = true
      dropQueue()
      if (current && !current.stopped) {
        current.stopped = true
        current.handle.kill()
      }
      update()
      if (current === null) return Promise.resolve()
      return new Promise(resolve => waiters.push(resolve))
    },
    get busy() {
      return enabled !== false && isBusy()
    }
  }
}
