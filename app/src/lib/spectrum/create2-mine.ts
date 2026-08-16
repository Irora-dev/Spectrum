import { bytesToHex, getAddress, getCreate2Address, hexToBytes, keccak256, type Address, type Hex } from 'viem'
import { HOOK_FLAGS_MASK, HOOK_FLAGS_SUFFIX } from './abis-v2'

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL CREATE2 MINING — the same search the factory's `predictTokenAddress`
// view performs, computed here instead of over the wire.
//
// ⛔ WHY THIS EXISTS. The miner used to ask the chain for every candidate:
// `predictTokenAddress` batched 60-per-multicall, ~164 probes/sec measured
// against Base's public RPC (2026-08-13). The search needs ~16,384 probes, so a
// launch sat on "mining the new address…" for ~100 SECONDS of pure network
// latency. CREATE2 is deterministic — address = keccak256(0xff ‖ factory ‖ salt
// ‖ initCodeHash)[12:] — so once the init-code hash is known (salt-init-code.ts
// derives it from the factory's own immutables and PROVES it against the
// factory's own oracle) the whole search is local hashing: 146,714 tries/sec on
// one thread, ~1.1M across a worker pool. The same ~16,384 tries now take
// milliseconds.
//
// ⛔ THE HARD LAW THIS FILE DOES NOT BREAK. Nothing mined here is trusted on its
// own. The init-code hash is only used after it reproduces a real
// predictTokenAddress answer, and the WINNING salt is put back to the factory's
// oracle before any deploy (salt-mining.ts). Local mining is an accelerator for
// the search, never the authority on the address.
// ─────────────────────────────────────────────────────────────────────────────

/** The masked bits are a contiguous low mask, so the value space is mask+1. */
const MASK = Number(HOOK_FLAGS_MASK)
const WANT = Number(HOOK_FLAGS_SUFFIX)

/** How many addresses share one masked value ⇒ the search is 1-in-this. */
export const HOOK_ADDRESS_SPACE = MASK + 1
/** Width of the mask in bits — the "N of 14" a near-miss is scored against. */
export const HOOK_FLAG_BITS = MASK.toString(2).replace(/0/g, '').length
/** Expected tries for a memoryless 1-in-HOOK_ADDRESS_SPACE search. */
export const MINE_EXPECTED_TRIES = HOOK_ADDRESS_SPACE

// Pre-image layout, 85 bytes: 0xff ‖ factory(20) ‖ salt(32) ‖ initCodeHash(32).
const PREIMAGE_BYTES = 85
const SALT_AT = 21
const HASH_AT = 53
/** The salt's leading bytes are random per run; the trailing 6 are the counter. */
export const SALT_PREFIX_BYTES = 26
const COUNTER_AT = SALT_AT + SALT_PREFIX_BYTES // 47
/** 6 counter bytes ⇒ 2^48 salts per prefix, ~17 billion times the expected need. */
export const MAX_COUNTER = 2 ** 48 - 1

/** A fresh random salt prefix, so two miners (tabs, workers, people) never
 *  walk the same salts even when they start at the same counter. */
export function randomSaltPrefix(): Uint8Array {
  const p = new Uint8Array(SALT_PREFIX_BYTES)
  crypto.getRandomValues(p)
  return p
}

/** The 85-byte CREATE2 pre-image with the counter zeroed, ready for mineChunk. */
export function create2Preimage(factory: Address, initCodeHash: Hex, prefix: Uint8Array): Uint8Array {
  if (prefix.length !== SALT_PREFIX_BYTES) {
    throw new Error(`salt prefix must be ${SALT_PREFIX_BYTES} bytes (got ${prefix.length})`)
  }
  const pre = new Uint8Array(PREIMAGE_BYTES)
  pre[0] = 0xff
  pre.set(hexToBytes(factory), 1)
  pre.set(prefix, SALT_AT)
  pre.set(hexToBytes(initCodeHash), HASH_AT)
  return pre
}

/** Big-endian 6-byte counter at `at`. The hot loop's only write. */
function writeCounterAt(buf: Uint8Array, at: number, counter: number): void {
  buf[at] = (counter / 0x10000000000) & 0xff
  buf[at + 1] = (counter / 0x100000000) & 0xff
  buf[at + 2] = (counter >>> 24) & 0xff
  buf[at + 3] = (counter >>> 16) & 0xff
  buf[at + 4] = (counter >>> 8) & 0xff
  buf[at + 5] = counter & 0xff
}

