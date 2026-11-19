/**
 * The one open proposal of the dial voice window and its statuses. State only:
 * no process and no network access, and the expiry runs on the injected timers.
 *
 * Statuses: pending -> read -> starting -> started | failed; pending or read
 * may also end as cancelled, expired or replaced. `open` is the proposal that is
 * pending or read; a starting one is held only until `settle`. A pending or read proposal also holds `seconds`
 * and `secondsLeft` (whole seconds, rounded up), computed from `now` when it is passed to `on` or read through `open`.
 */

const NONE = { ok: false, reason: 'no such proposal' }
const NOT_READ = 'the proposal was not read aloud; confirm it on screen'

/**
 * @param {{ timers: { setTimeout: Function, clearTimeout: Function }, seconds: number, newId: () => string, on?: (proposal: object) => void, now?: () => number }} deps
 */
export function createProposals({ timers, seconds, newId, on, now = Date.now }) {
  let open = null
  // When each proposal became open, in the milliseconds `now` gave; kept out of the proposal itself.
  const openedAt = new Map()
  // Every proposal that is starting, by id: a second start never takes the first one's place.
  const starting = new Map()
  // Each proposal holds its own expiry clock, so closing one never stops another's.
  const clocks = new Map()

  const stopClock = proposal => {
    const clock = clocks.get(proposal)
    if (clock === undefined) return
    clocks.delete(proposal)
    if (clock !== null) timers.clearTimeout(clock)
  }
  // A copy of the proposal; one that is pending or read also holds its time.
  const view = proposal => {
    const copy = { ...proposal }
    if (proposal.status === 'pending' || proposal.status === 'read') {
      const left = Math.ceil((openedAt.get(proposal) + seconds * 1000 - now()) / 1000)
      copy.seconds = seconds
      copy.secondsLeft = Math.min(seconds, Math.max(0, left))
    }
    return copy
  }
  const emit = proposal => on?.(view(proposal))
  const close = (proposal, status, reason) => {
    stopClock(proposal)
    if (open === proposal) open = null
    if (starting.get(proposal.id) === proposal) starting.delete(proposal.id)
    proposal.status = status
    if (reason !== undefined) proposal.reason = reason
    emit(proposal)
    openedAt.delete(proposal)
  }
  const find = id => (open && open.id === id ? open : null)

  return {
    offer({ repo, prompt }) {
      if (open) close(open, 'replaced')
      const proposal = { id: newId(), repo, prompt, status: 'pending' }
      open = proposal
      openedAt.set(proposal, now())
      const clock = timers.setTimeout(() => {
        clocks.delete(proposal)
        if (open === proposal) close(proposal, 'expired')
      }, seconds * 1000)
      clock?.unref?.()
      clocks.set(proposal, clock ?? null)
      emit(proposal)
      return view(proposal)
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
      return { ok: true, proposal: view(proposal) }
    },
    begin(id) {
      const proposal = find(id)
      if (!proposal) return false
      stopClock(proposal)
      open = null
      starting.set(proposal.id, proposal)
      proposal.status = 'starting'
      emit(proposal)
      openedAt.delete(proposal)
      return true
    },
    settle(id, status, reason) {
      const proposal = starting.get(id)
      if (!proposal) return false
      close(proposal, status, reason)
      return true
    },
    cancel(id) {
      const proposal = find(id)
      if (!proposal) return { ...NONE }
      close(proposal, 'cancelled')
      return { ok: true }
    },
    get open() {
      return open ? view(open) : null
    },
    clear() {
      if (open) stopClock(open)
      if (open) openedAt.delete(open)
      open = null
    },
  }
}
