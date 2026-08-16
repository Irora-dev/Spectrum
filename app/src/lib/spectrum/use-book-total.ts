import { useMemo } from 'react'
import { basketRowsFromPortfolio, deriveFoundBook } from './found-book'
import { usePortfolio } from './hooks'
import { useRawHoldings } from './use-raw-holdings'
import { useWalletGroup } from './use-wallet-group'

// ─────────────────────────────────────────────────────────────────────────────
// THE BOOK TOTAL — one number, "what do I hold overall", for chrome that is not
// the portfolio page (the nav readout, QOL round 2026-08-05).
//
// A THIN COMPOSITION, NEVER A SECOND IMPLEMENTATION: the same wallet group, the
// same raw sweep, the same held-basket fold and the same deriveFoundBook the
// homepage act (HomeOnboarding) and the portfolio ceremony (PortfolioIntro)
// already draw. One derivation means two surfaces cannot disagree about the
// same wallet, and the query keys are shared, so a caller adds no second read
// of anything the portfolio path already reads.
//
// LINKED WALLETS READ AS ONE BOOK (wallet-links.ts): the total is the group's,
// which is what the portfolio page shows, so the header and the page agree.
//
// HONESTY: `usd` is NULL until something priced actually came back. Not read
// yet, nothing priced, every RPC throttled — all null, never 0. A zero in the
// header reads as "your book is empty", which is a lie we cannot tell. Absent
// beats guessed.
// ─────────────────────────────────────────────────────────────────────────────

export interface BookTotal {
  /** Priced dollars read across the group. Null when nothing priced was read. */
  usd: number | null
  /** A first read is in flight and there is nothing to show yet. */
  isLoading: boolean
  /** A refresh is running behind a figure already on screen. */
  isFetching: boolean
  /** Wallets this one book reads (more than one once wallets are linked). */
  wallets: number
}

export function useBookTotal(address?: string): BookTotal {
  const group = useWalletGroup(address)
  const addresses = address ? group.addresses : undefined
  const raw = useRawHoldings(addresses)
  // Held BASKETS are part of the book too (the 2026-08-04 audit fold): the raw
  // sweep reads verified token lists, which can never carry a basket token, so
  // a wallet holding only baskets would otherwise read as nothing.
  const heldBaskets = usePortfolio(addresses)
  const book = useMemo(
    () =>
      deriveFoundBook([
        ...(raw.data?.holdings ?? []),
        ...basketRowsFromPortfolio(heldBaskets.data?.holdings ?? []),
      ]),
    [raw.data, heldBaskets.data],
  )
  return {
    // readableUsd sums only what priced (an unpriced row is null and adds
    // nothing), so "> 0" is exactly "something priced was actually read".
    usd: book.readableUsd > 0 ? book.readableUsd : null,
    isLoading: raw.isLoading || heldBaskets.isLoading,
    isFetching: raw.isFetching,
    wallets: addresses?.length ?? 0,
  }
}
