import { describe, expect, it } from 'vitest'
import { clearLandedLanes, loadLandedLanes, recordLandedLane, setLandedDeployer } from './landed-lanes'

function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

const ADDR = '0x00000000000000000000000000000000000000a1' as const

describe('landed-lanes: the ceremony memory survives what a useRef cannot', () => {
  it('round-trips a landed lane (the reload case the audit named)', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    const row = loadLandedLanes(s)
    expect(row?.name).toBe('AI Supercycle')
    expect(row?.lanes).toEqual([{ chainId: 8453, newAddress: ADDR }])
  })

  it('a confirmed-but-unread lane persists as null — DONE, never retried', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 4663, newAddress: null }, undefined, s)
    expect(loadLandedLanes(s)?.lanes).toEqual([{ chainId: 4663, newAddress: null }])
  })

  it('re-recording a chain replaces its lane rather than duplicating it', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: null }, undefined, s)
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    expect(loadLandedLanes(s)?.lanes).toEqual([{ chainId: 8453, newAddress: ADDR }])
  })

  it('a different shipped name replaces the row — one in-flight bundle at a time', () => {
    const s = memStorage()
    recordLandedLane('First Idea', { chainId: 8453, newAddress: ADDR }, undefined, s)
    recordLandedLane('Second Idea', { chainId: 1, newAddress: null }, undefined, s)
    const row = loadLandedLanes(s)
    expect(row?.name).toBe('Second Idea')
    expect(row?.lanes).toEqual([{ chainId: 1, newAddress: null }])
  })

  it('clear removes the row (the publish-complete case)', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    clearLandedLanes(s)
    expect(loadLandedLanes(s)).toBeNull()
  })

  it('a corrupt row reads as no memory, never a throw', () => {
    const s = memStorage()
    s.setItem('spectrum:landed-lanes:v1', '{"name":42,"lanes":"nope"}')
    expect(loadLandedLanes(s)).toBeNull()
    s.setItem('spectrum:landed-lanes:v1', 'not json')
    expect(loadLandedLanes(s)).toBeNull()
  })

  it('a malformed lane is dropped while valid siblings survive', () => {
    const s = memStorage()
    s.setItem(
      'spectrum:landed-lanes:v1',
      JSON.stringify({ name: 'X', lanes: [{ chainId: 8453, newAddress: ADDR }, { chainId: 'bad', newAddress: 7 }], savedAt: 1 }),
    )
    expect(loadLandedLanes(s)?.lanes).toEqual([{ chainId: 8453, newAddress: ADDR }])
  })
})

// ── the deployer anchor (the owner 2026-08-13: a mid-run wallet swap deployed one
//    leg from a second wallet, fragmenting the bundle) ─────────────────────────

const WALLET_A = '0x000000000000000000000000000000000000aaaa' as const
const WALLET_B = '0x000000000000000000000000000000000000bbbb' as const

describe('landed-lanes: the row remembers WHO deployed it', () => {
  it('anchors the row to the first landed lane’s wallet', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    setLandedDeployer('AI Supercycle', WALLET_A, s)
    expect(loadLandedLanes(s)?.deployer).toBe(WALLET_A)
  })

  it('is WRITE-ONCE — a second wallet can never move the anchor', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    setLandedDeployer('AI Supercycle', WALLET_A, s)
    setLandedDeployer('AI Supercycle', WALLET_B, s)
    expect(loadLandedLanes(s)?.deployer).toBe(WALLET_A)
  })

  it('a later lane recorded under the same name keeps the anchor', () => {
    const s = memStorage()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    setLandedDeployer('AI Supercycle', WALLET_A, s)
    recordLandedLane('AI Supercycle', { chainId: 1, newAddress: null }, undefined, s)
    const row = loadLandedLanes(s)
    expect(row?.deployer).toBe(WALLET_A)
    expect(row?.lanes).toHaveLength(2)
  })

  it('a NEW bundle starts unanchored — the old wallet does not bind it', () => {
    const s = memStorage()
    recordLandedLane('First Idea', { chainId: 8453, newAddress: ADDR }, undefined, s)
    setLandedDeployer('First Idea', WALLET_A, s)
    recordLandedLane('Second Idea', { chainId: 1, newAddress: null }, undefined, s)
    expect(loadLandedLanes(s)?.deployer).toBeNull()
  })

  it('refuses to anchor a name that has no row, and ignores a non-address', () => {
    const s = memStorage()
    setLandedDeployer('Nothing Landed', WALLET_A, s)
    expect(loadLandedLanes(s)).toBeNull()
    recordLandedLane('AI Supercycle', { chainId: 8453, newAddress: ADDR }, undefined, s)
    setLandedDeployer('AI Supercycle', 'not-an-address', s)
    setLandedDeployer('Other Name', WALLET_B, s)
    expect(loadLandedLanes(s)?.deployer).toBeNull()
  })

  it('a pre-anchor row (written before the field existed) reads as UNBOUND, never fabricated', () => {
    const s = memStorage()
    s.setItem(
      'spectrum:landed-lanes:v1',
      JSON.stringify({ name: 'Legacy', lanes: [{ chainId: 8453, newAddress: ADDR }], savedAt: 1 }),
    )
    expect(loadLandedLanes(s)?.deployer).toBeNull()
    // …and a garbage deployer is treated the same way
    s.setItem(
      'spectrum:landed-lanes:v1',
      JSON.stringify({ name: 'Legacy', deployer: 'nope', lanes: [{ chainId: 8453, newAddress: ADDR }], savedAt: 1 }),
    )
    expect(loadLandedLanes(s)?.deployer).toBeNull()
  })
})
