import { describe, expect, it } from 'vitest'
import { acquisitionRoute, needsSideSwaps, pendingApprovals, sellPathFromNativeVenue, type AcquisitionInput, type ZeroExVerdict } from './acquisition-route'
import { classifyZeroExOutcome } from './zeroex-quote'
import type { PoolVerdict } from './pool-safety'

// THE NARROW-C TIERING (the owner's ruling, PLAN.md §8). Named for the decision
// each case forces, because the copy IS the safety surface here.

const OK: PoolVerdict = { kind: 'ok', pool: {} as never, why: 'dominant WETH pool' }
const ASK: PoolVerdict = { kind: 'ask', reason: 'no-dominant-pool' as never, message: 'Several pools, none decisive.', candidates: [] }
const REFUSE_NO_POOL: PoolVerdict = { kind: 'refuse', reason: 'no-candidates' as never, message: 'We could not find a pool for this token, so there is nothing safe to place into.' }
const REFUSE_BAD_QUOTE: PoolVerdict = {
  kind: 'refuse',
  reason: 'no-recognised-quote-asset' as never,
  message: 'The only pool we found pays out in a token we do not recognise.',
}

const inp = (over: Partial<AcquisitionInput> = {}): AcquisitionInput => ({
  symbol: 'AERO',
  zeroEx: 'routable',
  poolVerdict: OK,
  sellPath: 'confirmed',
  ...over,
})

describe('acquisitionRoute — the aggregator path wins only when nothing outranks it', () => {
  it('a routable asset with a sound screen and a confirmed exit is an ordinary batch leg', () => {
    expect(acquisitionRoute(inp()).via).toBe('batch')
    // pool UNCERTAINTY still yields to the batch: the batch does not use our
    // native route, so an unclear pool is genuinely irrelevant to it
    expect(acquisitionRoute(inp({ poolVerdict: ASK })).via).toBe('batch')
    expect(acquisitionRoute(inp({ poolVerdict: null })).via).toBe('batch')
    expect(acquisitionRoute(inp()).message).toBeNull()
  })
})

describe('narrow C — cleared by our own screen, bought in its own transaction', () => {
  it('no 0x route + screen ok + sellable = a side swap, and the extra cost is STATED', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route' as const }))
    expect(r.via).toBe('side-swap')
    expect(r.message).toMatch(/second signature/i)
    expect(r.message).toMatch(/network fee/i)
  })
})

describe('the ruling’s approval tier — uncertainty the user can own', () => {
  it('an UNINDEXED asset (nothing else wrong) asks for approval and says what it is', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route' as const, poolVerdict: null }))
    expect(r.via).toBe('side-swap-on-approval')
    expect(r).toMatchObject({ approvalSubject: 'unindexed' })
    expect(r.message).toMatch(/new or thinly traded/i)
    expect(r.message).toMatch(/correct token/i)
  })

  it('an UNCLEAR POOL asks for approval and names THAT, not "new or experimental"', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route' as const, poolVerdict: ASK }))
    expect(r).toMatchObject({ via: 'side-swap-on-approval', approvalSubject: 'pool-unclear' })
    expect(r.message).toMatch(/more than one market/i)
    // the wrong sentence would be the generic one — a measured condition must
    // not be described as mere newness
    expect(r.message).not.toMatch(/new or thinly traded/i)
  })

  it('an UNCONFIRMED EXIT asks for approval and names the exit — the risk a buyer least expects', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route', sellPath: 'unconfirmed' }))
    expect(r).toMatchObject({ via: 'side-swap-on-approval', approvalSubject: 'exit-unconfirmed' })
    expect(r.message).toMatch(/could not confirm you would be able to sell/i)
  })

  it('exit uncertainty OUTRANKS pool uncertainty — the graver unknown owns the sentence', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route', poolVerdict: ASK, sellPath: 'unconfirmed' }))
    expect(r).toMatchObject({ approvalSubject: 'exit-unconfirmed' })
  })
})

