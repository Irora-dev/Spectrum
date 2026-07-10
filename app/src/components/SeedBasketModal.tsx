import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAccount } from 'wagmi'
import { SWAP_ENABLED } from '../lib/config/features'
import type { BasketData } from '../lib/spectrum/basket-data'
import { BasketBento } from './BasketBento'
import { DexSwapCard } from './DexSwapCard'

// ─────────────────────────────────────────────────────────────────────────────
// "Now seed it" (R+C 2026-07-06 18:26): a fresh basket is NOT tradable — on the
// site or on aggregators — until its creator makes the sandwich-protected first
// buy. So the moment the deploy lands on the basket page (?deployed=1), or any
// time the CREATOR views their still-unseeded basket, this pops: the bento +
// the real swap console, sized by their own wallet. Deliberately NO minimum
// anchored anywhere ("don't surface the minimum… you don't want to anchor
// low" — R); the console itself already blocks a first buy under 10 USDC with
// the honest reason if they try. Dismissible; re-offers on revisit while the
// basket stays unseeded (sessionStorage keeps one visit quiet).
// ─────────────────────────────────────────────────────────────────────────────

const dismissKey = (addr: string) => `spectrum:seed-dismissed:${addr.toLowerCase()}`

export function SeedBasketModal({ ix, chainId }: { ix: BasketData; chainId: number }) {
  const { address: viewer } = useAccount()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(dismissKey(ix.address)) === '1'
    } catch {
      return false
    }
  })

  const unseeded = ix.effectiveSupply === 0
  const isCreator = !!viewer && !!ix.deployer && viewer.toLowerCase() === ix.deployer.toLowerCase()
  const open = SWAP_ENABLED && unseeded && isCreator && !dismissed

  // Esc closes, like every other modal on the site.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = () => {
    setDismissed(true)
    try {
      sessionStorage.setItem(dismissKey(ix.address), '1')
    } catch {
      /* storage unavailable */
    }
  }

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto p-4" onClick={close}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Seed $${ix.symbol}`}
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative my-8 w-full max-w-lg overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full shrink-0" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">✓ Basket created</div>
              <h2 className="mt-1 font-display text-3xl font-bold tracking-tight text-ink">Now seed ${ix.symbol}</h2>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="press grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>

          {/* Short + readable (owner 2026-07-07: "less text, bigger text"). */}
          <p className="mt-3 text-base leading-relaxed text-ink-dim">
            Your first buy initializes the pool, sandwich-protected, and makes ${ix.symbol} tradable —
            here and on aggregators. Seed it with any amount.
          </p>

          <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/25 p-2.5">
            <BasketBento
              items={ix.holdings.map((h) => ({ symbol: h.symbol, address: h.asset, weightPct: h.targetWeightPct, chainId }))}
              aspect={2.6}
            />
          </div>

          <div className="mt-4">
            <DexSwapCard chainId={chainId} fixedBasket={ix} defaultHub="USDC" />
          </div>

          <button
            type="button"
            onClick={close}
            className="press mt-3 w-full py-2 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint transition-colors hover:text-ink"
          >
            I&rsquo;ll seed it later
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
