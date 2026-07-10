import type { ReactNode } from 'react'
import { useAccount } from 'wagmi'
import { CreatorJourney } from '../components/CreatorJourney'
import { Link, useParams } from 'react-router-dom'
import { ListingPipeline } from '../components/ListingPipeline'
import { ReferralCard } from '../components/ReferralCard'
import { useCreatorProfile, useCreatorMeta, type CreatorProfile } from '../lib/spectrum/hooks'
import { BasketCard } from '../components/BasketCard'
import { BasketWash } from '../components/BasketWash'
import { VersionButton } from '../components/VersionButton'
import { BasketAvatar } from '../components/BasketAvatar'
import { FollowButton } from '../components/FollowButton'
import { CopyChip } from '../components/DocKit'
import { resolveCreator } from '../lib/spectrum/creator'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { chainCfg } from '../lib/chain/chains'
import { formatUsdCompact, shortAddr } from '../lib/spectrum/format'

// Creator profile: every basket a given deployer has launched, with headline
// stats. Identity is the on-chain deployer address (the honest fact) until
// creator-published metadata exists. Data comes from the cached basket list
// (see useCreatorProfile) — opening a profile costs no extra network.

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="py-10">
      <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
        {children}
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint press hover:border-white/25 hover:text-ink"
    >
      ← All baskets
    </Link>
  )
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: ReactNode
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">{label}</div>
      <div
        className="mt-1.5 font-num text-xl font-light leading-none tabular-nums text-ink sm:text-2xl"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] tracking-wide text-ink-faint">{sub}</div>}
    </div>
  )
}

function Header({ profile }: { profile: CreatorProfile }) {
  const top = profile.baskets[0]
  // Verified creator metadata is read from the creator's largest basket's signed
  // blob (no platform per-creator store); else address attribution.
  const { data: meta } = useCreatorMeta(top?.address, top?.chainId)
  const identity = meta
    ? resolveCreator({ handle: meta.handle, name: meta.name, deployer: profile.address })
    : profile.identity
  // Tie the page to the creator's largest basket via its signature colour.
  const accent = top ? basketSignatureColor(top.address, top.top[0]) : 'var(--color-violet)'
  const avatarSymbol = identity.kind === 'address' ? 'x' : identity.label.replace(/^@/, '')

  return (
    <header className="relative overflow-hidden rounded-3xl card-surface backdrop-blur-md">
      <div aria-hidden className="h-1 w-full" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />

      {/* the giant banner/color band above the profile is GONE (owner 12:34) —
          the profile sits at the top; the creator's top basket washes in
          faintly from the right instead */}
      {top && <BasketWash ix={top} side="right" opacity={0.3} />}

      <div className="relative p-6 sm:p-8">
        <BackLink />

        <div className="mt-5 flex flex-wrap items-center gap-5">
          <div className="relative shrink-0">
            <div
              aria-hidden
              className="absolute -inset-1.5 rounded-3xl opacity-60 blur-md"
              style={{ background: `linear-gradient(135deg, ${accent}, var(--color-cyan))` }}
            />
            <div className="relative overflow-hidden rounded-2xl ring-1 ring-white/20">
              <BasketAvatar address={profile.address} symbol={avatarSymbol} imageUrl={meta?.avatarUrl ?? undefined} size={64} />
            </div>
          </div>

          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">Creator</div>
            <h1 className="mt-1 break-words font-display text-3xl font-bold leading-[0.95] tracking-tight text-ink sm:text-4xl">
              {identity.label}
            </h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
              {/* the Signed-identity badge is gone (R+C 18:26: "we don't have a
                  signed identity") — the address chip is the honest identity */}
              <CopyChip text={profile.address} label={shortAddr(profile.address)} />
              {/* account X link deliberately absent — only signed launch posts
                  link out, beside each basket's thesis (owner call 2026-07-06) */}
              <FollowButton deployer={profile.address} />
            </div>
          </div>
        </div>

        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Baskets"
            value={profile.basketCount}
            sub={
              profile.totalVersions > profile.basketCount
                ? `+${profile.totalVersions - profile.basketCount} superseded`
                : undefined
            }
          />
          <StatTile
            label="Series"
            value={profile.seriesCount}
            sub={profile.seriesCount > 0 ? 'maintained' : 'none yet'}
          />
          <StatTile label="Combined value" value={formatUsdCompact(profile.totalAumUsd)} />
          <StatTile label="Chains" value={profile.chains.map((c) => chainCfg(c).name).join(' · ') || '—'} />
        </div>
      </div>
    </header>
  )
}

