import { describe, expect, it, vi } from 'vitest'
import { preflightLeg, preflightLegs, preflightWords, shouldPreflight } from './leg-preflight'

const leg = (over = {}) => ({ symbol: 'LNOC', asset: '0xAaA', sellAmountRaw: 1_196_085_658n, swapData: '0xab', ...over })

describe('leg pre-flight — ask the chain before calling a plan runnable', () => {
  it('a leg the chain executes is fillable', async () => {
    expect(await preflightLeg(leg(), async () => {})).toEqual({ kind: 'fillable' })
  })

  it('an execution revert is a refusal about THIS leg', async () => {
    const v = await preflightLeg(leg(), async () => { throw new Error('execution reverted: 0x46a14930') })
    expect(v.kind).toBe('refused')
  })

  it('⚠ A TRANSPORT FAILURE IS NOT A MARKET VERDICT — it must never say the asset is untradeable', async () => {
    for (const m of ['fetch failed', 'network error', 'socket hang up', 'ECONNRESET', 'rate limit exceeded', 'HTTP 503', 'HTTP 429']) {
      const v = await preflightLeg(leg(), async () => { throw new Error(m) })
      expect(v.kind).toBe('unknown')
    }
  })

  it('⚠ A SLOW ENDPOINT CANNOT HANG THE REVIEW — it resolves unknown, not never', async () => {
    vi.useFakeTimers()
    const p = preflightLeg(leg(), () => new Promise<void>(() => {}), { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    vi.useRealTimers()
    await expect(p).resolves.toEqual({ kind: 'unknown', why: 'the check did not answer in time' })
  })

  it('unknown NEVER produces user-facing words — only a real refusal speaks', () => {
    expect(preflightWords('LNOC', { kind: 'unknown', why: 'x' })).toBeNull()
    expect(preflightWords('LNOC', { kind: 'fillable' })).toBeNull()
    expect(preflightWords('LNOC', { kind: 'refused', reason: 'r' })).toMatch(/\$LNOC can’t be filled at this size/)
  })

  it('the refusal tells the user what to DO, not just that it failed', () => {
    const w = preflightWords('LNOC', { kind: 'refused', reason: 'r' }) as string
    expect(w).toMatch(/lower this holding|buy it on its own/)
  })

  it('only THIN required legs are probed — a deep major has never failed this way', () => {
    expect(shouldPreflight({ thinMarket: true })).toBe(true)
    expect(shouldPreflight({ thinMarket: false })).toBe(false)
    expect(shouldPreflight({})).toBe(false)
  })

  it('an OPTIONAL leg is not probed — it already fails softly, so the round-trip buys nothing', () => {
    expect(shouldPreflight({ thinMarket: true, optional: true })).toBe(false)
  })

  it('probes several legs and keys verdicts by asset, case-insensitively', async () => {
    const m = await preflightLegs(
      [leg({ asset: '0xAAA' }), leg({ asset: '0xBBB', symbol: 'X' })],
      async ({ asset }) => { if (asset === '0xBBB') throw new Error('execution reverted') },
    )
    expect(m.get('0xaaa')).toEqual({ kind: 'fillable' })
    expect(m.get('0xbbb')?.kind).toBe('refused')
  })

  it('one leg’s failure never takes the others down with it', async () => {
    const m = await preflightLegs(
      [leg({ asset: '0x1' }), leg({ asset: '0x2' }), leg({ asset: '0x3' })],
      async ({ asset }) => { if (asset === '0x2') throw new Error('boom') },
    )
    expect(m.size).toBe(3)
    expect(m.get('0x1')).toEqual({ kind: 'fillable' })
    expect(m.get('0x3')).toEqual({ kind: 'fillable' })
  })

  it('the probe receives the leg’s REAL size and bytes — probing a different trade proves nothing', async () => {
    const seen: unknown[] = []
    await preflightLeg(leg(), async (l) => { seen.push(l) })
    expect(seen[0]).toEqual({ asset: '0xAaA', sellAmountRaw: 1_196_085_658n, swapData: '0xab' })
  })
})
