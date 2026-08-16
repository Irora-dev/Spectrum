// Alert rules: set by the user, evaluated locally, stored locally. No server,
// no account, no telemetry — and no advice. Every notification states a FACT
// about the user's own position ("WETH is 6.2pts over target"); nothing here
// may ever phrase a signal, a recommendation, or a suggestion to act.
//
// All three v1 rule types are derivable from a single poll with no history
// beyond the previous snapshot:
//   drift — an asset sits ≥ N points from its target (needs targets set).
//   value — the portfolio total crossed a threshold since the last check.
//   move  — a held basket's NAV moved ≥ N% over 24h (the summary's own figure,
//           available on every chain; per-underlying-asset moves need a price
//           source the main chain doesn't have, so v1 stays honest and
//           basket-level).

import type { PortfolioSnapshot } from './portfolio'
import { computeDrift } from './portfolio'

export type Rule =
  | { id: string; type: 'drift'; enabled: boolean; pts: number }
  | { id: string; type: 'value'; enabled: boolean; aboveUsd?: number; belowUsd?: number }
  | { id: string; type: 'move'; enabled: boolean; pct: number }

export interface Firing {
  /** Cooldown identity: rule × subject. One boundary oscillation ≠ N pings. */
  key: string
  title: string
  body: string
  /** Deep-link intent for the click-through (the site recomputes from live
   *  state; a link carries intent, never a plan). */
  intent: 'portfolio' | { token: { address: string; chainId: number } }
}

const fmtUsd = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 })

const signedPts = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}pts`
const signedPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

// Symbols are on-chain strings ANYONE can mint (airdropped spam baskets reach
// a watched wallet uninvited). The popup truncates in CSS; a notification has
// no such container, so cap and collapse here — a 200-char "symbol" full of
// newlines must not become the notification's whole body.
const label = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return (t.length > 24 ? `${t.slice(0, 24)}…` : t) || '?'
}

export function evaluateRules(input: {
  rules: Rule[]
  snapshot: PortfolioSnapshot
  /** Previous snapshot for the SAME address, else null (first read never fires
   *  value-crossings — there is nothing to have crossed). */
  prev: PortfolioSnapshot | null
  targets: Record<string, number>
}): Firing[] {
  const { rules, snapshot, targets } = input
  const prev = input.prev && input.prev.address === snapshot.address ? input.prev : null
  const out: Firing[] = []

  // A partial read is not a truthful basis for reference-comparing alerts: a
  // failed chain's holdings are MISSING, which would read as "under target"
  // (drift) or as a value drop/recovery (crossings) when nothing moved.
  // Drift needs THIS read complete; value needs BOTH reads complete. Move
  // stays live — it states a fact about a basket whose chain answered.
  const nowComplete = snapshot.chainsFailed.length === 0
  const prevComplete = prev != null && prev.chainsFailed.length === 0

  for (const rule of rules) {
    if (!rule.enabled) continue

    if (rule.type === 'drift') {
      if (!(rule.pts > 0) || !nowComplete) continue
      const drift = computeDrift(snapshot.assets, targets)
      for (const d of drift.perAsset) {
        if (Math.abs(d.deltaPts) < rule.pts) continue
        out.push({
          key: `drift:${rule.id}:${d.key}`,
          title: `${label(d.symbol)} is ${signedPts(d.deltaPts)} ${d.deltaPts > 0 ? 'over' : 'under'} target`,
          body: `Target ${d.targetPct.toFixed(1)}% · now ${d.currentPct.toFixed(1)}%`,
          intent: 'portfolio',
        })
      }
    }

    if (rule.type === 'value') {
      if (!prev || !nowComplete || !prevComplete) continue
      const was = prev.totalUsd
      const now = snapshot.totalUsd
      if (rule.aboveUsd != null && rule.aboveUsd > 0 && was < rule.aboveUsd && now >= rule.aboveUsd) {
        out.push({
          key: `value:${rule.id}:above:${rule.aboveUsd}`,
          title: `Portfolio crossed above ${fmtUsd(rule.aboveUsd)}`,
          body: `Now ${fmtUsd(now)} · was ${fmtUsd(was)} last check`,
          intent: 'portfolio',
        })
      }
      if (rule.belowUsd != null && rule.belowUsd > 0 && was > rule.belowUsd && now <= rule.belowUsd) {
        out.push({
          key: `value:${rule.id}:below:${rule.belowUsd}`,
          title: `Portfolio crossed below ${fmtUsd(rule.belowUsd)}`,
          body: `Now ${fmtUsd(now)} · was ${fmtUsd(was)} last check`,
          intent: 'portfolio',
        })
      }
    }

    if (rule.type === 'move') {
      if (!(rule.pct > 0)) continue
      for (const h of snapshot.held) {
        const c = h.change24hPct
        if (c == null || !isFinite(c) || Math.abs(c) < rule.pct) continue
        out.push({
          key: `move:${rule.id}:${h.chainId}:${h.address.toLowerCase()}`,
          title: `${label(h.symbol)} moved ${signedPct(c)} over 24h`,
          body: `Held value ${fmtUsd(h.valueUsd)} · NAV 24h change`,
          intent: { token: { address: h.address, chainId: h.chainId } },
        })
      }
    }
  }

  return out
}