/** Write a counter into the pre-image's trailing salt bytes. */
export function writeCounter(pre: Uint8Array, counter: number): void {
  writeCounterAt(pre, COUNTER_AT, counter)
}

/** The full 32-byte salt for a counter — what actually goes to deployBasket.
 *  Must produce the same salt bytes the pre-image carried, or the confirmed
 *  address would not be the mined one. */
export function saltFor(prefix: Uint8Array, counter: number): Hex {
  if (counter < 0 || counter > MAX_COUNTER) throw new Error(`salt counter out of range: ${counter}`)
  const salt = new Uint8Array(32)
  salt.set(prefix, 0)
  writeCounterAt(salt, SALT_PREFIX_BYTES, counter)
  return bytesToHex(salt)
}

/** viem's reference CREATE2 — the cross-check the byte loop is tested against. */
export function predictLocal(factory: Address, initCodeHash: Hex, salt: Hex): Address {
  return getCreate2Address({ from: factory, salt, bytecodeHash: initCodeHash })
}

/** The masked (low-14-bit) value of a keccak digest's address tail. */
export function maskedValueOf(digest: Uint8Array): number {
  return ((digest[30] << 8) | digest[31]) & MASK
}

/** How many of the HOOK_FLAG_BITS a masked value already carries — the honest
 *  near-miss score the scanner shows. HOOK_FLAG_BITS = a hit. */
export function bitsMatched(maskedValue: number): number {
  let x = (maskedValue ^ WANT) & MASK
  let bits = HOOK_FLAG_BITS
  while (x) {
    bits -= x & 1
    x >>>= 1
  }
  return bits
}

/** Lowercase 0x-address from a digest (display + comparison; never checksummed
 *  here so the scanner's flicker costs one allocation, not two). */
export function addressFromDigest(digest: Uint8Array): string {
  return bytesToHex(digest.subarray(12))
}

export interface MineChunkResult {
  /** Counter of the winning salt, or null when the chunk found nothing. */
  hit: number | null
  hitAddress: string | null
  /** How many candidates this chunk actually hashed. */
  tried: number
  /** Best near-miss seen, of HOOK_FLAG_BITS. */
  bestBits: number
  bestAddress: string | null
  /** Candidates sampled for the scanner — real addresses, not decoration. */
  samples: string[]
}

/**
 * Hash `count` candidates starting at `from`, stepping by `stride`. One keccak
 * of 85 bytes per try (a single permutation — the pre-image fits one block), no
 * allocation in the hot path beyond the digest itself.
 *
 * `stride`/`from` are how the worker pool splits the space: worker w of W walks
 * from = start + w, stride = W, so the residues mod W never overlap.
 */
export function mineChunk(opts: {
  pre: Uint8Array
  from: number
  count: number
  stride?: number
  /** Emit a sample candidate every N tries (0 = none). */
  sampleEvery?: number
}): MineChunkResult {
  const { pre, from, count, stride = 1, sampleEvery = 0 } = opts
  let bestBits = -1
  let bestAddress: string | null = null
  const samples: string[] = []
  for (let i = 0; i < count; i++) {
    const counter = from + i * stride
    writeCounter(pre, counter)
    const digest = keccak256(pre, 'bytes')
    const masked = maskedValueOf(digest)
    if (masked === WANT) {
      return { hit: counter, hitAddress: addressFromDigest(digest), tried: i + 1, bestBits: HOOK_FLAG_BITS, bestAddress: addressFromDigest(digest), samples }
    }
    const bits = bitsMatched(masked)
    if (bits > bestBits) {
      bestBits = bits
      bestAddress = addressFromDigest(digest)
    }
    if (sampleEvery > 0 && i % sampleEvery === 0) samples.push(addressFromDigest(digest))
  }
  return { hit: null, hitAddress: null, tried: count, bestBits: Math.max(bestBits, 0), bestAddress, samples }
}

/** Live figures the scanner renders. Every number here is measured, none modelled. */
export interface MineProgress {
  /** Candidates hashed so far. */
  attempts: number
  /** Measured tries/sec over the run. */
  rate: number
  /** Best near-miss so far, of HOOK_FLAG_BITS. */
  bestBits: number
  bestAddress: string | null
  /** Recent real candidates, newest last — the scanner's flicker. */
  samples: readonly string[]
  /** How the search is running: locally derived, or probing the chain. */
  mode: 'local' | 'rpc'
  /** Threads doing the work (1 on the main-thread fallback / rpc path). */
  workers: number
}

