import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256, toHex, zeroAddress, type Address } from 'viem'
import { probeTransferFee, screenTokenIdentity } from './token-screen'

// The screen runs against a viem PublicClient but only touches four methods —
// a hand-rolled stub keeps these tests pure-logic (no network, no chain).
type ReadArgs = { address: Address; functionName: string; args?: unknown[]; stateOverride?: unknown }

const ASSET = '0x00000000000000000000000000000000000a55e7' as Address
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address
const PROBE_SENDER = '0x1000000000000000000000000000000000000001'

const cfg = (factory: Address | null) =>
  ({ chainId: 8453, factory, weth: '0x4200000000000000000000000000000000000006' }) as never

interface StubOpts {
  code?: string
  decimals?: number | Error
  erc777Impl?: Address
  basketDeployer?: Address
  /** balanceOf responder for slot-scan reads (receives stateOverride). */
  balanceOf?: (a: ReadArgs) => bigint
  simulate?: (calls: unknown[]) => { results: { status: string; result?: unknown }[] }
}

function stubClient(o: StubOpts) {
  return {
    getCode: async () => o.code ?? '0x6001',
    readContract: async (a: ReadArgs) => {
      if (a.functionName === 'decimals') {
        if (o.decimals instanceof Error) throw o.decimals
        return o.decimals ?? 18
      }
      if (a.functionName === 'getInterfaceImplementer') return o.erc777Impl ?? zeroAddress
      if (a.functionName === 'tokens') return o.basketDeployer ?? zeroAddress
      if (a.functionName === 'balanceOf') return o.balanceOf ? o.balanceOf(a) : 0n
      throw new Error(`unexpected read: ${a.functionName}`)
    },
    simulateCalls: async ({ calls }: { calls: unknown[] }) => {
      if (!o.simulate) throw new Error('no simulateCalls stub')
      return o.simulate(calls)
    },
  } as never
}

describe('screenTokenIdentity — deterministic disqualifiers', () => {
  it('passes a vanilla ERC-20', async () => {
    const s = await screenTokenIdentity(stubClient({ decimals: 6 }), cfg(FACTORY), ASSET)
    expect(s.hardFail).toBeNull()
    expect(s.decimals).toBe(6)
  })

  it('rejects an address with no code', async () => {
    const s = await screenTokenIdentity(stubClient({ code: '0x' }), cfg(FACTORY), ASSET)
    expect(s.hardFail?.code).toBe('NOT_A_CONTRACT')
  })

  it('rejects when decimals() reverts (the deploy would revert too)', async () => {
    const s = await screenTokenIdentity(stubClient({ decimals: new Error('boom') }), cfg(FACTORY), ASSET)
    expect(s.hardFail?.code).toBe('NON_STANDARD')
  })

  it('rejects out-of-range decimals', async () => {
    const s = await screenTokenIdentity(stubClient({ decimals: 42 }), cfg(FACTORY), ASSET)
    expect(s.hardFail?.code).toBe('NON_STANDARD')
  })

  it('rejects an ERC-777 (ERC-1820 registered)', async () => {
    const s = await screenTokenIdentity(
      stubClient({ erc777Impl: '0x0000000000000000000000000000000000000777' }),
      cfg(FACTORY),
      ASSET,
    )
    expect(s.hardFail?.code).toBe('ERC777')
  })

  it('rejects a Spectrum basket token (factory-registered deployer)', async () => {
    const s = await screenTokenIdentity(
      stubClient({ basketDeployer: '0x00000000000000000000000000000000000d3b70' }),
      cfg(FACTORY),
      ASSET,
    )
    expect(s.hardFail?.code).toBe('SPECTRUM_BASKET')
  })

  it('skips the basket probe when no factory is configured', async () => {
    const s = await screenTokenIdentity(
      stubClient({ basketDeployer: '0x00000000000000000000000000000000000d3b70' }),
      cfg(null),
      ASSET,
    )
    expect(s.hardFail).toBeNull() // deployer stub never consulted without a factory
  })

  it('hard-fails known rebasing tokens from the denylist (stETH)', async () => {
    const s = await screenTokenIdentity(
      stubClient({}),
      { chainId: 1, factory: FACTORY, weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' } as never,
      '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address,
    )
    expect(s.hardFail?.code).toBe('REBASING')
  })
})

describe('probeTransferFee — empirical fee-on-transfer detection', () => {
  const AMOUNT = 10n ** 18n
  // The slot the stub "backs" balances with — the scan must find exactly this one.
  const SLOT = 9
  const slotKeyFor = (holder: string, slot: number) =>
    keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder as Address, BigInt(slot)]))

  /** balanceOf that honors a state override only when it hits the real slot. */
  const slotAwareBalance = (a: ReadArgs): bigint => {
    const ov = (a.stateOverride as { stateDiff: { slot: string; value: string }[] }[] | undefined)?.[0]
    const hit = ov?.stateDiff.find((d) => d.slot === slotKeyFor(PROBE_SENDER, SLOT))
    return hit ? BigInt(hit.value) : 0n
  }

  it('clean token → clean verdict', async () => {
    const client = stubClient({
      balanceOf: slotAwareBalance,
      simulate: () => ({
        results: [
          { status: 'success', result: true },
          { status: 'success', result: AMOUNT }, // recipient received all of it
        ],
      }),
    })
    expect(await probeTransferFee(client, ASSET)).toEqual({ verdict: 'clean' })
  })

  it('fee token → measured fee in bps', async () => {
    const client = stubClient({
      balanceOf: slotAwareBalance,
      simulate: () => ({
        results: [
          { status: 'success', result: true },
          { status: 'success', result: (AMOUNT * 9_800n) / 10_000n }, // 2% skimmed
        ],
      }),
    })
    expect(await probeTransferFee(client, ASSET)).toEqual({ verdict: 'fee-on-transfer', receivedBps: 9_800 })
  })

  it('unfindable balance slot → inconclusive, never a verdict', async () => {
    const client = stubClient({ balanceOf: () => 0n })
    expect(await probeTransferFee(client, ASSET)).toEqual({ verdict: 'inconclusive' })
  })

  it('simulateCalls unsupported → inconclusive', async () => {
    const client = stubClient({ balanceOf: slotAwareBalance }) // no simulate stub → throws
    expect(await probeTransferFee(client, ASSET)).toEqual({ verdict: 'inconclusive' })
  })

  it('reverting transfer → inconclusive (weird, but not a measured fee)', async () => {
    const client = stubClient({
      balanceOf: slotAwareBalance,
      simulate: () => ({
        results: [
          { status: 'failure' },
          { status: 'success', result: 0n },
        ],
      }),
    })
    expect(await probeTransferFee(client, ASSET)).toEqual({ verdict: 'inconclusive' })
  })
})

// toHex kept for parity with the module's slot encoding — exercised implicitly above.
void toHex
