import { useEffect, useMemo, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import type { BasketData } from '../lib/spectrum/basket-data'
import {
  clampSlippageBps,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  WARN_SLIPPAGE_BPS,
} from '../lib/spectrum/hook-data'
import { buildSwapQuote, type SwapQuote } from '../lib/spectrum/swap-quote'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { useBasketSwap, type Side, type TxState } from '../lib/spectrum/use-basket-swap'
import { SWAP_ENABLED } from '../lib/config/features'
import { chainCfg } from '../lib/chain/chains'
import { formatNav, shortAddr } from '../lib/spectrum/format'

// Mint/redeem preview + buy/sell, gated behind SWAP_ENABLED (default OFF — buy/sell
// needs a separately-deployed swap router; see OPERATORS.md). The math shown is the
// math that would be signed: fees come from the per-basket on-chain readout
// (never hardcoded), and the per-leg minimums preview mirrors hook-data.ts —
// the single encoder every transactional path must use. There is no
// "disable slippage protection" option, by design.
export function TradePanel({ ix, sig, buyInk }: { ix: BasketData; sig: string; buyInk: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS)
  const [customSlip, setCustomSlip] = useState('')
  const [showLegs, setShowLegs] = useState(false)
  const { data: fees } = useBasketFees(ix.address, ix.chainId)

  const feeFrac = fees ? fees.basketFeeBps / 10_000 : null
  const amt = parseFloat(amount)
  const valid = isFinite(amt) && amt > 0 && ix.navPerToken > 0 && feeFrac != null
  const out = !valid
    ? 0
    : side === 'buy'
      ? (amt * (1 - (feeFrac as number))) / ix.navPerToken
      : amt * ix.navPerToken * (1 - (feeFrac as number))
  const feeAmt = valid ? amt * (feeFrac as number) : 0
  const minOut = valid ? out * (1 - slippageBps / 10_000) : 0

  const inUnit = side === 'buy' ? 'USDC' : `$${ix.symbol}`
  const outUnit = side === 'buy' ? `$${ix.symbol}` : 'USDC'

  // The broadcast-grade swap inputs + per-leg minimums — ONE source for the
  // preview and the signed tx (legMin = quotedLeg × (1 − slippage), exactly as
  // hook-data.ts encodes). null when the quote is incomplete (any leg unpriced or
  // an amount that rounds to zero) ⇒ no swap is encodable and the button stays
  // disabled. The signed values are the latest *rendered* quote (the basket data is
  // background-polled, not re-read on click); the click-time on-chain simulate
  // reverts if any committed minimum can no longer be met, so what is shown is what
  // is signed and a stale leg fails closed rather than fills badly.
  const trade = useMemo<SwapQuote | null>(() => {
    if (!valid) return null
    // ONE source for the preview AND the signed tx — the Tier-1 floor derivation
    // (swap-quote.ts): independent-priced, decimals-correct, basket-ordered, non-zero
    // per-leg floors, refusing any unprotectable quote (→ null ⇒ the button stays
    // disabled). The signed values are the latest *rendered* quote; the binding
    // staleness backstop is the click-time on-chain simulate in use-basket-swap (a
    // committed minimum that can no longer be met reverts before the wallet prompt).
    return buildSwapQuote({
      side,
      amount: amt,
      navPerToken: ix.navPerToken,
      feeFrac: feeFrac as number,
      slippageBps,
      holdings: ix.holdings,
      basketDecimals: ix.decimals,
    })
  }, [valid, side, amt, ix, slippageBps, feeFrac])

  const legPreview = trade?.legs ?? []

  // FIRST-BUY SEED MINIMUM — SpectrumBasket.sol MIN_FIRST_DEPOSIT (10 USDC, an
  // internal constant with no getter; the click-time simulate is the binding
  // backstop if it ever drifts). A fresh basket's first mint seeds its reserves
  // and reverts InsufficientFirstDeposit below this, so refuse the doomed tx up
  // front with words instead of a wrapped hex selector.
  const SEED_MIN_USDC = 10
  const belowSeedMin = side === 'buy' && valid && ix.effectiveSupply === 0 && amt < SEED_MIN_USDC
  const armedTrade = belowSeedMin ? null : trade

  const swap = useBasketSwap(ix)
  // A broadcast in flight: the inputs (side toggle + amount) are locked while this
  // is true, so the trade parameters can't change mid-tx — closing the
  // double-submit window and keeping the status line attached to the trade that is
  // actually signing.
  const txBusy =
    swap.approveState.status === 'signing' ||
    swap.approveState.status === 'confirming' ||
    swap.swapState.status === 'signing' ||
    swap.swapState.status === 'confirming'
  // Clear any prior tx status when the side or amount changes materially, so a
  // lingering "done" / error never attaches to a different trade. Only reachable
  // when not busy — the inputs are disabled in flight (above).
  useEffect(() => {
    swap.reset()
  }, [side, amount, swap.reset])

  const applyCustom = (raw: string) => {
    setCustomSlip(raw)
    const pct = parseFloat(raw)
    if (isFinite(pct) && pct > 0) setSlippageBps(clampSlippageBps(Math.round(pct * 100)))
  }
  const customActive = slippageBps !== 50 && slippageBps !== 100

  return (
    <div className="rounded-2xl border border-white/12 bg-white/[0.03] p-4">
      {/* side toggle */}
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            disabled={txBusy}
            className={`press rounded-md py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50 ${
              side === s ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* amount in */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          <span>{side === 'buy' ? 'You pay' : 'You sell'}</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-void/40 px-3 py-2.5 focus-within:border-cyan/50">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={txBusy}
            className="min-w-0 flex-1 bg-transparent font-num text-xl tabular-nums text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
          />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-dim">{inUnit}</span>
        </div>
      </div>

      {/* estimated out */}
      <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">You receive (est.)</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-num text-xl tabular-nums text-ink">{valid ? formatNav(out, side === 'buy' ? 4 : 2) : '0.0'}</span>
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">{outUnit}</span>
        </div>
      </div>

      {/* slippage tolerance — always-on per-leg protection; no off switch exists */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          <span>Slippage tolerance</span>
          <span className="tabular-nums text-ink-dim">{(slippageBps / 100).toFixed(2)}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          {[
            { bps: 50, label: '0.5%' },
            { bps: 100, label: '1%' },
          ].map((p) => (
            <button
              key={p.bps}
              type="button"
              onClick={() => {
                setSlippageBps(p.bps)
                setCustomSlip('')
              }}
              className={`press rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
                slippageBps === p.bps && !customActive
                  ? 'border-cyan/60 text-cyan'
                  : 'border-white/12 text-ink-dim hover:text-ink'
              }`}
            >
              {p.label}
            </button>
          ))}
          <div
            className={`flex items-center rounded-md border px-2 py-1 ${
              customActive ? 'border-cyan/60' : 'border-white/12'
            }`}
          >
            <input
              value={customSlip}
              onChange={(e) => applyCustom(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="custom"
              inputMode="decimal"
              aria-label="Custom slippage percent"
              className="w-14 bg-transparent text-right font-num text-[11px] tabular-nums text-ink outline-none placeholder:text-ink-faint"
            />
            <span className="ml-0.5 font-mono text-[10px] text-ink-dim">%</span>
          </div>
        </div>
        {slippageBps > WARN_SLIPPAGE_BPS && (
          <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-alert">
            High slippage tolerance widens the worst-case fill on every leg. Cap is{' '}
            {(MAX_SLIPPAGE_BPS / 100).toFixed(0)}%.
          </p>
        )}
      </div>

      {/* details */}
      <dl className="mt-3 space-y-1.5 font-mono text-[11px] text-ink-faint">
        <div className="flex justify-between">
          <dt>Price</dt>
          <dd className="tabular-nums text-ink-dim">1 ${ix.symbol} = ${formatNav(ix.navPerToken)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Fee{fees ? ` (${(fees.basketFeeBps / 100).toFixed(2)}%)` : ''}</dt>
          <dd className="tabular-nums text-ink-dim">
            {valid ? `${formatNav(feeAmt, 2)} ${inUnit}` : fees ? '—' : 'read per basket'}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Minimum received</dt>
          <dd className="tabular-nums text-ink-dim">{valid ? `${formatNav(minOut, side === 'buy' ? 4 : 2)} ${outUnit}` : '—'}</dd>
        </div>
      </dl>

      {/* per-leg minimums — what the signature actually commits to */}
      {legPreview.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowLegs((v) => !v)}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink"
            aria-expanded={showLegs}
          >
            {showLegs ? '▾' : '▸'} Per-leg minimums ({legPreview.length})
          </button>
          {showLegs && (
            <dl className="mt-1.5 space-y-1 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 font-mono text-[10px] text-ink-faint">
              {legPreview.map((l) => (
                <div key={l.symbol} className="flex justify-between">
                  <dt>{l.symbol}</dt>
                  <dd className="tabular-nums text-ink-dim">
                    ≥ {formatNav(Number(l.min) / 10 ** l.decimals, 4)}
                  </dd>
                </div>
              ))}
              <p className="pt-1 text-[9px] leading-relaxed">
                Every transaction encodes a minimum for every leg, there is no unprotected path.
              </p>
            </dl>
          )}
        </div>
      )}

      {/* action — approve→buy/sell when an operator's build has TRADING_ENABLED +
          a swap router configured; otherwise the inert preview affordance. The
          hook hard-blocks the broadcast regardless of this UI. */}
      {belowSeedMin && (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          This is ${ix.symbol}&rsquo;s FIRST buy, it seeds the basket&rsquo;s reserves, and the contract
          requires at least {SEED_MIN_USDC} USDC for it. Smaller buys work fine after that.
        </div>
      )}
      <SwapAction
        side={side}
        symbol={ix.symbol}
        sig={sig}
        buyInk={buyInk}
        trade={armedTrade}
        slippageBps={slippageBps}
        swap={swap}
        explorer={chainCfg(ix.chainId).explorer}
        chainName={chainCfg(ix.chainId).name}
        chainId={ix.chainId}
      />
    </div>
  )
}

// The action button + tx status. Three states, in order: (1) inert preview —
// no trading flag or no router configured (the shipped/info build); (2) connect —
// trading build, no wallet on the right chain; (3) live — exact-amount approve of
// tokenIn to the router on the first trade, then buy/sell. Per-leg + aggregate
// minimums are committed in every broadcast (hook-data.ts); there is no
// unprotected path.
function SwapAction({
  side, symbol, sig, buyInk, trade, slippageBps, swap, explorer, chainName, chainId,
}: {
  side: Side
  symbol: string
  sig: string
  buyInk: string
  trade: SwapQuote | null
  slippageBps: number
  swap: ReturnType<typeof useBasketSwap>
  explorer: string
  chainName: string
  chainId: number
}) {
  const label = side === 'buy' ? `Buy $${symbol}` : `Sell $${symbol}`
  const inUnit = side === 'buy' ? 'USDC' : `$${symbol}`
  const baseBtn =
    'mt-4 w-full rounded-lg px-6 py-3 font-mono text-xs font-bold uppercase tracking-[0.15em]'

  // (1) Inert — preview-only when swap is not enabled (the default) or no router is
  // configured. Preserves the affordance the flagless build has always shown.
  if (!SWAP_ENABLED || !swap.configured) {
    return (
      <>
        <button
          type="button"
          disabled
          title="Trading broadcast is not wired on this build"
          className={`${baseBtn} cursor-not-allowed opacity-60`}
          style={{ background: sig, color: buyInk }}
        >
          {label}
        </button>
        <div className="mt-2 text-center font-mono text-[9px] uppercase tracking-wider text-ink-faint">
          Preview only, this build does not broadcast transactions
        </div>
      </>
    )
  }

  // (2) Trading build, wallet not ready. A CONNECTED wallet on the wrong network
  // gets an actionable switch button — a disabled buy with a footnote read as
  // "broken" in testing. Only a truly disconnected wallet shows the connect hint.
  if (!swap.walletReady) {
    return <WalletNotReady label={label} chainName={chainName} chainId={chainId} sig={sig} buyInk={buyInk} baseBtn={baseBtn} />
  }

  // (3) Live.
  const approving = swap.approveState.status === 'signing' || swap.approveState.status === 'confirming'
  const swapping = swap.swapState.status === 'signing' || swap.swapState.status === 'confirming'
  const busy = approving || swapping
  const needApprove = !!trade && swap.needsApproval(side, trade.amountRaw)

  const onClick = () => {
    if (!trade) return
    if (needApprove) {
      swap.approve(side, trade.amountRaw)
      return
    }
    swap.swap({
      side,
      amountRaw: trade.amountRaw,
      quotedLegAmounts: trade.quotedLegAmounts,
      legCount: trade.legCount,
      minOutRaw: trade.minOutRaw,
      slippageBps,
    })
  }

  const btnLabel = !trade
    ? label
    : approving
      ? 'Approving…'
      : swapping
        ? side === 'buy'
          ? 'Buying…'
          : 'Selling…'
        : needApprove
          ? `Approve ${inUnit}`
          : label

  return (
    <>
      <button
        type="button"
        disabled={!trade || busy}
        onClick={onClick}
        className={`${baseBtn} transition-opacity disabled:cursor-not-allowed disabled:opacity-50`}
        style={{ background: sig, color: buyInk }}
      >
        {btnLabel}
      </button>
      {needApprove && trade && !busy && (
        <div className="mt-2 text-center font-mono text-[9px] uppercase leading-relaxed tracking-wider text-ink-faint">
          Two signatures: first an approval capped at exactly this amount (your wallet shows it as a
          &ldquo;spending cap&rdquo;, that cap is this trade, not a limit on you), then the {side}. No
          unlimited approvals, by design.
        </div>
      )}
      <SwapStatus state={swap.approveState} explorer={explorer} verb="Approval" />
      <SwapStatus state={swap.swapState} explorer={explorer} verb={side === 'buy' ? 'Buy' : 'Sell'} />
    </>
  )
}

function SwapStatus({ state, explorer, verb }: { state: TxState; explorer: string; verb: string }) {
  if (state.status === 'idle') return null
  const link = state.hash ? (
    <a href={`${explorer}/tx/${state.hash}`} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-ink">
      {shortAddr(state.hash)}
    </a>
  ) : null
  return (
    <div className="enter mt-2 text-center font-mono text-[10px]">
      {state.status === 'signing' && <span className="text-ink-dim">Confirm in your wallet…</span>}
      {state.status === 'confirming' && <span className="text-cyan">{verb} confirming… {link}</span>}
      {state.status === 'success' && <span className="text-teal">{verb} done. {link}</span>}
      {state.status === 'error' && <span className="text-magenta">{state.error ?? 'Transaction failed.'}</span>}
    </div>
  )
}

// Wallet-not-ready action states. Wrong network is the actionable one: the
// primary button IS the network switch (same treatment as the deploy portal's
// gate — a disabled button with a footnote reads as "broken").
function WalletNotReady({
  label, chainName, chainId, sig, buyInk, baseBtn,
}: {
  label: string
  chainName: string
  chainId: number
  sig: string
  buyInk: string
  baseBtn: string
}) {
  const { isConnected, chainId: walletChainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()

  if (isConnected && walletChainId !== chainId) {
    return (
      <>
        <button
          type="button"
          onClick={() => switchChain({ chainId })}
          disabled={isPending}
          className={`${baseBtn} press disabled:cursor-not-allowed disabled:opacity-60`}
          style={{ background: sig, color: buyInk }}
        >
          {isPending ? 'Confirm in wallet…' : `Switch wallet to ${chainName}`}
        </button>
        <div className="mt-2 text-center font-mono text-[10px] text-amber-300/90">
          Your wallet is on the wrong network, this trade signs on {chainName}.
        </div>
      </>
    )
  }
  return (
    <>
      <button type="button" disabled className={`${baseBtn} cursor-not-allowed opacity-60`} style={{ background: sig, color: buyInk }}>
        {label}
      </button>
      <div className="mt-2 text-center font-mono text-[10px] text-ink-faint">Connect a wallet on {chainName} to trade.</div>
    </>
  )
}
