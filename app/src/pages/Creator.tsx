import { useEffect, useState, type ReactNode } from 'react'
import { useAccount } from 'wagmi'
import { CreatorJourney } from '../components/CreatorJourney'
import { CrownWinnings } from '../components/CrownWinnings'
import { CreatorSignup } from '../components/creator/CreatorSignup'
import { CreatorFeed } from '../components/creator/CreatorFeed'
import { BundleShelf } from '../components/BundleShelf'
import { useActiveChainId } from '../lib/chain/active-chain'
import { useFollowers as useFollowersOnchain } from '../lib/spectrum/notes-social'
import { Link, useParams } from 'react-router-dom'
import { ListingPipeline } from '../components/ListingPipeline'
import { ReferralCard } from '../components/ReferralCard'
import { useCreatorProfile, useCreatorMeta, useCreatorIdentity, type CreatorProfile } from '../lib/spectrum/hooks'
import type { VerifiedCreatorIdentity } from '../lib/spectrum/creator-identity'
import { BasketCard } from '../components/BasketCard'
import { BasketWash } from '../components/BasketWash'
import { VersionButton } from '../components/VersionButton'
import { BasketAvatar } from '../components/BasketAvatar'
import { AssetLogo } from '../components/AssetLogo'
import { FollowButton } from '../components/FollowButton'
import { CopyChip } from '../components/DocKit'
import { resolveCreator } from '../lib/spectrum/creator'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { chainCfg } from '../lib/chain/chains'
import { clientFor } from '../lib/chain/rpc'
import { parseAbi, type Address } from 'viem'
import { formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import leagueArt from '../assets/league-hero.jpg'
// the one hero the 1280w pass missed: every creator profile made phones decode
// a 3840px, ~1.05MB image (kit audit)
import leagueArt1280 from '../assets/league-hero.1280.jpg'

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
        className="mt-2 font-num text-2xl font-light leading-none tabular-nums text-ink sm:text-3xl"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] tracking-wide text-ink-faint">{sub}</div>}
    </div>
  )
}


// The creator stage (owner 2026-07-29: "way more stunning") — the league
// champions art runs full-bleed behind the profile card, edges masked to
// fully transparent so the site's animated bands ride over it (the league
// hero treatment), bottom composited into the page. The card floats on it.
function CreatorStage({ children }: { children: ReactNode }) {
  return (
    <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
      <img
        src={leagueArt}
        srcSet={`${leagueArt1280} 1280w, ${leagueArt} 3840w`}
        sizes="100vw"
        alt=""
        aria-hidden
        className="league-hero-in absolute inset-0 h-full w-full object-cover object-left-top"
        style={{
          WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 13%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 88%, transparent 100%)',
            WebkitMaskComposite: 'source-in',
            maskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 13%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 88%, transparent 100%)',
            maskComposite: 'intersect',
        }}
      />
      {/* full-stage height so the art breathes; the card rides the RIGHT
          half so the knights own the left (owner) */}
      <div className="relative z-10 mx-auto flex min-h-[64svh] w-full max-w-7xl items-center justify-end px-4 py-10 sm:px-8">
        <div className="w-full max-w-2xl">{children}</div>
      </div>
    </section>
  )
}

