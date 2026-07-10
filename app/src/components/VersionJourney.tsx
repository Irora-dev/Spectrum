import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { perfMeasurable, perfToDate } from '../lib/spectrum/leaderboard'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { formatNav, formatPct } from '../lib/spectrum/format'
import { HoverPortal } from './HoverPortal'

// ─────────────────────────────────────────────────────────────────────────────
// The version journey — Spectrum's differentiating mechanic (immutable
// versions, opt-in migration) rendered as a timeline of craft:
//
//   v1 ●───────● v2 ───────◉ v3        (current glows in the basket's color)
//
// Each node carries its era's perf-to-date; hovering shows WHAT CHANGED vs the
// previous version (added / dropped / kept — diffed from the on-chain `top`
// composition, no extra fetches). Facts only, never an endorsement (§9).
// ─────────────────────────────────────────────────────────────────────────────

const pctColor = (p: number) => (p >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)')

/** Composition diff between two versions, from their `top` arrays. */
function diffVersions(prev: BasketSummary | undefined, cur: BasketSummary) {
  if (!prev) return null
  const prevSet = new Map(prev.top.map((t) => [t.address.toLowerCase(), t]))
  const curSet = new Map(cur.top.map((t) => [t.address.toLowerCase(), t]))
  const added = cur.top.filter((t) => !prevSet.has(t.address.toLowerCase())).map((t) => t.symbol)
  const dropped = prev.top.filter((t) => !curSet.has(t.address.toLowerCase())).map((t) => t.symbol)
  const kept = cur.top.filter((t) => prevSet.has(t.address.toLowerCase())).length
  return { added, dropped, kept }
}

export function VersionHoverCard({ chain, index }: { chain: BasketSummary[]; index: number }) {
  const v = chain[index]
  const diff = diffVersions(chain[index - 1], v)
  const perf = perfToDate(v) * 100
  return (
    <div
      className="search-pop w-56 rounded-2xl border border-white/15 p-3 shadow-[0_22px_50px_-12px_rgba(0,0,0,0.75)]"
      style={{ background: 'rgba(4,4,8,0.98)', backdropFilter: 'blur(12px)' }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-sm font-bold text-ink">
          ${v.symbol} <span className="font-mono text-[10px] font-normal text-ink-faint">v{index + 1}</span>
        </span>
        <span className="font-num text-xs tabular-nums" style={{ color: pctColor(perf) }}>
          {formatPct(perf)}
        </span>
      </div>
      <div className="mt-1 line-clamp-1 text-[11px] text-ink-dim">{v.name?.trim() || v.symbol}</div>
      <div className="mt-2 flex items-baseline gap-3 font-mono text-[10px] text-ink-faint">
        <span className="text-ink">${formatNav(v.navPerToken, 4)}</span> NAV
        {v.supersededBy == null && <span className="rounded-full border border-cyan/30 px-1.5 text-cyan">current</span>}
      </div>
      {diff && (
        <div className="mt-2.5 space-y-1 border-t border-white/10 pt-2 font-mono text-[10px]">
          {diff.added.length > 0 && <div className="text-teal">+ {diff.added.join(', ')}</div>}
          {diff.dropped.length > 0 && <div className="text-magenta">− {diff.dropped.join(', ')}</div>}
          <div className="text-ink-faint">{diff.kept} kept{diff.added.length === 0 && diff.dropped.length === 0 ? ' · reweighted' : ''}</div>
        </div>
      )}
      {!diff && <div className="mt-2.5 border-t border-white/10 pt-2 font-mono text-[10px] text-ink-faint">the original version</div>}
    </div>
  )
}

/** The full journey strip (row expansions, creator page). Null under 2 versions. */
export function VersionJourney({ chain }: { chain: BasketSummary[] }) {
  const [hover, setHover] = useState<{ i: number; rect: DOMRect } | null>(null)
  if (chain.length < 2) return null

  return (
    <div className="flex items-center">
      {chain.map((v, i) => {
        const current = !v.supersededBy
        const accent = basketSignatureColor(v.address, v.top[0])
        const perf = perfToDate(v) * 100
        return (
          <div key={`${v.chainId}:${v.address}`} className="flex items-center">
            {i > 0 && <span aria-hidden className="h-px w-6 bg-gradient-to-r from-white/10 to-white/25 sm:w-9" />}
            <Link
              to={`/token?addr=${v.address}&chain=${v.chainId}`}
              onMouseEnter={(e) => setHover({ i, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setHover((p) => (p?.i === i ? null : p))}
              className="group/node flex flex-col items-center gap-1 px-0.5"
            >
              <span
                className={`grid h-7 w-7 place-items-center rounded-full border font-mono text-[10px] tabular-nums transition-transform group-hover/node:scale-110 ${
                  current ? 'text-ink' : 'border-white/15 text-ink-faint'
                }`}
                style={
                  current
                    ? { borderColor: accent, boxShadow: `0 0 14px -2px ${accent}`, background: `${accent}1a` }
                    : undefined
                }
              >
                v{i + 1}
              </span>
              {perfMeasurable(v) ? (
                <span className="font-num text-[10px] tabular-nums" style={{ color: pctColor(perf) }}>
                  {perf >= 1000 ? `${Math.round(perf).toLocaleString()}%` : formatPct(perf)}
                </span>
              ) : (
                <span className="font-num text-[10px] tabular-nums text-ink-faint" title={`Below the $${(1000).toLocaleString()} TVL floor, NAV here is fee residue over near-zero supply, not performance.`}>—</span>
              )}
            </Link>
            {hover?.i === i && (
              <HoverPortal anchor={hover.rect} width={224}>
                <VersionHoverCard chain={chain} index={i} />
              </HoverPortal>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Tiny inline variant (creator rows): chips + connectors only. */
export function VersionJourneyMini({ chain }: { chain: BasketSummary[] }) {
  if (chain.length < 2) return null
  return (
    <span className="inline-flex items-center align-middle">
      {chain.map((v, i) => {
        const current = !v.supersededBy
        const accent = basketSignatureColor(v.address, v.top[0])
        return (
          <span key={`${v.chainId}:${v.address}`} className="inline-flex items-center">
            {i > 0 && <span aria-hidden className="h-px w-2.5 bg-white/15" />}
            <span
              className={`grid h-4 min-w-4 place-items-center rounded-full border px-0.5 font-mono text-[8px] tabular-nums ${
                current ? 'text-ink' : 'border-white/15 text-ink-faint'
              }`}
              style={current ? { borderColor: accent, background: `${accent}1a` } : undefined}
            >
              {i + 1}
            </span>
          </span>
        )
      })}
    </span>
  )
}
