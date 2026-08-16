import { describe, expect, it } from 'vitest'
import {
  addTarget,
  adoptGuestDraft,
  clearDraft,
  emptyDraft,
  evenSplit,
  GUEST_SCOPE,
  loadDraft,
  MAX_ALLOCATION_ASSETS,
  MAX_PLAUSIBLE_AMOUNT_USD,
  removeTarget,
  saveDraft,
  setAmount,
  setChannel,
  setIntent,
  setSeedPct,
  setTargetWeight,
  type AllocationDraft,
  type StorageLike,
} from './allocation'

// ─────────────────────────────────────────────────────────────────────────────
// THE DRAFT LIFECYCLE, MODEL-TESTED (greenlit exotic path 5) — the submission
// reducer was model-checked exhaustively; the DRAFT's own state machine never
// was, and it is where the poisoned publish+funding draft lived (UIGuy's
// finding: `setIntent` guards TRANSITIONS, but deserialisation is not a
// transition, so the forbidden state walked back in through storage).
//
// Random sequences of real user operations — add, dial, amount, intent,
// channel, save, reload, switch wallet, adopt the guest draft, clear — plus
// deliberate STORAGE CORRUPTION between steps, with the invariants asserted
// after EVERY step:
//   I1. never more than MAX_ALLOCATION_ASSETS targets, never a duplicate key
//   I2. every in-memory weight is finite and non-negative; every LOADED
//       weight is an integer in 1..100 (round 8's storage-boundary law)
//   I3. amountUsd is null or finite-and-plausible — never NaN, never 1e21
//       surviving a reload (the trust boundary's ceiling)
//   I4. THE POISONED STATE IS UNREPRESENTABLE: intent 'publish' and a
//       `funding` block never coexist — not in memory, not after any reload
//   I5. wallet isolation: operations on one address never touch another's
//       stored draft; adopting the guest draft moves it and clears the guest
//   I6. a cleared draft is GONE (loads null), and a reload after save
//       preserves the targets it saved (keys survive the round trip)
// Failures replay by seed. Multi-step bugs live exactly here, and no output
// is ever "expected" — the invariants are the whole assertion.
// ─────────────────────────────────────────────────────────────────────────────

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

class MemStore implements StorageLike {
  m = new Map<string, string>()
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}

const WALLETS = ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', GUEST_SCOPE]
const ASSETS = Array.from({ length: 8 }, (_, i) => ({
  chainId: [1, 8453, 4663][i % 3],
  address: `0x${String(i + 1).repeat(40).slice(0, 40)}`,
  symbol: `T${i}`,
  name: `Token ${i}`,
}))

const HOSTILE_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, -5, 1e21]

/** The poisoned draft and other storage-corruption payloads — every one has
 *  actually been reachable (the publish+funding state persisted until
 *  9523f5c) or arrives free with a shared computer and a paste. */
const CORRUPTIONS = [
  '{{{ not json',
  JSON.stringify({ targets: [{ asset: ASSETS[0], weight: 500 }], amountUsd: 1e21, intent: 'keep' }),
  JSON.stringify({ targets: Array.from({ length: 500 }, () => ({ asset: ASSETS[1], weight: 1 })), amountUsd: 10, intent: 'keep' }),
  // THE POISONED DRAFT: publish + funding together, straight into storage
  JSON.stringify({ targets: [{ asset: ASSETS[2], weight: 100 }], amountUsd: 100, intent: 'publish', funding: { soldUsd: 50 }, seedPct: 900 }),
  JSON.stringify({ targets: [{ asset: ASSETS[3], weight: 1e999 }], amountUsd: 1e999, intent: 'keep' }), // JSON.parse → Infinity
]

function checkInvariants(label: string, draft: AllocationDraft | null, loaded: boolean): string | null {
  if (!draft) return null
  if (draft.targets.length > MAX_ALLOCATION_ASSETS) return `${label}: ${draft.targets.length} targets — I1`
  const keys = draft.targets.map((t) => `${t.asset.chainId}:${t.asset.address.toLowerCase()}`)
  if (new Set(keys).size !== keys.length) return `${label}: duplicate target keys — I1`
  for (const t of draft.targets) {
    if (!Number.isFinite(t.weight) || t.weight < 0) return `${label}: weight ${t.weight} — I2`
    if (loaded && (!Number.isInteger(t.weight) || t.weight < 1 || t.weight > 100)) return `${label}: loaded weight ${t.weight} — I2`
  }
  if (draft.amountUsd !== null) {
    if (!Number.isFinite(draft.amountUsd)) return `${label}: amountUsd ${draft.amountUsd} — I3`
    if (loaded && (draft.amountUsd < 0 || draft.amountUsd > MAX_PLAUSIBLE_AMOUNT_USD)) return `${label}: loaded amountUsd ${draft.amountUsd} — I3`
  }
  if (draft.intent === 'publish' && draft.funding) return `${label}: publish+funding coexist — I4 (the poisoned draft)`
  if (loaded && draft.seedPct != null && (draft.seedPct < 1 || draft.seedPct > 100)) return `${label}: loaded seedPct ${draft.seedPct}`
  return null
}

