import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getAddress, isAddress, type Address, parseAbi } from 'viem'
import { useAccount, useBalance, useEnsName } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useActiveChainId } from '../../lib/chain/active-chain'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { clientFor } from '../../lib/chain/rpc'
import { findBestPool, PoolDetectionError, Venue, ZERO_POOL_KEY, type BasketRoute } from '../../lib/pools'
import {
  addAsset,
  adjustWeight,
  CAP,
  equalSplit,
  isValid,
  MAX_ASSETS,
  MIN,
  removeAsset,
  setWeight,
  STEP,
  sum,
} from '../../lib/spectrum/weights'
import { type FeeConfigInput } from '../../lib/spectrum/abis-v2'
import { feeSplit, type FeeSplit } from '../../lib/spectrum/fee-model'
import { LAUNCHER_ADDRESS } from '../../lib/config/operator'
import { getStoredRef, hasCreatorRefBeenUsed, markCreatorRefUsed } from '../../lib/spectrum/referral'
import { useFeeBounds, useBasketFees } from '../../lib/spectrum/use-basket-fees'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { useTokenColors } from '../../lib/spectrum/use-token-color'
import { formatUsdCompact, shortAddr } from '../../lib/spectrum/format'
import { resolveCreator } from '../../lib/spectrum/creator'
import type { CreatorMetadataInput } from '../../lib/spectrum/creator-metadata'
import { bumpVersionTicker } from '../../lib/spectrum/versioning'
import { usePublish } from '../../lib/spectrum/use-publish'
import { useAllBaskets, useBasketData, useCreatorMeta, useDeployPrice } from '../../lib/spectrum/hooks'
import { AssetLogo } from '../AssetLogo'
import { BasketAvatar } from '../BasketAvatar'
import { BasketBento, type BentoItem } from '../BasketBento'
import { DeployPortal } from './DeployPortal'
import { AssetSearch } from './AssetSearch'
import { PopularAssets } from './PopularAssets'
import { MintOrb, type MintStatus } from './MintOrb'
import { BasketHealth } from './BasketHealth'
import { LiveTokenCard } from './LiveTokenCard'
import { HookForge } from './HookForge'
import { WeightStrip } from './WeightStrip'
import { useDeployBasket } from '../../lib/spectrum/use-deploy'

export interface BuilderAsset {
  address: string
  symbol: string
  decimals: number
  venueLabel: string
  depthUsd: number | null
  warnings: string[]
  route: BasketRoute
}

const symbolAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

async function readSymbol(addr: string, chainId: number): Promise<string> {
  try {
    const s = await clientFor(chainId).readContract({ address: addr as Address, abi: symbolAbi, functionName: 'symbol' })
    return (s as string) || shortAddr(addr)
  } catch {
    return shortAddr(addr)
  }
}

const token0ProbeAbi = parseAbi(['function token0() view returns (address)'])
/** True when the address is a LIQUIDITY-POOL token (Aerodrome LP, Uni pair…):
 *  pools answer token0(); plain ERC-20s revert. People paste the pool address
 *  from the DEX UI instead of the asset itself (R+C walkthrough 2026-07-06). */
async function isPoolToken(addr: string, chainId: number): Promise<boolean> {
  try {
    await clientFor(chainId).readContract({ address: addr as Address, abi: token0ProbeAbi, functionName: 'token0' })
    return true
  } catch {
    return false
  }
}

export async function resolveAsset(addr: string, chainId: number, knownSymbol?: string): Promise<BuilderAsset> {
  const [pool, symbol] = await Promise.all([
    findBestPool(addr as Address, chainId),
    knownSymbol ? Promise.resolve(knownSymbol) : readSymbol(addr, chainId),
  ])
  return {
    address: getAddress(addr),
    symbol,
    decimals: pool.decimals,
    venueLabel: pool.best.label,
    depthUsd: pool.best.depthUsd,
    warnings: pool.warnings,
    route: pool.route,
  }
}

const DEFAULT_GRAD = 'linear-gradient(135deg, var(--color-cyan), var(--color-violet-bright) 55%, var(--color-magenta))'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// Liquidity tiers for a basket constituent's routing pool. Depth only matters
// relative to how much of the basket routes through the pool, so a pool is flagged
// only when it's genuinely thin (< VERY_LOW, any weight) OR it's modest (≤ WARN_LIQ)
// AND the asset dominates the basket (> HEAVY_WEIGHT_PCT). Healthy pools, and
// small positions in modest pools, draw no warning.
const VERY_LOW_LIQ_USD = 20_000
const WARN_LIQ_USD = 50_000
const HEAVY_WEIGHT_PCT = 60
type LiqTier = 'ok' | 'low' | 'verylow'
function liqTier(depthUsd: number | null, weightPct: number): LiqTier {
  if (depthUsd != null && depthUsd < VERY_LOW_LIQ_USD) return 'verylow'
  if ((depthUsd == null || depthUsd <= WARN_LIQ_USD) && weightPct > HEAVY_WEIGHT_PCT) return 'low'
  return 'ok'
}
// When a pool is flagged, suggest a weight that clears it.
function suggestedWeight(depthUsd: number | null): number {
  if (depthUsd != null && depthUsd < VERY_LOW_LIQ_USD) return MIN
  return Math.min(CAP, HEAVY_WEIGHT_PCT)
}

// Wrong-network probe (owner E2E 2026-07-09, seed-flow finding #6): he pasted an
// Ethereum token address while building on Base and got a confusing thin result.
// When an added address resolves thin on the CURRENT chain, look the same address
// up on the other scaffolded chain(s) — a deep market there almost always means
// the address belongs on that network. Returns the warning line, or null when the
// other chains are quiet for it too.
const OTHER_CHAIN_REAL_DEPTH_USD = 50_000
async function wrongNetworkNote(
  addr: string,
  chainId: number,
  thisDepthUsd: number | null,
): Promise<string | null> {
  for (const other of SUPPORTED_CHAIN_IDS) {
    if (other === chainId) continue
    if (!chainCfg(other).poolManager) continue // detection = V4 baseline (V2/V3 join where present)
    try {
      const p = await findBestPool(addr as Address, other)
      const d = p.best.depthUsd
      if (d != null && d >= OTHER_CHAIN_REAL_DEPTH_USD && d > (thisDepthUsd ?? 0) * 5) {
        return `This token looks like it lives on ${chainCfg(other).name} (~${formatUsdCompact(d)} of liquidity there, almost none here). You are building on ${chainCfg(chainId).name}, switch network or paste the ${chainCfg(chainId).name} address for it.`
      }
    } catch {
      /* nothing on that chain either — stay quiet */
    }
  }
  return null
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Hoverable (and keyboard-focusable) ⓘ explainer — a small popover card above
// the icon. Purely informational; never load-bearing.
function InfoTip({ children }: { children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex align-middle">
      <button
        type="button"
        aria-label="What is this?"
        className="grid h-[18px] w-[18px] place-items-center rounded-full border border-white/25 font-serif text-[10px] font-bold italic text-ink-faint transition-colors hover:border-cyan hover:text-cyan focus-visible:border-cyan focus-visible:text-cyan"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-2.5 w-72 -translate-x-1/2 rounded-xl border border-white/12 bg-panel-2 p-3.5 font-mono text-[10.5px] normal-case leading-relaxed tracking-normal text-ink-dim opacity-0 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.9)] transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {children}
      </span>
    </span>
  )
}

// A fee dial: big live value, a spectral-fill range slider spanning the
// protocol's actual min → max, and endpoint labels. Value flows in/out as the
// same STRING state the free-typed inputs used, so validation is untouched.
function FeeSlider({
  id,
  label,
  tip,
  value,
  onChange,
  min,
  max,
  step,
  format,
  minLabel,
  maxLabel,
  defaultValue,
}: {
  id: string
  label: string
  tip: ReactNode
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  format: (v: number) => string
  minLabel: string
  maxLabel: string
  /** When set, the readout wears a "default" chip while the value sits on it. */
  defaultValue?: number
}) {
  const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
  // Visual floor: at the minimum the track kept 0% fill and read as an EMPTY
  // bar (owner 13:46 — "1% is the default" must be visible); the thumb always
  // sits on a lit baseline now.
  const fill = Math.max(6, max === min ? 0 : ((clamped - min) / (max - min)) * 100)
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="flex items-center gap-2 font-mono text-[13px] uppercase tracking-[0.15em] text-ink-dim">
          {label}
          <InfoTip>{tip}</InfoTip>
        </label>
        <span className="flex items-baseline gap-2">
          {defaultValue != null && clamped === defaultValue && (
            <span className="rounded-full border border-teal/30 bg-teal/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-teal">
              default
            </span>
          )}
          <span className="font-num text-2xl font-light tabular-nums text-ink">{format(clamped)}</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
        className="fee-slider mt-3"
        style={{ '--fill': `${fill}%` } as CSSProperties}
      />
      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  )
}

