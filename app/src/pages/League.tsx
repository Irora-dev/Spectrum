import { lazy, Suspense, useEffect, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { useActiveChain } from '../lib/chain/active-chain'
import { settlementDecimalsFor } from '../lib/chain/deployments'
import { clientFor } from '../lib/chain/rpc'
import { buildStandings, CROWN_CLAIM_RULE, fetchLeagueSnapshot, fetchOwed, leaguePoolAbi, type LeagueSnapshot } from '../lib/spectrum/league'
import { useAllBaskets, useCreatorIdentity } from '../lib/spectrum/hooks'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { perfMeasurable, perfToDate } from '../lib/spectrum/leaderboard'
import { TRADING_ENABLED } from '../lib/config/features'
import { AssetLogo } from '../components/AssetLogo'
import { useEnsName } from 'wagmi'
import { BasketAvatar } from '../components/BasketAvatar'
import { PixelCrown } from '../components/PixelCrown'
import { InfoDot } from '../components/InfoDot'
import { formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import heroArt from '../assets/league-hero.jpg'
import heroArt1280 from '../assets/league-hero.1280.jpg'

// The hero's edge treatment, in ONE place: a horizontal taper (so the site's
// animated side bands ride above the art) intersected with a bottom fade. The
// still and the video trial must wear exactly the same mask or the swap is
// visible, so neither inlines it.
// The hero's edge treatment, in ONE place — shared by the art and every layer
// that rides it. HORIZONTAL ONLY: the art file already carries its own vignette,
// and the vertical alpha fade we used to add cut in halfway down the image,
// where the slope change read as a faint horizontal line (owner 2026-07-30).
// The side taper stays because the site's animated bands ride through it.
// The hero's edge treatment, in ONE place — shared by the art and every layer
// that rides it. Two parts, both deliberate:
//  · the SIDE taper, so the site's animated bands ride through the art's edges;
//  · a SHORT foot fade (88%→100%) — object-cover crops the art file's own baked
//    vignette away, so without it the art ends mid-tone and butts against the
//    void page as a hard ~20/255 line. Measured: this takes that step to 0.3.
// It deliberately does NOT fade from halfway down (it used to, from 72%): that
// stacked our vignette on top of the image's own and banded (owner 2026-07-30).
const HERO_MASK = {
  WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 13%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 88%, transparent 100%)',
  WebkitMaskComposite: 'source-in',
  maskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 13%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 88%, transparent 100%)',
  maskComposite: 'intersect',
} as const

// The "Learn how this works" walkthrough (R 2026-07-29): lazy — its slides pull
// the /creators marketing pieces, which should load only when someone asks.
const LearnWalkthrough = lazy(() =>
  import('../components/LearnWalkthrough').then((m) => ({ default: m.LearnWalkthrough })),
)

// ─────────────────────────────────────────────────────────────────────────────
// /league — the creator league. Renders the live race over the 30-day
// LeaguePool season: a slice of every basket's trading fee lands in the pool,
// and when the season closes each creator claims a √-weighted share (4× the
// fees is 2× the weight — the contract's own math, read back via
// weightOf/totalWeight, never re-derived here). Standings roster comes from
// the pool's Credited events; every NUMBER comes from contract state — no
// backend, no ranking authority, the chain is the scoreboard. The page exists
// only where a leaguePool is configured for the viewing chain.
// ─────────────────────────────────────────────────────────────────────────────

function seasonLabel(epochEndsAt: number): string {
  // 30-day epochs are not calendar months; the midpoint names the season the
  // window overwhelmingly sits in ("July 2026").
  return new Date((epochEndsAt - 15 * 86_400) * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/** Fees are denominated in the league chain's settlement token — decimals
 *  from the deployment book, never a local constant (cold-review INFO-1). */
function usd(raw: bigint, chainId: number): string {
  return formatUsdCompact(Number(raw) / 10 ** settlementDecimalsFor(chainId))
}

function Countdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, endsAt - now)
  const d = Math.floor(left / 86_400)
  const h = Math.floor((left % 86_400) / 3_600)
  const m = Math.floor((left % 3_600) / 60)
  return (
    <span className="font-num tabular-nums">
      {d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}
    </span>
  )
}

function pnlColor(p: number): string {
  return p >= 0 ? 'text-teal' : 'text-magenta'
}