describe('the draft lifecycle under random operation sequences (2,000 runs × ~24 steps)', () => {
  it('holds every invariant after every step, whatever the order, whatever storage held', () => {
    const violations: string[] = []
    for (let seed = 1; seed <= 2_000 && violations.length < 5; seed++) {
      const rnd = lcg(seed * 7919)
      const store = new MemStore()
      let addr = WALLETS[Math.floor(rnd() * WALLETS.length)]
      let draft = emptyDraft(1_700_000_000_000)
      let loaded = false
      const steps = 8 + Math.floor(rnd() * 16)
      for (let step = 0; step < steps; step++) {
        const now = 1_700_000_000_000 + step * 1000
        const othersBefore = WALLETS.filter((w) => w !== addr).map((w) => store.getItem(`spectrum:draft:${w}`) ?? store.m.get([...store.m.keys()].find((k) => k.includes(w)) ?? '') ?? null)
        const op = Math.floor(rnd() * 12)
        const label = `seed ${seed} step ${step} op ${op}`
        switch (op) {
          case 0:
            draft = addTarget(draft, ASSETS[Math.floor(rnd() * ASSETS.length)], now)
            loaded = false
            break
          case 1:
            if (draft.targets.length) draft = removeTarget(draft, draft.targets[Math.floor(rnd() * draft.targets.length)].asset, now)
            loaded = false
            break
          case 2: {
            if (draft.targets.length) {
              const w = rnd() > 0.2 ? Math.floor(rnd() * 120) : HOSTILE_NUMBERS[Math.floor(rnd() * HOSTILE_NUMBERS.length)]
              draft = setTargetWeight(draft, draft.targets[Math.floor(rnd() * draft.targets.length)].asset, w, now)
              loaded = false
            }
            break
          }
          case 3: {
            const a = rnd() > 0.25 ? Math.floor(rnd() * 100_000) : rnd() > 0.5 ? null : HOSTILE_NUMBERS[Math.floor(rnd() * HOSTILE_NUMBERS.length)]
            draft = setAmount(draft, a as number | null, now)
            loaded = false
            break
          }
          case 4:
            draft = setIntent(draft, rnd() > 0.5 ? 'publish' : 'keep', now)
            loaded = false
            break
          case 5:
            draft = setChannel(draft, (['market', 'limit', 'slices'] as const)[Math.floor(rnd() * 3)], now)
            loaded = false
            break
          case 6:
            draft = evenSplit(draft, now)
            loaded = false
            break
          case 7:
            draft = setSeedPct(draft, rnd() > 0.3 ? Math.floor(rnd() * 120) : (HOSTILE_NUMBERS[Math.floor(rnd() * HOSTILE_NUMBERS.length)] as number), now)
            loaded = false
            break
          case 8:
            saveDraft(addr, draft, store)
            break
          case 9: {
            const back = loadDraft(addr, store)
            if (back) {
              draft = back
              loaded = true
            }
            break
          }
          case 10: {
            // switch wallet (possibly to the guest scope), or adopt the guest
            if (rnd() > 0.5 && addr !== GUEST_SCOPE) {
              adoptGuestDraft(addr, store)
              const adopted = loadDraft(addr, store)
              if (adopted) {
                draft = adopted
                loaded = true
              }
              const guestLeft = loadDraft(GUEST_SCOPE, store)
              if (guestLeft) violations.push(`${label}: guest draft survived adoption — I5`)
            } else {
              addr = WALLETS[Math.floor(rnd() * WALLETS.length)]
              const mine = loadDraft(addr, store)
              draft = mine ?? emptyDraft(now)
              loaded = mine != null
            }
            break
          }
          case 11: {
            // corrupt THIS wallet's stored draft, then reload through the boundary
            const key = [...store.m.keys()].find((k) => k.toLowerCase().includes(addr.toLowerCase())) ?? `spectrum:draft:${addr}`
            store.setItem(key, CORRUPTIONS[Math.floor(rnd() * CORRUPTIONS.length)])
            const back = loadDraft(addr, store)
            if (back) {
              draft = back
              loaded = true
            } else {
              draft = emptyDraft(now)
              loaded = false
            }
            break
          }
        }
        const v = checkInvariants(label, draft, loaded)
        if (v) violations.push(v)
        // I5 — other wallets' stored bytes never move on my operations
        const othersAfter = WALLETS.filter((w) => w !== addr).map((w) => store.getItem(`spectrum:draft:${w}`) ?? store.m.get([...store.m.keys()].find((k) => k.includes(w)) ?? '') ?? null)
        if (op !== 10 && JSON.stringify(othersBefore) !== JSON.stringify(othersAfter))
          violations.push(`${label}: another wallet's stored draft changed — I5`)
      }
      // end of sequence: clear must actually clear
      clearDraft(addr, store)
      if (loadDraft(addr, store) !== null) violations.push(`seed ${seed}: draft survived clearDraft — I6`)
    }
    expect(violations, violations.slice(0, 5).join(' | ')).toEqual([])
  }, 30_000)

  it('the poisoned draft is dead at BOTH gates: setIntent refuses the transition, loadDraft refuses the deserialisation', () => {
    const store = new MemStore()
    // gate 1: the transition — a rebalance draft cannot flip to publish
    let draft = emptyDraft(1_700_000_000_000)
    draft = addTarget(draft, ASSETS[0], 1_700_000_000_001)
    draft = { ...draft, funding: { soldUsd: 100 } }
    const flipped = setIntent(draft, 'publish', 1_700_000_000_002)
    expect(flipped.intent).toBe('keep')
    // gate 2: the boundary — a stored publish+funding draft loads DE-POISONED
    saveDraft('0xcccccccccccccccccccccccccccccccccccccccc', { ...draft, intent: 'publish' as const }, store)
    const back = loadDraft('0xcccccccccccccccccccccccccccccccccccccccc', store)
    expect(back).toBeTruthy()
    expect(back!.intent === 'publish' && back!.funding != null).toBe(false)
  })
})
