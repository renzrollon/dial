// The listening loop of the voice page. No DOM and no network: the recognizer
// class, `post`, `connect`, the timers and the `view` are all handed in, so the
// whole loop runs under test. See design section 9 and the interfaces in
// section 13 of the add-voice-ui change, and section 11 of add-voice-orchestrator
// for the proposal card, the session list and the log.

const RETRY_MS = [500, 1000, 2000]
const RESTART_MS = 50
const RECONNECTED = 'Reconnected; anything said while the page was away is not shown'
const CLOSED_PROPOSAL = new Set(['started', 'cancelled', 'expired', 'replaced'])
const LOG_UNREADABLE = 'the log could not be read'
const DEFAULT_POLL_SECONDS = 5

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: handle => globalThis.clearInterval(handle),
}

const MIC_NOTICES = {
  'not-allowed': 'the microphone was not allowed',
  'service-not-allowed': 'the microphone was not allowed',
  'audio-capture': 'no microphone could be used',
}

/**
 * Is on-device recognition offered for `lang`? Never creates a recognizer, so
 * it never asks for the microphone.
 * @returns {Promise<'ready' | 'unavailable'>}
 */
export async function checkRecognition(Recognition, lang) {
  try {
    if (!Recognition || typeof Recognition.available !== 'function') return 'unavailable'
    const options = { langs: [lang], processLocally: true }
    const availability = await Recognition.available(options)
    if (availability === 'available') return 'ready'
    if (availability === 'downloadable' || availability === 'downloading') {
      if (typeof Recognition.install !== 'function') return 'unavailable'
      return (await Recognition.install(options)) === true ? 'ready' : 'unavailable'
    }
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/**
 * The word a final transcript is, when it is exactly `confirm` or `cancel`
 * after trimming, lowercasing and dropping one final `.`, `!` or `?`.
 */
function proposalWord(text) {
  const word = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]$/, '')
  return word === 'confirm' || word === 'cancel' ? word : ''
}

