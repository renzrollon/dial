// The page shell: reads the token from the page address, wraps EventSource and
// fetch for the controller, and maps the controller's view onto the document.
// Every string reaches the document through textContent only.
import { createController } from './page-logic.mjs'

const token = new URLSearchParams(location.search).get('t') ?? ''
const EVENTS = ['hello', 'state', 'user', 'sentence', 'tool', 'error', 'bye']
const LABELS = { user: 'You', sentence: 'Dial', tool: 'Ran', error: 'Error' }

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

const controller = createController({ Recognition: globalThis.SpeechRecognition, post, connect, view })

$('start').addEventListener('click', () => {
  void controller.start()
})
muteEl.addEventListener('click', () => {
  const on = muteEl.getAttribute('aria-pressed') !== 'true'
  muteEl.setAttribute('aria-pressed', String(on))
  controller.mute(on)
})
$('stop').addEventListener('click', () => {
  void controller.stop()
})
$('quit').addEventListener('click', () => {
  void controller.quit()
})
formEl.addEventListener('submit', event => {
  event.preventDefault()
  void controller.submit(inputEl.value)
})
document.addEventListener('keydown', event => {
  controller.key(event.key)
})

controller.open()
