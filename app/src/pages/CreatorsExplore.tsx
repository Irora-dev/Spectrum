import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import { useAllBaskets, useCreatorMeta } from '../lib/spectrum/hooks'
import { useHandleForAddress } from '../lib/spectrum/use-handles'
import { buildCreatorLeaderboard, perfMeasurable, perfToDate, type CreatorEntry } from '../lib/spectrum/leaderboard'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { formatUsdCompact } from '../lib/spectrum/format'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { chainCfg } from '../lib/chain/chains'
import { useInViewOnce } from '../lib/motion'
import { BasketCard } from '../components/BasketCard'
import { BasketAvatar } from '../components/BasketAvatar'
import { ChainLogo } from '../components/ChainBadge'

// ─────────────────────────────────────────────────────────────────────────────
// CREATORS — the discovery page ABOUT the people (owner 2026-08-21). Not the
// basket/bundle catalogue (that is /explore); this is one CREATOR per row —
// their identity, their thesis, their performance — with a horizontal carousel
// of their baskets beside it. Big, expansive, the white page plane and the
// main-title hero. Every row is real: buildCreatorLeaderboard groups the live
// factory index by deployer; identity + thesis resolve through the same signed
// creator-metadata path the profile page uses; the cards are the real
// BasketCard. Nothing here is invented.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

