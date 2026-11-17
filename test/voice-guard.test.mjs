import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRequest, newToken } from '../lib/voice/guard.mjs'

const PORT = 3425
const TOKEN = 'a'.repeat(16) + 'b'.repeat(16)
const CTX = { port: PORT, token: TOKEN }
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://127.0.0.1:${PORT}`

/** A request that passes every check, with `headers` and the rest overridden. */
function req({ method = 'POST', url = '/turn', headers = {} } = {}) {
  const base = { host: HOST }
  if (method === 'POST') Object.assign(base, { 'x-dial-token': TOKEN, origin: ORIGIN, 'content-type': 'application/json' })
  const merged = { ...base, ...headers }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return { method, url, headers: merged }
}

const refusal = (request, status, reason) => {
  const out = checkRequest(request, CTX)
  assert.equal(out.ok, false, JSON.stringify(request))
  assert.equal(out.status, status, JSON.stringify(request))
  if (reason !== undefined) assert.equal(out.reason, reason, JSON.stringify(request))
  return out
}

// voice: "Every request is checked before it is served", design §13 route names.
// Re-pinned for add-voice-orchestrator, voice-sessions: "The page can read a session's screen as text" (eight paths became thirteen:
// GET /log with the token in `t`, and POST /confirm, /cancel, /stop and /attach checked as /turn is).
test('each of the thirteen paths gives its route', () => {
  const routes = [
    ['GET', '/', 'page'],
    ['GET', '/page.js', 'script'],
    ['GET', '/page-logic.mjs', 'logic'],
    ['GET', '/page.css', 'style'],
    ['GET', `/events?t=${TOKEN}`, 'events'],
    ['POST', '/turn', 'turn'],
    ['POST', '/interrupt', 'interrupt'],
    ['POST', '/quit', 'quit'],
    ['GET', `/log?t=${TOKEN}&id=c7b0ada6`, 'log'],
    ['POST', '/confirm', 'confirm'],
    ['POST', '/cancel', 'cancel'],
    ['POST', '/stop', 'stop'],
    ['POST', '/attach', 'attach']
  ]
  assert.equal(routes.length, 13)
  for (const [method, url, route] of routes) {
    assert.deepEqual(checkRequest(req({ method, url }), CTX), { ok: true, route }, `${method} ${url}`)
  }
})

test('the four static paths need no token and ignore a query string', () => {
  for (const url of ['/', '/page.js', '/page-logic.mjs', '/page.css']) {
    assert.equal(checkRequest(req({ method: 'GET', url }), CTX).ok, true, url)
    assert.equal(checkRequest(req({ method: 'GET', url: `${url}?t=wrong&x=1` }), CTX).ok, true, `${url} with a query`)
  }
  assert.equal(checkRequest(req({ method: 'GET', url: '/?t=' + TOKEN }), CTX).route, 'page')
})

test('a wrong Host is refused 403 with the reason wrong host', () => {
  for (const host of [undefined, `localhost:${PORT}`, '127.0.0.1', `127.0.0.1:${PORT + 1}`, `evil.example:${PORT}`, '']) {
    refusal(req({ headers: { host } }), 403, 'wrong host')
    refusal(req({ method: 'GET', url: '/', headers: { host } }), 403, 'wrong host')
  }
})

test('a wrong host on an unknown path is 403, not 404', () => {
  refusal(req({ method: 'GET', url: '/admin', headers: { host: 'evil.example:3425' } }), 403, 'wrong host')
})

test('a missing or wrong token on the event stream or a POST is 403 missing or wrong token', () => {
  const reason = 'missing or wrong token'
  refusal(req({ method: 'GET', url: '/events' }), 403, reason)
  refusal(req({ method: 'GET', url: '/events?t=' }), 403, reason)
  refusal(req({ method: 'GET', url: '/events?t=wrong' }), 403, reason)
  refusal(req({ method: 'GET', url: `/events?t=${TOKEN.slice(0, 31)}` }), 403, reason)
  refusal(req({ method: 'GET', url: `/events?t=${TOKEN}0` }), 403, reason)
  refusal(req({ method: 'GET', url: '/events', headers: { 'x-dial-token': TOKEN } }), 403, reason)
  for (const path of ['/turn', '/interrupt', '/quit']) {
    refusal(req({ url: path, headers: { 'x-dial-token': undefined } }), 403, reason)
    refusal(req({ url: path, headers: { 'x-dial-token': 'wrong' } }), 403, reason)
    refusal(req({ url: path, headers: { 'x-dial-token': TOKEN.slice(0, 31) } }), 403, reason)
    refusal(req({ url: path, headers: { 'x-dial-token': '' } }), 403, reason)
  }
})

