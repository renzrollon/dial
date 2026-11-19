// The page shell: reads the token from the page address, wraps EventSource and
// fetch for the controller, and maps the controller's view onto the document.
// Every string reaches the document through textContent only.
import { createController } from './page-logic.mjs'
import { createStage, paint } from './stage.mjs'

const token = new URLSearchParams(location.search).get('t') ?? ''
const EVENTS = ['hello', 'state', 'user', 'sentence', 'tool', 'error', 'proposal', 'sessions', 'notice', 'bye']
const LABELS = { user: 'You', sentence: 'Dial', tool: 'Ran', error: 'Error' }
const PROPOSAL_STATUS = {
  pending: 'Dial is reading this to you.',
  read: 'Say confirm or cancel, or use the buttons.',
  starting: 'Starting the session.',
  failed: 'The session did not start.',
}

const $ = id => document.getElementById(id)
const statusEl = $('status')
const errorEl = $('error')
const noticeEl = $('notice')
const interimEl = $('interim')
const transcriptEl = $('transcript')
const emptyEl = $('empty')
const inputEl = $('turn')
const formEl = $('turn-form')
const muteEl = $('mute')
const canvasEl = $('stage')
const proposalEl = $('proposal')
const proposalRepoEl = $('proposal-repo')
const proposalPromptEl = $('proposal-prompt')
const proposalStatusEl = $('proposal-status')
const proposalReasonEl = $('proposal-reason')
const confirmEl = $('confirm')
const cancelEl = $('cancel')
const sessionsEl = $('sessions')
const sessionsEmptyEl = $('sessions-empty')
const logPanelEl = $('log-panel')
const logTitleEl = $('log-title')
const logReasonEl = $('log-reason')
const logLinesEl = $('log-lines')

let listed = []

function connect({ onEvent, onError }) {
  const source = new EventSource(`/events?t=${encodeURIComponent(token)}`)
  for (const name of EVENTS) {
    source.addEventListener(name, event => {
      // A server event named error carries data; a failed connection does not.
      if (name === 'error' && typeof event.data !== 'string') {
        source.close()
        onError()
        return
      }
      let data = {}
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      onEvent(name, data)
    })
  }
  return { close: () => source.close() }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dial-Token': token },
    body: JSON.stringify(body),
  })
  let parsed = {}
  try {
    parsed = await response.json()
  } catch {
    parsed = {}
  }
  return { status: response.status, body: parsed }
}