describe('what approval CANNOT fix — refused, and it says which', () => {
  it('NO WAY OUT is refused outright, not offered for approval', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route', sellPath: 'none' }))
    expect(r.via).toBe('refused')
    expect(r.message).toMatch(/no way out|could not find any way to sell/i)
  })

  it('a structural pool refusal is refused, in pool-safety’s own words', () => {
    for (const v of [REFUSE_NO_POOL, REFUSE_BAD_QUOTE]) {
      const r = acquisitionRoute(inp({ zeroEx: 'no-route', poolVerdict: v }))
      expect(r.via).toBe('refused')
      expect(r.message).toContain(v.message)
    }
  })

  it('a structural refusal OUTRANKS the approval tier — "the user told us to" is not a safety argument', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route', poolVerdict: REFUSE_BAD_QUOTE, sellPath: 'unconfirmed' }))
    expect(r.via).toBe('refused')
  })

  it('a no-exit asset is refused even when its pool screens PERFECTLY — a sound pool is not an exit', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'no-route', poolVerdict: OK, sellPath: 'none' }))
    expect(r.via).toBe('refused')
  })
})

describe('plan-level helpers — the surface says it once, and the runner reads the same list', () => {
  it('needsSideSwaps is true when any leg leaves the batch', () => {
    expect(needsSideSwaps([acquisitionRoute(inp())])).toBe(false)
    expect(needsSideSwaps([acquisitionRoute(inp()), acquisitionRoute(inp({ zeroEx: 'no-route' as const }))])).toBe(true)
    expect(needsSideSwaps([acquisitionRoute(inp({ zeroEx: 'no-route' as const, poolVerdict: null }))])).toBe(true)
    // a refusal is not a side swap: it never executes
    expect(needsSideSwaps([acquisitionRoute(inp({ zeroEx: 'no-route', sellPath: 'none' }))])).toBe(false)
  })

  it('pendingApprovals lists exactly the legs waiting on the user', () => {
    const routes = [
      acquisitionRoute(inp()),
      acquisitionRoute(inp({ zeroEx: 'no-route' as const })),
      acquisitionRoute(inp({ symbol: 'NEW', zeroEx: 'no-route', poolVerdict: null })),
      acquisitionRoute(inp({ symbol: 'DEAD', zeroEx: 'no-route', sellPath: 'none' })),
    ]
    const pending = pendingApprovals(routes)
    expect(pending).toHaveLength(1)
    expect(pending[0].message).toMatch(/\$NEW/)
  })
})

describe('the copy is a money surface — bounded, inert, and it never says "verified"', () => {
  const HOSTILE = ['A'.repeat(300), 'a\nb\rc', 'X‮evil', 'US​DC', '', '   ']
  it('every tier’s sentence survives a deployer-controlled symbol', () => {
    for (const symbol of HOSTILE) {
      for (const over of [
        { zeroEx: 'no-route' as const },
        { zeroEx: 'no-route' as const, poolVerdict: null },
        { zeroEx: 'no-route' as const, poolVerdict: ASK },
        { zeroEx: 'no-route' as const, sellPath: 'unconfirmed' as const },
        { zeroEx: 'no-route' as const, sellPath: 'none' as const },
        { zeroEx: 'no-route' as const, poolVerdict: REFUSE_NO_POOL },
        // the two POLICY-refusal sentences added 2026-08-07
        { zeroEx: 'policy-refused' as const, poolVerdict: null },
        { zeroEx: 'policy-refused' as const },
      ]) {
        const r = acquisitionRoute(inp({ symbol, ...over }))
        if (r.message == null) continue
        expect(r.message.length, 'unbounded sentence').toBeLessThanOrEqual(240)
        expect(/[\u0000-\u001f\u007f-\u009f]/.test(r.message), 'control characters').toBe(false)
        expect(/[‪-‮⁦-⁩]/.test(r.message), 'direction override').toBe(false)
        expect(/[​-‍﻿]/.test(r.message), 'zero-width').toBe(false)
      }
    }
  })

  it('owner-copy rules hold: no em-dashes, never "verified" as a badge', () => {
    for (const over of [
      { zeroEx: 'no-route' as const },
      { zeroEx: 'no-route' as const, poolVerdict: null },
      { zeroEx: 'no-route' as const, poolVerdict: ASK },
      { zeroEx: 'no-route' as const, sellPath: 'unconfirmed' as const },
      { zeroEx: 'no-route' as const, sellPath: 'none' as const },
      { zeroEx: 'policy-refused' as const, poolVerdict: null },
      { zeroEx: 'policy-refused' as const },
    ]) {
      const m = acquisitionRoute(inp(over)).message
      if (m == null) continue
      expect(m).not.toContain('—')
      expect(m.toLowerCase()).not.toContain('verified')
    }
  })
})

