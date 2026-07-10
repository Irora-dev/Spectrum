import { type Address, type Hex, toHex } from 'viem'
import { clientFor } from '../chain/rpc'
import {
  factoryDeployAbi,
  HOOK_FLAGS_MASK,
  HOOK_FLAGS_SUFFIX,
  type FeeConfigInput,
} from './abis-v2'

// The deployed basket token IS its own V4 hook, so its address must carry the
// hook permission bits the PoolManager checks: BEFORE_SWAP (1<<7) |
// BEFORE_SWAP_RETURNS_DELTA (1<<3) = 0x88, masked to the low 14 bits. CREATE2
// makes the address a pure function of (factory, salt, initCodeHash);
// initCodeHash is fixed by the basket + deployer + FEE CONFIG (V2: the fee
// config is CREATE2-committed — so it is a mining input), leaving only
// `salt` free — brute-forced until the predicted address lands on the bits.
// Hit rate 1/16384 → expect ~16k probes. Flags are sourced from abis-v2.ts
// (single source of truth); what forces re-mining in V2 is the new init-code
// hash, not changed flags.

/** True when `addr` carries the 0x88 hook permission bits the factory requires. */
export function hasHookFlags(addr: Address): boolean {
  return (BigInt(addr) & HOOK_FLAGS_MASK) === HOOK_FLAGS_SUFFIX
}

import type { DeployBasketEntry } from './deploy'

export interface MineSaltArgs {
  /** Spectrum V2 factory for the target chain. */
  factory: Address
  chainId: number
  /** The basket exactly as it will be passed to deployBasket. */
  basket: DeployBasketEntry[]
  /** msg.sender of the eventual deployBasket call — baked into the init code,
   *  so the mined salt is valid ONLY for this deployer. */
  deployer: Address
  /** The immutable fee config (CREATE2-committed — changing it invalidates the salt). */
  feeConfig: FeeConfigInput
  /** predictTokenAddress calls per Multicall3 round-trip. */
  batchSize?: number
  /** Safety cap so a pathological run can't loop forever. */
  maxAttempts?: number
  /** Reports cumulative probe count after each batch. */
  onProgress?: (attempts: number) => void
  signal?: AbortSignal
}

export interface MinedSalt {
  salt: Hex
  predicted: Address
  attempts: number
}

/** 32-byte random starting point so concurrent miners don't collide. */
function randomSaltBase(): bigint {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

const U256_MASK = (1n << 256n) - 1n

/**
 * Mine a CREATE2 salt whose predicted basket-token address carries the 0x88
 * hook bits. Uses the factory's own `predictTokenAddress` view as the oracle
 * (it reuses the exact on-chain init code, so the mined address is guaranteed
 * to match the real deploy), batched through Multicall3.
 */
export async function mineSalt(args: MineSaltArgs): Promise<MinedSalt> {
  const {
    factory,
    chainId,
    basket,
    deployer,
    feeConfig,
    batchSize = 60,
    maxAttempts = 200_000,
    onProgress,
    signal,
  } = args

  const client = clientFor(chainId)
  const base = randomSaltBase()
  const saltAt = (i: number): Hex => toHex((base + BigInt(i)) & U256_MASK, { size: 32 })
  // Field order must match the contract's FeeConfig struct so predictTokenAddress
  // re-encodes the exact init-code the real deploy uses. The redesign's new tuple
  // is why every previously-mined salt is invalid (the "re-salt").
  const fc = {
    basketFeeBps: feeConfig.basketFeeBps,
    creatorShareBps: feeConfig.creatorShareBps,
    creatorPayout: feeConfig.creatorPayout,
    launcher: feeConfig.launcher,
  }

  // Probe once up front so a malformed basket / fee config / wrong factory fails
  // loudly here rather than masquerading as "no salt found".
  const probe = await client.readContract({
    address: factory,
    abi: factoryDeployAbi,
    functionName: 'predictTokenAddress',
    args: [saltAt(0), basket, deployer, fc],
  })
  if (hasHookFlags(probe)) return { salt: saltAt(0), predicted: probe, attempts: 1 }

  let attempts = 1
  for (let start = 1; start < maxAttempts; start += batchSize) {
    if (signal?.aborted) throw new DOMException('Salt mining aborted', 'AbortError')
    const salts = Array.from({ length: Math.min(batchSize, maxAttempts - start) }, (_, k) => saltAt(start + k))
    const results = await client.multicall({
      contracts: salts.map((salt) => ({
        address: factory,
        abi: factoryDeployAbi,
        functionName: 'predictTokenAddress',
        args: [salt, basket, deployer, fc],
      })),
      allowFailure: true,
    })
    for (let k = 0; k < results.length; k++) {
      const r = results[k]
      if (r.status !== 'success') continue
      const predicted = r.result as unknown as Address
      if (hasHookFlags(predicted)) {
        return { salt: salts[k], predicted, attempts: attempts + k + 1 }
      }
    }
    attempts += salts.length
    onProgress?.(attempts)
  }
  throw new Error(`No 0x88 salt found in ${maxAttempts} attempts — retry (random restart) or raise maxAttempts.`)
}