// The token is compared by bytes: a token of the right character count in multi-byte
// characters has a longer buffer and is refused 403, never thrown as a 500.
test('a multi-byte token of the right character count is 403, not a throw', () => {
  const reason = 'missing or wrong token'
  const wide = '\u00e9'.repeat(TOKEN.length)
  assert.equal(wide.length, TOKEN.length)
  refusal(req({ method: 'GET', url: `/events?t=${encodeURIComponent(wide)}` }), 403, reason)
  refusal(req({ method: 'GET', url: `/events?t=${'%C3%A9'.repeat(TOKEN.length)}` }), 403, reason)
  refusal(req({ method: 'GET', url: `/events?t=${encodeURIComponent('\u{1F600}'.repeat(TOKEN.length / 2))}` }), 403, reason)
  for (const path of ['/turn', '/interrupt', '/quit']) {
    refusal(req({ url: path, headers: { 'x-dial-token': wide } }), 403, reason)
  }
})

test('a POST with the token only in the query string is refused', () => {
  refusal(req({ url: `/turn?t=${TOKEN}`, headers: { 'x-dial-token': undefined } }), 403, 'missing or wrong token')
})

test('a missing, null or foreign Origin on a POST is 403', () => {
  for (const origin of [undefined, 'null', `http://localhost:${PORT}`, 'https://example.com', `https://127.0.0.1:${PORT}`, 'http://127.0.0.1']) {
    refusal(req({ headers: { origin } }), 403)
  }
  assert.equal(checkRequest(req(), CTX).ok, true)
})

