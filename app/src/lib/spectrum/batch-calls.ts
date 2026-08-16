import type { Address, Hex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// WALLET CALL-BATCHING (EIP-5792 / post-Pectra 7702) — the clunk compressor.
// Modern wallets take a LIST of calls behind ONE confirmation; older wallets
// can't, so every consumer keeps its sequential path as the fallback.
//
// This module speaks EIP-1193 DIRECTLY (wallet_getCapabilities /
// wallet_sendCalls / wallet_getCallsStatus) rather than going through a viem
// wallet client: a client object captured before a mid-run chain switch goes
// STALE (this morning's walletChain closure bug, same class), while the raw
// provider always routes to the wallet's live session and the 5792 params
// carry the target chain explicitly.
//
// HONESTY RULES for consumers:
//  · support is per WALLET per CHAIN — probe, never assume; cache per session.
//  · an atomic wallet may revert the WHOLE batch when one call reverts. A
//    consumer whose calls are independent must fall back to sequential on
//    batch failure — a failed batch is a routing outcome, not a result.
//  · a TIMEOUT is not a failure: the batch may still land. The consumer must
//    NOT re-send those calls in-session.
//  · never claim atomicity on the fallback path.
//  · atomicity is OPT-IN per batch (`atomicRequired`), because it is not always
//    the safer setting. Independent calls (the crank sweep) are better off
//    partially landing than all reverting. A batch whose calls are NOT
//    independent must demand it: the atomic launch's deploy + first mint is
//    one ceremony, and a partial run that deploys without minting reopens the
//    exact window it exists to close (launch-first-mint.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface Eip1193Like {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

export interface BatchCall {
  to: Address
  data: Hex
  value?: bigint
}

/** Parse a wallet_getCapabilities response for atomic-batch support on one
 *  chain. Pure + shape-defensive: EIP-5792 drafts used `atomicBatch:
 *  {supported}`, the final spec uses `atomic: {status: 'supported'|'ready'}`
 *  ('ready' = the wallet will 7702-upgrade on first use — counts). Keys are
 *  hex chain ids, occasionally decimal strings. Unknown → false. */
export function parseAtomicSupport(caps: unknown, chainId: number): boolean {
  if (!caps || typeof caps !== 'object') return false
  const byChain = caps as Record<string, unknown>
  const entry = byChain[`0x${chainId.toString(16)}`] ?? byChain[String(chainId)]
  if (!entry || typeof entry !== 'object') return false
  const e = entry as { atomicBatch?: { supported?: unknown }; atomic?: { status?: unknown } }
  if (e.atomicBatch?.supported === true) return true
  const status = e.atomic?.status
  return status === 'supported' || status === 'ready'
}

/** Probe the wallet for batch support on `chainId`. Never throws — a wallet
 *  without the method is a wallet without the feature. */
export async function probeBatchSupport(provider: Eip1193Like, address: Address, chainId: number): Promise<boolean> {
  try {
    const caps = await provider.request({ method: 'wallet_getCapabilities', params: [address] })
    return parseAtomicSupport(caps, chainId)
  } catch {
    return false
  }
}

export type BatchOutcome =
  | { kind: 'success'; okCount: number }
  | { kind: 'failure' } // rejected/reverted/refused — the sequential fallback may run
  | { kind: 'timeout' } // still pending past the deadline — do NOT re-send these calls

const toHex = (v: bigint) => `0x${v.toString(16)}`

/** The `wallet_sendCalls` params this module would send. Split out so a test can
 *  read what goes on the wire without a wallet, and so `atomicRequired` is one
 *  value in one place rather than a literal buried in a request. */
export function sendCallsParams(
  address: Address,
  chainId: number,
  calls: BatchCall[],
  atomicRequired: boolean,
): Record<string, unknown> {
  return {
    version: '2.0.0',
    from: address,
    chainId: `0x${chainId.toString(16)}`,
    atomicRequired,
    calls: calls.map((c) => ({
      to: c.to,
      data: c.data,
      ...(c.value != null && c.value > 0n ? { value: toHex(c.value) } : {}),
    })),
  }
}

/** Send `calls` as one wallet batch on `chainId` and poll to a terminal
 *  state. Status parsing is generation-defensive: wallets have returned
 *  status 'CONFIRMED'/'success'/200 with per-call receipts whose status is
 *  'success'/'reverted'/'0x1'/'0x0'. Unknown terminal shapes classify as
 *  failure — the consumer's sequential fallback is the safe direction.
 *
 *  `atomicRequired` defaults to false (independent calls, the crank sweep's
 *  posture). Pass true when a partial run is worse than no run: the wallet then
 *  refuses the batch outright rather than executing part of it, and that refusal
 *  arrives here as `failure`, which is the consumer's cue to take its honest
 *  non-atomic path instead. */
export async function runBatch(
  provider: Eip1193Like,
  address: Address,
  chainId: number,
  calls: BatchCall[],
  opts: { timeoutMs?: number; pollMs?: number; onSent?: () => void; atomicRequired?: boolean } = {},
): Promise<BatchOutcome> {
  let id: string
  try {
    const res = await provider.request({
      method: 'wallet_sendCalls',
      params: [sendCallsParams(address, chainId, calls, opts.atomicRequired === true)],
    })
    const rid = typeof res === 'string' ? res : (res as { id?: unknown })?.id
    if (typeof rid !== 'string' || !rid) return { kind: 'failure' }
    id = rid
  } catch {
    return { kind: 'failure' } // user rejected, or the wallet refused the method/version
  }
  opts.onSent?.()

  const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
  for (;;) {
    if (Date.now() > deadline) return { kind: 'timeout' }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1_500))
    try {
      const s = (await provider.request({ method: 'wallet_getCallsStatus', params: [id] })) as {
        status?: unknown
        receipts?: { status?: unknown }[]
      }
      const status = String(s?.status ?? '').toLowerCase()
      if (status === 'pending' || status === '100' || status === '') continue
      const ok = status === 'confirmed' || status === 'success' || status === '200'
      if (!ok) return { kind: 'failure' }
      const receipts = Array.isArray(s.receipts) ? s.receipts : []
      const okCount =
        receipts.length === 0
          ? calls.length // no per-call receipts — the terminal success covers the set
          : receipts.filter((r) => {
              const rs = String(r?.status ?? '').toLowerCase()
              return rs === 'success' || rs === '0x1' || rs === '1'
            }).length
      return { kind: 'success', okCount }
    } catch {
      // transient poll failure — keep polling until the deadline
    }
  }
}
