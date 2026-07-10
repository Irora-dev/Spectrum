import { useMemo, useState } from 'react'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { versionChain, perfToDate, perfMeasurable } from '../lib/spectrum/leaderboard'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { formatNav } from '../lib/spectrum/format'
import { HoverPortal } from './HoverPortal'
import { VersionJourney, VersionHoverCard } from './VersionJourney'

// ─────────────────────────────────────────────────────────────────────────────
// The creator's journey — CREATOR PAGE ONLY (owner call 2026-07-06): their
// longest version chain drawn as one line, each version a glowing node at
// where it stands TODAY (NAV vs its ~$1.00 launch), the $1.00 launch level as
// a dashed baseline. Creators with no ≥2 chain still get their arc (owner
// 12:34 — "see the performance of this person over time"): their largest
// current basket drawn launch → today, measurability-floor gated so dust
// never charts a perf claim. Honest framing: per-version CURRENT standing,
// not a stitched price history — that upgrade lands when the operator DB's
// snapshot indexer exists (full-life NAV across migrations). Hand-rolled SVG,
// same idiom as AssetHoverCard's spark. Facts only (§9).
// ─────────────────────────────────────────────────────────────────────────────

const W = 720
const H = 200
const PAD_X = 56
const PAD_Y = 30

// One dot on the journey line — a version (chain mode) or launch/today (single).
interface JourneyNode {
  nav: number
  /** label under the axis */
  axis: string
  /** perf line under the axis label (empty = none) */
  perf: string
  cur: boolean
}

