import { beforeEach, describe, expect, it } from 'vitest'
import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import { predictLocal, saltFor, SALT_PREFIX_BYTES } from './create2-mine'
import {
  basketInitCodeHash,
  deriveInitCodeHash,
  resetFactoryInitCodeCache,
  type FactoryInitCodeParts,
} from './salt-init-code'
import type { DeployBasketEntry } from './deploy'
import type { FeeConfigInput } from './abis-v2'

const A = (n: string) => `0x${n.repeat(40).slice(0, 40)}` as Address
const ZERO = A('0')
const FACTORY = A('a')

// Stand-in code halves: this file tests the ENCODING the factory hashes, not the
// bytes of the token. Agreement with the real chain is proven at runtime, by the
// probe `deriveInitCodeHash` checks before any hash is used (and again on the
// winning salt, in salt-mining.ts).
const PARTS: FactoryInitCodeParts = {
  poolManager: A('1'),
  canonEthUsdcKey: { currency0: ZERO, currency1: A('2'), fee: 3000, tickSpacing: 60, hooks: ZERO },
  code0: '0x60806040',
  code1: '0x52348015',
}

const entry = (over: Partial<DeployBasketEntry> = {}): DeployBasketEntry => ({
  asset: A('3'),
  venue: 1,
  ethPool: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
  v3Fee: 500,
  v2Pair: ZERO,
  weight: 10_000,
  decimals: 18,
  ...over,
})

const FEE: FeeConfigInput = { basketFeeBps: 100, creatorShareBps: 3000, creatorPayout: A('4'), launcher: ZERO }
const DEPLOYER = A('5')
const hashOf = (over: { basket?: DeployBasketEntry[]; deployer?: Address; feeConfig?: FeeConfigInput } = {}) =>
  basketInitCodeHash({
    parts: PARTS,
    basket: over.basket ?? [entry()],
    deployer: over.deployer ?? DEPLOYER,
    feeConfig: over.feeConfig ?? FEE,
  })

describe('rebuilding the basket init code', () => {
  it('zeroes decimals before hashing, exactly as the factory does', () => {
    // SpectrumFactory._buildInitCode normalises decimals to 0 and the token
    // re-reads them on-chain. A miner that skipped this would mine a salt for an
    // address that can never be deployed — so the two MUST hash the same.
    expect(hashOf({ basket: [entry({ decimals: 18 })] })).toBe(hashOf({ basket: [entry({ decimals: 0 })] }))
    expect(hashOf({ basket: [entry({ decimals: 6 })] })).toBe(hashOf({ basket: [entry({ decimals: 0 })] }))
  })

  it('commits every input that CREATE2 commits', () => {
    const base = hashOf()
    expect(hashOf({ deployer: A('6') })).not.toBe(base)
    expect(hashOf({ feeConfig: { ...FEE, basketFeeBps: 200 } })).not.toBe(base)
    expect(hashOf({ feeConfig: { ...FEE, creatorShareBps: 0 } })).not.toBe(base)
    expect(hashOf({ feeConfig: { ...FEE, creatorPayout: A('7') } })).not.toBe(base)
    expect(hashOf({ feeConfig: { ...FEE, launcher: A('8') } })).not.toBe(base)
    expect(hashOf({ basket: [entry({ asset: A('9') })] })).not.toBe(base)
    expect(hashOf({ basket: [entry({ weight: 9_000 }), entry({ asset: A('9'), weight: 1_000 })] })).not.toBe(base)
    expect(hashOf({ basket: [entry({ v3Fee: 3_000 })] })).not.toBe(base)
    expect(hashOf({ basket: [entry({ venue: 2 })] })).not.toBe(base)
  })

  it('locks the argument tuple against a silent reorder', () => {
    // (POOL_MANAGER, deployer, normalizedBasket, canonEthUsdcKey, feeConfig) —
    // the order named in _buildInitCode's own comment. Reordering it, or losing
    // a field, changes this and invalidates every salt this app mines.
    expect(hashOf()).toBe('0xb72ecc7d9ad5000216299d4c67a881ab48f4c91dc5863c9c0a72c505f1ed6d1f')
  })
})

