import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { formatEther, type Address } from 'viem'
import { useActiveChainId } from '../lib/chain/active-chain'
import { clientFor } from '../lib/chain/rpc'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import { factoryAbi } from '../lib/spectrum/abis-v2'
import { encodeBundleNote } from '../lib/spectrum/notes-social'
import { useAllBaskets, usePortfolio } from '../lib/spectrum/hooks'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import { BasketAvatar } from './BasketAvatar'
import { AssetLogo } from './AssetLogo'
import { ChainBadge } from './ChainBadge'
import { InfoDot } from './InfoDot'
import { BundleHero } from './BundleHero'
import { resolveAsset, type BuilderAsset } from './launch/BasketBuilder'
import { starterSuggestionsFor } from '../lib/chain/starter-suggestions'
import { isRetryableDetection } from '../lib/pools'
import {
  MAX_BUNDLE_LEGS,
  encodeBundleParams,
  normalizedLegs,
  slugForLegs,
  type Bundle as BundleT,
  type BundleLeg,
} from '../lib/spectrum/bundle'

// ─────────────────────────────────────────────────────────────────────────────
// THE FORGE — the bundle builder. ONE HERO VIEW (owner 2026-08-01): the bundle
// you are making is the only thing on the page, and choosing happens in a popup
// behind the glowing +. It began as an inline shelf of every basket, which made
// this a scrolling list; the owner's feedback was to lose the scroll.
//
// ONE component, THREE mounts (so no entry point grows a half-copy):
//   · /bundle/new                → full page, hero art
//   · Token page  [Bundle]       → `overlay`, seeded with that basket
//   · Creator page [+ New bundle]→ `overlay`, empty
// `seed` pre-loads a leg, which is what makes "Bundle this basket" one tap and
// answers "easier to create a bundle from the one basket they have".
//
// The picker leads with YOUR baskets (created, then held), shows what each one
// actually holds, and searches the assets inside them as well as their names.
// Everything is in the kit's own tokens — Chakra Petch, JetBrains Mono,
// void/panel, the spectral gradient. No new font, no new palette: the house
// rule is reuse before inventing.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
/** Physical easing — mass and spring, never `ease-in-out`. */
const EASE = 'cubic-bezier(0.32,0.72,0,1)'

const legKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

/** Outer shell + inner core, so a card reads as machined hardware rather than a
 *  div on a background. Radii are concentric: inner = outer − shell padding. */
function Bezel({ children, className = '', glow }: { children: React.ReactNode; className?: string; glow?: string }) {
  return (
    <div className={`rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 ${className}`}>
      <div
        className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] bg-panel/70 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)] backdrop-blur-md"
        style={glow ? ({ '--glow': glow } as CSSProperties) : undefined}
      >
        {glow && (
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-20 blur-3xl"
            style={{ background: glow }}
          />
        )}
        {children}
      </div>
    </div>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
      {children}
    </span>
  )
}

/** One basket inside the picker: what it IS, at a glance — its assets, its
 *  chain, its size — because picking blind is how you end up with a bundle you
 *  can't explain (owner 2026-08-01: "you should see on those baskets what
 *  assets they have… laid out beautifully"). */
