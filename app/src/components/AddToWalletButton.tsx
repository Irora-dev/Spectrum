import { useEffect, useState } from 'react'
import { useAccount, useReadContract, useWalletClient } from 'wagmi'
import { erc20Abi, type Address } from 'viem'

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
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const owned = useOwnsToken(address, chainId, requireBalance && isConnected && !preview)

  if (!preview) {
    if (!isConnected || !walletClient) return null
    if (requireBalance && !owned) return null
  }
  const wrongChain = !preview && walletChainId !== chainId

  const add = async () => {
    if (state !== 'idle' || wrongChain) return
    if (preview || !walletClient) return // design-review chip is inert
    setState('busy')
    try {
      await walletClient.watchAsset({
        type: 'ERC20',
        // watchAsset caps symbols at 11 chars; basket symbols already comply
        options: { address: address as Address, symbol: symbol.slice(0, 11), decimals },
      })
      setState('done')
      window.setTimeout(() => setState('idle'), 2000)
    } catch {
      // user declined or the wallet doesn't support it — quietly reset
      setState('idle')
    }
  }

  const title = wrongChain ? 'Switch your wallet to this chain first' : `Track $${symbol} in your wallet`
  const glyphSize = size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'
  const glyph =
    state === 'done' ? (
      <svg viewBox="0 0 24 24" className={`${glyphSize} text-teal`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6L9 17l-5-5" />
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
        className="pointer-events-auto grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/12 text-ink-dim transition-colors hover:border-white/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
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
      className={`press inline-flex items-center gap-1.5 border border-white/10 bg-white/[0.04] font-mono text-ink-dim transition-colors hover:border-cyan/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${
        size === 'lg' ? 'rounded-lg px-4 py-2 text-xs' : 'rounded-md px-2 py-1 text-[11px]'
      }`}
    >
      {glyph}
      {state === 'done' ? 'Added' : state === 'busy' ? 'Confirm…' : 'Add to wallet'}
    </button>
  )
}
