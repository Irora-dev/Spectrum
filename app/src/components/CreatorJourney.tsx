import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { ensureLaunchIndex, type BasketSummary } from '../lib/spectrum/basket-data'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { versionChain, perfToDate, perfMeasurable } from '../lib/spectrum/leaderboard'
import { launchTimeLookup } from '../lib/spectrum/basket-sort'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { formatNav } from '../lib/spectrum/format'
import { HoverPortal } from './HoverPortal'
import { VersionJourney, VersionHoverCard } from './VersionJourney'
import { Bezel, Eyebrow } from './home/Spine'

// ─────────────────────────────────────────────────────────────────────────────
// The creator's journey — CREATOR PAGE ONLY (owner call 2026-07-06; owner
// 2026-08-06: "this should show their entire timeline of basket launches and
// updates, not just a single one").
//
// TIMELINE MODE (the default whenever ≥2 of their launches carry an indexed
// launch time): EVERY basket this creator deployed — live, superseded, every
// version — as a node placed at the moment it LAUNCHED (x = time, from the
// launch index discovery already builds) at where it stands TODAY (y = NAV vs
// the ~$1.00 launch line). Version chains connect their nodes in launch order,
// each chain in its own signature color, so an update reads as a step in one
// story and a fresh basket starts a new one.
//
// Honest framing, unchanged from the day this shipped: per-basket CURRENT
// standing, not a stitched price history — that upgrade lands when the
// operator DB's snapshot indexer exists. The disclaimer says exactly what a
// node is. Launches the index cannot date are COUNTED, never guessed onto the
// axis. Perf labels stay behind the measurability floor (§9).
//
// FALLBACK (fewer than two dated launches): the pre-timeline picture — the
// longest version chain in version order, else the largest measurable basket
// drawn launch → today. Hand-rolled SVG, same idiom as AssetHoverCard's spark.
// ─────────────────────────────────────────────────────────────────────────────

const W = 720
const H = 244
const PAD_X = 56
const PAD_Y = 40
/** Bottom padding stands apart from the top: THREE label rows + a perf tspan
 *  hang under the plot floor (18 + 2×13 + descenders), and deriving them from
 *  the shared pad let the deepest row hang below the viewBox (the v3 shot's
 *  clipped ticker). */
const PAD_B = 56

// One dot on the journey — a launch (timeline), a version (chain fallback), or
// launch/today (single fallback).
interface JourneyNode {
  nav: number
  /** label under the axis */
  axis: string
  /** perf line under the axis label (empty = none) */
  perf: string
  cur: boolean
  /** ms epoch in timeline mode; index elsewhere */
  t: number
  /** the chain this node belongs to (timeline mode) — hover + color */
  chainIdx: number
  /** position within that chain */
  vIdx: number
}

