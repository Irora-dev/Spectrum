import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetPermit2PresenceForTests,
  knownSpenders,
  readStandingApprovals,
  revokeCall,
  type StandingApproval,
} from './allowances'
import { PERMIT2_ADDRESS } from './permit2'

const A = (s: string) => `0x${s.padEnd(40, '0')}` as `0x${string}`

beforeEach(() => __resetPermit2PresenceForTests())

function mockClient(handlers: {
  erc20?: (token: string, spender: string) => bigint | Error
  p2?: (token: string, spender: string) => [bigint, number, number] | Error
  /** Permit2 presence: bytecode ('0x60…'), absent ('0x'), or an Error (probe
   *  unreadable). Defaults to deployed — the pre-probe tests' implicit world. */
  code?: () => string | Error
}) {
  return {
    getCode: async () => {
      const r = handlers.code?.() ?? '0x6080'
      if (r instanceof Error) throw r
      return r
    },
    readContract: async (args: { address: string; functionName: string; args: readonly unknown[] }) => {
      if (args.address.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
        const r = handlers.p2?.(String(args.args[1]), String(args.args[2]))
        if (r instanceof Error) throw r
        return r ?? [0n, 0, 0]
      }
      const r = handlers.erc20?.(args.address, String(args.args[1]))
      if (r instanceof Error) throw r
      return r ?? 0n
    },
  } as never
}

describe('the approvals ledger', () => {
  it('registry: Permit2 everywhere; CoW relayer only where limit settles; LiFi where probed', () => {
    expect(knownSpenders(8453).map((s) => s.label).filter((l) => l !== 'Spectrum router')).toEqual(['Permit2', 'CoW vault relayer', 'LI.FI'])
    expect(knownSpenders(4663).map((s) => s.label).filter((l) => l !== 'Spectrum router')).toEqual(['Permit2', 'LI.FI'])
  })

  it('reads standing grants, flags infinite, keeps live permit2 sub-grants with expiry', async () => {
    const now = 1_700_000_000
    const { rows, failed } = await readStandingApprovals(
      mockClient({
        erc20: (_t, spender) => (spender.toLowerCase().startsWith('0x1231') ? 2n ** 256n - 1n : 0n),
        p2: (_t, spender) => (spender.toLowerCase().startsWith('0xc92e') ? [500n, now + 600, 0] : [0n, 0, 0]),
      }),
      8453,
      A('me'),
      [{ token: A('aa'), symbol: 'AAVE' }],
      now,
    )
    expect(failed).toBe(0)
    const inf = rows.find((r) => r.via === 'erc20')!
    expect(inf.infinite).toBe(true)
    expect(inf.spender.label).toBe('LI.FI')
    const p2 = rows.find((r) => r.via === 'permit2')!
    expect(p2.expiresAt).toBe(now + 600)
    expect(rows[0].infinite).toBe(true) // infinite sorts first — the loudest fact leads
  })

  it('an EXPIRED permit2 sub-grant is not a standing approval', async () => {
    const now = 1_700_000_000
    const { rows } = await readStandingApprovals(
      mockClient({ p2: () => [500n, now - 1, 0] }),
      8453,
      A('me'),
      [{ token: A('aa'), symbol: 'AAVE' }],
      now,
    )
    expect(rows).toHaveLength(0)
  })

  it('a failed read is COUNTED, never a verdict — no row, no silent all-clear', async () => {
    const { rows, failed } = await readStandingApprovals(
      mockClient({ erc20: () => new Error('rpc') }),
      8453,
      A('me'),
      [{ token: A('aa'), symbol: 'AAVE' }],
      1,
    )
    expect(rows.filter((r) => r.via === 'erc20')).toHaveLength(0)
    expect(failed).toBe(knownSpenders(8453).length) // one per spender, registry-sized
  })

  it('finding 3: where Permit2 IS deployed, a failed sub-grant read COUNTS as unchecked', async () => {
    const { rows, failed } = await readStandingApprovals(
      mockClient({ p2: () => new Error('rate limited') }),
      8453,
      A('me'),
      [{ token: A('aa'), symbol: 'AAVE' }],
      1,
    )
    expect(rows).toHaveLength(0)
    // one per non-Permit2 spender — the sub-grant layer that could not be read
    expect(failed).toBe(knownSpenders(8453).length - 1)
  })

  it('finding 3: where Permit2 is genuinely ABSENT, skipping stays silent (no wolf-crying)', async () => {
    const { failed } = await readStandingApprovals(
      mockClient({ code: () => '0x', p2: () => new Error('would explode if called') }),
      4663,
      A('me'),
      [{ token: A('aa'), symbol: 'AAVE' }],
      1,
    )
    expect(failed).toBe(0)
  })

  it('finding 3: an UNREADABLE presence probe counts the layer unchecked once — unknown is not absent', async () => {
    const { failed } = await readStandingApprovals(
      mockClient({ code: () => new Error('rpc down') }),
      8453,
      A('me'),
      [{ token: A('aa'), symbol: 'AAVE' }],
      1,
    )
    expect(failed).toBe(1)
  })

  it('revoke calls: approve(0) for erc20; Permit2.approve(token, spender, 0, 0) for sub-grants', () => {
    const base = { chainId: 8453, token: A('aa'), symbol: 'AAVE', amountRaw: 1n, infinite: false } as const
    const sp = knownSpenders(8453)[1]
    const e = revokeCall({ ...base, spender: sp, via: 'erc20' } as StandingApproval)
    expect(e.address).toBe(A('aa'))
    expect(e.args).toEqual([sp.address, 0n])
    const p = revokeCall({ ...base, spender: sp, via: 'permit2' } as StandingApproval)
    expect(p.address).toBe(PERMIT2_ADDRESS)
    expect(p.args).toEqual([A('aa'), sp.address, 0n, 0])
  })
})