function PickerRow({
  b,
  chosen,
  disabled,
  onPick,
  index,
}: {
  b: BasketSummary
  chosen: boolean
  disabled: boolean
  onPick: () => void
  index: number
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled && !chosen}
      aria-pressed={chosen}
      className={`enter group flex w-full items-start gap-4 rounded-2xl border p-4 text-left transition-transform duration-500 disabled:cursor-not-allowed disabled:opacity-40 ${
        chosen ? 'border-cyan/50 bg-cyan/[0.08]' : 'border-white/10 bg-white/[0.02] hover:-translate-y-0.5 hover:border-white/25'
      }`}
      style={{ transitionTimingFunction: EASE, '--enter-i': Math.min(index, 12) } as CSSProperties}
    >
      <BasketAvatar address={b.address} symbol={b.symbol} size={44} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-display text-base font-bold text-ink">${b.symbol}</span>
          <ChainBadge chainId={b.chainId} />
          <span className="font-mono text-[10px] text-ink-faint">
            {b.aumUsd > 0 ? formatUsdCompact(b.aumUsd) : '—'} · {b.basketLength} assets
          </span>
        </span>
        <span className="mt-1 block truncate font-mono text-[11px] text-ink-dim">{b.name}</span>
        {/* what's actually inside it */}
        {b.top?.length > 0 && (
          <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {b.top.slice(0, 5).map((t) => (
              <span
                key={t.address}
                className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] py-0.5 pl-0.5 pr-2"
              >
                <AssetLogo address={t.address} symbol={t.symbol} chainId={b.chainId} size={16} />
                <span className="font-mono text-[10px] text-ink-dim">{t.symbol}</span>
              </span>
            ))}
            {b.basketLength > 5 && (
              <span className="font-mono text-[10px] text-ink-faint">+{b.basketLength - 5}</span>
            )}
          </span>
        )}
      </span>
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border font-mono text-[14px] transition-colors ${
          chosen ? 'border-cyan/60 bg-cyan/20 text-cyan' : 'border-white/20 text-ink-faint group-hover:border-cyan/50 group-hover:text-cyan'
        }`}
      >
        {chosen ? '✓' : '+'}
      </span>
    </button>
  )
}

export function BundleForge({
  seed,
  overlay = false,
  onClose,
}: {
  /** Pre-load one leg — this is what makes "Bundle this basket" a single tap. */
  seed?: { chainId: number; address: string }
  overlay?: boolean
  onClose?: () => void
}) {
  const { address } = useAccount()
  const activeChainId = useActiveChainId()
  const { data: all } = useAllBaskets()
  const { data: portfolio } = usePortfolio(address)

  const [legs, setLegs] = useState<BundleLeg[]>(() =>
    seed ? [{ chainId: seed.chainId, address: seed.address, weight: 100 }] : [],
  )
  const [name, setName] = useState('')
  const [q, setQ] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  // The picker forks before it searches: an individual token, or a basket.
  const [mode, setMode] = useState<'choose' | 'token' | 'basket'>('choose')
  const [tokenChain, setTokenChain] = useState(activeChainId)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  // Carries the chain it was RESOLVED on, so it can never be attributed to
  // whichever pill is selected by the time you press Add.
  const [tokenFound, setTokenFound] = useState<{ chainId: number; asset: BuilderAsset } | null>(null)
  // Raw assets are NOT bundle legs yet — a leg is a basket address, and until
  // the basket is deployed there is no address. They are held apart as pending
  // picks, grouped by chain, and become legs when their basket exists.
  const [assetPicks, setAssetPicks] = useState<{ chainId: number; asset: BuilderAsset }[]>([])
  const suggestions = useMemo(() => starterSuggestionsFor(tokenChain), [tokenChain])

  // Resolve a pasted address the moment it is a valid one — same call the
  // launch builder makes, so the venue and routable depth shown here are the
  // launch page's own numbers rather than a second opinion.
  useEffect(() => {
    const raw = q.trim()
    // Clear the previous result FIRST. Leaving it up while a new chain or a new
    // address resolves meant the card showed one token's symbol, venue and
    // depth under a different chain's badge — and Add filed it under the pill
    // that happened to be selected, so a Base token could land in the Ethereum
    // group and be quoted a fee there.
    setTokenFound(null)
    setTokenError(null)
    if (mode !== 'token' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      // and the spinner must stop here too, or backspacing one character out of
      // a valid address leaves "Checking liquidity…" up forever — the in-flight
      // finally() is suppressed by its own stale guard.
      setTokenBusy(false)
      return
    }
    let stale = false
    setTokenBusy(true)
    setTokenError(null)
    const resolvedOn = tokenChain
    resolveAsset(raw, resolvedOn)
      .then((a) => {
        if (!stale) setTokenFound({ chainId: resolvedOn, asset: a })
      })
      .catch((e: unknown) => {
        if (stale) return
        setTokenFound(null)
        // A detection that merely FAILED is a retry, not a verdict — the same
        // distinction the remix path draws.
        // Surface the screen's OWN sentence. Collapsing every verdict into "no
        // routable pool" told a user who pasted a BASKET address — the single
        // likeliest mistake in a bundle builder, and one that fires more often
        // since basket detection was widened to retired factories — to go
        // hunting for liquidity, when the answer is "that is a basket, use the
        // other column". Same for a wrong-network paste, which reads as
        // NOT_A_CONTRACT. The launch builder already learned this.
        setTokenError(
          isRetryableDetection(e)
            ? 'Could not check this token right now — try again.'
            : e instanceof Error && e.message
              ? e.message
              : `No routable pool for this token on ${chainCfg(resolvedOn).name}.`,
        )
      })
      .finally(() => {
        if (!stale) setTokenBusy(false)
      })
    return () => {
      stale = true
    }
  }, [q, mode, tokenChain])

  const addAsset = (cid: number, a: BuilderAsset) => {
    setAssetPicks((prev) =>
      prev.some((p) => p.chainId === cid && p.asset.address.toLowerCase() === a.address.toLowerCase())
        ? prev
        : [...prev, { chainId: cid, asset: a }],
    )
    setQ('')
    setTokenFound(null)
  }
  const removeAsset = (chainId: number, address: string) =>
    setAssetPicks((prev) => prev.filter((p) => !(p.chainId === chainId && p.asset.address === address)))

  // Grouped by chain — this IS the deploy plan: one basket per chain, holding
  // that chain's raw assets (Colby 2026-08-01, which is what makes this need no
  // contract change at all).
  const assetsByChain = useMemo(() => {
    const m = new Map<number, BuilderAsset[]>()
    for (const p of assetPicks) m.set(p.chainId, [...(m.get(p.chainId) ?? []), p.asset])
    return [...m.entries()]
  }, [assetPicks])

  // The launch fee is READ LIVE per chain, never restated. A hardcoded 0.003
  // in money copy is exactly the "never transcribe a load-bearing number" trap:
  // it is right today on all three factories and would quietly become a lie the
  // day one of them is redeployed at a different price. Any chain we can't read
  // makes the TOTAL unknown rather than an under-count — quoting a number that
  // is too low is worse than saying we don't know yet.
  const feeReads = useQueries({
    queries: assetsByChain.map(([cid]) => ({
      // NOT ['spectrum','deployPrice',cid] — hooks.ts's useDeployPrice already
      // owns that key and returns {priceWei, slotOpen, blocksLeft}. Sharing it
      // poisoned BOTH directions: this line rendered "0.000[object Object]",
      // and worse, a bigint cached here made the launch builder's
      // insufficient-funds guard read undefined and silently pass. Own key.
      queryKey: ['spectrum', 'forge', 'launchFeeWei', cid],
      queryFn: async () => {
        const factory = chainCfg(cid).factory
        if (!factory) return null
        // currentDeployPrice reverts SlotNotOpen for 10 blocks after any
        // launch — an honest state, not a failure. Either way we don't know the
        // number yet, and the caller renders "reading…" rather than a guess.
        try {
          return (await clientFor(cid).readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'currentDeployPrice',
          })) as bigint
        } catch {
          return null
        }
      },
      staleTime: 60_000,
    })),
  })
  const feeTotalEth = useMemo(() => {
    if (feeReads.length === 0) return null
    let total = 0n
    for (const r of feeReads) {
      if (r.data == null) return null
      total += r.data
    }
    return formatEther(total)
  }, [feeReads])

  const heads = useMemo(() => (all ?? []).filter((b) => !b.supersededBy), [all])
  const chosen = useMemo(() => new Set(legs.map((l) => legKey(l.chainId, l.address))), [legs])
  const byKey = useMemo(() => new Map(heads.map((b) => [legKey(b.chainId, b.address), b])), [heads])

  // "Yours" is what the shelf leads with — the baskets you created plus the ones
  // you hold. That ordering is the feature: a creator with one basket sees it
  // first, not buried in a global list.
  const mine = useMemo(() => {
    const me = address?.toLowerCase()
    if (!me) return [] as BasketSummary[]
    const keys = new Set<string>()
    const out: BasketSummary[] = []
    for (const b of heads) {
      if (b.deployer?.toLowerCase() === me) {
        keys.add(legKey(b.chainId, b.address))
        out.push(b)
      }
    }
    for (const h of portfolio?.holdings ?? []) {
      const k = legKey(h.basket.chainId, h.basket.address)
      if (keys.has(k)) continue
      const full = byKey.get(k)
      if (full) {
        keys.add(k)
        out.push(full)
      }
    }
    return out
  }, [heads, address, portfolio, byKey])

  const needle = q.trim().toLowerCase()
  // Search matches the ASSETS INSIDE a basket as well as the basket itself
  // (owner 2026-08-01: "you can search both for baskets with that type of
  // asset"). Typing AAVE should find every basket holding AAVE, not just one
  // that happens to be called it — that is how you shop for exposure.
  const matches = (b: BasketSummary) =>
    !needle ||
    b.symbol.toLowerCase().includes(needle) ||
    b.name.toLowerCase().includes(needle) ||
    (b.top ?? []).some((t) => t.symbol.toLowerCase().includes(needle))
  const others = useMemo(() => {
    const mineKeys = new Set(mine.map((b) => legKey(b.chainId, b.address)))
    return heads
      .filter((b) => !mineKeys.has(legKey(b.chainId, b.address)))
      .filter(matches)
      .slice(0, needle ? 24 : 12)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heads, mine, needle])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mineShown = useMemo(() => mine.filter(matches), [mine, needle])

  const full = legs.length >= MAX_BUNDLE_LEGS
  const toggle = (b: BasketSummary) => {
    const k = legKey(b.chainId, b.address)
    if (chosen.has(k)) {
      setLegs((prev) => prev.filter((l) => legKey(l.chainId, l.address) !== k))
      return
    }
    if (full) return
    setLegs((prev) => [...prev, { chainId: b.chainId, address: b.address, weight: 100 }])
  }
  const setWeight = (i: number, w: number) =>
    setLegs((prev) => prev.map((l, k) => (k === i ? { ...l, weight: Math.max(1, w) } : l)))
  const remove = (i: number) => setLegs((prev) => prev.filter((_, k) => k !== i))
  /** Even it out — the single most-wanted weighting, and one tap. */
  const balance = () => setLegs((prev) => prev.map((l) => ({ ...l, weight: 100 })))

  const norm = useMemo(() => normalizedLegs(legs), [legs])
  const chains = useMemo(() => [...new Set(legs.map((l) => l.chainId))], [legs])
  const combinedTvl = useMemo(
    () => legs.reduce((s, l) => s + (byKey.get(legKey(l.chainId, l.address))?.aumUsd ?? 0), 0),
    [legs, byKey],
  )
  const unpriced = useMemo(
    () => legs.filter((l) => !(byKey.get(legKey(l.chainId, l.address))?.aumUsd)).length,
    [legs, byKey],
  )

  const shareable = legs.length >= 2
  const link = useMemo(() => {
    const params = encodeBundleParams({ legs, by: address ?? null, name: name.trim() || null } as BundleT)
    return `${typeof window !== 'undefined' ? window.location.origin : ''}/bundle?${params.toString()}`
  }, [legs, address, name])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  // PUBLISH — identical path to the old builder: one setNote on the notes
  // registry of the VIEWING chain, subject = you. A bundle that lives only in a
  // URL dies with the link.
  const registry = (() => {
    try {
      return chainCfg(activeChainId).notesRegistry
    } catch {
      return null
    }
  })()
  const publicClient = usePublicClient({ chainId: activeChainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [pubState, setPubState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [pubError, setPubError] = useState<string | null>(null)
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null)
  const canPublish = !!registry && !!address && shareable && pubState !== 'busy'

  async function publish() {
    if (!canPublish || !publicClient) return
    setPubState('busy')
    setPubError(null)
    try {
      const slug = slugForLegs(legs)
      const h = await writeContractAsync({
        address: registry as Address,
        abi: notesRegistryAbi,
        functionName: 'setNote',
        args: [
          address as Address,
          NOTE_KINDS.bundle,
          encodeBundleNote({ slug, name: name.trim() || undefined, legs }),
        ],
        chainId: activeChainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'bundles', activeChainId] })
      setPublishedSlug(slug)
      setPubState('done')
    } catch (e) {
      setPubError(e instanceof Error ? (('shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : e.message)) : String(e))
      setPubState('idle')
    }
  }

  // Escape closes the overlay mount; the page mount ignores it.
  useEffect(() => {
    if (!overlay || !onClose) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, onClose])

  const body = (
    <div className={overlay ? 'mx-auto w-full max-w-[1100px] px-4 py-10 sm:px-6' : ''}>
      {/* ── the bundle being built: the hero object, not a form ───────────── */}
      <Bezel glow="var(--color-violet-bright)">
        <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL }} />
        <div className="p-6 sm:p-10">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              {/* bigger than an eyebrow now — this is the card's own title */}
              <div className="font-display text-xl font-bold uppercase tracking-[0.08em] text-ink-dim sm:text-2xl">
                {seed ? 'Bundle this basket' : 'New bundle'}
              </div>
              {/* The name has to READ as a text box (owner 2026-08-01) — it was
                  a bare transparent input and looked like a heading. Framed,
                  with the right edge fading out so a long name dissolves
                  instead of colliding with the frame. */}
              <div className="relative mt-4 max-w-[36ch]">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={48}
                  placeholder="Name your bundle"
                  aria-label="Bundle name"
                  className="w-full min-w-0 rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-3 font-display text-3xl font-bold uppercase leading-[1.05] tracking-tight text-ink outline-none transition-colors placeholder:text-ink-faint/60 focus:border-cyan/50 sm:text-4xl"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-px right-px w-16 rounded-r-2xl"
                  style={{ background: 'linear-gradient(90deg, transparent, var(--color-panel))' }}
                />
              </div>
            </div>
            {overlay && onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="press grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-white/30 hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>

          {/* the legs, as weighted tiles */}
          <div className="mt-8 flex flex-wrap gap-3">
            {norm.map((l, i) => {
              const b = byKey.get(legKey(l.chainId, l.address))
              return (
                <div
                  key={legKey(l.chainId, l.address)}
                  className="group relative flex items-center gap-3 rounded-2xl border border-white/12 bg-white/[0.04] p-3 pr-4 transition-transform duration-500 hover:-translate-y-0.5"
                  style={{ transitionTimingFunction: EASE }}
                >
                  <BasketAvatar address={l.address} symbol={b?.symbol ?? '?'} size={40} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-display text-sm font-bold text-ink">${b?.symbol ?? shortAddr(l.address)}</span>
                      <ChainBadge chainId={l.chainId} />
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setWeight(i, l.weight - 10)}
                        aria-label={`Decrease ${b?.symbol ?? 'leg'} weight`}
                        className="press grid h-6 w-6 place-items-center rounded-md border border-white/15 font-mono text-[12px] text-ink-dim hover:border-white/35 hover:text-ink"
                      >
                        −
                      </button>
                      <span className="min-w-[3.25rem] text-center font-num text-sm font-semibold tabular-nums text-ink">
                        {l.pct.toFixed(0)}%
                      </span>
                      <button
                        type="button"
                        onClick={() => setWeight(i, l.weight + 10)}
                        aria-label={`Increase ${b?.symbol ?? 'leg'} weight`}
                        className="press grid h-6 w-6 place-items-center rounded-md border border-white/15 font-mono text-[12px] text-ink-dim hover:border-white/35 hover:text-ink"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label={`Remove ${b?.symbol ?? 'leg'}`}
                    className="press ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint opacity-0 transition-opacity hover:text-magenta focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              )
            })}

            {/* THE ADD SLOT. Owner: "make that glowing a little bit with a cool
                rotating animation, and it should be clickable — obvious that
                it's clickable". A conic ring rotates behind a masked core, so
                the glow travels the border rather than the whole tile. */}
            {!full && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-label="Add a basket to this bundle"
                className="press group relative grid h-[72px] w-[72px] shrink-0 place-items-center rounded-2xl transition-transform duration-500 hover:scale-[1.04]"
                style={{ transitionTimingFunction: EASE }}
              >
                {/* the halo — same rotating conic, blurred out beyond the tile,
                    so the glow reads from across the card (owner: "a bit more
                    glowy… it needs to feel more obvious") */}
                <span aria-hidden className="forge-add-ring absolute -inset-2 rounded-[1.25rem] opacity-60 blur-lg transition-opacity duration-500 group-hover:opacity-95" />
                <span aria-hidden className="forge-add-ring absolute inset-0 rounded-2xl" />
                <span aria-hidden className="absolute inset-[2px] rounded-[calc(1rem-2px)] bg-panel" />
                <span className="relative font-mono text-2xl leading-none text-ink transition-transform duration-500 group-hover:scale-110">+</span>
              </button>
            )}
          </div>

          {/* THE DEPLOY PLAN, made visible. Raw assets are grouped by chain and
              each group becomes ONE basket — Colby's model, and the reason this
              needs no contract change. Shown as pending because until the
              basket is deployed there is no address to put in the bundle, and
              the cost is stated rather than discovered at signing time. */}
          {assetsByChain.length > 0 && (
            <div className="mt-8 space-y-3">
              {assetsByChain.map(([cid, assets]) => (
                <div key={cid} className="rounded-2xl border border-dashed border-cyan/35 bg-cyan/[0.04] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <ChainBadge chainId={cid} />
                    <span className="font-mono text-[11px] text-ink-dim">
                      new basket · {assets.length} asset{assets.length === 1 ? '' : 's'}
                    </span>
                    <span className="font-mono text-[10px] text-ink-faint">not created yet</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {assets.map((a) => (
                      <span
                        key={a.address}
                        className="group inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] py-1 pl-1 pr-1.5"
                      >
                        <AssetLogo address={a.address} symbol={a.symbol} chainId={cid} size={20} />
                        <span className="font-mono text-[11px] text-ink-dim">${a.symbol}</span>
                        <button
                          type="button"
                          onClick={() => removeAsset(cid, a.address)}
                          aria-label={`Remove ${a.symbol}`}
                          className="press grid h-5 w-5 place-items-center rounded-full text-ink-faint hover:text-magenta"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <p className="font-mono text-[11px] leading-relaxed text-amber-300/85">
                {assetsByChain.length} basket{assetsByChain.length === 1 ? '' : 's'} to create ·{' '}
                {feeTotalEth == null ? 'reading the launch fee…' : `${feeTotalEth} ETH in launch fees`} plus gas,
                one signature each.
                <InfoDot>
                  Each chain&rsquo;s assets become one ordinary basket — a single tradable token with its own
                  price and chart. Creating one is a real deploy: the factory's launch fee, a signature, and a
                  short wait while its address is mined. On Ethereum the gas can cost more than
                  the fee itself. A new basket also needs a first buy before
                  anyone can enter it in kind. Nothing is spent until you start.
                </InfoDot>
              </p>
            </div>
          )}

          {/* live read-out of what you have made */}
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-6 font-mono text-[11px] text-ink-dim">
            <span>
              <span className="font-semibold text-ink">{legs.length}</span> basket{legs.length === 1 ? '' : 's'}
            </span>
            <span>
              <span className="font-semibold text-ink">{chains.length}</span> chain{chains.length === 1 ? '' : 's'}
              {chains.length > 0 && <span className="text-ink-faint"> · {chains.map((c) => chainCfg(c).name).join(' + ')}</span>}
            </span>
            <span>
              combined TVL <span className="font-semibold text-ink">{combinedTvl > 0 ? formatUsdCompact(combinedTvl) : '—'}</span>
              {unpriced > 0 && <span className="text-amber-300/80"> · {unpriced} unpriced</span>}
            </span>
            {legs.length > 1 && (
              <button
                type="button"
                onClick={balance}
                className="press ml-auto rounded-lg border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
              >
                Even it out
              </button>
            )}
          </div>

          {/* actions */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!canPublish}
              onClick={() => void publish()}
              className="press group inline-flex h-12 items-center gap-3 rounded-full pl-6 pr-2 font-display text-sm font-bold uppercase tracking-[0.14em] text-void transition-transform duration-500 hover:scale-[1.01] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: SPECTRAL, transitionTimingFunction: EASE }}
            >
              {pubState === 'busy' ? 'Confirm in wallet…' : pubState === 'done' ? 'Published' : 'Publish bundle'}
              <span className="grid h-8 w-8 place-items-center rounded-full bg-black/15 transition-transform duration-500 group-hover:translate-x-0.5 group-hover:-translate-y-px">
                ↗
              </span>
            </button>
            <button
              type="button"
              disabled={!shareable}
              onClick={() => void copy()}
              className="press inline-flex h-12 items-center rounded-full border border-white/15 px-6 font-mono text-[11px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            {!shareable && (
              <span className="font-mono text-[11px] text-ink-faint">
                Add {2 - legs.length} more basket{2 - legs.length === 1 ? '' : 's'} to share or publish
              </span>
            )}
            {!address && shareable && (
              <span className="font-mono text-[11px] text-ink-faint">Connect a wallet to publish</span>
            )}
          </div>

          {pubError && (
            <p className="mt-4 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] text-ink-dim">
              {pubError}
            </p>
          )}
          {pubState === 'done' && publishedSlug && address && (
            <p className="mt-4 rounded-xl border border-teal/30 bg-teal/[0.06] p-3 font-mono text-[11px] text-ink-dim">
              Live at{' '}
              <a className="text-teal hover:underline" href={`/bundle/${address.toLowerCase()}/${publishedSlug}`}>
                /bundle/{shortAddr(address)}/{publishedSlug}
              </a>{' '}
              — it is listed on your creator page and survives the link being lost.
            </p>
          )}
        </div>
      </Bezel>

      {/* ── the picker, as a popup. The shelf used to live inline and made this
             a scrolling page; owner 2026-08-01 wants ONE hero view, with the
             choosing behind the glowing +. ─────────────────────────────── */}
      {pickerOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[94] overflow-y-auto bg-void/85 p-4 backdrop-blur-sm sm:p-8"
            role="dialog"
            aria-modal="true"
            aria-label="Add a basket"
            onClick={() => setPickerOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="mx-auto w-full max-w-[980px] overflow-hidden rounded-[2rem] border border-white/12 bg-panel/95 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] backdrop-blur-md"
            >
              <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL }} />
              <div className="p-6 sm:p-8">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <Eyebrow>Add to bundle</Eyebrow>
                    <h2 className="mt-3 font-display text-3xl font-bold uppercase tracking-tight text-ink">
                      Pick a basket
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPickerOpen(false)}
                    aria-label="Close"
                    className="press grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-white/30 hover:text-ink"
                  >
                    ✕
                  </button>
                </div>

                {/* THE FORK (owner 2026-08-01): two columns, not a search bar.
                    An individual token, or a whole basket. */}
                {mode === 'choose' && (
                  <div className="mt-8 grid gap-4 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setMode('token')}
                      className="group rounded-[1.75rem] border border-white/12 bg-white/[0.03] p-7 text-left transition-transform duration-500 hover:-translate-y-1 hover:border-cyan/40"
                      style={{ transitionTimingFunction: EASE }}
                    >
                      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan/30 bg-cyan/10 font-mono text-lg text-cyan">◎</span>
                      <span className="mt-5 block font-display text-2xl font-bold uppercase tracking-tight text-ink">Pick a token</span>
                      <span className="mt-2 block text-[13px] leading-relaxed text-ink-dim">
                        Any asset across {SUPPORTED_CHAIN_IDS.map((c) => chainCfg(c).name).join(', ')}. We group
                        what you choose by chain and make a basket for each.
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('basket')}
                      className="group rounded-[1.75rem] border border-white/12 bg-white/[0.03] p-7 text-left transition-transform duration-500 hover:-translate-y-1 hover:border-violet-bright/40"
                      style={{ transitionTimingFunction: EASE }}
                    >
                      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-violet-bright/30 bg-violet-bright/10 font-mono text-lg text-[#cabdff]">▦</span>
                      <span className="mt-5 block font-display text-2xl font-bold uppercase tracking-tight text-ink">Pick a basket</span>
                      <span className="mt-2 block text-[13px] leading-relaxed text-ink-dim">
                        One that already exists — yours or anyone else&rsquo;s. It joins the bundle as it is.
                      </span>
                    </button>
                  </div>
                )}

                {mode !== 'choose' && (
                  <button
                    type="button"
                    onClick={() => setMode('choose')}
                    className="press mt-6 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint hover:text-ink"
                  >
                    ← {mode === 'token' ? 'Pick a token' : 'Pick a basket'}
                  </button>
                )}

                {/* chain pills — only meaningful on the token side, where an
                    address has to be resolved against ONE chain */}
                {mode === 'token' && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {SUPPORTED_CHAIN_IDS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setTokenChain(c)}
                        aria-pressed={tokenChain === c}
                        className={`press h-9 rounded-full border px-4 font-mono text-[11px] uppercase tracking-wide transition-colors ${
                          tokenChain === c ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-white/12 text-ink-dim hover:border-white/30'
                        }`}
                      >
                        {chainCfg(c).name}
                      </button>
                    ))}
                  </div>
                )}

                {mode !== 'choose' && (
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={
                      mode === 'token'
                        ? 'Search a token, or paste a contract address'
                        : 'Search by basket, or by an asset inside it — AAVE, WETH…'
                    }
                    aria-label={mode === 'token' ? 'Search tokens' : 'Search baskets'}
                    spellCheck={false}
                    autoFocus
                    className="mt-4 h-12 w-full rounded-full border border-white/12 bg-white/[0.03] px-5 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-cyan/50"
                  />
                )}

                {mode === 'token' && (
                  <div className="mt-5">
                    {tokenBusy && <p className="font-mono text-[11px] text-ink-faint">Checking liquidity on {chainCfg(tokenChain).name}…</p>}
                    {tokenError && (
                      <p className="rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] text-ink-dim">{tokenError}</p>
                    )}
                    {/* A resolved asset shows the SAME facts the launch builder
                        shows — venue and routable depth — because a bundle leg
                        is a basket you are about to deploy, and thin routing is
                        the thing that bites at buy time. */}
                    {tokenFound && (
                      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-cyan/40 bg-cyan/[0.06] p-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-display text-lg font-bold text-ink">${tokenFound.asset.symbol}</span>
                            <ChainBadge chainId={tokenFound.chainId} />
                          </div>
                          <div className="mt-1 font-mono text-[11px] text-ink-dim">
                            {tokenFound.asset.venueLabel} ·{' '}
                            {tokenFound.asset.depthUsd != null && tokenFound.asset.depthUsd > 0
                              ? `${formatUsdCompact(tokenFound.asset.depthUsd)} routable`
                              : 'depth unknown'}
                          </div>
                          {tokenFound.asset.warnings.length > 0 && (
                            <div className="mt-1.5 font-mono text-[10px] leading-relaxed text-amber-300/85">
                              {tokenFound.asset.warnings.join(' · ')}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => addAsset(tokenFound.chainId, tokenFound.asset)}
                          className="press h-10 shrink-0 rounded-full border border-cyan/50 bg-cyan/15 px-5 font-mono text-[11px] uppercase tracking-wide text-cyan hover:border-cyan"
                        >
                          Add asset
                        </button>
                      </div>
                    )}
                    {!tokenBusy && !tokenFound && !tokenError && suggestions.length > 0 && (
                      <>
                        <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Suggested on {chainCfg(tokenChain).name}</h3>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {suggestions.map((s) => (
                            <button
                              key={s.address}
                              type="button"
                              onClick={() => setQ(s.address)}
                              className="press rounded-full border border-white/12 bg-white/[0.03] px-4 py-2 font-mono text-[11px] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                            >
                              ${s.symbol}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {!tokenBusy && !tokenFound && !tokenError && suggestions.length === 0 && !q.trim() && (
                      <p className="font-mono text-[11px] text-ink-faint">
                        Paste a contract address on {chainCfg(tokenChain).name} to check it.
                      </p>
                    )}
                  </div>
                )}

                <div className={`mt-6 max-h-[52vh] space-y-6 overflow-y-auto pr-1 ${mode === 'basket' ? '' : 'hidden'}`}>
                  {mineShown.length > 0 && (
                    <div>
                      <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Yours</h3>
                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        {mineShown.map((b, i) => (
                          <PickerRow
                            key={legKey(b.chainId, b.address)}
                            b={b}
                            index={i}
                            chosen={chosen.has(legKey(b.chainId, b.address))}
                            disabled={full}
                            onPick={() => toggle(b)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {others.length > 0 && (
                    <div>
                      <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                        {needle ? 'Matching' : 'Everyone else’s'}
                      </h3>
                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        {others.map((b, i) => (
                          <PickerRow
                            key={legKey(b.chainId, b.address)}
                            b={b}
                            index={i}
                            chosen={chosen.has(legKey(b.chainId, b.address))}
                            disabled={full}
                            onPick={() => toggle(b)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {mineShown.length === 0 && others.length === 0 && (
                    <p className="py-8 text-center font-mono text-[11px] text-ink-faint">
                      Nothing matches “{q}”.
                    </p>
                  )}
                </div>

                {full && (
                  <p className="mt-5 font-mono text-[11px] text-amber-300/80">
                    {MAX_BUNDLE_LEGS} legs is the cap — remove one to swap it out.
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* The standing disclosure — centred, one line, the rest behind the icon
          (owner 2026-08-01). It still has to SAY the load-bearing part on the
          page; only the mechanics move into the dot. */}
      <p className="mt-14 text-center text-[13px] leading-relaxed text-ink-dim">
        A bundle is a set of baskets presented as one allocation — not one token.
        <InfoDot>
          Nothing is pooled, bridged or wrapped. A follower replicates the allocation by buying
          each leg on its own chain, which means holding funds and gas on each of them. The
          bundle tracks its target weights; it does not auto-rebalance.
        </InfoDot>
      </p>
    </div>
  )

  if (!overlay) return body

  return createPortal(
    <div className="fixed inset-0 z-[92] overflow-y-auto bg-void/90 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Create a bundle">
      {body}
    </div>,
    document.body,
  )
}

/** The standalone route (`/bundle/new`). Same forge, plus the full-bleed hero —
 *  the page mount is the set-piece, the overlay mount is the shortcut. Runs at
 *  the basket page's wider 1100px measure rather than the 1000px site column. */
export function BundleForgePage() {
  const [params] = useSearchParams()
  const chain = Number(params.get('chain'))
  const from = params.get('from')
  const seed = from && /^0x[0-9a-fA-F]{40}$/.test(from) && chain > 0 ? { chainId: chain, address: from } : undefined
  const [learnOpen, setLearnOpen] = useState(false)

  return (
    <div className="py-6 xl:-mx-[50px]">
      <BundleHero minH="34svh">
          {/* The title carries the homepage wordmark's sweeping spectral band
              (owner 2026-08-01) and is the whole hero now — the eyebrow pill and
              the paragraph under it are gone, because the line says it. */}
          {/* Two lines on desktop, not three — the break is explicit rather
              than left to the measure, so it lands in the same place at every
              width above md instead of reflowing with the font. */}
          <h1 className="spectrum-wordmark mx-auto max-w-[16ch] text-center font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight sm:text-6xl md:max-w-[28ch] md:text-7xl lg:text-8xl">
            Bundle cross-chain assets <br className="hidden md:block" /> into a single tradable flow
          </h1>
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={() => setLearnOpen(true)}
              className="press inline-flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-6 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim backdrop-blur-sm hover:border-cyan/50 hover:text-cyan"
            >
              How this works
            </button>
          </div>
      </BundleHero>

      {/* The card sits tight under the title (owner 2026-08-01: "all the way up
          just below the title"), pulled INTO the hero's foot so the art runs
          behind its shoulders, and on a spectral wash of its own. */}
      <div className="relative mx-auto -mt-6 max-w-[1160px] px-4 sm:px-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -top-16 bottom-0 -z-10 opacity-70"
          style={{
            background:
              'radial-gradient(120% 60% at 50% 0%, color-mix(in srgb, var(--color-violet-bright) 22%, transparent), transparent 70%)',
          }}
        />
        <BundleForge seed={seed} />
      </div>

      {/* the explainer that used to be a paragraph in the hero */}
      {learnOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[94] grid place-items-center overflow-y-auto bg-void/85 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label="How bundles work"
            onClick={() => setLearnOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-[min(38rem,100%)] overflow-hidden rounded-[2rem] border border-white/12 bg-panel/95 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]"
            >
              <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL }} />
              <div className="p-7 sm:p-8">
                <div className="flex items-start justify-between gap-4">
                  <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">How bundles work</h2>
                  <button
                    type="button"
                    onClick={() => setLearnOpen(false)}
                    aria-label="Close"
                    className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-white/30 hover:text-ink"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-5 space-y-4 text-[14px] leading-relaxed text-ink-dim">
                  <p>
                    A bundle is a weighted set of baskets shown as one allocation — and each basket
                    is itself a set of assets, so a single link can carry exposure on Ethereum,
                    Base and Robinhood at once.
                  </p>
                  <p>
                    It is <span className="text-ink">not a contract and not one token</span>.
                    Nothing is pooled, bridged or wrapped: a follower replicates the allocation by
                    buying each leg on its own chain, which means funds and gas on each.
                  </p>
                  <p>
                    Publishing writes the bundle on-chain as a signed note, so it lists on your
                    creator page, travels to every Spectrum site, and outlives the share link.
                  </p>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
