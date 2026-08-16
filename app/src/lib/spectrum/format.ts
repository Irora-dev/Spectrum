// Display helpers shared by Explore + Token. Numbers stay tabular (`tnum`) in the UI.

export function formatNav(n: number, dp = 4): string {
  if (!isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function formatGrouped(n: number, dp = 0): string {
  if (!isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

// PRIVACY MODE (owner 2026-08-03 ~11:2x, feature 5): one tap masks every
// HOLDINGS dollar as $•••• for screen shares and demos — percentages stay,
// and prices/market facts are public information so surfaces that show them
// use formatPrice/formatGrouped, which do not mask. Module-level flag so the
// pure formatters stay pure-shaped; the toggling surface re-renders the tree.
let moneyPrivacy = false
try {
  moneyPrivacy = typeof localStorage !== 'undefined' && localStorage.getItem('spectrum:privacy') === '1'
} catch {
  /* storage unavailable — privacy just starts off */
}
export function moneyPrivacyOn(): boolean {
  return moneyPrivacy
}
export function setMoneyPrivacy(on: boolean): void {
  moneyPrivacy = on
  try {
    localStorage.setItem('spectrum:privacy', on ? '1' : '0')
  } catch {
    /* device-local nicety only */
  }
}
export const MASKED_USD = '$••••'

// Money display law (owner 2026-08-02 ~23:5x: "$45.36K should be laid out as
// $45,000 — same for $450,000 when six digits — and on seven it goes to
// $1.15M"): full comma-grouped dollars up to six digits, compact only from a
// million. Sub-$1k keeps cents so small amounts stay meaningful.
export function formatUsdCompact(n: number): string {
  if (!isFinite(n) || n <= 0) return '—'
  if (moneyPrivacy) return MASKED_USD
  if (n >= 1_000_000)
    return '$' + n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })
  if (n >= 1_000) return '$' + Math.round(n).toLocaleString('en-US')
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/**
 * MONEY THAT HAS TO FIT INSIDE A MARK — a bento tile's breakdown label, where
 * three figures share one bar the width of a card. NOT for headline money:
 * the law above is the owner's ("$45.36K should be laid out as $45,000") and it
 * still governs every figure a page states on its own.
 *
 * The exception is his too, and narrower: for the cash tile's split he asked
 * for exactly "2.5k USDC, 3k USDG" (2026-08-06 12:49). At that size the
 * grouped form truncates to "$4,0…", which is not a smaller number — it is no
 * number at all, and an unreadable figure on a money surface is the failure
 * this whole formatter family exists to avoid.
 */
export function formatUsdTight(n: number): string {
  if (!isFinite(n) || n <= 0) return '—'
  if (moneyPrivacy) return MASKED_USD
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return '$' + Math.round(n).toLocaleString('en-US')
}

export function formatPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(dp)}%`
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// USD price across a wide magnitude range (tiny memecoins → 4-figure majors).
export function formatPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n <= 0) return '—'
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  if (n >= 0.01) return '$' + n.toFixed(4)
  if (n >= 0.0001) return '$' + n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
  // Micro-caps: condensed-zero notation (owner 2026-07-07 16:59 — "condense
  // the zeros down"): $0.0₆1103 = six zeros then the significant digits.
  // Never scientific notation.
  const zeros = -Math.floor(Math.log10(n)) - 1
  const digits = Math.round(n * 10 ** (zeros + 4)).toString().padStart(4, '0').replace(/0+$/, '') || '0'
  const SUB = '₀₁₂₃₄₅₆₇₈₉'
  const sub = String(zeros).split('').map((c) => SUB[Number(c)]).join('')
  return `$0.0${sub}${digits}`
}

// Compact "time since" for inception / freshness labels.
export function formatAge(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—'
  const d = sec / 86400
  if (d >= 1) return `${Math.round(d)}d`
  const h = sec / 3600
  if (h >= 1) return `${Math.round(h)}h`
  return `${Math.max(1, Math.round(sec / 60))}m`
}

// Maps a 24h change to the design system's accent for coloring.
export function changeAccent(n: number | null | undefined): 'teal' | 'alert' | 'ink' {
  if (n == null || !isFinite(n)) return 'ink'
  return n >= 0 ? 'teal' : 'alert'
}