describe('THE FULL TRUTH TABLE — every cell, because an ordering bug hides in the cells you did not think to test', () => {
  // The S2 fix was reverted in a pinned tree and the ENTIRE suite stayed green
  // (1553 passing), which means nothing pinned it. This table is that pin.
  const VERDICTS = { ok: OK, ask: ASK, refuse: REFUSE_NO_POOL, null: null } as const
  const SELL = ['confirmed', 'unconfirmed', 'none'] as const
/** All three aggregator answers — the cross-product now includes the POLICY
 *  refusal, which a boolean could not express (SpectrumContracts, 2026-08-07). */
const ZEROEX_STATES = ['routable', 'no-route', 'policy-refused', 'read-failed'] as const
// ⚠ 'read-failed' WAS MISSING AND NOTHING COULD NOTICE (A6 review, 2026-08-07).
// These unions are only ever compared with ===; there is no switch anywhere, so
// `noFallthroughCasesInSwitch` never engages and a new member breaks no build,
// no type and no test. This table calls itself "every cell" and was testing 36
// of 48. The assert below is the only thing that will fail when a FIFTH state
// is added — a comment asking the next person to remember is not a mechanism.
const _exhaustive: Record<ZeroExVerdict, true> = { routable: true, 'no-route': true, 'policy-refused': true, 'read-failed': true }
expect(Object.keys(_exhaustive).sort()).toEqual([...ZEROEX_STATES].sort())

  it('NO EXIT is refused in all 8 cells, aggregator or not', () => {
    for (const zeroEx of ZEROEX_STATES) {
      for (const [, v] of Object.entries(VERDICTS)) {
        const r = acquisitionRoute(inp({ zeroEx, poolVerdict: v, sellPath: 'none' }))
        expect(r.via, `zeroEx=${zeroEx}`).toBe('refused')
      }
    }
  })

  it('AN UNCONFIRMED EXIT never becomes a silent batch leg — the module’s own law', () => {
    for (const zeroEx of ZEROEX_STATES) {
      for (const [name, v] of Object.entries(VERDICTS)) {
        const r = acquisitionRoute(inp({ zeroEx, poolVerdict: v, sellPath: 'unconfirmed' }))
        // a structural pool refusal outranks it (refusing beats warning); every
        // other verdict must reach the approval tier. Never `batch`.
        const expected = name === 'refuse' ? 'refused' : 'side-swap-on-approval'
        expect(r.via, `zeroEx=${zeroEx} pool=${name}`).toBe(expected)
        expect(r.message).toBeTruthy()
      }
    }
  })

  it('A STRUCTURAL POOL REFUSAL is never overridden by aggregator coverage', () => {
    for (const zeroEx of ZEROEX_STATES) {
      for (const sellPath of ['confirmed', 'unconfirmed'] as const) {
        const r = acquisitionRoute(inp({ zeroEx, poolVerdict: REFUSE_NO_POOL, sellPath }))
        expect(['refused', 'side-swap-on-approval']).toContain(r.via)
        expect(r.via, `zeroEx=${zeroEx} sell=${sellPath}`).not.toBe('batch')
      }
    }
  })

  it('NO CELL IS EVER A SILENT PASS: only a sound-screen, confirmed-exit asset gets a null message', () => {
    for (const zeroEx of ZEROEX_STATES) {
      for (const [name, v] of Object.entries(VERDICTS)) {
        for (const sellPath of SELL) {
          const r = acquisitionRoute(inp({ zeroEx, poolVerdict: v, sellPath }))
          if (r.message == null) {
            expect(r.via).toBe('batch')
            expect(sellPath, `${name}/${sellPath}`).toBe('confirmed')
            expect(['ok', 'ask', 'null']).toContain(name)
          }
        }
      }
    }
  })
})


