import { stocksForChain } from './stocks'
import brand from '../../brand.config'
import { starterTokensEnabled, stocksEnabled } from '../../theme/brand'

// Launch-suggestion starters (owner 2026-07-30: "ensure the suggestions
// genuinely work — nvda, apple, pons and stonkbrokers to begin"). The seed set
// the builder/composer shelves show before a chain has organic basket data;
// the mechanical most-used-constituents list still leads once it exists, and
// PopularAssets re-ranks everything by live market data either way.
//
// Every entry must pass the builder's own findBestPool detection LIVE before
// it ships here — proven 2026-07-30 with scripts/rh-starter-suggestions-check.ts.
//
// ⚠ THOSE FIGURES ARE A SNAPSHOT, NOT A PROPERTY, AND THEY MOVED 400x IN NINE
// DAYS. The original note recorded NVDA $8.7M · AAPL $5.3M · PONS $671k ·
// STONKBROKER $1.29M as though they described the assets. SpectrumContracts
// re-ran the SAME script on 2026-08-08: NVDA $183k (−97.9%), AAPL $12.5k
// (−99.8%) AND ITS VENUE CHANGED V4→V3, PONS $1.23M (+83%). Nothing re-runs the
// probe, so the prose was the only evidence and it had silently stopped being
// true — the same defect as any load-bearing number restated in a comment.
//
// The dollar figures are deliberately NOT updated here. Rewriting them would
// re-create the identical trap with fresher numbers; a shelf whose justification
// is a hand-run script is unverified between runs BY CONSTRUCTION, and that is
// the honest thing for this comment to say. Re-run the script before trusting
// any of it, and treat a starter as a suggestion the live depth ranking still
// has to survive — not as a vetted asset.
//
// WHETHER AAPL SHOULD STILL BE A STARTER at $12.5k is an owner call and is on
// the owner's desk (2026-08-09), not decided here: removing an owner-chosen starter
// is his ruling to make, and the drift is evidence for it rather than a mandate.
//
// Stock addresses come from the official-registry shelf
// (stocks.ts), never restated. STONKBROKER was picked out of TEN same-name
// Blockscout results as the one with 9,987 holders AND the only real pool
// (the runner-up "STONKBROKER" reads $0 depth) — on this chain the name alone
// identifies nothing; re-run the probe before ever swapping this address.
export interface StarterSuggestion {
  address: string
  symbol: string
}

const ROBINHOOD_TOKEN_STARTERS: StarterSuggestion[] = [
  { symbol: 'PONS', address: '0x39dBED3a2bd333467115dE45665cC57F813C4571' },
  { symbol: 'STONKBROKER', address: '0xe934e36A439C94017B64a3FecE66AF12099aBF50' },
]

// The memecoin starters are a LAUNCH-WEEK bootstrap only (owner 2026-07-30:
// "suggested for the first week and then it defaults to trending over a $10M
// mcap"). After this date they drop out and the shelf is the organic pool
// under PopularAssets' existing ranking — large-cap gainers (≥$10M mcap)
// float to the front, which is exactly the requested default. The official-
// registry stocks stay (they are the shelf's identity, not an endorsement of
// a third-party token).
const MEMECOIN_STARTERS_UNTIL = Date.parse('2026-08-06T23:59:59Z')

const ROBINHOOD_STARTER_STOCKS = ['NVDA', 'AAPL']

/** The launch starter set for a chain ([] where none is curated, or where the
 *  operator turned starters off). Kit config governs BOTH gates: the whole set
 *  needs `starterTokens !== false`, and the stock entries additionally respect
 *  `stocks` — an operator who hid every stock surface must not still be
 *  suggesting NVDA in their launch builder. */
export function starterSuggestionsFor(chainId: number, now: number = Date.now()): StarterSuggestion[] {
  if (chainId !== 4663 || !starterTokensEnabled(brand)) return []
  const stocks = stocksEnabled(brand)
    ? stocksForChain(chainId)
        .filter((s) => ROBINHOOD_STARTER_STOCKS.includes(s.symbol))
        .map(({ symbol, address }) => ({ symbol, address }))
    : []
  return now <= MEMECOIN_STARTERS_UNTIL ? [...stocks, ...ROBINHOOD_TOKEN_STARTERS] : stocks
}
