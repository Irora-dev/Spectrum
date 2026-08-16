import { chunkAt, create2Preimage, mineChunk, type MineWorkerOut, type MineWorkerStart } from './create2-mine'

// One thread of the salt search. It owns the residues `from, from+stride,
// from+2·stride, …` — disjoint from every sibling by construction, so the pool
// never hashes the same candidate twice.
//
// It is stopped by TERMINATION, not by a message: the main thread calls
// worker.terminate() on a hit or on Cancel, which kills the loop mid-chunk. That
// is what keeps cancellation instant while the loop stays tight.
//
// `self` is narrowed by hand: this app's tsconfig ships the DOM lib (not
// WebWorker), where Window.postMessage has a different signature.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MineWorkerStart>) => void) | null
  postMessage: (m: MineWorkerOut) => void
}

ctx.onmessage = (event) => {
  const msg = event.data
  if (msg?.type !== 'start') return
  const { factory, initCodeHash, prefix, from, stride, chunk, maxTries, sampleEvery } = msg
  const pre = create2Preimage(factory, initCodeHash, prefix)

  let tried = 0
  let steps = 0
  let bestBits = 0
  let bestAddress: string | null = null

  const step = () => {
    // Ramped: the first chunk is small so the scanner has real candidates within
    // milliseconds, which matters because the whole search can end inside what
    // used to be a single chunk.
    const count = Math.min(chunkAt(steps++, chunk), maxTries - tried)
    if (count <= 0) {
      ctx.postMessage({ type: 'exhausted', tried })
      return
    }
    const r = mineChunk({ pre, from: from + tried * stride, count, stride, sampleEvery })
    tried += r.tried
    if (r.bestBits > bestBits) {
      bestBits = r.bestBits
      bestAddress = r.bestAddress
    }
    if (r.hit != null && r.hitAddress) {
      ctx.postMessage({ type: 'hit', counter: r.hit, address: r.hitAddress, tried, samples: r.samples })
      return
    }
    ctx.postMessage({ type: 'progress', tried, bestBits, bestAddress, samples: r.samples })
    // Break the loop so the message queue flushes between chunks; a tight
    // uninterrupted loop would starve postMessage and the progress readout.
    setTimeout(step, 0)
  }
  step()
}
