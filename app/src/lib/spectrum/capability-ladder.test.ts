import { describe, expect, it } from 'vitest'
import {
  ForbiddenFallback,
  resolveLadder,
  submissionReducer,
  type ChainSignatureNeeds,
  type LadderCaps,
  type SubmissionState,
} from './capability-ladder'
import { buildBatchPermit, PERMIT2_ADDRESS, permit2Domain } from './permit2'
import { has2612 } from './known-2612'

const A = (s: string) => `0x${s.padEnd(40, '0')}` as `0x${string}`

const CAPS_NONE: LadderCaps = { atomicBatch: false, permit2: false, permit2Approved: new Set(), funding2612: false }

// the owner's own scenario, one chain of it: 2 sells + ERC-20 funding + batch
const NEEDS: ChainSignatureNeeds = {
  chainId: 1,
  sellApprovals: [
    { token: A('aa'), symbol: 'AAVE', amountRaw: 100n },
    { token: A('bb'), symbol: 'UNI', amountRaw: 200n },
  ],
  fundingApproval: { token: A('cc'), symbol: 'USDC', amountRaw: 300n },
}

describe('resolveLadder — the honest confirm count per rung (readiness §5b)', () => {
  it('rung 1 (atomic): everything is ONE confirm, one tx', () => {
    const r = resolveLadder(NEEDS, { ...CAPS_NONE, atomicBatch: true })
    expect(r.confirmCount).toBe(1)
    expect(r.txCount).toBe(1)
    expect(r.confirms[0].rung).toBe('atomic')
  })

  it('plain floor: N sells + funding + batch, every one a tx', () => {
    const r = resolveLadder(NEEDS, CAPS_NONE)
    expect(r.confirmCount).toBe(4) // 2 approvals + funding approve + batch
    expect(r.txCount).toBe(4)
  })

  it('permit2 collapses the SELLS to one signature; missing one-time grants are stated txs', () => {
    const armed = { ...CAPS_NONE, permit2: true, permit2Approved: new Set([A('aa').toLowerCase()]) }
    const r = resolveLadder(NEEDS, armed)
    // one-time grant for UNI (tx) + sell signature + funding approve (tx) + batch (tx)
    expect(r.confirms.filter((c) => c.kind === 'signature')).toHaveLength(1)
    expect(r.confirms.some((c) => c.label.includes('one-time Permit2 approval for $UNI'))).toBe(true)
    expect(r.txCount).toBe(3)
  })

  it('2612 turns the funding approve into a signature; native funding needs nothing', () => {
    const r = resolveLadder(NEEDS, { ...CAPS_NONE, funding2612: true })
    expect(r.confirms.some((c) => c.rung === '2612' && c.kind === 'signature')).toBe(true)
    expect(r.txCount).toBe(3) // 2 sells + batch
    const native = resolveLadder({ ...NEEDS, fundingApproval: null }, CAPS_NONE)
    expect(native.txCount).toBe(3) // 2 sells + batch, no funding approve at all
  })

  it('buy-only chain on a plain EOA: funding approve + batch = 2 (the table row)', () => {
    const r = resolveLadder({ chainId: 8453, sellApprovals: [], fundingApproval: NEEDS.fundingApproval }, CAPS_NONE)
    expect(r.confirmCount).toBe(2)
  })
})

