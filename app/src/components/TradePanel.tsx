import { useEffect, useMemo, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { Link as RouterLink } from 'react-router'
import { useAccount, useReadContract } from 'wagmi'
import { erc20Abi, formatUnits } from 'viem'
import { WrongNetwork } from './WrongNetwork'
import { RevertCauses } from './RevertCauses'
import type { BasketData } from '../lib/spectrum/basket-data'
import { deploymentFor, settlementDecimalsFor } from '../lib/chain/deployments'
import { WALLET_ENABLED } from '../lib/config/features'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'
import { clientFor } from '../lib/chain/rpc'
import { findMaxSafe } from '../lib/spectrum/swap-sim'
import {
  clampSlippageBps,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  WARN_SLIPPAGE_BPS,
} from '../lib/spectrum/hook-data'
import { buildSwapQuote, toRaw, type SwapQuote } from '../lib/spectrum/swap-quote'
import type { MintFunding } from '../lib/spectrum/hook-data'
import { fundingSplitBpsOf, lensFactoryFor, resolveMintFunding } from '../lib/spectrum/mint-funding'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { useMintFunding } from '../lib/spectrum/use-mint-funding'
import { useSwapSim } from '../lib/spectrum/use-swap-sim'
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
  const { address } = useAccount()
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

  const inUnit = side === 'buy' ? 'USDC' : `$${showSymbol(ix.symbol)}`
  const outUnit = side === 'buy' ? `$${showSymbol(ix.symbol)}` : 'USDC'

  const swap = useBasketSwap(ix)

  // ── BOTH SIDES: price the REAL path on-chain, don't trust spot/NAV ───────────
  // Spot and `ix.navPerToken` (exchangeRate()) are FRICTIONLESS — they charge nothing
  // for the hub swap, each leg's swap, or (on a buy) the mint min-rule's discarded
  // cross-leg imbalance. Floors derived from them sat ABOVE what the chain pays:
  // measured live on Robinhood 2026-07-14, sells reverted above ~5 shares and buys
  // reverted at EVERY size (−10% to −68%). So simulate the real trade and haircut THAT.
  const tradeAmountRaw = valid
    ? toRaw(amt, side === 'buy' ? 6 : Math.min(ix.decimals, 18))
    : 0n

  // ── BUY: where each leg's share of the money comes from ──────────────────────
  // A D-R1 basket funds each leg from the split packed into its legMins word, and the
  // split may only come from the factory's own lens (mint-funding.ts explains why
  // target weights are exploitable). Read it for THIS amount before anything else:
  // both the floors and the on-chain probe below have to bind to the same split, and a
  // buy is not signable until it resolves.
  const firstMint = ix.effectiveSupply === 0
  const [fundingRetry, setFundingRetry] = useState(0)
  const funding = useMintFunding({
    enabled: valid && swap.configured && side === 'buy',
    basket: ix.address as `0x${string}`,
    chainId: ix.chainId,
    amountRaw: tradeAmountRaw,
    legCount: ix.holdings.length,
    firstMint,
    retryNonce: fundingRetry,
  })
  const fundingReady =
    side === 'sell' || (funding.outcome != null && funding.forAmountRaw === tradeAmountRaw && tradeAmountRaw > 0n)
  const fundingPlan = fundingReady && funding.outcome?.ok ? funding.outcome : null
  const fundingSplitBps = fundingPlan ? fundingSplitBpsOf(fundingPlan.funding) : null
  const fundingRefusal = fundingReady && funding.outcome && !funding.outcome.ok ? funding.outcome.reason : null

  const sim = useSwapSim({
    // The probe carries the same split the payload will: without it a D-R1 basket
    // acquires nothing and the measurement degrades to the frictionless estimate.
    enabled: valid && swap.configured && (side === 'sell' || fundingPlan != null),
    side,
    basket: ix.address as `0x${string}`,
    chainId: ix.chainId,
    amountRaw: tradeAmountRaw,
    legCount: ix.holdings.length,
    holder: address,
    allowanceCovers: tradeAmountRaw > 0n && !swap.needsApproval(side, tradeAmountRaw),
    fundingSplitBps,
  })

  // Only a simulation measured for exactly this side+amount may seed the floor.
  const simMatches =
    sim.out != null && sim.out > 0n && sim.forSide === side && sim.forAmountRaw === tradeAmountRaw

  // The broadcast-grade swap inputs + per-leg minimums — ONE source for the
  // preview and the signed tx (legMin = quotedLeg × (1 − slippage), exactly as
  // hook-data.ts encodes). null when the quote is incomplete (any leg unpriced or
  // an amount that rounds to zero) ⇒ no swap is encodable and the button stays
  // disabled. The signed values are the latest *rendered* quote (useBasketData is
  // staleTime-only with NO refetchInterval, so it is not polled and can be minutes
  // old — audit 2026-08-06); the click-time on-chain simulate reverts if any
  // committed minimum can no longer be met, so what is shown is what is signed and a
  // stale leg fails closed rather than fills badly.
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
      settlementDecimals: settlementDecimalsFor(ix.chainId),
      // Haircut the SIMULATED realised output, not the frictionless spot/NAV. Only
      // honoured when the figure was measured for THIS side+size — a realised number
      // from a different trade is not a valid floor basis (see use-swap-sim).
      realisedOutRaw: simMatches ? (sim.out as bigint) : undefined,
      // Each leg's floor prices the share the PAYLOAD funds it with, so the two cannot
      // disagree. Null on a pre-packing basket (it funds from its target weights).
      fundingSplitBps,
    })
  }, [valid, side, amt, ix, slippageBps, feeFrac, simMatches, sim.out, fundingSplitBps])

  // ── PREVIEW = THE SIGNED QUOTE ───────────────────────────────────────────────
  // Show what the floor was actually derived from. On a simulated sell that number
  // is achievable; the old NAV figure was not (it ignored two hops of swap fees +
  // price impact), so the UI used to promise proceeds the chain would never pay.
  const outDecimals = side === 'buy' ? Math.min(ix.decimals, 18) : 6
  const shownOut = trade ? Number(trade.expectedOutRaw) / 10 ** outDecimals : out
  const shownMinOut = trade ? Number(trade.minOutRaw) / 10 ** outDecimals : minOut
  // How far the realised sell lands under frictionless NAV. Small = ordinary venue
  // fees. Large = the basket's pools are too thin to exit at this size, which no
  // slippage tolerance should paper over — say so instead.
  const depthGapPct = trade?.basis === 'simulated' && out > 0
    ? (1 - shownOut / out) * 100
    : 0
  const thinExit = depthGapPct >= 5

  const legPreview = trade?.legs ?? []

  // ── quick sizing (lab 2026-07-29): preset chips + the balance + "max safe" ──
  // Chips remove the "how much do I type" hesitation; "max safe" runs the
  // simulator's binary search for the largest size that still fills within the
  // slippage tolerance — the same engine that already floors every trade, made
  // visible instead of silent.
  const dep = deploymentFor(ix.chainId)
  const shareDec = Math.min(ix.decimals, 18)
  const { data: usdcBal } = useReadContract({
    address: (dep.usdc ?? undefined) as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ix.chainId,
    query: { enabled: !!address && !!dep.usdc && side === 'buy' },
  })
  const { data: shareBal } = useReadContract({
    address: ix.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ix.chainId,
    query: { enabled: !!address && side === 'sell' },
  })
  const balRaw = side === 'buy' ? usdcBal : shareBal
  const balDec = side === 'buy' ? 6 : shareDec
  const [maxSafeBusy, setMaxSafeBusy] = useState(false)
  const [maxSafeNote, setMaxSafeNote] = useState<string | null>(null)
  useEffect(() => setMaxSafeNote(null), [side, ix.address])

  async function fillMaxSafe() {
    if (!address || !dep.swapRouter || !dep.usdc || balRaw == null || balRaw <= 0n || feeFrac == null || maxSafeBusy) return
    setMaxSafeBusy(true)
    setMaxSafeNote(null)
    try {
      const client = clientFor(ix.chainId)
      // The search probes real mints, so it needs the same funding split a buy would
      // carry — read for the CAP (the biggest size it will try) rather than for whatever
      // is typed, since the point of this button is that nothing is typed yet.
      let splitForSearch = fundingSplitBps
      if (side === 'buy') {
        // The basket's OWN lineage factory owns the lens for it (mint-funding.ts).
        const lensFactory = await lensFactoryFor(ix.chainId, ix.address as `0x${string}`)
        if (!lensFactory) {
          setMaxSafeNote('Could not tell which contracts this basket belongs to. Refresh and try again.')
          return
        }
        const plan = await resolveMintFunding(client, {
          chainId: ix.chainId,
          factory: lensFactory,
          basket: ix.address as `0x${string}`,
          amountIn: balRaw,
          legCount: ix.holdings.length,
          firstMint,
        })
        if (!plan.ok) {
          setMaxSafeNote(plan.reason)
          return
        }
        splitForSearch = fundingSplitBpsOf(plan.funding)
      }
      const safe = await findMaxSafe(client, {
        side,
        basket: ix.address as `0x${string}`,
        settlement: dep.usdc as `0x${string}`,
        router: dep.swapRouter as `0x${string}`,
        legCount: ix.holdings.length,
        holder: address,
        capRaw: balRaw,
        navPerToken: ix.navPerToken,
        feeFrac,
        basketDecimals: ix.decimals,
        slippageBps,
        // Same split the buy will carry, or the search measures a mint that funds nothing.
        fundingSplitBps: splitForSearch,
      })
      if (safe <= 0n) {
        setMaxSafeNote('No size fills within your slippage right now — the pools are too thin.')
      } else {
        setAmount(formatUnits(safe, balDec))
        if (safe < balRaw) setMaxSafeNote('Sized to what fills within your slippage; your full balance would fill worse.')
      }
    } finally {
      setMaxSafeBusy(false)
    }
  }

  // FIRST-BUY SEED MINIMUM — SpectrumBasket.sol MIN_FIRST_DEPOSIT (10 USDC, an
  // internal constant with no getter; the click-time simulate is the binding
  // backstop if it ever drifts). A fresh basket's first mint seeds its reserves
  // and reverts InsufficientFirstDeposit below this, so refuse the doomed tx up
  // front with words instead of a wrapped hex selector.
  const SEED_MIN_USDC = 10
  const belowSeedMin = side === 'buy' && valid && firstMint && amt < SEED_MIN_USDC
  // A buy is armed only once its funding split has resolved FOR THIS AMOUNT. The two
  // payload shapes are not interchangeable (mint-funding.ts), so "not yet known" can
  // never be signed as "no split".
  const armedTrade = belowSeedMin || (side === 'buy' && !fundingPlan) ? null : trade

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
  const customActive = slippageBps !== 100 && slippageBps !== DEFAULT_SLIPPAGE_BPS

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
            inputMode="decimal" enterKeyHint="done" autoComplete="off"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={txBusy}
            className="min-w-0 flex-1 bg-transparent font-num text-xl tabular-nums text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
          />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-dim">{inUnit}</span>
        </div>
        {/* quick sizing: buy = dollar chips, sell = balance fractions; both get max-safe */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {side === 'buy'
            ? [10, 50, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={txBusy}
                  onClick={() => setAmount(String(v))}
                  className="press rounded-md border border-white/10 px-2.5 py-1 font-mono text-[10px] tabular-nums text-ink-faint hover:border-cyan/50 hover:text-cyan disabled:opacity-50"
                >
                  ${v}
                </button>
              ))
            : [25, 50].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  disabled={txBusy || balRaw == null || balRaw <= 0n}
                  onClick={() => balRaw != null && setAmount(formatUnits((balRaw * BigInt(pct)) / 100n, balDec))}
                  className="press rounded-md border border-white/10 px-2.5 py-1 font-mono text-[10px] tabular-nums text-ink-faint hover:border-cyan/50 hover:text-cyan disabled:opacity-50"
                >
                  {pct}%
                </button>
              ))}
          <button
            type="button"
            disabled={txBusy || maxSafeBusy || balRaw == null || balRaw <= 0n}
            onClick={() => void fillMaxSafe()}
            title="The largest size the on-chain simulation fills within your slippage tolerance"
            className="press rounded-md border border-teal/30 bg-teal/[0.06] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-teal hover:border-teal/60 disabled:opacity-50"
          >
            {maxSafeBusy ? 'sizing…' : 'Max safe'}
          </button>
          {address && balRaw != null && (
            <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
              bal {formatNav(Number(formatUnits(balRaw, balDec)), side === 'buy' ? 2 : 4)}
            </span>
          )}
        </div>
        {maxSafeNote && (
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-amber-300/90">{maxSafeNote}</p>
        )}
      </div>

      {/* estimated out */}
      <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">You receive (est.)</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-num text-xl tabular-nums text-ink">{valid ? formatNav(shownOut, side === 'buy' ? 4 : 2) : '0.0'}</span>
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">{outUnit}</span>
        </div>
        {valid && sim.loading && !trade && (
          <div className="mt-1 font-mono text-[10px] tracking-wide text-ink-faint">pricing this trade on-chain…</div>
        )}
        {thinExit && (
          <div className="mt-1.5 font-mono text-[10px] leading-relaxed tracking-wide text-amber-300/90">
            This size fills {depthGapPct.toFixed(1)}% worse than NAV — the basket's pools are thin at
            this amount. A smaller trade gets a better price{side === 'sell' ? '; the in-kind exit avoids the pools entirely' : ''}.
          </div>
        )}
      </div>

      {/* slippage tolerance — always-on per-leg protection; no off switch exists */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          <span>Slippage tolerance</span>
          <span className="tabular-nums text-ink-dim">{(slippageBps / 100).toFixed(2)}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          {[
            { bps: 100, label: '1%' },
            { bps: DEFAULT_SLIPPAGE_BPS, label: `${DEFAULT_SLIPPAGE_BPS / 100}%` },
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
              inputMode="decimal" enterKeyHint="done" autoComplete="off"
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
          <dd className="tabular-nums text-ink-dim">1 ${showSymbol(ix.symbol)} = ${formatNav(ix.navPerToken)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Fee{fees ? ` (${(fees.basketFeeBps / 100).toFixed(2)}%)` : ''}</dt>
          <dd className="tabular-nums text-ink-dim">
            {valid ? `${formatNav(feeAmt, 2)} ${inUnit}` : fees ? '—' : 'read per basket'}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Minimum received</dt>
          <dd className="tabular-nums text-ink-dim">{valid ? `${formatNav(shownMinOut, side === 'buy' ? 4 : 2)} ${outUnit}` : '—'}</dd>
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
                  <dt>{showSymbol(l.symbol)}</dt>
                  <dd className="tabular-nums text-ink-dim">
                    {/* A holding the basket currently has none of gets none of this buy, so
                        it carries no minimum. Say that rather than showing a zero. */}
                    {l.min > 0n ? `≥ ${formatNav(Number(l.min) / 10 ** l.decimals, 4)}` : 'not funded by this buy'}
                  </dd>
                </div>
              ))}
              <p className="pt-1 text-[9px] leading-relaxed">
                Every leg this buy funds carries a minimum, there is no unprotected path.
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
          This is ${showSymbol(ix.symbol)}&rsquo;s FIRST buy, it seeds the basket&rsquo;s reserves, and the contract
          requires at least {SEED_MIN_USDC} USDC for it. Smaller buys work fine after that.
        </div>
      )}
      {/* The basket, or the connection, said this buy cannot be funded safely. Say so in
          words instead of letting the user sign something that reverts. */}
      {fundingRefusal && !belowSeedMin && (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          {fundingRefusal}
          {/* the refusals say "try again" and carry retryable:true — this is
              the button those words were missing (audit 2026-08-16) */}
          {funding.outcome && !funding.outcome.ok && funding.outcome.retryable && (
            <button
              type="button"
              onClick={() => setFundingRetry((n) => n + 1)}
              className="press ml-2 rounded-md border border-amber-400/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200 hover:bg-amber-400/10"
            >
              Try again
            </button>
          )}
        </div>
      )}
      <SwapAction
        side={side}
        symbol={ix.symbol}
        sig={sig}
        buyInk={buyInk}
        trade={armedTrade}
        funding={fundingPlan?.funding}
        preparing={side === 'buy' && valid && !belowSeedMin && !fundingPlan && !fundingRefusal}
        slippageBps={slippageBps}
        swap={swap}
        explorer={chainCfg(ix.chainId).explorer}
        chainName={chainCfg(ix.chainId).name}
        chainId={ix.chainId}
        hasAmount={valid}
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
  side, symbol, sig, buyInk, trade, funding, preparing, slippageBps, swap, explorer, chainName, chainId, hasAmount,
}: {
  /** A parseable positive amount is typed — splits the disabled reason
   *  ("Enter an amount" vs "can't price") on the no-trade face. */
  hasAmount: boolean
  side: Side
  symbol: string
  sig: string
  buyInk: string
  trade: SwapQuote | null
  /** BUY only — resolved funding for this exact amount; absent ⇒ nothing is signable. */
  funding: MintFunding | undefined
  /** The funding read is still in flight, so the button says so rather than looking dead. */
  preparing: boolean
  slippageBps: number
  swap: ReturnType<typeof useBasketSwap>
  explorer: string
  chainName: string
  chainId: number
}) {
  const label = side === 'buy' ? `Buy $${showSymbol(symbol)}` : `Sell $${showSymbol(symbol)}`
  const inUnit = side === 'buy' ? 'USDC' : `$${showSymbol(symbol)}`
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

  // (2) Trading build, wallet not ready. A CONNECTED wallet on another network
  // gets the pre-flight notice + an actionable switch button (a disabled buy with
  // a footnote read as "broken" in testing). Only a truly disconnected wallet
  // shows the connect hint.
  if (!swap.walletReady) {
    return <WalletNotReady chainName={chainName} chainId={chainId} sig={sig} buyInk={buyInk} baseBtn={baseBtn} />
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
      funding,
    })
  }

  const btnLabel = preparing
    ? 'Preparing…'
    : !trade
      ? !hasAmount
        ? 'Enter an amount'
        : 'Can’t price this trade right now'
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
      <SwapStatus
        state={swap.swapState}
        explorer={explorer}
        verb={side === 'buy' ? 'Buy' : 'Sell'}
        // the post-trade seam (owner ~17:0x): success says where the result
        // LIVES — a buy lands in the book, and the book is one click away
        after={
          side === 'buy' && WALLET_ENABLED && pageEnabled(brand.pages, 'portfolio') ? (
            <RouterLink to="/portfolio" className="text-cyan hover:underline">
              in your book → view portfolio
            </RouterLink>
          ) : null
        }
      />
    </>
  )
}

