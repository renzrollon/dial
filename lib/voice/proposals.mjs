/**
 * The one open proposal of the dial voice window and its statuses. State only:
 * no process and no network access, and the expiry runs on the injected timers.
 *
 * Statuses: pending -> read -> starting -> started | failed; pending or read
 * may also end as cancelled, expired or replaced. `open` is the proposal that is
 * pending or read; a starting one is held only until `settle`.
 */

const NONE = { ok: false, reason: 'no such proposal' }
const NOT_READ = 'the proposal was not read aloud; confirm it on screen'

/**
 * @param {{ timers: { setTimeout: Function, clearTimeout: Function }, seconds: number, newId: () => string, on?: (proposal: object) => void }} deps
 */
export function createProposals({ timers, seconds, newId, on }) {
  let open = null
  let starting = null
  let clock = null

  const stopClock = () => {
    if (clock !== null) timers.clearTimeout(clock)
    clock = null
  }
  const emit = proposal => on?.({ ...proposal })
  const close = (proposal, status, reason) => {
    stopClock()
    if (open === proposal) open = null
    if (starting === proposal) starting = null
    proposal.status = status
    if (reason !== undefined) proposal.reason = reason
    emit(proposal)
  }
  const find = id => (open && open.id === id ? open : null)

  return {
    offer({ repo, prompt }) {
      if (open) close(open, 'replaced')
      const proposal = { id: newId(), repo, prompt, status: 'pending' }
      open = proposal
      clock = timers.setTimeout(() => {
        clock = null
        if (open === proposal) close(proposal, 'expired')
      }, seconds * 1000)
      clock?.unref?.()
      emit(proposal)
      return { ...proposal }
    },
    markRead(id) {
      const proposal = find(id)
      if (!proposal || proposal.status !== 'pending') return false
      proposal.status = 'read'
      emit(proposal)
      return true
    },
    check(id, { spoken } = {}) {
      const proposal = find(id)
      if (!proposal) return { ...NONE }
      if (spoken && proposal.status !== 'read') return { ok: false, reason: NOT_READ }
      return { ok: true, proposal: { ...proposal } }
    },
    begin(id) {
      const proposal = find(id)
      if (!proposal) return false
      stopClock()
      open = null
      starting = proposal
      proposal.status = 'starting'
      emit(proposal)
      return true
    },
    settle(id, status, reason) {
      if (!starting || starting.id !== id) return false
      close(starting, status, reason)
      return true
    },
    cancel(id) {
      const proposal = find(id)
      if (!proposal) return { ...NONE }
      close(proposal, 'cancelled')
      return { ok: true }
    },
    get open() {
      return open ? { ...open } : null
    },
    clear() {
      stopClock()
      open = null
    },
  }
}
