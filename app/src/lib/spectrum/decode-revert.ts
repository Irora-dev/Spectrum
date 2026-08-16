import { decodeErrorResult, parseAbi, toFunctionSelector } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable revert decoding. A basket is its own V4 hook, so when it
// reverts inside a swap the PoolManager re-wraps the revert as v4-core's
// WrappedError(target, selector, reason, details) — the UI would otherwise
// surface "reverted with signature 0x90bfb865", which reads as a mystery. This
// unwraps that (recursively) and maps the protocol's custom-error selectors to
// names + actionable hints.
// ─────────────────────────────────────────────────────────────────────────────

const wrappedErrorAbi = parseAbi([
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
])
const WRAPPED_SELECTOR = '0x90bfb865'

// Signature → hint. Names mirror SpectrumBasket.sol / SpectrumSwapRouter.sol.
const HINTS: Record<string, string> = {
  'InsufficientFirstDeposit()':
    'the FIRST buy of a new basket seeds its reserves and must be at least 10 USDC — try again with a larger amount',
  // Two causes share this error and size tells them apart (measured 2026-08-15: a
  // deployment entry missing packsFundingSplit made every seed compose the legacy
  // unsplit payload, which acquires NOTHING and trips this same guard at any size —
  // the old pools-only hint sent a real operator hunting fee tiers for a config key).
  'FirstMintUnderValued()':
    'the seed bought less value than the 5% first-mint guard allows. Which cause is testable: if a clearly larger amount also fails on a freshly deployed basket, the buy’s funding split never reached the contract (this deployment’s entry is missing packsFundingSplit) and no amount can pass until that config is fixed; if only small amounts fail, the pools are thin — use a larger amount or calmer pools',
  'FirstMintLegMinRequired()': 'every leg of the first mint needs a non-zero minimum — refresh and retry',
  'SlippageExceeded()': 'the price moved past your slippage floor — refresh the quote or raise tolerance slightly',
  // Three causes share this error and their remedies are opposite (contracts,
  // measured 2026-08-04): the hint carries the user-side discriminator, never
  // a bare "retry" — a structurally dead leg makes retrying futile at any size.
  'LegMinNotMet()':
    'a protection floor on one constituent refused this trade. Which cause is testable: a smaller amount working right now means that pool is thin (size down); the same amount working ~30 minutes later means a passing buying burst (nothing was wrong); no amount ever working means a constituent has no tradeable market — retrying cannot help until it gains liquidity',
  'NoOutput()': 'the amount is too small — it rounds to zero output',
  'ZeroSupply()': 'the basket has no supply yet — it needs its first regular buy (min 10 USDC) before this action',
  'BadLegMinsLength()': 'internal quote mismatch (leg count) — refresh the page and retry',
  // ⛔ THE FACTORY THROWS THIS WHENEVER create2 RETURNS address(0) (SpectrumFactory
  // `_deployToken`), which means the basket’s CONSTRUCTOR reverted — and CREATE2
  // DISCARDS the inner reason, so the contract’s own error (InvalidEthPool,
  // DuplicateAsset, ForbiddenTokenStandard, WeightsNotFull, FeeOutOfBounds…) never
  // reaches us. The hint therefore states what is KNOWN, then the candidates, and
  // never picks one.
  //   It used to LEAD with "this exact configuration is already deployed (check
  // Explore before retrying)". That cause is NOT REACHABLE on this path, and the
  // sentence sent a live rehearsal hunting a duplicate that could not exist: the
  // launch flow mines a FRESH 256-bit random salt (salt-mining.ts `randomSaltBase`)
  // against the factory’s OWN predictTokenAddress oracle, so the target address
  // cannot already be occupied — measured 2026-08-13 against the very factory that
  // threw it, whose allBasketsLength() was ZERO. The cause that DID fire, reproduced
  // on both rehearsal chains, was a leg carrying a Uniswap V2 route: the current
  // contract generation rejects Venue.V2 in the constructor (`revert
  // InvalidEthPool()`), while the detector still ranks and emits V2 pools. Naming
  // the venue is what makes this actionable.
  'CREATE2Failed()':
    'the factory ran this basket\u2019s constructor and it refused the configuration. The contract does not report WHICH check failed — that reason is discarded when creation fails — so what follows is the candidate list, not a diagnosis. The usual cause is a leg routed through a venue this deployment will not accept: check each asset\u2019s venue and replace any that route through Uniswap V2. Less often — two legs holding the same asset, an asset the contract refuses (e.g. ERC-777), or weights/fee settings outside the allowed bounds. Retrying the same configuration cannot help',
  'MissingHookData()': 'the trade was sent without its protection payload — refresh and retry',
  'NothingToBurn()': 'nothing is pending for this crank',
  'BelowBridgeThreshold()': 'the pending amount is below the bridge threshold — let more fees accrue first',
  // No time estimate: 10 blocks is seconds on Base/Robinhood and minutes on
  // Ethereum, and the old "(about two minutes)" was only ever true on one of
  // them. The block count is the fact; the clock is the chain's business.
  'SlotNotOpen()':
    'another basket just launched — the factory takes a 10-block breather between launches; try again shortly',
  'MaxCostExceeded()': 'the launch price moved past your guard — refresh and retry',
  'InsufficientPayment()': 'the transaction carried less ETH than the launch price — refresh and retry',
}

