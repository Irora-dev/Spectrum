import { useSearchParams } from 'react-router-dom'
import { DEFAULT_CHAIN_ID } from '../lib/chain/chains'
import { useAllBaskets, useCreatorMeta } from '../lib/spectrum/hooks'
import { resolveCreator } from '../lib/spectrum/creator'
import { perfMeasurable, perfToDate } from '../lib/spectrum/leaderboard'
import { formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'

// ─────────────────────────────────────────────────────────────────────────────
// /embed?addr=&chain= — the embeddable basket card (adoption toolkit
// 2026-07-06 #4, v1): a compact, read-only card creators drop on their own
// sites via iframe (the ShareModal copies the snippet). Chrome-less (Layout
// bypasses nav/footer for this route), everything links out to the basket's
// page in a new tab. Read-only by design — the buy path stays on the site.
// Perf shows only above the measurable-TVL floor (§9).
// ─────────────────────────────────────────────────────────────────────────────

function pctColor(p: number): string {
  return p >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)'
}

export function Embed() {
  const [params] = useSearchParams()
  const addr = (params.get('addr') ?? '').toLowerCase()
  const chainId = Number(params.get('chain')) || DEFAULT_CHAIN_ID
  const { data, isLoading } = useAllBaskets()
  const ix = (data ?? []).find((b) => b.chainId === chainId && b.address.toLowerCase() === addr)
  const { data: meta } = useCreatorMeta(ix?.address, ix?.chainId)

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center p-3">
        <div className="h-[440px] w-full max-w-[400px] animate-pulse rounded-2xl border border-white/10 bg-white/[0.02]" />
      </div>
    )
  }
  if (!ix) {
    return (
      <div className="grid min-h-screen place-items-center p-3">
        <div className="w-full max-w-[400px] rounded-2xl border border-dashed border-white/12 p-8 text-center font-mono text-xs text-ink-faint">
          Basket not found on this network.
        </div>
      </div>
    )
  }

  const identity = resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: ix.deployer ?? undefined })
  const tagline = meta?.tagline || meta?.thesis || null
  // Embed & earn (owner 2026-07-07): the card carries the embedder's ?ref (set on
  // its own iframe src by the ShareModal snippet), so a viewer who clicks through
  // and buys tags the embedder for the interface slice. The ref is validated on
  // capture by the main app — here it's an opaque pass-through.
  const refParam = params.get('ref')?.trim()
  const tokenUrl = `${window.location.origin}/token?addr=${ix.address}&chain=${ix.chainId}${refParam ? `&ref=${encodeURIComponent(refParam)}` : ''}`

  return (
    <div className="grid min-h-screen place-items-center p-3">
      <a
        href={tokenUrl}
        target="_blank"
        rel="noreferrer"
        className="relative block w-full max-w-[400px] overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition-colors hover:border-white/25"
      >
        <BasketWash ix={ix} opacity={0.3} />
        <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />

        <div className="relative flex items-center gap-3 pt-1">
          <BasketAvatar address={ix.address} symbol={ix.symbol} size={40} />
          <div className="min-w-0 flex-1">
            <div className="font-display text-xl font-bold leading-tight text-ink">${ix.symbol}</div>
            <div className="truncate text-xs text-ink-dim">
              {ix.name?.trim() || ''} · by {identity.label}
            </div>
          </div>
        </div>

        {tagline && <p className="relative mt-3 line-clamp-2 font-display text-[14px] font-semibold leading-snug text-ink">{tagline}</p>}

        <div className="relative mt-3 overflow-hidden rounded-xl border border-white/10 bg-black/25 p-2">
          <BasketWash ix={ix} side="full" opacity={0.3} />
          <BasketBento
            items={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: ix.chainId }))}
            aspect={1.9}
          />
        </div>

        <div className="relative mt-3.5 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2.5">
            {perfMeasurable(ix) &&
              (() => {
                const p = perfToDate(ix) * 100
                const c = pctColor(p)
                return (
                  <span
                    className="inline-flex items-baseline gap-1 rounded-full border px-2 py-0.5 font-num text-xs font-semibold tabular-nums"
                    style={{ color: c, background: `${c}1a`, borderColor: `${c}33` }}
                  >
                    {Math.abs(p) >= 1000 ? `${p >= 0 ? '+' : ''}${Math.round(p).toLocaleString()}%` : formatPct(p)}
                    <span className="font-mono text-[8px] uppercase tracking-[0.08em] opacity-75">to date</span>
                  </span>
                )
              })()}
            <span className="font-mono text-[10px] text-ink-faint">
              <span className="tabular-nums text-ink-dim">{formatUsdCompact(ix.aumUsd)}</span> TVL
            </span>
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-cyan">View on Spectrum →</span>
        </div>

        <p className="relative mt-2.5 font-mono text-[8px] leading-relaxed text-ink-faint">
          Past performance is not indicative of future results.
        </p>
      </a>
    </div>
  )
}
