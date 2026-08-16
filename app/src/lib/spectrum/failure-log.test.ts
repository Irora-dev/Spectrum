import { beforeEach, describe, expect, it } from 'vitest'
import { FAILURE_LOG_LIMIT, clearFailures, failuresAsText, readFailures, recordFailure } from './failure-log'

// ⚠ THE NODE TEST ENV HAS NO localStorage, so the persistence pins below were
// passing VACUOUSLY (an absent store and a rejected store both read as []).
// A stub makes them discriminate — the whole point of those cases is that a
// user-writable store is hostile input.
const store = new Map<string, string>()
if (!globalThis.localStorage)
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })

const rec = (over: Partial<Parameters<typeof recordFailure>[0]> = {}) => ({
  at: '2026-08-16T00:00:00.000Z',
  surface: 'portfolio run',
  signer: '0xf4e6cCBeA77a070B84Ec182674a52D9b62826554',
  chainId: 4663,
  message: 'leg 1’s route refused',
  ...over,
})

describe('the failure log records without being asked', () => {
  beforeEach(() => clearFailures())

  it('keeps the newest first — the one that just happened is the one you read', () => {
    recordFailure(rec({ message: 'older' }))
    recordFailure(rec({ message: 'newer' }))
    expect(readFailures().map((r) => r.message)).toEqual(['newer', 'older'])
  })

  it('is BOUNDED — an unbounded log in storage is a leak nobody audits', () => {
    for (let i = 0; i < FAILURE_LOG_LIMIT + 10; i++) recordFailure(rec({ message: `m${i}` }))
    expect(readFailures()).toHaveLength(FAILURE_LOG_LIMIT)
    expect(readFailures()[0].message).toBe(`m${FAILURE_LOG_LIMIT + 9}`)
  })

  it('⚠ SURVIVES BIGINTS — the values it exists to capture are the ones JSON.stringify dies on', () => {
    expect(() => recordFailure(rec({ detail: { budgetRaw: 1_196_085_658n, legs: [{ sell: 5n }] } }))).not.toThrow()
    const d = readFailures()[0].detail as { budgetRaw: unknown; legs: { sell: unknown }[] }
    expect(d.budgetRaw).toBe('1196085658')
    expect(d.legs[0].sell).toBe('5')
  })

  it('never throws on hostile or exotic detail — it is called FROM failure paths', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => recordFailure(rec({ detail: cyclic }))).not.toThrow()
    expect(() => recordFailure(rec({ detail: { fn: () => 1, sym: Symbol('x'), un: undefined } }))).not.toThrow()
    expect(readFailures().length).toBeGreaterThan(0)
  })

  it('the signer is captured, because a plan signed by the wrong wallet is invisible in the message', () => {
    recordFailure(rec())
    expect(readFailures()[0].signer).toBe('0xf4e6cCBeA77a070B84Ec182674a52D9b62826554')
  })

  it('a corrupt store yields an empty log, never a crash on a failure surface', () => {
    clearFailures()
    globalThis.localStorage?.setItem('spectrum:failures', '{"not":"an array"}')
    expect(readFailures()).toEqual([])
    globalThis.localStorage?.setItem('spectrum:failures', 'not json at all')
    expect(readFailures()).toEqual([])
  })

  it('rows of the wrong shape are dropped, not trusted', () => {
    clearFailures()
    globalThis.localStorage?.setItem('spectrum:failures', JSON.stringify([{ nope: true }, { message: 'real' }]))
    expect(readFailures().map((r) => r.message)).toEqual(['real'])
  })

  it('produces paste-ready text with no editing required', () => {
    recordFailure(rec({ message: 'the refusal' }))
    const t = failuresAsText()
    expect(t).toContain('the refusal')
    expect(() => JSON.parse(t)).not.toThrow()
  })
})
