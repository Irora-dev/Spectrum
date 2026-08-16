import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { parseAbi, type Address } from 'viem'
import { Bezel, SPECTRAL } from '../home/Spine'
import { BasketAvatar } from '../BasketAvatar'
import { AssetLogo } from '../AssetLogo'
import { ChainBadge } from '../ChainBadge'
import { CopyAddress } from '../CopyAddress'
import { FollowButton } from '../FollowButton'
import { Carousel } from '../Carousel'
import { CrownWinnings } from '../CrownWinnings'
import { useActiveChainId } from '../../lib/chain/active-chain'
import { chainCfg } from '../../lib/chain/chains'
import { clientFor } from '../../lib/chain/rpc'
import { useFollowers as useFollowersOnchain } from '../../lib/spectrum/notes-social'
import { useCreatorMeta, type CreatorProfile } from '../../lib/spectrum/hooks'
import { resolveCreator } from '../../lib/spectrum/creator'
import { basketSignatureColor } from '../../lib/spectrum/signature'
import { formatUsdCompact, shortAddr } from '../../lib/spectrum/format'
import { useCopy } from '../../lib/use-copy'
import type { HandleOwner } from '../../lib/spectrum/creator-handles'
import type { VerifiedCreatorIdentity } from '../../lib/spectrum/creator-identity'
import { PortfolioChart } from '../PortfolioChart'
import type { PortfolioHistoryAsset } from '../../lib/spectrum/portfolio-history'
import leagueArt from '../../assets/league-hero.jpg'
import leagueArt1280 from '../../assets/league-hero.1280.jpg'

// ─────────────────────────────────────────────────────────────────────────────
// THE CREATOR HEAD (owner 2026-08-06, the creator-page rework: "this page needs
// to be way more logical and beautiful").
//
// WHO THEY ARE AND WHAT THEY BELIEVE, IN ONE BLOCK. The old page split the
// creator in half: the avatar, the handle and four counters at the top, and the
// convictions they had actually signed ("bullish on") dead last, below the
// baskets and the bundles. So it opened with inventory and buried the argument.
// The identity and the argument are now one composed plate: who, on the left;
// what they are bullish on, on the right; the facts that carry weight along the
// foot. A reader meets the person and their thesis in one screen.
//
// THE BANNER IS A BACKDROP, NOT A DESTINATION. It used to hold a 64svh floor and
// eat roughly 700px before a single fact — a thing you scroll past. Its height
// is now whatever the identity needs, so the art is behind the argument instead
// of in front of it. The creator's OWN signed banner takes the backdrop when
// they published one; the house league art stands in when they have not.
//
// It also aligns now: the stage's column is the app shell's 1000px, so the plate
// sits directly over the baskets below instead of floating off to one side.
// ─────────────────────────────────────────────────────────────────────────────

/** One weighty fact. `value` null = the fact is unmeasurable, so the cell is
 *  ABSENT — never a zero standing in for "we could not read it". */
interface CreatorFact {
  label: string
  value: string | null
  /** The precision the label cannot carry. Hidden on a phone, where three cells
   *  share 358px and the label alone has to do the work. */
  sub?: string
}

function FactCell({ fact }: { fact: CreatorFact }) {
  return (
    // flex-col justify-center: beside the tracked chart the cells stretch to
    // share its height (auto-rows-fr below), so a lone fact reads as a
    // full-height plate instead of a chip floating over dead air.
    <div className="relative flex flex-col justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4">
      {/* the house bezel edge: a spectral hairline along the top */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL, opacity: 0.55 }} />
      <div className="font-mono text-[10px] uppercase leading-tight tracking-[0.16em] text-ink-faint">{fact.label}</div>
      <div className="mt-3 font-num text-xl font-light leading-none tabular-nums text-ink sm:text-3xl">{fact.value}</div>
      {fact.sub && <div className="mt-2 hidden font-mono text-[10px] tracking-wide text-ink-faint sm:block">{fact.sub}</div>}
    </div>
  )
}

