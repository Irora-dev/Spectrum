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
  'FirstMintUnderValued()':
    'the seed buy moved the constituents more than the 5% first-mint guard allows — use a larger amount or calmer pools',
  'FirstMintLegMinRequired()': 'every leg of the first mint needs a non-zero minimum — refresh and retry',
  'SlippageExceeded()': 'the price moved past your slippage floor — refresh the quote or raise tolerance slightly',
  'LegMinNotMet()': 'a constituent filled below its per-leg minimum — refresh the quote or raise tolerance slightly',
  'NoOutput()': 'the amount is too small — it rounds to zero output',
  'ZeroSupply()': 'the basket has no supply yet — it needs its first regular buy (min 10 USDC) before this action',
  'BadLegMinsLength()': 'internal quote mismatch (leg count) — refresh the page and retry',
  'CREATE2Failed()':
    'the basket contract could not be created — either this exact configuration is already deployed (check Explore before retrying) or a leg\u2019s route was rejected; re-add the assets and try again',
  'MissingHookData()': 'the trade was sent without its protection payload — refresh and retry',
  'NothingToBurn()': 'nothing is pending for this crank',
  'BelowBridgeThreshold()': 'the pending amount is below the bridge threshold — let more fees accrue first',
}

const ERROR_SIGS = [
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
  'InvalidAsset()',
  'InvalidCanonicalKey()',
  'InvalidEthPool()',
  'LegMinNotMet()',
  'MetadataAlreadySet()',
  'MissingHookData()',
  'NoOutput()',
  'NotFactory()',
  'NotInitialized()',
  'NothingToBurn()',
  'OnlySelf()',
  'PoolAlreadyInitialized()',
  'SlippageExceeded()',
  'UnknownAction()',
  'WeightsNotFull()',
  'WrongPool()',
  'ZeroSupply()',
] as const

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
  for (let depth = 0; depth < 4 && data && data.slice(0, 10).toLowerCase() === WRAPPED_SELECTOR; depth++) {
    try {
      const dec = decodeErrorResult({ abi: wrappedErrorAbi, data })
      const reason = dec.args?.[2] as `0x${string}` | undefined
      if (!reason || reason.length < 10) break
      data = reason
    } catch {
      break
    }
  }
  if (data) {
    const named = nameFor(data.slice(0, 10))
    if (named) return `Basket reverted: ${named}.`
  }
  // 2. no data — viem often puts the bare signature in the message
  const m = fallback.match(/signature[:\s]+(0x[0-9a-fA-F]{8})/)
  if (m) {
    if (m[1].toLowerCase() === WRAPPED_SELECTOR)
      return `${fallback} (the basket's hook reverted inside the pool — commonly the 10 USDC first-buy minimum on a fresh basket)`
    const named = nameFor(m[1])
    if (named) return `Basket reverted: ${named}.`
  }
  return fallback
}
