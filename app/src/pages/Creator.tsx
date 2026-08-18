import { useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { showName, showSymbol } from '../lib/spectrum/safe-copy'
import { useAccount } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type SeedPlan } from '../components/reshape/seed-plan'
import { CreatorSignup } from '../components/creator/CreatorSignup'
import { CreatorFeed } from '../components/creator/CreatorFeed'
import { CreatorHero } from '../components/creator/CreatorHero'
import { BundleShelf } from '../components/BundleShelf'
import { BundleForge } from '../components/BundleForge'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'
import { useActiveChainId } from '../lib/chain/active-chain'
import { Link, useParams } from 'react-router'
import { ListingPipeline } from '../components/ListingPipeline'
import { ReferralCard } from '../components/ReferralCard'
import { PortfolioClaims } from '../components/PortfolioClaims'
import { ThesisEditor } from '../components/ThesisEditor'
import { useCreatorProfile, useCreatorMeta, useCreatorIdentity, type CreatorProfile } from '../lib/spectrum/hooks'
import { BasketCard } from '../components/BasketCard'
import { ChainBadge } from '../components/ChainBadge'
import { heldPosition } from '../lib/spectrum/held-baskets'
import { useHeldBaskets } from '../lib/spectrum/use-held-baskets'
import { Bezel, Eyebrow } from '../components/home/Spine'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { useQueries } from '@tanstack/react-query'
import { ensureLaunchIndex, type BasketSummary } from '../lib/spectrum/basket-data'
import { launchTimeLookup } from '../lib/spectrum/basket-sort'
import { groupIntoTheses, type Thesis } from '../lib/spectrum/thesis'
import { thesisHref } from '../lib/spectrum/thesis-url'
import { isDemoLegAddress } from '../lib/spectrum/thesis-run-types'
import { ThesisDoorCard } from '../components/ThesisCard'
import { ReshapeThesisModal } from '../components/reshape/ReshapeThesisModal'
import { JoinBundlePicker } from '../components/reshape/JoinBundlePicker'
import { DEPLOY_ENABLED } from '../lib/config/features'
import { basketHref } from '../lib/spectrum/short-url'
import { VersionButton } from '../components/VersionButton'
import { usePrefersReducedMotion } from '../lib/motion'
import { ClaimHandle } from '../components/creator/ClaimHandle'
import { useHandleForAddress } from '../lib/spectrum/use-handles'
import { flowHref } from '../lib/spectrum/flow-link'
import { readPortfolioDraft } from '../lib/spectrum/portfolio-handoff'
import { ResumeLaunchCard } from '../components/launch/ResumeLaunchCard'
import type { Address } from 'viem'
import { unseededBasketsOf } from '../lib/spectrum/unseeded-baskets'
import { SeedBundleDoor } from '../components/reshape/SeedBundleDoor'

// ─────────────────────────────────────────────────────────────────────────────
// THE CREATOR PAGE — one creator, their baskets and their thesis.
//
// REBUILT 2026-08-06 (owner: "I want to beautify the creator overall page…
// this page needs to be way more logical and beautiful").
//
// THE ORDER IS THE ARGUMENT. It used to run: banner, four counters, the owner's
// dashboard, the updates feed, a version chart, the baskets, the bundles, and
// only then the creator's own convictions — dead last, under everything. The
// page opened with inventory and buried the point of visiting it.
//
// It now reads the way a person meets a creator:
//   1. WHO THEY ARE AND WHAT THEY BELIEVE — identity and convictions in one
//      composed plate over their banner (components/creator/CreatorHero).
//   2. WHAT THEY MADE — the baskets. The signed words say it ONCE, in the
//      showcase plate (the owner 2026-08-12 — the grid used to restate each
//      basket's thesis under its card); every card below is face-only
//      evidence, sitting directly under the claim it supports. Their
//      bundles follow.
//   3. HOW IT HAS GONE — the version journey and the updates feed. Depth, not
//      headline, so they sit under the evidence.
//   4. THE STUDIO — everything only the creator can use, in ONE place instead
//      of interleaved through a visitor's page.
//
// Nothing was dropped in the move: the feed, the journey, the version buttons,
// the bundles, the follow control and the owner dashboard all still exist, and
// the follower count and the superseded-version count were promoted out of
// generic tiles into the places they actually mean something.
// ─────────────────────────────────────────────────────────────────────────────

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/12 px-6 py-10 text-center text-sm leading-relaxed text-ink-dim">
      {children}
    </div>
  )
}

/** The grouper's own name fold (thesis.ts `nameKey`, the Token picker's
 *  exclusion) — membership and exclusion must key exactly the way grouping
 *  does, or a case variant would offer a join to nowhere. */
const foldName = (s: string | null | undefined) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

// (BundleLegRow + BundleLegSet retired 2026-08-16, the owner's third correction on
// this page: "no 'inside X · one per network' leg wall" — the chain badges the
// bundle card already wears carry the one-per-network fact, and a leg's own
// page keeps its full console. The per-leg held marks and version pills went
// with the wall, on the same ruling.)

/** THEIR CROSS-CHAIN IDEAS (the owner 2026-08-09) — one create session that picked
 *  assets on several chains ships several baskets, and this page has always
 *  listed those siblings as strangers. Each chip is the door to that idea's own
 *  page, where it reads as the one product it was meant to be.
 *
 *  Multi-chain groups only (the grouper's default; the page groups once and
 *  hands the list in): a single-chain basket is already fully described by its
 *  own card below, and a "bundle" door to one basket would be a second name
 *  for the same thing. Absent entirely when they have none, so no visitor
 *  meets a heading standing over an empty row.
 *
 *  MINUS THE SHOWCASED ONE (QoL 2026-08-12): theses[0] — the biggest, the
 *  grouper's own order — leads the showcase plate directly below this strip,
 *  so the mount hands the strip the REST. A one-bundle creator therefore has
 *  no strip at all (the zero-check below — never an empty band): their bundle
 *  reads once, full size, from the plate instead of twice in a row.
 *
 *  THE CREATOR'S CORNER (the owner 2026-08-10: "a way for them to edit the entire
 *  thing using the reshape system"): a quiet Edit pill rides each card's top
 *  right — the bundle reshape popup's door, the Thesis page's own "Edit
 *  bundle" made per-card. Gate is that page's exact rule: the creator on a
 *  deploy-capable build, or a demo bundle, which shows its entry to everyone
 *  so the scripted walkthrough stays reachable. The shared ThesisDoorCard is
 *  untouched — the overlay is this call site's, wrapped around it.
 *
 *  THE ACTIONS RIDE EACH CARD'S FOOT (the owner 2026-08-16, superseding both the
 *  2026-08-13 leg rows and the floating Edit pill): the public card, then one
 *  visible row of creator buttons under it — the standalone card's own footer
 *  grammar. No leg wall, no toggle.
 *
 *  THE SMALL STRIP DIED THE SAME DAY (the owner, live, on the compact cards that
 *  sat ABOVE the showcase plate: "if we have this nicer looking section …
 *  i want the info all there not above") — every remaining bundle now renders
 *  BELOW the plate in the showcase's own md face (chart, composite bento,
 *  combined price, TVL), two per row, the standalone grid's exact rail
 *  grammar. One section, one card language. */