const COLS = ['', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3'] as const

/** The facts, or nothing at all. Written out per count so Tailwind can see the
 *  class: a strip of three cells where only one is measurable would otherwise
 *  leave two holes, which reads as missing data rather than absent data. */
function FactStrip({ facts, chart }: { facts: CreatorFact[]; chart?: ReactNode }) {
  const shown = facts.filter((f) => f.value !== null)
  if (shown.length === 0 && !chart) return null
  return (
    <div className="mt-8 border-t border-white/10 pt-6">
      {/* the facts LEFT, the chart that genuinely tracks them RIGHT (owner
          2026-08-06: "we should have charts on the right hand side of this
          data and let it genuinely track that data"). Below lg the cells keep
          their row and the chart follows — a chart beside a 90px cell on a
          phone is a postage stamp. */}
      <div className={chart ? 'grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-stretch' : ''}>
        <div className={`grid content-start gap-4 ${COLS[Math.min(shown.length, 3)]} ${chart ? 'lg:auto-rows-fr lg:grid-cols-1 lg:content-stretch' : ''}`}>
          {shown.map((f) => (
            <FactCell key={f.label} fact={f} />
          ))}
        </div>
        {chart}
      </div>
    </div>
  )
}

// "Bullish on" — the tokens the creator signed into their profile. Symbols are
// resolved live from the chain (display-only); every row is just a fact card,
// no links out (the pick is the creator's word, not an endorsement rail).
const pickSymbolAbi = parseAbi(['function symbol() view returns (string)'])

function Convictions({
  identityMeta,
  isMe,
  onEdit,
}: {
  identityMeta: VerifiedCreatorIdentity | null
  isMe: boolean
  onEdit?: () => void
}) {
  const [symbols, setSymbols] = useState<Record<string, string>>({})
  const chainId = identityMeta?.chainId
  const picks = useMemo(() => identityMeta?.picks ?? [], [identityMeta])

  useEffect(() => {
    if (chainId === undefined || picks.length === 0) return
    let stale = false
    void Promise.all(
      picks.map((p) =>
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
  }, [picks, chainId])

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 border-b border-white/10 pb-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-ink">Bullish on</h2>
        {picks.length > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">signed by them</span>
        )}
      </div>

      {picks.length === 0 ? (
        // Honest absence, and it says what would fill it. A blank column would
        // read as a page still loading; this reads as a creator who has not
        // said it yet.
        <div className="mt-4 rounded-2xl border border-dashed border-white/12 px-4 py-4">
          <p className="text-sm leading-relaxed text-ink-dim">
            {isMe
              ? 'You have not listed what you are bullish on. Sign your profile with the tokens you back and a line on each, and they show up here.'
              : 'Nothing listed yet. When this creator signs their profile they can name the tokens they back and say why in their own words.'}
          </p>
          {isMe && onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="press mt-4 inline-flex h-9 items-center rounded-full border border-cyan/45 bg-cyan/10 px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-cyan hover:border-cyan"
            >
              Add yours
            </button>
          )}
        </div>
      ) : (
        // A rail on a phone, a stacked list beside the identity from lg up
        // (Carousel: "anything that uses too much width we create a carousel").
        <Carousel
          label="Tokens this creator is bullish on"
          gridFrom="sm"
          gridClassName="sm:grid-cols-2 lg:grid-cols-1"
          peek="84%"
          className="mt-4"
        >
          {picks.map((p) => (
            <div
              key={p.address}
              className="flex h-full items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4"
            >
              <AssetLogo address={p.address} symbol={symbols[p.address] ?? '?'} chainId={chainId ?? 8453} size={28} />
              <div className="min-w-0">
                <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                  {symbols[p.address] ?? shortAddr(p.address)}
                </div>
                {p.note && <p className="mt-2 text-xs leading-relaxed text-ink-dim">{p.note}</p>}
              </div>
            </div>
          ))}
        </Carousel>
      )}
    </div>
  )
}

/** Wallets that signed a follow on the chain being viewed. Public, portable
 *  social proof — distinct from the browser-local bookmark the heart keeps. */
function useFollowerFact(creator: string): CreatorFact {
  const chainId = useActiveChainId()
  const { data } = useFollowersOnchain(chainId, creator)
  const n = data?.list.length ?? 0
  return {
    label: 'Followers',
    // "N+" when the log scan was range-capped or served stale: a partial count
    // must never pose as the total. Nobody following yet = absent, not zero.
    value: n > 0 ? `${n.toLocaleString()}${data?.partial ? '+' : ''}` : null,
    sub: `on ${chainCfg(chainId).name}`,
  }
}

