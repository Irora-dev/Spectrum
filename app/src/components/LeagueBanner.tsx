import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useActiveChain } from '../lib/chain/active-chain'
import { clientFor } from '../lib/chain/rpc'
import { fetchLeagueSnapshot } from '../lib/spectrum/league'
import { formatUsdCompact } from '../lib/spectrum/format'
import heroArt from '../assets/league-hero.jpg'
import heroArt1280 from '../assets/league-hero.1280.jpg'

// ─────────────────────────────────────────────────────────────────────────────
// Homepage league advert (owner 2026-07-29): the champions art on the left,
// the pitch + the live score to beat + Join now on the right. Exists only where the
// viewing chain has a LeaguePool (or in DEV, where the league page previews).
// Shares the league page's query key — one snapshot feeds both surfaces.
// ─────────────────────────────────────────────────────────────────────────────

export function LeagueBanner() {
  const { chainId, cfg } = useActiveChain()
  const pool = cfg.leaguePool
  const devPreview = !pool && import.meta.env.DEV
  const { data: snap } = useQuery({
    queryKey: ['spectrum', 'league', chainId],
    queryFn: () => fetchLeagueSnapshot(clientFor(chainId), pool as Address),
    enabled: !!pool,
    // No standing poll on an ADVERT (RPC audit 2026-08-06, the crown-fix
    // class): a parked anonymous homepage tab re-read the score to beat every
    // 60s — 2 posts/min on the app's front door, for a passive viewer. The
    // staleTime keeps a refocus honest; /league itself stays LIVE (its own
    // 30s poll on this same key — a watcher there feeds this banner too).
    staleTime: 60_000,
  })
  if (!pool && !devPreview) return null
  // There is no pot any more (contract f71ef4b) — the headline is the SCORE TO
  // BEAT, i.e. what a challenger must exceed to start taking the flow.
  const beatRaw = devPreview ? 5_120_000_000n : (snap?.scoreToBeat ?? null)
  const beat = beatRaw != null ? formatUsdCompact(Number(beatRaw) / 1e6) : null

  return (
    <Link
      to="/league"
      className="group relative isolate block overflow-hidden rounded-3xl border border-white/12 bg-panel press hover:border-white/25"
    >
      {/* the art rides the left half, fading into the panel. Below the fold on
          Home — lazy, phones take the 1280w variant (this img alone was a
          1.05MB eager fetch; systems audit) */}
      <img
        src={heroArt}
        srcSet={`${heroArt1280} 1280w, ${heroArt} 3840w`}
        sizes="72vw"
        loading="lazy"
        decoding="async"
        alt=""
        aria-hidden
        className="absolute inset-y-0 left-0 h-full w-[72%] object-cover object-left-top"
        style={{
          WebkitMaskImage: 'linear-gradient(90deg, black 0%, black 55%, transparent 100%)',
          maskImage: 'linear-gradient(90deg, black 0%, black 55%, transparent 100%)',
        }}
      />
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-violet/14 blur-[100px]" />

      <div className="relative flex min-h-[200px] flex-col items-end justify-center gap-3.5 px-6 py-6 text-right sm:px-10">
        <div className="font-display text-3xl font-bold uppercase leading-[0.92] tracking-tight text-ink sm:text-5xl">
          Spectrum <span className="spectral-text">Creator League</span>
        </div>
        <div className="flex items-center gap-6">
          {beat && (
            <div className="text-right">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">score to beat</div>
              <div className="font-num text-2xl font-semibold tabular-nums text-teal">{beat}</div>
            </div>
          )}
          <span className="rounded-lg bg-cyan px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-black transition-transform group-hover:scale-[1.03]">
            Join now →
          </span>
        </div>
      </div>
    </Link>
  )
}