function Header({ profile, identityMeta }: { profile: CreatorProfile; identityMeta: VerifiedCreatorIdentity | null }) {
  const top = profile.baskets[0]
  // Identity precedence: the creator's SELF-signed profile (creator-identity.ts)
  // → the largest basket's deployer-signed blob → address attribution.
  const { data: meta } = useCreatorMeta(top?.address, top?.chainId)
  const identity = identityMeta
    ? resolveCreator({ handle: identityMeta.handle, name: identityMeta.name, deployer: profile.address })
    : meta
      ? resolveCreator({ handle: meta.handle, name: meta.name, deployer: profile.address })
      : profile.identity
  // Tie the page to the creator's largest basket via its signature colour.
  const accent = top ? basketSignatureColor(top.address, top.top[0]) : 'var(--color-violet)'
  const avatarSymbol = identity.kind === 'address' ? 'x' : identity.label.replace(/^@/, '')
  const avatarUrl = identityMeta?.avatarUrl ?? meta?.avatarUrl ?? undefined

  return (
    <header className="relative overflow-hidden rounded-3xl card-surface backdrop-blur-md">
      <div aria-hidden className="h-1 w-full" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />

      {/* a signed banner (self-published) washes the header; else the creator's
          top basket washes in faintly from the right (owner 12:34 layout) */}
      {identityMeta?.bannerUrl ? (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <img src={identityMeta.bannerUrl} alt="" className="h-full w-full object-cover opacity-25" />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(5,5,11,0.85) 0%, rgba(5,5,11,0.45) 55%, rgba(5,5,11,0.75) 100%)' }} />
        </div>
      ) : (
        top && <BasketWash ix={top} side="right" opacity={0.3} />
      )}

      <div className="relative p-8 sm:p-10">
        <BackLink />

        <div className="mt-5 flex flex-wrap items-center gap-5">
          <div className="relative shrink-0">
            <div
              aria-hidden
              className="absolute -inset-1.5 rounded-3xl opacity-60 blur-md"
              style={{ background: `linear-gradient(135deg, ${accent}, var(--color-cyan))` }}
            />
            <div className="relative overflow-hidden rounded-2xl ring-1 ring-white/20">
              <BasketAvatar address={profile.address} symbol={avatarSymbol} imageUrl={avatarUrl} size={96} />
            </div>
          </div>

          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">Creator</div>
            <h1 className="mt-1.5 break-words font-display text-4xl font-bold leading-[0.95] tracking-tight text-ink sm:text-6xl">
              {identity.label}
            </h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
              {/* the address chip stays the honest anchor identity; the signed
                  profile only ADDS display facts on top of it */}
              <CopyChip text={profile.address} label={shortAddr(profile.address)} />
              {identityMeta?.handle && identity.label !== identityMeta.handle && (
                // handle is shown, never linked — only signed launch posts link
                // out (owner call 2026-07-06, kept for the identity layer too)
                <span className="font-mono text-[11px] text-ink-faint">{identityMeta.handle}</span>
              )}
              {identityMeta && (
                <span className="inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
                  Signed profile
                </span>
              )}
              <FollowButton deployer={profile.address} />
              <OnchainFollowerCount creator={profile.address} />
            </div>
            {identityMeta?.bio && (
              <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-dim">{identityMeta.bio}</p>
            )}
          </div>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
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

        {/* their UNWITHDRAWN crown balance (not cumulative earnings — it zeroes
            on withdraw and this self-hides at 0), and
            the claim buttons when the viewer is them (owner 2026-07-30) */}
        <CrownWinnings creator={profile.address} className="mt-5" />
      </div>
    </header>
  )
}

