// In-chat bundle creation, end to end (owner 2026-08-20: "create a bundle end
// to end from that chat without ever having to leave"). The DeployCard
// precedent: the primary flow completes here, external pages are optional
// receipts. All money-shaped logic is the REAL path reused, never a copy:
// legs are the forge's own {chainId, address, weight} shape, the share link is
// encodeBundleParams, and publishing signs through useBundlePublish, the hook
// BundleForge itself runs on.
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { useActiveChainId } from '../../lib/chain/active-chain'
import { useAllBaskets } from '../../lib/spectrum/hooks'
import { useBundlePublish } from '../BundleForge'
import { MAX_BUNDLE_LEGS, encodeBundleParams, normalizedLegs, type Bundle as BundleT } from '../../lib/spectrum/bundle'
import { CHAINS } from '../../lib/chain/chains'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { BasketAvatar } from '../BasketAvatar'
import { ChainBadge } from '../ChainBadge'
import { CopyRow, cheerSpecter } from './CopyRow'
import { playSfx } from './sfx'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

interface CardLeg {
  chainId: number
  address: Address
  symbol: string
  weight: number
}

const keyOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

export function BundleCard({ legs: initial }: { legs: { chainId: number; address: Address; symbol: string }[] }) {
  const { address } = useAccount()
  const chainId = useActiveChainId() // publishing records on the VIEWING chain, same as the forge
  const { data: all } = useAllBaskets()
  const [legs, setLegs] = useState<CardLeg[]>(() => {
    const out: CardLeg[] = []
    const seen = new Set<string>()
    for (const l of initial) {
      const k = keyOf(l.chainId, l.address)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ ...l, weight: 100 })
      if (out.length >= MAX_BUNDLE_LEGS) break
    }
    return out
  })
  const [name, setName] = useState('')
  const [q, setQ] = useState('')
  const { registry, state, error, slug, publish } = useBundlePublish(chainId)

  const chosen = useMemo(() => new Set(legs.map((l) => keyOf(l.chainId, l.address))), [legs])
  const norm = normalizedLegs(legs)
  const full = legs.length >= MAX_BUNDLE_LEGS
  const needle = q.trim().toLowerCase()
  // adding an existing basket rides the same list every builder picks from
  const matches = useMemo(() => {
    if (!needle) return []
    return (all ?? [])
      .filter((b) => !b.supersededBy)
      .filter((b) => !chosen.has(keyOf(b.chainId, b.address)))
      .filter((b) => b.symbol.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle))
      .slice(0, 5)
  }, [all, chosen, needle])

  const shareable = legs.length >= 2
  const shareUrl = useMemo(() => {
    const params = encodeBundleParams({ legs, by: address ?? null, name: name.trim() || null } as BundleT)
    return `${typeof window !== 'undefined' ? window.location.origin : ''}/bundle?${params.toString()}`
  }, [legs, address, name])
  const forgeHref = `/bundle/new${legs.length > 0 ? `?add=${legs.map((l) => `${l.chainId}:${l.address}`).join(',')}` : ''}`
  const canPublish = !!registry && !!address && shareable && state !== 'busy'
  const chainLabel = CHAINS[chainId]?.name ?? chainId

  const bump = (i: number, d: number) => setLegs((prev) => prev.map((l, k) => (k === i ? { ...l, weight: Math.max(1, l.weight + d) } : l)))
  const remove = (i: number) => setLegs((prev) => prev.filter((_, k) => k !== i))
  const inputCls =
    'w-full rounded-xl border border-white/[0.14] bg-white/[0.05] px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-white/[0.3]'

  if (state === 'done' && slug && address) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-2.5 rounded-2xl border p-4" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)' }}>
        <p className="text-sm font-semibold text-ink">
          {name.trim() || 'Your bundle'} is PUBLISHED on {chainLabel}: {legs.length} baskets, one page, one buy flow.
        </p>
        <p className="text-[12px] text-ink-dim">It lists on your creator page and survives the share link being lost.</p>
        <CopyRow url={shareUrl} />
        {/* buttons BELOW the info, always */}
        <Link
          to={`/bundle/${address.toLowerCase()}/${slug}`}
          className="w-fit rounded-full border border-white/[0.16] bg-white/[0.06] px-4 py-2 text-sm text-ink transition-colors hover:border-white/[0.3]"
        >
          Open the bundle page →
        </Link>
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5 sm:min-w-[var(--chat-card-min,24rem)]">
      {/* the legs, visual first */}
      {legs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {legs.map((l, i) => (
            <div key={keyOf(l.chainId, l.address)} className="flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5">
              <BasketAvatar address={l.address} symbol={l.symbol} size={28} />
              <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">${showSymbol(l.symbol)}</span>
              <ChainBadge chainId={l.chainId} />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => bump(i, -10)}
                  aria-label={`Reduce ${showSymbol(l.symbol)} weight`}
                  className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.14] text-ink-dim transition-colors hover:border-white/[0.3] hover:text-ink"
                >
                  −
                </button>
                <span className="w-11 text-center font-mono text-sm text-ink">{Math.round(norm[i]?.pct ?? 0)}%</span>
                <button
                  type="button"
                  onClick={() => bump(i, +10)}
                  aria-label={`Increase ${showSymbol(l.symbol)} weight`}
                  className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.14] text-ink-dim transition-colors hover:border-white/[0.3] hover:text-ink"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${showSymbol(l.symbol)}`}
                className="grid h-7 w-7 place-items-center rounded-full text-ink-faint transition-colors hover:text-ink"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {/* grow the bundle: same list every builder picks from */}
      {!full && (
        <div className="flex flex-col gap-1.5">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={legs.length > 0 ? 'Add another basket, any chain' : 'Search a basket to start, any chain'} aria-label="Search baskets to add" className={inputCls} />
          {matches.map((b) => (
            <button
              key={keyOf(b.chainId, b.address)}
              type="button"
              onClick={() => {
                setLegs((prev) => [...prev, { chainId: b.chainId, address: b.address as Address, symbol: b.symbol, weight: 100 }])
                setQ('')
              }}
              className="flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-left transition-colors hover:border-white/[0.24]"
            >
              <BasketAvatar address={b.address} symbol={b.symbol} size={24} />
              <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">${showSymbol(b.symbol)}</span>
              <ChainBadge chainId={b.chainId} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">add +</span>
            </button>
          ))}
          {needle.length > 0 && matches.length === 0 && <p className="px-1 text-[12px] text-ink-faint">Nothing matches. It has to be a deployed basket.</p>}
        </div>
      )}
      {legs.length > 0 && <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} placeholder="Bundle name (optional)" aria-label="Bundle name" className={inputCls} />}
      {shareable && <CopyRow url={shareUrl} />}
      {state === 'busy' && <p className="text-[13px] text-ink-dim">Check your wallet to sign. One signature writes it on-chain.</p>}
      {error && <p className="text-[13px]" style={{ color: 'var(--color-alert)' }}>{error}</p>}
      {/* buttons BELOW the info, always */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={!canPublish}
          onClick={() => {
            if (!address) return
            void publish(address as Address, legs, name).then((s) => {
              if (s) {
                cheerSpecter()
                playSfx('happy', 0.3)
              }
            })
          }}
          className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
          style={{ background: GRADIENT }}
        >
          {state === 'busy' ? 'Working…' : `Publish on ${chainLabel}, your wallet signs`}
        </button>
      </div>
      {!shareable && <p className="text-[12px] text-ink-faint">Add {2 - legs.length} more basket{legs.length === 1 ? '' : 's'}: a bundle needs at least 2.</p>}
      {shareable && !address && <p className="text-[12px] text-ink-faint">Connect a wallet (top right) to publish. The copy link above works without one.</p>}
      {shareable && !!address && !registry && <p className="text-[12px] text-ink-faint">Publishing is not enabled on {chainLabel}. The copy link above still works.</p>}
      <p className="text-[12px] text-ink-faint">
        Not one token: buyers get each leg on its own chain. The{' '}
        <Link to={forgeHref} className="underline underline-offset-2 hover:text-ink">
          full builder
        </Link>{' '}
        has the hero view if you want it.
      </p>
    </div>
  )
}