function StandingRow({
  rank,
  leader,
  creator,
  credited,
  toBeat,
  isMe,
  baskets,
  devName,
  chainId,
}: {
  /** The league's own chain — names the settlement decimals its fees read in. */
  chainId: number
  rank: number
  /** The contract's `champion` — taking the stream right now. */
  leader: boolean
  creator: Address
  credited: bigint
  /** Extra score needed to take the crown (0 if they hold it / are ahead). */
  toBeat: bigint
  isMe: boolean
  /** The creator's current (head) baskets on this chain. */
  baskets: BasketSummary[]
  /** Dev-preview ENS stand-in (the fixture addresses have no real ENS). */
  devName?: string
}) {
  const { data: identity } = useCreatorIdentity(creator)
  // ENS from mainnet (the canonical registry) when no signed identity exists.
  const { data: ens } = useEnsName({ address: creator, chainId: 1, query: { enabled: !identity && !devName } })
  const label = identity?.name ?? identity?.handle ?? devName ?? ens ?? shortAddr(creator)

  // Best basket = highest since-launch performance among TVL-measurable heads
  // (perf claims below the floor are noise, not modesty — §9). Fall back to the
  // largest basket so the card still shows their flagship.
  const measurable = baskets.filter(perfMeasurable)
  const best = (measurable.length > 0 ? measurable : baskets)
    .slice()
    .sort((a, b) => (measurable.length > 0 ? perfToDate(b) - perfToDate(a) : b.aumUsd - a.aumUsd))[0]
  const bestPerf = best && perfMeasurable(best) ? perfToDate(best) * 100 : null
  const tvl = baskets.reduce((s, b) => s + (b.aumUsd || 0), 0)
  const holderVals = baskets.map((b) => b.holdersCount).filter((x): x is number => x != null)
  const holders = holderVals.length > 0 ? holderVals.reduce((s, x) => s + x, 0) : null
  // A mixed roster (some baskets missing holdersCount) is a PARTIAL sum — say
  // "N+" rather than presenting it as the total (honesty audit R3).
  const holdersPartial = holderVals.length > 0 && holderVals.length < baskets.length

  return (
    <Link
      to={`/creator/${creator}`}
      className={`group relative block overflow-hidden rounded-2xl border px-5 py-4 press ${
        isMe ? 'border-cyan/40 bg-cyan/[0.05]' : 'border-white/10 bg-white/[0.02] hover:border-white/25'
      }`}
    >
      {rank <= 3 && (
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-cyan/10 blur-3xl" />
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {/* rank + who */}
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {/* the crown replaces the "1" for whoever is leading (owner
              2026-07-30) — one winner takes the season, so the top slot reads
              as a title, not a row number */}
          <span className={`grid w-10 shrink-0 place-items-center text-center font-display text-2xl font-bold tabular-nums ${rank === 1 ? 'text-cyan' : rank <= 3 ? 'text-cyan/70' : 'text-ink-faint'}`}>
            {/* "holds the crown", not "leading": the crown persists across a
                season reset, so the wearer may not be top of the board (audit) */}
            {leader ? <PixelCrown size={20} title="Holds the crown" /> : rank}
          </span>
          <div className="relative shrink-0 overflow-hidden rounded-xl ring-1 ring-white/15">
            <BasketAvatar address={creator} symbol={label.replace(/^@/, '')} imageUrl={identity?.avatarUrl ?? undefined} size={44} />
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-base font-bold text-ink">
              {label}
              {isMe && <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan">you</span>}
            </div>
            <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              <span>{baskets.length} basket{baskets.length === 1 ? '' : 's'}</span>
              {tvl > 0 && <span className="tabular-nums text-ink-dim">{formatUsdCompact(tvl)} TVL</span>}
              {holders != null && <span className="tabular-nums">{holders.toLocaleString()}{holdersPartial ? '+' : ''} holders</span>}
            </div>
          </div>
        </div>

        {/* best basket: logos + symbol + since-launch PnL + 24h */}
        {best && (
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {best.top.slice(0, 4).map((t) => (
                <span key={t.address} className="rounded-full ring-2 ring-void">
                  <AssetLogo address={t.address} symbol={t.symbol} chainId={best.chainId} size={24} />
                </span>
              ))}
            </div>
            <div className="text-right">
              <div className="font-mono text-xs font-semibold text-ink">${showSymbol(best.symbol)}</div>
              <div className="mt-0.5 flex items-baseline justify-end gap-1.5">
                {bestPerf != null ? (
                  <span className={`font-num text-sm font-semibold tabular-nums ${pnlColor(bestPerf)}`}>
                    {bestPerf >= 0 ? '+' : ''}{bestPerf.toFixed(1)}%
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-ink-faint">below perf floor</span>
                )}
                <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">since launch</span>
                {best.change24hPct != null && (
                  <span className={`font-num text-[11px] tabular-nums ${pnlColor(best.change24hPct)}`}>
                    {best.change24hPct >= 0 ? '+' : ''}{best.change24hPct.toFixed(1)}% 24h
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* the league money — a RACE: the leader's cell carries the whole pot,
            everyone else is explicitly playing for it, not owed a share */}
        <div className="flex items-center gap-6 border-l border-white/10 pl-5">
          <div className="text-right">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">fees this season</div>
            <div className="font-num text-sm tabular-nums text-ink-dim">{usd(credited, chainId)}</div>
          </div>
          <div className="text-right">
            {/* the crown-holder is being paid NOW; everyone else gets the gap
                they must close — a real, actionable number instead of a payout
                projection that no longer exists */}
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
              {leader ? 'taking the stream' : 'to take the crown'}
            </div>
            <div className={`font-num text-base font-semibold tabular-nums ${leader ? 'text-teal' : 'text-ink-dim'}`}>
              {leader ? 'live' : toBeat > 0n ? `+${usd(toBeat, chainId)}` : 'next credit'}
            </div>
          </div>
        </div>
      </div>
    </Link>
  )
}

// DEV-only preview data (never in a production bundle path: guarded on
// import.meta.env.DEV AND the absence of a real pool) — lets the page be
// designed/reviewed on :5310 before any LeaguePool exists on a real chain.
// Demo-only ENS handles for the fixture creators (the mock addresses have no
// real ENS; live rows resolve mainnet ENS via useEnsName).
const DEV_ENS: Record<string, string> = {
  '0x000000000000000000000000000000000000c0e1': 'basedcore.eth',
  '0x000000000000000000000000000000000000c0e2': 'agentseason.eth',
  '0x000000000000000000000000000000000000d0e0': 'spectrumchef.eth',
  '0x000000000000000000000000000000000000c0e3': 'yieldrotator.eth',
  '0x000000000000000000000000000000000000c0e4': 'mememelange.eth',
}

// Dev fixture built through the REAL standings math (linear ranking, the
// contract's own rank table) so the preview can never drift from the live page.
const DEV_ROWS = (
  [
    ['0x000000000000000000000000000000000000c0e1', 5_120_000_000n],
    ['0x000000000000000000000000000000000000c0e2', 3_400_000_000n],
    ['0x000000000000000000000000000000000000d0e0', 2_111_000_000n],
    ['0x000000000000000000000000000000000000c0e3', 1_300_000_000n],
    ['0x000000000000000000000000000000000000c0e4', 500_000_000n],
  ] as [Address, bigint][]
).map(([creator, credited]) => ({ creator, credited }))
const DEV_CHAMPION = '0x000000000000000000000000000000000000c0e1' as Address
const DEV_SCORE_TO_BEAT = 5_120_000_000n
const DEV_SNAPSHOT: LeagueSnapshot = {
  season: 2953,
  scoresResetAt: Math.floor(Date.now() / 1000) + 3 * 86_400 + 7 * 3_600,
  champion: DEV_CHAMPION,
  scoreToBeat: DEV_SCORE_TO_BEAT,
  championOwed: 3_186_400_000n,
  totalOwed: 3_186_400_000n,
  total: 12_431_000_000n,
  rosterComplete: true,
  rosterFailed: false,
  standings: buildStandings(DEV_ROWS, DEV_CHAMPION, DEV_SCORE_TO_BEAT),
}

export function League() {
  const { chainId, cfg } = useActiveChain()
  const pool = cfg.leaguePool
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [claimBusy, setClaimBusy] = useState<number | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [learnOpen, setLearnOpen] = useState(false)

  const { data: snap, isLoading } = useQuery<LeagueSnapshot>({
    queryKey: ['spectrum', 'league', chainId],
    queryFn: () => fetchLeagueSnapshot(clientFor(chainId), pool as Address),
    enabled: !!pool,
    refetchInterval: 30_000,
  })
  // What the viewer can withdraw right now — already theirs, no season wait.
  const { data: myOwed } = useQuery({
    queryKey: ['spectrum', 'league-owed', chainId, address?.toLowerCase()],
    queryFn: () => fetchOwed(clientFor(chainId), pool as Address, address as Address),
    enabled: !!pool && !!address,
    refetchInterval: 30_000,
  })

  // every hook must run on EVERY render (audit 2026-07-29 #1): this page's
  // early return used to sit above useAllBaskets — a chain toggle to a
  // poolless chain then rendered fewer hooks and crashed the whole tree in
  // production (dev was masked by devPreview).
  const { data: allBaskets } = useAllBaskets()
  const devPreview = !pool && import.meta.env.DEV
  if (!pool && !devPreview) {
    return (
      <div className="py-10">
        <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
          The creator league is not live on {cfg.name} yet.
        </div>
      </div>
    )
  }

  // withdraw(), not claim(epoch): earnings are not per-season any more and there
  // is no window. Pull-only by design — see the seam's header on USDG freezes.
  async function withdraw() {
    // hard guard as well as the render gate — a tx path should never be one
    // JSX edit away from existing in an info-only build
    if (!TRADING_ENABLED || !publicClient || claimBusy !== null) return
    setClaimBusy(0)
    setClaimError(null)
    try {
      const h = await writeContractAsync({
        address: pool as Address,
        abi: leaguePoolAbi,
        functionName: 'withdraw',
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'league-owed', chainId] })
    } catch (e) {
      setClaimError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Withdraw failed.') : 'Withdraw failed.')
    } finally {
      setClaimBusy(null)
    }
  }

  const heads = (allBaskets ?? []).filter((b) => !b.supersededBy)
  const basketsOf = (creator: Address) =>
    heads.filter((b) => b.deployer && b.deployer.toLowerCase() === creator.toLowerCase())

  const live = devPreview ? DEV_SNAPSHOT : snap
  const myRow = address && live?.standings.find((s) => s.creator.toLowerCase() === address.toLowerCase())

  return (
    <div className="space-y-8 pb-4">
      {/* ── HERO: full-bleed champions art (owner 2026-07-29) — the image is
          left-weighted (the knights) with a black right half, so the title
          block lives on the right. Breakout = the /creators w-screen pattern;
          sits flush under the nav. The art is MASKED (owner note 2): every
          edge tapers into the page rather than ending as a hard rectangle.
          The spectral side-lights paint ABOVE the art (owner note 1), so the
          site's glow language sits on top of the image, not behind it. ── */}
      <section className="relative left-1/2 -mt-8 -mb-28 w-screen -translate-x-1/2 overflow-hidden pb-16">
        {/* The still, with a slow SHIMMER over it (owner 2026-07-29: the video
            trial is out, but the art should feel alive). The mask constant is
            shared by the art and every layer that rides it, so nothing shows a
            hard edge where the art tapers away. */}
        <img
          src={heroArt}
          srcSet={`${heroArt1280} 1280w, ${heroArt} 3840w`}
          sizes="100vw"
          alt=""
          aria-hidden
          className="league-hero-in absolute inset-0 h-full w-full object-cover object-left-top"
          style={HERO_MASK}
        />
        {/* ── the shimmer: two very slow, very quiet passes over the art ──
            (1) a wide spectral sheen that drifts across it, and (2) a faint
            breathing bloom. Both are pure CSS on top of the SAME mask, so they
            fade out exactly where the art does; both stop dead under
            prefers-reduced-motion (see index.css). GPU-composited transforms
            and opacity only — no repaint, no JS, no download. */}
        <div
          aria-hidden
          className="league-hero-sheen pointer-events-none absolute inset-0 mix-blend-screen"
          style={HERO_MASK}
        />
        <div
          aria-hidden
          className="league-hero-breathe pointer-events-none absolute inset-0"
          style={HERO_MASK}
        />


        {/* (the added bottom vignette is gone — the art file carries its own,
            and stacking ours on top was half of the banding, owner 2026-07-30) */}
        <div className="relative z-10 mx-auto flex min-h-[72svh] max-w-7xl items-center justify-end px-4 sm:px-8">
          <div className="relative max-w-xl py-16 text-right">
            {/* readability vignette LOCAL to the text (not a full-height scrim) */}
            <div aria-hidden className="absolute -inset-10 -z-10 rounded-[3rem]" style={{ background: 'radial-gradient(ellipse 90% 80% at 60% 50%, rgba(5,5,11,0.72) 30%, rgba(5,5,11,0.35) 62%, transparent 82%)' }} />
            {/* the chain's colours over the league (owner 2026-07-29): the
                Robinhood feather in their neon lime, only where the league
                actually runs on Robinhood Chain (+ dev preview) */}
            {(chainId === 4663 || devPreview) && (
              <div className="mb-2.5 flex items-center justify-end gap-2" style={{ color: '#c9f826' }}>
                <svg
                  viewBox="0 0 24 24"
                  className="h-6 w-6"
                  fill="currentColor"
                  style={{ filter: 'drop-shadow(0 0 7px rgba(201,248,38,0.85))' }}
                  aria-hidden
                >
                  <path d="M21 2.5c-7.6.4-12.4 2.6-14.6 6.6-1.3 2.4-1.7 5.2-1 8.5 2.3-3.7 6.3-7.8 9.8-10.8-3.4 3.7-7.2 8-9.3 11.3 3.7.8 6.8.1 9.2-2C19.3 13 20.6 8.4 21 2.5z" />
                  <path d="M6 17.4 3.9 21a.8.8 0 0 1-1.1.3.8.8 0 0 1-.3-1.1l2.1-3.6c.4.3.9.6 1.4.8z" />
                </svg>
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.3em]" style={{ textShadow: '0 0 14px rgba(201,248,38,0.6)' }}>
                  Robinhood Chain
                </span>
              </div>
            )}
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-dim">
              Season · {live ? seasonLabel(live.scoresResetAt) : '…'}
            </div>
            <h1 aria-label="Spectrum Creator League" className="mt-3 flex items-stretch justify-end gap-2.5 sm:gap-4">
              <span aria-hidden className="text-right font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl lg:text-8xl" style={{ textShadow: '0 0 26px rgba(255,255,255,0.14)' }}>
                Spectrum
                <br />
                Creator
                <br />
                {/* no blurred duplicate behind this word — a filtered copy of a
                    background-clip:text element is rasterised and clipped at its
                    own box, which drew a dark vertical edge over the art beside
                    the word (owner 2026-07-30, same cause as the home wordmark) */}
                <span className="spectral-text">League</span>
              </span>
            </h1>
            {/* two lines, no more (owner): the mechanism, then the credibility */}
            <p className="ml-auto mt-5 max-w-md text-sm leading-relaxed text-ink-dim sm:text-base">
              Every basket trade feeds the pool, and every league fee streams to whoever holds
              the crown right now.
            </p>
            {/* most visitors LAND here (R 2026-07-29) — the page teaches on ask */}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setLearnOpen(true)}
                className="press group inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-dim backdrop-blur transition-colors hover:border-cyan/50 hover:text-cyan"
              >
                <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full border border-current text-[9px] leading-none">?</span>
                Learn how this works
              </button>
            </div>
            <div className="mt-14 flex flex-wrap items-end justify-end gap-x-10 gap-y-4">
              <div>
                {/* NO POT ANY MORE (contract f71ef4b): the fees stream straight
                    to whoever holds the crown when each slice arrives, so the
                    honest headline is what a challenger must beat. */}
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                  Score to beat
                </div>
                <div className="mt-1 font-num text-5xl font-light tabular-nums text-teal sm:text-6xl">
                  {live ? usd(live.scoreToBeat, chainId) : '…'}
                </div>
                <div className="mt-1 font-mono text-[10px] tracking-[0.08em] text-ink-faint">
                  pass it and every league fee starts streaming to you instead
                </div>
              </div>
              <div className="pb-1">
                {/* "scores reset", NOT "closes"/"payout in": the crown persists
                    across the boundary and there is no settlement event. Calling
                    this a payout countdown would be actively misleading. */}
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">scores reset in</div>
                <div className="mt-1 font-num text-2xl text-ink">{live ? <Countdown endsAt={live.scoresResetAt} /> : '…'}</div>
                <div className="mt-1 font-mono text-[9px] tracking-[0.08em] text-ink-faint">the crown carries over</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {learnOpen && (
        <Suspense fallback={null}>
          <LearnWalkthrough
            poolUsd={live ? usd(live.scoreToBeat, chainId) : undefined}
            closeLabel="Back to the league"
            onClose={() => setLearnOpen(false)}
          />
        </Suspense>
      )}

      {/* your position + what is already yours */}
      {address && (myRow || (myOwed != null && myOwed > 0n)) && (
        <section className="relative z-20 rounded-3xl border border-cyan/25 bg-cyan/[0.03] p-6 backdrop-blur-sm">
          <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Your league</h2>
          {myRow && (
            <p className="mt-2 text-sm text-ink-dim">
              This season your baskets have generated{' '}
              <span className="font-num text-ink">{usd(myRow.credited, chainId)}</span> in fees, putting you{' '}
              <span className="font-num text-ink">#{myRow.rank + 1}</span>
              <InfoDot>
                Creators are ranked on the fees their baskets generate this season, counted straight (no curve).
                Whoever holds the crown receives every league fee the moment it arrives — it is a live stream, not
                a pot that pays out later. Scores reset every 30 days; the crown itself carries over.
              </InfoDot>
              {myRow.leader ? (
                <>
                  {' '}— <span className="font-semibold text-teal">you hold the crown</span>, so league fees are
                  streaming to you right now.
                </>
              ) : myRow.toBeat > 0n ? (
                <>
                  . Generate <span className="font-num text-ink">{usd(myRow.toBeat, chainId)}</span> more in fees to take the
                  crown, and the stream switches to you.
                </>
              ) : (
                <>. You are ahead on score; the crown passes on the next fee credited.</>
              )}
            </p>
          )}
          {myOwed != null && myOwed > 0n && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
              <span className="font-mono text-xs text-ink-dim">
                <span className="font-num font-semibold text-teal">{usd(myOwed, chainId)}</span> yours to withdraw
                <InfoDot>{CROWN_CLAIM_RULE}</InfoDot>
              </span>
              {/* TRADING_ENABLED-gated: this broadcasts a tx, and an info-only
                  build (wallet on, trading off) is a supported artifact — the
                  sibling CrownWinnings gated it and this didn't (kit audit) */}
              {TRADING_ENABLED && (
                <button
                  type="button"
                  disabled={claimBusy !== null}
                  onClick={() => void withdraw()}
                  className="rounded-lg bg-teal px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-black press hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
                >
                  {claimBusy !== null ? 'Confirming…' : 'Withdraw'}
                </button>
              )}
              {claimError && <p className="w-full font-mono text-[11px] text-magenta">{claimError}</p>}
            </div>
          )}
        </section>
      )}

      {/* standings */}
      <section className="relative z-20 space-y-3">
        <div className="flex items-end justify-between border-b border-white/10 pb-3">
          <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-ink sm:text-4xl">The race, <span className="spectral-text">live</span></h2>
          <span className="flex items-center font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            <PixelCrown size={13} title="" className="mr-1.5" />
            the crown takes every league fee, live
            <InfoDot>
              Every basket skims a league slice off each fee and cranks it to the pool, and whoever holds the crown
              at that moment is entitled to it immediately — it is a stream, not a pot, so there is no settlement
              day and nothing to claim at a deadline. Take the crown by generating more fees than the current holder
              this season, and the flow switches to you on the next credit. Scores reset every 30 days; the crown
              carries over, so there is always an incumbent.
            </InfoDot>
          </span>
        </div>
        {/* the roster caveat sits ABOVE the rows it qualifies — a reader of the
            top three must see it (honesty audit R2); and a connected creator
            whose row wasn't found gets told, not silence */}
        {live && !live.rosterComplete && !live.rosterFailed && (
          <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
            Roster from the recent log window (rate-limited RPC), some creators may be missing from the list.
            {address && !myRow ? ' That can include you — credited fees still count even while your row is unfound.' : ''}{' '}
            Every score shown is exact, read from the pool contract.
          </p>
        )}
        {isLoading && !devPreview ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />
            ))}
          </div>
        ) : live && live.standings.length > 0 ? (
          <div className="space-y-2">
            {live.standings.map((s, i) => (
              <StandingRow
                chainId={chainId}
                key={s.creator}
                rank={i + 1}
                leader={s.leader}
                creator={s.creator}
                credited={s.credited}
                toBeat={s.toBeat}
                isMe={!!address && s.creator.toLowerCase() === address.toLowerCase()}
                baskets={basketsOf(s.creator)}
                devName={devPreview ? DEV_ENS[s.creator.toLowerCase()] : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
            {live?.rosterFailed ? (
              <>
                Couldn&rsquo;t read this season&rsquo;s standings — the network&rsquo;s log service didn&rsquo;t
                answer. This is a read failure, not an empty race; it refreshes on its own.
              </>
            ) : live && live.total === 0n ? (
              <>
                No league fees have been credited this season yet.{' '}
                <Link to="/create" className="text-cyan hover:underline">Create a basket</Link> — baskets of
                this lineage skim a league slice off each fee and crank it here as they trade.
              </>
            ) : (
              <>
                No fees credited yet this season. The first basket trade opens the race,{' '}
                <Link to="/create" className="text-cyan hover:underline">launch yours</Link>.
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