function SwapStatus({ state, explorer, verb, after }: { state: TxState; explorer: string; verb: string; after?: React.ReactNode }) {
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
      {state.status === 'success' && (
        <span className="text-teal">
          {verb} done. {link} {after && <span className="text-ink-faint">·</span>} {after}
        </span>
      )}
      {state.status === 'error' && (
        <span className="text-magenta">
          {state.error ?? 'Transaction failed.'}
          <RevertCauses error={state.error} />
        </span>
      )}
    </div>
  )
}

// Wallet-not-ready action states. Wrong network is the actionable one: the
// primary button IS the network switch (same treatment as the deploy portal's
// gate — a disabled button with a footnote reads as "broken"). The notice itself
// is the app-wide one (WrongNetwork.tsx) — this panel was where it was designed,
// and since the 2026-08-05 consolidation it lives there for all six surfaces.
function WalletNotReady({
  chainName, chainId, sig, buyInk, baseBtn,
}: {
  chainName: string
  chainId: number
  sig: string
  buyInk: string
  baseBtn: string
}) {
  const { isConnected, chainId: walletChainId } = useAccount()

  if (isConnected && walletChainId !== chainId) {
    return (
      <WrongNetwork
        requiredChainId={chainId}
        action="This basket buys and sells"
        className="mt-4"
        button={{ className: baseBtn, style: { background: sig, color: buyInk } }}
      />
    )
  }
  return (
    <>
      {/* audit 2026-08-16: this told the user to connect and offered no door —
          the same live control the console uses (spectrum:connect) */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('spectrum:connect'))}
        className={`${baseBtn}`}
        style={{ background: sig, color: buyInk }}
      >
        Connect wallet
      </button>
      <div className="mt-2 text-center font-mono text-[10px] text-ink-faint">Trading runs on {chainName}; connecting signs nothing.</div>
    </>
  )
}
