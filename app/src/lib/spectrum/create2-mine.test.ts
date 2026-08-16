import { describe, expect, it } from 'vitest'
import { bytesToHex, toHex, type Address, type Hex } from 'viem'
import {
  bitsMatched,
  chunkAt,
  create2Preimage,
  HOOK_ADDRESS_SPACE,
  HOOK_FLAG_BITS,
  MINE_EXPECTED_TRIES,
  mineChunk,
  mineLocally,
  predictLocal,
  randomSaltPrefix,
  saltFor,
  SALT_PREFIX_BYTES,
  workerCount,
} from './create2-mine'
import { hasHookFlags } from './salt-mining'

// ─────────────────────────────────────────────────────────────────────────────
// THE ANCHOR: three real answers from the LIVE Base factory
// (0xa60ce…4E5D), read from `predictTokenAddress` on 2026-08-13 with the
// init-code hash rebuilt from that factory's own TOKEN_CODE_PROVIDER_0/1,
// POOL_MANAGER and canonEthUsdcKey. If the local CREATE2 path ever stops
// reproducing these, it has stopped agreeing with the chain — which is the only
// thing that makes local mining safe.
// ─────────────────────────────────────────────────────────────────────────────
const FACTORY = '0xa60ce83A4048f2157A65d596002541311D694E5D' as Address
const INIT_CODE_HASH = '0x085f9d719d68388d2e1443ce129104b5349e2c016d64fe4135878a81fc6e2246' as Hex
const CHAIN_ANSWERS: ReadonlyArray<readonly [number, string]> = [
  [12_345, '0xFa1c4898Cc955038140a78682eD5D8003aFCEa3B'],
  [999_999, '0xb4720f15a378630C240Ac9c92DF304c9F8Df10aa'],
]

const ZERO_PREFIX = new Uint8Array(SALT_PREFIX_BYTES)
/** The address the hot byte loop computes for one counter (its own code path). */
const addressAt = (pre: Uint8Array, counter: number): string =>
  mineChunk({ pre, from: counter, count: 1 }).bestAddress as string

describe('local CREATE2 derivation', () => {
  it('reproduces the live factory’s predictTokenAddress answers', () => {
    const pre = create2Preimage(FACTORY, INIT_CODE_HASH, ZERO_PREFIX)
    for (const [counter, expected] of CHAIN_ANSWERS) {
      // the viem reference…
      expect(predictLocal(FACTORY, INIT_CODE_HASH, saltFor(ZERO_PREFIX, counter))).toBe(expected)
      // …and the byte loop the miner actually runs
      expect(addressAt(pre, counter)).toBe(expected.toLowerCase())
    }
  })

  it('lays the counter into the salt where deployBasket will read it', () => {
    // A zero prefix means the salt is just the counter — the plainest possible
    // statement that the salt handed to the factory is the salt that was mined.
    expect(saltFor(ZERO_PREFIX, 12_345)).toBe(toHex(12_345n, { size: 32 }))
    const prefix = randomSaltPrefix()
    const salt = saltFor(prefix, 7)
    expect(salt.slice(2, 2 + SALT_PREFIX_BYTES * 2)).toBe(bytesToHex(prefix).slice(2))
    expect(salt.slice(-12)).toBe('000000000007')
    expect(saltFor(prefix, 7)).not.toBe(saltFor(prefix, 8))
  })

  it('rejects a counter outside the salt’s counter field', () => {
    expect(() => saltFor(ZERO_PREFIX, 2 ** 48)).toThrow(/out of range/)
  })
})

describe('the hook-flag target', () => {
  it('is a 1-in-16,384 search, and says so in one place', () => {
    expect(HOOK_FLAG_BITS).toBe(14)
    expect(HOOK_ADDRESS_SPACE).toBe(16_384)
    expect(MINE_EXPECTED_TRIES).toBe(16_384)
  })

  it('scores near-misses honestly (14 = a hit)', () => {
    expect(bitsMatched(0x88)).toBe(14) // exact
    expect(bitsMatched(0x89)).toBe(13) // one bit out
    expect(bitsMatched(0x8b)).toBe(12) // two bits out
    expect(bitsMatched(0x3f77)).toBe(0) // every masked bit inverted
  })

  it('flags exactly the addresses hasHookFlags accepts, over a real scan', () => {
    const pre = create2Preimage(FACTORY, INIT_CODE_HASH, ZERO_PREFIX)
    const fromLoop: number[] = []
    for (let at = 0; at < 40_000; ) {
      const r = mineChunk({ pre, from: at, count: 40_000 - at })
      if (r.hit == null) break
      fromLoop.push(r.hit)
      at = r.hit + 1
    }
    expect(fromLoop.length).toBeGreaterThan(0)
    // every hit the byte loop claims survives the canonical check…
    for (const counter of fromLoop) {
      expect(hasHookFlags(predictLocal(FACTORY, INIT_CODE_HASH, saltFor(ZERO_PREFIX, counter)))).toBe(true)
    }
    // …and it claimed every one there is (spot-checked against the reference)
    const fromReference: number[] = []
    for (let c = 0; c < 3_000; c++) {
      if (hasHookFlags(predictLocal(FACTORY, INIT_CODE_HASH, saltFor(ZERO_PREFIX, c)))) fromReference.push(c)
    }
    expect(fromLoop.filter((c) => c < 3_000)).toEqual(fromReference)
  })
})