const ERROR_SIGS = [
  'BelowBridgeThreshold()',
  'CrankFloorRequired()',
  'BadCreatorShare()',
  'CREATE2Failed()',
  'BadLegMask()',
  'BadLegMinsLength()',
  'BelowBridgeThreshold()',
  'DuplicateAsset()',
  'EmptyBasket()',
  'ExactInputOnly()',
  'FeeOutOfBounds()',
  'FirstMintLegMinRequired()',
  'FirstMintUnderValued()',
  'ForbiddenTokenStandard()',
  'InsufficientFirstDeposit()',
  'InsufficientPayment()',
  'InvalidAsset()',
  'InvalidCanonicalKey()',
  'InvalidEthPool()',
  'LegMinNotMet()',
  'MaxCostExceeded()',
  'MetadataAlreadySet()',
  'MissingHookData()',
  'NoOutput()',
  'NotFactory()',
  'NotInitialized()',
  'NothingToBurn()',
  'OnlySelf()',
  'PoolAlreadyInitialized()',
  'SlippageExceeded()',
  'SlotNotOpen()',
  'UnknownAction()',
  'WeightsNotFull()',
  'WrongPool()',
  'ZeroSupply()',
] as const

// ── THE PORTFOLIO BATCHER'S VOCABULARY (pass-one LOW-3, 2026-08-14): the app
// could not name a single SpectrumPortfolioBatcher revert — the most likely
// live case, a required leg's 0x route going stale between quote and preview,
// read as an anonymous sentence. Signatures verbatim from
// SpectrumPortfolioBatcher.sol:361-399; the argful ones decode their args so
// a failing leg is NAMED by index (the contract carries only the index for a
// required-leg failure by design — the inner reason bytes exist only on the
// optional path's LegSkipped event, so the leg is nameable, the cause is not).
const portfolioErrorAbi = parseAbi([
  'error DeadlinePassed()',
  'error DeadlineTooFar(uint256 deadline, uint256 maxAllowed)',
  'error FeeAboveCeiling()',
  'error ZeroAddress()',
  'error NoLegs()',
  'error TooManyLegs()',
  'error BudgetsExceedFunding()',
  'error OnlySelf()',
  'error AggCallFailed()',
  'error MinBuyNotMet(uint256 delivered, uint256 floor)',
  'error LegOverspent(uint256 used, uint256 budget)',
  'error BuyIsFundingAsset()',
  'error RequiredLegFailed(uint256 index)',
  'error Reentrancy()',
  'error RouterHasNoCode()',
  'error RecipientIsSelf()',
  'error ZeroFloor(uint256 index)',
  'error BuyTokenHasNoCode(uint256 index)',
  'error FeeRecipientIsSelf()',
  'error BurnSinkHasNoCode()',
  'error BurnPoolDoesNotPriceAsset()',
  'error BurnPoolNotEthDenominated()',
  'error BurnAssetNotPriceable()',
  'error BurnTwapUnavailable()',
  'error BurnFloorIsZero()',
  'error BurnSwapFailed()',
  'error MinBurnNotMet(uint256 delivered, uint256 floor)',
  'error BurnSendFailed()',
  'error BurnFallbackSinkInvalid()',
  // ── present in the DEPLOYED ABI, absent from the .sol section first read
  // (SpectrumContracts' close-out table, 2026-08-14 — library-level transfer
  // guards; the deployed bytes are the vocabulary, not the source excerpt) ──
  'error ApproveFailed()',
  'error TransferFromFailed()',
  'error TransferFailed()',
  // ── the REBALANCE batcher's own vocabulary (dark build, 2026-08-15 — the
  // contract is undeployed; entries land ahead so the first live revert
  // already speaks; selectors verified by pin against the FE guide's table) ──
  'error NothingToDo()',
  'error SellIsFundingAsset()',
  'error SellFloorNotMet(uint256 delivered, uint256 floor)',
  'error SellOverspent(uint256 used, uint256 budget)',
  'error RequiredSellFailed(uint256 index)',
  'error RequiredBuyFailed(uint256 index)',
  'error BuyExceedsPot(uint256 asked, uint256 pot)',
  'error ConservationBroken()',
])

