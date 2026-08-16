import { useMemo } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { useNavigate } from 'react-router'
import { useAccount } from 'wagmi'
import brand from '../../brand.config'
import { pageEnabled } from '../../theme/brand'
import { SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { loadDraft } from '../../lib/spectrum/allocation'
import { usePortfolio } from '../../lib/spectrum/hooks'
import { basketRowsFromPortfolio, deriveFoundBook } from '../../lib/spectrum/found-book'
import { flowHref } from '../../lib/spectrum/flow-link'
import { markHomeOnboardingSeen } from '../../lib/spectrum/home-onboarding-seen'
import { seedDraftFromHoldings } from '../../lib/spectrum/seed-from-holdings'
import { useRawHoldings } from '../../lib/spectrum/use-raw-holdings'
import { useWalletGroup } from '../../lib/spectrum/use-wallet-group'
import { useMinWidth } from '../../lib/motion'
import { ChainBadge } from '../ChainBadge'
import { DoorCard, SceneBasketToken, SceneReweight } from '../allocate/DoorCards'
import { GhostBook } from '../portfolio/GhostBook'

// ─────────────────────────────────────────────────────────────────────────────
// THE HOMEPAGE ONBOARDING (owner ~16:3x, replacing the choose-assets station:
// "this must be the onboarding flow we have had built here … not the choose
// assets flow"). The get-started act is CONNECT-FIRST — the same system as the
// portfolio ceremony, inline:
//   disconnected — the ghost book (a silhouette is a promise) + a spectral
//                  Get-started CTA summoning the wallet dialog through the
//                  `spectrum:connect` event (the swap console's own idiom;
//                  Nav's WalletButton carries the listener site-wide).
//   connected    — YOUR book, drawn by the product's own bento from the same
//                  derivation the ceremony uses (found-book.ts, one source),
//                  the readable-now total, the linked-wallets pill, and the
//                  0845 doors as the flow's OWN DoorCards (reuse, never a
//                  lookalike) — both seeding the weighting draft from what
//                  you hold and landing in the flow at its own door. The
//                  ride-along line says WHAT travels; an existing draft flips
//                  the doors to Resume (seeding never clobbers).
// The choose-assets station stays reachable ("start from scratch") — it is no
// longer the homepage's face. Engine honesty unchanged: the flow's executor is
// still simulated; these doors create INTENT, nothing signs here.
// ─────────────────────────────────────────────────────────────────────────────

export function HomeOnboarding() {
  const { address, isConnected } = useAccount()
  const connected = isConnected && address ? address : undefined
  const walletGroup = useWalletGroup(connected)
  const raw = useRawHoldings(connected ? walletGroup.addresses : undefined)
  // held BASKETS join the book here too (audit 2026-08-04) — same fold as the
  // ceremony, so the two surfaces cannot disagree about the same wallet.
  const heldBaskets = usePortfolio(connected ? walletGroup.addresses : undefined)
  const navigate = useNavigate()

  const book = useMemo(
    () =>
      deriveFoundBook([
        ...(raw.data?.holdings ?? []),
        ...basketRowsFromPortfolio(heldBaskets.data?.holdings ?? []),
      ]),
    [raw.data, heldBaskets.data],
  )
  // Phones get the compact door (desk 40: the pair measured 480px vs ~800 at
  // 390w); the scenes stay the doors' identity from sm up where there is room.
  // A hook, not hidden duplicates: `size` is DoorCards' API and a display:none
  // twin would still mount both scenes on every phone.
  const doorsFull = useMinWidth(640)

  const publishHref = flowHref('publish')
  // Mirrors the SEEDER's laws (audit A1): native rides (the WETH fold) but a
  // held BASKET does not — counting baskets here made the doors promise
  // "your weights ride in" for rows seedDraftFromHoldings refuses.
  const seedable = useMemo(() => book.priced.filter((h) => !h.basket), [book.priced])
  const canSeed = connected != null && seedable.length >= 2
  // An existing draft flips the doors to RESUME — seeding never clobbers, so
  // the door must not pretend to start fresh (the honest label rule).
  const draft = useMemo(
    () => (connected ? loadDraft(connected) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connected, raw.dataUpdatedAt],
  )
  const hasDraft = (draft?.targets.length ?? 0) > 0
  // (the draft-AGE line left the homepage face on the owner's word 2026-08-03;
  // the flow itself still says what a click resumes, so the age derivation
  // that fed only that line is gone with it.)

  // ⚠ SEEING YOUR BOOK HERE IS NOT COMPLETING ONBOARDING (the owner 2026-08-09:
  // "Create your portfolio → needs to go to the onboarding flow, unless it's
  // already done and you have completed onboarding").
  //
  // This used to latch the moment a connected wallet's book rendered on the
  // HOMEPAGE — no click, no walk, no ceremony. From then on OnboardingGate
  // considered the visitor done and /portfolio never showed the flow again, so
  // the dedicated onboarding was unreachable for exactly the people it was
  // written for: anyone who connected on the front page first. The intent was
  // "one story, told once", but rendering a list is not telling a story.
  //
  // It now latches on the ACT — opening one of the doors below — which is the
  // thing that actually means "I have been walked through this". A visitor who
  // only looks still gets the ceremony once, and a visitor who has genuinely
  // been through it still skips it. See `openDoor` just below.
  //
  // (Deliberately NOT clearing the flag for people it already latched: a
  // returning user who has used the product for a week should not be handed a
  // first-run walkthrough because we changed our mind about the trigger.)

  function openDoor(href: string | null) {
    // the act, not the render — see the note above
    if (connected) markHomeOnboardingSeen()
    if (!href || !connected) return
    seedDraftFromHoldings(connected, raw.data?.holdings ?? [])
    navigate(href)
  }

  if (!connected) {
    return (
      <div className="mx-auto max-w-2xl">
        {/* The ghost is DESKTOP-ONLY now (mobile sweep 2026-08-06): 176px of
            empty outlined boxes — a third of a phone screen of content-free
            skeleton — sitting directly under the hero bento that already
            paints exactly this picture with real assets. On a wide screen the
            two sit far enough apart to read as promise-then-proof. */}
        <div className="hidden sm:block">
          <GhostBook heightClass="h-44" />
        </div>
        {/* the act's Get-started button moved INTO the hero as "Create your
            portfolio" (owner 1826: it "sits above the portfolio card") — the
            hero door is one viewport up and the nav's connect button is always
            present, so a second primary here was duplication. The badges and
            the promise line keep telling the act's story. */}
        <div className="mt-8 flex flex-wrap items-center gap-2">
          {SUPPORTED_CHAIN_IDS.map((c) => (
            <ChainBadge key={c} chainId={c} />
          ))}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-dim">
          Connect and this becomes your book. Reading is free and signs nothing.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* THE BOOK DISPLAY IS GONE FROM THE HOMEPAGE (owner 2026-08-06 live:
          "this doesn't need to be displayed on the homepage — below it you
          have the portfolio and basket options"). The straddling hero bento
          above already paints a book, and the REAL one lives one tap away on
          /portfolio; here the act is the two doors. The reads stay (canSeed,
          the ride-along line and the breadcrumb latch feed off them). */}

      {/* THE 0845 DOORS as the flow's OWN DoorCards — outcomes shown at rest,
          each wired to ITS OWN destination (owner ~16:5x ruling):
          · Build your portfolio → THE ONBOARDING POPUP (the /portfolio
            ceremony via the replay door — the breadcrumb opens it on the
            found step, your book, with Shape-these-weights from there).
            No seeding here: the ceremony's own CTA seeds when chosen.
          · Create a basket token → THE PUBLISH FLOW ("our new /launch page
            effectively"), seeded from what you hold.
          GATED APART (fix 2026-08-12): publishHref is null when the operator
          ships the create flow off (the brand.config shipped default), and
          gating BOTH doors on it cost production visitors the manage door —
          which needs no create flow at all (it opens the book you already
          have). Each door carries its own gate now: manage = canSeed;
          create = canSeed + publishHref. When the manage door stands alone
          it owns the full row (the grid drops its lg second column — the
          same single-column render every viewport below lg already gets). */}
      {canSeed ? (
        <>
          <div className={publishHref ? 'mt-8 grid gap-4 lg:grid-cols-2' : 'mt-8 grid gap-4'}>
            <DoorCard
              /* owner 2026-08-03 late: 'build sounds intimidating but manage
                 sounds like something you already do' */
              title="Manage your portfolio"
              /* CROSSOVER COPY (ratified plan 0.4): each door says what
                 TRAVELS. The portfolio door carries nothing — it opens on the
                 book you already have (wallet-anchored: your holdings ARE the
                 starting point, nothing is seeded or moved). */
              tagline={
                <>
                  your wallets, one book
                  <br />
                  rebalance anytime
                </>
              }
              glow="var(--color-cyan)"
              cta="Open"
              scene={() => <SceneReweight />}
              size={doorsFull ? 'full' : 'compact'}
              enterIndex={0}
              connecting={false}
              onOpen={() => navigate('/portfolio?intro=replay')}
            />
            {publishHref && (
              <DoorCard
                title="Create a basket token"
                /* the basket door DOES carry something — your weights ride in
                   as a starting recipe (the ride-along line below names the
                   assets; the seeder excludes held baskets and says so). */
                /* comma, not interpunct (owner 2026-08-06 live) */
                tagline="your weights ride in, you earn the fees"
                glow="var(--color-magenta)"
                cta={hasDraft ? 'Resume' : 'Start'}
                /* their component takes no props (DoorCards is specallocator's
                   — their signature is the contract) */
                scene={() => <SceneBasketToken />}
                size={doorsFull ? 'full' : 'compact'}
                enterIndex={1}
                connecting={false}
                onOpen={() => openDoor(publishHref)}
              />
            )}
          </div>
          {/* the ride-along line — the BASKET door's fact, so it hides with
              the basket door (publishHref, same gate as the door it
              footnotes). The draft-age variant left the homepage on the
              owner's word (2026-08-03 late: 'remove this text') — the flow
              itself still says what a click resumes; the homepage face stays
              clean. */}
          {/* DESKTOP ONLY (owner 2026-08-07): the ticker list is the first
              thing cut on a narrow screen — it wraps to two or three lines of
              10px mono under the doors and crowds the act it is supposed to
              footnote. The doors already say what they do; this is detail for
              a reader with room for it. lg: because a tablet has the same
              problem as a phone here. */}
          {publishHref && !hasDraft && (
            <p className="mt-4 hidden font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint lg:block">
              {`${seedable
                .slice(0, 3)
                .map((h) => `$${showSymbol(h.symbol)}`)
                .join(', ')}${seedable.length > 3 ? ` + ${seedable.length - 3} more` : ''} ride along into the basket`}
            </p>
          )}
          {/* (the seeder's exclusion note — "your baskets stay as they are" —
              left the homepage on the owner's word, 2026-08-16: the seeder
              itself still states the exclusion where it acts) */}
        </>
      ) : (
        /* nothing to seed — explore is the honest next step (the ceremony's
           own empty-state door), scratch stays for builders */
        !raw.isLoading && (
          <div className="mt-8 flex flex-wrap items-center gap-4">
            {pageEnabled(brand.pages, 'discover') && (
              <button
                type="button"
                onClick={() => navigate('/explore')}
                className="spectral-btn press inline-flex h-12 items-center rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void"
              >
                Browse baskets
              </button>
            )}
          </div>
        )
      )}
      {/* (the "start from scratch" escape hatch left the homepage on the
          owner's word, 2026-08-16 — the flow's own PublishPicker still
          offers a true scratch start where drafts are actually managed) */}
    </div>
  )
}