export interface LocalMineArgs {
  factory: Address
  initCodeHash: Hex
  prefix: Uint8Array
  maxAttempts: number
  onProgress?: (p: MineProgress) => void
  signal?: AbortSignal
  /** Test seam: force the single-threaded path even where Worker exists. */
  forceMainThread?: boolean
  /** Test seam: tries per yield on the single-threaded path. */
  chunkSize?: number
}

export interface LocalMineResult {
  salt: Hex
  /** Locally derived — CONFIRMED against the factory oracle by the caller. */
  predicted: Address
  attempts: number
  workers: number
}

const MAIN_THREAD_CHUNK = 2048
const WORKER_CHUNK = 8192
const SAMPLE_EVERY = 64
const SAMPLE_WINDOW = 12

// ⛔ THE FIRST CHUNK MUST BE SMALL. The local search often ENDS inside one full
// chunk — 7 threads found the salt in 7,013 tries on the first live run, about
// 1,000 each, so an 8,192-try chunk would have reported nothing at all and the
// scanner would have shown an empty box for the whole (very short) wait. Chunks
// therefore start at 256 tries and double up to the full size: the readout is
// alive within a couple of milliseconds, and steady-state throughput is
// unchanged because the ramp is over after ~16k tries.
const FIRST_CHUNK = 256
export function chunkAt(step: number, max: number): number {
  return Math.min(max, FIRST_CHUNK * 2 ** Math.min(step, 15))
}

/** How many threads to mine on: every core but one, so the scanner keeps its
 *  frames, capped at 8 (past that the coordination costs more than it buys). */
export function workerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
  return Math.max(1, Math.min(8, (cores || 4) - 1))
}

const aborted = () => new DOMException('Salt mining aborted', 'AbortError')

/**
 * Mine locally. Uses a Web Worker pool where the platform has one (the main
 * thread stays free, so the scanner animates and Cancel is instant), and falls
 * back to a chunked main-thread loop that yields between chunks — the node test
 * environment and any worker-less build take that path with identical results.
 */
export async function mineLocally(args: LocalMineArgs): Promise<LocalMineResult> {
  const canUseWorkers =
    !args.forceMainThread && typeof Worker !== 'undefined' && typeof URL !== 'undefined'
  if (canUseWorkers) {
    try {
      return await mineWithWorkers(args)
    } catch (e) {
      // An AbortError is the user's Cancel, not a broken worker — never retried
      // on the main thread, or Cancel would silently restart the search.
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      if (e instanceof Error && e.message.startsWith('No 0x88 salt')) throw e
      // Anything else (CSP blocking workers, a bundler that did not emit the
      // chunk) degrades to the single-threaded loop rather than to the network.
    }
  }
  return mineOnMainThread(args)
}

