// ─────────────────────────────────────────────────────────────────────────────
// QUOTE FRESHNESS — the staleness window both products' quotes honor.
//
// One number, one home (the split's S1): the basket side's swap quoting and
// the portfolio side's leg planning both bound a caller-supplied price age by
// this window. It used to live inside the basket's swap-quote module, which
// made the portfolio planner import a basket money module for one constant —
// a product-boundary crossing for a value that belongs to NEITHER side.
// swap-quote re-exports it, so its callers are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** Default bound applied to a caller-supplied `priceAgeMs` (ms). DexScreener's
 *  own cache TTL is ~30s, so 60s leaves headroom. */
export const DEFAULT_MAX_PRICE_AGE_MS = 60_000