function perfLabel(v: BasketSummary): string {
  const p = perfToDate(v) * 100
  return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 1000 ? Math.round(p).toLocaleString() : p.toFixed(1)}%`
}

/** The launch index stores unix SECONDS (viem block timestamps) — convert
 *  here, once, or every date reads as January 1970. */
function dateLabel(unixSec: number, withYear: boolean): string {
  return new Date(unixSec * 1000).toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
}

/** Catmull-Rom through the nodes → one smooth cubic path. Two versions of a
 *  basket are a story, not a zigzag — the straight polyline read as an error
 *  bar. Two points degrade to the honest straight line. */
function smoothPath(p: { x: number; y: number }[]): string {
  if (p.length < 2) return ''
  if (p.length === 2) return `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)} L${p[1].x.toFixed(1)},${p[1].y.toFixed(1)}`
  let d = `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)]
    const p1 = p[i]
    const p2 = p[i + 1]
    const p3 = p[Math.min(p.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

export function CreatorJourney({ deployer }: { deployer: string }) {
  const { data: all } = useAllBaskets()
  const [hover, setHover] = useState<{ chainIdx: number; vIdx: number; rect: DOMRect } | null>(null)

  // The launch index is built LAZILY elsewhere (a side effect of per-basket
  // inception asks), so a fresh browser landing straight on a creator page
  // would have no dates and silently fall back. This page asks for its own
  // chains' indexes up front; each resolved index bumps `datedTick` and the
  // grouping below re-reads the (now populated) lookup.
  const mine = useMemo(
    () => (all ?? []).filter((b) => b.deployer?.toLowerCase() === deployer.toLowerCase()),
    [all, deployer],
  )
  const chainIds = useMemo(() => [...new Set(mine.map((b) => b.chainId))], [mine])
  const idxQueries = useQueries({
    queries: chainIds.map((id) => ({
      queryKey: ['spectrum', 'launch-index', id],
      queryFn: () => ensureLaunchIndex(id),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })
  const datedTick = idxQueries.filter((q) => q.data === true).length

  // Every basket of THIS deployer, grouped into version chains (root → head).
  // The F2 spoof guard holds: chains resolve only within their OWN deployer's
  // set.
  const { chains, undated, timeline, fallbackChain, fallbackSingle } = useMemo(() => {
    const heads = mine.filter((b) => !b.supersededBy)
    const groups = heads.map((h) => versionChain(h.address, mine)).filter((c) => c.length > 0)
    const ageOf = launchTimeLookup([...new Set(mine.map((b) => b.chainId))])
    const dated: { b: BasketSummary; t: number; chainIdx: number; vIdx: number }[] = []
    let missing = 0
    groups.forEach((c, chainIdx) =>
      c.forEach((b, vIdx) => {
        const t = ageOf(b)
        if (t != null) dated.push({ b, t, chainIdx, vIdx })
        else missing++
      }),
    )
    const distinctTimes = new Set(dated.map((d) => d.t)).size
    // Timeline needs two DISTINCT moments, or there is no axis to draw.
    if (dated.length >= 2 && distinctTimes >= 2) {
      return { chains: groups, undated: missing, timeline: dated.sort((a, b) => a.t - b.t), fallbackChain: [] as BasketSummary[], fallbackSingle: null as BasketSummary | null }
    }
    // Fallback: the pre-timeline picture.
    let best: BasketSummary[] = []
    for (const c of groups) if (c.length > best.length) best = c
    if (best.length >= 2) return { chains: groups, undated: 0, timeline: [], fallbackChain: best, fallbackSingle: null }
    const top = [...heads].sort((a, b) => (b.aumUsd || 0) - (a.aumUsd || 0))[0]
    return { chains: groups, undated: 0, timeline: [], fallbackChain: [], fallbackSingle: top && perfMeasurable(top) ? top : null }
    // datedTick: each freshly-built launch index re-runs the grouping so the
    // timeline appears the moment dates exist (the lookup reads a cache).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, datedTick])

  const timelineMode = timeline.length >= 2
  const chainMode = !timelineMode && fallbackChain.length >= 2
  if (!timelineMode && !chainMode && !fallbackSingle) return null

  // ── the nodes, whichever mode ──────────────────────────────────────────────
  const nodes: JourneyNode[] = timelineMode
    ? timeline.map((d) => ({
        nav: d.b.navPerToken,
        axis: chains[d.chainIdx].length > 1 ? `$${showSymbol(d.b.symbol)} v${d.vIdx + 1}` : `$${showSymbol(d.b.symbol)}`,
        perf: perfMeasurable(d.b) ? perfLabel(d.b) : '',
        cur: !d.b.supersededBy,
        t: d.t,
        chainIdx: d.chainIdx,
        vIdx: d.vIdx,
      }))
    : chainMode
      ? fallbackChain.map((v, i) => ({
          nav: v.navPerToken,
          axis: `v${i + 1} · $${showSymbol(v.symbol)}`,
          perf: perfMeasurable(v) ? perfLabel(v) : '',
          cur: !v.supersededBy,
          t: i,
          chainIdx: 0,
          vIdx: i,
        }))
      : [
          { nav: 1, axis: 'launch', perf: '', cur: false, t: 0, chainIdx: 0, vIdx: 0 },
          { nav: fallbackSingle!.navPerToken, axis: `$${showSymbol(fallbackSingle!.symbol)} today`, perf: perfLabel(fallbackSingle!), cur: true, t: 1, chainIdx: 0, vIdx: 1 },
        ]

  const navs = nodes.map((n) => n.nav)
  const maxNav = Math.max(...navs, 1)
  const minNav = Math.min(...navs, 1)
  const range = maxNav - minNav || 1
  const tMin = Math.min(...nodes.map((n) => n.t))
  const tMax = Math.max(...nodes.map((n) => n.t))
  const tSpan = tMax - tMin || 1
  const x = (t: number) => PAD_X + ((t - tMin) / tSpan) * (W - PAD_X * 2)
  const y = (nav: number) => H - PAD_B - ((nav - minNav) / range) * (H - PAD_Y - PAD_B)

  // ── the header's subject ───────────────────────────────────────────────────
  const liveHeads = chains.map((c) => c[c.length - 1]).filter((h) => h && !h.supersededBy)
  const hoverChain = timelineMode ? (hover ? chains[hover.chainIdx] : null) : fallbackChain
  const fallbackHead = chainMode ? fallbackChain[fallbackChain.length - 1] : fallbackSingle
  const accent = timelineMode
    ? 'var(--color-violet-bright)'
    : basketSignatureColor(fallbackHead!.address, fallbackHead!.top[0])
  const headPerf = !timelineMode && fallbackHead && perfMeasurable(fallbackHead) ? perfLabel(fallbackHead) : ''

  // Best / weakest / spread across every measurable LIVE basket (timeline) or
  // the chain's versions (fallback) — only when two can be priced.
  const priced = timelineMode ? liveHeads.filter((v) => perfMeasurable(v)) : chainMode ? fallbackChain.filter((v) => perfMeasurable(v)) : []
  const ranked = priced.length >= 2 ? [...priced].sort((a, b) => perfToDate(b) - perfToDate(a)) : []
  const best = ranked[0]
  const worst = ranked[ranked.length - 1]
  const gid = `cj-${deployer.slice(2, 10)}`
  const spanYears = timelineMode && new Date(tMax * 1000).getFullYear() !== new Date(tMin * 1000).getFullYear()
  const sameDay = timelineMode && new Date(tMax * 1000).toDateString() === new Date(tMin * 1000).toDateString()

  // ── label collision control ────────────────────────────────────────────────
  //    Launches minutes apart land at the same x, and two stagger rows were
  //    not enough for a burst of three (the first live look: three tickers
  //    overtyping at the right edge). Each node's AXIS label takes a row by
  //    how many neighbors sit within 30px before it (three rows cycle), and
  //    its VALUE dodges a second level the same way. Perf rides the axis
  //    label's own line as a colored tspan, so a row is one line tall.
  const labelRow = nodes.map((n, i) => {
    let near = 0
    for (let j = 0; j < i; j++) if (Math.abs(x(nodes[j].t) - x(n.t)) < 30) near++
    return near
  })

  const chainAccent = (ci: number) => {
    const head = chains[ci]?.[chains[ci].length - 1]
    return head ? basketSignatureColor(head.address, head.top[0]) : 'var(--color-violet-bright)'
  }

  // ── THE MOMENTS (owner 2026-08-06: "more akin to the moments of a creator's
  //    basket activity") — the same dated facts, told as EVENTS: a chain root
  //    is "Launched $X", a later version is "Updated to vN". Where a basket
  //    stands today rides each moment as a fact chip instead of being the
  //    y-axis, so the card reads as a story, not a scatter. ──────────────────
  const moments = timeline.map((d) => ({
    t: d.t,
    kind: d.vIdx === 0 ? ('launch' as const) : ('update' as const),
    b: d.b,
    vIdx: d.vIdx,
    chainIdx: d.chainIdx,
    cur: !d.b.supersededBy,
  }))
  const nLaunches = moments.filter((m) => m.kind === 'launch').length + undated
  const nUpdates = moments.filter((m) => m.kind === 'update').length
  /** Time → percent along the rail, padded so edge cards stay inside. */
  const pct = (t: number) => 8 + ((t - tMin) / tSpan) * 84
  // Slot assignment: moments minutes apart share an x, so each takes one of
  // four slots (above/below × near/far) by how crowded its neighborhood
  // already is — the burst-of-three lesson from the chart face, in DOM.
  const slot = moments.map((m, i) => {
    let near = 0
    for (let j = 0; j < i; j++) if (Math.abs(pct(moments[j].t) - pct(m.t)) < 14) near++
    return near % 4
  })
  // Card slots relative to the rail point: above/below near, then above/below
  // far for the third and fourth of a burst.
  const SLOT_CLASS = ['bottom-4', 'top-4', 'bottom-[104px]', 'top-[104px]'] as const
  const usesFarSlot = slot.some((s) => s >= 2)

  return (
    // THE JOURNEY WEARS THE HOUSE (owner 2026-08-06: "massively beautified"):
    // a double-bezel plate with its own light, the numbers said at the size
    // they deserve, and — same day — the WHOLE timeline (owner: "their entire
    // timeline of basket launches and updates, not just a single one").
    <section>
      <Bezel glow={accent}>
        <div className="p-6 sm:p-8">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <Eyebrow>the journey</Eyebrow>
              {timelineMode ? (
                <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h2 className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                    {nLaunches} launch{nLaunches === 1 ? '' : 'es'}
                  </h2>
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    {nUpdates > 0 ? `${nUpdates} update${nUpdates === 1 ? '' : 's'} · ` : ''}
                    {liveHeads.length} live ·{' '}
                    {sameDay ? `all on ${dateLabel(tMin, true)}` : `${dateLabel(tMin, spanYears)} → ${dateLabel(tMax, spanYears)}`}
                  </span>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h2 className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                    ${showSymbol(fallbackHead!.symbol)}
                  </h2>
                  {headPerf && (
                    <span
                      className="font-num text-2xl font-light tabular-nums sm:text-3xl"
                      style={{ color: headPerf.startsWith('-') ? 'var(--color-magenta)' : 'var(--color-teal)' }}
                    >
                      {headPerf}
                    </span>
                  )}
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    {chainMode ? `since launch · ${fallbackChain.length} versions` : 'since launch'}
                  </span>
                </div>
              )}
            </div>
            {chainMode && <VersionJourney chain={fallbackChain} />}
          </div>

          {timelineMode ? (
            <>
              {/* ── THE MOMENTS RAIL (sm+): time flows left → right, every
                     moment an event card anchored to when it happened. HTML,
                     not SVG — moment cards are text, and text stays readable
                     at every width instead of scaling with a viewBox. ── */}
              <div className="mt-6 hidden sm:block">
                <div className={`relative ${usesFarSlot ? 'h-[384px]' : 'h-[240px]'}`}>
                  {/* the rail itself */}
                  <div aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/12" />
                  {/* a chain's stretch of the rail wears its story's color */}
                  {chains.map((_, ci) => {
                    const ms = moments.filter((m) => m.chainIdx === ci)
                    if (ms.length < 2) return null
                    const l = pct(ms[0].t)
                    const r = pct(ms[ms.length - 1].t)
                    return (
                      <div
                        key={`strip-${ci}`}
                        aria-hidden
                        className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                        style={{ left: `${l}%`, width: `${Math.max(r - l, 0.5)}%`, background: chainAccent(ci), opacity: 0.6 }}
                      />
                    )
                  })}
                  {/* era marks: first and last date under the rail's ends */}
                  <span className="absolute left-0 top-1/2 mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                    {dateLabel(tMin, spanYears)}
                  </span>
                  <span className="absolute right-0 top-1/2 mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                    {dateLabel(tMax, spanYears)}
                  </span>

                  {moments.map((m, i) => {
                    const acc = chainAccent(m.chainIdx)
                    const canHover = chains[m.chainIdx]?.length > 1
                    const standing = perfMeasurable(m.b) ? perfLabel(m.b) : ''
                    return (
                      <div key={i} className="absolute top-1/2" style={{ left: `${pct(m.t)}%` }}>
                        {/* the marker on the rail */}
                        {m.cur && (
                          <span aria-hidden className="absolute left-0 top-0 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-20" style={{ background: acc }} />
                        )}
                        <span
                          aria-hidden={!canHover}
                          className={`absolute left-0 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${canHover ? 'cursor-pointer' : ''}`}
                          style={{ background: m.cur ? acc : '#0c0a14', borderColor: m.cur ? acc : 'rgba(255,255,255,0.45)' }}
                          onMouseEnter={canHover ? (e) => setHover({ chainIdx: m.chainIdx, vIdx: m.vIdx, rect: (e.currentTarget as HTMLSpanElement).getBoundingClientRect() }) : undefined}
                          onMouseLeave={canHover ? () => setHover((p) => (p?.chainIdx === m.chainIdx && p?.vIdx === m.vIdx ? null : p)) : undefined}
                        />
                        {/* the connector from marker to its card */}
                        <span
                          aria-hidden
                          className={`absolute left-0 w-px -translate-x-1/2 bg-white/15 ${
                            slot[i] === 0 ? 'bottom-2 h-2' : slot[i] === 1 ? 'top-2 h-2' : slot[i] === 2 ? 'bottom-2 h-[96px]' : 'top-2 h-[96px]'
                          }`}
                        />
                        {/* the moment card */}
                        <div className={`absolute left-1/2 w-28 -translate-x-1/2 text-center md:w-32 ${SLOT_CLASS[slot[i]]}`}>
                          <div className="font-mono text-[9px] uppercase tracking-[0.16em]" style={{ color: m.kind === 'update' ? 'var(--color-violet-bright)' : 'var(--color-cyan)' }}>
                            {m.kind === 'update' ? `update → v${m.vIdx + 1}` : 'launched'}
                          </div>
                          <div className="mt-1 truncate font-display text-sm font-bold text-ink">${m.b.symbol}</div>
                          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">{dateLabel(m.t, spanYears)}</div>
                          <div className="mt-1.5 font-num text-[12px] tabular-nums text-ink-dim">
                            ${formatNav(m.b.navPerToken, 2)}
                            {standing && (
                              <span className="ml-1.5" style={{ color: standing.startsWith('-') ? 'var(--color-magenta)' : 'var(--color-teal)' }}>
                                {standing}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* ── THE MOMENTS FEED (phone): the same story, read downward —
                     text at text size, no viewBox scaling, nothing hidden
                     behind a sideways scroll. ── */}
              <ol className="mt-6 sm:hidden">
                {moments.map((m, i) => {
                  const acc = chainAccent(m.chainIdx)
                  const standing = perfMeasurable(m.b) ? perfLabel(m.b) : ''
                  return (
                    <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
                      {/* the rail, vertical */}
                      <div className="relative flex w-4 shrink-0 justify-center">
                        {i < moments.length - 1 && <span aria-hidden className="absolute bottom-0 top-2 w-px bg-white/10" />}
                        <span aria-hidden className="relative mt-1 h-2.5 w-2.5 rounded-full border-2" style={{ background: m.cur ? acc : '#0c0a14', borderColor: m.cur ? acc : 'rgba(255,255,255,0.45)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono text-[9px] uppercase tracking-[0.16em]" style={{ color: m.kind === 'update' ? 'var(--color-violet-bright)' : 'var(--color-cyan)' }}>
                            {m.kind === 'update' ? `update → v${m.vIdx + 1}` : 'launched'}
                          </span>
                          <span className="truncate font-display text-sm font-bold text-ink">${m.b.symbol}</span>
                        </div>
                        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">{dateLabel(m.t, true)}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-num text-sm tabular-nums text-ink">${formatNav(m.b.navPerToken, 2)}</div>
                        {standing && (
                          <div className="font-num text-[11px] tabular-nums" style={{ color: standing.startsWith('-') ? 'var(--color-magenta)' : 'var(--color-teal)' }}>
                            {standing}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </>
          ) : (
          <div className="scrollbar-none mt-6 overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="The creator's launch timeline">
              <defs>
                <linearGradient id={`${gid}-a`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={accent} stopOpacity="0.22" />
                  <stop offset="1" stopColor={accent} stopOpacity="0" />
                </linearGradient>
                {/* the line's own light — a blurred twin beneath it, the cheap
                    honest glow (no filter on the crisp line itself) */}
                <filter id={`${gid}-glow`} x="-20%" y="-60%" width="140%" height="220%">
                  <feGaussianBlur stdDeviation="5" />
                </filter>
              </defs>

              {/* vertical hairline per node — the reading rail from value to
                  axis label, faint enough to be furniture */}
              {nodes.map((n, i) => (
                <line key={`rail-${i}`} x1={x(n.t)} x2={x(n.t)} y1={PAD_Y - 8} y2={H - PAD_B} stroke="rgba(255,255,255,0.05)" />
              ))}

              {/* the ~$1.00 launch baseline */}
              <line x1={PAD_X - 16} x2={W - PAD_X + 16} y1={y(1)} y2={y(1)} stroke="rgba(255,255,255,0.16)" strokeDasharray="4 5" />
              <text x={W - PAD_X + 20} y={y(1) + 3} fontSize="9" fill="rgba(255,255,255,0.4)" fontFamily="monospace">
                $1.00
              </text>

              {/* ── the stories: one path per chain that has ≥2 dated nodes —
                     each in its own signature color over its glow twin; a
                     lone launch stands as its node ── */}
              {(timelineMode
                ? chains.map((_, ci) => nodes.filter((n) => n.chainIdx === ci))
                : [nodes]
              )
                .filter((seg) => seg.length >= 2)
                .map((seg, si) => {
                  const segAccent = timelineMode ? chainAccent(seg[0].chainIdx) : accent
                  const d = smoothPath(seg.map((n) => ({ x: x(n.t), y: y(n.nav) })))
                  const area = `${d} L${x(seg[seg.length - 1].t).toFixed(1)},${H - PAD_B} L${x(seg[0].t).toFixed(1)},${H - PAD_B} Z`
                  return (
                    <g key={`seg-${si}`}>
                      <path d={area} fill={`url(#${gid}-a)`} />
                      <path d={d} fill="none" stroke={segAccent} strokeWidth="6" strokeLinecap="round" opacity="0.35" filter={`url(#${gid}-glow)`} />
                      <path d={d} fill="none" stroke={segAccent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </g>
                  )
                })}

              {/* nodes: value above (dodging a neighbor's), one label line
                  below — ticker + its perf as a colored tspan — on a row
                  chosen by crowding; the live ones glow */}
              {nodes.map((n, i) => {
                const nodeAccent = timelineMode ? chainAccent(n.chainIdx) : accent
                const labelY = H - PAD_B + 18 + (labelRow[i] % 3) * 13
                const valueY = y(n.nav) - 16 - (labelRow[i] % 3) * 13
                const canHover = (timelineMode ? chains[n.chainIdx]?.length > 1 : chainMode)
                return (
                  <g key={i}>
                    {n.cur && <circle cx={x(n.t)} cy={y(n.nav)} r="14" fill={nodeAccent} opacity="0.18" />}
                    {n.cur && <circle cx={x(n.t)} cy={y(n.nav)} r="9" fill="none" stroke={nodeAccent} strokeOpacity="0.45" />}
                    <circle
                      cx={x(n.t)}
                      cy={y(n.nav)}
                      r={n.cur ? 5 : 4}
                      fill={n.cur ? nodeAccent : '#0c0a14'}
                      stroke={n.cur ? nodeAccent : 'rgba(255,255,255,0.5)'}
                      strokeWidth="1.5"
                    />
                    <text x={x(n.t)} y={valueY} textAnchor="middle" fontSize="13" fontFamily="monospace" fontWeight="600" fill="#f5f4fa">
                      ${formatNav(n.nav, 2)}
                    </text>
                    <text x={x(n.t)} y={labelY} textAnchor="middle" fontSize="9" fontFamily="monospace" letterSpacing="0.08em" fill={n.cur ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.4)'}>
                      {n.axis.toUpperCase()}
                      {n.perf && (
                        <tspan fill={n.perf.startsWith('+') ? 'var(--color-teal)' : 'var(--color-magenta)'}>
                          {'  '}
                          {n.perf}
                        </tspan>
                      )}
                    </text>
                    {/* generous invisible hover target → the shared what-changed
                        card (multi-version chains only; a lone launch has no
                        diff to show) */}
                    {canHover && (
                      <circle
                        cx={x(n.t)}
                        cy={y(n.nav)}
                        r="20"
                        fill="transparent"
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={(e) => setHover({ chainIdx: n.chainIdx, vIdx: n.vIdx, rect: (e.currentTarget as SVGCircleElement).getBoundingClientRect() })}
                        onMouseLeave={() => setHover((p) => (p?.chainIdx === n.chainIdx && p?.vIdx === n.vIdx ? null : p))}
                      />
                    )}
                  </g>
                )
              })}
            </svg>
          </div>
          )}
          {hover && hoverChain && hoverChain.length > 1 && (
            <HoverPortal anchor={hover.rect} width={224}>
              <VersionHoverCard chain={hoverChain} index={hover.vIdx} />
            </HoverPortal>
          )}

          {/* THE TRACKING FACTS: best · weakest · spread — across their live
              baskets in timeline mode, across the chain's versions in
              fallback. Only when two can be priced (§9). */}
          {best && worst && best.address !== worst.address && (
            <div className="mt-6 grid grid-cols-3 gap-4 border-t border-white/8 pt-6">
              <div>
                <div className="font-num text-xl font-light leading-none tabular-nums text-teal sm:text-2xl">{perfLabel(best)}</div>
                <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
                  best · <span className="text-ink-dim">${showSymbol(best.symbol)}</span>
                </div>
              </div>
              <div>
                <div
                  className="font-num text-xl font-light leading-none tabular-nums sm:text-2xl"
                  style={{ color: perfToDate(worst) < 0 ? 'var(--color-magenta)' : 'var(--color-teal)' }}
                >
                  {perfLabel(worst)}
                </div>
                <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
                  weakest · <span className="text-ink-dim">${showSymbol(worst.symbol)}</span>
                </div>
              </div>
              <div>
                <div className="font-num text-xl font-light leading-none tabular-nums text-ink sm:text-2xl">
                  {Math.abs((perfToDate(best) - perfToDate(worst)) * 100).toFixed(1)}
                </div>
                <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">points of spread</div>
              </div>
            </div>
          )}

          {/* ONE line. The node semantics are load-bearing in timeline mode
              (launch-dated x, priced-today y); the undated count is said,
              never guessed onto the axis. */}
          <p className="mt-6 font-mono text-[9px] text-ink-faint">
            {timelineMode
              ? `Their launches and updates, in order; each moment shows where that basket stands today. Each version is a separate basket.${undated > 0 ? ` ${undated} launch${undated === 1 ? '' : 'es'} not dated by the index yet.` : ''} Not advice.`
              : chainMode
                ? 'Each version is a separate basket. Live value, not advice.'
                : 'Live value against the launch price. Not advice.'}
          </p>
        </div>
      </Bezel>
    </section>
  )
}
