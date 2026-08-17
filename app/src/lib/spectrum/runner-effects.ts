import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { batcherAbi, BatchComposeRefusal, type ComposedBatchBuy, type BatchSimResult } from './batcher'
import { encodePortfolioBatchBuy, portfolioBatcherAbi, portfolioBatcherAbiGen2, type ComposedPortfolioBatchBuy } from './portfolio-batcher'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'
import { batchFeeBpsFor } from './allocation'
import { erc20ApproveAbi } from './abis-v2'
import type { Eip1193Like } from './batch-calls'
import { parseAtomicSupport } from './batch-calls'
import { revertDataOf, friendlyRevert } from './decode-revert'
import { recordFailure } from './failure-log'
import { fetchLifiQuote, fetchLifiStatus, LIFI_TARGETS, type LifiQuote, LIFI_NATIVE } from './lifi'
import { approvalPlan } from './migrate-math'
import { addBridge } from './bridge-pending'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { computeRefuelGasWei } from './refuel'
import { refuelFromTokenUnits } from './use-bridge-leg'
import { compositionLawsBroken, diffDisplayedVsSigned, diffDisplayedVsSignedPortfolio, portfolioCompositionLawsBroken, type ShownStepReview } from './displayed-vs-signed'
import type { FundingStep } from './funding-plan'
import { RunnerRefusal, type RunnerEffects, type SimulatedStep } from './execution-runner'
import { showChainId, showSymbol } from './safe-copy'
import { ALLOWANCE_HOLDER, createProxyZeroExFetcher, validateLegQuote, ZeroExQuoteRefusal, type ZeroExFetcher } from './zeroex-quote'
import { probeWritable } from './submission-store'

// ─────────────────────────────────────────────────────────────────────────────
// THE WALLET PLUMBING (2026-08-04) — the effects the pure runner cannot do
// itself, built against the runner's 13 laws and AUDITED AT BIRTH with an
// adversarial wallet (runner-effects.test.ts): every law the runner states is
// a claim about wallet behaviour, and this layer is where a lying wallet
// meets those claims.
//
// React-free by construction: the hook (use-execution-runner.ts) acquires the
// provider/clients from wagmi and injects them here, so every law below is
// provable with fakes. The 5792 path speaks the RAW provider (batch-calls.ts'
// stale-client lesson); the plain path takes an injected sender so the hook
// can use the house wagmi idiom.
//
// LAWS AT THIS LAYER (the runner's laws continue above; these are the
// wallet-facing ones the adversarial audit forced into writing):
//  P1. UNKNOWN STATUS SHAPES HOLD, NEVER CLASSIFY. `runBatch` (the clunk
//      compressor) maps unparseable terminal shapes to "failure" because its
//      consumers have a safe sequential fallback. MONEY DOES NOT: a failure
//      verdict tells the runner the money did not move, and if that is wrong
//      the double-buy returns. Anything this parser cannot read is AMBIGUITY —
//      `resolve` answers null and the poll keeps holding.
//  P2. A RECEIPT ANSWERS FOR ITS OWN HASH ONLY. A wallet/RPC returning a
//      receipt whose transactionHash differs from the one asked about is
//      answering a different question — hold, never adopt (the adversarial
//      provider's wrong-receipt case).
//  P3. A CLAIMED SUCCESS WITH A REVERTED RECEIPT IS A FAILURE. The wrapper
//      status is the wallet's claim; the receipt is the chain's. When they
//      disagree, the chain wins (success-for-reverted case).
//  P4. THE SAME ID FOR TWO STEPS IS AMBIGUITY BY CONSTRUCTION. Nothing can
//      say which step a shared id reports on, so the second step resolves
//      null forever and ends `unresolved` with its record intact — a lying
//      wallet is converted into held ambiguity, never into a false success.
//  P5. THE DEADLINE IS RE-CHECKED AGAINST THE CHAIN'S OWN CLOCK at simulate
//      time (chainNowSec law): a plan composed long ago, or against a device
//      clock, refuses before any signature — 0 < deadline − chainNow ≤ 30min.
//  P6. THE SIM RESULT IS CHECKED, NOT TRUSTED (B2's shape on the batch path):
//      required legs may not be skipped, every kept leg's out must meet the
//      floor WE composed, and the batch may not spend more than it pulls. A
//      disagreement between our composition and the simulated result refuses.
//  P7. NOTHING SIGNS WHAT WAS NOT SIMULATED — the bytes eth_call'd are the
//      bytes signed (encoded ONCE, at simulate; submit reuses the object).
//  P8. THE BYTES MATCH THE REVIEW (the displayed-vs-signed gate, security
//      queue item 1, 2026-08-07). The exact prepared calls are decoded BACK
//      and diffed against what the review rendered — every leg's asset,
//      budget, floor and skippability, the funding asset and total, the
//      recipient, the native value, and each approval's token, spender and
//      amount. The recipient check above reads the composed OBJECT; this
//      reads the BYTES, so a divergence in or after encoding is caught too.
//      A missing shown record REFUSES — a verification that silently skips
//      when its input is absent is law 8's failure in a new coat.
//
// STATED v1 BOUNDS (capability-grained truth, said not hidden):
//  · BRIDGE STEPS DO NOT EXECUTE (slice B) — `planExecutable` refuses the
//    whole plan up front so no step runs before a bridge that cannot follow.
//  · ERC-20-FUNDED steps simulate approve+batch via eth_simulateV1
//    (`simulateCalls`) where the RPC supports it; where it does not, the step
//    REFUSES rather than signing a sequence we could not preview. Native
//    funding (the 3.2 critical path) simulates everywhere. The sequential
//    approve-then-sim-then-batch shape for such RPCs is a named follow-up —
//    it needs approvals as their own plan steps.
// ─────────────────────────────────────────────────────────────────────────────

/** 30 minutes — the outer bound on how far a composed deadline may sit past
 *  the CHAIN's clock. Composed plans target ~minutes; past this the plan is
 *  stale (or the clock it was composed against was not the chain's). */
export const MAX_DEADLINE_WINDOW_SEC = 1_800

export interface WalletOps {
  /** The live raw EIP-1193 session (5792 + capability probes). A captured
   *  client goes stale on chain switch; the raw provider does not. */
  provider: Eip1193Like
  /** Sign + send ONE plain transaction on `chainId`, returning its hash. The
   *  hook wires wagmi's own sender here (house idiom); tests wire fakes. */
  sendTransaction: (chainId: number, tx: { to: Address; data: Hex; value: bigint }) => Promise<Hex>
}