// A client that answers exactly the four getters + the two code reads.
function stubClient(over: Partial<Record<string, unknown>> = {}): PublicClient {
  const answers: Record<string, unknown> = {
    POOL_MANAGER: PARTS.poolManager,
    TOKEN_CODE_PROVIDER_0: A('b'),
    TOKEN_CODE_PROVIDER_1: A('c'),
    canonEthUsdcKey: [
      PARTS.canonEthUsdcKey.currency0,
      PARTS.canonEthUsdcKey.currency1,
      PARTS.canonEthUsdcKey.fee,
      PARTS.canonEthUsdcKey.tickSpacing,
      PARTS.canonEthUsdcKey.hooks,
    ],
    ...over,
  }
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in answers)) throw new Error(`no such function: ${functionName}`)
      return answers[functionName]
    },
    getCode: async ({ address }: { address: Address }) =>
      address.toLowerCase() === A('b').toLowerCase() ? PARTS.code0 : PARTS.code1,
  } as unknown as PublicClient
}

const PREFIX = new Uint8Array(SALT_PREFIX_BYTES)
const PROOF_SALT = saltFor(PREFIX, 42)

describe('proving the rebuild against the factory', () => {
  beforeEach(() => resetFactoryInitCodeCache())

  const derive = (client: PublicClient, address: Address) =>
    deriveInitCodeHash({
      client,
      factory: FACTORY,
      chainId: 8453,
      basket: [entry()],
      deployer: DEPLOYER,
      feeConfig: FEE,
      proof: { salt: PROOF_SALT, address },
    })

  it('returns the hash when it reproduces the factory’s own answer', async () => {
    const expected = hashOf()
    const truth = predictLocal(FACTORY, expected, PROOF_SALT)
    await expect(derive(stubClient(), truth)).resolves.toBe(expected)
  })

  it('returns null — never a guess — when the answers disagree', async () => {
    // Any disagreement means this factory is not the lineage this file mirrors.
    // The miner must fall back to probing the chain, not mine against rubbish.
    await expect(derive(stubClient(), A('d'))).resolves.toBeNull()
  })

  it('returns null when the factory has no such getters', async () => {
    const client = { readContract: async () => { throw new Error('execution reverted') } } as unknown as PublicClient
    await expect(derive(client, A('d'))).resolves.toBeNull()
  })

  it('returns null when a code provider holds no code', async () => {
    const client = {
      ...stubClient(),
      getCode: async () => '0x' as Hex,
    } as unknown as PublicClient
    await expect(derive(client, A('d'))).resolves.toBeNull()
  })

  it('does not cache a failed read', async () => {
    let calls = 0
    const failing = {
      readContract: async () => {
        calls++
        throw new Error('rate limited')
      },
    } as unknown as PublicClient
    await derive(failing, A('d'))
    const before = calls
    await derive(failing, A('d'))
    expect(calls).toBeGreaterThan(before)
  })

  it('caches the 29 KB of token code per factory', async () => {
    let codeReads = 0
    const counting = {
      ...stubClient(),
      getCode: async ({ address }: { address: Address }) => {
        codeReads++
        return address.toLowerCase() === A('b').toLowerCase() ? PARTS.code0 : PARTS.code1
      },
    } as unknown as PublicClient
    const truth = predictLocal(FACTORY, hashOf(), PROOF_SALT)
    await derive(counting, truth)
    expect(codeReads).toBe(2)
    await derive(counting, truth)
    expect(codeReads).toBe(2) // the token's creation code cannot change
  })
})

describe('the salt the proof is taken on', () => {
  it('is a real 32-byte salt, not a placeholder', () => {
    expect(PROOF_SALT).toBe(toHex(42n, { size: 32 }))
  })
})
