import type { ExecLogEntry } from './exec-log'
import { showSymbol } from './safe-copy'
import { EXPORT_CAVEATS, type TradeHistory } from './trade-history'

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORT (16:4x feature 7): positions + the execution log's recorded
// events, as one spreadsheet-openable file. Pure builder — the page makes the
// blob. Real numbers regardless of the privacy eye: an explicit export click
// is the user asking for their own data, and a masked file would be useless.
// ─────────────────────────────────────────────────────────────────────────────

// SHOWN TEXT IS BOUNDED AND INERT even in a file (redteam round 7): csvEscape
// quotes a newline correctly per RFC 4180, but a spreadsheet still renders one
// holding across two visible rows — and a 300-character symbol makes a column
// nobody can read. The symbol is sanitized at the SOURCE here, so the escaping
// only has to handle commas and quotes, which is what it is for.
export function csvEscape(v: string | number | null | undefined): string {
  if (v == null) return ''
  let s = String(v)
  // FORMULA-INJECTION HARDENING (audit round 2, latent): a token SYMBOL is
  // attacker-controlled on-chain data, and a cell starting with = + - @ (or
  // tab/CR) executes in Excel/Sheets. Unreachable today only by accident
  // (every symbol happens to get a $ prefix) — the utility defends itself
  // now: dangerous leading chars get the standard apostrophe guard.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export interface CsvPosition {
  symbol: string
  kind: 'token' | 'basket' | 'lp'
  chain: string
  amount?: number
  priceUsd?: number
  valueUsd: number
  sharePct: number
}

export function buildPortfolioCsv(input: {
  exportedAtIso: string
  positions: CsvPosition[]
  /** Rows may carry the wallet that made them (a linked-wallet group export,
   *  2026-08-11): with several wallets in the book, "who did this" is part of
   *  the record, and a merged timeline without it cannot be reconciled. */
  activity: (ExecLogEntry & { wallet?: string })[]
}): string {
  const lines: string[] = []
  lines.push(`Spectrum portfolio export,${csvEscape(input.exportedAtIso)}`)
  lines.push('')
  lines.push('POSITIONS')
  lines.push('symbol,kind,chain,amount,price_usd,value_usd,share_pct')
  for (const p of input.positions) {
    lines.push(
      [
        csvEscape(`$${showSymbol(p.symbol)}`),
        p.kind,
        csvEscape(p.chain),
        p.amount != null ? String(Number(p.amount.toPrecision(8))) : '', // 8 sig figs: an amount, not float noise
        // sub-cent prices keep significance (audit find: toFixed(6) printed
        // a 3e-8 price as 0.000000 — a zero that isn't)
        p.priceUsd != null ? (p.priceUsd >= 0.01 ? p.priceUsd.toFixed(6) : p.priceUsd.toPrecision(6)) : '',
        p.valueUsd.toFixed(2),
        p.sharePct.toFixed(2),
      ].join(','),
    )
  }
  if (input.activity.length > 0) {
    // the wallet column appears only when the export actually spans wallets —
    // a single-wallet CSV keeps its exact old shape
    const multi = new Set(input.activity.map((e) => e.wallet ?? '')).size > 1
    lines.push('')
    lines.push('ACTIVITY (recorded on this device)')
    lines.push(`timestamp,kind,total_usd,simulated,${multi ? 'wallet,' : ''}symbol,delta_usd,realized_usd`)
    for (const e of input.activity) {
      const base = [
        new Date(e.ts).toISOString(),
        e.kind,
        e.totalUsd != null ? e.totalUsd.toFixed(2) : '',
        String(e.simulated),
        ...(multi ? [csvEscape(e.wallet ?? '')] : []),
      ]
      if (e.changes && e.changes.length > 0) {
        for (const c of e.changes)
          lines.push(
            [...base, csvEscape(`$${showSymbol(c.symbol)}`), c.deltaUsd.toFixed(2), c.realizedUsd != null ? c.realizedUsd.toFixed(2) : ''].join(','),
          )
      } else {
        lines.push([...base, '', '', ''].join(','))
      }
    }
  }
  return lines.join('\n') + '\n'
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TRADE HISTORY & COST-BASIS DOCUMENT (the owner 2026-08-11)
//
// The accountant's artifact: every router trade, dated, with the basis each
// disposal consumed and the gain it booked. Deliberately NOT called a tax
// report — the caveats print at the TOP of the file, before a single number,
// because a reader who skips them could file against a method their
// jurisdiction does not use. A footnote nobody scrolls to would be the same
// as not saying it.
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number | null | undefined): string => (n == null ? '' : n.toFixed(2))
const isoDay = (ts: number | null): string => (ts == null ? '' : new Date(ts * 1000).toISOString().slice(0, 10))
const isoFull = (ts: number | null): string => (ts == null ? 'unknown' : new Date(ts * 1000).toISOString())

