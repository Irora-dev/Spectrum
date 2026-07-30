import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'

// The store reads window.localStorage at module load — stub a Map-backed fake
// and import fresh per test so persistence is exercised for real.
function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

const TX = ('0x' + 'ab'.repeat(32)) as Hex
// Lowercase on purpose: viem's isAddress is checksum-strict on mixed case, and
// the store must accept what wagmi hands it (checksummed or lowercase).
const HOLDER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const row = () => ({
  txHash: TX,
  fromChainId: 1,
  toChainId: 4663,
  holder: HOLDER as `0x${string}`,
  fromSymbol: 'ETH',
  fromAmountRaw: 100000000000000000n,
  fromDecimals: 18,
  quotedToAmountRaw: 250_000_000n,
  startedAt: 1_753_800_000_000,
})

/** The stored (JSON-safe) shape of row() — bigints as strings. */
const storedRow = () => ({
  ...row(),
  fromAmountRaw: '100000000000000000',
  quotedToAmountRaw: '250000000',
})

async function freshStore(storage = fakeStorage()) {
  vi.resetModules()
  vi.stubGlobal('window', { localStorage: storage })
  const mod = await import('./bridge-pending')
  return { mod, storage }
}

beforeEach(() => vi.unstubAllGlobals())

describe('bridge-pending persisted store (localStorage is hostile input)', () => {
  it('add → reload round-trips, bigints included', async () => {
    const storage = fakeStorage()
    const a = await freshStore(storage)
    a.mod.addBridge(row())
    const b = await freshStore(storage) // a "reload": fresh module, same storage
    expect(b.mod.bridgeRows()).toHaveLength(1)
    expect(b.mod.bridgeRows()[0].fromAmountRaw).toBe(100000000000000000n)
    expect(b.mod.bridgeRows()[0].resolved).toBeUndefined()
  })

  it('a resolved done state (the ARRIVED amount) survives reload', async () => {
    const storage = fakeStorage()
    const a = await freshStore(storage)
    a.mod.addBridge({ ...row(), resolved: { state: 'done', toAmount: 249_100_000n } })
    const b = await freshStore(storage)
    expect(b.mod.bridgeRows()[0].resolved).toEqual({ state: 'done', toAmount: 249_100_000n })
  })

  it('forged/garbage rows are dropped on load, never guessed', async () => {
    const storage = fakeStorage()
    storage.setItem(
      'spectrum:bridge-pending',
      JSON.stringify([
        { txHash: 'not-a-hash', holder: HOLDER, fromChainId: 1, toChainId: 2, fromSymbol: 'X', fromDecimals: 18, startedAt: 1 },
        { ...storedRow(), holder: 'nope' },
        { ...storedRow(), fromSymbol: '' },
        'garbage',
        storedRow(), // the one valid row
      ]),
    )
    const { mod } = await freshStore(storage)
    expect(mod.bridgeRows()).toHaveLength(1)
    expect(mod.bridgeRows()[0].fromAmountRaw).toBe(100000000000000000n)
  })

  it('dismiss removes and persists the removal', async () => {
    const storage = fakeStorage()
    const a = await freshStore(storage)
    a.mod.addBridge(row())
    a.mod.dismissBridge(TX)
    expect(a.mod.bridgeRows()).toHaveLength(0)
    const b = await freshStore(storage)
    expect(b.mod.bridgeRows()).toHaveLength(0)
  })
})