/** One honest sentence per portfolio revert. `{n}` interpolates the decoded
 *  leg index (1-based for humans) where the error carries one. */
/** Exported so tests can pin MATCHERS against the live sentences rather than a
 *  copy of them — the copy drifts, and a prose-keyed matcher fails silently when
 *  it does (measured: correcting "failed on-chain" quietly removed a recovery
 *  door from the UI, 2026-08-16). */
export const PORTFOLIO_HINTS: Record<string, string> = {
  DeadlinePassed: 'this batch expired before it reached the network — re-open the review to compose a fresh one',
  DeadlineTooFar: 'this batch asked for a longer life than the contract allows — re-open the review; if it repeats, the device clock is wrong',
  FeeAboveCeiling: 'the composed fee is above the contract’s ceiling — nothing was bought; report this, it should be impossible from this app',
  ZeroAddress: 'the batch named a zero address where a real one is required — report this, it should be impossible from this app',
  NoLegs: 'the batch carried no legs — re-open the review',
  TooManyLegs: 'the batch carries more legs than the contract takes in one go — split the plan',
  BudgetsExceedFunding: 'the legs plus the fee exceed what the batch pulls — re-open the review to recompose',
  OnlySelf: 'an internal-only entry point was called directly — report this, it should be impossible from this app',
  AggCallFailed: 'the route contract itself rejected the call — re-open the review to re-quote',
  MinBuyNotMet: 'a leg delivered under the floor we set for it — the market moved past the quote; re-open the review to re-quote',
  LegOverspent: 'a route tried to pull more than its leg’s budget — refused by the contract; re-quote, and report it if it repeats',
  BuyIsFundingAsset: 'a leg tries to buy the funding asset itself — remove that leg',
  NothingToDo: 'the rebalance carried no legs at all — re-open the review',
  SellIsFundingAsset: 'a sell leg sells the funding asset itself — a cash trim is funding, not a sale; report this, it should be impossible from this app',
  SellFloorNotMet: 'a sale yielded under the floor we set for it — the market moved past the quote; re-open the review to re-quote',
  SellOverspent: 'a route tried to pull more than its sell leg allows — refused by the contract; re-quote, and report it if it repeats',
  // same class as RequiredLegFailed above: shared with the PRE-SEND preview, so
  // it may not claim a chain event — 'refused' is true either way
  RequiredSellFailed:
    'sale {n} refused. Most often its quote went stale between the review and the moment it ran. Nothing moved: one required sale failing rolls the whole rebalance back. re-open the review to try again on fresh prices',
  RequiredBuyFailed:
    'buy {n} refused. Most often its quote went stale, or the sales yielded less than it needs. Nothing moved. re-open the review to try again on fresh prices',
  BuyExceedsPot: 'a buy asked for more funding than the sales produced — the contract refused the whole rebalance; re-open the review to recompose',
  ConservationBroken: 'the contract’s own money-conservation check failed — nothing moved; report this immediately',
  // ⚠ "failed ON-CHAIN" WAS FALSE ON THE PATH THAT SHOWS IT MOST (the owner, live
  // 2026-08-15, six times in a row). This one string is shared by two callers:
  // a genuinely mined revert, and the PRE-SEND preview — and the preview is the
  // common one, where nothing was signed, no transaction exists and no gas was
  // spent. Every refusal therefore read as "your transaction reverted on
  // chain", which sent the owner AND this lane hunting a chain problem that had
  // not happened, and implied money had moved and come back when it never left.
  //
  // "refused" is true in BOTH contexts, which is the only way one shared string
  // can be honest; the caller supplies whether it was a preview or a mined tx.
  RequiredLegFailed:
    'leg {n}’s route refused. Most often its quote went stale between the review and the moment it ran. Nothing was bought: one required leg failing rolls the whole batch back, so your balances are untouched. re-open the review to try again on fresh prices',
  Reentrancy: 'the contract refused a reentrant call — report this, it should be impossible from this app',
  RouterHasNoCode: 'the route target has no code on this network — the deployment is misconfigured; do not retry, report it',
  RecipientIsSelf: 'the payout address is the batch contract itself — report this, it should be impossible from this app',
  ZeroFloor: 'leg {n} carries no protection floor — refused by the contract; re-open the review to recompose',
  BuyTokenHasNoCode: 'leg {n}’s token has no code on this network — remove that leg; it does not exist here',
  FeeRecipientIsSelf: 'the fee sink is the batch contract itself — the deployment is misconfigured; do not retry, report it',
  BurnSinkHasNoCode: 'the fee’s burn plumbing is misconfigured on this network (sink has no code) — the batch cannot complete; report it',
  BurnPoolDoesNotPriceAsset: 'the fee’s burn pricing pool does not quote this funding asset — the batch cannot complete on this network; report it',
  BurnPoolNotEthDenominated: 'the fee’s burn pricing pool is not ETH-denominated — misconfiguration; report it',
  BurnAssetNotPriceable: 'the fee’s burn leg cannot price this funding asset — the batch cannot complete on this network; report it',
  BurnTwapUnavailable: 'the fee’s burn price history is too short right now — try again shortly',
  BurnFloorIsZero: 'the fee’s burn share priced at nothing — refused rather than sold unguarded; try again shortly',
  BurnSwapFailed: 'the fee’s burn route did not execute — the share diverts to the fallback sink, nothing is stranded; retry is safe',
  MinBurnNotMet: 'the fee’s burn swap delivered under its own floor — the market moved; retry',
  BurnSendFailed: 'the burn sink refused the transfer — misconfiguration; report it',
  BurnFallbackSinkInvalid: 'the burn fallback sink is invalid on this network — misconfiguration; report it',
  ApproveFailed: 'the funding token refused the contract’s own approval step — unusual token behaviour; report it with the funding asset',
  TransferFromFailed: 'pulling the funding from your wallet failed — check the approval and balance, then retry',
  TransferFailed: 'a token transfer inside the batch failed — unusual token behaviour; report it with the asset',
}