describe('the 0x EQUITY REFUSAL (SpectrumContracts, 2026-08-07) — measured live, not imagined', () => {
  // 0x refuses all 8 tokenized equities on 4663 with HTTP 422 and
  // NOT_AUTHORIZED_FOR_TRADE, while 8 trending tokens quote fine on the same
  // chain/key/funding asset. It is an asset-class deny-list, and the owner ruled
  // that stocks are acquired individually OUTSIDE the batcher.

  it('THE BLANKET-REFUSAL TRAP: a policy refusal must never be read as "no exit"', () => {
    // The dangerous wiring: 0x's refusal is BIDIRECTIONAL, so asking it
    // "can you sell NVDA?" also fails — and mapping that to sellPath 'none'
    // fires the un-overridable first tier and refuses the ENTIRE stock
    // registry. sellPath comes from the native venue, and only from there.
    expect(sellPathFromNativeVenue(true)).toBe('confirmed')
    expect(sellPathFromNativeVenue(false)).toBe('none')
    expect(sellPathFromNativeVenue(null)).toBe('unconfirmed') // warns, never refuses

    // a stock: 0x declines it, its own V4 pool is sound, its exit is real
    const r = acquisitionRoute(inp({ symbol: 'NVDA', zeroEx: 'policy-refused', poolVerdict: OK, sellPath: sellPathFromNativeVenue(true) }))
    expect(r.via).toBe('side-swap') // bought individually, exactly as ruled
    expect(r.message).toBeTruthy()
  })

  it('a policy refusal is NOT called "new or thinly traded" — the wrong-sentence hazard', () => {
    const r = acquisitionRoute(inp({ symbol: 'NVDA', zeroEx: 'policy-refused', poolVerdict: null, sellPath: 'confirmed' }))
    expect(r.via).toBe('side-swap-on-approval')
    expect(r.via === 'side-swap-on-approval' && r.approvalSubject).toBe('aggregator-declines')
    expect(r.message).not.toMatch(/new or thinly traded/)
    expect(r.message).toMatch(/cannot be bought through the exchange/)
    // and the DEPTH refusal keeps its own honest sentence
    const thin = acquisitionRoute(inp({ symbol: 'NEWCOIN', zeroEx: 'no-route', poolVerdict: null, sellPath: 'confirmed' }))
    expect(thin.via === 'side-swap-on-approval' && thin.approvalSubject).toBe('unindexed')
    expect(thin.message).toMatch(/new or thinly traded/)
  })

  it('a real no-exit is STILL refused, whatever 0x said — the first tier is not weakened', () => {
    for (const zeroEx of ['routable', 'no-route', 'policy-refused'] as const) {
      const r = acquisitionRoute(inp({ zeroEx, poolVerdict: OK, sellPath: 'none' }))
      expect(r.via, `zeroEx=${zeroEx}`).toBe('refused')
    }
  })

  it('a structural pool refusal still outranks a policy refusal — approval cannot fix a measured wrong thing', () => {
    const r = acquisitionRoute(inp({ zeroEx: 'policy-refused', poolVerdict: REFUSE_NO_POOL, sellPath: 'confirmed' }))
    expect(r.via).toBe('refused')
  })
})