test('a POST with another content type is 415 and a JSON one with a charset is accepted', () => {
  refusal(req({ headers: { 'content-type': undefined } }), 415)
  refusal(req({ headers: { 'content-type': 'text/plain' } }), 415)
  refusal(req({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 415)
  assert.deepEqual(checkRequest(req({ headers: { 'content-type': 'application/json; charset=utf-8' } }), CTX), { ok: true, route: 'turn' })
})

test('the other-site scenario: a right token and Host with a foreign Origin is refused', () => {
  refusal(req({ headers: { origin: 'https://example.com' } }), 403)
})

test('an unknown path is 404 and a wrong method is 405, each with a reason', () => {
  const unknown = refusal(req({ method: 'GET', url: '/admin' }), 404)
  assert.equal(typeof unknown.reason, 'string')
  assert.ok(unknown.reason.length > 0)
  for (const [method, url] of [['GET', '/turn'], ['POST', '/'], ['PUT', '/turn'], ['GET', '/interrupt'], ['GET', '/quit'], ['POST', '/events'], ['POST', '/page.js']]) {
    const out = refusal(req({ method, url }), 405)
    assert.equal(typeof out.reason, 'string', `${method} ${url}`)
    assert.ok(out.reason.length > 0, `${method} ${url}`)
  }
})

test('the checks run in order: Host, path, method, token, Origin, content type', () => {
  refusal(req({ url: '/admin', headers: { host: 'x:1', 'x-dial-token': undefined } }), 403, 'wrong host')
  refusal(req({ method: 'GET', url: '/turn', headers: { 'x-dial-token': undefined } }), 405)
  refusal(req({ headers: { 'x-dial-token': 'wrong', origin: undefined, 'content-type': 'text/plain' } }), 403, 'missing or wrong token')
  refusal(req({ headers: { origin: undefined, 'content-type': 'text/plain' } }), 403)
})

test('newToken is 32 lowercase hex characters and differs between calls', () => {
  const a = newToken()
  const b = newToken()
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.match(b, /^[0-9a-f]{32}$/)
  assert.notEqual(a, b)
})

// voice-sessions: "The page can read a session's screen as text": GET /log carries the token in `t`, as GET /events does.
test('GET /log without the token is 403 missing or wrong token and with it gives the route log', () => {
  const reason = 'missing or wrong token'
  refusal(req({ method: 'GET', url: '/log?id=c7b0ada6' }), 403, reason)
  refusal(req({ method: 'GET', url: '/log' }), 403, reason)
  refusal(req({ method: 'GET', url: '/log?t=&id=c7b0ada6' }), 403, reason)
  refusal(req({ method: 'GET', url: '/log?t=wrong&id=c7b0ada6' }), 403, reason)
  refusal(req({ method: 'GET', url: `/log?t=${TOKEN.slice(0, 31)}&id=c7b0ada6` }), 403, reason)
  refusal(req({ method: 'GET', url: '/log?id=c7b0ada6', headers: { 'x-dial-token': TOKEN } }), 403, reason)
  assert.deepEqual(checkRequest(req({ method: 'GET', url: `/log?id=c7b0ada6&t=${TOKEN}` }), CTX), { ok: true, route: 'log' })
  assert.deepEqual(checkRequest(req({ method: 'GET', url: `/log?t=${TOKEN}` }), CTX), { ok: true, route: 'log' })
})

test('GET /log with a foreign Host is 403 wrong host', () => {
  refusal(req({ method: 'GET', url: `/log?t=${TOKEN}&id=c7b0ada6`, headers: { host: 'evil.example:3425' } }), 403, 'wrong host')
})

// voice-sessions: the confirm, cancel, stop and attach routes are checked as /turn is.
const SESSION_POSTS = [['/confirm', 'confirm'], ['/cancel', 'cancel'], ['/stop', 'stop'], ['/attach', 'attach']]

test('POST /confirm, /cancel, /stop and /attach give their routes', () => {
  for (const [path, route] of SESSION_POSTS) {
    assert.deepEqual(checkRequest(req({ url: path }), CTX), { ok: true, route }, path)
    assert.deepEqual(checkRequest(req({ url: path, headers: { 'content-type': 'application/json; charset=utf-8' } }), CTX), { ok: true, route }, `${path} with a charset`)
  }
})

test('the four session POSTs need the token header, a same-origin Origin and a JSON content type', () => {
  for (const [path] of SESSION_POSTS) {
    for (const token of [undefined, 'wrong', TOKEN.slice(0, 31), '']) {
      refusal(req({ url: path, headers: { 'x-dial-token': token } }), 403, 'missing or wrong token')
    }
    refusal(req({ url: `${path}?t=${TOKEN}`, headers: { 'x-dial-token': undefined } }), 403, 'missing or wrong token')
    for (const origin of [undefined, 'null', `http://localhost:${PORT}`, 'https://example.com', `https://127.0.0.1:${PORT}`]) {
      refusal(req({ url: path, headers: { origin } }), 403)
    }
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
      refusal(req({ url: path, headers: { 'content-type': type } }), 415)
    }
    refusal(req({ url: path, headers: { host: 'evil.example:3425' } }), 403, 'wrong host')
  }
})

test('the checks run in the same order for the four session POSTs', () => {
  for (const [path] of SESSION_POSTS) {
    refusal(req({ url: path, headers: { 'x-dial-token': 'wrong', origin: undefined, 'content-type': 'text/plain' } }), 403, 'missing or wrong token')
    refusal(req({ url: path, headers: { origin: undefined, 'content-type': 'text/plain' } }), 403)
  }
})

test('GET /confirm, /cancel, /stop and /attach and POST /log are 405 with a reason', () => {
  for (const [path] of SESSION_POSTS) {
    for (const method of ['GET', 'PUT']) {
      const out = refusal(req({ method, url: path }), 405)
      assert.equal(typeof out.reason, 'string', `${method} ${path}`)
      assert.ok(out.reason.length > 0, `${method} ${path}`)
    }
  }
  for (const method of ['POST', 'PUT']) {
    const out = refusal(req({ method, url: `/log?t=${TOKEN}&id=c7b0ada6` }), 405)
    assert.equal(typeof out.reason, 'string', `${method} /log`)
    assert.ok(out.reason.length > 0, `${method} /log`)
  }
})
