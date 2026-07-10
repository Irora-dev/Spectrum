import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { SWAP_ENABLED } from '../lib/config/features'
import { setActiveChainId, useActiveChain } from '../lib/chain/active-chain'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { useAllBaskets, useCreatorMeta } from '../lib/spectrum/hooks'
import { formatNav, formatUsdCompact } from '../lib/spectrum/format'
import { DexSwapCard } from '../components/DexSwapCard'
import { PageHeader } from '../components/PageHeader'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'

// ─────────────────────────────────────────────────────────────────────────────
// /swap — the DEX-style console over the whole basket directory. The console
// itself is DexSwapCard (shared with the Token page's fixed-basket variant);
// this page is the roomy standalone frame: ambient aurora, header, the
// ?basket=&chain= deep link, and — from lg up — the IDENTITY PANEL beside the
// console (owner 2026-07-07 15:4x UX pass: you're buying a whole thesis, the
// page should show it: wash, constituents, NAV/TVL, the creator's tagline).
// ─────────────────────────────────────────────────────────────────────────────

export function Swap() {
  if (!SWAP_ENABLED) return <Navigate to="/" replace />
  return <SwapPage />
}

function SwapPage() {
  const [params] = useSearchParams()
  const { chainId } = useActiveChain()
  const [selected, setSelected] = useState<string | null>(null)

  const paramBasket = params.get('basket')
  const paramChain = Number(params.get('chain'))
  useEffect(() => {
    if (paramChain && paramChain !== chainId) setActiveChainId(paramChain)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative">
      {/* ambient aurora */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-visible">
        <div className="absolute left-1/2 top-8 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-violet/12 blur-[130px]" />
        <div className="absolute left-[12%] top-40 h-64 w-64 rounded-full bg-cyan/10 blur-[110px]" />
        <div className="absolute right-[10%] top-64 h-64 w-64 rounded-full bg-magenta/10 blur-[120px]" />
      </div>

      <div className="mx-auto w-full max-w-5xl pt-4">
        {/* header (owner 13:46): "Trade" eyebrow gone, title at the Launch
            page's size, the sub is one plain line, and the chain chip grew
            into a real Ethereum ⇄ Base toggle */}
        <PageHeader
          className="mb-6 px-1"
          size="lg"
          title="Swap"
          sub="Any basket, straight from ETH, WETH or USDC."
          actions={
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
              {[...SUPPORTED_CHAIN_IDS].reverse().map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveChainId(id)}
                  aria-pressed={chainId === id}
                  className={`press rounded-full px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                    chainId === id ? 'bg-white/10 text-ink' : 'text-ink-faint hover:text-ink-dim'
                  }`}
                >
                  {CHAINS[id].name}
                </button>
              ))}
            </div>
          }
        />

        {/* console LEFT · what-you're-buying RIGHT (stacks on mobile, panel
            below the console so the money controls stay first) */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-8">
          <DexSwapCard chainId={chainId} initialBasket={paramBasket} large onBasketChange={setSelected} />
          <BasketContextPanel address={selected} chainId={chainId} />
        </div>
      </div>
    </div>
  )
}

// ── the identity panel: the thesis-first face of whatever the console is on ──
function BasketContextPanel({ address, chainId }: { address: string | null; chainId: number }) {
  const { data: all } = useAllBaskets()
  const { data: meta } = useCreatorMeta(address ?? undefined, chainId)
  const b = address
    ? (all ?? []).find((x) => x.chainId === chainId && x.address.toLowerCase() === address.toLowerCase())
    : undefined
  if (!b) return null

  const top = [...b.top].sort((a, y) => y.weightPct - a.weightPct)
  return (
    <aside className="relative hidden overflow-hidden rounded-3xl border border-white/12 bg-white/[0.02] backdrop-blur-md lg:sticky lg:top-24 lg:block">
      {/* the basket's own color field */}
      <BasketWash ix={b} side="right" opacity={0.3} />

      <div className="relative p-6">
        <div className="flex items-center gap-3">
          <BasketAvatar address={b.address} symbol={b.symbol} size={44} />
          <div className="min-w-0">
            <div className="truncate font-display text-xl font-bold uppercase tracking-tight text-ink">{b.name}</div>
            <div className="font-mono text-xs text-ink-dim">${b.symbol}</div>
          </div>
        </div>

        {meta?.tagline && (
          <p className="mt-4 font-display text-lg font-semibold leading-snug text-ink">{meta.tagline}</p>
        )}

        {/* the facts row — NAV · 24h · TVL, spread across the width (owner 15:32) */}
        <div className="mt-4 flex items-end justify-between gap-6 border-t border-white/10 pt-4 pr-2 sm:pr-6">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">NAV</div>
            <div className="mt-1 font-num text-xl font-light tabular-nums text-ink">${formatNav(b.navPerToken)}</div>
          </div>
          {b.change24hPct != null && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">24h</div>
              <div className={`mt-1 font-num text-xl font-light tabular-nums ${b.change24hPct >= 0 ? 'text-teal' : 'text-magenta'}`}>
                {b.change24hPct >= 0 ? '+' : ''}
                {b.change24hPct.toFixed(1)}%
              </div>
            </div>
          )}
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">TVL</div>
            <div className="mt-1 font-num text-xl font-light tabular-nums text-ink">{formatUsdCompact(b.aumUsd)}</div>
          </div>
        </div>

        {/* what's inside — the bento, not a text list (owner 15:32: "the
            little bento grid there instead, rather than more text") */}
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">Holds</div>
          <div className="mt-2.5">
            <BasketBento
              items={top.map((h) => ({ symbol: h.symbol, address: h.address, weightPct: h.weightPct, chainId: b.chainId }))}
              aspect={1.7}
            />
          </div>
        </div>

        <Link
          to={`/token?addr=${b.address}&chain=${b.chainId}`}
          className="press mt-5 block rounded-xl border border-white/15 py-2.5 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
        >
          View the basket →
        </Link>
      </div>
    </aside>
  )
}
