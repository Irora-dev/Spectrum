import { describe, expect, it, vi } from 'vitest'

// ⚠ THE DISTINCTION THIS PINS (audit 2026-08-11, the owner's ruling to fix it):
// a balance read that FAILED used to be written as 0, so a rate-limited RPC
// made a real position vanish from the book — the page said "you hold nothing"
// with exactly the confidence it uses when you genuinely hold nothing. The two
// cases must come out DIFFERENT: a real zero is a balance, a refusal is not an
// answer at all. The second test is the one with teeth — without the fix both
// baskets read 0 and the assertions on `unreadable` fail.

const BASKET_OK = '0x00000000000000000000000000000000000000a1'
const BASKET_DEAD = '0x00000000000000000000000000000000000000b2'
const HOLDER = '0x00000000000000000000000000000000000000ff'

vi.mock('../chain/rpc', () => ({
  clientFor: () => ({
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      // the dead basket refuses every read — an RPC outage, not a zero balance
      if (address.toLowerCase() === BASKET_DEAD) throw new Error('rate limited')
      if (functionName === 'decimals') return 18
      return 0n // the live basket answers: genuinely ZERO held
    },
  }),
  hasPrivateRpc: () => true,
  publicWideLogsRisky: () => false,
}))

describe('getUserHoldings: could-not-read is not zero', () => {
  it('a genuine zero balance is a READ ANSWER — reported, never flagged', async () => {
    const { getUserHoldings } = await import('./basket-data')
    const r = await getUserHoldings(HOLDER as `0x${string}`, [{ address: BASKET_OK, chainId: 8453 }])
    expect(r.balances.get(BASKET_OK)).toBe(0)
    expect(r.unreadable.size).toBe(0)
  })

  it('a REFUSED read is flagged and left out of the balances, not written as 0', async () => {
    const { getUserHoldings } = await import('./basket-data')
    const r = await getUserHoldings(HOLDER as `0x${string}`, [
      { address: BASKET_OK, chainId: 8453 },
      { address: BASKET_DEAD, chainId: 8453 },
    ])
    // the readable one still answers
    expect(r.balances.get(BASKET_OK)).toBe(0)
    // the refused one is ABSENT from balances (a total over it would be a lie)
    expect(r.balances.has(BASKET_DEAD)).toBe(false)
    // …and named, so the page can say the total is a floor
    expect([...r.unreadable]).toEqual([BASKET_DEAD])
  })
})
