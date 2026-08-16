import type { BasketRoute } from '../../lib/pools'
import type { FeeConfigInput } from '../../lib/spectrum/abis-v2'

// ─────────────────────────────────────────────────────────────────────────────
// THE RESHAPE CONTRACT — the seam four parallel modules implement against
// (the owner 2026-08-10: "make it easy for a creator to edit their thesis /
// reweight … a reshape pop up a bit like the portfolio system except tailored
// for baskets and thesis").
//
// THE ONE FACT THE WHOLE FEATURE RESTS ON: a published basket is immutable.
// "Editing" is shipping a NEW VERSION — a real deploy (`useDeployBasket`) plus
// one EIP-712 lineage signature (`supersedes`, the BasketBuilder:770 pattern).
// The old basket keeps trading; its page grows a version strip; holders swap
// into the new version through the existing migrate flow on their own
// schedule. The popup's job is to make that feel like editing while never
// letting it LOOK like mutation — the review stage says "ships v2" in words.
//
// THE WEIGHT LAW IS weights.ts (MIN 5 · STEP 5 · ≤20 assets · Σ=100,
// borrow-from-largest), NOT allocation.ts's portfolio law (min 1 / ≤50):
// only the former is deployable — toBasketEntries enforces just Σ=100, so a
// popup on the looser law would mint drafts the builder itself calls invalid.
//
// Files implementing this contract:
//   lib/spectrum/version-seed.ts   — useVersionSeed (v1→draft, the
//                                    BasketBuilder prefill recipe EXTRACTED,
//                                    builder refactored to consume it)
//   lib/spectrum/use-lineage-sign.ts — the silent supersedes signature
//   components/reshape/ShapeEditor.tsx — the shape stage (tiles + dial)
//   components/reshape/ReshapeBasketModal.tsx — one basket, three stages
//   components/reshape/ReshapeThesisModal.tsx — one thesis, per-chain tabs +
//                                    a sequential per-chain deploy ceremony
// ─────────────────────────────────────────────────────────────────────────────

/** One deployable leg of a draft — resolved against LIVE pools (route is
 *  findBestPool's verdict, never copied blindly from v1). */
export interface ReshapeLeg {
  address: `0x${string}`
  symbol: string
  name?: string | null
  decimals: number
  route: BasketRoute
}

/** The editable draft: legs + whole-% weights, index-aligned, Σ=100 under the
 *  weights.ts law at all times (every mutation goes through its ops). */
export interface ReshapeDraft {
  name: string
  /** Seeds as the predecessor's own ticker (keep-same default, owner
   *  2026-08-12); editable behind the change-ticker toggle. */
  symbol: string
  legs: ReshapeLeg[]
  weights: number[]
  /** Carried VERBATIM from v1 in this popup (fee/share/payout are editable in
   *  the full studio; restating their validation here would fork a money
   *  path). The launcher field is re-derived at deploy, never carried. */
  feeConfig: FeeConfigInput
}

/** What seeding a draft from a live basket found. `dropped` is stated, never
 *  silent: a leg whose pool cannot be re-resolved today is listed with its
 *  reason so the creator knows the draft is narrower than v1. */
export interface VersionSeedResult {
  status: 'loading' | 'ready' | 'error'
  draft: ReshapeDraft | null
  predecessor: `0x${string}` | null
  dropped: { address: string; symbol: string; reason: string }[]
  /** Human sentence when status === 'error' (fewer than 2 legs resolvable,
   *  RPC unreadable — the poisoned-draft guard, never a shorter basket). */
  error: string | null
  /** Re-run the resolution (RPC failures are retryable). */
  retry: () => void
}

/** ShapeEditor — the shape stage, PositionsMode's picture-leads idiom under
 *  the builder's law: the real BasketBento as tiles-as-controls, a fixed
 *  dial slot under it (TrimBar snapping to STEP), −/+ steppers in list view,
 *  AssetSearchModal for adds, ✕ to remove. Pure controlled component. */
export interface ShapeEditorProps {
  chainId: number
  draft: ReshapeDraft
  onChange: (next: ReshapeDraft) => void
  /** Freezes every control (the deploy stage is running). */
  disabled?: boolean
}

export interface ReshapeBasketModalProps {
  address: `0x${string}`
  chainId: number
  /** The subject is a demo basket: every stage works, the ceremony is a
   *  scripted walkthrough (DEMO chip pinned), nothing arms. */
  demo?: boolean
  /** JOIN MODE — this reshape is how a basket enters a multichain thesis.
   *  Names are immutable on-chain and the thesis grouper keys on
   *  (deployer, name), so joining IS shipping a renamed version: the draft's
   *  name seeds to the target thesis's name instead of the predecessor's.
   *  The name stays editable — editing it away simply un-joins, and the
   *  field's note plus the review honesty plate state which one is shipping.
   *  Nothing else changes: same deploy, same lineage signature, same demo
   *  rules. */
  joinThesis?: { name: string }
  onClose: () => void
}

export interface ReshapeThesisModalProps {
  /** The thesis's legs (one basket per chain) + shared identity. */
  deployer: string
  name: string
  legs: { address: `0x${string}`; chainId: number; symbol: string }[]
  demo?: boolean
  onClose: () => void
}

/** The demo ceremony's script — the run overlay's walkthrough idiom applied
 *  to a deploy: each beat holds long enough to read. */
export const DEMO_DEPLOY_SCRIPT: { status: string; ms: number }[] = [
  { status: 'mining', ms: 2200 },
  { status: 'preparing', ms: 1400 },
  { status: 'ready', ms: 1600 },
  { status: 'signing', ms: 1800 },
  { status: 'confirming', ms: 2200 },
  { status: 'success', ms: 0 },
]

/** One thesis-reshape ceremony lane (per chain), the sequential machine the
 *  thesis modal drives: switch is CALLED once per lane and still offered by
 *  hand (the owner 2026-08-13 superseded "OFFERED, never taken" for the
 *  in-ceremony lane advance — auto-switch.ts holds the law), deploy is the
 *  real useDeployBasket per chain, sign is the silent supersedes signature.
 *  Interruption is stated, not papered over: a deployed leg whose signature
 *  was refused/lost is recoverable through LinkPredecessorButton on the new
 *  basket's own page, and the lane's note says exactly that. */
export type ThesisReshapeStepState =
  | 'queued'
  | 'switch' // offering the wallet this chain
  | 'deploying' // useDeployBasket mining→confirming
  | 'signing-lineage'
  | 'done'
  | 'failed'
  | 'skipped' // the creator chose not to reshape this leg

export interface ThesisReshapeLane {
  chainId: number
  predecessor: `0x${string}`
  state: ThesisReshapeStepState
  newAddress: `0x${string}` | null
  note: string | null
}