describe('classifyZeroExOutcome — a policy refusal and a depth refusal are opposite facts', () => {
  it('names the measured 422 shapes as POLICY, in both directions', () => {
    for (const name of ['BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE', 'SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE']) {
      expect(classifyZeroExOutcome({ status: 422, name })).toBe('policy-refused')
      expect(classifyZeroExOutcome({ name })).toBe('policy-refused') // status-less fetchers too
    }
  })
  it('a genuine depth refusal stays no-route', () => {
    expect(classifyZeroExOutcome({ liquidityAvailable: false })).toBe('no-route')
  })
  it('an UNNAMED failure is promoted to neither claim — the read-failed law', () => {
    // ⚠⚠ THIS TEST ASSERTED `no-route` AND WAS WRONG, under a name that
    // described the right law (A6 review, 2026-08-07). 'no-route' IS a claim —
    // acquisition-route renders it as "0x has no route for this asset on this
    // network" — so the old assertion pinned the defect as correct while its
    // title said the opposite. A test can encode the bug; this is the third
    // time that shape has been the finding here.
    for (const raw of [{ status: 500 }, { status: 503, name: 'INTERNAL' }, { status: 429 }]) {
      expect(classifyZeroExOutcome(raw)).toBe('read-failed')
    }
  })

  it('OUR OWN failures are read-failed, never a statement about the market', () => {
    // the proxy's whole error vocabulary: an operator with no key, a refused
    // request, an unreachable upstream, a redirect we refused to follow
    for (const name of [
      'NO_UPSTREAM_KEY',
      'UPSTREAM_UNREACHABLE',
      'UPSTREAM_REDIRECTED',
      'ORIGIN_NOT_ALLOWED',
      'BAD_PROXY_REQUEST',
      'METHOD_NOT_ALLOWED',
      'PROXY_UNPARSEABLE_RESPONSE',
    ]) {
      expect(classifyZeroExOutcome({ status: 503, name }), name).toBe('read-failed')
    }
  })

  it('and a rate limit is read-failed too — an attacker must not be able to make us state a false market fact', () => {
    // burning our quota to a 429 would otherwise tell every user that assets
    // 0x routes fine have no route at all
    expect(classifyZeroExOutcome({ status: 429 })).toBe('read-failed')
  })

  it('the ONE thing that is still a market fact stays no-route', () => {
    expect(classifyZeroExOutcome({ status: 200, liquidityAvailable: false })).toBe('no-route')
  })
  it('a healthy quote is routable', () => {
    expect(classifyZeroExOutcome({ liquidityAvailable: true, buyAmount: '1' })).toBe('routable')
  })
})

describe('MEASURED LIVE, not described — the exact 0x response shapes, 2026-08-07', () => {
  // These four fixtures are what api.0x.org actually returned to a real key on
  // 2026-08-07 (probe: /swap/allowance-holder/price, 0x-version v2, $250 of the
  // 4663 settlement asset). My classifier was first written from
  // SpectrumContracts' WRITTEN REPORT; this pins it against the bytes, so the
  // two cannot drift and a future 0x change shows up as a failing test rather
  // than as silently mis-tiered money. Only response shapes are recorded —
  // status and error name. No key, no full response.
  const MEASURED = {
    equityBuy: { status: 422, name: 'BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE' },
    equitySell: { status: 422, name: 'SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE' },
    ordinaryToken: { status: 200, liquidityAvailable: true, buyAmount: '2595508405491274662783572' },
    majorPair: { status: 200, liquidityAvailable: true, buyAmount: '2899174' },
  }

  it('the equity refusal is POLICY in BOTH directions — the bidirectional claim, re-measured myself', () => {
    // This is the one the whole trap rests on: if the sell direction did NOT
    // refuse, deriving sellPath from 0x would be merely wrong rather than
    // catastrophic. It refuses. Verified against the live API, not inherited.
    expect(classifyZeroExOutcome(MEASURED.equityBuy)).toBe('policy-refused')
    expect(classifyZeroExOutcome(MEASURED.equitySell)).toBe('policy-refused')
  })

  it('the controls are ROUTABLE — same chain, same key, same funding asset', () => {
    // Proves the refusal is the ASSET CLASS and not our credentials or config;
    // without these two rows the 422s would be evidence of nothing.
    expect(classifyZeroExOutcome(MEASURED.ordinaryToken)).toBe('routable')
    expect(classifyZeroExOutcome(MEASURED.majorPair)).toBe('routable')
  })

  it('and a refused equity with a sound native market is still BOUGHT, individually', () => {
    // the end-to-end consequence of the measurement, in one assertion
    const r = acquisitionRoute({
      symbol: 'NVDA',
      zeroEx: classifyZeroExOutcome(MEASURED.equityBuy),
      poolVerdict: OK,
      sellPath: 'confirmed', // established from the native venue, never from 0x
    })
    expect(r.via).toBe('side-swap')
  })
})