/** A creator's chosen name if they claimed one, else a short address. */
function creatorLabel(address: string, handle: string | null, name: string | null): string {
  const claimed = (name || handle || '').trim()
  if (claimed) return claimed
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function StatBlock({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="font-num text-xl font-bold tabular-nums sm:text-2xl" style={accent ? { color: 'var(--color-cyan)' } : { color: 'var(--color-ink)' }}>
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</div>
    </div>
  )
}

/** A creator's combined value created since start: Σ, across every current
 *  basket, of the value its NAV growth has added on top of deposits — measured
 *  from navPerToken (starts at 1). Only baskets past the dust floor count
 *  (perfMeasurable), so a $0.40 pool showing "+40,000%" never inflates it.
 *  value_added_i = aum_i · (nav_i − 1) / nav_i  (the growth portion of AUM). */
function valueCreated(entry: CreatorEntry): number {
  return entry.baskets.reduce((sum, b) => {
    if (!perfMeasurable(b) || b.navPerToken <= 0) return sum
    const added = (b.aumUsd || 0) * (perfToDate(b) / b.navPerToken)
    return sum + Math.max(0, added)
  }, 0)
}

/** The per-basket value % since launch (perfToDate = navPerToken − 1), shown as
 *  the BasketCard footer — but only where it is an honest claim (perfMeasurable;
 *  the card's own change line already shows 24h). */
function BasketValueFooter({ b }: { b: BasketSummary }) {
  if (!perfMeasurable(b)) return null
  const pct = perfToDate(b) * 100
  const up = pct >= 0
  return (
    <div className="flex items-center justify-between border-t border-black/5 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Value since launch</span>
      <span className="font-num text-[13px] font-bold tabular-nums" style={{ color: up ? 'var(--color-cyan)' : 'var(--color-magenta)' }}>
        {up ? '+' : ''}{pct.toFixed(1)}%
      </span>
    </div>
  )
}

/** The leaderboard rank chip — the top three take a metal tint. */
function RankChip({ rank }: { rank: number }) {
  const metal = rank === 1 ? '#E6B450' : rank === 2 ? '#AAB2BD' : rank === 3 ? '#C08457' : null
  return (
    <span
      className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border font-num text-lg font-bold tabular-nums sm:h-12 sm:w-12"
      style={metal ? { color: '#111', background: `${metal}22`, borderColor: `${metal}88` } : { color: 'var(--color-ink-dim)', borderColor: 'rgba(0,0,0,0.1)' }}
    >
      {rank}
    </span>
  )
}

/** The identity column: avatar, name, thesis (from the top basket's signed
 *  metadata), the numbers, a link to the full creator page. */
function CreatorIdentity({ entry, rank }: { entry: CreatorEntry; rank: number }) {
  // the top basket carries the identity + accent + thesis (the leaderboard's
  // own convention); its signed metadata is where the tagline/thesis live
  const top = entry.topBasket
  const { data: meta } = useCreatorMeta(top.address, top.chainId)
  const { lookup } = useHandleForAddress(entry.address)
  const claimedName = lookup.status === 'found' ? lookup.owner.display : null
  const label = creatorLabel(entry.address, meta?.handle ?? null, claimedName ?? meta?.name ?? null)
  const sig = basketSignatureColor(top.address, top.top[0])
  const thesisLine = (meta?.tagline || meta?.thesis || '').trim()
  const best = entry.best24hPct

  const created = valueCreated(entry)

  return (
    <div className="flex flex-col gap-4 lg:w-[320px] lg:shrink-0">
      <div className="flex items-center gap-3">
        <RankChip rank={rank} />
        <BasketAvatar address={entry.address} symbol={label} imageUrl={meta?.avatarUrl || undefined} size={52} />
        <div className="min-w-0">
          <Link to={`/creator/${entry.address}`} className="block truncate font-display text-xl font-bold leading-tight tracking-tight text-ink transition-colors hover:text-cyan sm:text-2xl">
            {label}
          </Link>
          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            <span>{entry.basketCount} basket{entry.basketCount === 1 ? '' : 's'}</span>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1">
              {entry.chains.map((c) => (
                <span key={c} title={chainCfg(c).name} className="grid place-items-center">
                  <ChainLogo chainId={c} size={13} />
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>

      {thesisLine ? (
        <p className="line-clamp-2 border-l-2 pl-3 text-[14px] leading-relaxed text-ink-dim" style={{ borderColor: sig }}>
          {thesisLine}
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-faint">A creator building on-chain baskets.</p>
      )}

      {/* VALUE CREATED is the leaderboard's headline number (owner 2026-08-21) —
          the growth their baskets have added since start, combined. */}
      <div className="mt-1 rounded-xl border border-cyan/25 bg-cyan/[0.05] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Value created since start</div>
        <div className="mt-0.5 font-num text-2xl font-bold tabular-nums text-cyan sm:text-3xl">{created > 0 ? formatUsdCompact(created) : '—'}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-black/5 pt-4">
        <StatBlock label="Managed" value={formatUsdCompact(entry.combinedTvl)} />
        <StatBlock label="Baskets" value={String(entry.basketCount)} />
        <StatBlock label="Best 24h" value={best == null ? '—' : `${best >= 0 ? '+' : ''}${best.toFixed(1)}%`} accent={best != null && best >= 0} />
      </div>

      <Link
        to={`/creator/${entry.address}`}
        className="press inline-flex w-fit items-center gap-2 rounded-full border border-black/10 px-4 py-1.5 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-ink transition-colors hover:border-cyan/50 hover:text-cyan"
      >
        View creator
        <span aria-hidden className="text-cyan">→</span>
      </Link>
    </div>
  )
}

/** The basket carousel: a horizontal snap-rail of the creator's real
 *  BasketCards, with edge arrows on wider screens. */
function BasketCarousel({ entry }: { entry: CreatorEntry }) {
  const railRef = useRef<HTMLDivElement>(null)
  const turn = (dir: 1 | -1) => {
    const el = railRef.current
    if (el) el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.85), behavior: 'smooth' })
  }
  const many = entry.baskets.length > 2
  return (
    <div className="relative min-w-0 flex-1">
      {many && (
        <div className="mb-3 hidden items-center justify-end gap-1.5 lg:flex">
          {([-1, 1] as const).map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => turn(dir)}
              aria-label={dir === -1 ? 'Previous baskets' : 'More baskets'}
              className="press grid h-9 w-9 place-items-center rounded-full border border-black/10 text-ink-dim hover:border-cyan/60 hover:text-cyan"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d={dir === -1 ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
              </svg>
            </button>
          ))}
        </div>
      )}
      <div
        ref={railRef}
        className="scrollbar-none -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain scroll-pl-4 px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:px-0 lg:scroll-pl-0"
      >
        {entry.baskets.map((b) => (
          <div key={`${b.chainId}:${b.address}`} className="w-[300px] shrink-0 snap-start sm:w-[320px]">
            <BasketCard ix={b} footer={<BasketValueFooter b={b} />} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The live row content — its hooks (useCreatorMeta) and its BasketCards (each
 *  a NAV-history query) only exist while this is MOUNTED, which the shell below
 *  defers until the row scrolls into view. That is the RPC lever (owner
 *  2026-08-21 "efficient in rpc usage"): off-screen creators cost nothing; the
 *  one shared useAllBaskets sweep already supplies every summary number. */
function CreatorRowLive({ entry, rank }: { entry: CreatorEntry; rank: number }) {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <CreatorIdentity entry={entry} rank={rank} />
      <BasketCarousel entry={entry} />
    </div>
  )
}

function CreatorRow({ entry, rank, me }: { entry: CreatorEntry; rank: number; me?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  // generous margin: mount just BEFORE the row reaches the viewport so its
  // reads are in flight by the time it is on screen, but never for rows far
  // below. Once seen, it stays mounted (useInViewOnce) — no thrash on scroll-up.
  const inView = useInViewOnce(ref, '0px 0px 25% 0px')
  return (
    <section id={`creator-${entry.address.toLowerCase()}`} ref={ref} className={`scroll-mt-24 ${inView ? 'enter' : ''}`} style={inView ? ({ '--enter-i': 0 } as CSSProperties) : undefined}>
      <div
        className={`rounded-[28px] bg-white p-5 shadow-[0_1px_0_0_rgba(0,0,0,0.03),0_20px_40px_-32px_rgba(0,0,0,0.16)] sm:p-6 lg:p-7 ${
          me ? 'border-2 border-cyan/50 ring-4 ring-cyan/10' : 'border border-black/[0.06]'
        }`}
      >
        {me && <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-cyan/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan"><span className="h-1.5 w-1.5 rounded-full bg-cyan" /> This is you</div>}
        {inView ? <CreatorRowLive entry={entry} rank={rank} /> : <div className="min-h-[280px]" aria-hidden />}
      </div>
    </section>
  )
}

type CreatorSort = 'created' | 'managed' | 'change'
const SORT_LABEL: Record<CreatorSort, string> = { created: 'Value created', managed: 'Value managed', change: 'Best 24h' }

export function CreatorsExplore() {
  const { data, isLoading, isError } = useAllBaskets()
  const { address: viewer } = useAccount()
  const [sort, setSort] = useState<CreatorSort>('created')
  const [limit, setLimit] = useState(12)

  const base = useMemo(() => buildCreatorLeaderboard(data ?? []), [data])
  // re-rank by the chosen key (pure, no reads): value created / managed / best
  // 24h. buildCreatorLeaderboard already orders by managed value, so 'managed'
  // keeps the base order; the others sort a copy.
  const creators = useMemo(() => {
    if (sort === 'managed') return base
    const key = sort === 'created' ? valueCreated : (c: CreatorEntry) => c.best24hPct ?? Number.NEGATIVE_INFINITY
    return [...base].sort((a, b) => key(b) - key(a))
  }, [base, sort])
  const shown = creators.slice(0, limit)

  const totalTvl = base.reduce((s, c) => s + c.combinedTvl, 0)
  const totalBaskets = base.reduce((s, c) => s + c.basketCount, 0)

  // the connected wallet's own placement in the CURRENT sort (if they're a
  // creator on the board) — powers the "you're #N" pill and the row highlight
  const myIndex = useMemo(() => {
    if (!viewer) return -1
    const v = viewer.toLowerCase()
    return creators.findIndex((c) => c.address.toLowerCase() === v)
  }, [creators, viewer])
  const jumpToMe = () => {
    if (myIndex < 0) return
    if (myIndex >= limit) setLimit(myIndex + 1) // reveal the row before scrolling to it
    const addr = creators[myIndex].address.toLowerCase()
    requestAnimationFrame(() => document.getElementById(`creator-${addr}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  return (
    // the WHITE PAGE PLANE (owner ask): this discovery surface reads on paper.
    // A full-bleed white ground behind the standard content column, so the rows
    // (white cards) sit on white with only their soft shadow separating them.
    <div className="relative left-1/2 w-screen -translate-x-1/2 bg-white text-ink [color-scheme:light]">
      {/* ── THE HERO — the main title, big, on white ─────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px]" style={{ background: 'radial-gradient(120% 70% at 50% 0%, color-mix(in srgb, var(--color-violet-bright) 10%, transparent), transparent 70%)' }} />
        <div className="relative mx-auto max-w-[1180px] px-4 pb-6 pt-16 text-center sm:px-6 sm:pt-24">
          <h1 className="mx-auto max-w-4xl font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl md:text-8xl">
            The people behind
            <br />
            the <span className="spectral-text">baskets</span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl text-lg leading-snug text-ink-dim sm:text-xl [text-wrap:balance]">
            Every basket is one person&rsquo;s thesis, made buyable. Meet the creators, read what they believe, and see how it has played out.
          </p>
          {!isLoading && !isError && creators.length > 0 && (
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
              <span className="font-num text-lg font-bold tabular-nums text-ink">{creators.length}<span className="ml-1.5 font-mono text-[11px] font-normal uppercase tracking-[0.16em] text-ink-faint">creators</span></span>
              <span className="font-num text-lg font-bold tabular-nums text-ink">{totalBaskets}<span className="ml-1.5 font-mono text-[11px] font-normal uppercase tracking-[0.16em] text-ink-faint">baskets</span></span>
              <span className="font-num text-lg font-bold tabular-nums text-ink">{formatUsdCompact(totalTvl)}<span className="ml-1.5 font-mono text-[11px] font-normal uppercase tracking-[0.16em] text-ink-faint">total value</span></span>
            </div>
          )}
          {/* YOU'RE #N (owner QoL 2026-08-21): a connected creator sees their own
              placement and can jump straight to their highlighted row. */}
          {myIndex >= 0 && (
            <button
              type="button"
              onClick={jumpToMe}
              className="press mt-8 inline-flex items-center gap-2 rounded-full border border-cyan/40 bg-cyan/[0.06] px-5 py-2 font-display text-sm font-bold uppercase tracking-[0.1em] text-ink transition-colors hover:border-cyan/70"
            >
              You&rsquo;re ranked <span className="text-cyan">#{myIndex + 1}</span> by {SORT_LABEL[sort].toLowerCase()}
              <span aria-hidden className="text-cyan">↓</span>
            </button>
          )}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to="/creators" className="press rounded-xl px-6 py-3 text-center font-display text-sm font-bold uppercase tracking-[0.1em] text-void" style={{ background: SPECTRAL }}>
              Become a creator
            </Link>
            <Link to="/explore" className="press rounded-xl border border-black/10 px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan">
              Explore all baskets →
            </Link>
          </div>
        </div>
      </section>

      {/* ── THE ROWS — one creator each ──────────────────────────────────────── */}
      <div className="mx-auto max-w-[1180px] px-4 pb-24 pt-6 sm:px-6">
        {isLoading && (
          <div className="space-y-6" aria-busy="true" aria-label="Loading creators">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-72 animate-pulse rounded-[28px] border border-black/[0.06] bg-black/[0.02]" />
            ))}
          </div>
        )}
        {isError && !isLoading && (
          <div className="rounded-[28px] border border-dashed border-black/10 p-16 text-center">
            <p className="font-mono text-sm text-ink-dim">Couldn&rsquo;t load creators right now.</p>
            <p className="mt-2 font-mono text-[11px] text-ink-faint">The public RPC may be rate-limiting. An origin-restricted key or read proxy makes it reliable.</p>
          </div>
        )}
        {!isLoading && !isError && creators.length === 0 && (
          <div className="rounded-[28px] border border-dashed border-black/10 p-16 text-center">
            <p className="font-mono text-sm text-ink-dim">No creators on this network yet.</p>
            <p className="mt-2 font-mono text-[11px] text-ink-faint">Be the first — every basket you launch puts you here, read straight from the factory.</p>
          </div>
        )}
        {!isLoading && !isError && creators.length > 0 && (
          <>
            {/* SORT CONTROL (owner QoL 2026-08-21): re-rank by value created,
                value managed, or best 24h — pure client-side, no extra reads. */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Ranked by</span>
              <div className="flex flex-wrap gap-1.5">
                {(['created', 'managed', 'change'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={sort === k}
                    onClick={() => { setSort(k); setLimit(12) }}
                    className={`press rounded-full border px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                      sort === k ? 'border-cyan/60 bg-cyan/[0.08] text-cyan' : 'border-black/10 text-ink-dim hover:border-black/25 hover:text-ink'
                    }`}
                  >
                    {SORT_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-6 sm:space-y-8">
              {shown.map((c, i) => (
                <CreatorRow key={c.address} entry={c} rank={i + 1} me={myIndex === i} />
              ))}
            </div>
            {limit < creators.length && (
              <div className="mt-10 flex justify-center">
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + 12)}
                  className="press rounded-xl border border-black/10 px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                >
                  Show more creators
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
