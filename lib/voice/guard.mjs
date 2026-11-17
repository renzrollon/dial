// Request guard for dial voice. Pure: decides whether a request may be served.

import { randomBytes, timingSafeEqual } from 'node:crypto'

const ROUTES = {
  '/': { method: 'GET', route: 'page' },
  '/page.js': { method: 'GET', route: 'script' },
  '/page-logic.mjs': { method: 'GET', route: 'logic' },
  '/page.css': { method: 'GET', route: 'style' },
  '/events': { method: 'GET', route: 'events', token: 'query' },
  '/turn': { method: 'POST', route: 'turn', token: 'header' },
  '/interrupt': { method: 'POST', route: 'interrupt', token: 'header' },
  '/quit': { method: 'POST', route: 'quit', token: 'header' }
}

/** 32 lowercase hex characters. */
export function newToken() {
  return randomBytes(16).toString('hex')
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

const refuse = (status, reason) => ({ ok: false, status, reason })

/** Checks run in order: Host, path, method, token, Origin, content type. */
export function checkRequest({ method, url, headers }, { port, token }) {
  const h = headers ?? {}
  if (h.host !== `127.0.0.1:${port}`) return refuse(403, 'wrong host')

  const raw = String(url ?? '')
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const query = q === -1 ? '' : raw.slice(q + 1)
  const entry = Object.hasOwn(ROUTES, path) ? ROUTES[path] : null
  if (!entry) return refuse(404, 'not found')
  if (method !== entry.method) return refuse(405, 'method not allowed')

  if (entry.token) {
    const given = entry.token === 'query' ? new URLSearchParams(query).get('t') : h['x-dial-token']
    if (!tokenMatches(given, token)) return refuse(403, 'missing or wrong token')
  }

  if (entry.method === 'POST') {
    if (h.origin !== `http://127.0.0.1:${port}`) return refuse(403, 'wrong origin')
    const type = String(h['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return refuse(415, 'content type must be application/json')
  }
  return { ok: true, route: entry.route }
}