function TheirTheses({
  theses,
  isMe,
  onEdit,
  unseededKeys,
}: {
  theses: Thesis[]
  isMe: boolean
  onEdit: (t: Thesis) => void
  unseededKeys: Set<string>
}) {
  if (theses.length === 0) return null
  return (
    // the standalone grid's rail: a snap slideshow on phones, a two-up grid
    // from lg — an md card per screen keeps each bundle whole on a phone.
    <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:grid lg:snap-none lg:grid-cols-2 lg:items-start lg:gap-x-12 lg:gap-y-14 lg:overflow-visible lg:px-0 lg:pb-0">
      {theses.map((t) => {
        const editable = (DEPLOY_ENABLED && isMe) || t.legs.some((l) => isDemoLegAddress(l.address))
        return (
          <div
            key={t.name}
            className="min-w-0 shrink-0 basis-[86%] snap-start sm:basis-[62%] lg:basis-auto lg:shrink"
          >
            <ThesisDoorCard thesis={t} size="md" />
            {/* the creator's buttons, docked under the public face — the
                card-footer grammar (the owner 2026-08-16); the old floating Edit
                pill lives in this row now */}
            {editable && (
              <div className="mt-2 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                <ProductActions
                  legs={t.legs}
                  isMe={isMe}
                  onEditBundle={() => onEdit(t)}
                  unseededKeys={unseededKeys}
                />
              </div>
            )}
          </div>
        )
      })}
      {/* the quiet door to the NEXT bundle, riding the row the bundles live on
          (creator-only; gated on the composer's own page key so it is never a
          dead door). No machinery — /createbasket is the compose flow. */}
      {isMe && pageEnabled(brand.pages, 'launch') && (
        <Link
          /* the MAIN create flow, not the composer and never the legacy
             /create (owner 2026-08-16 ×2: "takes you to composer not the
             create page" · "we should never use the old create flow") */
          to={flowHref('publish') ?? '/createbasket'}
          title="Pick assets on several networks to compose a bundle"
          className="press flex min-w-0 shrink-0 basis-[86%] snap-start flex-col justify-center rounded-2xl border border-dashed border-white/12 p-6 transition-colors hover:border-violet/60 sm:basis-[62%] lg:basis-auto lg:shrink"
        >
          <span className="font-display text-base font-bold text-ink">+ New bundle</span>
          <span className="mt-2 max-w-[26ch] font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-ink-faint">
            pick assets on several networks to compose a bundle
          </span>
        </Link>
      )}
    </div>
  )
}

/** "ADD TO A BUNDLE" ON A SINGLE BASKET (the owner 2026-08-10: "the ability to
 *  link one basket to a bundle") — the join door, riding the cell's action
 *  cluster in VersionButton's own pill grammar (violet, because the bundle
 *  surfaces are violet). It opens the shared JoinBundlePicker → the reshape
 *  popup in join mode; the picked name is the whole join.
 *
 *  Shows only when the join is real, so visitors and dead ends see NOTHING:
 *  the viewer is the creator on a deploy-capable build (or the basket is a
 *  demo subject — demo entries show to everyone so the walkthrough stays
 *  reachable, the Thesis page's exact gate) · the basket is not already a
 *  bundle leg (the grouper's fold — sharing the name IS membership) · and at
 *  least one multi-chain bundle exists to join. */
function AddToBundle({
  ix,
  isMe,
  bundles,
  onJoin,
  className = '',
}: {
  ix: BasketSummary
  isMe: boolean
  bundles: Thesis[]
  onJoin: (b: BasketSummary) => void
  className?: string
}) {
  if (!((DEPLOY_ENABLED && isMe) || isDemoLegAddress(ix.address))) return null
  const mine = foldName(ix.name)
  // already inside a bundle (or its same-chain shadow) — this door is for the
  // baskets still standing alone
  if (bundles.some((t) => foldName(t.name) === mine)) return null
  // the Token picker's exact exclusion: a bundle whose name this basket
  // already shares would be a join to nowhere
  const joinable = bundles.filter((t) => foldName(t.name) !== mine)
  if (joinable.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => onJoin(ix)}
      title="Ship a version of this basket under one of your bundles' names — the name is what joins it"
      className={`press inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-violet/60 hover:text-violet-bright ${className}`}
    >
      + Add to a bundle
    </button>
  )
}

/** The showcase's signed words (owner 2026-08-06: "thesis next to each
 *  basket"; narrowed 2026-08-12, the owner: "the thesis shows for each basket no
 *  need to have the text of read the thesis dropdown etc." — the grid cards
 *  below carry no prose any more, and the read-more expander died with them).
 *  The tagline as the display line, the thesis body clamped to five lines,
 *  resolved via the SAME per-basket metadata cache the token page uses. The
 *  door underneath IS the read-more: the whole thesis lives on the subject's
 *  own page. One component for the bundle plate and the flagship plate, so
 *  the two showcase mounts cannot drift. */
