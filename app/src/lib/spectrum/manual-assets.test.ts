import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addManualAssets, loadManualAssets, manualAssetsFor, manualSig, subscribeManualAssets } from './manual-assets'

const OWNER = '0x8347Ca89C40b139e8E9b38d82d7B799A3dB68605'
const OTHER = '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function shimStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
  return store
}

describe('manual-assets (the paste-to-add store)', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = shimStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips an add, lowercased and deduped, owner-key case-insensitive', () => {
    addManualAssets(OWNER.toUpperCase(), [
      { chainId: 8453, address: TOKEN_A.toUpperCase().replace('0X', '0x') },
      { chainId: 8453, address: TOKEN_A }, // duplicate — refused
      { chainId: 1, address: TOKEN_A }, // same token, other chain — its own row
    ])
    const rows = loadManualAssets(OWNER.toLowerCase())
    expect(rows.map((r) => `${r.chainId}:${r.address}`)).toEqual([`8453:${TOKEN_A}`, `1:${TOKEN_A}`])
    expect(rows.every((r) => r.addedAt > 0)).toBe(true)
  })

  it('refuses invalid rows quietly: bad addresses, unsupported chains', () => {
    addManualAssets(OWNER, [
      { chainId: 8453, address: '0xnot-an-address' },
      { chainId: 999999, address: TOKEN_A },
      { chainId: 8453, address: TOKEN_B },
    ])
    expect(loadManualAssets(OWNER).map((r) => r.address)).toEqual([TOKEN_B])
  })

  it('a corrupt row is dropped on read; a corrupt STORE reads as empty and heals on write', () => {
    store.set(`spectrum:manual-assets:v1:${OWNER.toLowerCase()}`, '{not json')
    expect(loadManualAssets(OWNER)).toEqual([])
    addManualAssets(OWNER, [{ chainId: 8453, address: TOKEN_A }])
    expect(loadManualAssets(OWNER)).toHaveLength(1)
    // mixed garbage inside an otherwise-valid array: bad rows drop, good rows stay
    store.set(
      `spectrum:manual-assets:v1:${OWNER.toLowerCase()}`,
      JSON.stringify([{ chainId: 8453, address: TOKEN_A, addedAt: 5 }, { nonsense: true }, 42, { chainId: 8453, address: 'xx' }]),
    )
    expect(loadManualAssets(OWNER)).toHaveLength(1)
  })

  it('manualAssetsFor unions the group and dedupes shared rows; manualSig is order-stable', () => {
    addManualAssets(OWNER, [{ chainId: 8453, address: TOKEN_A }])
    addManualAssets(OTHER, [
      { chainId: 8453, address: TOKEN_A }, // both members added the same token
      { chainId: 4663, address: TOKEN_B },
    ])
    const union = manualAssetsFor([OWNER, OTHER])
    expect(union.map((r) => `${r.chainId}:${r.address}`).sort()).toEqual([`4663:${TOKEN_B}`, `8453:${TOKEN_A}`])
    expect(manualSig([OWNER, OTHER])).toBe(manualSig([OTHER, OWNER]))
    expect(manualSig([OWNER, OTHER])).toContain('8453:')
  })

  it('an add wakes subscribers (the sweep re-keys); unsubscribe stops it', () => {
    const woke = vi.fn()
    const off = subscribeManualAssets(woke)
    addManualAssets(OWNER, [{ chainId: 8453, address: TOKEN_A }])
    expect(woke).toHaveBeenCalledTimes(1)
    off()
    addManualAssets(OWNER, [{ chainId: 8453, address: TOKEN_B }])
    expect(woke).toHaveBeenCalledTimes(1)
  })

  it('caps at 100 rows, keeping the newest', () => {
    addManualAssets(
      OWNER,
      Array.from({ length: 110 }, (_, i) => ({ chainId: 8453, address: `0x${String(i).padStart(40, '0')}` })),
    )
    const rows = loadManualAssets(OWNER)
    expect(rows).toHaveLength(100)
    expect(rows[rows.length - 1].address).toBe(`0x${String(109).padStart(40, '0')}`)
  })

  it('storage unavailable: reads empty, writes do not throw', () => {
    vi.unstubAllGlobals()
    expect(loadManualAssets(OWNER)).toEqual([])
    expect(() => addManualAssets(OWNER, [{ chainId: 8453, address: TOKEN_A }])).not.toThrow()
  })
})