describe('the safety law — never fall back after an ambiguous submit', () => {
  it('the legal path: attempt → submitted → ambiguous holds → resolved', () => {
    let s: SubmissionState = { phase: 'idle', rung: 1 }
    s = submissionReducer(s, { type: 'attempt' })
    s = submissionReducer(s, { type: 'submitted', submissionId: 'x' })
    s = submissionReducer(s, { type: 'ambiguous-silence' })
    expect(s.phase).toBe('submitted') // held, polling — NOT falling back
    s = submissionReducer(s, { type: 'resolved-success' })
    expect(s.phase).toBe('succeeded')
  })

  it('definitive non-support BEFORE submission moves to the next rung', () => {
    let s: SubmissionState = { phase: 'idle', rung: 1 }
    s = submissionReducer(s, { type: 'attempt' })
    s = submissionReducer(s, { type: 'unsupported-definitive' })
    expect(s).toEqual({ phase: 'idle', rung: 2 })
  })

  it('THE FORBIDDEN MOVE THROWS: no fallback once a submission exists', () => {
    let s: SubmissionState = { phase: 'idle', rung: 1 }
    s = submissionReducer(s, { type: 'attempt' })
    s = submissionReducer(s, { type: 'submitted', submissionId: 'x' })
    expect(() => submissionReducer(s, { type: 'unsupported-definitive' })).toThrow(ForbiddenFallback)
  })

  it('a RESOLVED failure is final on that rung — no auto-retry below', () => {
    let s: SubmissionState = { phase: 'idle', rung: 1 }
    s = submissionReducer(s, { type: 'attempt' })
    s = submissionReducer(s, { type: 'submitted', submissionId: 'x' })
    s = submissionReducer(s, { type: 'resolved-failure', reason: 'reverted' })
    expect(s.phase).toBe('failed')
    expect(() => submissionReducer(s, { type: 'attempt' })).toThrow(ForbiddenFallback)
  })
})

describe('permit2 builders', () => {
  it('domain has NO version field (adding one breaks every signature)', () => {
    const d = permit2Domain(8453)
    expect(d).toEqual({ name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2_ADDRESS })
    expect('version' in d).toBe(false)
  })

  it('builds the exact batch message from recorded raw amounts; refuses empties and zeros', () => {
    const NOW = 1_700_000_000 - 600
    const p = buildBatchPermit({
      chainId: 1,
      permitted: [
        { token: A('aa'), amountRaw: 100n },
        { token: A('bb'), amountRaw: 200n },
      ],
      spender: A('ba7c4e5'),
      nonce: 42n,
      deadlineSec: 1_700_000_000,
      chainNowSec: NOW,
    })
    expect(p.primaryType).toBe('PermitBatchTransferFrom')
    expect(p.message.permitted).toHaveLength(2)
    expect(p.message.deadline).toBe(1_700_000_000n)
    expect(() => buildBatchPermit({ chainId: 1, permitted: [], spender: A('ba'), nonce: 1n, deadlineSec: NOW + 1, chainNowSec: NOW })).toThrow(/empty/)
    expect(() =>
      buildBatchPermit({ chainId: 1, permitted: [{ token: A('aa'), amountRaw: 0n }], spender: A('ba'), nonce: 1n, deadlineSec: NOW + 1, chainNowSec: NOW }),
    ).toThrow(/positive/)
    // audit round: the deadline WINDOW is law — past deadlines and standing-
    // grant-length deadlines both refuse
    expect(() =>
      buildBatchPermit({ chainId: 1, permitted: [{ token: A('aa'), amountRaw: 1n }], spender: A('ba'), nonce: 1n, deadlineSec: NOW, chainNowSec: NOW }),
    ).toThrow(/future deadline/)
    expect(() =>
      buildBatchPermit({ chainId: 1, permitted: [{ token: A('aa'), amountRaw: 1n }], spender: A('ba'), nonce: 1n, deadlineSec: NOW + 86_400, chainNowSec: NOW }),
    ).toThrow(/standing grant/)
  })
})