export interface RunnerEffectsContext {
  /** The planned account — every guard compares against this. */
  account: Address
  /** The single ACTIVE address the wallet reports right now (law 1). The hook
   *  supplies this from wagmi's active account — never a group. */
  activeAccount: () => Address | null
  wallet: WalletOps
  /** Read-only client per chain; null = no connection configured. */
  client: (chainId: number) => PublicClient | null
  /** The deployed batcher on a chain; null until the ceremony seats it. */
  batcherAddress: (chainId: number) => Address | null
  /** The chain's settlement token — what a bridge step moves. null = the
   *  chain cannot fund bridges here, and any plan carrying one refuses whole. */
  settlementAddress?: (chainId: number) => Address | null
  /** The settlement token's decimals AS CONFIGURED (the deployment book's
   *  settlementDecimalsFor). Absent → 6, every canonical settlement today.
   *  This is the EXPECTATION half of law S2b (cold-review INFO-1): before any
   *  cents→raw conversion signs, the runner reads the token's own decimals()
   *  and refuses on mismatch — a config lie mis-sizes a plan upstream, but it
   *  can never mis-scale a floor past this check. */
  settlementDecimals?: (chainId: number) => number
  /** Test seams for the bridge step's two network oracles. Defaults are the
   *  REAL lifi.ts functions (the guarded parse with the pinned-target law). */
  lifiQuote?: typeof fetchLifiQuote
  /** The same-chain sale fallback's quote seam (0x through the operator's
   *  proxy). Injected in tests; defaults to the proxy fetcher the token page
   *  already trades through. */
  zeroExQuote?: ZeroExFetcher
  lifiStatus?: typeof fetchLifiStatus
  /** WHICH CONTRACT THIS RUN SPEAKS (the executor migration, 2026-08-13).
   *  'legacy' (absent = legacy — the pre-migration default, byte-identical) =
   *  batcher.ts's retired shape; 'portfolio' = SpectrumPortfolioBatcher via
   *  the 0x compose path. EXPLICIT, never inferred from the composed object:
   *  a silent switch on a money path is the incident class this lane refuses. */
  engine?: 'legacy' | 'portfolio'
  /** Compose the exact batch for one funding step — the flow's plan context
   *  (assemble-batch.ts). Throws BatchComposeRefusal in review-grade words. */
  composeStep: (step: FundingStep) => Promise<ComposedBatchBuy>
  /** The PORTFOLIO engine's composer (assembleZeroExBatchBuyLive → typed
   *  args). REQUIRED when engine==='portfolio'; its absence there refuses in
   *  a sentence rather than falling back to the legacy composer — the two
   *  contracts' calldata are mutually unintelligible. */
  composePortfolioStep?: (step: FundingStep) => Promise<ComposedPortfolioBatchBuy>
  /** Exact-amount approvals the step needs before the batch (ERC-20 funding).
   *  Empty/omitted = native funding. */
  approvalsFor?: (step: FundingStep) => { token: Address; amountRaw: bigint }[]
  /** What the review RENDERED for this step (law P8) — the gate decodes the
   *  prepared bytes back and diffs them against this before anything is
   *  simulated or signed. REQUIRED, and null refuses: the gate must not be
   *  skippable by omission. */
  shownFor: (step: FundingStep) => ShownStepReview | null
  /** Does THIS APP compose a burn route on this chain? (config-read; the F6
   *  burn law consumes it — see displayed-vs-signed.) */
  burnComposable?: (chainId: number) => boolean
  /** USD per whole native token, for the gas measurement the comparator
   *  consumes. Null = unreadable — gasCostUsd stays null, never zero. */
  nativeUsd?: (chainId: number) => number | null
  writeExecLog: RunnerEffects['writeExecLog']
  onState?: RunnerEffects['onState']
  shouldStop?: () => boolean
  store?: RunnerEffects['store']
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The measured extras this layer adds to the runner's opaque SimulatedStep —
 *  the review and the route comparator read them; the runner does not. */
export interface MeasuredSimulatedStep extends SimulatedStep {
  /** What executing this step costs in gas, USD. Null = unreadable. */
  gasCostUsd: number | null
  /** The simulated BatchResult — the review's data (readiness §3). NULL when
   *  the simulation refused/never ran: a zeroed result would read as "zero
   *  outs", which is a verdict off an error (the read-failed law). */
  result: BatchSimResult | null
  /** The PORTFOLIO engine's simulated result (bought per leg + refunded) —
   *  null on the legacy engine and on refused/never-ran, same law as above. */
  portfolioResult?: { bought: readonly bigint[]; refunded: bigint } | null
}

/** Refuse a plan UP FRONT for capabilities this build does not have — before
 *  any step runs (a mid-plan refusal after money moved is a partial; a known
 *  incapacity must refuse whole). */
export function planExecutable(
  steps: FundingStep[],
  opts: {
    client: (chainId: number) => PublicClient | null
    batcherAddress: (chainId: number) => Address | null
    settlementAddress?: (chainId: number) => Address | null
  },
): { ok: true } | { ok: false; reason: string } {
  for (const s of steps) {
    if (s.action.kind === 'bridge') {
      // THE BRIDGE STEP IS LIVE (the owner's build order, 2026-08-14 ~14:0x) — a
      // bridge is admitted exactly when every fact it depends on exists:
      // clients on BOTH chains, the SIGNING chain's pinned LI.FI diamond
      // (lifi.ts's own allowlist — an unpinned chain fails closed, its law),
      // and a settlement token on both ends. Anything missing refuses WHOLE,
      // before any step runs — a mid-plan incapacity is a partial; a known
      // one must refuse at the door.
      const { fromChainId, toChainId } = s.action
      if (!opts.client(fromChainId) || !opts.client(toChainId))
        return { ok: false, reason: `We have no connection to one of the networks this transfer crosses (${showChainId(fromChainId)} → ${showChainId(toChainId)}) — nothing was sent.` }
      if (!LIFI_TARGETS[fromChainId])
        return { ok: false, reason: `No verified transfer-routing contract is pinned for network ${showChainId(fromChainId)} — nothing was sent.` }
      if (!opts.settlementAddress?.(fromChainId) || !opts.settlementAddress?.(toChainId))
        return { ok: false, reason: `A network in this transfer has no settlement token configured, so the transfer cannot be funded — nothing was sent.` }
      continue
    }
    if (s.action.kind === 'sell') {
      // A SALE IS LIVE (the owner's sell-side order, 2026-08-14 ~19:3x): admitted
      // exactly when its facts exist — a client, the chain's pinned LI.FI
      // diamond (a same-chain swap signs against the same allowlisted
      // target), and the settlement token the proceeds land in. NO BATCHER
      // REQUIRED: a pure cash-out must run on a chain that never seated one.
      const sellChainId = s.action.chainId
      if (!opts.client(sellChainId))
        return { ok: false, reason: `We have no connection to network ${showChainId(sellChainId)}, so this plan cannot run — nothing was sent.` }
      if (!LIFI_TARGETS[sellChainId])
        return { ok: false, reason: `No verified swap-routing contract is pinned for network ${showChainId(sellChainId)}, so its sales cannot run — nothing was sent.` }
      if (!opts.settlementAddress?.(sellChainId))
        return { ok: false, reason: `Network ${showChainId(sellChainId)} has no settlement token configured, so sale proceeds would have nowhere to land — nothing was sent.` }
      continue
    }
    const chainId = s.action.chainId
    if (!opts.client(chainId))
      return { ok: false, reason: `We have no connection to network ${showChainId(chainId)}, so this plan cannot run — nothing was sent.` }
    if (!opts.batcherAddress(chainId))
      return {
        ok: false,
        reason: `No batch contract is deployed on network ${showChainId(chainId)} yet, so this plan cannot run — nothing was sent.`,
      }
  }
  return { ok: true }
}

// EIP-5792 status codes (final spec) + the legacy string shapes wallets have
// actually returned. 600 = partially-reverted (non-atomic wallets) — a
// failure for money.
export type MoneyCallsVerdict =
  | { kind: 'pending' }
  | { kind: 'success' }
  /** `partial` = SOME OF THE MONEY LANDED. Structural rather than only in the
   *  sentence, because the runner has to ACT on it: a partial failure must keep
   *  its submission record, and a total one may clear it. R3 (review
   *  2026-08-07): the record was cleared on every resolved failure, including
   *  this one, so a retry re-sent legs that had already executed. */
  | { kind: 'failure'; message: string; partial?: boolean }
  | { kind: 'unknown' }

/** The MONEY-grade wallet_getCallsStatus parser (laws P1/P3). Exported so the
 *  adversarial suite can drive it directly. */
export function parseCallsStatusForMoney(raw: unknown): MoneyCallsVerdict {
  if (!raw || typeof raw !== 'object') return { kind: 'unknown' }
  const s = raw as { status?: unknown; receipts?: unknown }
  const status = s.status
  const norm = typeof status === 'number' ? String(status) : typeof status === 'string' ? status.toLowerCase() : null
  if (norm === null) return { kind: 'unknown' }
  if (norm === '100' || norm === 'pending') return { kind: 'pending' }

  const receipts = Array.isArray(s.receipts) ? (s.receipts as { status?: unknown; transactionHash?: unknown }[]) : null
  const anyReverted =
    receipts?.some((r) => {
      const rs = typeof r?.status === 'number' ? String(r.status) : typeof r?.status === 'string' ? r.status.toLowerCase() : ''
      return rs === 'reverted' || rs === '0x0' || rs === '0'
    }) ?? false

  if (norm === '200' || norm === 'confirmed' || norm === 'success') {
    // LAW P3 — the chain's receipts outrank the wallet's wrapper claim.
    if (anyReverted)
      // some legs landed and some reverted — money moved
      return {
        kind: 'failure',
        partial: true,
        message: 'The wallet reported this batch confirmed, but part of it reverted on chain. Check your wallet activity before retrying.',
      }
    return { kind: 'success' }
  }
  if (norm === '400' || norm === '500' || norm === '600' || norm === 'failed' || norm === 'reverted' || norm === 'error') {
    return {
      kind: 'failure',
      // 600 is the wallet's own "partially executed" code
      partial: norm === '600',
      message:
        norm === '600'
          ? 'Part of this batch went through and part did not — check your wallet activity for what landed before doing anything else.'
          : 'This batch did not go through. Nothing needs to be undone — check your wallet activity to confirm, then retry when ready.',
    }
  }
  // LAW P1 — an unrecognized shape is ambiguity, never a verdict.
  return { kind: 'unknown' }
}

/** Best-effort RequiredLegFailed(index) recovery by replaying the exact bytes
 *  at the failing block. decodeErrorResult verifies the selector, so a wrong
 *  guess about the error's shape yields undefined — never a wrong index. */
const requiredLegFailedAbi = parseAbi(['error RequiredLegFailed(uint256 index)'])
async function recoverFailedLegIndex(
  client: PublicClient,
  tx: { to: Address; data: Hex; value: bigint; account: Address },
  blockNumber: bigint,
): Promise<number | undefined> {
  try {
    await client.call({ to: tx.to, data: tx.data, value: tx.value, account: tx.account, blockNumber })
    return undefined // replay did not revert — the state moved on; claim nothing
  } catch (e) {
    const data = revertDataOf(e)
    if (!data) return undefined
    try {
      const decoded = decodeErrorResult({ abi: requiredLegFailedAbi, data })
      const idx = Number(decoded.args?.[0])
      return Number.isInteger(idx) && idx >= 0 && idx < 10_000 ? idx : undefined
    } catch {
      return undefined
    }
  }
}

interface PreparedCall {
  to: Address
  data: Hex
  value: bigint
}

/** What simulate() prepares and submit() signs — one encoding, one object
 *  (law P7). `calls` = approvals then the batch, in submission order. */
interface PreparedStep {
  chainId: number
  calls: PreparedCall[]
  /** Index of the batch call within `calls` (approvals precede it). */
  batchIndex: number
}

/** What a bridge simulate() prepares and its submit() signs — the quote's
 *  transaction VERBATIM (law B1: the bytes the guarded parse validated are
 *  the bytes signed; lifi.ts pinned the target, the spender and the echo).
 *  The approvals ride the same object so the wallet sequence is decided at
 *  simulate time, like the batch path's PreparedStep. */
interface BridgePrepared {
  kind: 'bridge'
  fromChainId: number
  toChainId: number
  holder: Address
  fromToken: Address
  amountRaw: bigint
  quote: LifiQuote
  /** exact-amount approvals owed before the send (approvalPlan's sequence) */
  approvals: { token: Address; spender: Address; value: bigint }[]
}

/** What a sale simulate() prepares and its submit() signs — the same-chain
 *  LI.FI quote VERBATIM (law S1 = B1's shape: lifi.ts's guarded parse pinned
 *  the target, the spender and the echo; a same-chain receipt IS the
 *  settlement, so no arrival oracle exists or is needed). */
interface SellPrepared {
  kind: 'sell'
  chainId: number
  holder: Address
  asset: Address
  sellRaw: bigint
  settlement: Address
  /** What the plan drew on, in raw settlement units. The router's own
   *  enforced minimum must clear it BEFORE anything signs (law S2) — and
   *  on-chain the router reverts rather than under-fill, so a SUCCESS
   *  receipt itself proves the floor held. */
  floorRaw: bigint
  quote: LifiQuote
  approvals: { token: Address; spender: Address; value: bigint }[]
}

/** What P8 actually verified, keyed by the prepared step. `submit()` re-reads
 *  `sim.request.calls` and signs them, and until now it did so with NO
 *  re-verification — so the window the P8 header names, "any code that touches
 *  the prepared call afterwards", was entirely AFTER the only check (A6
 *  review, 2026-08-07). A WeakMap so a step that never submits is collected. */
/** Wait for one receipt, bounded — an approval that cannot be seen landing
 *  must stop the transfer that depends on it (never a verdict, a refusal). */
async function awaitReceiptOk(client: PublicClient, hash: Hex, tries = 90, delayMs = 2_000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await client.getTransactionReceipt({ hash })
      if (r?.transactionHash?.toLowerCase() === hash.toLowerCase()) return r.status === 'success'
    } catch {
      /* not found yet */
    }
    await new Promise((res) => setTimeout(res, delayMs))
  }
  return false
}

const verifiedBytes = new WeakMap<object, string>()

/**
 * Frame a decoded revert as what it ACTUALLY was on this path: a preview.
 *
 * ⚠ THE DECODED SENTENCES ARE SHARED with the mined-revert path, so none of
 * them may claim a chain event — and equally, none of them says on its own that
 * nothing was signed. This is the caller's half of that contract: the preview
 * call sites append the fact that distinguishes them, once, in one place, so a
 * refusal can never again read as "your transaction reverted" when no
 * transaction was ever created (the owner, 2026-08-15 — six of them).
 *
 * Idempotent: a message that already says nothing was signed is left alone,
 * so the generic fallbacks do not end up saying it twice.
 */
