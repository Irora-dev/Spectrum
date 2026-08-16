import { useEffect, useState } from 'react'
import { useAccount, useReadContract, useWalletClient } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import { showSymbol } from '../lib/spectrum/safe-copy'

// "Add to wallet" (owner pick, adoption toolkit 2026-07-06 #4): asks the
// connected wallet to track the basket ERC-20 (`wallet_watchAsset`), so a
// freshly bought basket doesn't vanish from view. Renders nothing without a
// wallet; disabled (with the reason) when the wallet sits on another chain,
// because the asset would land on the wrong network's token list.
//
// Surfacing rule (owner 2026-07-06): only people who OWN the token see it —
// one balanceOf read gates it (`requireBalance`, the default). The swap
// overlay passes requireBalance={false} at the you-just-bought moment.

/** Does the connected wallet hold this token? One eth_call; in DEV the
 *  fixture's mock balances stand in (demo baskets have no contracts). */
function useOwnsToken(address: string, chainId: number, enabled: boolean): boolean {
  const { address: viewer } = useAccount()
  const { data: bal } = useReadContract({
    address: address as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: viewer ? [viewer] : undefined,
    chainId,
    query: { enabled: enabled && !!viewer, retry: false },
  })
  const [devOwned, setDevOwned] = useState(false)
  useEffect(() => {
    if (!import.meta.env.DEV || !enabled) return
    let stale = false
    void import('../lib/spectrum/dev-fixture')
      .then(({ devUserHoldings }) => {
        const m = devUserHoldings([{ address, chainId }])
        if (!stale) setDevOwned(!!m?.get(address.toLowerCase()))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [address, chainId, enabled])
  return (bal != null && bal > 0n) || devOwned
}

export function AddToWalletButton({
  address,
  symbol,
  decimals = 18,
  chainId,
  variant = 'chip',
  requireBalance = true,
  preview = false,
  size = 'md',
}: {
  address: string
  symbol: string
  decimals?: number
  chainId: number
  variant?: 'chip' | 'icon'
  /** false = show regardless of holdings (the just-bought moment). */
  requireBalance?: boolean
  /** DEV design-review only: render the chip without a wallet (clicks no-op). */
  preview?: boolean
  /** 'lg' = the buy-success popup's roomier chip (owner 2026-07-09). */
  size?: 'md' | 'lg'
}) {
  const { isConnected, chainId: walletChainId } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const owned = useOwnsToken(address, chainId, requireBalance && isConnected && !preview)

  if (!preview) {
    if (!isConnected || !walletClient) return null
    if (requireBalance && !owned) return null
  }
  const wrongChain = !preview && walletChainId !== chainId

  const add = async () => {
    // 'failed' stays clickable on purpose — that chip IS the retry affordance.
    if (state === 'busy' || state === 'done' || wrongChain) return
    if (preview || !walletClient) return // design-review chip is inert
    setState('busy')
    try {
      await walletClient.watchAsset({
        type: 'ERC20',
        // ⚠ THE WALLET RENDERS THIS, NOT US — the one string we hand somewhere
        // we cannot escape or bound afterwards. The ticker is deployer-set, so
        // a bidi override or a newline would land inside MetaMask's own "Add
        // suggested token" dialog. showSymbol makes it inert first; the slice
        // then caps at watchAsset's 11 and now runs on cleaned text, so it can
        // no longer halve a surrogate pair either. Audit 2026-08-07.
        options: { address: address as Address, symbol: showSymbol(symbol).slice(0, 11), decimals },
      })
      setState('done')
      window.setTimeout(() => setState('idle'), 2000)
    } catch {
      // Declined, or the wallet has no watchAsset. The old quiet reset to idle
      // was pixel-identical to never having tapped — on the buy-success overlay
      // of all places (audit 2026-08-07). "Not added" is honest for both cases
      // without shouting at someone who simply said no; it falls back so the
      // chip stays usable (guarded — a retry may already have moved state on).
      setState('failed')
      window.setTimeout(() => setState((s) => (s === 'failed' ? 'idle' : s)), 4000)
    }
  }

  const title = wrongChain
    ? 'Switch your wallet to this chain first'
    : state === 'failed'
      ? `$${showSymbol(symbol)} wasn’t added — tap to try again`
      : `Track $${showSymbol(symbol)} in your wallet`
  const glyphSize = size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'
  const glyph =
    state === 'done' ? (
      <svg viewBox="0 0 24 24" className={`${glyphSize} text-teal`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6L9 17l-5-5" />
      </svg>
    ) : state === 'failed' ? (
      // Its own mark, not just a tint: in the icon variant color is the ONLY
      // other channel, and color alone can't carry "this didn't happen".
      <svg viewBox="0 0 24 24" className={glyphSize} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M8.8 15.2l6.4-6.4" />
      </svg>
    ) : (
      <svg viewBox="0 0 24 24" className={glyphSize} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
        <path d="M16 12.5h2.5M2.5 9.5h19" />
      </svg>
    )

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={add}
        disabled={wrongChain || state === 'busy'}
        title={title}
        aria-label={title}
        className={`pointer-events-auto grid h-9 w-9 shrink-0 place-items-center rounded-xl border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          state === 'failed'
            ? 'border-amber/30 bg-amber/[0.06] text-amber'
            : 'border-white/12 text-ink-dim hover:border-white/30 hover:text-ink'
        }`}
      >
        {glyph}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={add}
      disabled={wrongChain || state === 'busy'}
      title={title}
      className={`press inline-flex items-center gap-1.5 border font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        state === 'failed'
          ? 'border-amber/30 bg-amber/[0.06] text-amber'
          : 'border-white/10 bg-white/[0.04] text-ink-dim hover:border-cyan/50 hover:text-ink'
      } ${size === 'lg' ? 'rounded-lg px-4 py-2 text-xs' : 'rounded-md px-2 py-1 text-[11px]'}`}
    >
      {glyph}
      {state === 'done' ? 'Added' : state === 'busy' ? 'Confirm…' : state === 'failed' ? 'Not added' : 'Add to wallet'}
    </button>
  )
}
