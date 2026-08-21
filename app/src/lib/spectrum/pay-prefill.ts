import { isAddress, type Address } from 'viem'
import { deriveFoundBook, type RawHolding } from './portfolio-handoff'
import { asTokenDecimals, hubPay, type HubToken, type PayToken } from './pay-token'

// ─────────────────────────────────────────────────────────────────────────────
// "THE SWAP CONSOLE DOESN'T KNOW WHAT YOU HOLD" (owner QOL round 2026-08-05,
// from his own captured idea: the swap page should interface the portfolio and
// basket systems and be smart about what you already have). The smallest honest
// first step is a FORM DEFAULT: open the pay side on the visitor's largest
// priced holding on this network instead of a static ETH. Nothing here touches
// quoting, routing or approvals — it only answers "which token should the box
// start on".
//
// REACT-FREE BY CONTRACT, like found-book.ts and raw-holdings.ts: this is handed
// what useRawHoldings already fetched, so the console never grows a second
// holdings reader, and the ordering law stays in ONE place — the found book's
// (priced value first, dust never tiles and never suggests).
//
// The honesty laws, unchanged from the book they come from:
//  · An unpriced holding is null, NEVER zero. It can never be the suggestion:
//    "your largest" is a claim about money, and for an unpriced row we do not
//    have that money to claim. Unpriced is not worthless, it is unpriced.
//  · Nothing priced on this network ⇒ null, and the caller keeps its existing
//    default exactly as it stood. Absent is never guessed.
//  · Only a token the console can actually pay with gets seated: a hub THIS
//    chain executes, or an ERC-20 where the any-token path exists. Every row
//    the sweep produced came from the same verified token list the pay picker
//    offers, and it only counts as priced because the same pool detection the
//    quote path uses found it a pool — so a suggestion is always something the
//    console can quote.
// ─────────────────────────────────────────────────────────────────────────────

export interface PayPrefillContext {
  chainId: number
  /** The hubs THIS chain can execute (the console's own hubChoices). */
  hubChoices: readonly HubToken[]
  /** Whether an ERC-20 pay side exists on this chain (LiFi coverage). */
  anyTokenPay: boolean
  /** This chain's WETH address, when it has one. A held hub asset seats as the
   *  HUB it is, never as a custom token, so the route stays the plain one. */
  weth?: string | null
  /** This chain's settlement-asset address (USDC / USDG). */
  usdc?: string | null
  /** Addresses the pay side must never become (the selected basket). */
  exclude?: (string | null | undefined)[]
}

/** The pay token to open on, or null to leave the caller's default alone. */
export function payTokenFromHoldings(holdings: RawHolding[], ctx: PayPrefillContext): PayToken | null {
  // Basket rows are excluded on principle as well as by construction: a basket
  // is not a plain leg the pay side can resolve (the same rule the seed CTA
  // follows), and the raw sweep cannot see one anyway.
  const here = holdings.filter((h) => h.chainId === ctx.chainId && !h.basket)
  // The found book IS the ordering: priced first, unpriced dropped from
  // `priced`, dust below the tile floor left out. topN = every row, because the
  // biggest holding this console can PAY with may sit below the majors window.
  const { priced } = deriveFoundBook(here, here.length)

  const skip = new Set(
    (ctx.exclude ?? []).filter(Boolean).map((a) => (a as string).toLowerCase()),
  )
  const weth = ctx.weth?.toLowerCase()
  const usdc = ctx.usdc?.toLowerCase()

  // Largest first, stepping past anything this chain cannot pay with — the
  // suggestion is "your biggest holding the console can trade", which is the
  // only version of it that can be honoured.
  for (const h of priced) {
    const addr = h.address.toLowerCase()
    if (skip.has(addr)) continue
    if (h.native) {
      if (ctx.hubChoices.includes('ETH')) return hubPay('ETH')
      continue
    }
    if (weth && addr === weth) {
      if (ctx.hubChoices.includes('WETH')) return hubPay('WETH')
      continue
    }
    if (usdc && addr === usdc) {
      if (ctx.hubChoices.includes('USDC')) return hubPay('USDC')
      continue
    }
    if (!ctx.anyTokenPay) continue
    // Same bounds the picker and the stored-pick parser enforce: a token
    // claiming absurd decimals is unreadable, not payable (formatUnits is
    // O(decimals²)), and a symbol is display text, so it stays short.
    const decimals = asTokenDecimals(h.decimals)
    if (decimals == null || !isAddress(h.address) || !h.symbol) continue
    return {
      kind: 'erc20',
      address: h.address as Address,
      symbol: h.symbol.slice(0, 24),
      decimals,
      chainId: ctx.chainId,
    }
  }
  return null
}
