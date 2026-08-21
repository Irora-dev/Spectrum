import { useMemo, useState, type CSSProperties } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { Link, useParams, useSearchParams } from 'react-router'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { clientFor } from '../lib/chain/rpc'
import { useActiveChainId } from '../lib/chain/active-chain'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import { encodeBundleNote, useCreatorBundles } from '../lib/spectrum/notes-social'
import { BundleHero } from '../components/BundleHero'
import { creatorHref } from '../lib/spectrum/short-url'
import { BundleBento as SharedBundleBento } from '../components/BundleBento'
import { BasketAvatar } from '../components/BasketAvatar'
import { ChainBadge } from '../components/ChainBadge'
import { ShareModal } from '../components/LaunchBanner'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { useHandleForAddress } from '../lib/spectrum/use-handles'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { readableInk } from '../lib/spectrum/token-meta'
import { readBrandHex } from '../theme/brand-colors'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { shortAddr } from '../lib/spectrum/format'
import {
  MAX_BUNDLE_LEGS,
  bundleChains,
  decodeBundle,
  encodeBundleParams,
  normalizedLegs,
  slugForLegs,
  splitBudget,
  type Bundle as BundleT,
  type BundleLeg,
} from '../lib/spectrum/bundle'

// ─────────────────────────────────────────────────────────────────────────────
// /bundle — cross-chain BUNDLES (owner 2026-07-08). A bundle is a weighted set of
// single-chain baskets shown as one cross-chain allocation. A frontend construct:
// NOT a contract, NOT one token. A follower replicates it by buying each leg on
// its own chain — stated explicitly. A creator/KOL builds one from their baskets
// and shares the link; buys through it carry their ?ref.
//
// No `?b=` → the BUILDER (pick baskets across chains, weight them, share the link).
// `?b=…`   → the VIEW (the bento, the split, per-leg buy, the disclosure).
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

interface Resolved {
  leg: BundleLeg
  pct: number
  ix: BasketSummary | null
}

function useResolved(legs: BundleLeg[]): Resolved[] {
  const { data: all } = useAllBaskets()
  return useMemo(() => {
    const norm = normalizedLegs(legs)
    return norm.map((l) => ({
      leg: l,
      pct: l.pct,
      ix: (all ?? []).find((b) => b.chainId === l.chainId && b.address.toLowerCase() === l.address.toLowerCase()) ?? null,
    }))
  }, [legs, all])
}