/** Decode a portfolio-batcher revert into its named sentence, or null when the
 *  selector is not the portfolio contract's. Argful errors name the leg
 *  (1-based) so “which asset failed” is answerable from the review’s own row
 *  order — the contract gives us the index, never the cause. */
function portfolioReason(data: `0x${string}`): string | null {
  try {
    const dec = decodeErrorResult({ abi: portfolioErrorAbi, data })
    const hint = PORTFOLIO_HINTS[dec.errorName]
    const idx = dec.args && dec.args.length > 0 && typeof dec.args[0] === 'bigint' ? (dec.args[0] as bigint) : null
    const withIndex = hint && idx != null ? hint.replace('{n}', String(idx + 1n)) : hint
    return withIndex ? `${dec.errorName} — ${withIndex}` : dec.errorName
  } catch {
    return null
  }
}

// selector (0x + 8 hex) → signature. toFunctionSelector keccaks the signature —
// the computation is identical for functions and errors.
const BY_SELECTOR = new Map<string, string>(ERROR_SIGS.map((sig) => [toFunctionSelector(sig), sig]))

function nameFor(selector: string): string | null {
  const sig = BY_SELECTOR.get(selector.toLowerCase())
  if (!sig) return null
  const name = sig.replace('()', '')
  const hint = HINTS[sig]
  return hint ? `${name} — ${hint}` : name
}

