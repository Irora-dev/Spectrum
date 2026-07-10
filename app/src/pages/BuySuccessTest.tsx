import { useState } from 'react'
import { SwapPendingOverlay } from '../components/SwapPendingOverlay'
import type { DexStep, DexTxState } from '../lib/spectrum/use-dex-swap'

// DEV-only design-review page for the buy-success bento popup (owner ask
// 2026-07-09: "after buying, replace the buy success with a pop-up grid of the
// bento you've just bought + handy buttons"). Mounts the REAL SwapPendingOverlay
// in its done state on canned data — same component the live buy renders, so
// what's approved here is what ships. Never in production builds (DEV route,
// like /post-deploy-test). Controls float above the overlay to flip the cases.

// Obviously-synthetic tx hash — the explorer link 404s by design (canned data).
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111'

// Real Base token addresses (the dev fixture's own set) so AssetLogo art resolves.
const BASKETS = {
  'Blue-chip (3)': {
    symbol: 'DEVBKT',
    items: [
      { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', weightPct: 40, chainId: 8453 },
      { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', weightPct: 35, chainId: 8453 },
      { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', weightPct: 25, chainId: 8453 },
    ],
  },
  'Memes (2)': {
    symbol: 'DEVTWO',
    items: [
      { symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', weightPct: 50, chainId: 8453 },
      { symbol: 'BRETT', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', weightPct: 50, chainId: 8453 },
    ],
  },
  'Wide (6)': {
    symbol: 'AGENTS',
    items: [
      { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', weightPct: 30, chainId: 8453 },
      { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', weightPct: 22, chainId: 8453 },
      { symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', weightPct: 18, chainId: 8453 },
      { symbol: 'BRETT', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', weightPct: 12, chainId: 8453 },
      { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', weightPct: 10, chainId: 8453 },
      { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', weightPct: 8, chainId: 8453 },
    ],
  },
} as const
type BasketKey = keyof typeof BASKETS

const STEPS: DexStep[] = [
  { key: 'hub-in', label: 'Swap ETH → USDC' },
  { key: 'approve-usdc', label: 'Approve USDC' },
  { key: 'spectrum', label: 'Buy $DEVBKT' },
]
const TX_DONE: DexTxState = { status: 'success', hash: TX, error: null }

export function BuySuccessTest() {
  const [open, setOpen] = useState(true)
  const [basket, setBasket] = useState<BasketKey>('Blue-chip (3)')
  const [seeding, setSeeding] = useState(false)
  const [withShare, setWithShare] = useState(true)
  const [withUsd, setWithUsd] = useState(true)
  const b = BASKETS[basket]

  // Mirrors DexSwapCard's swapShare composition exactly, so clicking Share on X
  // here opens the REAL tweet text for review.
  const shareUrl = `${window.location.origin}/token?addr=0x0000000000000000000000000000000000ba5e01&chain=8453&ref=0x00000000000000000000000000000000000ef111`
  const share = withShare
    ? {
        url: shareUrl,
        xHref: `https://twitter.com/intent/tweet?text=${encodeURIComponent(`I just added $${b.symbol} to my portfolio, take a look`)}&url=${encodeURIComponent(shareUrl)}`,
      }
    : null

  const chip = (on: boolean) =>
    `press rounded-lg border px-3 py-1.5 font-mono text-[11px] ${on ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-white/15 text-ink-dim hover:border-white/35'}`

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-ink">Buy-success popup — design review</h1>
      <p className="mt-2 font-mono text-xs leading-relaxed text-ink-dim">
        The real SwapPendingOverlay in its done state on canned data. The floating bar (top left)
        flips the cases; Done / backdrop closes it, Reopen brings it back. DEV-only route.
      </p>

      {/* controls — float ABOVE the overlay portal (z-[95]) so they stay usable */}
      <div className="fixed left-4 top-4 z-[100] flex flex-wrap items-center gap-2 rounded-2xl border border-white/15 bg-void/90 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.7)] backdrop-blur-md">
        {(Object.keys(BASKETS) as BasketKey[]).map((k) => (
          <button key={k} type="button" onClick={() => setBasket(k)} className={chip(basket === k)}>
            {k}
          </button>
        ))}
        <span aria-hidden className="mx-1 h-5 w-px bg-white/15" />
        <button type="button" onClick={() => setSeeding((v) => !v)} className={chip(seeding)}>
          seeding
        </button>
        <button type="button" onClick={() => setWithShare((v) => !v)} className={chip(withShare)}>
          share row
        </button>
        <button type="button" onClick={() => setWithUsd((v) => !v)} className={chip(withUsd)}>
          $ line
        </button>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className={chip(false)}>
            ↻ Reopen
          </button>
        )}
      </div>

      <SwapPendingOverlay
        open={open}
        dir="buy"
        symbol={b.symbol}
        steps={STEPS}
        txOf={() => TX_DONE}
        running={false}
        done={{ hash: TX }}
        error={null}
        explorer="https://basescan.org"
        onClose={() => setOpen(false)}
        token={{ address: '0x0000000000000000000000000000000000ba5e01', chainId: 8453 }}
        seeding={seeding}
        constituents={b.items.map((i) => ({ address: i.address, symbol: i.symbol }))}
        share={share}
        bentoItems={[...b.items]}
        decimals={18}
        usdRaw={withUsd ? 250_000_000n : null}
        previewWallet
      />
    </div>
  )
}