function BasketProse({
  basket,
  chainId,
  mine = false,
  href,
  door = 'basket',
  assetCount,
  launchedAt,
}: {
  basket: string
  chainId: number
  mine?: boolean
  /** The subject's own page — the prose column's quiet door, and the way to
   *  the words past the clamp. */
  href?: string
  /** What the door opens: a basket (cyan, the default) or a bundle (violet —
   *  bundle surfaces are violet, never the baskets' cyan). */
  door?: 'basket' | 'bundle'
  assetCount?: number
  /** Launch unix SECONDS from the launch index; null/absent = not indexed. */
  launchedAt?: number | null
}) {
  const { data: meta } = useCreatorMeta(basket, chainId)
  const tagline = meta?.tagline || null
  const thesis = meta?.thesis || null
  // The provenance line: what the words CAN'T say about themselves — when it
  // launched (the index's fact, not shown on the card) and how many assets
  // carry it. Facts only; absent facts leave no gap.
  const metaBits = [
    launchedAt != null
      ? `launched ${new Date(launchedAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : null,
    assetCount ? `${assetCount} asset${assetCount === 1 ? '' : 's'} inside` : null,
  ].filter(Boolean)
  return (
    <div>
      {tagline || thesis ? (
        <>
          {tagline && (
            <p className="font-display text-2xl font-semibold leading-snug text-ink [text-wrap:balance] sm:text-3xl">
              {tagline}
            </p>
          )}
          {thesis && (
            <p className={`${tagline ? 'mt-4' : ''} line-clamp-5 max-w-[62ch] text-[15px] leading-relaxed text-ink-dim`}>
              {thesis}
            </p>
          )}
        </>
      ) : (
        <p className="font-mono text-[11px] uppercase leading-relaxed tracking-[0.14em] text-ink-faint">
          No thesis published for this one yet
          {/* the owner's gap is one anchor from its fix: the studio's Theses
              block is where capture lives. Visitors keep the plain fact. */}
          {mine && (
            <>
              {' — '}
              <a href="#creator-studio" className="text-cyan/80 underline decoration-cyan/30 underline-offset-2 transition-colors hover:text-cyan">
                write it in your studio
              </a>
            </>
          )}
        </p>
      )}

      {metaBits.length > 0 && (
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {metaBits.join(' · ')}
        </p>
      )}
      {href &&
        (door === 'bundle' ? (
          // THE BIG DOOR (the owner 2026-08-13, two rulings same morning: the
          // per-leg buys come off and the plate carries one big button; then,
          // live, "Buy bundle should say Visit Bundle") — the bundle plate's
          // door at CTA size, the console's exact recipe (ThesisConsole's cta
          // button), navigating to the bundle page where the one-flow buy
          // console lives. The buy stays THERE, behind its own guards; this
          // door only walks the reader to it.
          <Link
            to={href}
            className="spectral-btn press mt-6 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
          >
            Visit bundle →
          </Link>
        ) : (
          <Link
            to={href}
            className="press mt-6 inline-block rounded-lg border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
          >
            View basket →
          </Link>
        ))}
    </div>
  )
}

// (BasketThesisLine retired 2026-08-06; the grid's per-basket prose followed
// 2026-08-12 — BasketProse above speaks once, from the showcase plate.)

/** One basket's thesis, editable in place — the studio is the designated home
 *  for thesis capture (owner 1120, relayed by specallocator desk 202: "have the
 *  thesis stuff done once you've seeded; there's a creator page setup where
 *  everything would be done for the thesis side" — the publish review's
 *  textarea was removed on the same call). The editor is the Token page's own
 *  ThesisEditor, mounted verbatim: same one-tx SpectrumNotes write, same
 *  deployer gate, so the two surfaces cannot drift. Own component because each
 *  row reads its own meta (hooks cannot live in a loop). */
// StudioThesis retired: its job (one basket, its thesis) is now a leg inside
// ProductRow, which cannot render the same basket twice.

/**
 * THE PRODUCT'S ACTION FOOTER (the owner 2026-08-16, his third and final correction
 * on this page: ONE list, and the creator actions as VISIBLE BUTTONS in the
 * card footer — the standalone card's own grammar, where $TESTV3 already shows
 * `Buy →` `↻ New version` `+ Add to a bundle` directly under its public bento.
 * The collapsed "creator tools +" disclosure strip and the studio's second
 * "Your work" list are both gone: he does not want a toggle, he wants the
 * buttons on the card, and every product listed exactly once).
 *
 * One row of pills under the public face. Seed (only while legs wait for their
 * first buy) · thesis · new version / edit bundle · add to a bundle · get
 * listed. Seed, thesis and get-listed summon their REAL tool right below the
 * row — the same SeedBundleDoor / ThesisEditor / ListingPipeline the studio
 * walls used to mount, so nothing was dropped in the merge; the buttons are
 * always visible, only each tool's body appears on press (the AddToBundle
 * grammar: a labelled button opening its machinery).
 *
 * Mount rule: call sites gate the mount on `(DEPLOY_ENABLED && isMe) || demo`
 * so a visitor never meets an empty footer strip; inside, every button keeps
 * its own gate (VersionButton's deployer self-gate, AddToBundle's demo door).
 */
const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

function ProductActions({
  legs,
  isMe,
  bundles,
  onJoin,
  onEditBundle,
  unseededKeys,
}: {
  /** One entry for a standalone basket, every leg for a bundle. */
  legs: BasketSummary[]
  isMe: boolean
  /** Standalone mounts only — the join door's targets. */
  bundles?: Thesis[]
  onJoin?: (b: BasketSummary) => void
  /** Bundle mounts only — opens the whole-bundle reshape. */
  onEditBundle?: () => void
  unseededKeys: Set<string>
}) {
  const [open, setOpen] = useState<'seed' | 'thesis' | 'listed' | null>(null)
  // the seed run overlay standing over the popup — while it is up, the
  // popup's backdrop must not close underneath it (SeedBundleDoor's own
  // onOverlayChange contract, the ceremony rule)
  const [runUp, setRunUp] = useState(false)
  const { address: viewer } = useAccount()
  const qc = useQueryClient()
  const lead = legs[0]
  const { data: meta } = useCreatorMeta(lead.address, lead.chainId)
  const owner = DEPLOY_ENABLED && isMe
  const isBundle = legs.length > 1
  const unseeded = useMemo(
    () => legs.filter((l) => unseededKeys.has(`${l.chainId}:${l.address.toLowerCase()}`)),
    [legs, unseededKeys],
  )
  const hasThesis = !!(meta?.thesis ?? '').trim()
  const pill =
    'press pointer-events-auto inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors'
  const quiet = `${pill} border-white/12 text-ink-dim hover:border-cyan/50 hover:text-cyan`
  const toggled = (on: boolean) => (on ? `${pill} border-cyan/50 bg-cyan/10 text-cyan` : quiet)
  const plan: SeedPlan = {
    legs: unseeded.map((b) => ({ chainId: b.chainId, address: b.address as `0x${string}`, symbol: b.symbol, share: 1 })),
    excluded: [],
  }
  const flip = (k: 'seed' | 'thesis' | 'listed') => setOpen((v) => (v === k ? null : k))
  return (
    <div className="pointer-events-auto">
      <div className="flex flex-wrap items-center gap-2">
        {/* the seed pill wears amber because it is the one action money waits
            on — the old status chip's colour, now ON the button that fixes it */}
        {owner && viewer && unseeded.length > 0 && (
          <button
            type="button"
            onClick={() => flip('seed')}
            className={`${pill} ${
              open === 'seed'
                ? 'border-amber-300/70 bg-amber-400/15 text-amber-100'
                : 'border-amber-300/40 bg-amber-400/[0.06] text-amber-200/90 hover:border-amber-300/70 hover:text-amber-100'
            }`}
          >
            Seed it
          </button>
        )}
        {owner && (
          <button type="button" onClick={() => flip('thesis')} className={toggled(open === 'thesis')}>
            {hasThesis ? 'Edit thesis' : 'Write thesis'}
          </button>
        )}
        {isBundle ? (
          onEditBundle && (
            <button
              type="button"
              onClick={onEditBundle}
              title="Reweight or edit this bundle — ships a new version holders can swap into"
              className={quiet}
            >
              ↻ Edit bundle
            </button>
          )
        ) : (
          <>
            {/* the RECIPE rides (owner 2026-08-16: "new version … needs to
                have the proper main create flow but setup for allowing you to
                reweight/remove/add assets, we should never use the old create
                flow") — with holdings in hand VersionButton takes the flow
                path, seeding the draft from this composition */}
            <VersionButton
              basket={lead.address}
              deployer={lead.deployer}
              chainId={lead.chainId}
              holdings={(lead.top ?? []).map((t) => ({ chainId: lead.chainId, address: t.address, symbol: t.symbol, weightPct: t.weightPct }))}
              className="pointer-events-auto"
            />
            {onJoin && <AddToBundle ix={lead} isMe={isMe} bundles={bundles ?? []} onJoin={onJoin} className="pointer-events-auto" />}
          </>
        )}
        {owner && (
          <button type="button" onClick={() => flip('listed')} className={toggled(open === 'listed')}>
            Get listed
          </button>
        )}
      </div>
      {/* THE TOOLS OPEN AS A POPUP, never inline (owner 2026-08-16: "write
          thesis needs to show a proper thesis card that doesnt clip over
          everything, maybe best done as a pop up") — BasketCard's shell is
          overflow-hidden with a hover translate, so ANY tall expansion inside
          its footer clips; a body portal escapes both. Backdrop and ✕ close
          it, except while the seed's own run overlay stands above. */}
      {open != null &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto p-4"
            role="dialog"
            aria-modal="true"
            aria-label={open === 'seed' ? `Seed $${showSymbol(lead.symbol)}` : open === 'thesis' ? 'Why this mix' : 'Get listed'}
            onClick={() => {
              if (!runUp) setOpen(null)
            }}
          >
            <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" aria-hidden />
            <div
              className="relative w-full max-w-lg rounded-2xl border border-white/12 bg-panel p-5 shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                  {open === 'seed' ? `Seed $${showSymbol(lead.symbol)}` : open === 'thesis' ? 'Why this mix' : 'Get listed'}
                </span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setOpen(null)}
                  className="press grid h-8 w-8 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-white/30 hover:text-ink"
                >
                  ✕
                </button>
              </div>
              {open === 'seed' && viewer && (
                <SeedBundleDoor
                  plan={plan}
                  name={lead.symbol}
                  deployer={viewer}
                  accent="var(--color-cyan)"
                  gradient={SPECTRAL}
                  textClass="text-void"
                  /* the run overlay's close re-reads the chain — a landed seed
                     flips supply>0, the row leaves the unseeded set and the
                     Seed pill genuinely unmounts (owner 2026-08-16 asked
                     exactly this; before, it waited on query staleness) */
                  onOverlayChange={(overlayOpen) => {
                    setRunUp(overlayOpen)
                    if (!overlayOpen) void qc.invalidateQueries({ queryKey: ['unseeded-baskets', viewer] })
                  }}
                />
              )}
              {open === 'thesis' && (
                <div className="mt-4">
                  {/* inline + start-open: this popup exists to edit, and the
                      corner-pin variant overlapped its own text here */}
                  <ThesisEditor basket={lead.address} chainId={lead.chainId} deployer={lead.deployer ?? null} meta={meta} variant="inline" startOpen />
                </div>
              )}
              {open === 'listed' && (
                <div className="mt-4 space-y-3">
                  {legs.map((l) => (
                    <div key={`${l.chainId}:${l.address}`}>
                      {isBundle && (
                        <div className="mb-2 flex items-center gap-2">
                          <ChainBadge chainId={l.chainId} size="sm" />
                          <span className="truncate font-mono text-[11px] text-ink-dim">{showName(l.name)}</span>
                        </div>
                      )}
                      <ListingPipeline addr={l.address} symbol={l.symbol} name={l.name} decimals={18} chainId={l.chainId} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

/** The standing draft + the next-basket door — the studio's resume points. */
function StudioRow() {
  const { address } = useAccount()
  const publishFlow = flowHref('publish')
  const draft = useMemo(() => readPortfolioDraft(address), [address])
  const targets = draft?.targets ?? []
  if (!publishFlow) return null
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {targets.length > 0 ? (
        <Link
          to={publishFlow}
          className="press group rounded-2xl border border-white/12 bg-black/25 p-4 transition-colors hover:border-cyan/50"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">standing draft</div>
          <div className="mt-2 font-display text-base font-bold text-ink group-hover:text-cyan">
            Resume your mix: {targets.length} asset{targets.length === 1 ? '' : 's'}
          </div>
          <div className="mt-2 truncate font-mono text-[11px] text-ink-dim">
            {targets
              .slice(0, 4)
              .map((t) => `$${showSymbol(t.asset.symbol)}`)
              .join(' · ')}
            {targets.length > 4 ? ` +${targets.length - 4}` : ''}
          </div>
        </Link>
      ) : (
        <Link
          to={publishFlow}
          className="press group rounded-2xl border border-white/12 bg-black/25 p-4 transition-colors hover:border-cyan/50"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">no draft standing</div>
          <div className="mt-2 font-display text-base font-bold text-ink group-hover:text-cyan">Start a new basket</div>
          <div className="mt-2 font-mono text-[11px] text-ink-dim">design the weights · publish when ready</div>
        </Link>
      )}
      <div className="rounded-2xl border border-white/12 bg-black/25 p-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">iterate</div>
        <div className="mt-2 font-display text-base font-bold text-ink">Cut a new version</div>
        <div className="mt-2 font-mono text-[11px] text-ink-dim">
          ↻ on any basket above starts a new one from its recipe, already linked to the version it replaces
        </div>
      </div>
    </div>
  )
}

/**
 * THE STUDIO — every owner-only surface, in one place (2026-08-06).
 *
 * These used to be scattered: the edit button floated above the page, the
 * dashboard sat between the identity and the baskets, and the new-bundle button
 * landed between the bundle shelf and the convictions. A visitor saw the gaps
 * they left, and the creator had to hunt. Grouping them at the foot means the
 * page reads the same for both, and everything the creator can act on is one
 * scroll (or one tap of the studio door in the header) away.
 */
function CreatorStudio({
  profile,
  editing,
  onToggleEdit,
  hasProfile,
  needsName,
  onNewBundle,
}: {
  profile: CreatorProfile
  editing: boolean
  onToggleEdit: () => void
  hasProfile: boolean
  /** True when this wallet verifiably has NO claimed name — step 1 shows. */
  needsName: boolean
  onNewBundle: () => void
}) {
  const bundlesOn = pageEnabled(brand.pages, 'bundle')
  return (
    <section id="creator-studio" className="scroll-mt-20 rounded-3xl border border-cyan/25 bg-cyan/[0.03] p-4 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">Your studio</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">only you see this</span>
      </div>

      {/* THE PAGE ITSELF FIRST. Editing happens right here (owner 2026-07-29):
          the connected owner opens the same profile editor inline, no trip to
          /creators. It leads the studio because it is the one thing that
          changes what a visitor sees at the top. */}
      {/* MAKE IT YOURS — ONE flow, top of the studio (owner 2026-08-15:
          "combined into one flow and shown more prominently close to the top
          since its the important first step"). Step 1 = the NAME (the real
          ClaimHandle, Base is its home); step 2 = the PROFILE. Each step
          collapses to a ✓ line once done; both done = the calm edit chip. */}
      {(needsName || !hasProfile) && !editing ? (
        <div className="mt-6 overflow-hidden rounded-2xl border border-white/12">
          <div aria-hidden className="h-1 w-full" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
          <div className="p-5 sm:p-6">
            <div className="font-display text-xl font-bold uppercase tracking-tight text-ink">Make this page yours</div>
            <div className="mt-4 space-y-4">
              <div className="flex items-start gap-3">
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full font-display text-[12px] font-bold ${needsName ? 'bg-cyan text-void' : 'bg-teal/20 text-teal'}`}>
                  {needsName ? '1' : '✓'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                    {needsName ? 'Claim your name' : 'Name claimed'}
                  </div>
                  {needsName && <ClaimHandle className="mt-3" />}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full font-display text-[12px] font-bold ${hasProfile ? 'bg-teal/20 text-teal' : 'bg-cyan text-void'}`}>
                  {hasProfile ? '✓' : '2'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                    {hasProfile ? 'Profile live' : 'Set up your profile'}
                  </div>
                  {!hasProfile && (
                    <button
                      type="button"
                      onClick={onToggleEdit}
                      className="press mt-3 flex w-full flex-col items-center gap-1 rounded-xl px-6 py-4 text-center transition-transform hover:scale-[1.005]"
                      style={{ background: 'linear-gradient(100deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
                    >
                      <span className="font-display text-lg font-bold uppercase tracking-tight text-void">Claim this page →</span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-void/80">
                        your name, bio and convictions — live in one minute
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={onToggleEdit}
            className={`press inline-flex h-9 items-center rounded-full border px-5 font-mono text-[11px] uppercase tracking-[0.14em] ${
              editing ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-white/15 text-ink-dim hover:border-cyan/50 hover:text-cyan'
            }`}
          >
            {editing ? 'Close the editor' : 'Edit your page'}
          </button>
        </div>
      )}
      {editing && (
        <div className="mt-4">
          <CreatorSignup />
        </div>
      )}

      {/* THE WORK IN PROGRESS (ratified plan #2, 2026-08-04): this page is the
          creation side's HOME. The row carries the two facts a creator returns
          for — the standing draft (resume, one tap) and the next basket (the
          flow's door). Per-basket iterate buttons live on the rows above. */}
      <div className="mt-8">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">Work in progress</h3>
        <div className="mt-4">
          <StudioRow />
        </div>
      </div>

      {/* (the studio's "Your work" queue retired 2026-08-16 — the owner: ONE list,
          not two. Every product now lists once in the baskets section above,
          wearing its creator actions as the card footer; seed, thesis and
          get-listed all live there.) */}

      {/* FEES, IN CONTEXT (owner 2026-08-01, relayed by R: fee claiming should be
          surfaced contextually — "a basket's fee claims on the creator's portfolio
          page" — rather than as standalone destinations). Scoped to
          profile.baskets, so it answers the question this page is about. Self-hides
          with nothing claimable, and adds no reads: it aggregates the same
          `feeState` query keys the portfolio already uses.

          On the two numbers here — deliberate, and NOT the /earn double-count.
          This panel is scoped to THIS creator's baskets; the referral card below
          is the creator's link and everything it earns them anywhere, including
          buys they referred on someone else's basket. Different scopes, different
          questions, each labelled with its own.

          The old "Baskets / Combined TVL" pair that used to sit here is gone: the
          identity plate at the top of this same page already states the combined
          value and the baskets section states the count. Restating a number is how
          two versions of it start to drift.

          NO HEADING OF OURS: PortfolioClaims carries its own ("Claimable fees")
          and self-hides with nothing claimable, so a heading here was both a
          second label for one thing and, most of the time, a title standing over
          an empty space. */}
      <PortfolioClaims baskets={profile.baskets} className="mt-8" />

      <ReferralCard className="mt-8" />

      {bundlesOn && (
        // Start a bundle from your own page (owner 2026-08-01). The shelf only
        // ever linked out from its EMPTY state, so the moment a creator had one
        // bundle there was no way to make another from here.
        <div className="mt-8">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">Bundles</h3>
          <button
            type="button"
            onClick={onNewBundle}
            className="press mt-4 inline-flex h-11 items-center gap-2 rounded-full border border-violet-bright/45 bg-violet-bright/10 px-6 font-mono text-[11px] uppercase tracking-[0.14em] text-[#cabdff] hover:border-violet-bright hover:bg-violet-bright/20"
          >
            + New bundle
          </button>
        </div>
      )}

      {/* the promote wall retired: 'Get listed' now rides each product's
          action footer in the baskets section, per network, instead of a
          second flat list of the same baskets (the owner 2026-08-16). */}
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
  const activeChainId = useActiveChainId()
  const { data: profile, isLoading, isError, chainsFailed } = useCreatorProfile(address)
  const { data: identityMeta } = useCreatorIdentity(address)
  const isMe = !!viewer && !!address && viewer.toLowerCase() === address.toLowerCase()
  // THIS PAGE's claimed URL name (called unconditionally, above the gates).
  // One resolve serves two faces: the hero's shareable name chip when a name
  // exists, and the studio's claim offer when the owner verifiably has none.
  const pageHandle = useHandleForAddress(address)
  // The declared delegate may compose too — their posts render "via delegate".
  const isDelegate =
    !!viewer && !!identityMeta?.delegate && viewer.toLowerCase() === identityMeta.delegate.toLowerCase()
  const [editing, setEditing] = useState(false)
  const [forgeOpen, setForgeOpen] = useState(false)
  // The bundle doors' state (the owner 2026-08-10: edit a whole bundle / link a
  // basket into one, from the creator's own page): which bundle the reshape
  // popup is editing · which basket the join picker is shipping into one.
  // Above the gates, like every hook on this page.
  const [editBundle, setEditBundle] = useState<Thesis | null>(null)
  const [joinSubject, setJoinSubject] = useState<BasketSummary | null>(null)
  const studioRef = useRef<HTMLDivElement>(null)
  const reduced = usePrefersReducedMotion()
  // The viewer's own positions in THIS creator's baskets (QOL round
  // 2026-08-06): Explore's cards state "you hold this" and these cards
  // silently did not — same one-portfolio-read index, same HeldMark, so the
  // fact reads identically on both surfaces. Above the early returns: hooks
  // run unconditionally.
  const heldIndex = useHeldBaskets()
  // The one unseeded read every action footer shares (the Seed pills). This
  // was YourWork's own query; it moved to page level when the studio's second
  // list retired (the owner 2026-08-16 — ONE list, actions on the cards).
  const { data: unseededRows } = useQuery({
    queryKey: ['unseeded-baskets', viewer],
    queryFn: () => unseededBasketsOf(viewer as Address),
    enabled: !!viewer && isMe,
    staleTime: 30_000,
  })
  const unseededKeys = useMemo(
    () => new Set((unseededRows ?? []).map((b: BasketSummary) => `${b.chainId}:${b.address.toLowerCase()}`)),
    [unseededRows],
  )
  // Launch dates for the prose columns (the refine round): the same indexes
  // the journey builds — react-query dedupes the two mounts into one build —
  // read reactively so dates appear the moment an index lands.
  const proseChainIds = useMemo(
    () => [...new Set((profile?.baskets ?? []).map((b) => b.chainId))],
    [profile?.baskets],
  )
  const proseIdxQueries = useQueries({
    queries: proseChainIds.map((id) => ({
      queryKey: ['spectrum', 'launch-index', id],
      queryFn: () => ensureLaunchIndex(id),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })
  const proseDatedTick = proseIdxQueries.filter((q) => q.data === true).length
  const launchedAtOf = useMemo(
    () => launchTimeLookup(proseChainIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [proseChainIds, proseDatedTick],
  )
  // Their cross-chain bundles, grouped ONCE at page level: the strip's cards,
  // the per-basket join doors and the modal mounts all read this one list.
  // (`launchedAt` rides for API compat; the grouper no longer reads it.)
  const theses = useMemo(
    () => groupIntoTheses(profile?.baskets ?? [], { launchedAt: launchedAtOf }),
    [profile?.baskets, launchedAtOf],
  )

  if (!address) return <Notice>No creator address provided.</Notice>
  if (isError)
    return <Notice>Could not load this creator. The public data source may be busy, so try again in a moment.</Notice>
  if (isLoading || !profile) return <CreatorSkeleton />

  const openStudio = () => {
    setEditing(true)
    studioRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }

  // The ONE owner-only control in the header: a door to the studio, which holds
  // the rest. A visitor never sees it, and the creator never has to hunt.
  const ownerBar = isMe ? (
    <button
      type="button"
      onClick={() => studioRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })}
      className="press inline-flex h-9 items-center gap-2 rounded-full border border-cyan/45 bg-cyan/10 px-4 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan backdrop-blur hover:border-cyan"
    >
      Your studio ↓
    </button>
  ) : null

  const hero = (
    <CreatorHero
      profile={profile}
      identityMeta={identityMeta ?? null}
      isMe={isMe}
      onEdit={openStudio}
      ownerBar={ownerBar}
      handle={pageHandle.lookup.status === 'found' ? pageHandle.lookup.owner : null}
    />
  )

  const studio = isMe ? (
    <div ref={studioRef}>
      <CreatorStudio
        profile={profile}
        editing={editing}
        onToggleEdit={() => setEditing((v) => !v)}
        hasProfile={!!identityMeta}
        needsName={!pageHandle.loading && pageHandle.lookup.status === 'none'}
        onNewBundle={() => setForgeOpen(true)}
      />
      {/* baskets you created that aren't fully published yet (owner 2026-08-15
          11:43) — deployed on-chain, still waiting on their first buy; each
          carries the real seed door, and remove is an honest local dismissal */}
      {/* the seed wall and the thesis-nudge wall are RETIRED here: both now
          ride each product's own "creator tools" strip in YourWork, so one
          product occupies one card instead of up to four full-width sections
          repeating its ticker (the owner 2026-08-16). They stay mounted on the
          PORTFOLIO page, where there is no per-product card to carry them. */}
      {forgeOpen && <BundleForge overlay onClose={() => setForgeOpen(false)} />}
    </div>
  ) : null

  // Tighter between regions on a phone than on a desktop (the 2026-08-05 mobile
  // sweep: the next piece of information should be on screen within a second of
  // scrolling away from the last one). 32/40 on the house scale, and the hero's
  // own foot padding is what carries the rest of the gap under the identity.
  const shell = 'space-y-8 pb-4 sm:space-y-10'

  if (profile.basketCount === 0) {
    // "Published nothing" may only be ASSERTED when the whole registry
    // actually answered: every chain's list arrived AND every discovered
    // basket's deployer is known. A failed CHAIN contributes [] to the
    // combined list, and a failed deployer read leaves null — in either gap
    // this creator's baskets could be hiding, so say "could not check",
    // never "nothing". (Both halves bit on the same day, 2026-08-06: a
    // rate-limited RPC made this page claim a four-basket creator had
    // published none — first via memoized-null deployers, then via the RH
    // enumeration failing while Base/ETH answered.)
    const unverified = profile.unknownDeployerCount > 0 || (chainsFailed ?? 0) > 0
    return (
      <div className={shell}>
        {hero}
        {/* The unfinished launch outranks the empty state: a creator whose
            first basket is deployed-but-unseeded would otherwise be told they
            have published nothing (see the ruling's mount note below). */}
        <ResumeLaunchCard wallet={address} />
        <Notice>
          {unverified
            ? 'Could not verify this creator’s baskets just now — part of the network did not answer, so nothing is being claimed either way. Try again in a moment.'
            : isMe
              ? 'You have not published a basket from this address yet. Your first one appears here with its composition, its performance and whatever you say about it.'
              : 'No baskets published from this address yet. When one is, it appears here with its composition, its performance and the creator’s own words about it.'}
        </Notice>
        {studio}
      </div>
    )
  }

  return (
    <div className={shell}>
      {hero}

      {/* ── THE UNFINISHED LAUNCH, ABOVE EVERYTHING (the owner 2026-08-13: "this
             flow of the create basket is crucial, you should ALWAYS be guided
             through the entire setup, and even if you accidentally refresh or
             click off you should always be able to resume from your creator
             page or /create").

             It sits directly under the identity, above the baskets, because a
             half-finished launch is the one thing on this page that is
             time-sensitive — a deployed-but-unseeded basket LOOKS finished in
             the grid below (it has a card, a name and a ticker) while being
             unenterable, and a standing draft disappears if it is forgotten.

             Owner-scoped and self-hiding: it takes the page's address, so a
             visitor never sees it, and it renders nothing at all when there is
             nothing outstanding. ── */}
      <ResumeLaunchCard wallet={address} />

      {/* ── THE EVIDENCE ──────────────────────────────────────────────────
          The baskets are the point of the page, so they come first after the
          claim — the creator's signed words say it once, in the showcase
          plate (the owner 2026-08-12), and every card below is face-only. The
          counts that used to be generic tiles up top live here instead, where
          they describe the list a reader is actually looking at. */}
      <section className="space-y-4">
        {/* (the "Their baskets · N live" SectionBar retired — the owner 2026-08-16
            live: "we dont need Their baskets 23 live". The evidence opens with
            the showcase plate itself; the other bundles follow it in the same
            md face, then the standalone baskets.) */}

        {/* ── THE HIGHLIGHT (owner 2026-08-06: "a highlight basket/thesis above
               the list") — the showcase and its words as ONE plate: the thesis
               at display size on the left, the REAL card on the right.
               Selection is a fact, never a taste call, and it is stated as the
               eyebrow.

               THE BUNDLE LEADS (the owner 2026-08-12: "the most held should always
               default to their bundle and show it like it's a basket in this
               section rather than as a small little element on the creator
               page") — a creator WITH a bundle showcases their biggest one (by
               combined AUM — the grouper's own order, so theses[0]) wearing
               ThesisDoorCard's FULL md face, the exact mount Explore's Bundles
               band ships (thesis + size="md"): combined-value chart, composite
               bento, combined price + 24h + TVL, violet dress. Its words are
               the bundle's own — the lead leg's signed meta, the Thesis page's
               exact rule — and the door is the bundle's page, violet because
               bundle surfaces are violet. ITS LEGS RIDE THE PLATE'S FOOT as
               compact rows (the owner 2026-08-13, the grouped-legs ruling above
               BundleLegSet — this supersedes the 2026-08-12 "every basket
               then lists in the grid below" arrangement): the grid holds only
               the genuinely standalone baskets, and the count above the
               section still counts everything. Creators with NO bundle keep
               the most-held basket plate exactly as it shipped. ── */}
        {(() => {
          const bundle = theses[0] ?? null
          const flagship = bundle
            ? null
            : ([...profile.baskets].sort(
                (a, b) => (b.holdersCount ?? 0) - (a.holdersCount ?? 0) || b.aumUsd - a.aumUsd,
              )[0] ?? null)
          if (!bundle && !flagship) return null
          // THE LEGS LEAVE THE GRID (the owner 2026-08-13, the grouped-legs ruling
          // above BundleLegSet): a bundle's per-network baskets render as
          // compact rows under their bundle's presence — the showcase plate
          // for theses[0], the strip cards for the rest — so the grid below
          // holds only the genuinely standalone baskets. Identity match
          // (chainId:address), deliberately NOT the name fold: a same-chain
          // shadow the grouper dropped from the legs (a relaunch sharing the
          // name) is a separate live product the bundle's combined figures do
          // not count, and a name-fold filter would erase it from the page
          // entirely. With no bundles the set is empty and this is exactly
          // the old baskets-minus-flagship grid.
          const legKeyOf = (b: { chainId: number; address: string }) =>
            `${b.chainId}:${b.address.toLowerCase()}`
          const bundleLegKeys = new Set(theses.flatMap((t) => t.legs.map(legKeyOf)))
          const rest = profile.baskets.filter(
            (b) =>
              !bundleLegKeys.has(legKeyOf(b)) &&
              !(flagship && b.chainId === flagship.chainId && b.address === flagship.address),
          )
          return (
            <>
              {bundle ? (
                <Bezel glow="var(--color-violet)">
                  {/* the padding lives on this wrapper (not the grid) so the
                      legs band below the two columns shares the plate's own
                      gutters — one plate, one product. */}
                  <div className="p-6 sm:p-10">
                    {/* min-w-0 on both columns: a grid item floors at
                        min-content by default, which let the card widen its
                        column and clip itself (mobile sweep 2026-08-06). */}
                    <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
                      <div className="min-w-0">
                        <Eyebrow tone="spectral">{theses.length > 1 ? 'biggest bundle' : 'their bundle'}</Eyebrow>
                        <div className="mt-5">
                          <BasketProse
                            basket={bundle.legs[0].address}
                            chainId={bundle.legs[0].chainId}
                            mine={isMe}
                            href={thesisHref(bundle.deployer, bundle.name)}
                            door="bundle"
                            assetCount={bundle.legs.reduce((s, l) => s + l.basketLength, 0)}
                            launchedAt={launchedAtOf(bundle.legs[0])}
                          />
                        </div>
                      </div>
                      <div className="min-w-0">
                        <ThesisDoorCard thesis={bundle} size="md" />
                        {/* the creator's buttons, docked under the public
                            face — the card-footer grammar (the owner 2026-08-16;
                            the plate-foot leg wall retired on the same word:
                            the card's own chain badges carry one-per-network) */}
                        {((DEPLOY_ENABLED && isMe) || bundle.legs.some((l) => isDemoLegAddress(l.address))) && (
                          <div className="mt-2 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                            <ProductActions
                              legs={bundle.legs}
                              isMe={isMe}
                              onEditBundle={() => setEditBundle(bundle)}
                              unseededKeys={unseededKeys}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </Bezel>
              ) : flagship && (
                <Bezel glow={basketSignatureColor(flagship.address, flagship.top[0])}>
                  {/* min-w-0 on both columns: a grid item floors at min-content
                      by default, which let the card widen its column and clip
                      itself (mobile sweep 2026-08-06). */}
                  <div className="grid items-center gap-8 p-6 sm:p-10 lg:grid-cols-2 lg:gap-12">
                    <div className="min-w-0">
                      <Eyebrow tone="spectral">most held</Eyebrow>
                      <div className="mt-5">
                        <BasketProse
                          basket={flagship.address}
                          chainId={flagship.chainId}
                          mine={isMe}
                          href={basketHref(flagship)}
                          assetCount={flagship.basketLength}
                          launchedAt={launchedAtOf(flagship)}
                        />
                      </div>
                    </div>
                    <div className="min-w-0">
                      {/* the actions ride the card's OWN footer (the owner
                          2026-08-16: visible buttons in the card footer, the
                          $TESTV3 grammar) — no stacked buttons under it */}
                      <BasketCard
                        ix={flagship}
                        held={heldPosition(heldIndex, flagship)}
                        footer={
                          (DEPLOY_ENABLED && isMe) || isDemoLegAddress(flagship.address) ? (
                            <ProductActions
                              legs={[flagship]}
                              isMe={isMe}
                              bundles={theses}
                              onJoin={setJoinSubject}
                              unseededKeys={unseededKeys}
                            />
                          ) : undefined
                        }
                      />
                    </div>
                  </div>
                </Bezel>
              )}

              {/* ── THE OTHER BUNDLES, IN THE SAME NICE FACE (the owner 2026-08-16
                     live: "if we have this nicer looking section … i want the
                     info all there not above") — every remaining bundle, below
                     the plate, as the md card the plate itself uses, each with
                     its action footer. ── */}
              <TheirTheses theses={theses.slice(1)} isMe={isMe} onEdit={setEditBundle} unseededKeys={unseededKeys} />

              {/* ── THE GENUINELY NEW, TWO PER ROW (owner 2026-08-09: "after
                     the spotlight, their next baskets should all be via a grid
                     of two per row"). The spotlight above is the wide plate;
                     repeating that shape for every basket made a long single
                     column that read as a queue rather than a collection.

                     ONLY STANDALONE BASKETS LIST HERE (the owner 2026-08-13, the
                     grouped-legs ruling — see `rest` above): a bundle's legs
                     render as compact rows under their bundle's presence, so
                     this grid is exactly the "genuinely new other baskets".
                     When every basket is a bundle leg, `rest` is empty and the
                     zero-check below drops the band whole — never an empty
                     band, and nothing is lost: every leg is visible as a row
                     under its bundle, and the section count still says how
                     many live baskets there are.

                     THE WORDS CAME OFF THE GRID (the owner 2026-08-12: "the thesis
                     shows for each basket no need to have the text of read the
                     thesis dropdown etc."): each cell used to restate its
                     thesis, launch line and page door under the card — for a
                     bundle's legs that was the SAME pitch once per network,
                     and the page read as a wall of text. The card face already
                     says ticker, name, chart, composition and price, and it IS
                     the door to the basket's own page, where the whole thesis
                     lives; the creator's words say it once, large, in the
                     showcase above.

                     `items-start` matters: grid cells default to stretch, so a
                     short cell beside a tall one would pad its card to match
                     the tallest in the row. Each cell sizes to its own content
                     and the row's baseline is the top, which is where the eye
                     enters. `min-w-0` on the cell for the same reason it is on
                     the spotlight's columns — a grid item floors at
                     min-content, and without it a wide card clips itself. ── */}
              {rest.length > 0 && (
                /* ── A SLIDESHOW ON PHONES, A TWO-UP GRID ABOVE (the owner
                      2026-08-09: "make that a slideshow for mobile"). Stacked
                      vertically, three baskets each carrying a card, a thesis
                      and a button is a very long scroll before the page's next
                      section — one basket per screen, swiped, keeps each one
                      whole and makes the collection feel like a collection.

                      Snap rather than a carousel widget: `snap-x snap-mandatory`
                      + `overflow-x-auto` is the platform's own horizontal
                      paging, so it has momentum, respects reduced-motion, and
                      needs no library or state. `-mx-4 px-4` lets the row bleed
                      to the screen edge while the first card still starts at the
                      page gutter. From `lg` the scroll container becomes a plain
                      grid and every snap class stops applying, so the desktop
                      layout is exactly the two-up grid and nothing else. ── */
                <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:grid lg:snap-none lg:grid-cols-2 lg:items-start lg:gap-x-12 lg:gap-y-14 lg:overflow-visible lg:px-0 lg:pb-0">
                  {rest.map((ix) => (
                    /* ONE CARD PER BASKET (the owner 2026-08-09: "should be a bg
                       card for each basket + thesis + button"; the thesis half
                       superseded by the 2026-08-12 trim above) — the card and
                       its deployer controls sit on one surface, so a reader
                       can see where one basket ends and the next begins. The
                       basis/shrink-0 pair is what makes each a full-width page
                       on a phone; both are dropped at lg. */
                    <div
                      key={`${ix.chainId}:${ix.address}`}
                      className="min-w-0 shrink-0 basis-[86%] snap-start rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:basis-[62%] sm:p-5 lg:basis-auto lg:shrink lg:p-6"
                    >
                      <BasketCard
                        ix={ix}
                        held={heldPosition(heldIndex, ix)}
                        footer={
                          (DEPLOY_ENABLED && isMe) || isDemoLegAddress(ix.address) ? (
                            <ProductActions
                              legs={[ix]}
                              isMe={isMe}
                              bundles={theses}
                              onJoin={setJoinSubject}
                              unseededKeys={unseededKeys}
                            />
                          ) : undefined
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        })()}
      </section>

      {/* their bundles — the packaged version of the baskets above. Still part
          of what they made, so it stays with the evidence. On your OWN page it
          is the manage view (owner 2026-07-29): with one basket it nudges the
          second launch, with more it invites the bundle — visitors still never
          see an empty section. */}
      {pageEnabled(brand.pages, 'bundle') && (
        <BundleShelf
          creator={profile.address}
          chainId={activeChainId}
          manage={isMe}
          basketCount={profile.basketCount}
        />
      )}

      {/* ── HOW IT HAS GONE ───────────────────────────────────────────────
          The feed self-hides when there is nothing to show, which is why it
          carries its own heading instead of sharing one.

          THE JOURNEY IS GONE (the owner 2026-08-09: "lets remove this it doesnt
          offer value"). It drew one basket's NAV against its launch price —
          "$HARD +29.1% since launch" — which the basket's own card already
          states, and a chart of two points with a straight line between them
          is not evidence of anything. CreatorJourney.tsx is left in the tree:
          it is a real component with its own tests, and deleting it would take
          the moments-timeline work with it if this is ever wanted back. ── */}
      <CreatorFeed
        creator={profile.address as Address}
        chainId={activeChainId}
        canPost={isMe || isDelegate}
        delegate={identityMeta?.delegate ?? null}
      />

      {/* ── THE STUDIO (owner only) ───────────────────────────────────── */}
      {studio}

      {/* the bundle doors' popups — the strip's Edit pill opens the whole-bundle
          reshape (the Thesis page's own mount, per-card), and a basket's
          "Add to a bundle" opens the shared picker → the reshape popup in join
          mode. Demo rule per subject, both pages' exact gate. */}
      {editBundle && (
        <ReshapeThesisModal
          deployer={editBundle.deployer}
          name={editBundle.name}
          legs={editBundle.legs.map((l) => ({ address: l.address as `0x${string}`, chainId: l.chainId, symbol: l.symbol }))}
          demo={editBundle.legs.some((l) => isDemoLegAddress(l.address))}
          onClose={() => setEditBundle(null)}
        />
      )}
      {joinSubject && (
        <JoinBundlePicker
          bundles={theses.filter((t) => foldName(t.name) !== foldName(joinSubject.name))}
          subject={{ address: joinSubject.address as `0x${string}`, chainId: joinSubject.chainId, symbol: joinSubject.symbol }}
          demo={isDemoLegAddress(joinSubject.address)}
          onClose={() => setJoinSubject(null)}
        />
      )}
    </div>
  )
}