describe('known-2612 — a list, not a probe', () => {
  it('USDC on Base/ETH qualifies; everything unlisted does not', () => {
    expect(has2612(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true)
    expect(has2612(1, '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48')).toBe(true)
    expect(has2612(8453, '0x4200000000000000000000000000000000000006')).toBe(false) // WETH: no
    expect(has2612(4663, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false) // wrong chain
  })
})

describe('battle-test half-2 pins (2026-08-04)', () => {
  it('P1: the deadline window is bounded by the CHAIN clock — a fast device clock cannot widen it', () => {
    // the finding's case: device two days fast. Against the device clock the
    // window "passes"; against the chain clock it is a standing grant.
    const chainNow = 1_700_000_000
    const deviceNow = chainNow + 172_800 // two days fast
    expect(() =>
      buildBatchPermit({
        chainId: 1,
        permitted: [{ token: A('aa'), amountRaw: 1n }],
        spender: A('ba'),
        nonce: 1n,
        deadlineSec: deviceNow + 1800, // "30 minutes" by the wrong clock
        chainNowSec: chainNow, // the only clock the chain honors
      }),
    ).toThrow(/standing grant/)
  })

  it('P1: a fractional or non-positive chain clock refuses — the bound needs a real second', () => {
    expect(() =>
      buildBatchPermit({ chainId: 1, permitted: [{ token: A('aa'), amountRaw: 1n }], spender: A('ba'), nonce: 1n, deadlineSec: 100, chainNowSec: 0 }),
    ).toThrow(/chain clock/)
  })

  it('finding 6: submitted carries the signer through the reducer', () => {
    const s = submissionReducer(
      submissionReducer({ phase: 'idle', rung: 0 }, { type: 'attempt' }),
      { type: 'submitted', submissionId: 'x', signer: A('cc') },
    )
    expect(s).toMatchObject({ phase: 'submitted', signer: A('cc') })
  })
})

describe('resolveLadder — the non-atomic rungs, structurally (mutation round 3: the model-checked REDUCER shared a file with an untested FUNCTION, and the file inherited a reputation the function never earned)', () => {
  const T1 = '0x1111111111111111111111111111111111111111' as `0x${string}`
  const T2 = '0x2222222222222222222222222222222222222222' as `0x${string}`
  const FUND = '0x3333333333333333333333333333333333333333' as `0x${string}`
  const needsOf = (sells: `0x${string}`[], funding: boolean): ChainSignatureNeeds => ({
    chainId: 8453,
    sellApprovals: sells.map((token, i) => ({ token, symbol: `S${i}`, amountRaw: 100n })),
    fundingApproval: funding ? { token: FUND, symbol: 'USDC', amountRaw: 5n } : null,
  })
  const capsOf = (over: Partial<LadderCaps> = {}): LadderCaps => ({
    atomicBatch: false,
    permit2: false,
    permit2Approved: new Set<string>(),
    funding2612: false,
    ...over,
  })

  it('plain rung: every sell + the funding + the batch are EACH a tx — counts exact, every label names its token', () => {
    const r = resolveLadder(needsOf([T1, T2], true), capsOf())
    expect(r.confirms.map((c) => c.kind)).toEqual(['tx', 'tx', 'tx', 'tx'])
    expect(r.confirmCount).toBe(4)
    expect(r.txCount).toBe(4)
    expect(r.confirms[0].label).toContain('S0')
    expect(r.confirms[1].label).toContain('S1')
    expect(r.confirms[2].label).toContain('USDC')
    expect(r.confirms[3].label).toMatch(/batch/i)
    expect(r.confirms.every((c) => c.label.length > 0)).toBe(true)
  })

  it('permit2 rung: only MISSING grants become one-time txs, ONE signature covers all sells, the batch stays a tx', () => {
    const r = resolveLadder(needsOf([T1, T2], false), capsOf({ permit2: true, permit2Approved: new Set([T1.toLowerCase()]) }))
    expect(r.confirms.map((c) => `${c.kind}:${c.rung}`)).toEqual(['tx:permit2', 'signature:permit2', 'tx:plain'])
    expect(r.txCount).toBe(2)
    expect(r.confirms[0].label).toContain('S1') // the one WITHOUT the grant
    expect(r.confirms[1].label).toMatch(/2 tokens/)
  })

  it('2612 rung: the funding approval is a SIGNATURE on the known-good list and a TX off it', () => {
    const on = resolveLadder(needsOf([], true), capsOf({ funding2612: true }))
    expect(on.confirms.map((c) => `${c.kind}:${c.rung}`)).toEqual(['signature:2612', 'tx:plain'])
    expect(on.txCount).toBe(1)
    expect(on.confirms[0].label).toContain('USDC')
    const off = resolveLadder(needsOf([], true), capsOf())
    expect(off.confirms.map((c) => c.kind)).toEqual(['tx', 'tx'])
    expect(off.txCount).toBe(2)
  })

  it('the singular/plural boundaries hold at exactly one: one sell, one atomic action', () => {
    const one = resolveLadder(needsOf([T1], false), capsOf({ permit2: true }))
    expect(one.confirms.some((c) => /selling 1 token\b/.test(c.label))).toBe(true)
    const atomicOne = resolveLadder(needsOf([], false), capsOf({ atomicBatch: true }))
    expect(atomicOne.confirms[0].label).toBe('1 action, one confirmation')
    const atomicFour = resolveLadder(needsOf([T1, T2], true), capsOf({ atomicBatch: true }))
    expect(atomicFour.confirms[0].label).toBe('4 actions, one confirmation')
  })
})

describe('submissionReducer — the NEGATIVE transition matrix (the model checker proves reachable traces; this pins every guard pairwise, so no mutant can widen the legal table)', () => {
  it('every (state, event) pair outside the legal table THROWS ForbiddenFallback', () => {
    const states: SubmissionState[] = [
      { phase: 'idle', rung: 0 },
      { phase: 'attempting', rung: 0 },
      { phase: 'submitted', rung: 0, submissionId: 'x' },
      { phase: 'succeeded', rung: 0 },
      { phase: 'failed', rung: 0, reason: 'r' },
    ]
    const events = [
      { type: 'attempt' },
      { type: 'unsupported-definitive' },
      { type: 'submitted', submissionId: 'y' },
      { type: 'resolved-success' },
      { type: 'resolved-failure', reason: 'z' },
      { type: 'ambiguous-silence' },
    ] as const
    const LEGAL = new Set([
      'idle:attempt',
      'attempting:unsupported-definitive',
      'attempting:submitted',
      'submitted:ambiguous-silence',
      'submitted:resolved-success',
      'submitted:resolved-failure',
    ])
    for (const s of states) {
      for (const e of events) {
        const key = `${s.phase}:${e.type}`
        if (LEGAL.has(key)) {
          expect(() => submissionReducer(s, e), key).not.toThrow()
        } else {
          expect(() => submissionReducer(s, e), `${key} must be forbidden`).toThrow(ForbiddenFallback)
        }
      }
    }
  })
})

describe('narrow-C side swaps on the ladder (the owner: "if we can batch approvals we should")', () => {
  const A = '0xaaaa000000000000000000000000000000000001' as `0x${string}`
  const B = '0xbbbb000000000000000000000000000000000002' as `0x${string}`
  const FUND = '0xffff000000000000000000000000000000000003' as `0x${string}`
  const caps = (over: Partial<LadderCaps> = {}): LadderCaps => ({
    atomicBatch: false,
    permit2: false,
    permit2Approved: new Set<string>(),
    funding2612: false,
    ...over,
  })
  const needs = (over: Partial<ChainSignatureNeeds> = {}): ChainSignatureNeeds => ({
    chainId: 8453,
    sellApprovals: [],
    fundingApproval: { token: FUND, symbol: 'USDC', amountRaw: 1_000_000n },
    ...over,
  })

  it('ATOMIC: however many assets fall out of 0x coverage, it stays ONE confirmation', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ token: `0x${String(i).repeat(40)}` as `0x${string}`, symbol: `T${i}` }))
    const r = resolveLadder(needs({ sideSwaps: many }), caps({ atomicBatch: true }))
    expect(r.confirmCount).toBe(1)
    expect(r.confirms[0].kind).toBe('bundle')
    // 1 funding approve + 1 batch + 9 buys = 11 actions, one confirmation
    expect(r.confirms[0].label).toMatch(/^11 actions, one confirmation$/)
  })

  it('NON-ATOMIC: each side swap costs ONE transaction, and never a second allowance', () => {
    const base = resolveLadder(needs(), caps())
    const withTwo = resolveLadder(needs({ sideSwaps: [{ token: A, symbol: 'AAA' }, { token: B, symbol: 'BBB' }] }), caps())
    // exactly +2 confirmations for 2 unroutable assets — the funding allowance
    // already counted covers them, because they sell the same funding asset
    expect(withTwo.confirmCount).toBe(base.confirmCount + 2)
    expect(withTwo.confirms.filter((c) => /own transaction/.test(c.label))).toHaveLength(2)
    // and no per-asset approval appeared
    expect(withTwo.confirms.filter((c) => /approve \$AAA|approve \$BBB/.test(c.label))).toHaveLength(0)
  })

  it('ABSENT sideSwaps resolves byte-identically to before the field existed', () => {
    expect(resolveLadder(needs(), caps())).toEqual(resolveLadder(needs({ sideSwaps: [] }), caps()))
  })

  it('AN EMPTY BATCH counts no phantom batch transaction — a real state on a thin chain', () => {
    const r = resolveLadder(needs({ batchIsEmpty: true, sideSwaps: [{ token: A, symbol: 'AAA' }] }), caps())
    expect(r.confirms.some((c) => c.label === 'the batch transaction')).toBe(false)
    // the funding approval + the one side swap, nothing invented
    expect(r.confirmCount).toBe(2)
    const atomic = resolveLadder(needs({ batchIsEmpty: true, sideSwaps: [{ token: A, symbol: 'AAA' }] }), caps({ atomicBatch: true }))
    expect(atomic.confirms[0].label).toMatch(/^2 actions, one confirmation$/)
  })

  it('a hostile symbol cannot restructure a wallet-prompt label', () => {
    const r = resolveLadder(needs({ sideSwaps: [{ token: A, symbol: 'A'.repeat(300) }] }), caps())
    const label = r.confirms.find((c) => /own transaction/.test(c.label))!.label
    expect(label.length).toBeLessThanOrEqual(240)
    expect(/[\r\n]/.test(label)).toBe(false)
  })
})