// Owner-only dashboard (owner 2026-07-07): shown when the connected wallet IS
// this creator. Houses cumulative fees + the per-basket listing pipeline, so a
// creator manages discoverability for everything they've launched in one place.
function CreatorDashboard({ profile }: { profile: CreatorProfile }) {
  return (
    <section className="rounded-3xl border border-cyan/25 bg-cyan/[0.03] p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">Your creator dashboard</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">only you see this</span>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">
        Your fees and everything you need to get each basket discovered — tracker submissions, the
        token-list feed, and the assets to paste into them.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <StatTile label="Baskets" value={profile.basketCount} />
        <StatTile label="Combined TVL" value={formatUsdCompact(profile.totalAumUsd)} />
      </div>

      <ReferralCard className="mt-5" />

      <div className="mt-6">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">List &amp; promote</h3>
        <div className="mt-3 space-y-2">
          {profile.baskets.map((ix) => (
            <details key={`${ix.chainId}:${ix.address}`} className="group rounded-2xl border border-white/10 bg-black/20">
              <summary className="press flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">${ix.symbol}</span>
                  <span className="truncate font-mono text-[11px] text-ink-faint">{ix.name}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors group-open:text-cyan">
                  Get listed ▾
                </span>
              </summary>
              <div className="border-t border-white/10 p-4">
                {/* basket tokens are 18-decimal ERC-20s from the factory */}
                <ListingPipeline addr={ix.address} symbol={ix.symbol} name={ix.name} decimals={18} chainId={ix.chainId} />
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

function CreatorSkeleton() {
  return (
    <div className="space-y-8 py-4">
      <div className="h-56 animate-pulse rounded-3xl border border-white/5 bg-white/[0.02]" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-72 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
        ))}
      </div>
    </div>
  )
}

export function Creator() {
  const { address } = useParams()
  const { address: viewer } = useAccount()
  const { data: profile, isLoading, isError } = useCreatorProfile(address)
  const isMe = !!viewer && !!address && viewer.toLowerCase() === address.toLowerCase()

  if (!address) return <Notice>No creator address provided.</Notice>
  if (isError) return <Notice>Couldn’t load this creator, the public RPC may be rate-limiting.</Notice>
  if (isLoading || !profile) return <CreatorSkeleton />

  if (profile.basketCount === 0) {
    return (
      <div className="space-y-8 py-4">
        <Header profile={profile} />
        <Notice>No baskets deployed by this address yet.</Notice>
      </div>
    )
  }

  return (
    <div className="space-y-8 py-4">
      <Header profile={profile} />
      {isMe && <CreatorDashboard profile={profile} />}
      {/* the whole-journey line — creator page only (owner call 2026-07-06) */}
      <CreatorJourney deployer={profile.address} />
      <section className="space-y-4">
        <div className="flex items-end justify-between border-b border-white/10 pb-3">
          <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-ink">Baskets</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            {profile.basketCount} total
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {profile.baskets.map((ix) => (
            <div key={`${ix.chainId}:${ix.address}`} className="space-y-2">
              <BasketCard ix={ix} />
              <VersionButton basket={ix.address} deployer={ix.deployer} chainId={ix.chainId} className="w-full" />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