// On-chain followers — wallets that signed a follow (kind "follow"). Distinct
// from the browser-local bookmark: this is public, portable social proof.
// Renders nothing until the chain has a registry or anyone has signed.
function OnchainFollowerCount({ creator }: { creator: string }) {
  const chainId = useActiveChainId()
  const { data } = useFollowersOnchain(chainId, creator)
  if (!data || data.list.length === 0) return null
  // "N+" when the log scan was range-capped or served stale — a partial count
  // must never pose as the total (audit). Chain-qualified: follows are
  // per-chain notes and this reads only the ACTIVE chain's registry.
  const n = data.list.length
  return (
    <span className="font-mono text-[11px] tabular-nums text-ink-faint">
      followed by <span className="text-ink-dim">{n.toLocaleString()}{data.partial ? '+' : ''}</span> wallet{n === 1 && !data.partial ? '' : 's'} on {chainCfg(chainId).name}
    </span>
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

// "Bullish on" — the tokens the creator signed into their profile. Symbols are
// resolved live from the chain (display-only); every row is just a fact card,
// no links out (the pick is the creator's word, not an endorsement rail).
const pickSymbolAbi = parseAbi(['function symbol() view returns (string)'])

function BullishOn({ identityMeta }: { identityMeta: VerifiedCreatorIdentity }) {
  const [symbols, setSymbols] = useState<Record<string, string>>({})
  const chainId = identityMeta.chainId

  useEffect(() => {
    let stale = false
    void Promise.all(
      identityMeta.picks.map((p) =>
        clientFor(chainId)
          .readContract({ address: p.address as Address, abi: pickSymbolAbi, functionName: 'symbol' })
          .then((s) => [p.address, typeof s === 'string' && s ? s.slice(0, 16) : shortAddr(p.address)] as const)
          .catch(() => [p.address, shortAddr(p.address)] as const),
      ),
    ).then((pairs) => {
      if (!stale) setSymbols(Object.fromEntries(pairs))
    })
    return () => {
      stale = true
    }
  }, [identityMeta, chainId])

  if (identityMeta.picks.length === 0) return null
  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between border-b border-white/10 pb-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-ink">Bullish on</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          signed by the creator
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {identityMeta.picks.map((p) => (
          <div key={p.address} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <AssetLogo address={p.address} symbol={symbols[p.address] ?? '?'} chainId={chainId} size={28} />
            <div className="min-w-0">
              <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                {symbols[p.address] ?? shortAddr(p.address)}
              </div>
              {p.note && <p className="mt-0.5 text-xs leading-relaxed text-ink-dim">{p.note}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// One basket's signed tagline/thesis line under its card — resolved via the
// SAME per-basket metadata cache the token page uses (no extra network when
// the visitor later opens the basket).
function BasketThesisLine({ basket, chainId }: { basket: string; chainId: number }) {
  const { data: meta } = useCreatorMeta(basket, chainId)
  const line = meta?.tagline ?? meta?.thesis ?? null
  if (!line) return null
  return <p className="line-clamp-2 px-1 text-xs leading-relaxed text-ink-dim">“{line}”</p>
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
  const activeChainId = useActiveChainId()
  const { data: profile, isLoading, isError } = useCreatorProfile(address)
  const { data: identityMeta } = useCreatorIdentity(address)
  const isMe = !!viewer && !!address && viewer.toLowerCase() === address.toLowerCase()
  // The declared delegate may compose too — their posts render "via delegate".
  const isDelegate =
    !!viewer && !!identityMeta?.delegate && viewer.toLowerCase() === identityMeta.delegate.toLowerCase()
  const [editing, setEditing] = useState(false)

  if (!address) return <Notice>No creator address provided.</Notice>
  if (isError) return <Notice>Couldn’t load this creator, the public RPC may be rate-limiting.</Notice>
  if (isLoading || !profile) return <CreatorSkeleton />

  // Editing happens ON the page (owner 2026-07-29): the connected owner opens
  // the same profile editor inline — no round-trip to /creators.
  const editLink = isMe && (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={`rounded-lg border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] press ${
            editing ? 'border-cyan/50 text-cyan' : 'border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan'
          }`}
        >
          {editing ? 'Close the editor' : identityMeta ? 'Edit your page' : 'Claim this page — add your profile'}
        </button>
      </div>
      {editing && <CreatorSignup />}
    </div>
  )

  if (profile.basketCount === 0) {
    return (
      <div className="space-y-8 pb-4">
        <CreatorStage>
          <Header profile={profile} identityMeta={identityMeta ?? null} />
        </CreatorStage>
        {editLink}
        {identityMeta && <BullishOn identityMeta={identityMeta} />}
        <Notice>No baskets deployed by this address yet.</Notice>
      </div>
    )
  }

  return (
    <div className="space-y-8 pb-4">
      <CreatorStage>
        <Header profile={profile} identityMeta={identityMeta ?? null} />
      </CreatorStage>
      {editLink}
      {isMe && <CreatorDashboard profile={profile} />}
      {/* on-chain updates feed (owner 2026-07-29) — composer for the owner
          or their declared delegate */}
      <CreatorFeed creator={profile.address as Address} chainId={activeChainId} canPost={isMe || isDelegate} delegate={identityMeta?.delegate ?? null} />
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
              {/* the creator's signed words about THIS basket, when published */}
              <BasketThesisLine basket={ix.address} chainId={ix.chainId} />
              <VersionButton basket={ix.address} deployer={ix.deployer} chainId={ix.chainId} className="w-full" />
            </div>
          ))}
        </div>
      </section>
      {/* their bundles — the packaged version of the baskets above (marketing).
          On your OWN page it's the manage view (owner 2026-07-29): with one
          basket it nudges the second launch, with more it invites the bundle —
          visitors still never see an empty section. */}
      <BundleShelf
        creator={profile.address}
        chainId={activeChainId}
        manage={isMe}
        basketCount={profile.basketCount}
      />
      {identityMeta && <BullishOn identityMeta={identityMeta} />}
    </div>
  )
}