export function CreatorHero({
  profile,
  identityMeta,
  isMe,
  onEdit,
  ownerBar,
  handle = null,
}: {
  profile: CreatorProfile
  identityMeta: VerifiedCreatorIdentity | null
  isMe: boolean
  /** Opens the inline profile editor — offered from the empty convictions state. */
  onEdit?: () => void
  /** The one owner-only control up here: a door to the studio, which holds the
   *  rest. Everything a visitor cannot use stays grouped down there. */
  ownerBar?: ReactNode
  /** The page's claimed URL name, when one exists — worn as a copyable chip in
   *  the control strip (it IS the shareable identity; ≤30 chars by claim law). */
  handle?: HandleOwner | null
}) {
  const { copied: nameCopied, copy: copyName } = useCopy()
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
  const bio = identityMeta?.bio ?? null

  // Holders across their baskets. Only the operator's indexer reports this, so
  // a chain-only install reports none — in which case the fact is ABSENT. When
  // some baskets report and others do not, the sum is marked partial rather
  // than passed off as the whole (the same rule the follower count follows).
  const reporting = profile.baskets.filter((b) => b.holdersCount != null)
  const holders = reporting.reduce((s, b) => s + (b.holdersCount ?? 0), 0)
  const followerFact = useFollowerFact(profile.address)

  const facts: CreatorFact[] = [
    {
      label: 'Total value',
      value: profile.totalAumUsd > 0 ? formatUsdCompact(profile.totalAumUsd) : null,
      sub: 'held in their baskets',
    },
    {
      label: 'Holders',
      value: holders > 0 ? `${holders.toLocaleString()}${reporting.length < profile.baskets.length ? '+' : ''}` : null,
      sub: 'across their baskets',
    },
    followerFact,
  ]

  // THE TRACKED VALUE (owner 2026-08-06: charts beside the facts that
  // "genuinely track that data"): the combined value's real history,
  // reconstructed the way every portfolio surface does it — each basket's
  // current composition (weight × today's AUM per constituent) priced back
  // through time by PortfolioChart. Genuine, with the chart's own coverage
  // honesty left ON. Holders get NO curve: no holder history exists anywhere
  // client-side, and a drawn one would be an invention — that chart arrives
  // with the operator DB's snapshot indexer.
  const historyAssets = useMemo<(PortfolioHistoryAsset & { symbol: string })[]>(
    () =>
      profile.baskets.flatMap((b) =>
        (b.top ?? [])
          .map((t) => ({
            chainId: b.chainId,
            address: t.address,
            valueUsd: (b.aumUsd || 0) * ((t.weightPct || 0) / 100),
            symbol: t.symbol,
          }))
          .filter((a) => a.valueUsd > 0),
      ),
    [profile.baskets],
  )
  const valueChart =
    historyAssets.length > 0 && profile.totalAumUsd > 0 ? (
      <div className="relative min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL, opacity: 0.55 }} />
        <div className="font-mono text-[10px] uppercase leading-tight tracking-[0.16em] text-ink-faint">
          Their baskets · tracked
        </div>
        <div className="mt-3">
          <PortfolioChart assets={historyAssets} totalUsd={profile.totalAumUsd} heightClass="h-40" />
        </div>
      </div>
    ) : undefined

  const banner = identityMeta?.bannerUrl ?? null

  return (
    <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
      {/* THE BACKDROP. Edges masked to fully transparent so the site's animated
          light bands ride over it, bottom composited into the page. */}
      {banner ? (
        <img src={banner} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover opacity-60" style={{ WebkitMaskImage: MASK, WebkitMaskComposite: 'source-in', maskImage: MASK, maskComposite: 'intersect' }} />
      ) : (
        <img
          src={leagueArt}
          srcSet={`${leagueArt1280} 1280w, ${leagueArt} 3840w`}
          sizes="100vw"
          alt=""
          aria-hidden
          /* Centred on the art's own subject, not its top-left corner: the
             stage is now a band rather than a 64svh wall, and left-top cropped
             it to empty sky. */
          className="league-hero-in absolute inset-0 h-full w-full object-cover object-[38%_45%]"
          style={{ WebkitMaskImage: MASK, WebkitMaskComposite: 'source-in', maskImage: MASK, maskComposite: 'intersect' }}
        />
      )}
      <span aria-hidden className="absolute inset-0 bg-void/25" />

      {/* The app shell's own 1000px column and gutters, so the plate lines up
          with the baskets under it instead of floating in the right half.
          The foot is deliberately shorter than the head: the page's own
          between-region rhythm picks up right underneath, and the two used to
          add to ~112px of nothing between the identity and the evidence. */}
      <div className="relative z-10 mx-auto w-full max-w-[1000px] px-4 pb-8 pt-10 sm:px-6 sm:pt-14">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link
            to="/"
            className="press inline-flex h-9 items-center gap-2 rounded-full border border-white/12 bg-black/30 px-4 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim backdrop-blur hover:border-white/30 hover:text-ink"
          >
            ← All baskets
          </Link>
          {ownerBar}
        </div>

        <Bezel className="mt-6" glow={accent} panel="bg-void/85 backdrop-blur-xl">
          {/* 16px of plate padding on a phone is deliberate: it is exactly the
              Carousel's own bleed, so the conviction rail runs to the plate's
              edge instead of stopping in a channel. */}
          <div className="p-4 sm:p-8">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-12">
              {/* ── who they are ─────────────────────────────────────────── */}
              <div className="min-w-0">
                <div className="flex items-center gap-4">
                  <div className="relative shrink-0">
                    <div
                      aria-hidden
                      className="absolute -inset-1 rounded-3xl opacity-60 blur-md"
                      style={{ background: `linear-gradient(135deg, ${accent}, var(--color-cyan))` }}
                    />
                    <div className="relative overflow-hidden rounded-2xl ring-1 ring-white/20">
                      <BasketAvatar address={profile.address} symbol={avatarSymbol} imageUrl={avatarUrl} size={80} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">Creator</div>
                    {/* FLUID, because a handle is arbitrary text next to a fixed
                        avatar in a half-width column: at a fixed 48px
                        "@basedresearch" ran out of line and broke MID-WORD,
                        which is worse than any size. The clamp keeps it whole
                        down to 390px; `break-words` stays as the last resort for
                        a handle no size could fit. */}
                    <h1
                      className="mt-2 break-words font-display font-bold leading-[0.95] tracking-tight text-ink"
                      style={{ fontSize: 'clamp(1.5rem, 0.9rem + 3.2vw, 2.5rem)' }}
                    >
                      {identity.label}
                    </h1>
                  </div>
                </div>

                {/* One 36px row: every chip is a tap target on a phone, and they
                    all stand the same height so the row reads as one control
                    strip rather than a pile of odd sizes. */}
                <div className="mt-6 flex flex-wrap items-center gap-2">
                  {/* The h-9 on a shared chip is deliberate and local: these are
                      the page's own controls and a 24px pill is not a thumb
                      target. Nothing about the chips' chrome changes anywhere
                      else. */}
                  {/* the claimed name FIRST — it outranks the address as the
                      thing a visitor takes away; one tap copies the full URL */}
                  {handle ? (
                    <button
                      type="button"
                      onClick={() => void copyName(`${window.location.origin}/creator/${handle.display}`)}
                      title={`Copy ${window.location.host}/creator/${handle.display}`}
                      aria-label="Copy this creator page link"
                      className={`press inline-flex h-9 items-center rounded-full border px-3 font-mono text-[11px] tracking-[0.04em] ${
                        nameCopied
                          ? 'border-cyan/60 bg-cyan/10 text-cyan'
                          : 'border-cyan/35 bg-cyan/[0.06] text-ink hover:border-cyan/70'
                      }`}
                    >
                      <span className="text-ink-faint">/creator/</span>
                      <span className="font-semibold">{handle.display}</span>
                      <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                        {nameCopied ? 'copied ✓' : 'copy'}
                      </span>
                    </button>
                  ) : null}
                  {/* FOLLOW TAKES THE COPY-LINK'S PLACE (the owner 2026-08-09:
                      "remove the copy page link and put the follow button in
                      its place"). Copying a page link is what the browser's own
                      share and URL bar already do; following is the one action
                      here that does something this app cannot do for you — and
                      it was last in the row, after the chain badges, which is
                      the least likely place for the row's only real verb. */}
                  <FollowButton deployer={profile.address} className="h-9 px-3" />
                  <CopyAddress
                    address={profile.address}
                    what="creator address"
                    className="[&>button]:h-9 [&>button]:px-3 [&>button]:text-[11px]"
                  />
                  {identityMeta && (
                    <span className="inline-flex h-9 items-center rounded-full border border-teal/40 bg-teal/10 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
                      Signed profile
                    </span>
                  )}
                  {profile.chains.map((c) => (
                    <ChainBadge key={c} chainId={c} size="md" className="h-9 px-3" />
                  ))}
                </div>

                {bio ? (
                  <p className="mt-6 max-w-[62ch] text-[15px] leading-relaxed text-ink-dim">{bio}</p>
                ) : (
                  <p className="mt-6 max-w-[62ch] text-sm leading-relaxed text-ink-faint">
                    {isMe
                      ? 'You have not published a profile yet. Sign one to add your name, a short bio and the tokens you back, on every Spectrum site at once.'
                      : 'No profile published yet. Until then this page is what the address itself proves: the baskets it published, and how they have gone.'}
                  </p>
                )}
              </div>

              {/* ── what they believe ────────────────────────────────────── */}
              <div className="min-w-0 lg:border-l lg:border-white/10 lg:pl-12">
                <Convictions identityMeta={identityMeta} isMe={isMe} onEdit={onEdit} />
              </div>
            </div>

            {/* ── and the facts that carry weight ──────────────────────────
                Value, holders and followers — never a count of the inventory
                that is listed in full two sections down. */}
            <FactStrip facts={facts} chart={valueChart} />
          </div>
        </Bezel>

        {/* Their UNWITHDRAWN crown balance (not cumulative earnings — it zeroes
            on withdraw and self-hides at 0), and the claim button when the
            viewer is them. */}
        <CrownWinnings creator={profile.address} className="mt-4" />
      </div>
    </section>
  )
}

// Sides fade to transparent for the light bands, foot dissolves into the page.
const MASK =
  'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 13%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 78%, transparent 100%)'