describe('THE MISSING-PROXY CASE — absence of a failure is not evidence of a route', () => {
  // Found reviewing my own change. The app calls /api/zerox on its own origin;
  // if that edge function is absent or misrouted, the SPA catch-all
  // (`/*  /index.html  200`) answers with HTML at status **200**. The fetcher
  // cannot parse it, so it yields an essentially EMPTY object with status 200 —
  // and the classifier, which only looked for reasons to say no, said
  // 'routable'. A deployment gap would have promoted every asset to
  // batch-eligible on no quote at all. Fail-open, in the one place I told
  // the owner it failed closed.
  it('an unparseable 200 (the SPA catch-all) is NOT routable', () => {
    expect(classifyZeroExOutcome({ status: 200 })).not.toBe('routable')
    expect(classifyZeroExOutcome({ status: 200, nonJson: true } as never)).not.toBe('routable')
  })
  it('a 200 with NO usable buyAmount is not routable either — routability needs a quote', () => {
    for (const raw of [
      { status: 200, liquidityAvailable: true },
      { status: 200, liquidityAvailable: true, buyAmount: '' },
      { status: 200, liquidityAvailable: true, buyAmount: '0' },
      { status: 200, buyAmount: 'not-a-number' },
    ]) {
      expect(classifyZeroExOutcome(raw), JSON.stringify(raw)).not.toBe('routable')
    }
  })
  it('and a REAL quote is still routable — the bar is positive evidence, not suspicion', () => {
    expect(classifyZeroExOutcome({ status: 200, liquidityAvailable: true, buyAmount: '2595508405491274662783572' })).toBe('routable')
    expect(classifyZeroExOutcome({ liquidityAvailable: true, buyAmount: '1' })).toBe('routable')
  })
})

describe('the corrected classifier — no-route is ONE fact, everything else is a read failure', () => {
  // A6 review: my commit message claimed no-route was reserved for
  // liquidityAvailable===false while the code twenty lines below said
  // otherwise. The old tests could not catch it — they asserted only
  // `.not.toBe('routable')`, which passes for either verdict.
  it('an unusable answer is READ-FAILED, never a market fact', () => {
    for (const raw of [
      { status: 200 },
      { status: 200, liquidityAvailable: true },
      { status: 200, liquidityAvailable: true, buyAmount: '' },
      { status: 200, liquidityAvailable: true, buyAmount: '0' },
      { status: 200, buyAmount: 'not-a-number' },
      { status: 200, buyAmount: 123 as unknown as string }, // a NUMBER, not a string
      { status: 200, buyAmount: '9'.repeat(41) }, // past the bound
    ]) {
      expect(classifyZeroExOutcome(raw), JSON.stringify(raw)).toBe('read-failed')
    }
  })
  it('a numeric buyAmount would otherwise have made EVERY asset routeless', () => {
    // the sharpest case: if 0x ever emits numbers, the old code called it
    // no-route — a global false market claim, for every asset, silently
    expect(classifyZeroExOutcome({ status: 200, liquidityAvailable: true, buyAmount: 5 as unknown as string })).toBe('read-failed')
  })
  it('and the ONE market fact still reads as one', () => {
    expect(classifyZeroExOutcome({ status: 200, liquidityAvailable: false })).toBe('no-route')
  })
  it('a failure that ALSO carries liquidityAvailable:false is a failure, not a market fact', () => {
    // ordering: the failure branches must run before the market fact
    expect(classifyZeroExOutcome({ status: 503, liquidityAvailable: false })).toBe('read-failed')
    expect(classifyZeroExOutcome({ status: 200, liquidityAvailable: false, name: 'NO_UPSTREAM_KEY' })).toBe('read-failed')
  })
})