// The explicit cross-chain disclosure — the honesty rail for this whole feature.
function CrossChainNote({ chains }: { chains: number[] }) {
  return (
    <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-amber-200/90">
      A bundle is <span className="text-ink">not one token</span> — it's {chains.length} baskets across{' '}
      {chains.map((c, i) => (
        <span key={c}>
          {i > 0 ? ' + ' : ''}
          <span className="text-ink">{chainCfg(c).name}</span>
        </span>
      ))}
      . You buy each leg separately on its own chain (you'll need funds + gas on each). It tracks the target
      weights; it doesn't auto-rebalance.
    </p>
  )
}

/** "Your ref link" on the bundle hero (owner 2026-08-20: the ref copy control
 *  rides the hero of both pages, not buried in a panel) — the Token pill row's
 *  RefLinkChip law: the connected viewer's claimed creator name first, address
 *  form when unnamed, hidden with no wallet (no identity, no referral, and a
 *  door to nowhere is worse than no door). Copies THIS bundle's link with
 *  ?ref=you attached; the URL API keeps the ?b= legs intact on the query form
 *  and the published /bundle/:creator/:slug form alike. */
function BundleRefChip() {
  const { address, isConnected } = useAccount()
  const { lookup } = useHandleForAddress(address)
  const [copied, setCopied] = useState(false)
  if (!isConnected || !address) return null
  const refWord = lookup.status === 'found' ? lookup.owner.display : address
  const copy = async () => {
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('ref', refWord)
      await navigator.clipboard.writeText(u.toString())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copy your referral link for this bundle"
      title="Copy this bundle with your referral attached, buys through it credit you"
      className={`press inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors ${
        copied ? 'border-teal/50 bg-teal/10 text-teal' : 'border-white/15 bg-white/[0.04] text-ink-dim hover:border-cyan/50 hover:text-cyan'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
      {copied ? 'Copied ✓' : 'Your ref link'}
    </button>
  )
}

// ── VIEW: an existing bundle ───────────────────────────────────────────────────
// ── what the VIEWER actually holds of each leg ────────────────────────────────
// The framing decision (owner 2026-07-29): an allocation reads like a PORTFOLIO —
// one combined value and one performance number, with the legs as the breakdown —
// plus a completion state, because "you hold 2 of 3" is both the honest sentence
// and the one that makes the buyer want the third. Never "one token".
interface Held {
  /** Whole basket tokens held by the viewer, or null while unknown. */
  balance: number | null
  valueUsd: number
}

function useBundleHoldings(resolved: Resolved[]): {
  byLeg: Map<string, Held>
  heldCount: number
  /** Legs whose balance could not be READ — not held, not zero, unknown. */
  unknownCount: number
  /** Held legs whose basket didn't resolve, so their value can't be priced. */
  unpricedHeld: number
  combinedUsd: number
  /** Value-weighted 24h change across the legs actually held, or null. */
  change24hPct: number | null
  loading: boolean
} {
  const { address } = useAccount()
  const legKey = (l: BundleLeg) => `${l.chainId}:${l.address.toLowerCase()}`
  const q = useQuery({
    queryKey: [
      'spectrum',
      'bundle-holdings',
      address?.toLowerCase() ?? '',
      resolved.map((r) => legKey(r.leg)).join(','),
    ],
    enabled: !!address && resolved.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const out = new Map<string, number | null>()
      await Promise.all(
        resolved.map(async (r) => {
          try {
            const bal = await clientFor(r.leg.chainId).readContract({
              address: r.leg.address as Address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address as Address],
            })
            out.set(legKey(r.leg), Number(formatUnits(bal, 18)))
          } catch {
            out.set(legKey(r.leg), null) // couldn't read: say unknown, never "0 held"
          }
        }),
      )
      return out
    },
  })

  return useMemo(() => {
    const byLeg = new Map<string, Held>()
    let combinedUsd = 0
    let heldCount = 0
    let unknownCount = 0
    let unpricedHeld = 0
    let changeNumer = 0
    let changeDenom = 0
    for (const r of resolved) {
      const bal = q.data?.get(legKey(r.leg)) ?? null
      const nav = r.ix?.navPerToken ?? 0
      const valueUsd = bal != null && nav > 0 ? bal * nav : 0
      byLeg.set(legKey(r.leg), { balance: bal, valueUsd })
      // A balance we COULDN'T READ is not a balance of zero. The read path is
      // careful to record null for that, and the aggregate used to throw the
      // distinction away — so an RPC hiccup rendered as "you hold 2 of 3" and
      // put a buy CTA on a leg the wallet may already own. Counted apart, and
      // never folded into the held tally either way.
      if (bal == null) {
        unknownCount++
        continue
      }
      if (bal > 0) {
        heldCount++
        combinedUsd += valueUsd
        // Held but unpriceable (the basket itself didn't resolve) — it belongs
        // in the count, but the dollar total it contributes is a floor.
        if (nav <= 0) unpricedHeld++
        if (r.ix?.change24hPct != null && valueUsd > 0) {
          changeNumer += r.ix.change24hPct * valueUsd
          changeDenom += valueUsd
        }
      }
    }
    return {
      byLeg,
      heldCount,
      unknownCount,
      unpricedHeld,
      combinedUsd,
      change24hPct: changeDenom > 0 ? changeNumer / changeDenom : null,
      loading: q.isLoading,
    }
  }, [resolved, q.data, q.isLoading])
}

/** The portfolio headline: one combined number, one performance number, and the
 *  completion state. Shown only to a connected wallet — with none, there is no
 *  honest "you" to report on, so the page stays purely descriptive. */
function AllocationHeadline({
  resolved,
  holdings,
}: {
  resolved: Resolved[]
  holdings: ReturnType<typeof useBundleHoldings>
}) {
  const { address } = useAccount()
  if (!address) return null
  const total = resolved.length
  const pct = total > 0 ? (holdings.heldCount / total) * 100 : 0
  // "Complete" is a claim about every leg, so an unreadable one forfeits it.
  const complete = holdings.heldCount === total && total > 0 && holdings.unknownCount === 0
  return (
    <section className="rounded-2xl border border-white/12 bg-white/[0.03] px-5 py-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            Your combined position
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-num text-4xl font-light tabular-nums text-ink">
              {holdings.loading ? '…' : `$${Math.round(holdings.combinedUsd).toLocaleString('en-US')}`}
            </span>
            {holdings.change24hPct != null && (
              <span
                className={`font-num text-sm font-semibold tabular-nums ${holdings.change24hPct >= 0 ? 'text-teal' : 'text-magenta'}`}
              >
                {holdings.change24hPct >= 0 ? '+' : ''}
                {holdings.change24hPct.toFixed(1)}% 24h
              </span>
            )}
          </div>
        </div>
        <div className="min-w-[12rem] flex-1">
          <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            <span>
              {holdings.loading
                ? 'reading your balances…'
                : complete
                  ? 'allocation complete'
                  : `you hold ${holdings.heldCount} of ${total} legs`}
              {/* An unreadable leg is stated, never rounded into "not held" —
                  and it is why `complete` can't be trusted while any is unknown. */}
              {holdings.unknownCount > 0 && !holdings.loading && (
                <span className="text-amber-300/80"> · {holdings.unknownCount} unreadable</span>
              )}
            </span>
            {!complete && <span className="tabular-nums">{Math.round(pct)}%</span>}
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className="h-full rounded-full transition-[width] duration-700"
              style={{ width: `${Math.max(pct, complete ? 100 : 2)}%`, background: complete ? 'var(--color-teal)' : SPECTRAL }}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

function BundleView({ bundle, dropped, published }: { bundle: BundleT; dropped: number; published?: boolean }) {
  const resolved = useResolved(bundle.legs)
  const holdings = useBundleHoldings(resolved)
  // Memoized: the share card's payload keys off this identity — a fresh array
  // per render would redraw the drawn image on every budget keystroke.
  const chains = useMemo(() => bundleChains(bundle.legs), [bundle.legs])
  const [budget, setBudget] = useState('1000')
  const budgetNum = Number(budget) || 0
  const splits = splitBudget(bundle.legs, budgetNum)
  const refq = bundle.by ? `&ref=${bundle.by}` : ''
  // SHARE = THE REAL CARD POP-UP (owner 2026-08-20): the bundle's Share raises
  // the same drawn-image ShareModal the basket pages raise — the X intent, the
  // copy chips and the exportable image all live there now, so this page only
  // hands it the bundle's facts. The old X-intent + copy-link pair left with it.
  const [shareOpen, setShareOpen] = useState(false)
  const shareUrl = typeof window !== 'undefined' ? window.location.href : ''
  // the creator's claimed name rides the drawn card's footer (Token's law:
  // named creators by name, nothing when unnamed)
  const { lookup: creatorName } = useHandleForAddress(bundle.by)
  const sigHex = readBrandHex('--color-violet-bright', '#a48bff')
  const shareBundle = useMemo(
    () => ({
      url: shareUrl,
      chainNames: chains.map((c) => chainCfg(c).name),
      legs: resolved.map((r) => {
        // each tile painted as its basket's signature — the page bento's own law
        const paint = r.ix
          ? basketSignatureColor(r.ix.address, r.ix.top[0])
          : readBrandHex('--color-violet', '#7b5cff')
        return {
          symbol: r.ix?.symbol ?? shortAddr(r.leg.address),
          asset: r.leg.address,
          targetWeightPct: r.pct,
          color: paint,
          ink: /^#[0-9a-fA-F]{6}$/.test(paint) ? readableInk(paint) : '#0b0b12',
        }
      }),
    }),
    [shareUrl, chains, resolved],
  )

  return (
    <div className="py-4">
      {/* the bundle hero art, on every bundle page (owner 2026-08-01). This
          page used to open on a bare PageHeader with no art at all. */}
      <BundleHero minH="34svh">
        <h1 className="max-w-[18ch] font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl md:text-6xl">
          {bundle.name || 'Cross-chain bundle'}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-dim">
          <span>{bundle.legs.length} baskets · {chains.length} chains</span>
          {published && (
            <span
              title="This bundle is published on-chain by its creator, so this page works even without the original share link."
              className="inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-teal"
            >
              published on-chain
            </span>
          )}
          {bundle.by && (
            <span>
              by{' '}
              <Link to={creatorHref(bundle.by)} className="text-cyan hover:underline">{shortAddr(bundle.by)}</Link>
            </span>
          )}
          {/* the connected viewer's own ref copy, on the hero with the other
              identity facts (owner 2026-08-20: not buried in the buy panel) */}
          <BundleRefChip />
        </div>
      </BundleHero>
      <div className="mb-6" />

      {dropped > 0 && (
        <p className="mb-5 font-mono text-[10px] text-amber-200/80">
          {dropped} leg{dropped > 1 ? 's' : ''} on a network this site hasn’t enabled {dropped > 1 ? 'are' : 'is'} hidden.
        </p>
      )}

      <div className="mb-6">
        <AllocationHeadline resolved={resolved} holdings={holdings} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <SharedBundleBento legs={resolved.map((r) => ({ chainId: r.leg.chainId, address: r.leg.address, weight: r.leg.weight, ix: r.ix }))} />
          <CrossChainNote chains={chains} />
        </div>

        {/* allocate a budget → the per-leg split + guided buys */}
        <aside className="flex flex-col gap-4 rounded-3xl card-surface p-5 backdrop-blur-md sm:p-6">
          <div aria-hidden className="h-1 w-full -mt-5 mb-1 rounded-t-3xl sm:-mt-6" style={{ background: SPECTRAL }} />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-dim">Get this allocation</div>
            <label className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5">
              <span className="font-num text-xl text-ink-faint">$</span>
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal" enterKeyHint="done" autoComplete="off"
                aria-label="Budget in USD"
                className="min-w-0 flex-1 bg-transparent font-num text-2xl font-light tabular-nums text-ink outline-none"
              />
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">to allocate</span>
            </label>
          </div>

          {/* ONE PLAN, several steps — numbered, with what's already done ticked
              off. A leg the viewer already holds is not a pending purchase. */}
          <div className="flex flex-col divide-y divide-white/8 border-y border-white/10">
            {resolved.map((r, i) => {
              const held = holdings.byLeg.get(`${r.leg.chainId}:${r.leg.address.toLowerCase()}`)
              // null means we COULDN'T READ it, which is not the same as zero. Folding the
                // two together put a cyan "buy this leg" CTA on a position the wallet may
                // already hold — the exact thing the aggregate above was fixed to stop doing.
                const balKnown = held?.balance != null
                const has = balKnown && (held?.balance ?? 0) > 0
                const unknownBal = !balKnown && !holdings.loading
              return (
                <div key={`${r.leg.chainId}:${r.leg.address}`} className="flex items-center gap-3 py-2.5">
                  <span
                    aria-hidden
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border font-mono text-[9px] tabular-nums ${
                      has ? 'border-teal/60 bg-teal/15 text-teal' : 'border-white/20 text-ink-faint'
                    }`}
                  >
                    {has ? '✓' : unknownBal ? '?' : i + 1}
                  </span>
                  {r.ix && <BasketAvatar address={r.ix.address} symbol={r.ix.symbol} size={30} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-display text-sm font-bold text-ink">${r.ix?.symbol ?? shortAddr(r.leg.address)}</span>
                      <ChainBadge chainId={r.leg.chainId} />
                    </div>
                    <div className="font-mono text-[10px] tabular-nums text-ink-faint">
                      {Math.round(r.pct)}% · {chainCfg(r.leg.chainId).name}
                      {has && held?.valueUsd ? ` · you hold $${Math.round(held.valueUsd).toLocaleString('en-US')}` : ''}
                      {unknownBal ? ' · balance unreadable' : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-num text-sm tabular-nums text-ink">
                      {budgetNum > 0 ? `$${splits[i].toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
                    </div>
                    {/* NO `amt` here, deliberately. `splits[i]` is DOLLARS, but
                        /swap feeds `amt` straight into the pay field and parses
                        it with the PAY TOKEN's decimals — and the console
                        defaults to ETH. Passing $500 opened the buy at 500 ETH,
                        roughly 2,400x the intended trade, with a live Buy
                        button for any wallet that could cover it. Handing the
                        number across needs /swap to accept a USD-denominated
                        amount, or this to convert first; until then the plan
                        states the figure and the console starts empty. */}
                    <Link
                      to={`/swap?basket=${r.leg.address}&chain=${r.leg.chainId}${refq}`}
                      className={`press mt-0.5 inline-block rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
                        has
                          ? 'border-white/15 text-ink-faint hover:border-white/35 hover:text-ink'
                          : 'border-cyan/40 bg-cyan/[0.08] text-cyan hover:border-cyan'
                      }`}
                    >
                      {has ? 'Add more' : `Step ${i + 1}`}
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
          {/* The honest sentence, in the buy panel where the decision happens. */}
          <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
            {resolved.length} basket tokens, one per chain — you hold each in your own wallet. Take the
            steps in any order; each needs funds and gas on its own chain. Nothing here is pooled,
            bridged, or wrapped, and there is no combined token.
          </p>

          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="press inline-flex items-center gap-1.5 rounded-lg border border-cyan/40 bg-cyan/[0.08] px-3.5 py-2 font-mono text-[10px] uppercase tracking-wide text-cyan hover:border-cyan"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                <path d="M16 6l-4-4-4 4" />
                <path d="M12 2v13" />
              </svg>
              Share this bundle
            </button>
          </div>
        </aside>
      </div>

      {/* the real share pop-up — the drawn card, X intent, copy link/image,
          and the sharer's ref link row, all the modal's own machinery */}
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        symbol={bundle.name || 'bundle'}
        name={bundle.name || 'Cross-chain bundle'}
        addr=""
        chainId={chains[0] ?? 8453}
        sig={sigHex}
        buyInk={/^#[0-9a-fA-F]{6}$/.test(sigHex) ? readableInk(sigHex) : '#0b0b12'}
        holdings={[]}
        navPerToken={0}
        ageHours={null}
        navSeries={[]}
        by={creatorName.status === 'found' ? creatorName.owner.display : null}
        bundle={shareBundle}
      />
    </div>
  )
}

// ── BUILDER: assemble + weight a bundle, get a shareable link ───────────────────
function BundleBuilder() {
  const { data: all } = useAllBaskets()
  const { address } = useAccount()
  // Publishing writes to the notes registry on the VIEWING chain (the bundle's
  // legs can span chains; the record of it lives on one).
  const activeChainId = useActiveChainId()
  const [, setSearchParams] = useSearchParams()
  const [legs, setLegs] = useState<BundleLeg[]>([])
  const [name, setName] = useState('')
  const [q, setQ] = useState('')

  const heads = useMemo(() => (all ?? []).filter((b) => !b.supersededBy), [all])
  const chosen = useMemo(() => new Set(legs.map((l) => `${l.chainId}:${l.address.toLowerCase()}`)), [legs])
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return heads
      .filter((b) => !chosen.has(`${b.chainId}:${b.address.toLowerCase()}`))
      .filter((b) => !needle || b.symbol.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle))
      .slice(0, 24)
  }, [heads, chosen, q])

  const resolved = useResolved(legs)
  const add = (b: BasketSummary) => {
    if (legs.length >= MAX_BUNDLE_LEGS) return
    setLegs((prev) => [...prev, { chainId: b.chainId, address: b.address, weight: 100 }])
  }
  const setWeight = (i: number, w: number) => setLegs((prev) => prev.map((l, k) => (k === i ? { ...l, weight: Math.max(1, w) } : l)))
  const remove = (i: number) => setLegs((prev) => prev.filter((_, k) => k !== i))

  const link = useMemo(() => {
    const params = encodeBundleParams({ legs, by: address ?? null, name: name.trim() || null } as BundleT)
    return `${typeof window !== 'undefined' ? window.location.origin : ''}/bundle?${params.toString()}`
  }, [legs, address, name])
  const [copied, setCopied] = useState(false)
  const share = legs.length >= 2
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  // PUBLISH — a bundle that lives only in a URL dies with the link. One
  // signature writes it on-chain (kind 'bundle', subject = the creator), so it
  // gets listed on their creator page, travels to every Spectrum site, and stays
  // editable. Publishing is optional: the link alone still works.
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
  const [publishState, setPublishState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [publishError, setPublishError] = useState<string | null>(null)
  const canPublish = !!registry && !!address && share

  async function publish() {
    if (!canPublish || !publicClient || publishState === 'busy') return
    setPublishState('busy')
    setPublishError(null)
    try {
      // A stable slug from the composition: re-publishing the same set EDITS in
      // place instead of stacking duplicates.
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
      setPublishState('done')
    } catch (e) {
      setPublishError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Could not publish.') : 'Could not publish.')
      setPublishState('idle')
    }
  }

  return (
    <div className="pb-12">
      {/* ── HERO (full-bleed marketing) ── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/15 blur-[130px]" />
          <div className="absolute left-[18%] top-[26%] h-72 w-72 rounded-full bg-cyan/12 blur-[120px]" />
          <div className="absolute right-[16%] top-[44%] h-72 w-72 rounded-full bg-magenta/12 blur-[130px]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(125% 85% at 50% 42%, rgba(5,5,11,0.6) 0%, rgba(5,5,11,0.2) 46%, transparent 78%)' }} />
        <div className="relative z-10 mx-auto flex min-h-[52svh] max-w-4xl flex-col items-center justify-center px-4 pt-6 text-center">
          <div className="enter inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-ink-dim backdrop-blur" style={{ '--enter-i': 0 } as CSSProperties}>
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" />
            Bundles · cross-chain · permissionless
          </div>
          <h1 className="enter mt-7 font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl md:text-8xl" style={{ '--enter-i': 1 } as CSSProperties}>
            Curate a bundle,<br />earn the <span className="spectral-text">fees</span>.
          </h1>
          <p className="enter mx-auto mt-7 max-w-xl text-base leading-snug text-ink-dim sm:text-lg" style={{ '--enter-i': 2 } as CSSProperties}>
            Weight any baskets, yours or anyone’s, into one cross-chain allocation. Share the link and earn a
            slice of the fee on every buy through it, at no extra cost to them. You never have to launch your own.
          </p>
          <a href="#build" className="enter press mt-9 inline-flex items-center gap-2 rounded-xl px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black" style={{ background: SPECTRAL, '--enter-i': 3 } as CSSProperties}>
            Build yours
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14m0 0l-6-6m6 6l6-6" /></svg>
          </a>
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-16 px-1">
        {/* ── WHY CURATE ── */}
        <section className="grid gap-4 sm:grid-cols-3">
          {[
            { t: 'Curate, don’t create', c: 'var(--color-cyan)', d: 'You don’t have to launch a basket to earn. Bundle the ones you rate and get paid for the volume you bring.' },
            { t: 'One link, every leg', c: 'var(--color-violet-bright)', d: 'Your link tags every buy across every basket in it. It’s the protocol fee slice redirected to you, so buyers pay nothing extra and each basket’s creator keeps theirs.' },
            { t: 'Cross-chain, one set', c: 'var(--color-magenta)', d: 'Mix Ethereum and Base baskets into one weighted allocation your followers get in a few clicks.' },
          ].map((card) => (
            <div key={card.t} className="relative overflow-hidden rounded-3xl border border-white/[0.12] bg-white/[0.02] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${card.c}, transparent)` }} />
              <div className="font-display text-base font-bold uppercase tracking-tight text-ink">{card.t}</div>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{card.d}</p>
            </div>
          ))}
        </section>

        {/* ── THE BUILDER (functional generator) ── */}
        <section id="build" className="scroll-mt-6">
          <h2 className="text-center font-display text-4xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-5xl">Build your bundle</h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-sm leading-relaxed text-ink-dim">Pick baskets across chains, set the weights, get your link. Up to {MAX_BUNDLE_LEGS} baskets.</p>
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* pick + weight */}
        <div className="flex flex-col gap-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your bundle (optional)"
            maxLength={48}
            className="w-full rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 font-display text-lg text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
          />

          {legs.length > 0 && (
            <div className="flex flex-col gap-2 rounded-2xl card-surface p-3 backdrop-blur-md">
              {resolved.map((r, i) => (
                <div key={`${r.leg.chainId}:${r.leg.address}`} className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-black/20 px-2.5 py-2">
                  {r.ix && <BasketAvatar address={r.ix.address} symbol={r.ix.symbol} size={26} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-display text-sm font-bold text-ink">${r.ix?.symbol ?? shortAddr(r.leg.address)}</span>
                      <ChainBadge chainId={r.leg.chainId} />
                    </div>
                    <div className="font-mono text-[9px] tabular-nums text-ink-faint">{Math.round(r.pct)}% of bundle</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setWeight(i, r.leg.weight - 10)} className="press grid h-6 w-6 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink">−</button>
                    <span className="w-8 text-center font-num text-sm tabular-nums text-ink">{r.leg.weight}</span>
                    <button type="button" onClick={() => setWeight(i, r.leg.weight + 10)} className="press grid h-6 w-6 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink">+</button>
                  </div>
                  <button type="button" onClick={() => remove(i)} aria-label="Remove" className="press grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-white/10 hover:text-ink">✕</button>
                </div>
              ))}
            </div>
          )}

          {legs.length < MAX_BUNDLE_LEGS && (
            <div className="rounded-2xl card-surface p-3 backdrop-blur-md">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Add a basket — search ticker or name (any chain)"
                className="w-full rounded-xl border border-white/10 bg-void/40 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
              />
              <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                {matches.length === 0 && <p className="px-2 py-4 text-center font-mono text-[11px] text-ink-faint">No baskets match.</p>}
                {matches.map((b) => (
                  <button key={`${b.chainId}:${b.address}`} type="button" onClick={() => add(b)} className="press flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.05]">
                    <BasketAvatar address={b.address} symbol={b.symbol} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm font-semibold text-ink">${showSymbol(b.symbol)}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-faint">{b.name}</span>
                    </span>
                    <ChainBadge chainId={b.chainId} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* live preview + link */}
        <div className="flex flex-col gap-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-dim">Live preview</div>
          {legs.length > 0 ? <SharedBundleBento legs={resolved.map((r) => ({ chainId: r.leg.chainId, address: r.leg.address, weight: r.leg.weight, ix: r.ix }))} /> : (
            <div className="grid aspect-[2.2/1] w-full place-items-center rounded-2xl border border-dashed border-white/12 text-center font-mono text-xs text-ink-faint">
              Add baskets to see your bundle
            </div>
          )}
          <div className="rounded-2xl border border-cyan/20 bg-cyan/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan">Your bundle link</div>
            {share ? (
              <>
                <code className="mt-2 block truncate rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-ink-dim" title={link}>{link}</code>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void copy()} className="press rounded-lg border border-cyan/40 bg-cyan/10 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-cyan hover:border-cyan">{copied ? 'Copied' : 'Copy link'}</button>
                  <button type="button" onClick={() => setSearchParams(encodeBundleParams({ legs, by: address ?? null, name: name.trim() || null } as BundleT))} className="press rounded-lg border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan">Preview it</button>
                </div>
                {!address && <p className="mt-2 font-mono text-[9px] text-ink-faint">Connect a wallet so buys through your link are tagged to you.</p>}

                {/* PUBLISH — makes the bundle durable + listed, one signature.
                    Optional: the link works either way. */}
                {canPublish && (
                  <div className="mt-3 border-t border-white/10 pt-3">
                    {publishState === 'done' ? (
                      <p className="font-mono text-[10px] leading-relaxed text-teal">
                        Published on-chain. It now appears on your creator page and on any Spectrum site
                        reading this chain. Publish again after an edit to update it.
                      </p>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void publish()}
                          disabled={publishState === 'busy'}
                          className="press rounded-lg bg-cyan px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90 disabled:opacity-60"
                        >
                          {publishState === 'busy' ? 'Publishing…' : 'Publish on-chain'}
                        </button>
                        <p className="mt-2 font-mono text-[9px] leading-relaxed text-ink-faint">
                          One signature. A published bundle is listed on your creator page and survives
                          the link being lost; re-publishing the same set edits it in place.
                        </p>
                      </>
                    )}
                    {publishError && <p className="mt-2 font-mono text-[10px] text-magenta">{publishError}</p>}
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 font-mono text-[11px] text-ink-faint">Add at least 2 baskets to get a shareable link.</p>
            )}
          </div>
        </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ── */}
        <section>
          <h2 className="text-center font-display text-4xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-5xl">Three steps</h2>
          <div className="mt-9 grid gap-4 sm:grid-cols-3">
            {[
              { n: '01', t: 'Pick + weight', d: 'Choose baskets on any chain and set how much of each.' },
              { n: '02', t: 'Share your link', d: 'It unfurls as a card and carries your wallet as the referrer.' },
              { n: '03', t: 'Earn on every trade', d: 'Every buy through it pays you the interface fee slice, onchain in USDC.' },
            ].map((s) => (
              <div key={s.n} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="font-num text-2xl font-light text-cyan">{s.n}</div>
                <div className="mt-2 font-display text-base font-bold uppercase tracking-tight text-ink">{s.t}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-3 text-center font-mono text-[11px] leading-relaxed text-amber-200/90">
          A bundle is a shared allocation, not one token. Followers buy each basket on its own chain, and the fee
          you earn is a redirected protocol slice, never an extra charge. It tracks the weights, it doesn’t auto-rebalance.
        </p>
      </div>
    </div>
  )
}

/** Chains this build actually supports — `chainCfg` throws on an unknown chain,
 *  and a shared bundle can name one this deployment hasn't enabled. */
function keepSupported(legs: BundleLeg[]): { legs: BundleLeg[]; dropped: number } {
  const supported = new Set(SUPPORTED_CHAIN_IDS as readonly number[])
  const kept = legs.filter((l) => supported.has(l.chainId))
  return { legs: kept, dropped: legs.length - kept.length }
}

/**
 * A PUBLISHED bundle's own page: /bundle/:creator/:slug. Stable and shareable,
 * with no query soup — and because it reads the on-chain note rather than the
 * URL, the link keeps working even if the original share link is lost (which is
 * the whole point of publishing).
 */
export function PublishedBundlePage() {
  const { creator, slug } = useParams()
  const chainId = useActiveChainId()
  const { data, isLoading } = useCreatorBundles(chainId, creator)
  const found = (data ?? []).find((b) => b.slug === slug)

  if (isLoading) {
    return (
      <div className="grid min-h-[50vh] place-items-center" role="status" aria-label="Loading the bundle">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
      </div>
    )
  }
  if (!found) {
    return (
      <div className="py-10">
        <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center">
          <p className="text-sm text-ink-dim">
            No published bundle at this address on {chainCfg(chainId).name}.
          </p>
          <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
            It may have been retired by its creator, or published on a different network.
          </p>
          <Link to="/bundle" className="press mt-4 inline-block font-mono text-[11px] uppercase tracking-[0.16em] text-cyan hover:underline">
            Build your own →
          </Link>
        </div>
      </div>
    )
  }
  const { legs, dropped } = keepSupported(
    found.legs.map((l) => ({ chainId: l.chainId, address: l.address, weight: l.weight })),
  )
  return (
    <BundleView
      bundle={{ legs, by: creator ?? null, name: found.name || null }}
      dropped={dropped}
      published
    />
  )
}

export function Bundle() {
  const [params] = useSearchParams()
  const { bundle, dropped } = useMemo(() => {
    const b = decodeBundle(params.toString())
    const { legs, dropped: d } = keepSupported(b.legs)
    return { bundle: { ...b, legs }, dropped: d }
  }, [params])
  return bundle.legs.length > 0 ? <BundleView bundle={bundle} dropped={dropped} /> : <BundleBuilder />
}