export function asPreviewRefusal(message: string): string {
  const m = (message ?? '').trim()
  if (!m) return 'This batch was refused in preview — nothing was signed and nothing was sent.'
  if (/nothing was signed|nothing was sent/i.test(m)) return m
  const tail = 'This was a check before signing, so nothing was signed and nothing was sent.'
  return /[.!?]$/.test(m) ? `${m} ${tail}` : `${m}. ${tail}`
}

/**
 * A PREVIEW THAT CANNOT FAIL IS NOT A PREVIEW.
 *
 * ⚠⚠ THIS IS THE GENERALISED FORM OF THE MISTAKE THAT COST THE MOST on
 * 2026-08-15. An `eth_call` control used to diagnose a live refusal was
 * "passing" — and it also passed with a ZERO allowance and no approval, which
 * no honest execution can do. It could not produce a negative, so its positives
 * meant nothing, and two wrong root causes were shipped on the strength of them.
 *
 * The same hazard applies to the preview this runner signs against: if the
 * node's simulation does not actually enforce the conditions we are relying on
 * it to check, a green preview is not evidence and we would be signing blind
 * while believing we had checked. Not hypothetical — the two mechanisms in use
 * here (`eth_call` and `eth_simulateV1`) demonstrably disagreed on this very
 * contract, on this very chain, on the same bytes.
 *
 * So before a PASS is trusted, the same machinery is handed a batch that MUST
 * fail — the identical calldata with an unsatisfiable floor — and is required
 * to reject it. A mechanism that accepts the impossible has told us its
 * verdicts are worthless, and the honest response is to say so rather than
 * sign. This is cheap (one extra read, cached per chain) and it converts a
 * silent class of false confidence into a sentence.
 */
export function poisonFloor(args: readonly unknown[]): unknown[] {
  const legs = (args[0] as { minBuyAmount: bigint }[]) ?? []
  // an amount no route on earth delivers; every other byte is untouched, so a
  // mechanism that enforces floors at all must reject exactly this and nothing
  // about the rest of the batch has changed
  const IMPOSSIBLE = (1n << 250n)
  return [legs.map((l) => ({ ...l, minBuyAmount: IMPOSSIBLE })), args[1], args[2], args[3]]
}

/** Injected only so the recorder can be pinned without faking a global clock. */
const nowIso = () => new Date().toISOString()

// ── LAW S2b — SETTLEMENT DECIMALS ARE VERIFIED, NEVER ASSUMED (cold-review
// INFO-1, 2026-08-16). Every cents→raw conversion on a money path used to
// multiply by a hardcoded 10^4 ("settlement is 6dp everywhere"), which was a
// comment, not a check: wire a >6dp settlement token and the sell floor
// (law S2) silently DISABLES — floorRaw comes out 10^(d−6)× too small and no
// quote ever trips it. Now the configured expectation (ctx.settlementDecimals,
// from the deployment book) is compared against the token's own decimals()
// once per (chain, token), cached for the session, and ANY disagreement or
// unreadable answer refuses before a single byte signs. Fail-closed both ways:
// the config can mis-size a plan upstream, but it cannot mis-scale a floor
// through this gate. ─────────────────────────────────────────────────────────
const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)'])
const confirmedDecimals = new Map<string, number>()
/** Exported for the pins: the session cache must be resettable per test. */
export function resetConfirmedSettlementDecimals(): void {
  confirmedDecimals.clear()
}
async function verifiedSettlementDecimals(
  client: PublicClient,
  ctx: RunnerEffectsContext,
  chainId: number,
  token: Address,
  scope: string,
): Promise<number> {
  const key = `${chainId}:${token.toLowerCase()}`
  const hit = confirmedDecimals.get(key)
  if (hit != null) return hit
  const expected = ctx.settlementDecimals?.(chainId) ?? 6
  let onChain: number
  try {
    onChain = Number(await client.readContract({ address: token, abi: erc20DecimalsAbi, functionName: 'decimals' }))
  } catch {
    throw new RunnerRefusal(
      'The settlement token’s decimals could not be read, so amounts cannot be converted safely. Nothing was sent.',
      scope,
    )
  }
  // [2, 36]: below 2 the cents divisor is 10^negative; above 36 exists on no
  // real token. Out-of-range is unreadable, not a value to compute with.
  if (!Number.isInteger(onChain) || onChain < 2 || onChain > 36)
    throw new RunnerRefusal(
      'The settlement token reports decimals no real token has, so amounts cannot be converted safely. Nothing was sent.',
      scope,
    )
  if (onChain !== expected)
    throw new RunnerRefusal(
      `This chain’s settlement token reports ${onChain} decimals but this app is configured for ${expected} — converting money across that disagreement could mis-scale every amount, so nothing was sent. Fix the deployment config.`,
      scope,
    )
  confirmedDecimals.set(key, onChain)
  return onChain
}
/** Integer cents → raw units at the VERIFIED decimals (2 implied cent places). */
const centsToRawAt = (cents: number, decimals: number): bigint =>
  BigInt(Math.max(0, Math.trunc(cents))) * 10n ** BigInt(decimals - 2)

/** Chains whose preview has already proven it can fail, this session. */
const previewProven = new Set<number>()
/** Chains whose preview accepted the impossible — verdicts there are worthless. */
const previewBroken = new Set<number>()

/** Exported for the pins: the honest sentence for an untrustworthy preview. */
export const PREVIEW_NOT_TRUSTWORTHY =
  'This network’s preview accepted a batch that could not possibly succeed, so a passing preview here proves nothing and we will not sign against it. Nothing was signed. Report this: it is a node problem, not your plan.'

/** How many EXTRA pre-send previews a stale-quote-class refusal earns. */
export const STALE_QUOTE_RETRIES = 2

/**
 * Does this refusal stand a real chance of clearing on a FRESH quote?
 *
 * Keyed to the route-level failures a moving pool produces, and deliberately
 * NOT to the ones that are facts about the plan, the wallet or the deployment.
 * The deny-list runs FIRST and wins: several of those sentences also contain
 * route words, and retrying an insufficient balance three times would spend
 * round-trips to deliver the same true answer more slowly. When in doubt this
 * returns false — a retry that cannot help is pure latency.
 */
export function looksStaleQuote(message: string): boolean {
  const m = (message ?? '').toLowerCase()
  // ⚠⚠ THE DENY-LIST MUST MATCH PHRASES, NOT WORDS. It read a bare `balance`,
  // and the corrected RequiredLegFailed copy says "so your balances are
  // untouched" — a REASSURANCE — so the one sentence this retry exists for was
  // being denied by its own good news. Caught by the pin that reads the live
  // copy table rather than a copy of it; it would otherwise have shipped as
  // "the retry silently never fires", which is indistinguishable from the bug
  // it was meant to fix.
  if (
    /insufficient|needs \$|wallet holds|not authorized|no route|has no batch|not configured|no batch contract|too small|more assets than|misconfigured|do not retry/.test(m)
  )
    return false
  // `(leg|sale|buy) <n> refused` — tolerant of the un-substituted `{n}`
  // placeholder so this matches the TEMPLATE as well as the rendered sentence
  return /(leg|sale|buy) \S+ refused|route refused|route failed on-chain|quote went stale|return too low|requiredlegfailed|minbuynotmet|refused this batch in simulation|preview of this batch failed/.test(m)
}