function perfLabel(v: BasketSummary): string {
  const p = perfToDate(v) * 100
  return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 1000 ? Math.round(p).toLocaleString() : p.toFixed(1)}%`
}

export function CreatorJourney({ deployer }: { deployer: string }) {
  const { data: all } = useAllBaskets()
  const [hover, setHover] = useState<{ i: number; rect: DOMRect } | null>(null)

  // Longest chain (≥2 versions) among this creator's own baskets — the F2
  // spoof guard: chains resolve only within their OWN deployer's set.
  const { chain, single } = useMemo<{ chain: BasketSummary[]; single: BasketSummary | null }>(() => {
    const mine = (all ?? []).filter((b) => b.deployer?.toLowerCase() === deployer.toLowerCase())
    const heads = mine.filter((b) => !b.supersededBy)
    let best: BasketSummary[] = []
    for (const h of heads) {
      const c = versionChain(h.address, mine)
      if (c.length > best.length) best = c
    }
    if (best.length >= 2) return { chain: best, single: null }
    // fallback: the largest measurable current basket, drawn launch → today
    const top = [...heads].sort((a, b) => (b.aumUsd || 0) - (a.aumUsd || 0))[0]
    return { chain: [], single: top && perfMeasurable(top) ? top : null }
  }, [all, deployer])

  const chainMode = chain.length >= 2
  if (!chainMode && !single) return null

  const nodes: JourneyNode[] = chainMode
    ? chain.map((v, i) => ({ nav: v.navPerToken, axis: `v${i + 1} · $${v.symbol}`, perf: perfLabel(v), cur: !v.supersededBy }))
    : [
        { nav: 1, axis: 'launch', perf: '', cur: false },
        { nav: single!.navPerToken, axis: `$${single!.symbol} today`, perf: perfLabel(single!), cur: true },
      ]

  const navs = nodes.map((n) => n.nav)
  const maxNav = Math.max(...navs, 1)
  const minNav = Math.min(...navs, 1)
  const range = maxNav - minNav || 1
  const x = (i: number) => PAD_X + (i / (nodes.length - 1)) * (W - PAD_X * 2)
  const y = (nav: number) => H - PAD_Y - ((nav - minNav) / range) * (H - PAD_Y * 2)
  const pts = nodes.map((n, i) => `${x(i).toFixed(1)},${y(n.nav).toFixed(1)}`)
  const head = chainMode ? chain[chain.length - 1] : single!
  const accent = basketSignatureColor(head.address, head.top[0])
  const gid = `cj-${head.address.slice(2, 10)}`

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">The journey</h2>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            {chainMode
              ? `${chain.length} versions of $${head.symbol} · where each stands today vs its ~$1.00 launch`
              : `$${head.symbol} · where it stands today vs its ~$1.00 launch`}
          </p>
        </div>
        {chainMode && <VersionJourney chain={chain} />}
      </div>

      <div className="mt-4 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label={`NAV journey of $${head.symbol}`}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="var(--color-cyan)" />
              <stop offset="0.55" stopColor="var(--color-violet-bright)" />
              <stop offset="1" stopColor={accent} />
            </linearGradient>
            <linearGradient id={`${gid}-a`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={accent} stopOpacity="0.22" />
              <stop offset="1" stopColor={accent} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* the ~$1.00 launch baseline */}
          <line x1={PAD_X} x2={W - PAD_X} y1={y(1)} y2={y(1)} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 5" />
          <text x={W - PAD_X + 6} y={y(1) + 3} fontSize="9" fill="rgba(255,255,255,0.35)" fontFamily="monospace">
            $1.00
          </text>

          {/* area under the journey + the line itself */}
          <polygon points={`${PAD_X},${H - PAD_Y} ${pts.join(' ')} ${W - PAD_X},${H - PAD_Y}`} fill={`url(#${gid}-a)`} />
          <polyline points={pts.join(' ')} fill="none" stroke={`url(#${gid})`} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* nodes: value above, axis label below; the current one glows */}
          {nodes.map((n, i) => (
            <g key={i}>
              {n.cur && <circle cx={x(i)} cy={y(n.nav)} r="10" fill={accent} opacity="0.25" />}
              <circle
                cx={x(i)}
                cy={y(n.nav)}
                r={n.cur ? 5 : 4}
                fill={n.cur ? accent : '#0c0a14'}
                stroke={n.cur ? accent : 'rgba(255,255,255,0.45)'}
                strokeWidth="1.5"
              />
              <text x={x(i)} y={y(n.nav) - 12} textAnchor="middle" fontSize="11" fontFamily="monospace" fill="#f5f4fa">
                ${formatNav(n.nav, 2)}
              </text>
              <text x={x(i)} y={H - PAD_Y + 16} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.45)">
                {n.axis}
              </text>
              {n.perf && (
                <text
                  x={x(i)}
                  y={H - PAD_Y + 28}
                  textAnchor="middle"
                  fontSize="9"
                  fontFamily="monospace"
                  fill={n.perf.startsWith('+') ? 'var(--color-cyan)' : 'var(--color-magenta)'}
                >
                  {n.perf}
                </text>
              )}
              {/* generous invisible hover target → the shared what-changed card
                  (version chains only, launch/today has no diff to show) */}
              {chainMode && (
                <circle
                  cx={x(i)}
                  cy={y(n.nav)}
                  r="18"
                  fill="transparent"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => setHover({ i, rect: (e.currentTarget as SVGCircleElement).getBoundingClientRect() })}
                  onMouseLeave={() => setHover((p) => (p?.i === i ? null : p))}
                />
              )}
            </g>
          ))}
        </svg>
      </div>
      {hover && chainMode && (
        <HoverPortal anchor={hover.rect} width={224}>
          <VersionHoverCard chain={chain} index={hover.i} />
        </HoverPortal>
      )}

      <p className="mt-3 font-mono text-[9px] leading-relaxed text-ink-faint">
        {chainMode
          ? 'Each version is its own immutable basket; holders migrate only by choice. Values are live NAV per version, not a recommendation. '
          : 'Values are live NAV against the ~$1.00 launch convention, not a recommendation. '}
        Past performance is not indicative of future results.
      </p>
    </section>
  )
}

