import { basketHref } from './short-url'
import { MAX_ASSETS } from './weights'
import type { Journey, StepId } from './launch-journey'

// ─────────────────────────────────────────────────────────────────────────────
// THE DOORS — where each step of a launch journey actually goes.
//
// Separated from launch-journey.ts (which judges) and from the card (which
// draws) because a door is the one part that can be WRONG in a way neither
// notices: a card can render perfectly and still send a creator somewhere that
// cannot do the thing it just told them to do. Pure, so every door is pinned by
// a test instead of by clicking.
//
// EVERY DOOR OPENS SOMETHING THAT ALREADY EXISTS. Nothing here is a new
// surface:
//   seed   → the basket page with ?deployed=1, which is what opens the shipped
//            SeedBasketModal ("Now seed $X", the real first-buy console —
//            R+C 2026-07-06 18:26). There is no second seed door.
//   thesis → the basket page's own ThesisEditor (the one-tx SpectrumNotes
//            write), or a caller-supplied anchor when the editor is already on
//            the page the card is sitting on.
//   share  → the basket page with ?share=1, which raises the shipped
//            ShareModal (the drawn image card + copy/save). The page's
//            standalone Share button left on the owner's 2026-08-07 note
//            ("people have the URL anyway"), which quietly made the bare
//            page a door to nowhere; the owner's 2026-08-14 recording
//            (create → seed → SHARE as the flow's third step) makes the
//            journey step the door, so it must open the modal itself.
//   build  → /create, in the face that matches the draft that was left.
// ─────────────────────────────────────────────────────────────────────────────

export interface StepDoor {
  href: string
  /** The button's words — an imperative, because it is an action not a place. */
  label: string
}

/** The basket page for a journey subject, or null for a draft journey. */
function basketPage(journey: Journey): string | null {
  if (journey.subject.kind !== 'basket') return null
  const b = journey.subject.basket
  return basketHref({ symbol: b.symbol, address: b.address, chainId: b.chainId })
}

/**
 * Where `step` goes for this journey, or null when there is nowhere honest to
 * send someone (a step whose subject cannot support it).
 *
 * `anchors` lets a page that ALREADY hosts a step's surface point at it in
 * place rather than navigating to a copy of itself.
 */
export function stepDoor(
  journey: Journey,
  step: StepId,
  anchors: { seed?: string; thesis?: string; share?: string } = {},
): StepDoor | null {
  if (journey.subject.kind === 'draft') {
    const d = journey.subject.draft
    if (step !== 'build' && step !== 'deploy') return null
    // The composer face restores its own draft on mount, so bare /create IS the
    // resume. A builder draft belongs to the full-page studio — and a
    // version-mode draft is keyed to its predecessor, so it only reopens with
    // that predecessor named.
    if (d.kind === 'composer') return { href: '/create', label: 'Pick up where you left off' }
    if (d.predecessor && d.chainId != null)
      return {
        href: `/create?from=${encodeURIComponent(d.predecessor)}&chain=${d.chainId}`,
        label: 'Back to the new version',
      }
    // Legacy STUDIO drafts land on the modern create page, never ?studio=1
    // (owner, live 2026-08-14: "the old create studio should never be linked
    // to from the continue work popup"). The old draft's content stays in
    // storage; the door just refuses to resurrect the retired face for it.
    return { href: '/create', label: 'Pick up where you left off' }
  }

  const page = basketPage(journey)
  if (!page) return null
  switch (step) {
    case 'build':
    case 'deploy':
      // Both already happened — the basket exists. Its page is the only place
      // the word "go" still means anything.
      return { href: page, label: 'Open the basket' }
    case 'seed':
      // ?deployed=1 is what raises the shipped seed console on arrival — but a
      // page that already HAS the buy console scrolls to it instead of
      // navigating to itself to grow a second one.
      return { href: anchors.seed ?? `${page}?deployed=1`, label: 'Seed it now' }
    case 'thesis':
      return { href: anchors.thesis ?? page, label: 'Write the thesis' }
    case 'share':
      // ?share=1 is what raises the ShareModal on arrival (Token page reads
      // it) — the bare page has had no Share affordance since 2026-08-07.
      return { href: anchors.share ?? `${page}?share=1`, label: 'Share it' }
  }
}

// ── SHARE THIS DRAFT (the owner 2026-08-13, in the greenlit list) ────────────────
//
// A draft is not on chain, so it has no page — but it already has a WIRE
// FORMAT: `/createbasket?tokens=<a,b,c>&chain=<id>`, which the Composer parses
// on mount (its parseChainParam + seedFromAddresses) to rebuild a mix from
// nothing but a URL. That door has existed since 2026-07-08 as an EXTERNAL
// contract — Prismbeat's bot builds those links and this app only ever read
// them. Nothing in the repo has ever written one.
//
// So this is the builder for a parser that already shipped, and its job is to
// emit exactly what that parser accepts and nothing else:
//   · lowercased, de-duplicated, 20-hex-byte addresses only — the parser's own
//     filter, applied here so a bad address is dropped at the source rather
//     than silently vanishing on the far side;
//   · MAX_ASSETS at most, the same cap seedFromAddresses slices to;
//   · the chain as its NUMERIC id (parseChainParam accepts keys and aliases
//     too, but an id cannot be mis-resolved by a rename).

const ADDRESS = /^0x[0-9a-f]{40}$/

/**
 * A link that rebuilds this draft's mix in the Composer, or null when there is
 * nothing valid to carry. Relative by default; pass `origin` for an absolute
 * one to put on a clipboard.
 */
export function draftShareUrl(input: {
  addresses: readonly string[]
  chainId: number
  origin?: string
}): string | null {
  if (!Number.isInteger(input.chainId)) return null
  const tokens = [...new Set(input.addresses.map((a) => String(a ?? '').trim().toLowerCase()))]
    .filter((a) => ADDRESS.test(a))
    .slice(0, MAX_ASSETS)
  if (tokens.length === 0) return null
  const path = `/createbasket?tokens=${tokens.join(',')}&chain=${input.chainId}`
  return input.origin ? `${input.origin.replace(/\/+$/, '')}${path}` : path
}