export function createController({ Recognition, post, get, connect, timers, view }) {
  const clock = timers ?? defaultTimers

  let lang = 'en-US'
  let closed = false

  // the event stream
  let stream = null
  let generation = 0
  let attempt = 0
  let retryTimer = null
  let connected = false
  let seenHello = false
  let dropped = false

  // what the server last said
  let serverState = null
  let refusal = ''
  let lastTool = ''

  // the owner's side
  let recog = 'none' // 'none' before Start, 'ready', or 'typed' (typed turns only)
  let starting = false
  let muted = false

  // the recognizer
  let current = null
  let restartTimer = null

  // a turn this page posted
  let posting = false
  let inFlight = false
  let sawBusy = false

  // the open proposal, the session list and the open log
  let proposal = null
  let sessionList = []
  let pollSeconds = DEFAULT_POLL_SECONDS
  let logId = null
  let logLines = []
  let logTimer = null
  let logRun = 0

  let shownStatus = null

  function statusText() {
    if (closed) return 'Closed'
    if (serverState === 'refused') return `Refused: ${refusal}`
    if (serverState === 'thinking' && lastTool) return `Thinking: running ${lastTool}`
    if (serverState === 'thinking' || inFlight) return 'Thinking'
    if (serverState === 'speaking') return 'Speaking'
    if (recog === 'typed') return 'Typed turns only'
    if (recog === 'none') return 'Not started'
    if (muted) return 'Muted'
    return 'Listening'
  }

  function render() {
    const text = statusText()
    if (text === shownStatus) return
    shownStatus = text
    view.status(text)
  }

  function clearInterim() {
    view.interim('')
  }

  function canListen() {
    return !closed && recog === 'ready' && !muted && connected && serverState === 'idle' && !inFlight
  }

  function stopRecognition() {
    if (restartTimer !== null) {
      clock.clearTimeout(restartTimer)
      restartTimer = null
    }
    const rec = current
    current = null
    if (!rec) return
    try {
      if (typeof rec.abort === 'function') rec.abort()
      else rec.stop()
    } catch {
      // a recognizer that is already over has nothing left to stop
    }
  }

  function micFailed(notice) {
    stopRecognition()
    recog = 'typed'
    clearInterim()
    view.notice(notice)
    render()
  }

  function ensureListening() {
    if (current || !canListen()) return
    let rec
    try {
      rec = new Recognition()
      rec.lang = lang
      rec.interimResults = true
      rec.processLocally = true
      rec.onresult = event => onResult(rec, event)
      rec.onend = () => onEnd(rec)
      rec.onerror = event => onRecognitionError(rec, event)
      current = rec
      rec.start()
    } catch (error) {
      current = null
      micFailed(`speech recognition failed (${error?.name || 'error'})`)
      return
    }
    render()
  }

  function onEnd(rec) {
    if (rec !== current) return
    current = null
    clearInterim()
    if (canListen() && restartTimer === null) {
      restartTimer = clock.setTimeout(() => {
        restartTimer = null
        ensureListening()
      }, RESTART_MS)
    }
  }

  function onRecognitionError(rec, event) {
    if (rec !== current) return
    const code = String(event?.error ?? 'unknown')
    if (code === 'no-speech' || code === 'aborted') return
    micFailed(`${MIC_NOTICES[code] ?? 'speech recognition failed'} (${code})`)
  }

  function onResult(rec, event) {
    if (rec !== current) return
    const results = event?.results ?? []
    let finalText = ''
    let interimText = ''
    for (let i = event?.resultIndex ?? 0; i < results.length; i += 1) {
      const result = results[i]
      const transcript = result?.[0]?.transcript ?? ''
      if (result?.isFinal) finalText += transcript
      else interimText += transcript
    }
    if (finalText.trim()) {
      stopRecognition()
      clearInterim()
      const word = proposal?.status === 'read' ? proposalWord(finalText) : ''
      if (word === 'confirm') void decide('/confirm', { id: proposal.id, spoken: true })
      else if (word === 'cancel') void decide('/cancel', { id: proposal.id })
      else void postTurn(finalText.trim(), false)
    } else if (interimText) {
      view.interim(interimText)
    }
  }

  async function postTurn(text, typed) {
    if (closed || inFlight) return
    inFlight = true
    posting = true
    sawBusy = false
    stopRecognition()
    clearInterim()
    render()
    let answer = null
    try {
      answer = await post('/turn', { text })
    } catch {
      answer = null
    }
    posting = false
    if (closed) return
    if (answer && answer.status === 202) {
      view.error('')
      if (typed) view.clearInput()
      if (sawBusy) inFlight = false
    } else {
      inFlight = false
      view.error(answer ? (answer.body?.reason ?? `the turn was not accepted (${answer.status})`) : 'the turn could not be sent')
    }
    render()
    ensureListening()
  }

  // a spoken confirm or cancel: not a turn, so nothing holds the microphone afterwards
  async function decide(path, body) {
    await command(path, body)
    ensureListening()
  }

  function stopLog() {
    logRun += 1
    if (logTimer !== null) {
      clock.clearTimeout(logTimer)
      logTimer = null
    }
  }

  function closeLog() {
    if (logId === null) return
    stopLog()
    logId = null
    logLines = []
    view.log(null, [], '')
  }

  async function pollLog() {
    const id = logId
    const run = logRun
    if (id === null || closed) return
    let reason = ''
    try {
      const answer = await get(`/log?id=${encodeURIComponent(id)}`)
      if (answer && answer.status === 200 && Array.isArray(answer.body?.lines)) {
        logLines = answer.body.lines.map(String)
      } else {
        reason = answer?.body?.reason ?? LOG_UNREADABLE
      }
    } catch {
      reason = LOG_UNREADABLE
    }
    if (run !== logRun || closed) return
    view.log(id, logLines, reason)
    logTimer = clock.setTimeout(() => {
      logTimer = null
      void pollLog()
    }, pollSeconds * 1000)
  }

  function shutDown() {
    if (closed) return
    closed = true
    generation += 1
    stopLog()
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer)
      retryTimer = null
    }
    stopRecognition()
    clearInterim()
    try {
      stream?.close()
    } catch {
      // the stream is over either way
    }
    stream = null
    view.closed()
    render()
  }

  function streamFailed() {
    if (closed) return
    generation += 1
    stopRecognition()
    clearInterim()
    connected = false
    serverState = null
    dropped = true
    try {
      stream?.close()
    } catch {
      // the stream is over either way
    }
    stream = null
    if (attempt >= RETRY_MS.length) {
      shutDown()
      return
    }
    const delay = RETRY_MS[attempt]
    attempt += 1
    retryTimer = clock.setTimeout(() => {
      retryTimer = null
      connectStream()
    }, delay)
    render()
  }

  function connectStream() {
    if (closed) return
    generation += 1
    const id = generation
    stream = connect({
      onEvent: (name, data) => {
        if (id === generation) onEvent(name, data)
      },
      onError: () => {
        if (id === generation) streamFailed()
      },
    })
  }

  function onEvent(name, data) {
    if (closed) return
    const body = data ?? {}
    switch (name) {
      case 'hello': {
        if (seenHello && dropped) {
          view.notice(RECONNECTED)
          if (!posting) inFlight = false
        }
        seenHello = true
        dropped = false
        connected = true
        attempt = 0
        serverState = null
        // The card may be stale after a drop: the server sends the open proposal again after hello, if any.
        if (proposal !== null) {
          proposal = null
          view.proposal(null, '')
        }
        if (typeof body.lang === 'string' && body.lang) lang = body.lang
        break
      }
      case 'state': {
        const previous = serverState
        serverState = body.state
        if (serverState === 'refused') {
          refusal = body.reason ?? ''
          if (previous !== 'refused') view.focusStatus()
        }
        if (serverState !== 'thinking') lastTool = ''
        if (serverState === 'idle') {
          ensureListening()
        } else {
          stopRecognition()
          clearInterim()
          if (posting) sawBusy = true
          else inFlight = false
        }
        break
      }
      case 'user':
        view.line('user', String(body.text ?? ''))
        break
      case 'sentence':
        view.line('sentence', String(body.text ?? ''))
        break
      case 'tool':
        lastTool = String(body.command ?? '')
        view.line('tool', lastTool)
        break
      case 'error': {
        const message = String(body.message ?? '')
        view.error(message)
        view.line('error', message)
        break
      }
      case 'proposal': {
        // A later status of an earlier proposal (one settling while a newer one is open) leaves the card as it is.
        if (proposal !== null && body.id !== proposal.id && body.status !== 'pending') break
        if (CLOSED_PROPOSAL.has(body.status)) {
          proposal = null
          view.proposal(null, '')
        } else {
          proposal = body
          view.proposal(body, typeof body.reason === 'string' ? body.reason : '')
        }
        break
      }
      case 'sessions': {
        sessionList = Array.isArray(body.sessions) ? body.sessions : []
        if (Number.isFinite(body.pollSeconds) && body.pollSeconds > 0) pollSeconds = body.pollSeconds
        view.sessions(sessionList)
        if (logId !== null && !sessionList.some(session => session?.id === logId)) closeLog()
        break
      }
      case 'notice':
        view.notice(String(body.text ?? ''))
        break
      case 'bye':
        shutDown()
        return
      default:
        return
    }
    render()
  }

  async function command(path, body = {}) {
    if (closed) return
    try {
      const answer = await post(path, body)
      if (!closed && answer && answer.status >= 300 && answer.body?.reason) view.error(answer.body.reason)
    } catch {
      // no answer: the stream tells the page what became of the server
    }
  }

  return {
    open() {
      render()
      connectStream()
    },
    onEvent,
    async start() {
      if (closed || starting || recog === 'ready') return
      starting = true
      try {
        const result = await checkRecognition(Recognition, lang)
        if (closed) return
        if (result === 'ready') {
          recog = 'ready'
          render()
          ensureListening()
        } else {
          stopRecognition()
          recog = 'typed'
          clearInterim()
          view.notice(`on-device speech recognition is not offered for ${lang}`)
          render()
        }
      } finally {
        starting = false
      }
    },
    mute(on) {
      muted = Boolean(on)
      if (muted) {
        stopRecognition()
        clearInterim()
      } else {
        ensureListening()
      }
      render()
    },
    async submit(text) {
      const trimmed = String(text ?? '').trim()
      if (closed || inFlight || !trimmed) return
      await postTurn(trimmed, true)
    },
    stop() {
      return command('/interrupt')
    },
    quit() {
      return command('/quit')
    },
    key(name) {
      if (name === 'Escape') void command('/interrupt')
    },
    confirm() {
      if (!proposal) return Promise.resolve()
      return command('/confirm', { id: proposal.id, spoken: false })
    },
    cancel() {
      if (!proposal) return Promise.resolve()
      return command('/cancel', { id: proposal.id })
    },
    stopSession(id) {
      return command('/stop', { id: String(id) })
    },
    attach(id) {
      return command('/attach', { id: String(id) })
    },
    openLog(id) {
      if (closed) return
      stopLog()
      logId = String(id)
      logLines = []
      view.log(logId, [], '')
      void pollLog()
    },
    closeLog,
  }
}
