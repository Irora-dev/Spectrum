import { type Address, type Hex, type PublicClient, toHex } from 'viem'
import { clientFor } from '../chain/rpc'
import {
  factoryDeployAbi,
  HOOK_FLAGS_MASK,
  HOOK_FLAGS_SUFFIX,
  type FeeConfigInput,
} from './abis-v2'
import {
  bitsMatched,
  mineLocally,
  randomSaltPrefix,
  saltFor,
  type MineProgress,
} from './create2-mine'
import { deriveInitCodeHash } from './salt-init-code'

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
//
// ── TWO SEARCHES, ONE ORACLE (2026-08-13) ────────────────────────────────────
// The search runs LOCALLY when the factory's init code can be rebuilt and
// proven (salt-init-code.ts): measured 146,714 tries/sec on one thread and
// ~1.1M across the worker pool, against 164 probes/sec for the multicall path
// it replaces — the same ~16,384-try search fell from ~100 seconds of network
// latency to milliseconds. The multicall path below is unchanged and is still
// the answer for any factory whose init code cannot be proven.
//
// ⛔ THE ORACLE IS STILL THE AUTHORITY. Whichever search found it, the winning
// salt is put back to `predictTokenAddress` and must answer with the same
// address, carrying the flags, before this function returns it. A locally mined
// address is a CANDIDATE until the factory itself agrees.

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
  /** predictTokenAddress calls per Multicall3 round-trip (RPC fallback only). */
  batchSize?: number
  /** Safety cap so a pathological run can't loop forever. */
  maxAttempts?: number
  /** Live figures for the scanner: tries, measured rate, near-misses, candidates. */
  onProgress?: (progress: MineProgress) => void
  signal?: AbortSignal
  /** Test seam: skip the local path entirely and probe the chain as before. */
  forceRpc?: boolean
  /** Test seam: mine single-threaded even where Web Workers exist. */
  forceMainThread?: boolean
}

export interface MinedSalt {
  salt: Hex
  predicted: Address
  attempts: number
  /** Which search found it — surfaced so the UI can be honest about the wait. */
  mode: 'local' | 'rpc'
}

const U256_MASK = (1n << 256n) - 1n

/**
 * Mine a CREATE2 salt whose predicted basket-token address carries the 0x88
 * hook bits. The factory's own `predictTokenAddress` view is the oracle: it
 * opens the run (a malformed basket / fee config / wrong factory fails loudly
 * here), it proves the local init-code rebuild, and it confirms the winner.
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
    forceRpc,
    forceMainThread,
  } = args

  const client = clientFor(chainId) as PublicClient
  // Field order must match the contract's FeeConfig struct so predictTokenAddress
  // re-encodes the exact init-code the real deploy uses. The redesign's new tuple
  // is why every previously-mined salt is invalid (the "re-salt").
  const fc = {
    basketFeeBps: feeConfig.basketFeeBps,
    creatorShareBps: feeConfig.creatorShareBps,
    creatorPayout: feeConfig.creatorPayout,
    launcher: feeConfig.launcher,
  }
  const predict = (salt: Hex): Promise<Address> =>
    client.readContract({
      address: factory,
      abi: factoryDeployAbi,
      functionName: 'predictTokenAddress',
      args: [salt, basket, deployer, fc],
    }) as Promise<Address>

  const prefix = randomSaltPrefix()
  const probeSalt = saltFor(prefix, 0)

  // Probe once up front so a malformed basket / fee config / wrong factory fails
  // loudly here rather than masquerading as "no salt found". The same answer is
  // the proof the local rebuild has to reproduce.
  const probe = await predict(probeSalt)
  if (hasHookFlags(probe)) return { salt: probeSalt, predicted: probe, attempts: 1, mode: 'local' }
  if (signal?.aborted) throw new DOMException('Salt mining aborted', 'AbortError')

  // ── the local search ───────────────────────────────────────────────────────
  if (!forceRpc) {
    const initCodeHash = await deriveInitCodeHash({
      client,
      factory,
      chainId,
      basket,
      deployer,
      feeConfig: fc,
      proof: { salt: probeSalt, address: probe },
    })
    if (initCodeHash) {
      const found = await mineLocally({
        factory,
        initCodeHash,
        prefix,
        maxAttempts,
        onProgress,
        signal,
        forceMainThread,
      })
      // ⛔ CONFIRMATION, NOT DECORATION. One call, on the winner only. The
      // deploy is armed with what the FACTORY says the address is; if the two
      // ever disagreed, the local rebuild would be wrong and mining it further
      // would be mining rubbish — so this falls through to the chain probe
      // rather than deploying a guess.
      const confirmed = await predict(found.salt)
      if (confirmed.toLowerCase() === found.predicted.toLowerCase() && hasHookFlags(confirmed)) {
        return { salt: found.salt, predicted: confirmed, attempts: found.attempts, mode: 'local' }
      }
    }
  }

  // ── the chain-probing search (unchanged): batched predictTokenAddress ──────
  const base = BigInt(probeSalt)
  const saltAt = (i: number): Hex => toHex((base + BigInt(i)) & U256_MASK, { size: 32 })
  const started = Date.now()
  let attempts = 1
  let bestBits = 0
  let bestAddress: string | null = null
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
    const samples: string[] = []
    for (let k = 0; k < results.length; k++) {
      const r = results[k]
      if (r.status !== 'success') continue
      const predicted = r.result as unknown as Address
      if (hasHookFlags(predicted)) {
        return { salt: salts[k], predicted, attempts: attempts + k + 1, mode: 'rpc' }
      }
      // Same near-miss score the local path reports — the scanner reads the
      // same on either search, because it is the same measurement.
      const bits = bitsMatched(Number(BigInt(predicted) & HOOK_FLAGS_MASK))
      if (bits > bestBits) {
        bestBits = bits
        bestAddress = predicted.toLowerCase()
      }
      if (k % 8 === 0) samples.push(predicted.toLowerCase())
    }
    attempts += salts.length
    const elapsed = Math.max(1, Date.now() - started)
    onProgress?.({
      attempts,
      rate: (attempts / elapsed) * 1000,
      bestBits,
      bestAddress,
      samples: samples.slice(-12),
      mode: 'rpc',
      workers: 1,
    })
  }
  throw new Error(`No 0x88 salt found in ${maxAttempts} attempts — retry (random restart) or raise maxAttempts.`)
}
