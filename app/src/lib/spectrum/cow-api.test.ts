import { describe, expect, it } from 'vitest'
import {
  cancelCowOrders,
  describeCowError,
  fetchCowOrder,
  fetchCowQuote,
  postCowOrder,
  type FetchLike,
} from './cow-api'
import { buildLimitOrder } from './cow'

const OWNER = '0x182e54f8011cb15887764E6D4a658cD9b96c8d8F' as const
const WETH = '0x4200000000000000000000000000000000000006' as const
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const APP: `0x${string}` = `0x${'00'.repeat(32)}`

const reply = (status: number, body: unknown): FetchLike => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const dead: FetchLike = async () => {
  throw new TypeError('Failed to fetch')
}

const quoteArgs = { sellToken: WETH, buyToken: USDC, owner: OWNER, sellAmountRaw: 10n ** 18n, appData: APP }
const order = buildLimitOrder({
  sellToken: WETH,
  buyToken: USDC,
  owner: OWNER,
  sellAmountRaw: 10n ** 18n,
  minBuyAmountRaw: 4000_000000n,
  validForSec: 3600,
  nowSec: 1_780_000_000,
  appData: APP,
})

describe('cow-api: quotes', () => {
  it('reads the price out of a good reply', async () => {
    const r = await fetchCowQuote(8453, quoteArgs, {
      fetchImpl: reply(200, { quote: { buyAmount: '186706786', sellAmount: '999973950000000000', feeAmount: '26050000000' } }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.buyAmountRaw).toBe(186706786n)
      expect(r.value.feeAmountRaw).toBe(26050000000n)
    }
  })

  it('treats a priceless 200 as unreadable rather than as a zero price', async () => {
    const r = await fetchCowQuote(8453, quoteArgs, { fetchImpl: reply(200, { quote: {} }) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('unreachable')
  })
})

// THE RULE THIS FILE EXISTS FOR. "The network did not answer" and "the protocol
// says no" are different facts, and a rebalance that reports "no route" when the
// wifi dropped is a lie that makes people abandon a position.
describe('cow-api: a failed call is NOT a verdict', () => {
  it('calls a network failure unreachable, never rejected', async () => {
    const r = await fetchCowQuote(8453, quoteArgs, { fetchImpl: dead })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('unreachable')
  })

  it('calls a 5xx with no errorType unreachable — the SERVICE failed, the protocol did not refuse', async () => {
    const r = await fetchCowQuote(8453, quoteArgs, { fetchImpl: reply(503, {}) })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('unreachable')
      expect(r.message).toMatch(/503/)
    }
  })

  it('DOES call a real protocol refusal rejected', async () => {
    const r = await fetchCowQuote(8453, quoteArgs, {
      fetchImpl: reply(400, { errorType: 'NoLiquidity', description: 'no route found' }),
    })
    expect(r.ok).toBe(false)
    // Narrow on `kind`, not just on `ok` — the false branch still holds the
    // unreachable variant, which deliberately carries no errorType.
    if (!r.ok && r.kind === 'rejected') {
      expect(r.errorType).toBe('NoLiquidity')
    } else {
      throw new Error('expected a protocol refusal')
    }
  })
})

// The 0x90bfb865 lesson: our fallback once asserted a cause it had guessed and
// sent a real user hunting a minimum they had already cleared — and a unit test
// pinned the guess. An unknown code must be quoted, never interpreted.
describe('cow-api: never assert a cause we did not read', () => {
  it('gives a human sentence for codes we actually know', () => {
    expect(describeCowError('NoLiquidity')).toMatch(/no route/i)
    expect(describeCowError('InsufficientAllowance')).toMatch(/approv/i)
  })

  it('QUOTES an unknown code rather than inventing a reason for it', () => {
    const s = describeCowError('SomeBrandNewCode', 'the backend said something specific')
    expect(s).toContain('the backend said something specific')
    expect(s).toMatch(/refused/i)
  })

  it('names the raw code when there is no description at all', () => {
    expect(describeCowError('WeirdCode')).toContain('WeirdCode')
  })

  it('never claims a minimum, a balance or a price as the cause of an unknown error', () => {
    const s = describeCowError('MysteryFailure')
    expect(s).not.toMatch(/minimum|balance|slippage|price too/i)
  })
})

describe('cow-api: posting an order', () => {
  it('returns the uid from a bare-string reply', async () => {
    const r = await postCowOrder(8453, order, OWNER, `0x${'ab'.repeat(65)}`, { fetchImpl: reply(201, '"0xUID"') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('0xUID')
  })

  it('does not report success when no id came back', async () => {
    const r = await postCowOrder(8453, order, OWNER, `0x${'ab'.repeat(65)}`, { fetchImpl: reply(201, {}) })
    expect(r.ok).toBe(false)
  })

  it('surfaces a duplicate as a refusal, not a crash', async () => {
    const r = await postCowOrder(8453, order, OWNER, `0x${'ab'.repeat(65)}`, {
      fetchImpl: reply(400, { errorType: 'DuplicatedOrder' }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/already live/i)
  })
})

describe('cow-api: order state', () => {
  it('prefers the fee-EXCLUSIVE executed amount for progress', async () => {
    const r = await fetchCowOrder(8453, '0xUID', {
      fetchImpl: reply(200, {
        status: 'open',
        sellAmount: '1000',
        executedSellAmount: '520',
        executedSellAmountBeforeFees: '500',
        executedBuyAmount: '2000',
      }),
    })
    expect(r.ok).toBe(true)
    // 520 includes fees and would overstate how much of the user's order is done.
    if (r.ok) expect(r.value.executedSellRaw).toBe(500n)
  })

  it('falls back to the fee-inclusive figure when the other is absent', async () => {
    const r = await fetchCowOrder(8453, '0xUID', {
      fetchImpl: reply(200, { status: 'fulfilled', sellAmount: '1000', executedSellAmount: '1000' }),
    })
    if (r.ok) expect(r.value.executedSellRaw).toBe(1000n)
  })

  it('reports an untouched order as zero progress, not as an error', async () => {
    const r = await fetchCowOrder(8453, '0xUID', { fetchImpl: reply(200, { status: 'open', sellAmount: '1000' }) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.executedSellRaw).toBe(0n)
      expect(r.value.status).toBe('open')
    }
  })
})

describe('cow-api: cancellation', () => {
  it('succeeds on a 200 with an empty body', async () => {
    const r = await cancelCowOrders(8453, ['0xUID'], '0xsig', { fetchImpl: reply(200, '') })
    expect(r.ok).toBe(true)
  })

  it('reports a refusal instead of silently claiming the order is gone', async () => {
    const r = await cancelCowOrders(8453, ['0xUID'], '0xsig', {
      fetchImpl: reply(400, { errorType: 'OrderNotFound', description: 'already settled' }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('already settled')
  })

  it('does not claim success when the network never answered', async () => {
    const r = await cancelCowOrders(8453, ['0xUID'], '0xsig', { fetchImpl: dead })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('unreachable')
  })
})