// One stage of the launch flow. Renders nothing until `show` flips true, then fades
// up into place. NO step scrolls on reveal: steps also reveal from DATA (the
// version-mode prefill, a draft restore), and scrolling there threw the user to
// the bottom of a page they meant to edit from the top (owner 2026-07-07 13:2x).
// The one deliberate scroll lives on the "Confirm basket" CLICK handler.
function Step({
  index,
  title,
  subtitle,
  show,
  complete,
  children,
}: {
  index: number
  title: string
  subtitle?: string
  show: boolean
  complete?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (!show) {
      setEntered(false)
      return
    }
    const t0 = window.setTimeout(() => setEntered(true), 30)
    return () => {
      window.clearTimeout(t0)
    }
  }, [show, index])

  if (!show) return null
  return (
    <section
      ref={ref}
      id={`step-${index}`}
      aria-labelledby={`step-${index}-title`}
      // Every card's backdrop-blur creates a stacking context, so later siblings
      // paint OVER an earlier card's overflow. Step 1 gets an explicit raise so
      // the asset-search dropdown floats above the weights card, not under it.
      className={`scroll-mt-24 rounded-2xl card-surface p-5 backdrop-blur-md sm:p-6 ${index === 1 ? 'relative z-20' : ''}`}
      style={{
        opacity: entered ? 1 : 0,
        transform: entered ? 'none' : 'translateY(18px)',
        transition: 'opacity 0.5s ease, transform 0.55s cubic-bezier(0.34,1.2,0.64,1)',
      }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full font-num text-sm font-bold tabular-nums"
          style={
            complete
              ? { background: 'rgba(52,214,196,0.16)', color: 'var(--color-teal)', boxShadow: 'inset 0 0 0 1px rgba(52,214,196,0.45)' }
              : { background: 'rgba(255,255,255,0.06)', color: 'var(--color-ink)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }
          }
        >
          {complete ? '✓' : index}
        </span>
        <div className="min-w-0">
          <h2 id={`step-${index}-title`} className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
            <span className="sr-only">{`Step ${index}: `}</span>
            {title}
            {complete && <span className="sr-only"> (complete)</span>}
          </h2>
          {subtitle && <div className="mt-1 font-mono text-[15px] leading-snug text-ink-dim">{subtitle}</div>}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

interface StepState {
  n: number
  label: string
  done: boolean
}

// Progress rail across the 6 stages: an overview + a keyboard-accessible
// jump-to-step. Revealed steps are links; upcoming ones are inert.
function Stepper({ steps, maxStep, current }: { steps: StepState[]; maxStep: number; current: number }) {
  return (
    <nav aria-label="Launch progress" className="rounded-2xl card-surface px-3 py-2.5 backdrop-blur-md sm:px-4">
      <ol className="flex items-center">
        {steps.map((s, i) => {
          const revealed = s.n <= maxStep
          const isCurrent = s.n === current
          const node = (
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full font-num text-xs font-bold tabular-nums transition-colors"
                style={
                  s.done
                    ? { background: 'rgba(52,214,196,0.16)', color: 'var(--color-teal)', boxShadow: 'inset 0 0 0 1px rgba(52,214,196,0.45)' }
                    : isCurrent
                      ? { background: 'rgba(53,224,255,0.14)', color: 'var(--color-cyan)', boxShadow: 'inset 0 0 0 1px rgba(53,224,255,0.5)' }
                      : { background: 'rgba(255,255,255,0.05)', color: revealed ? 'var(--color-ink-dim)' : 'var(--color-ink-faint)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)' }
                }
              >
                {s.done ? '✓' : s.n}
              </span>
              <span
                className={`hidden font-mono text-[11px] uppercase tracking-[0.15em] sm:inline ${
                  isCurrent ? 'text-ink' : revealed ? 'text-ink-dim' : 'text-ink-faint'
                }`}
              >
                {s.label}
              </span>
            </span>
          )
          const srText = `Step ${s.n}: ${s.label}${s.done ? ', complete' : isCurrent ? ', current' : !revealed ? ', upcoming' : ''}. `
          return (
            <li key={s.n} className="flex flex-1 items-center last:flex-none">
              {revealed ? (
                <a
                  href={`#step-${s.n}`}
                  aria-current={isCurrent ? 'step' : undefined}
                  className="rounded-full transition-[opacity,scale] duration-150 hover:opacity-80 active:scale-[0.96]"
                >
                  <span className="sr-only">{srText}</span>
                  {node}
                </a>
              ) : (
                <span>
                  <span className="sr-only">{srText}</span>
                  {node}
                </span>
              )}
              {i < steps.length - 1 && <span aria-hidden className="mx-2 h-px flex-1 bg-white/10 sm:mx-3" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// ── fee-config model ──────────────────────────────────────────────────────────
// The creator picks exactly two things: the total fee rate (1–3%), and how much
// of the post-burn-interface-launcher remainder THEY take (0–30%, DEFAULT = the
// 30% cap, dialable down to 0). Holders automatically get the rest of that
// remainder (≥70% — the cap is the floor). The burn / interface / launcher slices are FIXED protocol
// constants (fee-model.ts), and the launcher recipient is operator-injected at
// deploy (LAUNCHER_ADDRESS) — NEVER a creator dial. There is no routing table.

/** Whole-% creator-take string ("0".."30") → bps, clamped to the on-chain cap. */
function creatorShareBpsOf(pctStr: string, maxBps: number): number {
  const v = parseFloat(pctStr)
  if (!isFinite(v) || v <= 0) return 0
  return Math.min(Math.round(v * 100), maxBps)
}

// ── draft autosave ────────────────────────────────────────────────────────────
// Persist the in-progress basket per chain so a refresh / accidental nav doesn't
// wipe it. (The legal acknowledgment is intentionally NOT persisted — re-checked
// each session.)
interface BuilderDraft {
  assets: BuilderAsset[]
  weights: number[]
  name: string
  symbol: string
  /** Legacy (pre-ENS-identity) drafts may carry these; ignored on restore. */
  xHandle?: string
  creatorName?: string
  /** Legacy (pre-cut) drafts may carry these; ignored on restore. */
  avatarUrl?: string
  bannerUrl?: string
  feePct: string
  creatorSharePct: string
  creatorPayout: string
  /** The deliberate "Continue" click at the end of the weights step. */
  weightsConfirmed?: boolean
  basketConfirmed: boolean
  maxStep: number
}
const DRAFT_PREFIX = 'spectrum:launch-draft:v2:'
// Version-mode drafts are scoped to the predecessor so a "new version of X" draft
// never clobbers a from-scratch draft (and vice-versa).
const draftKey = (chainId: number, predecessor?: string) =>
  `${DRAFT_PREFIX}${chainId}${predecessor ? ':from:' + predecessor.toLowerCase() : ''}`
const draftIsEmpty = (d: BuilderDraft) => d.assets.length === 0 && !d.name.trim() && !d.symbol.trim()
function loadDraft(chainId: number, predecessor?: string): BuilderDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(chainId, predecessor))
    if (!raw) return null
    const d = JSON.parse(raw)
    return d && Array.isArray(d.assets) && Array.isArray(d.weights) ? (d as BuilderDraft) : null
  } catch {
    return null
  }
}
/** One-click handoff from the Composer (owner+R 2026-07-07 17:19): writes a
 *  from-scratch draft the builder restores on /launch — composition + name +
 *  ticker prefilled, fee/share left to self-heal to their defaults, the flow
 *  opened at the name step. The MONEY PATH stays single: the composer never
 *  deploys, it seeds THIS draft. */
export function seedLaunchDraft(
  chainId: number,
  seed: { assets: BuilderAsset[]; weights: number[]; name?: string; symbol?: string },
): void {
  const d: BuilderDraft = {
    assets: seed.assets,
    weights: seed.weights,
    name: seed.name ?? '',
    symbol: seed.symbol ?? '',
    feePct: '',
    creatorSharePct: '',
    creatorPayout: '',
    weightsConfirmed: true,
    basketConfirmed: true,
    maxStep: 6,
  }
  try {
    localStorage.setItem(draftKey(chainId), JSON.stringify(d))
  } catch {
    /* storage unavailable — the composer's Launch button still navigates */
  }
}

function saveDraft(chainId: number, d: BuilderDraft, predecessor?: string) {
  try {
    localStorage.setItem(draftKey(chainId, predecessor), JSON.stringify(d))
  } catch {
    /* storage full / unavailable — drafting is best-effort */
  }
}
function clearDraft(chainId: number, predecessor?: string) {
  try {
    localStorage.removeItem(draftKey(chainId, predecessor))
  } catch {
    /* ignore */
  }
}

export function BasketBuilder({
  predecessor,
  predecessorChainId,
}: { predecessor?: string; predecessorChainId?: number } = {}) {
  const activeChainId = useActiveChainId()
  // Version mode PINS the builder to the predecessor's chain: a new version
  // deploys where its predecessor lives, and its legs must re-resolve against
  // THAT chain's venues. (Bug 2026-07-07 ~12:4x: with the site's active chain
  // on Base, an Ethereum basket's "New version" probed every leg on Base →
  // NO_POOL → all legs dropped → the builder opened empty of assets/weights
  // while name/fees — read on the predecessor's chain — prefilled fine.)
  const chainId = predecessorChainId ?? activeChainId
  const cfg = useMemo(() => chainCfg(chainId), [chainId])
  const { address: account } = useAccount()
  // Creator identity is the wallet itself: the ENS name reverse-linked to the
  // deploy address (mainnet registry), else the address. No self-typed handles
  // or display names (owner call — see the social-layer plan).
  const { data: ensName } = useEnsName({ address: account, chainId: 1 })
  // Version mode: read the predecessor basket to prefill from (constituents,
  // weights, fee config + the creator's signed profile text).
  const predChainId = predecessorChainId ?? chainId
  const { data: predData } = useBasketData(predecessor, predChainId)
  const { data: predFees } = useBasketFees(predecessor, predChainId)
  const predMeta = useCreatorMeta(predecessor, predChainId)
  const [prefillDone, setPrefillDone] = useState(false)

  const [assets, setAssets] = useState<BuilderAsset[]>([])
  const [weights, setWeights] = useState<number[]>([])
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [adding, setAdding] = useState(false)
  const [minting, setMinting] = useState<{ address: string; symbol?: string; status: MintStatus } | null>(null)
  const [recheck, setRecheck] = useState<Record<string, 'checking' | 'better' | 'none' | 'set'>>({})
  // Per-asset "this looks like the other network's address" note (lowercased addr → line).
  const [wrongNet, setWrongNet] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  // ── fee config (immutable at deploy) ──
  // The creator picks ONLY the fee rate + their own share of the remainder. The
  // burn / interface / launcher slices are fixed protocol constants (fee-model.ts);
  // the launcher recipient is operator-injected (LAUNCHER_ADDRESS), never shown here.
  const { data: bounds } = useFeeBounds(chainId)
  // Default = exactly 1% (owner told R "I'm gonna default this to 1%"),
  // clamped into the protocol bounds if an operator narrows them.
  const midFeePct = (Math.min(Math.max(100, bounds.minFeeBps), bounds.maxFeeBps) / 100).toFixed(2)
  const maxSharePct = String(bounds.maxCreatorShareBps / 100)
  // Defaults are CONCRETE from the first render — the fee step is valid without
  // touching a slider (owner call 2026-07-06: "most will leave it default"). The
  // midpoint fee is "a default suggestion, clearly your choice"; the share
  // defaults to the cap (the creator can dial it down to 0).
  const [feePct, setFeePct] = useState(midFeePct)
  const [creatorSharePct, setCreatorSharePct] = useState(maxSharePct)
  const [creatorPayout, setCreatorPayout] = useState('')
  // The thesis is collected ONCE, in the post-deploy publish ceremony — not
  // here (owner 2026-07-07 12:11 reversed the 12:08 name-step collection after
  // hitting the duplicate entry live: deploy first, then write + sign).
  // Self-healing: ANY route back to an empty fee (draft restore, chain switch)
  // re-fills the default — validity never depends on a slider being touched.
  useEffect(() => {
    if (!feePct) setFeePct(midFeePct)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, feePct])

  const feeBps = useMemo(() => {
    const v = parseFloat(feePct)
    return isFinite(v) && v > 0 ? Math.round(v * 100) : null
  }, [feePct])

  const feeInBounds =
    feeBps != null && feeBps >= bounds.minFeeBps && feeBps <= bounds.maxFeeBps

  const creatorShareBps = useMemo(
    () => creatorShareBpsOf(creatorSharePct, bounds.maxCreatorShareBps),
    [creatorSharePct, bounds.maxCreatorShareBps],
  )
  // Default the payout to the connected wallet once, so the default 30% share
  // is deploy-valid with zero interaction ("Use my address" made explicit).
  useEffect(() => {
    if (account && !creatorPayout) setCreatorPayout(account)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])
  const payoutValid = isAddress(creatorPayout.trim(), { strict: false })
  // A non-zero take must name a valid payout; a zero take needs no address.
  const creatorTakeValid = creatorShareBps === 0 || payoutValid
  const feeValid = feeInBounds && creatorTakeValid

  // Referral (owner 2026-07-07): if this creator arrived via a ?ref link, that
  // referrer becomes the basket's LAUNCHER — they earn the fixed launcher slice
  // (~5% of fees) on this basket forever. It's IMMUTABLE at deploy and comes out
  // of the same remainder the creator+holders share, so it's disclosed in the
  // Deploy step with a Remove. Falls back to the operator's LAUNCHER_ADDRESS.
  //
  // The credit is FIRST-BASKET-ONLY (owner 2026-07-07): applied only when the
  // wallet has no existing baskets on-chain AND the one-shot creatorUsed flag is
  // clear. Once they've launched, later deploys revert to the operator launcher.
  const { data: allBaskets } = useAllBaskets()
  const [referrer] = useState<Address | null>(() => getStoredRef())
  // First-basket gate — default NOT-first until allBaskets has actually LOADED
  // (audit 2026-07-07: the old `?? []` made a loading state look like "no baskets =
  // first basket", which could over-credit the referrer on an already-deployed
  // wallet that deploys before the read resolves).
  const isFirstBasket = !!account && !!allBaskets && !allBaskets.some((b) => b.deployer?.toLowerCase() === account.toLowerCase())
  // ...and never credit a SELF-referrer (opened their own share link) as their own
  // launcher — that just diverts the launcher slice from the operator to themselves.
  const applyReferrerLauncher =
    !!referrer && isFirstBasket && !hasCreatorRefBeenUsed() && referrer.toLowerCase() !== account?.toLowerCase()
  const launcher = ((applyReferrerLauncher ? referrer : LAUNCHER_ADDRESS) ?? ZERO_ADDR) as Address

  // Live waterfall the creator sees as they choose — assume a tagging interface
  // (the common case) so their/holders' shown shares are the FLOOR; the launcher
  // reflects this build's launcher (referrer if referred, else operator config).
  const builderSplit = useMemo(
    () => feeSplit(creatorShareBps, { hasInterface: true, hasLauncher: launcher !== ZERO_ADDR }),
    [creatorShareBps, launcher],
  )

  const feeConfig: FeeConfigInput | null = useMemo(() => {
    if (!feeValid || feeBps == null) return null
    return {
      basketFeeBps: feeBps,
      creatorShareBps,
      creatorPayout: (creatorShareBps > 0 ? getAddress(creatorPayout.trim()) : ZERO_ADDR) as Address,
      // Referrer (if referred) else operator-injected origination recipient.
      launcher,
    }
  }, [feeValid, feeBps, creatorShareBps, creatorPayout, launcher])

  // Live preview of who the basket will be attributed to (ENS, else address).
  const creatorPreview = useMemo(
    () => resolveCreator({ handle: null, name: ensName ?? null, deployer: account ?? null }),
    [ensName, account],
  )
  const [deploying, setDeploying] = useState(false)
  const deploy = useDeployBasket(chainId)
  // Post-deploy publish ceremony: once the basket is live, the creator signs their
  // profile / version-link blob in their own wallet and it persists down the ladder
  // (localStorage · operator relay · download).
  const publisher = usePublish(chainId)
  // The identity + lineage half of the blob (fixed by the deploy): the wallet's ENS
  // name (never self-typed) and, in version mode, `supersedes = predecessor`. ALL
  // thesis fields (title, body, tags, launch post) are collected in the post-deploy
  // ceremony itself and merged in at sign time — the launch page never asks.
  const publishBase: CreatorMetadataInput = useMemo(
    () => ({
      handle: null,
      name: ensName ?? null, // the wallet's ENS name, never self-typed
      // No creator-hosted media: avatar/banner URLs were messy third-party
      // data to carry in signed blobs (owner call) — visuals are generated.
      avatarUrl: null,
      bannerUrl: null,
      tagline: null,
      thesis: null,
      sectors: [],
      postUrl: null,
      supersedes: predecessor ?? null,
    }),
    [ensName, predecessor],
  )
  // The ceremony is offered whenever a basket is live and a wallet can sign it —
  // every creator can now write a thesis, so there is always something to publish.
  // It stays skippable (Skip → honest wallet-identity attribution).
  // Post-deploy thesis/publish ceremony REMOVED from the deploy flow (owner 2026-07-09,
  // live E2E: "there shouldn't be a create and publish thesis… it's just simply you skip
  // to seed the basket"). enabled:false → DeployPortal navigates straight through to the
  // seed prompt on success. The ceremony code + usePublish stay in the tree (metadata
  // RENDERING of already-signed theses is untouched); re-enable by restoring this flag.
  const publishEnabled = false
  const queryClient = useQueryClient()
  // Silent lineage-only signature (owner 2026-07-09 ~16:25, adopted REC). Removing
  // the ceremony above also removed the ONLY vehicle that signed `supersedes`, so a
  // version deploy listed as an unrelated basket. Now the moment a VERSION deploy
  // succeeds we request exactly one wallet signature over a supersedes-only blob —
  // no thesis prose, no ceremony UI, publishEnabled stays false. A rejected prompt
  // is recoverable ("Link previous version" on the basket page). The invalidate
  // re-runs discovery's tagLineage so the pair collapses into one lineage at once.
  useEffect(() => {
    if (!predecessor || !account) return
    if (!(deploying && deploy.status === 'success' && deploy.token)) return
    if (publisher.state.status !== 'idle') return
    void publisher
      .publish({
        input: {
          handle: null,
          name: null,
          avatarUrl: null,
          bannerUrl: null,
          tagline: null,
          thesis: null,
          sectors: [],
          postUrl: null,
          supersedes: predecessor,
        },
        basket: deploy.token,
        signer: account,
      })
      .then(() => void queryClient.invalidateQueries())
  }, [account, deploy.status, deploy.token, deploying, predecessor, publisher, queryClient])
  // Open the ceremony + kick off the read-only prepare (mine + price + simulate).
  // The on-chain broadcast stays behind the DEPLOY_ENABLED feature flag inside the hook.
  const startDeploy = useCallback(() => {
    if (!feeConfig) return
    // First-basket-only: once this referred wallet deploys with the referrer as
    // launcher, consume the credit so later baskets revert to the operator (the
    // on-chain "has baskets" check also closes it, this handles the same-session race).
    if (applyReferrerLauncher) markCreatorRefUsed()
    setDeploying(true)
    void deploy.prepare({
      name,
      symbol,
      assets: assets.map((a) => ({ address: a.address, decimals: a.decimals, route: a.route })),
      weights,
      feeConfig,
    })
  }, [deploy, name, symbol, assets, weights, feeConfig, applyReferrerLauncher])
  const [basketConfirmed, setBasketConfirmed] = useState(false)
  // The deliberate "Continue" click that ends the weights step and reveals the
  // fee structure + everything below (owner call: break the flow up).
  const [weightsConfirmed, setWeightsConfirmed] = useState(false)
  // Deployer self-attestation that gates the launch CTA (placeholder legal copy in the Deploy step).
  const [acknowledged, setAcknowledged] = useState(false)
  const [maxStep, setMaxStep] = useState(1)
  const [restored, setRestored] = useState(false)
  const hydrating = useRef(false)

  // On mount + chain switch, restore that chain's saved draft (or reset to empty).
  useEffect(() => {
    hydrating.current = true
    const d0 = loadDraft(chainId, predecessor)
    // A version-mode draft with NO assets is not a draft — it's the artifact of
    // a half-failed prefill (name/fees landed, legs didn't) that then autosaved.
    // Restoring it would set prefillDone and wedge the version flow FOREVER
    // (2026-07-07 13:1x: exactly this poisoned the owner's browser). Discard it
    // and let the prefill run; a deliberate all-assets-deleted state is not
    // worth preserving on a page whose whole point is "start from v(n-1)".
    const d = d0 && predecessor && d0.assets.length === 0 ? null : d0
    if (!d && d0) clearDraft(chainId, predecessor)
    setError(null)
    setDeploying(false)
    setAcknowledged(false)
    if (d) {
      setAssets(d.assets)
      setWeights(d.weights)
      setName(d.name)
      setSymbol(d.symbol)
      setFeePct(d.feePct && parseFloat(d.feePct) > 0 ? d.feePct : midFeePct)
      // Same self-heal as the fee: a zero/empty share in a saved draft re-fills
      // the 30% default (owner 2026-07-07: "always 30% default, slide it down if
      // you want" — a stale draft's zero kept resurrecting as the deploy value).
      // A deliberate 0 is a THIS-SESSION choice, re-made where the review shows it.
      setCreatorSharePct(
        d.creatorSharePct && parseFloat(d.creatorSharePct) > 0 ? d.creatorSharePct : maxSharePct,
      )
      setCreatorPayout(d.creatorPayout ?? '')
      setWeightsConfirmed(d.weightsConfirmed ?? d.maxStep >= 3) // old drafts already saw the fee step
      setBasketConfirmed(d.basketConfirmed)
      setMaxStep(d.maxStep)
      setRestored(true)
      setPrefillDone(true)
    } else {
      setAssets([])
      setWeights([])
      setName('')
      setSymbol('')
      setFeePct(midFeePct)
      setCreatorSharePct(maxSharePct)
      setCreatorPayout('')
      setWeightsConfirmed(false)
      setBasketConfirmed(false)
      setMaxStep(1)
      setRestored(false)
      setPrefillDone(!predecessor)
    }
  }, [chainId, predecessor])

  // Version mode: once the predecessor's on-chain data resolves, prefill the
  // builder from it — re-resolving each constituent against CURRENT pools (a
  // since-dead pool is dropped, not silently kept). The new version is a
  // separate immutable deploy; its link to the predecessor is a deployer-signed
  // `supersedes` claim published with the creator metadata — there is NO on-chain
  // version pointer.
  useEffect(() => {
    // Gate ONLY on the constituent data; wait for the fee query to SETTLE
    // (undefined = in flight) but never for it to SUCCEED — a null fee read is
    // best-effort seasoning and must not block the assets/weights prefill (it
    // once wedged the whole version flow). The old predMeta.isLoading wait was
    // vestigial: the thesis no longer prefills here (post-deploy popup only).
    if (prefillDone || !predecessor || !predData || predFees === undefined) return
    let cancelled = false
    // Detection availability = the V4 baseline (poolManager); isPoolReady stays
    // the engine's stricter V2/V3-infra check.
    const poolReady = !!cfg.poolManager
    void (async () => {
      try {
        const resolved = await Promise.all(
          predData.holdings.map(async (h) => {
            try {
              return await resolveAsset(h.asset, chainId, h.symbol)
            } catch {
              // No live pool for this leg. If the chain HAS pool infra configured,
              // the pool is genuinely gone → drop it (a since-dead pool is never
              // silently kept). If pool detection is unavailable (no factory/pool
              // config — e.g. a preview / not-yet-deployed build), carry the
              // predecessor's leg over as-is so the version still prefills; it is
              // marked 'unverified' and its routing must be re-checked before deploy.
              if (poolReady) return null
              try {
                return {
                  address: getAddress(h.asset),
                  symbol: h.symbol,
                  decimals: h.decimals,
                  venueLabel: 'unverified',
                  depthUsd: null,
                  warnings: ['Routing not re-checked on this build, verify before deploy.'],
                  route: { venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: ZERO_ADDR as Address },
                } as BuilderAsset
              } catch {
                return null
              }
            }
          }),
        )
        if (cancelled) return
        const ok = resolved.filter((a): a is BuilderAsset => a !== null)
        if (ok.length >= 2) {
          const wByAddr = new Map(predData.holdings.map((h) => [h.asset.toLowerCase(), h.targetWeightPct]))
          const w = ok.map((a) => Math.max(MIN, Math.round(wByAddr.get(a.address.toLowerCase()) ?? 0)))
          const total = w.reduce((s, x) => s + x, 0)
          if (total !== CAP && w.length > 0) {
            let mi = 0
            for (let i = 1; i < w.length; i++) if (w[i] > w[mi]) mi = i
            w[mi] = Math.max(MIN, w[mi] + (CAP - total))
          }
          setAssets(ok)
          setWeights(w)
          setWeightsConfirmed(true)
          setBasketConfirmed(isValid(w))
          setMaxStep(6)
          setName(predData.name)
          // Ticker arrives pre-incremented (BLUE→BLUEV2, TBV2→TBV3) — same
          // ticker is VALID but reads ambiguous on wallets/aggregators once two
          // versions are live (owner 13:38). A nudge: freely editable below.
          setSymbol(bumpVersionTicker(predData.symbol))
          if (predFees) {
            setFeePct((predFees.basketFeeBps / 100).toFixed(2))
            setCreatorSharePct((predFees.creatorShareBps / 100).toString())
            setCreatorPayout(predFees.creatorPayout ?? '')
          }
          // (identity is the wallet's ENS/address now — nothing to carry forward)
        } else if (predData.holdings.length >= 2) {
          // Legs failed to re-resolve: say so and write NOTHING ELSE — a partial
          // prefill (name/fees without assets) autosaves as a poisoned draft that
          // wedges every future visit (2026-07-07 13:1x). Virgin state + the
          // error = the next load retries cleanly.
          setError(
            'Couldn’t re-resolve the predecessor’s constituents against live pools — reload to retry.',
          )
        }
      } finally {
        if (!cancelled) setPrefillDone(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillDone, predecessor, predData, predFees, predMeta.isLoading, chainId])

  // Persist the draft as it changes (skip the render that just hydrated it).
  useEffect(() => {
    if (hydrating.current) {
      hydrating.current = false
      return
    }
    const d: BuilderDraft = {
      assets,
      weights,
      name,
      symbol,
      feePct,
      creatorSharePct,
      creatorPayout,
      weightsConfirmed,
      basketConfirmed,
      maxStep,
    }
    if (draftIsEmpty(d)) clearDraft(chainId, predecessor)
    else saveDraft(chainId, d, predecessor)
  }, [assets, weights, name, symbol, feePct, creatorSharePct, creatorPayout, weightsConfirmed, basketConfirmed, maxStep, chainId, predecessor])

  // Once the basket actually deploys, drop the saved draft.
  useEffect(() => {
    if (deploy.status === 'success') clearDraft(chainId, predecessor)
  }, [deploy.status, chainId, predecessor])

  // Discard the draft + reset the builder to a blank slate.
  const startFresh = useCallback(() => {
    clearDraft(chainId, predecessor)
    setAssets([])
    setWeights([])
    setName('')
    setSymbol('')
    setFeePct('')
    setCreatorSharePct('0')
    setCreatorPayout('')
    setWeightsConfirmed(false)
    setBasketConfirmed(false)
    setAcknowledged(false)
    setMaxStep(1)
    setError(null)
    setRestored(false)
    setPrefillDone(true)
  }, [chainId, predecessor])

  const inBasket = useCallback(
    (addr: string) => assets.some((a) => a.address.toLowerCase() === addr.toLowerCase()),
    [assets],
  )

  const add = useCallback(
    async (addr: string, knownSymbol?: string) => {
      setError(null)
      const raw = addr.trim()
      if (!isAddress(raw)) {
        setError('Enter a valid token contract address (0x…).')
        return
      }
      if (inBasket(raw)) {
        setError('That asset is already in the basket.')
        return
      }
      if (assets.length >= MAX_ASSETS) {
        setError(`A basket holds up to ${MAX_ASSETS} assets.`)
        return
      }
      setAdding(true)
      setMinting({ address: raw, symbol: knownSymbol, status: 'forming' })
      try {
        if (await isPoolToken(raw, chainId)) {
          setMinting(null)
          setError('That address is a liquidity-pool token (e.g. an Aerodrome LP), not the asset itself, paste the underlying token\u2019s contract address instead.')
          setAdding(false)
          return
        }
        const a = await resolveAsset(raw, chainId, knownSymbol)
        // Thin here? Ask the other scaffolded chain before the row lands (finding #6).
        const note =
          a.depthUsd == null || a.depthUsd < VERY_LOW_LIQ_USD
            ? await wrongNetworkNote(raw, chainId, a.depthUsd).catch(() => null)
            : null
        setWrongNet((m) => {
          const k = raw.toLowerCase()
          if (note) return { ...m, [k]: note }
          if (!(k in m)) return m
          const rest = { ...m }
          delete rest[k]
          return rest
        })
        setAssets((prev) => [...prev, a])
        setWeights((prev) => (prev.length === 0 ? [CAP] : addAsset(prev)))
        setMinting({ address: raw, symbol: a.symbol, status: 'added' })
      } catch (e) {
        setMinting(null)
        if (e instanceof PoolDetectionError) {
          // No pool at all on this chain — if the same address is deep on the other
          // chain, say so in the same breath (the classic wrong-network paste).
          const note = await wrongNetworkNote(raw, chainId, null).catch(() => null)
          setError(note ? `${e.message} ${note}` : e.message)
        } else setError('Could not validate this asset, check the address and the selected network.')
      } finally {
        setAdding(false)
      }
    },
    [assets.length, chainId, inBasket],
  )

  const remove = useCallback((i: number) => {
    setAssets((prev) => prev.filter((_, k) => k !== i))
    setWeights((prev) => removeAsset(prev, i))
  }, [])

  const bump = useCallback((i: number, delta: number) => setWeights((prev) => adjustWeight(prev, i, delta)), [])
  const setW = useCallback((i: number, v: number) => setWeights((prev) => setWeight(prev, i, v)), [])
  const equalize = useCallback(() => setWeights((prev) => equalSplit(prev.length)), [])

  // Re-run pool detection for one asset; if a deeper routing pool turns up, swap to it.
  const recheckPool = useCallback(
    async (i: number) => {
      const a = assets[i]
      if (!a) return
      const key = a.address.toLowerCase()
      setRecheck((m) => ({ ...m, [key]: 'checking' }))
      try {
        const fresh = await findBestPool(a.address as Address, chainId)
        const prev = a.depthUsd ?? 0
        const next = fresh.best.depthUsd ?? 0
        const better = next > prev * 1.02
        if (better) {
          setAssets((prevAssets) =>
            prevAssets.map((x, k) =>
              k === i
                ? {
                    ...x,
                    decimals: fresh.decimals,
                    venueLabel: fresh.best.label,
                    depthUsd: fresh.best.depthUsd,
                    warnings: fresh.warnings,
                    route: fresh.route,
                  }
                : x,
            ),
          )
        }
        setRecheck((m) => ({ ...m, [key]: better ? 'better' : 'none' }))
      } catch {
        setRecheck((m) => ({ ...m, [key]: 'none' }))
      }
    },
    [assets, chainId],
  )

  // Suggestions: real constituents of live baskets on this chain, most-used first
  // (usage frequency is a mechanical fact, not curation). `allBaskets` is read
  // once, higher up (for the first-basket launcher gate).
  const suggestions = useMemo(() => {
    const freq = new Map<string, { address: string; symbol: string; n: number }>()
    const usdc = cfg.usdc?.toLowerCase()
    const weth = cfg.weth?.toLowerCase()
    for (const ix of allBaskets ?? []) {
      if (ix.chainId !== chainId) continue
      for (const t of ix.top) {
        const k = t.address.toLowerCase()
        if (k === usdc || k === weth || !t.symbol || t.symbol === '?') continue
        const cur = freq.get(k)
        if (cur) cur.n += 1
        else freq.set(k, { address: t.address, symbol: t.symbol, n: 1 })
      }
    }
    return [...freq.values()].sort((a, b) => b.n - a.n)
  }, [allBaskets, chainId, cfg])

  // Derived views
  const total = sum(weights)
  // Upgrade unknown tokens' hash colors to their logo's dominant color as the
  // extractions land (weight rows, preview bar and bento all read tokenVisual).
  useTokenColors(assets, chainId)
  const bentoItems: BentoItem[] = assets.map((a, i) => ({ symbol: a.symbol, address: a.address, weightPct: weights[i] ?? 0, chainId }))

  // Prismatic blend from the basket's brand colors (avatar + ambient glow).
  const blend = useMemo(() => assets.map((a) => tokenVisual(a.symbol, a.address).color), [assets])
  const avatarGrad =
    blend.length >= 2 ? `linear-gradient(135deg, ${blend.join(', ')})` : blend.length === 1 ? `linear-gradient(135deg, ${blend[0]}, ${blend[0]})` : DEFAULT_GRAD
  const glowGrad = blend.length === 0 ? null : `linear-gradient(115deg, ${(blend.length === 1 ? [blend[0], blend[0]] : blend).join(', ')})`

  const weightsValid = isValid(weights)
  const symbolValid = /^[A-Z0-9]{2,11}$/.test(symbol)
  const nameValid = name.trim().length >= 2
  const enoughAssets = assets.length >= 2
  const canDeploy = weightsValid && symbolValid && nameValid && enoughAssets && feeValid
  // Live Dutch-auction deploy cost — only polled once the basket is deployable.
  const { data: deployPrice } = useDeployPrice(chainId, canDeploy)
  const deployCostEth = deployPrice?.priceWei != null ? Number(deployPrice.priceWei) / 1e18 : null
  // The deploy button STOPS when the wallet can't pay (owner 2026-07-07 13:4x —
  // an underfunded deploy previously got all the way into the ceremony before
  // failing). Balance re-polls so a top-up arms the button without a reload;
  // headroom mirrors the prepare()-preflight (~5.5M-gas deploy).
  const { data: walletBal } = useBalance({
    address: account,
    chainId,
    query: { enabled: canDeploy && !!account, refetchInterval: 15_000 },
  })
  const GAS_HEADROOM_WEI = 10_000_000_000_000_000n
  const insufficientEth =
    walletBal != null && deployPrice?.priceWei != null && walletBal.value < deployPrice.priceWei + GAS_HEADROOM_WEI
  // The launch CTA also requires the deployer acknowledgment (Deploy-step checkbox).
  const readyToDeploy = canDeploy && acknowledged && !insufficientEth

  // Naming guidance, not enforcement: the protocol does not censor names; names
  // implying a regulated product are the deployer's own legal risk.
  const nameRiskHint = /\b(fund|etf|index)\b/i.test(`${name} ${symbol}`)

  // Progressive reveal: the highest stage the basket has earned (monotonic).
  const level =
    basketConfirmed && nameValid && symbolValid
      ? 6
      : basketConfirmed
        ? 5
        : weightsConfirmed && enoughAssets && weightsValid && feeValid
          ? 4
          : weightsConfirmed && enoughAssets
            ? 3
            : assets.length >= 1
              ? 2
              : 1
  useEffect(() => {
    setMaxStep((m) => Math.max(m, level))
  }, [level])

  const stepState: StepState[] = [
    { n: 1, label: 'Assets', done: enoughAssets },
    { n: 2, label: 'Weights', done: enoughAssets && weightsValid },
    { n: 3, label: 'Fees', done: feeValid },
    { n: 4, label: 'Review', done: basketConfirmed },
    { n: 5, label: 'Name', done: nameValid && symbolValid },
    { n: 6, label: 'Deploy', done: readyToDeploy },
  ]
  const currentStep = stepState.find((s) => s.n <= maxStep && !s.done)?.n ?? Math.min(maxStep, 6)

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-6">
        <Stepper steps={stepState} maxStep={maxStep} current={currentStep} />

        {predecessor && (
          <div className="rounded-xl border border-white/12 bg-white/[0.03] px-4 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--color-violet-bright)' }}>
              ↻ New version{predData?.symbol ? ` of $${predData.symbol}` : ''}
            </div>
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-dim">
              Constituents, weights and fee config are prefilled below, edit anything, then deploy a new
              immutable basket. The original stays live and unchanged; this version links back to it
              through your signed creator profile, not an on-chain pointer.
            </p>
          </div>
        )}

        {restored && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-cyan/30 bg-cyan/[0.06] px-4 py-2.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan">
              ↻ Picked up your saved draft
            </span>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={startFresh}
                className="press font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim underline-offset-4 hover:text-ink hover:underline"
              >
                Start fresh
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setRestored(false)}
                className="press grid h-10 w-10 place-items-center text-ink-faint hover:text-ink"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── 1 · Add assets ─────────────────────────────────────────── */}
        <Step
          index={1}
          title="Add assets"
          show
          complete={enoughAssets}
        >
          <AssetSearch
            chainId={chainId}
            busy={adding}
            excludeAddresses={assets.map((a) => a.address)}
            onPick={(addr, sym) => void add(addr, sym)}
          />

          {minting && (
            <MintOrb
              key={minting.address}
              address={minting.address}
              symbol={minting.symbol}
              chainId={chainId}
              status={minting.status}
              onDone={() => setMinting(null)}
            />
          )}

          {error && (
            <p role="alert" className="mt-2.5 font-mono text-sm leading-relaxed text-alert">
              {error}
            </p>
          )}
          <p id="asset-help" className="mt-2.5 font-mono text-sm leading-relaxed text-ink-dim">
            We find the deepest Uniswap v2/v3/v4 pool automatically.
            {chainId === 8453 && <> Aerodrome-only tokens can't be used (no hook support).</>}
          </p>

          <PopularAssets
            chainId={chainId}
            chainName={cfg.name}
            candidates={suggestions}
            excludeAddresses={assets.map((a) => a.address)}
            onPick={(addr, sym) => void add(addr, sym)}
            busy={adding}
          />
        </Step>

        {/* ── 2 · Set weights ────────────────────────────────────────── */}
        <Step
          index={2}
          title="Set weights"
          show={maxStep >= 2}
          complete={enoughAssets && weightsValid}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-wide text-ink-dim">
              {assets.length}/{MAX_ASSETS} assets
            </span>
            <div className="flex items-center gap-2.5">
              {assets.length > 1 && (
                <button
                  type="button"
                  onClick={equalize}
                  className="press rounded-md border border-white/12 px-2.5 py-1 font-mono text-[13px] uppercase tracking-[0.15em] text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  Equal weight
                </button>
              )}
              {/* Running allocation, right where the weights are typed (owner
                  2026-07-07 13:14: "out of 100%, so people know what percentage
                  they're on" — the Σ at the card's foot was below the fold while
                  editing). Live region, teal at exactly 100. */}
              {assets.length > 0 && (
                <span
                  aria-live="polite"
                  className={`rounded-md border px-2.5 py-1 font-num text-[13px] font-semibold tabular-nums ${
                    total === CAP
                      ? 'border-teal/40 bg-teal/10 text-teal'
                      : 'border-alert/40 bg-alert/10 text-alert'
                  }`}
                >
                  {total} / 100%
                </span>
              )}
            </div>
          </div>

          <ul className="space-y-2.5">
            {assets.map((a, i) => {
              const color = tokenVisual(a.symbol, a.address).color
              const w = weights[i] ?? 0
              const tier = liqTier(a.depthUsd, w)
              const rk = recheck[a.address.toLowerCase()]
              const sugg = suggestedWeight(a.depthUsd)
              const showNudge = w > sugg
              const tierColor = tier === 'verylow' ? 'var(--color-alert)' : 'var(--color-amber)'
              const safeguarded = rk === 'set' && !showNudge
              const stripColor = safeguarded ? 'var(--color-teal)' : tierColor
              return (
                <li
                  key={a.address}
                  className="group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border border-white/10 p-3"
                  style={{ background: `linear-gradient(90deg, ${color}1f, ${color}0a 32%, rgba(255,255,255,0.02) 72%)` }}
                >
                  <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
                  <div className="flex items-center gap-3">
                    <AssetLogo
                      address={a.address}
                      symbol={a.symbol}
                      chainId={chainId}
                      size={34}
                      discColor={`color-mix(in srgb, ${color} 55%, #000)`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-display text-sm font-bold uppercase tracking-wide text-ink">{a.symbol}</span>
                        <span className="shrink-0 rounded border border-white/12 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                          {a.venueLabel.replace('Uniswap ', '')}
                        </span>
                        {tier !== 'ok' && (
                          <span
                            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide"
                            style={{ color: tierColor, background: `${tierColor}1f` }}
                          >
                            {tier === 'verylow' ? 'Very low liq' : 'Low liq'}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-ink-dim">
                        {a.depthUsd != null ? `~${formatUsdCompact(a.depthUsd)} liquidity` : shortAddr(a.address)}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center overflow-hidden rounded-xl border border-white/15 bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
                      <button
                        type="button"
                        aria-label={`Decrease ${a.symbol} weight`}
                        onClick={() => bump(i, -STEP)}
                        disabled={w <= MIN}
                        className="press grid h-10 w-10 place-items-center font-num text-lg font-medium leading-none text-ink-dim hover:bg-white/10 hover:text-cyan active:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-ink-dim"
                      >
                        −
                      </button>
                      <WeightInput value={w} onCommit={(v) => setW(i, v)} label={a.symbol} />
                      <button
                        type="button"
                        aria-label={`Increase ${a.symbol} weight`}
                        onClick={() => bump(i, STEP)}
                        className="press grid h-10 w-10 place-items-center font-num text-lg font-medium leading-none text-ink-dim hover:bg-white/10 hover:text-cyan active:bg-white/[0.14]"
                      >
                        +
                      </button>
                    </div>

                    <button
                      type="button"
                      aria-label={`Remove ${a.symbol}`}
                      onClick={() => remove(i)}
                      className="press grid h-10 w-10 shrink-0 place-items-center rounded-lg text-base text-ink-dim hover:bg-white/8 hover:text-alert"
                    >
                      ×
                    </button>
                  </div>

                  {tier !== 'ok' && (
                    <div
                      className="relative flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-2.5 py-2 font-mono text-[11px] leading-relaxed"
                      style={{ borderColor: `${stripColor}40`, background: `${stripColor}12` }}
                    >
                      {safeguarded ? (
                        <span className="text-teal">
                          <span className="font-bold">✓ </span>
                          Whilst large transactions may suffer slippage, this weighting safeguards as best as
                          possible.
                        </span>
                      ) : (
                        <>
                          {!rk && (
                            <span className="text-ink-dim">
                              <span className="font-bold" style={{ color: stripColor }}>
                                ⚠{' '}
                              </span>
                              {tier === 'verylow'
                                ? 'Very thin pool, large basket trades will slip badly here.'
                                : `Over ${HEAVY_WEIGHT_PCT}% of the basket in a thin pool, sizable mints/redeems may slip here.`}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void recheckPool(i)}
                            disabled={rk === 'checking'}
                            className="press rounded-md border border-white/15 px-2 py-1 uppercase tracking-wide text-ink hover:border-cyan/60 hover:text-cyan disabled:opacity-50"
                          >
                            {rk === 'checking' ? 'Rechecking…' : 'Recheck pools'}
                          </button>
                          {rk === 'better' && <span className="text-teal">Found a deeper pool ✓</span>}
                          {rk === 'none' && !showNudge && <span className="text-ink-dim">No deeper pool found.</span>}
                          {showNudge && (rk === 'none' || rk === 'set') && (
                            <>
                              <span className="text-ink-dim">
                                {rk === 'none' ? 'No deeper pool found, ease its weight:' : 'Ease its weight:'}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setW(i, sugg)
                                  setRecheck((m) => ({ ...m, [a.address.toLowerCase()]: 'set' }))
                                }}
                                className="rounded-md px-2 py-1 font-bold uppercase tracking-wide text-black transition-transform hover:scale-[1.03]"
                                style={{ background: tierColor }}
                              >
                                Set {sugg}%
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {wrongNet[a.address.toLowerCase()] && (
                    <div className="relative rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-amber-200/90">
                      <span className="font-bold">⚠ </span>
                      {wrongNet[a.address.toLowerCase()]}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="mt-4 flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint">Your basket</span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              {assets.length > 1 ? 'drag an edge ↔ to reweight' : 'live preview'}
            </span>
          </div>
          <div className="mt-2">
            <WeightStrip
              assets={assets}
              weights={weights}
              min={MIN}
              chainId={chainId}
              onResize={(i, wi, wj) =>
                setWeights((prev) => prev.map((w, k) => (k === i ? wi : k === i + 1 ? wj : w)))
              }
            />
          </div>
          <div aria-hidden className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-white/5">
            {assets.map((a, i) => (
              <div
                key={a.address}
                className="h-full transition-[width] duration-300 ease-out"
                style={{
                  // relative share, like the strip — a Σ drift must not shrink the bar
                  width: `${((weights[i] ?? 0) / (total > 0 ? total : 1)) * 100}%`,
                  background: tokenVisual(a.symbol, a.address).color,
                }}
                title={`${a.symbol} · ${weights[i] ?? 0}%`}
              />
            ))}
          </div>
          <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] uppercase tracking-wide">
            <span className="text-ink-dim">
              Min {MIN}% per asset · type or ±{STEP}%
            </span>
            <span aria-live="polite" className={total === CAP ? 'text-teal' : 'text-alert'}>
              {total === CAP ? '✓ Balanced · 100%' : `Σ ${total}%`}
            </span>
          </div>

          {/* Honest degradation, made prominent: the creator must see this
              BEFORE weighting, depth ranking may be missing whole V4 venues. */}
          {assets.some((a) => a.warnings.some((w) => w.includes('V4 venues were not scanned'))) && (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 font-mono text-[12px] leading-relaxed text-amber-200"
            >
              ⚠ V4 venues were not scanned on this build (no private RPC), the pool depths above may be
              incomplete and a deeper V4 pool may exist for some assets. Weight accordingly, or rebuild
              with an origin-restricted key or your own provider's RPC URL for complete V4 coverage.
            </div>
          )}

          <BasketHealth assets={assets} weights={weights} />

          {/* Deliberate break in the flow: the fee structure (and everything
              after it) reveals only on this click, not reactively. */}
          {!weightsConfirmed && (
            <div className="mt-6 flex flex-col items-center gap-2 border-t border-white/10 pt-6">
              <button
                type="button"
                disabled={!enoughAssets || !weightsValid}
                onClick={() => setWeightsConfirmed(true)}
                className="press w-full rounded-2xl py-3.5 font-display text-base font-bold uppercase tracking-[0.15em] text-black transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:px-14"
                style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
              >
                Continue → set your fee
              </button>
              {!(enoughAssets && weightsValid) && (
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                  Balance the weights to 100% to continue
                </p>
              )}
            </div>
          )}
        </Step>

        {/* ── 3 · Fee config (set once at deploy, immutable forever) ── */}
        <Step
          index={3}
          title="Set the fee"
          show={maxStep >= 3}
          complete={feeValid}
        >
          <div className="grid gap-8 sm:grid-cols-2 sm:gap-10">
            {/* 1 · total fee rate (basketFeeBps) — slider across the protocol bounds */}
            <div>
              <FeeSlider
                id="fee-pct"
                label="Total fee"
                tip={
                  <>
                    The one fee this basket ever charges: taken once per buy, sell or swap, as a %
                    of that trade. There is no management fee and no other cost. You set it now and
                    it is written into the contract forever, nobody (including you) can change it
                    later.
                  </>
                }
                value={parseFloat(feePct)}
                onChange={(v) => setFeePct(v.toFixed(2))}
                min={bounds.minFeeBps / 100}
                max={bounds.maxFeeBps / 100}
                step={0.05}
                format={(v) => `${v.toFixed(2)}%`}
                minLabel={`${(bounds.minFeeBps / 100).toFixed(2)}% min · default`}
                maxLabel={`${(bounds.maxFeeBps / 100).toFixed(2)}% max`}
                defaultValue={1}
              />
              <p className="mt-2.5 font-mono text-xs leading-relaxed text-ink-dim">
                Charged on every buy, sell &amp; swap. Fixed forever once deployed.
              </p>
              {feeBps != null && !feeInBounds && (
                <p className="mt-1 font-mono text-xs text-alert">Fee is outside the protocol bounds.</p>
              )}
            </div>

            {/* 2 · the creator's own take (creatorShareBps) — slider 0 → the cap */}
            <div>
              <FeeSlider
                id="creator-share"
                label="Your share of it"
                tip={
                  <>
                    {`Every fee first burns ${(bounds.burnShareBps / 100).toFixed(0)}% as PRISM and reserves the small protocol app/launchpad slices. This slider is YOUR cut of what remains, paid to your payout address on every trade. Whatever you don't take belongs to the basket's holders, and holders are always guaranteed at least ${(100 - bounds.maxCreatorShareBps / 100).toFixed(0)}% of the remainder. Fixed forever at deploy.`}
                  </>
                }
                value={parseFloat(creatorSharePct)}
                onChange={(v) => setCreatorSharePct(String(Math.round(v)))}
                min={0}
                max={bounds.maxCreatorShareBps / 100}
                step={1}
                format={(v) => `${Math.round(v)}%`}
                minLabel="0% · all to holders"
                maxLabel={`${(bounds.maxCreatorShareBps / 100).toFixed(0)}% max`}
              />
              {/* one line (owner 13:46) — the InfoTip carries the full waterfall */}
              <p className="mt-2.5 whitespace-nowrap font-mono text-xs leading-relaxed text-ink-dim">
                Your cut after the burn &amp; protocol slices.
              </p>
              {creatorShareBps === 0 && (
                <p className="mt-1 font-mono text-xs text-teal">
                  You&rsquo;re taking no fee, your whole share flows to basket holders.
                </p>
              )}
            </div>
          </div>

          {/* creator payout — only required/shown when the creator takes a share */}
          {creatorShareBps > 0 && (
            <div className="mt-8">
              <label htmlFor="creator-payout" className="flex items-center gap-2 font-mono text-[13px] uppercase tracking-[0.15em] text-ink-dim">
                Your payout address
                <InfoTip>
                  Paid your fee share automatically on every trade. Set once at deploy.
                </InfoTip>
              </label>
              <div className="mt-3 flex items-center gap-2.5">
                <input
                  id="creator-payout"
                  value={creatorPayout}
                  onChange={(e) => setCreatorPayout(e.target.value.trim())}
                  placeholder="0x… where your fee is sent"
                  spellCheck={false}
                  size={1}
                  className="min-w-0 flex-1 rounded-xl border border-white/12 bg-black/40 px-4 py-3.5 font-mono text-sm text-ink placeholder:text-ink-dim focus:border-cyan/60 focus:outline-none"
                />
                {account && !creatorPayout && (
                  <button
                    type="button"
                    onClick={() => setCreatorPayout(account)}
                    className="press shrink-0 rounded-lg border border-white/12 px-3 py-3 font-mono text-[11px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
                  >
                    Use my address
                  </button>
                )}
              </div>
              {creatorPayout && !payoutValid && (
                <p className="mt-1.5 font-mono text-xs text-alert">
                  Enter a valid payout address (0x…), required because your take is above 0%.
                </p>
              )}
              <p className="mt-2 font-mono text-xs leading-relaxed text-ink-faint">

              </p>
            </div>
          )}

          {/* live waterfall — what every fee splits into, as % of the total fee */}
          <div className="mt-6">
            <FeeBreakdown split={builderSplit} creatorShareBps={creatorShareBps} />
          </div>
        </Step>

        {/* ── 4 · Review & confirm basket ────────────────────────────── */}
        <Step
          index={4}
          title="Review basket"
          show={maxStep >= 4}
          complete={basketConfirmed}
        >
          {/* What you see is what deploys: render the fee facts exactly as the
              Token page's FeePanel will show them post-launch. */}
          {feeValid && feeBps != null && (
            <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              {/* the "set at launch, immutable" header is gone; the rows step up
                  to 13px (owner 13:46) */}
              <dl className="mb-3 space-y-2 font-mono text-[13px] text-ink-dim">
                <div className="flex justify-between">
                  <dt className="text-ink-faint">Fee</dt>
                  <dd className="tabular-nums">{(feeBps / 100).toFixed(2)}% per mint / redeem / swap</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-faint">Your take</dt>
                  <dd className="tabular-nums">
                    {creatorShareBps > 0
                      ? `${(creatorShareBps / 100).toFixed(0)}% of remaining fees → ${shortAddr(creatorPayout.trim())}`
                      : 'none, all to holders'}
                  </dd>
                </div>
              </dl>
              <FeeBreakdown split={builderSplit} creatorShareBps={creatorShareBps} compact />
            </div>
          )}
          {basketConfirmed ? (
            <div className="flex items-center justify-center gap-2 font-mono text-[12px] uppercase tracking-[0.15em] text-teal">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-teal/15 text-[10px]">✓</span>
              Basket confirmed, name it below
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={!(enoughAssets && weightsValid && feeValid)}
                onClick={() => {
                  setBasketConfirmed(true)
                  // THE deliberate scroll: the user asked for the next step, so
                  // bring the just-revealed Name card into view (never done on
                  // reveal-from-data — prefill/draft restores stay at the top).
                  if (!prefersReducedMotion()) {
                    window.setTimeout(
                      () => document.getElementById('step-5')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                      200,
                    )
                  }
                }}
                className="w-full rounded-xl py-3.5 font-display text-base font-bold uppercase tracking-[0.15em] text-black transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed"
                style={enoughAssets && weightsValid && feeValid ? { background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' } : { background: 'rgba(255,255,255,0.08)', color: 'var(--color-ink-faint)' }}
              >
                Confirm basket
              </button>
              {!(enoughAssets && weightsValid && feeValid) && (
                <p className="mt-2 text-center font-mono text-xs text-ink-dim">
                  Add at least 2 assets balanced to 100%, and complete the fee config.
                </p>
              )}
            </>
          )}
        </Step>

        {/* ── 5 · Name your basket ───────────────────────────────────── */}
        <Step
          index={5}
          title="Name your basket"
          show={maxStep >= 5}
          complete={nameValid && symbolValid}
        >
          <div className="mb-6 space-y-3">
            <LiveTokenCard
              name={name}
              symbol={symbol}
              assets={assets}
              weights={weights}
              blend={blend}
              chainId={chainId}
              glowGrad={glowGrad}
            />
            <BasketBento items={bentoItems} aspect={2.6} />
          </div>

          <div className="relative">
            {glowGrad && (
              <div
                aria-hidden
                className="pointer-events-none absolute -top-28 left-1/2 -z-0 h-48 w-[120%] -translate-x-1/2 opacity-35 blur-3xl"
                style={{ background: glowGrad }}
              />
            )}
            <div className="relative z-10 flex items-center gap-3.5">
              <div className="relative shrink-0">
                <div className="absolute -inset-1 rounded-2xl opacity-60 blur-md" style={{ background: avatarGrad }} aria-hidden />
                <div className="relative grid h-14 w-14 place-items-center rounded-2xl ring-1 ring-white/20" style={{ background: avatarGrad }}>
                  <span aria-hidden className="font-display text-xl font-bold text-black/75">◆</span>
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <label htmlFor="basket-name" className="sr-only">
                  Basket name
                </label>
                <input
                  id="basket-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 42))}
                  placeholder="Basket name"
                  className="w-full rounded-xl border border-white/12 bg-black/40 px-4 py-3 font-display text-lg text-ink placeholder:text-ink-dim transition-colors focus:border-cyan/60 focus:bg-black/50 focus:outline-none focus:ring-2 focus:ring-cyan/15"
                />
                <label htmlFor="basket-symbol" className="sr-only">
                  Ticker symbol
                </label>
                <div className="flex items-center rounded-xl border border-white/12 bg-black/40 px-4 transition-colors focus-within:border-cyan/60 focus-within:bg-black/50 focus-within:ring-2 focus-within:ring-cyan/15">
                  <span aria-hidden className="font-num text-lg text-ink-dim">$</span>
                  <input
                    id="basket-symbol"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
                    placeholder="SYMBOL"
                    className="w-full bg-transparent py-3 font-display text-lg font-bold uppercase tracking-wide text-ink placeholder:text-ink-dim focus:outline-none"
                  />
                </div>
              </div>
            </div>
            {/* Version-mode ticker nudge (owner 13:38): recommendation, never a rule. */}
            {predecessor && (
              <p className="mt-2 font-mono text-xs leading-relaxed text-ink-dim">
                We recommend a versioned ticker (prefilled above) — wallets and aggregators list
                every version under its ticker, so a new number keeps buyers on the right one.
                The name can stay the same.
              </p>
            )}
          </div>

          {/* The thesis (title, body, tags, launch post) is deliberately NOT
              collected here — it lives in ONE place, the post-deploy publish
              ceremony (owner 2026-07-07 12:11: entering it twice was the bug;
              "publish your thesis in the popup rather than the launch page"). */}

          {/* Naming guidance, not enforcement — placeholder hint copy. */}
          {nameRiskHint && (
            <p className="mt-2.5 font-mono text-xs leading-relaxed text-alert">
              Heads up: names implying a regulated product ("…Fund", "…ETF", "…Index") can carry legal
              consequences for you as the deployer. The protocol does not censor names, the risk is
              yours.
            </p>
          )}

          {/* No handles, display names, taglines or descriptions by design: the
              creator identity IS the deploy wallet, its ENS name when one is
              reverse-linked, else the address. Nothing self-typed to spoof. */}

          <div className="mt-5">
            <div id="creator-label" className="flex items-center gap-2 font-mono text-[13px] uppercase tracking-[0.15em] text-ink-dim">
              Creator
              <InfoTip>
                Your basket is attributed to your deploy wallet. If that wallet has an ENS name
                (reverse record on Ethereum), you&rsquo;re shown by name; otherwise by address.
                There&rsquo;s nothing to type, identity comes from the chain, so it can&rsquo;t be
                impersonated.
              </InfoTip>
            </div>
            <div
              role="group"
              aria-labelledby="creator-label"
              className="mt-2 flex items-center gap-3 rounded-xl border border-white/12 bg-black/40 px-4 py-3"
            >
              <BasketAvatar
                address={account ?? ZERO_ADDR}
                symbol={creatorPreview.kind === 'address' ? 'x' : creatorPreview.label.replace(/^@/, '')}
                size={36}
              />
              <div className="min-w-0">
                <div className="truncate font-display text-base text-ink">
                  {account ? creatorPreview.label : 'Connect your wallet'}
                </div>
                <div className="truncate font-mono text-[11px] text-ink-faint">
                  {account
                    ? ensName
                      ? `ENS · ${shortAddr(account)}`
                      : 'No ENS name linked, your address is your identity'
                    : 'Your deploy wallet becomes the creator'}
                </div>
              </div>
            </div>
            {/* Honest-state: identity is chain-derived; no creator-hosted media. */}
            <p className="mt-3 font-mono text-xs leading-relaxed text-ink-faint">
              </p>
          </div>
        </Step>

        {/* ── 6 · Deploy ─────────────────────────────────────────────── */}
        <Step index={6} title="Deploy" subtitle="Mint your basket token onchain." show={maxStep >= 6} complete={readyToDeploy}>
          <div className="flex items-center gap-2.5">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-white/20" style={{ background: avatarGrad }}>
              <span aria-hidden className="font-display text-base font-bold text-black/75">◆</span>
            </div>
            <div className="min-w-0">
              <div className="truncate font-display text-base font-bold uppercase tracking-tight text-ink">{name || 'Your basket'}</div>
              <div className="font-mono text-[13px] uppercase tracking-[0.15em] text-ink-dim">
                {symbol ? `$${symbol} · ` : ''}
                {assets.length} assets · starts at $1.00
              </div>
            </div>
          </div>

          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2">
            <Check ok={enoughAssets}>At least 2 assets</Check>
            <Check ok={weightsValid}>Weights balanced</Check>
            <Check ok={feeValid}>Fee config complete</Check>
            <Check ok={nameValid}>Basket name set</Check>
            <Check ok={symbolValid}>Ticker set</Check>
          </ul>

          {/* Referral disclosure (owner 2026-07-07): setting a referrer as launcher
              is PERMANENT and comes out of the fee remainder — DISCLOSED, not
              optional. The creator is told, but can't disable the launcher slice
              (owner 2026-07-07 — it's the integrator fee, not a creator dial). */}
          {applyReferrerLauncher && referrer && (
            <div className="mt-5 rounded-xl border border-violet/30 bg-violet/[0.06] px-4 py-3">
              <span className="text-sm leading-relaxed text-ink-dim">
                Referred by <span className="font-mono text-ink">{shortAddr(referrer)}</span> — they receive the
                launcher fee share (~5% of fees) on this basket, <span className="text-ink">permanently</span>. It&rsquo;s
                a fixed protocol slice, part of launching through a referral.
              </span>
            </div>
          )}

          <HookForge status={deploy.status} attempts={deploy.attempts} predicted={deploy.predicted} />

          {/* Deployer self-attestation — required before the launch CTA below. The
              deployer-is-issuer acknowledgment must survive every refactor.
              The copy below is placeholder text, not legal advice. */}
          <label
            className={`mt-5 flex cursor-pointer items-start gap-3 rounded-xl border bg-white/[0.02] p-4 transition-colors ${
              acknowledged ? 'border-teal/40' : 'tick-glow border-cyan/40'
            }`}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-cyan"
            />
            <span className="text-sm leading-relaxed text-ink-dim">
              I&rsquo;m the creator and issuer of this basket and responsible for my own legal and marketing
              obligations. Spectrum is software, not financial, investment, legal, or tax advice, and is
              provided without warranty.
            </span>
          </label>
        </Step>

        {/* Bottom-of-flow launch banner — routes through the same flow as the
            Deploy step (startDeploy → ceremony); the on-chain broadcast stays behind
            the DEPLOY_ENABLED feature flag, so this never launches on its own. */}
        <div
          className="flex flex-col items-center gap-5 rounded-2xl p-6 text-center sm:flex-row sm:justify-between sm:p-8 sm:text-left"
          style={{ background: readyToDeploy ? 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' : 'rgba(255,255,255,0.06)' }}
        >
          <div className={readyToDeploy ? 'text-black' : 'text-ink-dim'}>
            <div className="font-display text-2xl font-bold uppercase leading-none tracking-tight sm:text-3xl">
              Ready to launch {symbol ? `$${symbol}` : 'your basket'}?
            </div>
            <div className="mt-2 font-mono text-[13px] uppercase tracking-[0.15em] opacity-80">
              {assets.length} {assets.length === 1 ? 'asset' : 'assets'} · starts at $1.00 NAV
            </div>
          </div>
          <div className="flex w-full shrink-0 flex-col items-center gap-2 sm:w-auto sm:items-end">
            <button
              type="button"
              disabled={!readyToDeploy}
              onClick={startDeploy}
              className="w-full rounded-xl bg-black px-10 py-4 font-display text-lg font-bold uppercase tracking-[0.2em] text-white transition-transform hover:enabled:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              Deploy →
            </button>
            {canDeploy && !insufficientEth && (
              <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${readyToDeploy ? 'text-black/70' : 'text-ink-dim'}`}>
                {deployCostEth != null
                  ? `≈ ${deployCostEth.toLocaleString(undefined, { maximumFractionDigits: 3 })} ETH to deploy · auction`
                  : 'Deploy cost: Dutch auction, price read live from the factory'}
              </span>
            )}
            {canDeploy && insufficientEth && walletBal && deployCostEth != null && (
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-alert">
                Not enough ETH: wallet holds {(Number(walletBal.value) / 1e18).toFixed(4)} · needs ≈{' '}
                {(deployCostEth + 0.01).toFixed(3)} (auction + gas)
              </span>
            )}
          </div>
        </div>
        {canDeploy && !acknowledged && !insufficientEth && (
          <p className="text-center font-mono text-xs text-ink-dim">
            Check the creator acknowledgment in step 6 to enable deploy.
          </p>
        )}
      </div>

      <DeployPortal
        open={deploying}
        onClose={() => {
          setDeploying(false)
          deploy.reset()
          publisher.reset()
        }}
        onStartOver={() => {
          setDeploying(false)
          deploy.reset()
          publisher.reset()
          setAssets([])
          setWeights([])
          setName('')
          setSymbol('')
          setFeePct('')
          setCreatorSharePct('0')
          setCreatorPayout('')
          setBasketConfirmed(false)
          setAcknowledged(false)
          setMaxStep(1)
        }}
        chainId={chainId}
        name={name}
        symbol={symbol}
        grad={avatarGrad}
        blend={blend}
        creatorHandle={undefined}
        creatorName={ensName ?? undefined}
        creatorAddress={account}
        assets={assets.map((a) => ({ address: a.address, symbol: a.symbol }))}
        bentoItems={bentoItems}
        deploy={{
          status: deploy.status,
          attempts: deploy.attempts,
          predicted: deploy.predicted,
          priceWei: deploy.priceWei,
          txHash: deploy.txHash,
          token: deploy.token,
          error: deploy.error,
          enabled: deploy.enabled,
          onSign: () => void deploy.broadcast(),
        }}
        publish={{
          enabled: publishEnabled,
          isVersion: !!predecessor,
          status: publisher.state.status,
          error: publisher.state.error,
          relay: publisher.state.relay,
          relayVerified: publisher.state.relayVerified,
          path: publisher.state.path,
          url: publisher.state.url,
          onPublish: (t) => {
            if (deploy.token && account) {
              // empty ceremony fields never clobber what the builder collected
              const overrides = Object.fromEntries(
                Object.entries(t ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== '')),
              )
              void publisher.publish({
                input: { ...publishBase, ...overrides },
                basket: deploy.token,
                signer: account,
              })
            }
          },
          onSkip: publisher.skip,
          onDownload: publisher.download,
        }}
      />
    </>
  )
}

// The live fee waterfall — every fee split into its five sinks, as % of the TOTAL
// fee (the on-chain knob is "% of the remainder", but the honest, legible number
// is "% of total"). Mirrors exactly what the post-launch FeePanel shows. The
// `split` is computed by feeSplit() in the conservative (interface-present) case,
// so the creator + holder figures are the FLOOR — unused slices only grow them.
function FeeBreakdown({
  split,
  creatorShareBps,
  compact = false,
}: {
  split: FeeSplit
  creatorShareBps: number
  compact?: boolean
}) {
  const pct = (f: number) => `${(f * 100).toFixed(1).replace(/\.0$/, '')}%`
  const rows = [
    { key: 'burn', label: 'PRISM burn', frac: split.burn, color: 'var(--color-cyan)', caption: 'fixed · same on every basket', show: true },
    { key: 'interface', label: 'Interface', frac: split.interface, color: 'var(--color-ink-dim)', caption: 'routes the trade · 0 on direct trades', show: split.interface > 0 },
    { key: 'launcher', label: 'Launcher', frac: split.launcher, color: '#6b6b80', caption: 'operator origination', show: split.launcher > 0 },
    { key: 'creator', label: 'Your take', frac: split.creator, color: 'var(--color-magenta)', caption: `${(creatorShareBps / 100).toFixed(0)}% of remaining fees`, show: true },
    { key: 'holders', label: 'Basket holders', frac: split.holders, color: 'var(--color-teal)', caption: 'claimable', show: true },
  ]
  const segs = rows.filter((r) => r.frac > 0)
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <p className="mb-3 font-mono text-[14px] leading-snug text-ink">
        You take <span className="text-magenta">≈{pct(split.creator)}</span> of total fees · holders keep{' '}
        <span className="text-teal">≈{pct(split.holders)}</span>
      </p>
      {/* stacked bar */}
      <div aria-hidden className="flex h-2 w-full overflow-hidden rounded-full bg-white/5">
        {segs.map((s) => (
          <div key={s.key} style={{ width: `${s.frac * 100}%`, background: s.color }} title={`${s.label} · ${pct(s.frac)}`} />
        ))}
      </div>
      <dl className="mt-3 space-y-2 font-mono text-[13px]">
        {rows
          .filter((r) => r.show)
          .map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-ink-dim">
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                {r.label}
                {!compact && <span className="text-ink-faint">· {r.caption}</span>}
              </dt>
              <dd className="tabular-nums text-ink">{pct(r.frac)}</dd>
            </div>
          ))}
      </dl>

    </div>
  )
}

// Typeable weight cell — buffers keystrokes locally and commits on blur/Enter via
// setWeight (which clamps to MIN and rebalances the others to keep Σ = 100).
function WeightInput({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [text, setText] = useState(String(value))
  const [resync, setResync] = useState(0)
  useEffect(() => setText(String(value)), [value, resync])
  const commit = () => {
    const n = parseInt(text, 10)
    if (Number.isFinite(n)) onCommit(n)
    setResync((r) => r + 1)
  }
  return (
    <div className="flex h-10 w-[4.5rem] items-center justify-center gap-0.5 border-x border-white/10 bg-black/25">
      <input
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        inputMode="numeric"
        aria-label={`${label} weight percent`}
        className="w-8 bg-transparent text-right font-num text-lg font-bold tabular-nums text-ink focus:outline-none"
      />
      <span className="font-num text-xs font-semibold text-ink-dim">%</span>
    </div>
  )
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 font-mono text-xs">
      <span
        aria-hidden
        className="grid h-4 w-4 place-items-center rounded-full text-[9px]"
        style={{ background: ok ? 'rgba(52,214,196,0.15)' : 'rgba(255,255,255,0.06)', color: ok ? 'var(--color-teal)' : 'var(--color-ink-faint)' }}
      >
        {ok ? '✓' : '○'}
      </span>
      <span className="text-ink-dim">
        <span className="sr-only">{ok ? 'Done: ' : 'To do: '}</span>
        {children}
      </span>
    </li>
  )
}