// GET with the launch token in the t query parameter, as GET /events carries it.
// The controller asks for '/log?id=<id>'; the token is added here.
async function get(path) {
  const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`)
  let parsed = {}
  try {
    parsed = await response.json()
  } catch {
    parsed = {}
  }
  return { status: response.status, body: parsed }
}

function button(label, name, handler) {
  const control = document.createElement('button')
  control.type = 'button'
  control.textContent = label
  control.setAttribute('aria-label', name)
  control.addEventListener('click', handler)
  return control
}

function paragraph(className, text) {
  const element = document.createElement('p')
  element.className = className
  element.textContent = text
  return element
}

function startedAt(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString()
}

function sessionItem(session) {
  const item = document.createElement('li')
  item.className = 'session'
  const state = session.waitingFor ? `${session.state}: ${session.waitingFor}` : String(session.state ?? '')
  const head = document.createElement('p')
  head.className = 'session-head'
  const repo = document.createElement('strong')
  repo.textContent = String(session.repo ?? '')
  head.append(repo, ` \u00b7 ${state} \u00b7 ${startedAt(session.startedAt)}`)
  const command = document.createElement('p')
  command.className = 'session-command'
  const code = document.createElement('code')
  code.textContent = `claude attach ${session.id}`
  command.append(code)
  const controls = document.createElement('div')
  controls.className = 'session-controls'
  const who = `${session.repo} ${session.id}`
  controls.append(
    button('Log', `Log of ${who}`, () => controller.openLog(session.id)),
    button('Stop', `Stop ${who}`, () => {
      void controller.stopSession(session.id)
    }),
    button('Terminal', `Open ${who} in a terminal`, () => {
      void controller.attach(session.id)
    }),
  )
  item.append(head, paragraph('session-prompt', String(session.prompt ?? '')), command, controls)
  return item
}

const view = {
  status: text => {
    statusEl.textContent = text
  },
  error: text => {
    errorEl.textContent = text
  },
  notice: text => {
    noticeEl.textContent = text
  },
  interim: text => {
    interimEl.textContent = text
  },
  line: (kind, text) => {
    const line = document.createElement('div')
    line.className = `line line-${kind}`
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = LABELS[kind] ?? kind
    const body = document.createElement('span')
    body.className = 'text'
    body.textContent = text
    line.append(label, ' ', body)
    emptyEl.hidden = true
    transcriptEl.append(line)
    transcriptEl.scrollTop = transcriptEl.scrollHeight
  },
  proposal: (card, reason) => {
    proposalEl.hidden = card === null
    if (card === null) return
    proposalRepoEl.textContent = String(card.repo ?? '')
    proposalPromptEl.textContent = String(card.prompt ?? '')
    proposalStatusEl.textContent = PROPOSAL_STATUS[card.status] ?? String(card.status ?? '')
    proposalReasonEl.textContent = reason ?? ''
    const open = card.status === 'pending' || card.status === 'read'
    confirmEl.hidden = !open
    cancelEl.hidden = !open
  },
  sessions: list => {
    listed = list
    sessionsEmptyEl.hidden = list.length > 0
    sessionsEl.replaceChildren(...list.map(sessionItem))
  },
  log: (id, lines, reason) => {
    logPanelEl.hidden = id === null
    if (id === null) return
    const session = listed.find(entry => entry.id === id)
    logTitleEl.textContent = `Log of ${session?.repo ?? ''} ${id}`.replace('  ', ' ')
    logReasonEl.textContent = reason ?? ''
    const atEnd = logLinesEl.scrollTop + logLinesEl.clientHeight >= logLinesEl.scrollHeight - 4
    logLinesEl.textContent = lines.join('\n')
    if (atEnd) logLinesEl.scrollTop = logLinesEl.scrollHeight
  },
  stage: change => stage.tell(change),
  muted: on => {
    muteEl.setAttribute('aria-pressed', String(on))
  },
  clearInput: () => {
    inputEl.value = ''
  },
  focusStatus: () => {
    statusEl.focus()
  },
  closed: () => {
    for (const control of document.querySelectorAll('button, input')) control.disabled = true
  },
}

// The mechanism. The canvas is as many pixels as its element is wide times the device pixel ratio, at most 2. Its
// colours are read from the style sheet, so no script holds one.
const context = canvasEl.getContext('2d')
let parts = []
let tones = {}

function readTones() {
  const computed = getComputedStyle(document.documentElement)
  const tone = name => computed.getPropertyValue(name).trim()
  tones = {
    ground: tone('--ground'),
    live: tone('--stage-live'),
    rest: tone('--stage-rest'),
    accent: tone('--stage-accent'),
    ok: tone('--stage-ok'),
    fail: tone('--stage-fail'),
  }
}

function drawParts() {
  if (context) paint(context, parts, { width: canvasEl.width, height: canvasEl.height, tones })
}

function sizeCanvas() {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2)
  const box = canvasEl.getBoundingClientRect()
  canvasEl.width = Math.max(1, Math.round(box.width * ratio))
  canvasEl.height = Math.max(1, Math.round(box.height * ratio))
  drawParts()
}

const stage = createStage({
  draw: next => {
    parts = next
    drawParts()
  },
  raf: callback => requestAnimationFrame(callback),
  cancelRaf: handle => cancelAnimationFrame(handle),
  timers: { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: handle => globalThis.clearTimeout(handle) },
  now: () => performance.now(),
})

// The browser's own full screen, handed to the controller as three small functions.
const screen = {
  enter: () => document.documentElement.requestFullscreen(),
  leave: () => document.exitFullscreen(),
  active: () => Boolean(document.fullscreenElement),
}

const controller = createController({ Recognition: globalThis.SpeechRecognition, post, get, connect, view, screen })

readTones()
sizeCanvas()
window.addEventListener('resize', sizeCanvas)
document.addEventListener('visibilitychange', () => {
  stage.hidden(document.hidden)
})
const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)')
stage.tell({ reduced: reducedMotion.matches })
reducedMotion.addEventListener('change', event => {
  stage.tell({ reduced: event.matches })
})
if (document.hidden) stage.hidden(true)
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) controller.leftFullScreen()
})
$('fullscreen').addEventListener('click', () => {
  void controller.fullScreen()
})
canvasEl.addEventListener('click', () => {
  void controller.stop()
})

$('start').addEventListener('click', () => {
  void controller.start()
})
muteEl.addEventListener('click', () => {
  controller.mute(muteEl.getAttribute('aria-pressed') !== 'true')
})
$('stop').addEventListener('click', () => {
  void controller.stop()
})
$('quit').addEventListener('click', () => {
  void controller.quit()
})
confirmEl.addEventListener('click', () => {
  void controller.confirm()
})
cancelEl.addEventListener('click', () => {
  void controller.cancel()
})
$('log-close').addEventListener('click', () => {
  controller.closeLog()
})
formEl.addEventListener('submit', event => {
  event.preventDefault()
  void controller.submit(inputEl.value)
})
document.addEventListener('keydown', event => {
  controller.key(event.key)
})

controller.open()