export function createRunnerEffects(ctx: RunnerEffectsContext): RunnerEffects {
  // LAW P4 — ids this run has already seen; a repeat can answer for no step.
  const seenIds = new Set<string>()

  const simulate = async (step: FundingStep): Promise<MeasuredSimulatedStep> => {
    // ── THE SALE STEP (laws S1–S3, the owner's sell-side order 2026-08-14) ───────
    // S1 THE QUOTE IS THE SIMULATION, same-chain (B1's shape): lifi.ts's
    //    guarded parse pins the execution target to the chain's allowlisted
    //    diamond, requires approval-spender === target, and echoes the exact
    //    pair/size; its transaction is stored VERBATIM — the bytes validated
    //    are the bytes signed.
    // S2 THE FLOOR CLEARS BEFORE ANYTHING SIGNS: the router's own enforced
    //    minimum (toAmountMin) must cover what the plan drew on
    //    (floorProceedsCents) — a market that moved past the floor refuses
    //    here, and on-chain the router reverts rather than under-fill, so a
    //    SUCCESS receipt proves the floor (resolve rides the tx: path).
    // S3 APPROVALS ARE EXACT, on the SOLD token, to the quote's own (pinned)
    //    spender, receipt-confirmed before the swap that spends them (B2).
    if (step.action.kind === 'sell') {
      const { chainId, symbol } = step.action
      const scope = `the sale of ${showSymbol(symbol)} on ${showChainId(chainId)}`
      const client = ctx.client(chainId)
      if (!client) throw new RunnerRefusal(`We have no connection to network ${showChainId(chainId)}. Nothing was sent.`, scope)
      const settlement = ctx.settlementAddress?.(chainId) ?? null
      if (!settlement)
        throw new RunnerRefusal('This network has no settlement token configured here, so sale proceeds would have nowhere to land. Nothing was sent.', scope)
      const asset = step.action.asset as Address
      let sellRaw = 0n
      try {
        sellRaw = BigInt(step.action.sellRaw)
      } catch {
        sellRaw = 0n
      }
      if (sellRaw <= 0n) throw new RunnerRefusal('This sale carries no readable amount. Nothing was sent.', scope)
      // NATIVE ETH sells ride LI.FI's native sentinel: no ERC-20 approval
      // exists to plan, and the quote's own tx.value carries the amount —
      // signed verbatim like every other byte (the owner's live find, 2026-08-14).
      const isNativeSale = asset.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      // S2's numbers come FIRST: the floor is what the plan draws on, and the
      // fallback lane below needs it as the independent price basis its
      // validator demands — derived before any lane is asked (law S2b: the
      // settlement token's VERIFIED decimals, refused on any disagreement).
      const settlementDec = await verifiedSettlementDecimals(client, ctx, chainId, settlement, scope)
      const floorRaw = centsToRawAt(step.action.floorProceedsCents, settlementDec)
      const quoteFn = ctx.lifiQuote ?? fetchLifiQuote
      let quote: LifiQuote
      try {
        quote = await quoteFn({
          chainId,
          fromToken: isNativeSale ? LIFI_NATIVE : asset,
          toToken: settlement,
          fromAmount: sellRaw,
          fromAddress: ctx.account,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        })
      } catch (e) {
        const lifiWords = e instanceof Error ? e.message : 'the routing service did not answer'
        // ── THE SAME-CHAIN FALLBACK LANE (the owner's live 4663 refusal,
        // 2026-08-17 20:07: LI.FI has no coverage for this pair on the young
        // chain while the token page sells the SAME asset through the 0x
        // proxy). ERC-20 → settlement only; LI.FI remains the cross-chain
        // machine and the native-sale lane. The S-laws hold unchanged:
        //   S1 — validateLegQuote pins call target AND approval spender to
        //        the baked AllowanceHolder, refuses value-carrying quotes,
        //        and the bytes it validated are stored verbatim below;
        //   S2 — the floor compares against 0x's OWN settler-enforced
        //        minimum (minBuyAmount), toAmountMin's equal — a quote that
        //        cannot state its enforced minimum is refused, never trusted;
        //   S3 — approvals plan exactly, to the pinned holder, zero-first
        //        where the token demands it (the shared approvalPlan below).
        if (isNativeSale)
          throw new RunnerRefusal(`This sale could not be quoted: ${lifiWords} Nothing was sent.`, scope)
        const zx = ctx.zeroExQuote ?? createProxyZeroExFetcher()
        try {
          const raw = await zx({
            chainId,
            sellToken: asset,
            buyToken: settlement,
            sellAmountRaw: sellRaw,
            taker: ctx.account,
            slippageBps: DEFAULT_SLIPPAGE_BPS,
          })
          const leg = validateLegQuote(raw, {
            symbol,
            chainId,
            sellToken: asset,
            buyToken: settlement,
            sellAmountRaw: sellRaw,
            // the plan supplies the floor and the settler enforces it on-chain
            // (S2 below) — the validator's bracket has no quote-derived floor
            // to protect, so it stands down by declaration; every structural
            // law (pinned target/spender, no native value, echo) still runs
            spotOutRaw: null,
            floorBasis: 'external',
          })
          let minRaw: bigint | null = null
          try {
            minRaw = raw.minBuyAmount != null ? BigInt(raw.minBuyAmount) : null
          } catch {
            minRaw = null
          }
          if (minRaw == null || minRaw <= 0n)
            throw new ZeroExQuoteRefusal(
              `$${showSymbol(symbol)}: the direct lane's quote carries no readable enforced minimum — a floor we cannot read is a floor we do not have`,
              symbol,
            )
          quote = {
            tool: '0x',
            toAmount: leg.buyAmountRaw,
            toAmountMin: minRaw,
            approvalAddress: ALLOWANCE_HOLDER,
            tx: { to: ALLOWANCE_HOLDER, data: leg.swapData, value: 0n, gasLimit: null },
            gasCostUsd: null,
            crossChain: false,
            nativeFeeRaw: 0n,
            etaSec: null,
          }
        } catch (zErr) {
          const zxWords = zErr instanceof Error ? zErr.message : 'the direct lane did not answer'
          throw new RunnerRefusal(
            `This sale could not be quoted on either lane we trust. The routing service said: ${lifiWords} The direct lane said: ${zxWords} Nothing was sent.`,
            scope,
          )
        }
      }
      // S2 — the floor (derived above, law S2b) clears before anything signs,
      // whichever lane produced the quote
      if (quote.toAmountMin < floorRaw)
        throw new RunnerRefusal(
          'The market has moved against this sale: its guaranteed minimum no longer covers what the plan draws on. Nothing was sold — re-open the review to plan against today’s prices.',
          scope,
        )
      // S3 — the approval sequence, decided NOW, on the SOLD token. A native
      // sale has no allowance to read and nothing to approve.
      let approvals: SellPrepared['approvals'] = []
      if (!isNativeSale)
      try {
        const allowance = (await client.readContract({
          address: asset,
          abi: erc20ApproveAbi,
          functionName: 'allowance',
          args: [ctx.account, quote.approvalAddress],
        })) as bigint
        // pass the token+chain so a MEASURED direct-re-approve token skips the
        // zero step and the user signs once instead of twice
        const mode = approvalPlan(allowance, sellRaw, { chainId, token: asset })
        const values = mode === 'none' ? [] : mode === 'zero-first' ? [0n, sellRaw] : [sellRaw]
        approvals = values.map((value) => ({ token: asset, spender: quote.approvalAddress, value }))
      } catch {
        throw new RunnerRefusal('The sold token’s allowance could not be read, so the approval could not be planned. Nothing was sent.', scope)
      }
      const prepared: SellPrepared = { kind: 'sell', chainId, holder: ctx.account, asset, sellRaw, settlement, floorRaw, quote, approvals }
      verifiedBytes.set(
        prepared,
        `${quote.tx.to}|${quote.tx.data}|${quote.tx.value}~${approvals.map((a) => `${a.token}|${a.spender}|${a.value}`).join('~')}`,
      )
      return { request: prepared, floorHolds: true, gasCostUsd: quote.gasCostUsd ?? null, result: null }
    }
    // ── THE BRIDGE STEP (laws B1–B4, the owner's build order 2026-08-14) ─────────
    // B1 THE QUOTE IS THE SIMULATION: no eth_call can preview a cross-chain
    //    transfer, so the guarded LI.FI quote — lifi.ts's parse pins the
    //    execution target to the chain's allowlisted diamond, requires
    //    approval-spender === target, and echoes pair/size/delivery — is the
    //    independent check, and its transaction is stored VERBATIM: the bytes
    //    validated are the bytes signed (P7's shape, bridge-flavoured).
    // B2 APPROVALS ARE EXACT and to the quote's own (pinned) spender, in
    //    approvalPlan's sequence (zero-first where the token demands it).
    // B3 ARRIVAL IS THE ORACLE'S VERDICT: resolve() reads LI.FI's status —
    //    'done' carries the ACTUAL delivered amount, refund/fail are named,
    //    and an unreachable oracle is ambiguity (null), never a verdict. The
    //    row is persisted at send (bridge-pending), so arrival tracking
    //    survives a reload and outlives even a partial-ended run.
    // B4 THE DOUBLE-BUY STORE COVERS IT like any step: claims by stepKey,
    //    the submissionId carries the source-chain hash, law 14b stamps it.
    if (step.action.kind === 'bridge') {
      const { fromChainId, toChainId, amountCents } = step.action
      const fromClient = ctx.client(fromChainId)
      if (!fromClient || !ctx.client(toChainId))
        throw new RunnerRefusal(`We have no connection to one of the networks this transfer crosses. Nothing was sent.`, 'the network transfer')
      const fromToken = ctx.settlementAddress?.(fromChainId) ?? null
      const toToken = ctx.settlementAddress?.(toChainId) ?? null
      if (!fromToken || !toToken)
        throw new RunnerRefusal('A network in this transfer has no settlement token configured here. Nothing was sent.', 'the network transfer')
      if (!Number.isFinite(amountCents) || amountCents <= 0)
        throw new RunnerRefusal('This transfer carries no readable amount. Nothing was sent.', 'the network transfer')
      // The transfer amount converts at the SOURCE settlement token's VERIFIED
      // decimals (law S2b — the quote's fromAmount is denominated in that
      // token's own raw units, so a wrong divisor here mis-sizes real money).
      const bridgeDec = await verifiedSettlementDecimals(
        fromClient,
        ctx,
        fromChainId,
        fromToken,
        'the network transfer',
      )
      const amountRaw = centsToRawAt(amountCents, bridgeDec)
      // REFUEL (the gas-deposit lane, 2026-08-14 — the plan marked this
      // bridge as the destination's gas carrier): sized live per refuel.ts's
      // policy (contracts' rule: compute live, clamp per chain), converted to
      // from-token units at the destination's native price, and REFUSED
      // honestly when any of those facts cannot be read — a top-up is never
      // a made-up number. KNOWN LIMIT (lifi.ts's own): the quote carries no
      // verifiable refuel echo, so delivery is best-effort; a later step on
      // the destination still refuses at its own gas law if nothing arrived.
      let fromAmountForGas: bigint | undefined
      if (step.action.refuel) {
        const toClient = ctx.client(toChainId)
        let destGasPrice: bigint | null = null
        try {
          destGasPrice = toClient ? await toClient.getGasPrice() : null
        } catch {
          destGasPrice = null
        }
        const weiNeeded = destGasPrice != null ? computeRefuelGasWei(toChainId, destGasPrice) : null
        if (weiNeeded == null)
          throw new RunnerRefusal(
            `Could not size the arrival gas top-up for network ${showChainId(toChainId)} — nothing was sent. Retry, or fund gas there separately.`,
            'the network transfer',
          )
        const usd = ctx.nativeUsd ? ctx.nativeUsd(toChainId) : null
        const units = refuelFromTokenUnits(weiNeeded, usd)
        if (units == null)
          throw new RunnerRefusal(
            `Could not read a native-gas price on network ${showChainId(toChainId)} to size the arrival gas top-up — nothing was sent. Retry, or fund gas there separately.`,
            'the network transfer',
          )
        if (units > 0n) fromAmountForGas = units
      }
      const quoteFn = ctx.lifiQuote ?? fetchLifiQuote
      let quote: LifiQuote
      try {
        quote = await quoteFn({
          chainId: toChainId,
          fromChainId,
          fromToken,
          toToken,
          fromAmount: amountRaw,
          fromAddress: ctx.account,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          // IN-RUN transfers optimise for SPEED (the owner's ruling, 2026-08-15
          // live: "it should take hopefully less than 30 seconds") — a run is
          // a human waiting, and a cheap-but-slow route strands the whole
          // sequence at 'traveling'. The kit-wide CHEAPEST default (the owner
          // 2026-08-09) stands everywhere else; lifi.ts's own comment names
          // per-call divergence as the deliberate seam for exactly this.
          order: 'FASTEST',
          ...(fromAmountForGas != null ? { fromAmountForGas } : {}),
        })
      } catch (e) {
        throw new RunnerRefusal(
          `The transfer route could not be quoted: ${e instanceof Error ? e.message : 'the routing service did not answer'} Nothing was sent.`,
          'the network transfer',
        )
      }
      // the approval sequence, decided NOW (B2) — read the live allowance
      let approvals: BridgePrepared['approvals'] = []
      try {
        const allowance = (await fromClient.readContract({
          address: fromToken,
          abi: erc20ApproveAbi,
          functionName: 'allowance',
          args: [ctx.account, quote.approvalAddress],
        })) as bigint
        const mode = approvalPlan(allowance, amountRaw, { chainId: fromChainId, token: fromToken })
        const values = mode === 'none' ? [] : mode === 'zero-first' ? [0n, amountRaw] : [amountRaw]
        approvals = values.map((value) => ({ token: fromToken, spender: quote.approvalAddress, value }))
      } catch {
        throw new RunnerRefusal('The funding token’s allowance could not be read, so the approval could not be planned. Nothing was sent.', 'the network transfer')
      }
      const prepared: BridgePrepared = {
        kind: 'bridge',
        fromChainId,
        toChainId,
        holder: ctx.account,
        fromToken,
        amountRaw,
        quote,
        approvals,
      }
      // P8-analog registration: submit() refuses bytes it cannot match to
      // what THIS simulate validated (the same WeakMap discipline as batch)
      verifiedBytes.set(prepared, `${quote.tx.to}|${quote.tx.data}|${quote.tx.value}~${approvals.map((a) => `${a.token}|${a.spender}|${a.value}`).join('~')}`)
      return { request: prepared, floorHolds: true, gasCostUsd: quote.gasCostUsd ?? null, result: null }
    }
    const chainId = step.action.chainId
    const client = ctx.client(chainId)
    if (!client)
      throw new RunnerRefusal(`We have no connection to network ${showChainId(chainId)}. Nothing was sent.`, `network ${showChainId(chainId)}`)
    const batcher = ctx.batcherAddress(chainId)
    if (!batcher)
      throw new RunnerRefusal(
        `No batch contract is deployed on network ${showChainId(chainId)} yet. Nothing was sent.`,
        `network ${showChainId(chainId)}`,
      )

    // ── THE PORTFOLIO ENGINE (the executor migration, the owner's runway order
    //    2026-08-13): the new contract's whole simulate path, explicit and
    //    separate — never inferred, never a silent switch. Everything below
    //    this branch is the LEGACY path, byte-identical to its pre-migration
    //    self; submit()/resolve() are contract-agnostic (bytes + records). ──
    if (ctx.engine === 'portfolio') return simulatePortfolio(step, chainId, client, batcher)

    let composed: ComposedBatchBuy
    try {
      composed = await ctx.composeStep(step)
    } catch (e) {
      if (e instanceof BatchComposeRefusal || e instanceof RunnerRefusal) throw e
      throw new RunnerRefusal(friendlyRevert(e, 'This step could not be prepared.'), `network ${showChainId(chainId)}`)
    }

    // E1's signer-bound half at THIS gate too: the composed recipient must be
    // the account this run was constructed for (simulateBatchBuy's own law,
    // held here because these bytes are the ones that get signed).
    const params = composed.args[3]
    if (params.recipient.toLowerCase() !== ctx.account.toLowerCase())
      throw new RunnerRefusal(
        'The composed batch pays out to a different address than the account running it — refusing before any signature.',
        `network ${showChainId(chainId)}`,
      )

    // LAW P5 — the deadline against the CHAIN's clock, at the last gate.
    const block = await client.getBlock()
    const chainNow = Number(block.timestamp)
    const deadline = Number(params.deadline)
    if (!(deadline > chainNow))
      throw new RunnerRefusal(
        'This plan’s signing window has already passed on the network’s own clock — re-open the review to compose a fresh one. Nothing was sent.',
        `network ${showChainId(chainId)}`,
      )
    if (deadline - chainNow > MAX_DEADLINE_WINDOW_SEC)
      throw new RunnerRefusal(
        'This plan’s signing window reaches further ahead than we allow a signature to live — re-open the review to compose a fresh one. Nothing was sent.',
        `network ${showChainId(chainId)}`,
      )

    // ONE encoding — the bytes below are simulated, and the same object signs.
    const batchCall: PreparedCall = {
      to: batcher,
      data: encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args }),
      value: composed.value,
    }
    const approvals = (ctx.approvalsFor?.(step) ?? []).map(
      (a): PreparedCall => ({
        to: a.token,
        data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [batcher, a.amountRaw] }),
        value: 0n,
      }),
    )
    const prepared: PreparedStep = { chainId, calls: [...approvals, batchCall], batchIndex: approvals.length }

    // LAW P8 — the displayed-vs-signed gate, before anything is simulated or
    // signed. The bytes are decoded back with the pinned ABI and diffed
    // against what the review rendered; the first divergence refuses in its
    // own sentence. No shown record = no run for this step, fail closed.
    const shown = ctx.shownFor(step)
    if (!shown || shown.chainId !== chainId)
      throw new RunnerRefusal(
        'We could not check this transaction against what you reviewed, so nothing was signed. Re-open the review and try again.',
        `network ${showChainId(chainId)}`,
        'nothing-sent',
      )
    // ⚠ THE LAWS FIRST, because the byte diff below cannot speak for them (A6
    // review, 2026-08-07). These bytes were encoded from `composed.args` eight
    // lines up, so re-encoding the same object proves only that nothing
    // mutated in between — every tamper that lives in the COMPOSITION passes
    // it. What catches those is comparing the composition to things it was not
    // derived from: our own fee constant, the signing account, and the CHAIN's
    // clock (read at :296, not supplied by the composer).
    const lawBroken = compositionLawsBroken(composed, {
      account: ctx.account,
      chainNowSec: chainNow,
      maxDeadlineWindowSec: MAX_DEADLINE_WINDOW_SEC,
    })
    if (lawBroken) throw new RunnerRefusal(lawBroken, `network ${showChainId(chainId)}`, 'nothing-sent')

    const mismatch = diffDisplayedVsSigned(prepared.calls, prepared.batchIndex, batcher, shown, composed)
    // definitive: this refuses before the wallet is ever contacted
    if (mismatch) throw new RunnerRefusal(mismatch, `network ${showChainId(chainId)}`, 'nothing-sent')
    // keep what we verified, so submit() can prove it is signing the SAME bytes
    verifiedBytes.set(prepared, prepared.calls.map((c) => `${c.to}|${c.data}|${c.value}`).join('~'))

    // Simulate the EXACT bytes. Native funding: one eth_call. ERC-20 funding:
    // the batch's transferFrom needs the approval applied first, so the whole
    // sequence goes through eth_simulateV1 — and where the RPC cannot, we
    // refuse rather than sign blind (stated v1 bound).
    let rawResult: Hex
    if (approvals.length === 0) {
      try {
        const res = await client.call({ to: batchCall.to, data: batchCall.data, value: batchCall.value, account: ctx.account })
        if (!res.data) throw new Error('the simulation returned no data')
        rawResult = res.data
      } catch (e) {
        return refusedSim(prepared, asPreviewRefusal(friendlyRevert(e, 'The network refused this batch in simulation — nothing was signed.')))
      }
    } else {
      try {
        const sim = await client.simulateCalls({
          account: ctx.account,
          calls: prepared.calls.map((c) => ({ to: c.to, data: c.data, value: c.value })),
        })
        const results = (sim.results ?? []) as { status: string; data?: Hex; error?: unknown }[]
        const batchRes = results[prepared.batchIndex]
        for (const [i, r] of results.entries()) {
          if (r?.status !== 'success')
            return refusedSim(
              prepared,
              i === prepared.batchIndex
                ? asPreviewRefusal(friendlyRevert(r?.error, 'The network refused this batch in simulation — nothing was signed.'))
                : 'The token approval this batch needs was refused in simulation — nothing was signed.',
            )
        }
        if (!batchRes?.data) return refusedSim(prepared, 'The preview returned no result for the batch — refusing rather than signing blind.')
        rawResult = batchRes.data
      } catch (e) {
        // an RPC without eth_simulateV1 is a stated v1 bound, in its own words
        if (isMethodUnsupported(e))
          return refusedSim(
            prepared,
            'This network connection cannot preview an approval-then-batch sequence, and we never sign what we could not preview. Fund with the network’s own asset, or try a wallet/network that supports previews.',
          )
        return refusedSim(prepared, asPreviewRefusal(friendlyRevert(e, 'The preview of this batch failed — nothing was signed.')))
      }
    }

    let result: BatchSimResult
    try {
      const decoded = decodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', data: rawResult }) as BatchSimResult
      result = decoded
    } catch {
      return refusedSim(prepared, 'The network answered the preview in a shape we do not recognize — refusing rather than signing blind.')
    }

    // LAW P6 — check the result against what WE composed.
    const legs = composed.args[0]
    const skipped = new Set<number>()
    for (let i = 0; i < legs.length; i++) if ((result.skippedBitmap >> BigInt(i)) & 1n) skipped.add(i)
    for (const [i, leg] of legs.entries()) {
      if (skipped.has(i)) {
        if (!leg.optional)
          return refusedSim(prepared, 'The preview skipped a part of this batch that is not skippable — our plan and the network disagree, so nothing was signed.')
        continue
      }
      const out = result.outs[i]
      if (out == null || out < leg.minOut)
        return refusedSim(
          prepared,
          'The preview delivers less than the floor we showed you on at least one asset — nothing was signed. Refresh the review to re-quote.',
        )
    }
    if (result.spentFunding > (composed.args[2] as bigint))
      return refusedSim(prepared, 'The preview spent more than this batch pulls — our plan and the network disagree, so nothing was signed.')

    // The measured gas figure the route comparator consumes (null = unreadable,
    // never zero — routing.ts' own law).
    let gasCostUsd: number | null = null
    try {
      const [gas, gasPrice] = await Promise.all([
        client.estimateGas({ to: batchCall.to, data: batchCall.data, value: batchCall.value, account: ctx.account }),
        client.getGasPrice(),
      ])
      const usd = ctx.nativeUsd?.(chainId) ?? null
      if (usd != null && Number.isFinite(usd) && usd > 0) {
        gasCostUsd = round2(Number(gas * gasPrice) / 1e18 * usd)
      }
    } catch {
      gasCostUsd = null
    }

    return { request: prepared, floorHolds: true, gasCostUsd, result }
  }

  /** The PORTFOLIO engine's simulate — SpectrumPortfolioBatcher's laws end to
   *  end. Mirrors the legacy path's stations (compose → independent laws →
   *  one encoding → P8 gate → exact-bytes preview → result laws → gas) with
   *  the new contract's own truths: nonpayable (value 0n always), 0x swapData
   *  per leg, and a `(bought[], refunded)` return that makes conservation an
   *  EXACT equality — stronger than the legacy bitmap ever allowed. */
  const simulatePortfolioOnce = async (
    step: FundingStep,
    chainId: number,
    client: PublicClient,
    batcher: Address,
  ): Promise<MeasuredSimulatedStep> => {
    if (!ctx.composePortfolioStep)
      throw new RunnerRefusal(
        'This build selected the portfolio engine without wiring its composer — refusing rather than falling back to a contract that speaks different calldata. Nothing was sent.',
        `network ${showChainId(chainId)}`,
        'nothing-sent',
      )
    let composed: ComposedPortfolioBatchBuy
    try {
      composed = await ctx.composePortfolioStep(step)
    } catch (e) {
      if (e instanceof BatchComposeRefusal || e instanceof RunnerRefusal) throw e
      throw new RunnerRefusal(friendlyRevert(e, 'This step could not be prepared.'), `network ${showChainId(chainId)}`)
    }

    // E1's signer-bound half at THIS gate too (the legacy path's own law).
    const params = composed.args[3]
    if (params.recipient.toLowerCase() !== ctx.account.toLowerCase())
      throw new RunnerRefusal(
        'The composed batch pays out to a different address than the account running it — refusing before any signature.',
        `network ${showChainId(chainId)}`,
      )

    // LAW P5 — the deadline against the CHAIN's clock, at the last gate.
    const block = await client.getBlock()
    const chainNow = Number(block.timestamp)
    const deadline = Number(params.deadline)
    if (!(deadline > chainNow))
      throw new RunnerRefusal(
        'This plan’s signing window has already passed on the network’s own clock — re-open the review to compose a fresh one. Nothing was sent.',
        `network ${showChainId(chainId)}`,
      )
    if (deadline - chainNow > MAX_DEADLINE_WINDOW_SEC)
      throw new RunnerRefusal(
        'This plan’s signing window reaches further ahead than we allow a signature to live — re-open the review to compose a fresh one. Nothing was sent.',
        `network ${showChainId(chainId)}`,
      )

    // ONE encoding — the bytes below are simulated, and the same object signs.
    // value 0n ALWAYS: the contract is nonpayable and funds in ERC-20 only.
    const batchCall: PreparedCall = {
      to: batcher,
      data: encodePortfolioBatchBuy(composed),
      value: 0n,
    }
    const approvals = (ctx.approvalsFor?.(step) ?? []).map(
      (a): PreparedCall => ({
        to: a.token,
        data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [batcher, a.amountRaw] }),
        value: 0n,
      }),
    )
    const prepared: PreparedStep = { chainId, calls: [...approvals, batchCall], batchIndex: approvals.length }

    // LAW P8 — shown-vs-signed, laws first (the byte diff cannot speak for
    // what both sides inherited from the composer).
    const shown = ctx.shownFor(step)
    if (!shown || shown.chainId !== chainId)
      throw new RunnerRefusal(
        'We could not check this transaction against what you reviewed, so nothing was signed. Re-open the review and try again.',
        `network ${showChainId(chainId)}`,
        'nothing-sent',
      )
    const lawBroken = portfolioCompositionLawsBroken(composed, {
      account: ctx.account,
      chainNowSec: chainNow,
      maxDeadlineWindowSec: MAX_DEADLINE_WINDOW_SEC,
      // the operator's own fee sink (audit F4): the composed feeRecipient must
      // be this, not merely non-zero. INTERFACE_TAG_ADDRESS is the operator's
      // configured fee wallet (operator.ts); null when unset, which keeps the
      // zero-sink refusal but cannot pin a specific address — acceptable for
      // an operator who has configured no sink, and the flip's wiring supplies
      // one. A composer cannot beat this by tampering: it is our config.
      expectedFeeRecipient: INTERFACE_TAG_ADDRESS ?? undefined,
      // per-generation fee (gen-2 charges GEN2_BATCH_FEE_BPS): the law reads
      // OUR config's rate for this chain, never the composer's opinion
      expectedFeeBps: batchFeeBpsFor(chainId),
      burnComposable: ctx.burnComposable?.(chainId) === true,
    })
    if (lawBroken) throw new RunnerRefusal(lawBroken, `network ${showChainId(chainId)}`, 'nothing-sent')
    const mismatch = diffDisplayedVsSignedPortfolio(prepared.calls, prepared.batchIndex, batcher, shown, composed)
    if (mismatch) throw new RunnerRefusal(mismatch, `network ${showChainId(chainId)}`, 'nothing-sent')
    verifiedBytes.set(prepared, prepared.calls.map((c) => `${c.to}|${c.data}|${c.value}`).join('~'))

    // Simulate the EXACT bytes — ERC-20 funding always, so any approval means
    // the approve-then-batch sequence and eth_simulateV1 (the legacy path's
    // own stated bound where an RPC cannot).
    let rawResult: Hex
    if (approvals.length === 0) {
      try {
        const res = await client.call({ to: batchCall.to, data: batchCall.data, value: batchCall.value, account: ctx.account })
        if (!res.data) throw new Error('the simulation returned no data')
        rawResult = res.data
      } catch (e) {
        return refusedSim(prepared, asPreviewRefusal(friendlyRevert(e, 'The network refused this batch in simulation — nothing was signed.')))
      }
    } else {
      try {
        const sim = await client.simulateCalls({
          account: ctx.account,
          calls: prepared.calls.map((c) => ({ to: c.to, data: c.data, value: c.value })),
        })
        const results = (sim.results ?? []) as { status: string; data?: Hex; error?: unknown }[]
        const batchRes = results[prepared.batchIndex]
        for (const [i, r] of results.entries()) {
          if (r?.status !== 'success')
            return refusedSim(
              prepared,
              i === prepared.batchIndex
                ? asPreviewRefusal(friendlyRevert(r?.error, 'The network refused this batch in simulation — nothing was signed.'))
                : 'The token approval this batch needs was refused in simulation — nothing was signed.',
            )
        }
        if (!batchRes?.data) return refusedSim(prepared, 'The preview returned no result for the batch — refusing rather than signing blind.')
        rawResult = batchRes.data
      } catch (e) {
        if (isMethodUnsupported(e))
          return refusedSim(
            prepared,
            'This network connection cannot preview an approval-then-batch sequence, and we never sign what we could not preview. Try a wallet/network that supports previews.',
          )
        return refusedSim(prepared, asPreviewRefusal(friendlyRevert(e, 'The preview of this batch failed — nothing was signed.')))
      }
    }

    let bought: readonly bigint[]
    let refunded: bigint
    try {
      // outputs are identical across generations; the discriminated ABI keeps
      // the decode honest anyway
      const decoded = decodeFunctionResult({
        abi: composed.generation === 2 ? portfolioBatcherAbiGen2 : portfolioBatcherAbi,
        functionName: 'batchBuy',
        data: rawResult,
      }) as readonly [readonly bigint[], bigint]
      bought = decoded[0]
      refunded = decoded[1]
    } catch {
      return refusedSim(prepared, 'The network answered the preview in a shape we do not recognize — refusing rather than signing blind.')
    }

    // LAW P6' — the result against what WE composed, on the NEW contract's
    // vocabulary. No skip bitmap exists: bought[i] === 0 IS the skip signal
    // (an executed leg is contract-bound to clear its floor, and we assert it
    // anyway — a preview that disagrees with the contract's own guarantee is
    // a preview not worth signing).
    const legs = composed.args[0]
    if (bought.length !== legs.length)
      return refusedSim(prepared, 'The preview answered for a different number of assets than this batch carries — nothing was signed.')
    let executedSell = 0n
    for (const [i, leg] of legs.entries()) {
      const out = bought[i]
      if (out === 0n) {
        if (!leg.optional)
          return refusedSim(prepared, 'The preview skipped a part of this batch that is not skippable — our plan and the network disagree, so nothing was signed.')
        continue
      }
      if (out < leg.minBuyAmount)
        return refusedSim(
          prepared,
          'The preview delivers less than the floor we showed you on at least one asset — nothing was signed. Refresh the review to re-quote.',
        )
      executedSell += leg.sellAmount
    }
    // CONSERVATION (the migration's one strengthened law): what the executed
    // legs deploy, plus the contract's own fee on that deployment, plus what
    // comes back, must equal the pull.
    //
    // ⚠ RESHAPED PER THE COLD REVIEWER'S ANSWER (SpectrumContracts pass-one
    // report §P6', 2026-08-14 — supersedes e3cb7226's symmetric 2×legs+1,
    // which that answer measured as the wrong shape on BOTH sides). The
    // contract's true identity telescopes over its own MEASURED quantities:
    // `received == totalUsed + fee + refunded`, fee = ONE floor over the sum
    // (so total fee rounding is at most 1 wei — never 2 per leg), and the 7:1
    // split is remainder-exact with both cuts exiting, so the split cannot
    // perturb this. Our preview sees only the return `(bought[], refunded)`
    // plus our own calldata, so:
    //   · `executedSell` (calldata) ≥ the contract's `totalUsed` (measured):
    //     underspend is ONE-SIGNED. The residual can never be negative on an
    //     honest route — a negative residual means the batch returned more
    //     money than it took, a defect to CATCH, not tolerate.
    //   · the upside budget is a wei per EXECUTED leg for route dust plus one
    //     for the single fee floor — tight on purpose: a route that strands
    //     real funds (the V3 partial-fill class this repo has measured)
    //     REFUSES here in preview, before any signature. Refusal is the safe
    //     direction; silent stranding is the harm.
    //   · `fundingTotal` stands in for the contract's `received` — exact for
    //     the non-fee-on-transfer settlement assets this app funds with
    //     (USDC/USDG). A FoT funding asset would need the measured `received`,
    //     which the return values cannot carry. Stated, never assumed silently.
    const fee = (executedSell * BigInt(params.feeBps)) / 10_000n
    const fundingTotal = composed.args[2]
    const conservationGap = executedSell + fee + refunded - fundingTotal
    let executedCount = 0n
    for (const out of bought) if (out > 0n) executedCount += 1n
    if (conservationGap < 0n)
      return refusedSim(
        prepared,
        'The preview loses track of part of this batch’s money — what executes plus the fee plus the refund falls short of the pull. That is a defect, not rounding, so nothing was signed.',
      )
    if (conservationGap > executedCount + 1n)
      return refusedSim(
        prepared,
        'The preview strands part of this batch’s funds between the route and the refund — nothing was signed.',
      )

    let gasCostUsd: number | null = null
    try {
      const [gas, gasPrice] = await Promise.all([
        client.estimateGas({ to: batchCall.to, data: batchCall.data, value: batchCall.value, account: ctx.account }),
        client.getGasPrice(),
      ])
      const usd = ctx.nativeUsd?.(chainId) ?? null
      if (usd != null && Number.isFinite(usd) && usd > 0) {
        gasCostUsd = round2(Number(gas * gasPrice) / 1e18 * usd)
      }
    } catch {
      gasCostUsd = null
    }

    // ⚠ BEFORE TRUSTING THIS PASS, MAKE THE PREVIEW PROVE IT CAN FAIL (see
    // `poisonFloor`). Once per chain per session: the same bytes with an
    // unsatisfiable floor must be rejected. A mechanism that accepts the
    // impossible has no verdicts worth having, and signing against it would be
    // the "control that cannot fail" mistake in production rather than in a
    // diagnosis. Any error running the probe leaves the chain UNPROVEN rather
    // than marking it broken — a failed read is not a failed mechanism.
    if (!previewProven.has(chainId) && !previewBroken.has(chainId)) {
      try {
        const poisoned = encodePortfolioBatchBuy({ ...composed, args: poisonFloor(composed.args) as never })
        await client.call({ to: batchCall.to, data: poisoned, value: batchCall.value, account: ctx.account })
        previewBroken.add(chainId) // it ACCEPTED the impossible
      } catch {
        previewProven.add(chainId) // it rejected it, as any honest preview must
      }
    }
    // ⚠ IT RECORDS, IT DOES NOT BLOCK, and that boundary is deliberate. A probe
    // that can produce a FALSE "broken" verdict would refuse every run on this
    // chain, which is a bigger failure than the one it guards against (the
    // suite caught exactly that: a stub client that accepts everything).
    // And the preview is not the security boundary anyway: the CONTRACT enforces
    // every floor on chain via MinBuyNotMet, so an untrustworthy preview costs
    // a wasted gas fee, never funds. Recording it is proportionate; blocking on
    // it is not.
    if (previewBroken.has(chainId))
      recordFailure({
        at: nowIso(),
        surface: 'preview self-test',
        signer: ctx.account,
        chainId,
        message: PREVIEW_NOT_TRUSTWORTHY,
      })

    return { request: prepared, floorHolds: true, gasCostUsd, result: null, portfolioResult: { bought, refunded } }
  }

  /**
   * ⚠⚠ THE STALE-QUOTE RETRY — and the reason it is SAFE to retry at all is the
   * whole point: this is a PRE-SEND simulation. Nothing has been signed, no
   * transaction exists, no gas has been spent. A failed preview costs exactly
   * one wasted round-trip, so re-quoting and previewing again is free.
   *
   * WHY IT EXISTS (the owner, 2026-08-15, after six refusals in a row and an
   * evening of me chasing structural causes that were not there): a thin pool
   * moves in STEPS, not drifts — measured on $LNOC at 722 bps inside a single
   * 12-second interval, flat either side. The 0x quote is fetched at compose,
   * the preview runs moments later, and if a step lands in between, the route
   * refuses with its own minimum ("return too low"), which our wrapper reports
   * as `RequiredLegFailed`. Every reconstruction of his exact trade passed,
   * because by then the pool had settled — the failure is real but momentary.
   *
   * A momentary failure that the user is asked to fix by hand is a bad
   * surface: he pressed the re-check door repeatedly and kept hitting the same
   * window. The machine should do it, because the machine can do it in
   * milliseconds and the human cannot.
   *
   * BOUNDED AND HONEST:
   *  · Only STALE-QUOTE-CLASS failures retry. A refusal that will not change on
   *    a fresh quote — no route, a policy refusal, a broken deployment, an
   *    insufficient balance — must fail on the FIRST attempt, exactly as
   *    before, or we would spend three round-trips to deliver the same true
   *    sentence more slowly.
   *  · Each attempt RE-COMPOSES, so it carries genuinely fresh 0x quotes.
   *    Retrying the same bytes would be pure superstition.
   *  · Three attempts total. If a pool is moving faster than three consecutive
   *    quotes can survive, the honest answer is the refusal, not a fourth try.
   *  · The user-facing message is the LAST attempt's, unchanged — this adds no
   *    new vocabulary and cannot invent a reason.
   */
  const simulatePortfolio = async (
    step: FundingStep,
    chainId: number,
    client: PublicClient,
    batcher: Address,
  ): Promise<MeasuredSimulatedStep> => {
    let last = await simulatePortfolioOnce(step, chainId, client, batcher)
    for (let attempt = 0; attempt < STALE_QUOTE_RETRIES; attempt++) {
      if (last.floorHolds) return last
      if (!looksStaleQuote(last.floorMessage ?? '')) return last
      // fresh compose → fresh quotes → fresh preview. Nothing was signed, so
      // this is a read, not a second attempt at spending anything.
      last = await simulatePortfolioOnce(step, chainId, client, batcher)
    }
    return last
  }

  const submit: RunnerEffects['submit'] = async (_step, sim) => {
    // ── SALE SUBMIT (S1/S3): exact approvals on the sold token, then the
    //    validated bytes VERBATIM. The submissionId rides the generic tx:
    //    path — a same-chain receipt is the whole settlement (no oracle),
    //    and the router's on-chain minimum makes SUCCESS itself the floor
    //    proof (S2). ──
    if ((sim.request as SellPrepared).kind === 'sell') {
      const sp = sim.request as SellPrepared
      const bytesNow = `${sp.quote.tx.to}|${sp.quote.tx.data}|${sp.quote.tx.value}~${sp.approvals.map((a) => `${a.token}|${a.spender}|${a.value}`).join('~')}`
      const verified = verifiedBytes.get(sp)
      if (verified === undefined || verified !== bytesNow)
        throw new RunnerRefusal(
          'This sale changed after we checked it, so nothing was signed. Re-open the review and try again.',
          'the wallet prompt',
          'nothing-sent',
        )
      if (!(ctx.store === undefined ? probeWritable() : probeWritable(ctx.store)))
        throw new RunnerRefusal(
          'This browser’s storage cannot take the record this step must leave behind — nothing was sent. Free some space, then try again.',
          'the record book',
          'nothing-sent',
        )
      const client = ctx.client(sp.chainId)
      for (const a of sp.approvals) {
        const h = await ctx.wallet.sendTransaction(sp.chainId, {
          to: a.token,
          data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [a.spender, a.value] }),
          value: 0n,
        })
        // the approval must LAND before the swap that spends it (S3)
        const ok = client ? await awaitReceiptOk(client, h) : false
        if (!ok)
          throw new RunnerRefusal(
            'The approval before this sale did not confirm, so the sale was not signed. Check your wallet activity and try again.',
            'the wallet prompt',
          )
      }
      const txHash = await ctx.wallet.sendTransaction(sp.chainId, {
        to: sp.quote.tx.to,
        data: sp.quote.tx.data,
        value: sp.quote.tx.value,
      })
      return { submissionId: `tx:${sp.chainId}:${txHash}`, rung: 0 }
    }
    // ── BRIDGE SUBMIT (B1/B2): exact approvals, then the validated bytes
    //    VERBATIM; the persisted row lands the instant the send returns so
    //    arrival tracking survives anything (a reload, a partial end). ──
    if ((sim.request as BridgePrepared).kind === 'bridge') {
      const bp = sim.request as BridgePrepared
      const bytesNow = `${bp.quote.tx.to}|${bp.quote.tx.data}|${bp.quote.tx.value}~${bp.approvals.map((a) => `${a.token}|${a.spender}|${a.value}`).join('~')}`
      const verified = verifiedBytes.get(bp)
      if (verified === undefined || verified !== bytesNow)
        throw new RunnerRefusal(
          'This transfer changed after we checked it, so nothing was signed. Re-open the review and try again.',
          'the wallet prompt',
          'nothing-sent',
        )
      if (!(ctx.store === undefined ? probeWritable() : probeWritable(ctx.store)))
        throw new RunnerRefusal(
          'This browser’s storage cannot take the record this step must leave behind — nothing was sent. Free some space, then try again.',
          'the record book',
          'nothing-sent',
        )
      const fromClient = ctx.client(bp.fromChainId)
      for (const a of bp.approvals) {
        const h = await ctx.wallet.sendTransaction(bp.fromChainId, {
          to: a.token,
          data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [a.spender, a.value] }),
          value: 0n,
        })
        // the approval must LAND before the transfer references it
        const ok = fromClient ? await awaitReceiptOk(fromClient, h) : false
        if (!ok)
          throw new RunnerRefusal(
            'The approval before this transfer did not confirm, so the transfer was not signed. Check your wallet activity and try again.',
            'the wallet prompt',
          )
      }
      const txHash = await ctx.wallet.sendTransaction(bp.fromChainId, {
        to: bp.quote.tx.to,
        data: bp.quote.tx.data,
        value: bp.quote.tx.value,
      })
      addBridge({
        txHash,
        fromChainId: bp.fromChainId,
        toChainId: bp.toChainId,
        holder: bp.holder,
        fromSymbol: 'USDC',
        fromAmountRaw: bp.amountRaw,
        fromDecimals: 6,
        quotedToAmountRaw: bp.quote.toAmount,
        startedAt: Date.now(),
        ...(bp.quote.etaSec != null ? { etaSec: bp.quote.etaSec } : {}),
      })
      return { submissionId: `bridge:${bp.fromChainId}:${bp.toChainId}:${txHash}`, rung: 0 }
    }
    const prepared = sim.request as PreparedStep
    const calls = prepared.calls

    // ⚠ THE MID-RUN DOOR PROBE (R7's quota half, desk 250 item 4 — the
    // registry row this closes). The run's door check measured the store
    // BEFORE the run; a quota hit in a LATER write used to degrade silently,
    // leaving an in-flight transaction with no durable record. Probe HERE,
    // before the wallet is asked: a full store is survivable exactly while
    // nothing is in flight yet, so this refusal is honestly 'nothing-sent'.
    // the probe measures the SAME store the run records to: the injected one
    // when the harness provides it, the window default otherwise. An
    // EXPLICITLY null store is a run that cannot record at all — false, refuse
    // (?? would have silently swapped null for the healthy window store).
    if (!(ctx.store === undefined ? probeWritable() : probeWritable(ctx.store)))
      throw new RunnerRefusal(
        'This browser’s storage cannot take the record this step must leave behind — nothing was sent. Free some space (or close other tabs of this app), then try again.',
        'the record book',
        'nothing-sent',
      )

    // ⚠⚠ LAW P8 IS RE-ASSERTED HERE, AND UNTIL NOW IT WAS NOT (A6 review,
    // 2026-08-07). P8 ran at simulate; `submit` then re-read
    // `sim.request.calls` and handed them to the wallet with no
    // re-verification — so the exact window the P8 header names, "any code
    // that touches the prepared call afterwards", sat entirely AFTER the only
    // check. Anything mutating the prepared object between the two (a later
    // effects change, a compromised module holding the reference) signed bytes
    // nobody had verified. Comparing to what P8 recorded is cheap and it is
    // the one place the "afterwards" claim can be true.
    const verified = verifiedBytes.get(prepared)
    const nowBytes = calls.map((c) => `${c.to}|${c.data}|${c.value}`).join('~')
    if (verified === undefined)
      throw new RunnerRefusal(
        'This transaction was not checked against what you reviewed, so nothing was signed. Re-open the review and try again.',
        'the wallet prompt',
        'nothing-sent',
      )
    if (verified !== nowBytes)
      throw new RunnerRefusal(
        'This transaction changed after we checked it against your review, so nothing was signed. Re-open the review and try again.',
        'the wallet prompt',
        'nothing-sent',
      )

    // Rung 1 — one atomic bundle (approvals + batch, all-or-nothing). Probed
    // fresh: capabilities are per wallet per chain and change with sessions.
    let atomic = false
    try {
      const caps = await ctx.wallet.provider.request({ method: 'wallet_getCapabilities', params: [ctx.account] })
      atomic = parseAtomicSupport(caps, prepared.chainId)
    } catch {
      atomic = false
    }

    if (atomic) {
      try {
        const res = await ctx.wallet.provider.request({
          method: 'wallet_sendCalls',
          params: [
            {
              version: '2.0.0',
              from: ctx.account,
              chainId: `0x${prepared.chainId.toString(16)}`,
              // MONEY REQUIRES ATOMICITY on this rung: an approval that lands
              // without its batch is a dangling exact-amount grant.
              atomicRequired: true,
              calls: calls.map((c) => ({ to: c.to, data: c.data, ...(c.value > 0n ? { value: `0x${c.value.toString(16)}` } : {}) })),
            },
          ],
        })
        const id = typeof res === 'string' ? res : ((res as { id?: unknown })?.id as string | undefined)
        if (typeof id === 'string' && id) {
          if (seenIds.has(id)) return { submissionId: `dup:${id}`, rung: 1 } // LAW P4
          seenIds.add(id)
          return { submissionId: `calls:${prepared.chainId}:${id}`, rung: 1 }
        }
        // an empty/shapeless id: the wallet accepted the request but gave us
        // nothing to poll — ambiguity by construction, same class as P4
        return { submissionId: `dup:no-id`, rung: 1 }
      } catch (e) {
        // ⚠⚠ THE DOUBLE-BUY DOOR, CLOSED (independent review, 2026-08-07). This
        // catch used to test ONLY for a user rejection and then FALL THROUGH to
        // the plain rung on everything else — which means a lost response
        // (WalletConnect relay drop, bundler 502, socket hang up, a timeout)
        // after the wallet had ALREADY BROADCAST sent the same batchBuy a
        // second time. Eleven error shapes were driven through it: only 4001
        // refused; timeout, socket hang up, disconnect, bundler 5xx and -32603
        // all re-sent. The run then reported `done` with no record that a
        // bundle ever existed.
        //
        // THE LAW, applied at the altitude it actually matters: fall back ONLY
        // on a DEFINITIVE non-support answer, where the method never ran and
        // nothing can be in flight. Every other error is AMBIGUOUS — it is not
        // evidence that nothing was sent — and ambiguity must fail closed, even
        // though that costs a retry on errors that really were harmless. A
        // wasted retry is recoverable; a double buy is not.
        // ⚠ EVERY THROW OUT OF submit() STATES ITS CERTAINTY EXPLICITLY (A6
        // verify pass, 2026-08-07). These three are the only RunnerRefusals
        // the runner's definitive/ambiguous classifier can ever see, and the
        // middle one was silently taking the DEFINITIVE branch off a default
        // — releasing its claim and inviting the double-buy this whole catch
        // exists to prevent. Never rely on the default here: the word is the
        // difference between a held claim and a second signature.
        if (isUserRejection(e))
          throw new RunnerRefusal('You declined the signature, so nothing was sent.', 'the wallet prompt', 'nothing-sent')
        if (!isMethodUnsupported(e))
          throw new RunnerRefusal(
            'Your wallet did not answer clearly, so we stopped rather than risk sending this twice. Check your wallet activity before trying again — if the batch is there, it went through.',
            'the wallet prompt',
            'unknown',
          )
        // definitive non-support: nothing ran, the plain rung may try
      }
    }

    // Plain rung. A multi-call step reaching here means the atomic rung is
    // unavailable (or flapped between simulate and submit) — which USED to
    // refuse outright, and stranded the owner's live run at the last step
    // (2026-08-15: his wallet stopped offering atomic mid-session; the buys
    // died with the sale already executed). THE SEQUENTIAL FALLBACK: send the
    // approvals one by one, each RECEIPT-CONFIRMED before the batch — the
    // sale/bridge lanes' own S3/B2 discipline, applied here. Only the
    // batch-last shape is eligible (the portfolio path builds
    // [...approvals, batch] by construction); an exotic legacy shape with
    // calls after the batch keeps the refusal — half a side-swap sequence
    // must never ship.
    if (calls.length > 1 && prepared.batchIndex !== calls.length - 1)
      throw new RunnerRefusal(
        'This step needs its approval and batch to land together, and the wallet stopped offering that — nothing was sent. Try again, or fund with the network’s own asset.',
        'the wallet prompt',
        // definitive: this refuses BEFORE anything is handed to the wallet, so
        // nothing can be in flight and the claim must be released
        'nothing-sent',
      )
    if (calls.length > 1) {
      const client = ctx.client(prepared.chainId)
      for (const c of calls.slice(0, prepared.batchIndex)) {
        const h = await ctx.wallet.sendTransaction(prepared.chainId, { to: c.to, data: c.data, value: c.value })
        // the approval must LAND before the batch that spends it (S3's shape)
        const ok = client ? await awaitReceiptOk(client, h) : false
        if (!ok)
          throw new RunnerRefusal(
            'The approval before this batch did not confirm, so the batch was not signed. Check your wallet activity and try again.',
            'the wallet prompt',
          )
      }
    }
    const only = calls[prepared.batchIndex]
    const hash = await ctx.wallet.sendTransaction(prepared.chainId, { to: only.to, data: only.data, value: only.value })
    if (seenIds.has(hash)) return { submissionId: `dup:${hash}`, rung: 4 } // LAW P4
    seenIds.add(hash)
    return { submissionId: `tx:${prepared.chainId}:${hash}`, rung: 4 }
  }

  const resolve: RunnerEffects['resolve'] = async (submissionId) => {
    // LAW P4 — a shared id answers for no step: hold forever, honestly.
    if (submissionId.startsWith('dup:')) return null

    // ── BRIDGE RESOLVE (B3): LI.FI's status oracle is the arrival verdict.
    //    'done' = funds ARRIVED on the destination (the oracle reports the
    //    actual delivered amount); refund/fail are named; pending/unknown is
    //    ambiguity — the runner keeps polling under its own bounded law, and
    //    past the cap the run ends partial with the persisted bridge row
    //    still tracking arrival for the surfaces that render it. ──
    if (submissionId.startsWith('bridge:')) {
      const [, fromStr, toStr, hash] = submissionId.split(':')
      const statusFn = ctx.lifiStatus ?? fetchLifiStatus
      let verdict: Awaited<ReturnType<typeof fetchLifiStatus>>
      try {
        verdict = await statusFn({ txHash: hash as Hex, fromChainId: Number(fromStr), toChainId: Number(toStr) })
      } catch {
        return null // an unreachable oracle is ambiguity, never a verdict
      }
      if (verdict.state === 'done') return { ok: true }
      if (verdict.state === 'refunded')
        return { ok: false, message: 'The transfer was refunded on the source network — the money is back where it started. Nothing arrived; try again.' }
      if (verdict.state === 'failed')
        return { ok: false, message: `The transfer failed: ${verdict.reason ?? 'the route did not complete'}. Check the pending-transfers panel before retrying.` }
      return null // pending / unknown — keep polling
    }

    if (submissionId.startsWith('calls:')) {
      const [, chainStr, ...rest] = submissionId.split(':')
      const id = rest.join(':')
      void chainStr
      let raw: unknown
      try {
        raw = await ctx.wallet.provider.request({ method: 'wallet_getCallsStatus', params: [id] })
      } catch {
        return null // a poll blip is ambiguity (law 10 upstream), never a verdict
      }
      const verdict = parseCallsStatusForMoney(raw)
      if (verdict.kind === 'success') return { ok: true }
      if (verdict.kind === 'failure') return { ok: false, message: verdict.message, partial: verdict.partial }
      return null
    }

    if (submissionId.startsWith('tx:')) {
      const [, chainStr, hash] = submissionId.split(':')
      const chainId = Number(chainStr)
      const client = ctx.client(chainId)
      if (!client) return null
      let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>
      try {
        receipt = await client.getTransactionReceipt({ hash: hash as Hex })
      } catch {
        return null // not found yet / RPC blip — still ambiguous
      }
      // LAW P2 — a receipt answers for its own hash only.
      if (typeof receipt?.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) return null
      if (receipt.status === 'success') return { ok: true }
      if (receipt.status === 'reverted') {
        const failedLegIndex = lastPrepared
          ? await recoverFailedLegIndex(
              client,
              { to: lastPrepared.to, data: lastPrepared.data, value: lastPrepared.value, account: ctx.account },
              receipt.blockNumber,
            )
          : undefined
        return {
          ok: false,
          message: 'The transaction was included and reverted — the money did not move. Check the review and try again.',
          failedLegIndex,
        }
      }
      return null // an unrecognized receipt status is ambiguity (law P1)
    }

    return null // an id shape we did not issue: never a verdict
  }

  // The last batch call this run simulated — resolve's revert replay uses it.
  // One run = one effects instance = at most one in-flight step at a time (the
  // runner is strictly sequential), so a single slot is faithful.
  let lastPrepared: PreparedCall | null = null
  const simulateTracked: RunnerEffects['simulate'] = async (step) => {
    const sim = await simulate(step)
    // the replay tracker reads BATCH shapes only — a bridge's request carries
    // no calls array (its failed-leg question does not exist: LI.FI's status
    // oracle names the failure, no revert to replay)
    const prepared = sim.request as PreparedStep
    lastPrepared = Array.isArray(prepared.calls) ? (prepared.calls[prepared.batchIndex] ?? null) : null
    return sim
  }

  return {
    activeAccount: ctx.activeAccount,
    simulate: simulateTracked,
    submit,
    resolve,
    writeExecLog: ctx.writeExecLog,
    onState: ctx.onState,
    shouldStop: ctx.shouldStop,
    store: ctx.store,
    nowMs: ctx.nowMs,
    sleep: ctx.sleep,
  }
}

function refusedSim(prepared: PreparedStep, message: string): MeasuredSimulatedStep {
  return { request: prepared, floorHolds: false, floorMessage: message, gasCostUsd: null, result: null }
}

/** EIP-1193 user-rejection (4001) and its common wrapper shapes. */
/** A user decline is definitive by DEFINITION: the wallet asked, the human said
 *  no, nothing was broadcast. Exported so the runner can recognise it too —
 *  a raw provider error may reach it from any effects implementation, and the
 *  runner must not treat an unambiguous "no" as ambiguity. */
export function isUserRejection(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  if (code === 4001) return true
  const msg = (e as { message?: unknown }).message
  return typeof msg === 'string' && /user (rejected|denied|cancell?ed)/i.test(msg)
}

/** JSON-RPC method-not-found (-32601) and its transport wrappers. */
function isMethodUnsupported(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  if (code === -32601) return true
  const msg = (e as { message?: unknown }).message
  return typeof msg === 'string' && /method not (found|supported|available)|does not exist|not implemented/i.test(msg)
}

const round2 = (n: number) => Math.round(n * 100) / 100