/** Dig the raw revert data (0x…) out of a viem error chain. */
export function revertDataOf(e: unknown): `0x${string}` | null {
  let cur: unknown = e
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const o = cur as { data?: unknown; cause?: unknown }
    const d = o.data
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) return d as `0x${string}`
    // viem sometimes nests { data: { data: '0x…' } } or exposes raw signatures in message only
    if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') {
      const dd = (d as { data: string }).data
      if (dd.startsWith('0x') && dd.length >= 10) return dd as `0x${string}`
    }
    cur = o.cause
  }
  return null
}

/**
 * The CONTRACT's own reason, or null when the failure was never a contract
 * revert at all — an unreachable endpoint, a timeout, a wrong RPC. Narrower than
 * `friendlyRevert` on purpose: it decodes only, and never translates node/wallet
 * noise into a claim about what a contract decided.
 */
export function contractReasonOf(e: unknown): string | null {
  const data = revertDataOf(e)
  if (data) {
    // the portfolio batcher first — its argful errors decode a leg index the
    // bare selector map cannot carry
    const p = portfolioReason(data)
    if (p) return p
    const named = nameFor(data.slice(0, 10))
    if (named) return named
  }
  // viem often carries only the bare signature in the message text.
  const m = rawMessageOf(e).match(/signature[:\s]+(0x[0-9a-fA-F]{8})/)
  if (m) return nameFor(m[1])
  return null
}

/** The raw message off an error/viem error, before any translation. */
export function rawMessageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string') return e.shortMessage
  if (e instanceof Error) return e.message
  return String(e)
}

// ⛔ WHAT A FAILED PRICE READ IS ALLOWED TO SAY (owner, 2026-08-13: "i thought
// we removed auction slots in new contracts????"). The catch around
// `currentDeployPrice()` used to answer EVERY failure with "Auction slot is not
// open yet — one deploy per slot", which was wrong twice over: the shipped
// factories charge a FLAT LAUNCH_FEE_WEI and have no auction at all, and a
// failed READ is no evidence about the factory's schedule — an RPC hiccup or a
// bad endpoint was being reported as a confident claim about launch timing.
//
// The factory's only genuine refusal here is its own revert, SlotNotOpen(),
// which is decoded and stated as itself. Everything else says what is actually
// known: the price could not be read.
export const LAUNCH_PRICE_UNREADABLE =
  'The launch price could not be read just now — that is the network or this app’s RPC endpoint, not a refusal by the factory. Check your connection and try again.'

/** The honest sentence for a `currentDeployPrice()` read that did not return. */
export function launchPriceUnavailable(e: unknown): string {
  const reason = contractReasonOf(e)
  return reason ? `Cannot launch right now: ${reason}.` : LAUNCH_PRICE_UNREADABLE
}