async function mineOnMainThread(args: LocalMineArgs): Promise<LocalMineResult> {
  const { factory, initCodeHash, prefix, maxAttempts, onProgress, signal } = args
  const chunkSize = args.chunkSize ?? MAIN_THREAD_CHUNK
  const pre = create2Preimage(factory, initCodeHash, prefix)
  const started = Date.now()
  let attempts = 0
  let bestBits = 0
  let bestAddress: string | null = null
  let samples: string[] = []

  for (let from = 0, step = 0; from < maxAttempts; step++) {
    if (signal?.aborted) throw aborted()
    const count = Math.min(args.chunkSize ? chunkSize : chunkAt(step, chunkSize), maxAttempts - from)
    const r = mineChunk({ pre, from, count, sampleEvery: SAMPLE_EVERY })
    attempts += r.tried
    if (r.bestBits > bestBits) {
      bestBits = r.bestBits
      bestAddress = r.bestAddress
    }
    if (r.samples.length) samples = [...samples, ...r.samples].slice(-SAMPLE_WINDOW)
    if (r.hit != null && r.hitAddress) {
      onProgress?.(progressOf(attempts, started, bestBits, bestAddress, samples, 'local', 1))
      return { salt: saltFor(prefix, r.hit), predicted: getAddress(r.hitAddress), attempts, workers: 1 }
    }
    onProgress?.(progressOf(attempts, started, bestBits, bestAddress, samples, 'local', 1))
    from += count
    // Yield so the scanner paints and an abort lands between chunks, not after.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw noSaltError(maxAttempts)
}

async function mineWithWorkers(args: LocalMineArgs): Promise<LocalMineResult> {
  const { factory, initCodeHash, prefix, maxAttempts, onProgress, signal } = args
  const stride = workerCount()
  const started = Date.now()
  const workers: Worker[] = []
  const tried = new Array<number>(stride).fill(0)
  let bestBits = 0
  let bestAddress: string | null = null
  let samples: string[] = []
  let done = 0

  return new Promise<LocalMineResult>((resolve, reject) => {
    const stop = () => {
      signal?.removeEventListener('abort', onAbort)
      for (const w of workers) w.terminate()
    }
    const onAbort = () => {
      stop()
      reject(aborted())
    }
    if (signal?.aborted) return reject(aborted())
    signal?.addEventListener('abort', onAbort)

    const total = () => tried.reduce((s, n) => s + n, 0)
    const report = () =>
      onProgress?.(progressOf(total(), started, bestBits, bestAddress, samples, 'local', stride))

    for (let index = 0; index < stride; index++) {
      let worker: Worker
      try {
        worker = new Worker(new URL('./salt-miner.worker.ts', import.meta.url), { type: 'module' })
      } catch (e) {
        stop()
        return reject(e)
      }
      workers.push(worker)
      worker.onerror = (e) => {
        stop()
        reject(new Error(`Salt miner worker failed: ${e.message || 'unknown error'}`))
      }
      worker.onmessage = (event: MessageEvent<MineWorkerOut>) => {
        const msg = event.data
        tried[index] = msg.tried
        if (msg.type === 'hit') {
          const attempts = total()
          stop()
          if (msg.samples.length) samples = [...samples, ...msg.samples].slice(-SAMPLE_WINDOW)
          // The near-miss stays the near-miss. Reporting 14/14 here would put a
          // frame on screen claiming a perfect match while the panel still says
          // "searching" — the hit is announced by resolving, and shown as the
          // locked address, not by overwriting the closest-so-far figure.
          onProgress?.(progressOf(attempts, started, bestBits, bestAddress, samples, 'local', stride))
          resolve({ salt: saltFor(prefix, msg.counter), predicted: getAddress(msg.address), attempts, workers: stride })
          return
        }
        if (msg.type === 'exhausted') {
          done++
          if (done === stride) {
            stop()
            reject(noSaltError(maxAttempts))
          }
          return
        }
        if (msg.bestBits > bestBits) {
          bestBits = msg.bestBits
          bestAddress = msg.bestAddress
        }
        if (msg.samples.length) samples = [...samples, ...msg.samples].slice(-SAMPLE_WINDOW)
        report()
      }
      const start: MineWorkerStart = {
        type: 'start',
        factory,
        initCodeHash,
        prefix,
        from: index,
        stride,
        chunk: WORKER_CHUNK,
        // Each worker owns 1/stride of the budget, so the pool's total tries
        // match the single-threaded cap rather than multiplying it.
        maxTries: Math.ceil(maxAttempts / stride),
        sampleEvery: SAMPLE_EVERY,
      }
      worker.postMessage(start)
    }
  })
}

function progressOf(
  attempts: number,
  started: number,
  bestBits: number,
  bestAddress: string | null,
  samples: readonly string[],
  mode: 'local' | 'rpc',
  workers: number,
): MineProgress {
  const elapsed = Math.max(1, Date.now() - started)
  return { attempts, rate: (attempts / elapsed) * 1000, bestBits, bestAddress, samples, mode, workers }
}

function noSaltError(maxAttempts: number): Error {
  return new Error(`No 0x88 salt found in ${maxAttempts} attempts — retry (random restart) or raise maxAttempts.`)
}

// ── worker protocol (shared with salt-miner.worker.ts) ───────────────────────
export interface MineWorkerStart {
  type: 'start'
  factory: Address
  initCodeHash: Hex
  prefix: Uint8Array
  /** This worker's residue: it walks from, from+stride, from+2·stride, … */
  from: number
  stride: number
  chunk: number
  maxTries: number
  sampleEvery: number
}

export type MineWorkerOut =
  | { type: 'progress'; tried: number; bestBits: number; bestAddress: string | null; samples: string[] }
  | { type: 'hit'; counter: number; address: string; tried: number; samples: string[] }
  | { type: 'exhausted'; tried: number }