export function buildTradeHistoryCsv(input: {
  exportedAtIso: string
  history: TradeHistory
  /** Basket address (lowercase) → ticker, for readability. The address is
   *  exported too: a ticker is creator-chosen and not an identity. */
  symbolOf: (basket: string, chainId: number) => string
  chainNameOf: (chainId: number) => string
  /** Wallets the document covers — with a linked group this is several, and a
   *  reader must know whose trades these are. */
  wallets: readonly string[]
  /** The window, when one was asked for. */
  fromIso?: string
  toIso?: string
}): string {
  const { history: h } = input
  const lines: string[] = []

  lines.push(`Spectrum trade history and tracked cost basis,${csvEscape(input.exportedAtIso)}`)
  lines.push(`Wallets,${csvEscape(input.wallets.join(' '))}`)
  if (input.fromIso || input.toIso) {
    lines.push(`Period,${csvEscape(`${input.fromIso ?? 'the beginning'} to ${input.toIso ?? 'today'}`)}`)
  }
  lines.push('')

  // THE CAVEATS FIRST — the document is unreadable-as-intended without them.
  lines.push('READ THIS FIRST')
  for (const c of EXPORT_CAVEATS) lines.push(csvEscape(c))
  lines.push('')

  lines.push('SUMMARY')
  lines.push(`Realized gain/loss (USD),${money(h.realizedUsd)}`)
  lines.push(`Disposals in period,${h.rows.filter((r) => r.kind !== 'buy').length}`)
  if (h.unpricedDisposals > 0) {
    lines.push(
      `Disposals with NO price,${h.unpricedDisposals},${csvEscape('their gain is NOT in the figure above — it is unknown, not zero')}`,
    )
  }
  if (h.partiallyCoveredDisposals > 0) {
    lines.push(
      `Partially covered disposals,${h.partiallyCoveredDisposals},${csvEscape('only the part with tracked basis booked a gain')}`,
    )
  }
  lines.push('')

  lines.push('TRADES')
  lines.push(
    'date,timestamp_utc,network,basket_symbol,basket_address,action,shares,proceeds_or_cost_usd,basis_consumed_usd,gain_usd,covered,shares_held_after,basis_held_after_usd,tx_hash',
  )
  for (const r of h.rows) {
    lines.push(
      [
        isoDay(r.ts),
        isoFull(r.ts),
        csvEscape(input.chainNameOf(r.chainId)),
        csvEscape(`$${showSymbol(input.symbolOf(r.basket, r.chainId))}`),
        r.basket,
        r.kind === 'buy' ? 'BUY' : r.kind === 'sell' ? 'SELL' : 'SELL (paid in ETH)',
        r.shares,
        // an unpriced disposal prints the WORD, never an empty cell that reads
        // as zero in a spreadsheet's sum
        r.settlementUsd == null ? 'unknown' : money(r.settlementUsd),
        money(r.basisUsd),
        r.kind === 'buy' ? '' : r.realizedUsd == null ? 'unknown' : money(r.realizedUsd),
        r.kind === 'buy' ? '' : r.partiallyCovered ? 'partial' : 'full',
        r.sharesAfter,
        money(r.basisAfterUsd),
        csvEscape(r.txHash ?? ''),
      ].join(','),
    )
  }
  return lines.join('\n') + '\n'
}
