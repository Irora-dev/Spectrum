import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissOnboardingInvite,
  hasSeenReveal,
  inviteDismissed,
  markSeenReveal,
  browseWithoutOnboarding,
  shouldGatePortfolio,
  shouldInviteOnboarding,
} from './onboarding-reveal'

const A = '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0'
const B = '0x1111111111111111111111111111111111111111'

// node test env has no window — shim the one member these helpers touch
function shimStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    // the gate's browse escape is SESSION-scoped — same map shape, its own bag
    sessionStorage: {
      getItem: (k: string) => store.get(`session:${k}`) ?? null,
      setItem: (k: string, v: string) => void store.set(`session:${k}`, v),
      removeItem: (k: string) => void store.delete(`session:${k}`),
    },
  })
  return store
}

describe('onboarding-reveal (the per-wallet invite law)', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = shimStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a never-revealed, never-dismissed wallet gets the invite', () => {
    expect(shouldInviteOnboarding(A)).toBe(true)
  })

  it('a revealed wallet is never invited — and the memory is case-insensitive', () => {
    markSeenReveal(A.toUpperCase())
    expect(hasSeenReveal(A.toLowerCase())).toBe(true)
    expect(shouldInviteOnboarding(A)).toBe(false)
    // per-wallet, not per-browser: the other wallet still gets asked
    expect(shouldInviteOnboarding(B)).toBe(true)
  })

  it('dismissal silences the invite for THAT wallet only, without faking a reveal', () => {
    dismissOnboardingInvite(A)
    expect(shouldInviteOnboarding(A)).toBe(false)
    expect(inviteDismissed(A)).toBe(true)
    expect(hasSeenReveal(A)).toBe(false) // dismissed ≠ walked through
    expect(shouldInviteOnboarding(B)).toBe(true)
  })

  it('both lists cap at 20 owners (a wallet-hopping session cannot grow them unbounded)', () => {
    for (let i = 0; i < 25; i++) {
      const addr = `0x${String(i).padStart(40, '0')}`
      markSeenReveal(addr)
      dismissOnboardingInvite(addr)
    }
    const revealed = JSON.parse(store.get('spectrum.onboarding-revealed.v1') ?? '[]') as string[]
    const dismissed = JSON.parse(store.get('spectrum.onboarding-invite-dismissed.v1') ?? '[]') as string[]
    expect(revealed.length).toBe(20)
    expect(dismissed.length).toBe(20)
    // the most recent owner survives the cap
    expect(revealed).toContain(`0x${String(24).padStart(40, '0')}`)
  })

  it('unavailable storage: never invite (no nag loop), never claim a reveal', () => {
    vi.unstubAllGlobals() // no window at all
    expect(hasSeenReveal(A)).toBe(false)
    expect(inviteDismissed(A)).toBe(true)
    expect(shouldInviteOnboarding(A)).toBe(false)
    // and the writers must not throw
    expect(() => markSeenReveal(A)).not.toThrow()
    expect(() => dismissOnboardingInvite(A)).not.toThrow()
  })

  it('corrupted storage rows read as never-revealed but also never-inviting', () => {
    store.set('spectrum.onboarding-revealed.v1', '{not json')
    store.set('spectrum.onboarding-invite-dismissed.v1', '{not json')
    expect(hasSeenReveal(A)).toBe(false)
    expect(shouldInviteOnboarding(A)).toBe(false)
    // a write repairs the row
    markSeenReveal(A)
    expect(hasSeenReveal(A)).toBe(true)
  })

  // ── the full-page gate's render matrix (owner 2026-08-13) ──────────────────
  describe('shouldGatePortfolio (the render matrix — keyed on the OUTCOME)', () => {
    it('gates a connected wallet with an empty book', () => {
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(true)
    })
    it('THE LIMBO CASE (owner 2026-08-13): revealed but the book is still empty — gates anyway', () => {
      // his exact state: the arrival marked the reveal, the ADD never ran.
      // The first cut consulted the reveal and stood down; the outcome key
      // must not.
      markSeenReveal(A)
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(true)
    })
    it('a book with anything in it never gates — the page has something true to show', () => {
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: false, signedIn: false })).toBe(false)
    })
    it('disconnected never gates (ConnectGate owns that face), nor a missing owner', () => {
      expect(shouldGatePortfolio({ connected: false, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(false)
      expect(shouldGatePortfolio({ connected: true, owner: undefined, demo: false, bookEmpty: true, signedIn: false })).toBe(false)
      expect(shouldGatePortfolio({ connected: true, owner: null, demo: false, bookEmpty: true, signedIn: false })).toBe(false)
    })
    it('the demo door never gates (a catalogue, not a wallet)', () => {
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: true, bookEmpty: true, signedIn: false })).toBe(false)
    })
    it('"browse without onboarding" holds for the SESSION, per wallet — and only the session', () => {
      browseWithoutOnboarding(A)
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(false)
      expect(shouldGatePortfolio({ connected: true, owner: B, demo: false, bookEmpty: true, signedIn: false })).toBe(true)
      // a fresh session (new storage) asks again — the limbo can never be permanent
      store.clear()
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(true)
    })
    it('the OLD permanent dismissal row no longer parks a wallet in the limbo', () => {
      dismissOnboardingInvite(A) // the 2026-08-12 plate's localStorage row
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(true)
    })
    it('unavailable storage never gates (no loop a user cannot escape)', () => {
      vi.unstubAllGlobals()
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: false })).toBe(false)
    })
    it('THE LOGIN LATCH (the owner 2026-08-13): a signed-in wallet is never re-gated, even with an empty book', () => {
      // "'log into' your portfolio by signing" — the signature is the login;
      // an empty book after it falls to the page's own empty states (and the
      // page's add-attempted effect closes that seam the moment reads allow).
      expect(shouldGatePortfolio({ connected: true, owner: A, demo: false, bookEmpty: true, signedIn: true })).toBe(false)
      // the latch outranks nothing else: a signed-in DISCONNECTED wallet is
      // still the ConnectGate's face, not this one
      expect(shouldGatePortfolio({ connected: false, owner: A, demo: false, bookEmpty: true, signedIn: true })).toBe(false)
    })
  })
})