/** Best-effort readable message for a contract revert. Falls back to the input. */
export function friendlyRevert(e: unknown, fallback: string): string {
  // 0. money before mechanics: an underfunded tx surfaces as node/wallet noise
  // ("OutOfFunds", "insufficient funds", Rabby's "transaction creation failed")
  // — translate it before hunting for revert selectors.
  if (/outoffunds|insufficient funds|exceeds the balance|transaction creation failed/i.test(fallback)) {
    return 'Not enough ETH in this wallet to cover the transaction value plus gas.'
  }
  // 1. raw revert data on the error chain → decode (possibly nested) WrappedError
  let data = revertDataOf(e)
  let emptyHookReason = false
  let unwrapped = false
  for (let depth = 0; depth < 4 && data && data.slice(0, 10).toLowerCase() === WRAPPED_SELECTOR; depth++) {
    try {
      const dec = decodeErrorResult({ abi: wrappedErrorAbi, data })
      const reason = dec.args?.[2] as `0x${string}` | undefined
      // An EMPTY reason is itself a diagnosis: the hook reverted with no data,
      // which is what a constituent's own swap does when it has no usable
      // route or liquidity (measured on a fresh 4-leg basket, 2026-08-02).
      // Reporting it as "unknown" sent people hunting slippage settings.
      if (!reason || reason.length < 10) {
        emptyHookReason = reason != null && reason.length <= 2
        break
      }
      data = reason
      unwrapped = true
    } catch {
      break
    }
  }
  if (emptyHookReason)
    return 'One of this basket\u2019s constituents could not be traded at all right now — its pool returned nothing, which usually means that token has no liquidity on this network yet. This is the basket, not your settings: a different amount or slippage will not change it.'
  if (data) {
    const p = portfolioReason(data)
    if (p) return `Batch reverted: ${p}.`
    const named = nameFor(data.slice(0, 10))
    if (named) return `Basket reverted: ${named}.`
    // An UNKNOWN selector inside the hook wrap is a CONSTITUENT's own error —
    // none of our contracts throw it. Measured live 2026-08-15 (TEST10006's
    // FWA leg, 0x2f352531 carried by FWA's own bytecode): the token trades
    // FINE on the open market — its real $944k market is a HOOKED v4 pool
    // baskets cannot route, so the leg rode a $15k hookless side pool and the
    // hook-launched token refused that venue. Owner correction on the first
    // wording ("you can buy fwa off the open market"): the token is not
    // untradeable — the BASKET's available route is what it refuses.
    if (unwrapped) {
      return `One holding refused this route with its own rule (${data.slice(0, 10)} — the token’s own error, not this protocol’s). Tokens launched on a hooked pool often trade only through their own market, which this contract generation’s baskets cannot route (hooked-leg support is being designed) — the token stays buyable there, but this basket’s leg rides a side pool it refuses. Amount and slippage change nothing; for now the mix needs that holding swapped for one that trades on an open pool.`
    }
  }
  // 2. no data — viem often puts the bare signature in the message
  const m = fallback.match(/signature[:\s]+(0x[0-9a-fA-F]{8})/)
  if (m) {
    // The wrapper carries the REAL cause in its `reason` field, but here we only
    // have the bare signature from the message — the data never reached us. Say
    // what is known and NOTHING beyond it. (This used to assert "commonly the 10
    // USDC first-buy minimum", which sent a real user hunting a minimum they had
    // already cleared: the actual cause, decoded from chain, was LegMinNotMet on
    // an established basket. A guess presented as a diagnosis is worse than no
    // diagnosis.)
    if (m[1].toLowerCase() === WRAPPED_SELECTOR)
      return 'The basket rejected this trade inside the pool, and the wallet did not return the reason. The usual causes are a per-constituent floor missing on a thin pool, or the price moving past your slippage tolerance — retry with a slightly higher tolerance, and if it keeps failing report it with the basket and amount.'
    const named = nameFor(m[1])
    if (named) return `Basket reverted: ${named}.`
  }
  return fallback
}