describe('the honest worst case (review 2026-08-07: stated 1, faced 7)', () => {
  it('the atomic rung carries the figure the designed fallback would face — the same resolution one rung down', () => {
    const needs = {
      chainId: 8453,
      sellApprovals: [
        { token: '0x1000000000000000000000000000000000000001', symbol: 'A' },
        { token: '0x1000000000000000000000000000000000000002', symbol: 'B' },
        { token: '0x1000000000000000000000000000000000000003', symbol: 'C' },
      ],
      fundingApproval: { token: '0x1000000000000000000000000000000000000004', symbol: 'USDC' },
      batchIsEmpty: false,
      sideSwaps: [{ symbol: 'NVDA' }, { symbol: 'TSLA' }],
    } as never
    const atomicCaps = { atomicBatch: true, permit2: false, permit2Approved: new Set<string>(), funding2612: false } as never
    const atomic = resolveLadder(needs, atomicCaps)
    expect(atomic.confirmCount).toBe(1)
    // the fallback resolution: 3 plain approves + funding approve + batch + 2 side swaps = 7
    expect(atomic.worstCaseConfirms).toBe(7)
    // and it IS the one-rung-down figure, by construction — the two cannot drift
    const plain = resolveLadder(needs, { ...(atomicCaps as object), atomicBatch: false } as never)
    expect(atomic.worstCaseConfirms).toBe(plain.confirmCount)
    expect(plain.worstCaseConfirms).toBe(plain.confirmCount)
  })
})
