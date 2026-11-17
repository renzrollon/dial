// The say queue for dial voice: one `say` process per sentence, text on stdin.

/**
 * `spawn` is the child runner of lib/spawn.mjs. `on` receives
 * `{ type: 'busy', busy }` on each change and `{ type: 'error', message }` once,
 * after which nothing more is spoken.
 */
export function createSpeaker({ spawn, voice, enabled, on }) {
  const queue = []
  let current = null // { handle, stopped, exited }
  let failed = false
  let closed = false
  let lastBusy = false
  let waiters = []

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
    const text = queue.shift()
    const child = { handle: null, stopped: false }
    current = child
    child.handle = spawn('say', voice ? ['-v', voice] : [], {
      onLine() {},
      onExit({ code, stderr, error }) {
        current = null
        if (!child.stopped && !failed && !closed) {
          const line = String(stderr ?? '').split('\n').find(l => l.trim() !== '')
          if (error) fail(error.message || 'could not start say')
          else if (code !== 0) fail(line?.trim() || `say exited with code ${code}`)
        }
        pump()
        update()
        settle()
      }
    })
    child.handle.write(text)
    child.handle.end()
  }

  function fail(message) {
    failed = true
    queue.length = 0
    on?.({ type: 'error', message })
  }

  return {
    say(text) {
      if (enabled === false || failed || closed) return
      queue.push(String(text))
      pump()
      update()
    },
    stop() {
      queue.length = 0
      if (current && !current.stopped) {
        current.stopped = true
        current.handle.kill()
      }
      update()
    },
    shutdown() {
      closed = true
      queue.length = 0
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
