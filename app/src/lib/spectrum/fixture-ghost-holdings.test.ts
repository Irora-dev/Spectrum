import { describe, expect, it } from 'vitest'
import { getUserHoldings } from './basket-data'
import { isFixtureBasketAddress } from './dev-fixture'
import { demoSummaries } from './demo-baskets'

// THE GHOST-UNREADABLE FIX (owner report 2026-08-12: "the whole portfolio
// system is bugged"). In fixture mode the directory lists synthetic baskets —
// addresses with no contract on any chain — and a REAL wallet's balance read
// against each of them reverted into `unreadable`, so the connected hero wore
// an amber "37 holdings couldn't be read — this total leaves them out" over a
// $0 book. A synthetic basket is not a chain fact for a real wallet: it must
// leave the read set, not join it as a ghost.

const REAL_WALLET = '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0' as const

describe('fixture baskets never ghost a real wallet’s read', () => {
  it('knows the synthetic catalogue (mocks + demo, case-insensitive) and no real address', () => {
    const demo = demoSummaries(8453)
    expect(demo.length).toBeGreaterThan(0)
    for (const b of demo) {
      expect(isFixtureBasketAddress(b.address)).toBe(true)
      expect(isFixtureBasketAddress(b.address.toUpperCase().replace('0X', '0x'))).toBe(true)
    }
    // a real token address is never claimed as fixture
    expect(isFixtureBasketAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false)
  })

  it('a real account reading a fixture-only list gets a CLEAN empty book — zero unreadable ghosts, zero RPC', async () => {
    // every row is synthetic → after the filter nothing is left to read, so
    // this resolves without touching any network (a revert per row before the
    // fix; 37 ghost "unreadable" rows in the owner's live repro)
    const fixtureList = [8453, 1, 4663].flatMap((chainId) => demoSummaries(chainId))
    expect(fixtureList.length).toBeGreaterThan(0)
    const r = await getUserHoldings(REAL_WALLET, fixtureList.map((b) => ({ address: b.address, chainId: b.chainId })))
    expect(r.balances.size).toBe(0)
    expect(r.unreadable.size).toBe(0)
  })
})