describe('the worker pool splits the salt space', () => {
  it('gives each worker a disjoint residue class, and every hit is real', () => {
    const pre = create2Preimage(FACTORY, INIT_CODE_HASH, ZERO_PREFIX)
    const stride = 4
    const hits = new Set<number>()
    for (let index = 0; index < stride; index++) {
      // exactly what salt-miner.worker.ts runs: from = index, step = stride
      const r = mineChunk({ pre, from: index, count: 60_000, stride })
      expect(r.hit).not.toBeNull()
      const hit = r.hit as number
      // the residue class is the disjointness: no two workers can meet here
      expect(hit % stride).toBe(index)
      expect(hits.has(hit)).toBe(false)
      hits.add(hit)
      // and the candidate is a genuine one, by the reference implementation
      expect(hasHookFlags(predictLocal(FACTORY, INIT_CODE_HASH, saltFor(ZERO_PREFIX, hit)))).toBe(true)
    }
    expect(hits.size).toBe(stride)
  })

  it('ramps its first chunks so a search that ends early still reported', () => {
    // The first live run found the salt in 7,013 tries across 7 threads — about
    // 1,000 each. A flat 8,192-try chunk would have reported nothing at all, and
    // the scanner would have shown an empty box for the entire wait.
    expect(chunkAt(0, 8192)).toBe(256)
    expect(chunkAt(1, 8192)).toBe(512)
    expect(chunkAt(5, 8192)).toBe(8192)
    expect(chunkAt(99, 8192)).toBe(8192) // never overshoots the cap
    expect(chunkAt(0, 64)).toBe(64) // nor a cap smaller than the first chunk
  })

  it('never asks for more threads than the machine should give', () => {
    const n = workerCount()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(8)
  })
})

describe('mining locally', () => {
  it('finds a salt whose address the reference implementation agrees with', async () => {
    const found = await mineLocally({
      factory: FACTORY,
      initCodeHash: INIT_CODE_HASH,
      prefix: ZERO_PREFIX,
      maxAttempts: 200_000,
      forceMainThread: true,
    })
    expect(hasHookFlags(found.predicted)).toBe(true)
    expect(predictLocal(FACTORY, INIT_CODE_HASH, found.salt)).toBe(found.predicted)
    expect(found.attempts).toBeGreaterThan(0)
  })

  it('reports measured figures, not modelled ones', async () => {
    const seen: number[] = []
    await mineLocally({
      factory: FACTORY,
      initCodeHash: INIT_CODE_HASH,
      prefix: ZERO_PREFIX,
      maxAttempts: 200_000,
      forceMainThread: true,
      chunkSize: 64,
      onProgress: (p) => {
        seen.push(p.attempts)
        expect(p.rate).toBeGreaterThan(0)
        expect(p.bestBits).toBeLessThanOrEqual(HOOK_FLAG_BITS)
        for (const a of p.samples) expect(a).toMatch(/^0x[0-9a-f]{40}$/)
      },
    })
    expect(seen.length).toBeGreaterThan(0)
    // attempts only ever go up, and they count tries — not batches
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })

  it('stops the moment it is cancelled', async () => {
    // counter 0 is not a hit for these inputs, so the first chunk cannot resolve
    // before the abort lands — the cancellation is what ends this run, always.
    expect(hasHookFlags(predictLocal(FACTORY, INIT_CODE_HASH, saltFor(ZERO_PREFIX, 0)))).toBe(false)
    const ctrl = new AbortController()
    let attemptsWhenCancelled = 0
    await expect(
      mineLocally({
        factory: FACTORY,
        initCodeHash: INIT_CODE_HASH,
        prefix: ZERO_PREFIX,
        maxAttempts: 5_000_000,
        forceMainThread: true,
        chunkSize: 1,
        signal: ctrl.signal,
        onProgress: (p) => {
          attemptsWhenCancelled = p.attempts
          ctrl.abort()
        },
      }),
    ).rejects.toThrow(/aborted/i)
    // one try after the abort at most: the loop checks before every chunk
    expect(attemptsWhenCancelled).toBe(1)
  })

  it('refuses a signal that is already aborted', async () => {
    await expect(
      mineLocally({
        factory: FACTORY,
        initCodeHash: INIT_CODE_HASH,
        prefix: ZERO_PREFIX,
        maxAttempts: 5_000_000,
        forceMainThread: true,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/aborted/i)
  })

  it('gives up honestly rather than looping forever', async () => {
    await expect(
      mineLocally({
        factory: FACTORY,
        initCodeHash: INIT_CODE_HASH,
        prefix: ZERO_PREFIX,
        // counter 0 is not a hit, so a one-try budget must come back empty
        maxAttempts: 1,
        forceMainThread: true,
      }),
    ).rejects.toThrow(/No 0x88 salt found/)
  })
})
