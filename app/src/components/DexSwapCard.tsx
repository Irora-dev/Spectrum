import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatUnits, isAddress, parseUnits } from 'viem'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { chainCfg } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import type { BasketData } from '../lib/spectrum/basket-data'
import { useAllBaskets, useBasketData } from '../lib/spectrum/hooks'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { useDexSwap, type DexTxState, type HubToken } from '../lib/spectrum/use-dex-swap'
import { erc20BalanceAbi } from '../lib/spectrum/abis-v2'
import { clampSlippageBps, DEFAULT_SLIPPAGE_BPS } from '../lib/spectrum/hook-data'
import { formatNav, formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import { AssetLogo } from './AssetLogo'
import { BasketAvatar } from './BasketAvatar'
import { SwapPendingOverlay } from './SwapPendingOverlay'
import { ShareEarnNudge } from './ShareEarnNudge'

// ─────────────────────────────────────────────────────────────────────────────
// The DEX-style swap console: one pay box, one receive box, a flip, and a
// basket selector; pay with native ETH, WETH or USDC (routes through the
// canonical V3 hub into the protected Spectrum leg — see use-dex-swap.ts).
// Every basket trade still commits per-leg minimums; there is no unprotected
// path.
//
// Two hosts share this card:
//   /swap       — free mode (`large`): picker over the whole head directory,
//                 ?basket=&chain= deep-links a preselection.
//   Token page  — `fixedBasket`: locked to that basket, no picker, compact.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
const HUBS: HubToken[] = ['ETH', 'USDC', 'WETH']

function EthGlyph({ size = 22 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-[#627eea]/20 ring-1 ring-white/10"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 256 417" style={{ width: size * 0.5, height: size * 0.5 }} aria-hidden>
        <path fill="#c9d4fa" d="M127.9 0l-2.8 9.5v275.7l2.8 2.8 127.9-75.6z" />
        <path fill="#8fa7f2" d="M127.9 0L0 212.4l127.9 75.6V0z" />
        <path fill="#c9d4fa" d="M127.9 312.2l-1.6 1.9v98.2l1.6 4.7L256 236.6z" />
        <path fill="#8fa7f2" d="M127.9 417v-104.8L0 236.6z" />
      </svg>
    </span>
  )
}

function HubIcon({ hub, chainId, size = 22 }: { hub: HubToken; chainId: number; size?: number }) {
  const dep = deploymentFor(chainId)
  if (hub === 'ETH') return <EthGlyph size={size} />
  const addr = hub === 'WETH' ? dep.weth : dep.usdc
  if (!addr) return <EthGlyph size={size} />
  // The letters fallback should spell the chain's settlement asset (USDG on
  // Robinhood) — logo sources have no coverage there, so the letters ARE the icon.
  const sym = hub === 'USDC' ? chainCfg(chainId).usdcSymbol : hub
  return <AssetLogo address={addr} symbol={sym} chainId={chainId} size={size} />
}

const hubDecimals = (hub: HubToken) => (hub === 'USDC' ? 6 : 18)

/** Compact amount for balances/quotes. */
function fmtAmt(raw: bigint | null, decimals: number, dp = 5): string {
  if (raw == null) return '—'
  const n = Number(formatUnits(raw, decimals))
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  if (n >= 10_000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return n.toLocaleString('en-US', { maximumFractionDigits: dp })
}

export function DexSwapCard({
  chainId,
  fixedBasket = null,
  initialBasket = null,
  large = false,
  strip = false,
  defaultHub = 'ETH',
  onBasketChange,
}: {
  chainId: number
  /** Lock the console to one already-loaded basket (Token page) — no picker. */
  fixedBasket?: BasketData | null
  /** Free mode: preselect this basket address (deep link). */
  initialBasket?: string | null
  /** Roomier paddings + typography for the standalone /swap page. */
  large?: boolean
  /** The one-row streamlined buy (owner 19:24): pay left → basket right → Buy.
   *  Same state machine, quotes, guards and overlay — just the strip layout. */
  strip?: boolean
  /** Pay-side token preselected on mount — the seed prompt opens on USDC
   *  (owner 2026-07-07 13:57); everywhere else stays ETH. */
  defaultHub?: HubToken
  /** Fired when the selected basket changes — lets a host page (the /swap
   *  context panel) follow the console's selection. */
  onBasketChange?: (address: string | null) => void
}) {
  const cfg = chainCfg(chainId)
  const { isConnected, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { data: all } = useAllBaskets()

  const heads = useMemo(
    () => (fixedBasket ? [] : (all ?? []).filter((b) => b.chainId === chainId && !b.supersededBy)),
    [all, chainId, fixedBasket],
  )

  const [basketAddr, setBasketAddr] = useState<string | null>(
    initialBasket && isAddress(initialBasket) ? initialBasket : null,
  )
  // Free mode: default to the largest basket once the directory loads (no
  // selection yet); reselect when a chain switch invalidates the current pick.
  useEffect(() => {
    if (fixedBasket) return
    if (!basketAddr && heads.length > 0) setBasketAddr(heads[0].address)
    if (basketAddr && heads.length > 0 && !heads.some((h) => h.address.toLowerCase() === basketAddr.toLowerCase())) {
      setBasketAddr(heads[0].address)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heads, chainId])

  const { data: fetched } = useBasketData(fixedBasket ? undefined : (basketAddr ?? undefined), chainId)
  const ix = fixedBasket ?? fetched ?? null
  const { data: fees } = useBasketFees(ix?.address, chainId)
  const feeFrac = fees ? fees.basketFeeBps / 10_000 : Number.NaN

  const [dir, setDir] = useState<'buy' | 'sell'>('buy')
  // Hub availability per chain: full Uniswap infra (Base/Ethereum) = ETH/WETH/
  // settlement; a LiFi external-hub chain (Robinhood) = ETH + settlement (the
  // ETH hop rides LiFi's verified diamond, WETH doesn't exist there); neither =
  // settlement-direct only. Computed here so the DEFAULT is right pre-hook.
  const depHere = deploymentFor(chainId)
  const hubInfra = !!depHere.uniV3SwapRouter && !!depHere.uniV3Quoter && !!depHere.weth
  const lifiHubChain = cfg.externalHubRouter === 'lifi' && !hubInfra
  const hubChoices: HubToken[] = hubInfra ? HUBS : lifiHubChain ? ['ETH', 'USDC'] : ['USDC']
  const [hub, setHub] = useState<HubToken>(hubInfra || lifiHubChain ? defaultHub : 'USDC')
  useEffect(() => {
    if (!hubChoices.includes(hub)) setHub('USDC')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubInfra, lifiHubChain, chainId])
  // Display name of the settlement asset: USDC on Base/Ethereum, USDG on
  // Robinhood Chain. Mechanics identical — labels only.
  const usdcSym = cfg.usdcSymbol
  const hubLabel = (h: HubToken) => (h === 'USDC' ? usdcSym : h)
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [customSlip, setCustomSlip] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hubMenuOpen, setHubMenuOpen] = useState(false)
  const [flipped, setFlipped] = useState(false)
  // Trade details (fee/min/route/slippage) fold behind one summary row — the
  // rail stays clean until the user asks for the numbers (owner ask 2026-07-05).
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Whether the pending-animation pop-up is showing (opened on execute, dismissed
  // by the user on done/error).
  const [pending, setPending] = useState(false)

  const dex = useDexSwap(ix, dir, hub, chainId)

  // Tell the host page which basket the console is on (context panel follows).
  useEffect(() => {
    onBasketChange?.(ix?.address ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix?.address])

  // The viewer's position in the selected basket — context on the receive side
  // while buying (sell mode already shows it as the pay balance).
  const { address: viewerAddr } = useAccount()
  const { data: basketHolding } = useReadContract({
    address: ix?.address as `0x${string}` | undefined,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: viewerAddr ? [viewerAddr] : undefined,
    chainId,
    query: { enabled: !!ix && !!viewerAddr && dir === 'buy', refetchInterval: 30_000 },
  })

  // Seed route default (owner E2E 2026-07-09, improvement set #4): the first buy
  // of an UNSEEDED basket must land ≥ 10 USDC on the basket leg, and the creator's
  // wallet usually already holds USDC — yet this console kept opening on the ETH
  // route (an extra hub swap for nothing). When the viewer can cover the seed
  // floor in USDC, start on the direct USDC route. One-shot per mount, and an
  // explicit hub pick always wins — the default never fights the user.
  const hubPicked = useRef(false)
  const { data: viewerUsdc } = useReadContract({
    address: deploymentFor(chainId).usdc ?? undefined,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: viewerAddr ? [viewerAddr] : undefined,
    chainId,
    query: {
      enabled:
        !!viewerAddr && dir === 'buy' && hub !== 'USDC' && !hubPicked.current && ix?.effectiveSupply === 0,
    },
  })
  useEffect(() => {
    if (hubPicked.current || hub === 'USDC') return
    if (dir !== 'buy' || ix?.effectiveSupply !== 0) return
    if (viewerUsdc == null || viewerUsdc < 10_000_000n) return // the C-1 seed floor
    setHub('USDC')
  }, [viewerUsdc, hub, dir, ix?.effectiveSupply])

  // Share-&-earn nudge shown on the swap-success overlay (owner 2026-07-07): a
  // buyer who just bought can share the basket, and their link carries ?ref so
  // buys through it pay them the interface slice (~5%). SUPPRESSED for the
  // basket's OWN deployer (owner 2026-07-07 — the creator already has launch /
  // creator share surfaces; this nudge is for turning buyers into referrers).
  const isBasketDeployer =
    !!viewerAddr && !!ix?.deployer && viewerAddr.toLowerCase() === ix.deployer.toLowerCase()
  const swapShare = (() => {
    if (!ix || !viewerAddr || isBasketDeployer) return null
    const url = `${window.location.origin}/token?addr=${ix.address}&chain=${chainId}&ref=${viewerAddr}`
    // Natural first-person share (owner 2026-07-09) — reads like a holder talking,
    // not a product blurb; the intent appends the (ref-carrying) link after it.
    const text = `I just added $${ix.symbol} to my portfolio, take a look`
    const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
    return { url, xHref }
  })()

  const payDecimals = dir === 'buy' ? hubDecimals(hub) : Math.min(ix?.decimals ?? 18, 18)
  const receiveDecimals = dir === 'buy' ? Math.min(ix?.decimals ?? 18, 18) : hubDecimals(hub)
  const amountRaw = useMemo(() => {
    try {
      const v = parseUnits(amount || '0', payDecimals)
      return v > 0n ? v : 0n
    } catch {
      return 0n
    }
  }, [amount, payDecimals])

  // Debounced quoting.
  useEffect(() => {
    const t = window.setTimeout(() => void dex.refreshQuote(amountRaw, slippageBps, feeFrac), 320)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountRaw, slippageBps, feeFrac, hub, dir, ix?.address, chainId])

  const wrongChain = isConnected && walletChainId !== chainId
  const insufficient = dex.payBalance != null && amountRaw > 0n && amountRaw > dex.payBalance
  const seedShort =
    dir === 'buy' && ix?.effectiveSupply === 0 && dex.quote != null && dex.quote.usdcLegRaw < 10_000_000n

  const flip = () => {
    setDir((d) => (d === 'buy' ? 'sell' : 'buy'))
    setFlipped((f) => !f)
    setAmount('')
    dex.resetRun()
    void dex.refreshQuote(0n, slippageBps, feeFrac) // clear the stale quote instantly
  }

  const setMax = () => {
    if (dex.payBalance == null) return
    // Native ETH keeps a gas reserve back; everything else is spendable in full.
    const reserve = dir === 'buy' && hub === 'ETH' ? parseUnits('0.005', 18) : 0n
    const max = dex.payBalance > reserve ? dex.payBalance - reserve : 0n
    setAmount(formatUnits(max, payDecimals))
  }

  const stepsList = dex.steps(ix?.symbol ?? '—')
  const showSteps = dex.running || dex.error != null || dex.done != null
  const rate =
    dex.quote && amountRaw > 0n
      ? Number(formatUnits(dex.quote.outRaw, receiveDecimals)) / Number(formatUnits(amountRaw, payDecimals))
      : null

  // Concrete-dollar grounding (owner rule: money beats units). The quote's
  // USDC mid-leg IS the trade's dollar value (every route pivots through
  // USDC), and the basket side values at NAV — both facts we already hold,
  // no new price feed. Null until a quote exists; labelled ≈ everywhere.
  const usdLeg = dex.quote ? Number(formatUnits(dex.quote.usdcLegRaw, 6)) : null
  const basketUnits = (raw: bigint) => Number(formatUnits(raw, Math.min(ix?.decimals ?? 18, 18)))
  const payUsd =
    dex.quote && amountRaw > 0n
      ? dir === 'buy'
        ? usdLeg
        : ix?.navPerToken
          ? basketUnits(amountRaw) * ix.navPerToken
          : usdLeg
      : null
  const receiveUsd =
    dex.quote && amountRaw > 0n
      ? dir === 'buy'
        ? ix?.navPerToken
          ? basketUnits(dex.quote.outRaw) * ix.navPerToken
          : usdLeg
        : usdLeg
      : null
  const fmtUsd = (v: number | null) =>
    v == null || !Number.isFinite(v) || v <= 0
      ? null
      : `≈ $${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // ── CTA state machine ────────────────────────────────────────────────────
  let cta: { label: string; onClick?: () => void; disabled: boolean } = { label: 'Swap', disabled: true }
  if (!dex.configured) cta = { label: 'Preview only · no router configured', disabled: true }
  else if (!ix)
    cta = fixedBasket
      ? { label: 'Loading basket…', disabled: true }
      : { label: 'Select a basket', onClick: () => setPickerOpen(true), disabled: false }
  else if (!isConnected) cta = { label: 'Connect a wallet (top right)', disabled: true }
  else if (wrongChain)
    cta = {
      label: switching ? 'Confirm in wallet…' : `Switch wallet to ${cfg.name}`,
      onClick: () => switchChain({ chainId }),
      disabled: switching,
    }
  else if (dex.running) cta = { label: 'Swapping…', disabled: true }
  else if (dex.done) cta = { label: 'Swap again', onClick: () => { setAmount(''); dex.resetRun() }, disabled: false }
  else if (amountRaw === 0n) cta = { label: 'Enter an amount', disabled: true }
  else if (insufficient) cta = { label: `Insufficient ${dir === 'buy' ? hubLabel(hub) : `$${ix.symbol}`} balance`, disabled: true }
  else if (seedShort) cta = { label: `First buy needs ≥ 10 ${usdcSym} on the basket leg`, disabled: true }
  else if (dex.quoting) cta = { label: 'Quoting…', disabled: true }
  else if (!dex.quote) cta = { label: 'Quote unavailable', disabled: true }
  else if (dex.error) cta = { label: 'Retry swap', onClick: () => runSwap(), disabled: false }
  else cta = { label: dir === 'buy' ? `Buy $${ix.symbol}` : `Sell $${ix.symbol}`, onClick: () => runSwap(), disabled: false }

  // The last completed swap, kept AFTER the overlay closes — the page itself
  // remembers what just happened (expected units captured at fire time; the
  // receipt is the tx, linked).
  const [lastSwap, setLastSwap] = useState<{ hash: string; label: string } | null>(null)
  const pendingRef = useRef<string | null>(null)
  useEffect(() => {
    if (dex.done && pendingRef.current) {
      setLastSwap({ hash: dex.done.hash, label: pendingRef.current })
      pendingRef.current = null
    }
  }, [dex.done])

  // Kick off the swap AND raise the pending pop-up (the on-brand wait animation).
  function runSwap() {
    const out = dex.quote ? fmtAmt(dex.quote.outRaw, receiveDecimals) : null
    pendingRef.current =
      out && ix
        ? dir === 'buy'
          ? `≈ ${out} $${ix.symbol} received`
          : `≈ ${out} ${hubLabel(hub)} received`
        : 'Swap confirmed'
    setLastSwap(null)
    setPending(true)
    void dex.execute(amountRaw, slippageBps, feeFrac)
  }

  const boxPad = large ? 'p-6' : 'p-5'
  const amountText = large ? 'text-5xl' : 'text-4xl'
  // The pay/receive boxes are backdrop-filter surfaces, so each is its own
  // stacking context — the hub dropdown would paint UNDER the next card. The
  // box hosting the open menu is raised above its siblings while open.
  const hubBoxZ = hubMenuOpen ? 'z-30' : 'z-[1]'

  const hubChip = (
    <HubChip hub={hub} chainId={chainId} open={hubMenuOpen} setOpen={setHubMenuOpen} onPick={(h) => { hubPicked.current = true; setHub(h); dex.resetRun() }} disabled={dex.running} choices={hubChoices} usdcSym={usdcSym} />
  )
  const basketChip = (
    <BasketChip ix={ix} onClick={fixedBasket ? undefined : () => setPickerOpen(true)} disabled={dex.running} />
  )

  // ── the STRIP: buy-only — every guard/quote/overlay shared. Two balanced,
  //    labeled cells (You pay | You receive) bridged by a directional badge,
  //    the CTA riding the right edge (owner 2026-07-07 14:5x: "way more
  //    beautiful and balanced"). Wraps to stacked cells inside narrow hosts
  //    (row expansions) — the badge hides when stacked. ──────────────────────
  if (strip) {
    const armed = !cta.disabled && amountRaw > 0n
    // No basket yet (directory loading / nothing picked): the pay/receive cells
    // have nothing to say, so the card shows ONE centered Select-a-basket
    // button instead of an empty two-cell shell (owner 2026-07-07 15:0x).
    if (!ix) {
      return (
        <div className="relative">
          <div className="relative grid min-h-[4.5rem] place-items-center rounded-2xl card-surface p-3 backdrop-blur-md">
            <button
              type="button"
              disabled={!!fixedBasket}
              onClick={() => setPickerOpen(true)}
              className="press inline-flex items-center gap-2.5 rounded-xl border border-white/15 bg-white/[0.04] px-7 py-2.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-60"
            >
              {fixedBasket ? 'Loading basket…' : 'Select a basket'}
              {!fixedBasket && (
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              )}
            </button>
          </div>
          {pickerOpen && !fixedBasket && (
            <BasketPicker
              heads={heads}
              chainId={chainId}
              onPick={(a) => {
                setBasketAddr(a)
                setPickerOpen(false)
                dex.resetRun()
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      )
    }
    return (
      <div className="relative">
        <div className={`relative flex flex-wrap items-stretch gap-2 rounded-2xl card-surface p-2 backdrop-blur-md sm:p-2.5 ${hubMenuOpen ? 'z-30' : ''}`}>
          {/* ── You pay ── */}
          <div className="min-w-[13rem] flex-1 rounded-xl border border-white/[0.07] bg-black/30 px-3.5 py-2">
            <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
              <span>You pay</span>
              {dex.payBalance != null && (
                <button type="button" onClick={setMax} className="press whitespace-nowrap hover:text-cyan">
                  {fmtAmt(dex.payBalance, payDecimals)} · Max
                </button>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2.5">
              {hubChip}
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="0"
                size={1}
                disabled={dex.running}
                aria-label="Amount to pay"
                className="min-w-[2.5rem] flex-1 bg-transparent text-right font-num text-xl font-light tabular-nums text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
              />
            </div>
          </div>

          {/* ── the bridge (hidden when the cells stack) ── */}
          <div className="hidden self-center sm:block">
            <span
              aria-hidden
              className={`grid h-8 w-8 place-items-center rounded-full border transition-colors ${
                dex.quote ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-white/12 bg-white/[0.03] text-ink-faint'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14m0 0l-5-5m5 5l-5 5" />
              </svg>
            </span>
          </div>

          {/* ── You receive ── */}
          <div className="min-w-[13rem] flex-1 rounded-xl border border-white/[0.07] bg-black/30 px-3.5 py-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">You receive (est.)</div>
            <div className="mt-1 flex items-center gap-2.5">
              {basketChip}
              <span className={`min-w-0 flex-1 truncate text-right font-num text-xl font-light tabular-nums ${dex.quote ? 'text-ink' : 'text-ink-faint'}`}>
                {dex.quoting ? <span className="animate-pulse">…</span> : fmtAmt(dex.quote?.outRaw ?? null, receiveDecimals)}
              </span>
            </div>
          </div>

          {/* ── the CTA — gradient once armed, quiet before ── */}
          <button
            type="button"
            disabled={cta.disabled}
            onClick={cta.onClick}
            className={`press w-full whitespace-nowrap rounded-xl px-6 py-2.5 font-display text-xs font-bold uppercase tracking-[0.14em] transition-transform hover:enabled:scale-[1.02] active:enabled:scale-[0.97] disabled:cursor-not-allowed sm:w-auto sm:self-stretch ${
              armed ? 'text-black' : 'border border-white/12 bg-white/[0.04] text-ink-dim disabled:opacity-70'
            }`}
            style={armed ? { background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' } : undefined}
          >
            {amountRaw === 0n && ix ? `Buy $${ix.symbol}` : cta.label}
          </button>
        </div>
        {pickerOpen && !fixedBasket && (
          <BasketPicker
            heads={heads}
            chainId={chainId}
            onPick={(a) => {
              setBasketAddr(a)
              setPickerOpen(false)
              dex.resetRun()
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
        <SwapPendingOverlay
          open={pending && (dex.running || dex.done != null || dex.error != null)}
          dir={dir}
          symbol={ix?.symbol ?? ''}
          steps={stepsList}
          txOf={dex.txOf}
          running={dex.running}
          done={dex.done}
          error={dex.error}
          explorer={cfg.explorer}
          onClose={() => setPending(false)}
          token={ix ? { address: ix.address, chainId } : undefined}
          seeding={dir === 'buy' && ix?.effectiveSupply === 0}
          constituents={ix?.holdings.map((h) => ({ address: h.asset, symbol: h.symbol }))}
          share={swapShare}
          bentoItems={ix?.holdings.map((h) => ({ symbol: h.symbol, address: h.asset, weightPct: h.targetWeightPct, chainId }))}
          decimals={ix?.decimals}
          usdRaw={dex.quote?.usdcLegRaw}
        />
      </div>
    )
  }

  return (
    <div className="relative">
      {/* ── PAY ─────────────────────────────────────────────────────────── */}
      <section className={`relative rounded-3xl card-surface backdrop-blur-md transition-shadow focus-within:ring-1 focus-within:ring-cyan/25 ${boxPad} ${dir === 'buy' ? hubBoxZ : 'z-[1]'}`}>
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          <span>You pay</span>
          {dex.payBalance != null && (
            <span className="flex items-center gap-1">
              <span className="mr-1 tabular-nums">{fmtAmt(dex.payBalance, payDecimals)}</span>
              {([25, 50] as const).map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setAmount(formatUnits((dex.payBalance! * BigInt(pct)) / 100n, payDecimals))}
                  className="press rounded-md border border-white/10 px-1.5 py-0.5 hover:border-cyan/40 hover:text-cyan"
                >
                  {pct}%
                </button>
              ))}
              <button type="button" onClick={setMax} className="press rounded-md border border-cyan/30 px-1.5 py-0.5 text-cyan hover:border-cyan/60">
                Max
              </button>
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            placeholder="0"
            size={1} // kill the default 20-char intrinsic width, at text-4xl it inflates ancestor grid tracks on phones
            disabled={dex.running}
            aria-label="Amount to pay"
            className={`min-w-0 flex-1 bg-transparent font-num ${amountText} font-light tabular-nums text-ink outline-none placeholder:text-ink-faint disabled:opacity-60`}
          />
          {dir === 'buy' ? hubChip : basketChip}
        </div>
        {fmtUsd(payUsd) && (
          <div className="mt-1 font-mono text-[11px] tabular-nums text-ink-faint">{fmtUsd(payUsd)}</div>
        )}
      </section>

      {/* flip */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={flip}
          disabled={dex.running}
          aria-label="Flip direction"
          className="press grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-panel text-ink-dim shadow-[0_8px_20px_rgba(0,0,0,0.5)] transition-transform duration-300 hover:border-cyan/50 hover:text-cyan disabled:opacity-50"
          style={{ transform: flipped ? 'rotate(180deg)' : 'none' }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v16m0 0l-5-5m5 5l5-5" />
          </svg>
        </button>
      </div>

      {/* ── RECEIVE ─────────────────────────────────────────────────────── */}
      <section className={`relative rounded-3xl card-surface backdrop-blur-md transition-shadow focus-within:ring-1 focus-within:ring-cyan/25 ${boxPad} ${dir === 'sell' ? hubBoxZ : 'z-[1]'}`}>
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          <span>You receive (est.)</span>
          {dir === 'buy' && ix && basketHolding != null && basketHolding > 0n && (
            <span className="tabular-nums">You hold {fmtAmt(basketHolding, Math.min(ix.decimals ?? 18, 18))}</span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <div className={`min-w-0 flex-1 truncate font-num ${amountText} font-light tabular-nums ${dex.quote ? 'text-ink' : 'text-ink-faint'}`}>
            {dex.quoting ? <span className="animate-pulse">…</span> : fmtAmt(dex.quote?.outRaw ?? null, receiveDecimals)}
          </div>
          {dir === 'buy' ? basketChip : hubChip}
        </div>
        {fmtUsd(receiveUsd) && (
          <div className="mt-1 font-mono text-[11px] tabular-nums text-ink-faint">{fmtUsd(receiveUsd)}</div>
        )}
      </section>

      {/* ── details: ONE summary line (rate · slip · chevron); everything else
             folds behind it. Appears once there's an amount or a quote, an
             untouched console shows just the two boxes and the button. ─────── */}
      {(amountRaw > 0n || dex.quote != null) && (
        <div className="mt-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02] font-mono text-[11px] text-ink-dim">
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen}
            className="press flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-white/[0.02]"
          >
            <span className="truncate tabular-nums">
              {dex.quoting ? (
                <span className="animate-pulse text-ink-faint">Quoting…</span>
              ) : rate && ix ? (
                dir === 'buy'
                  ? `1 ${hubLabel(hub)} ≈ ${rate.toLocaleString('en-US', { maximumFractionDigits: 4 })} $${ix.symbol}`
                  : `1 $${ix.symbol} ≈ ${rate.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${hubLabel(hub)}`
              ) : (
                <span className="text-ink-faint">Trade details</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-ink-faint">
              <span className="tabular-nums">{(slippageBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% slip</span>
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                className={`transition-transform duration-200 ${detailsOpen ? 'rotate-180' : ''}`}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </button>

          {detailsOpen && (
            <div className="space-y-1.5 border-t border-white/[0.07] px-4 pb-3.5 pt-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Basket fee</span>
                <span className="tabular-nums">{fees ? `${(fees.basketFeeBps / 100).toFixed(2)}%` : '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Minimum received</span>
                <span className="tabular-nums">
                  {dex.quote ? `${fmtAmt(dex.quote.minOutRaw, receiveDecimals)} ${dir === 'buy' ? `$${ix?.symbol ?? ''}` : hubLabel(hub)}` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Route</span>
                <span className="truncate">
                  {ix
                    ? dir === 'buy'
                      ? hub === 'USDC'
                        ? `${usdcSym} → $${ix.symbol} · self-pool`
                        : `${hub} → ${usdcSym} → $${ix.symbol} · ${lifiHubChain ? 'LiFi' : 'V3'} + self-pool`
                      : hub === 'USDC'
                        ? `$${ix.symbol} → ${usdcSym} · self-pool`
                        : `$${ix.symbol} → ${usdcSym} → ${hub} · self-pool + ${lifiHubChain ? 'LiFi' : 'V3'}`
                    : '—'}
                  {dex.quote && dir === 'buy' ? ` · ${dex.quote.legCount} legs, each with its own floor` : ''}
                </span>
              </div>
              {/* slippage */}
              <div className="flex items-center justify-between gap-3 border-t border-white/[0.07] pt-2.5">
                <span className="text-ink-faint">Slippage</span>
                <span className="flex items-center gap-2">
                  {[50, 100, 300].map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      onClick={() => { setSlippageBps(bps); setCustomSlip('') }}
                      className={`press rounded-lg px-3 py-1.5 text-[12px] ${slippageBps === bps && !customSlip ? 'bg-cyan/15 text-cyan ring-1 ring-inset ring-cyan/30' : 'text-ink-faint ring-1 ring-inset ring-white/10 hover:text-ink'}`}
                    >
                      {bps / 100}%
                    </button>
                  ))}
                  <span className="flex items-center rounded-lg border border-white/10 px-2.5 py-1.5">
                    <input
                      value={customSlip}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^0-9.]/g, '')
                        setCustomSlip(raw)
                        const pct = parseFloat(raw)
                        if (Number.isFinite(pct) && pct > 0) setSlippageBps(clampSlippageBps(Math.round(pct * 100)))
                      }}
                      placeholder="1.0"
                      inputMode="decimal"
                      className="w-11 bg-transparent text-right text-[12px] tabular-nums text-ink outline-none placeholder:text-ink-faint"
                    />
                    <span className="text-[12px] text-ink-faint">%</span>
                  </span>
                </span>
              </div>
              <p className="border-t border-white/[0.07] pt-2.5 text-[9px] uppercase leading-relaxed tracking-wider text-ink-faint">
                Multi-leg routes run as sequenced transactions, each simulated before you sign.
              </p>
            </div>
          )}
        </div>
      )}

      {/* seed-min warning */}
      {seedShort && ix && (
        <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          This is ${ix.symbol}&rsquo;s FIRST buy, it seeds the basket&rsquo;s reserves and the contract
          requires at least 10 USDC to reach the basket leg. Increase the amount.
        </div>
      )}

      {/* quote error */}
      {dex.quoteError && amountRaw > 0n && !dex.quoting && (
        <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
          {dex.quoteError}
        </p>
      )}

      {/* CTA — the gradient is EARNED by an executable trade (same rule as the
          strip): quiet outline while idle/disabled, spectral once armed. */}
      <button
        type="button"
        onClick={cta.onClick}
        disabled={cta.disabled}
        className={`press mt-4 w-full rounded-2xl ${large ? 'py-5' : 'py-4'} font-display text-base font-bold uppercase tracking-[0.15em] transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed ${
          !cta.disabled && amountRaw > 0n
            ? 'text-black'
            : 'border border-white/12 bg-white/[0.04] text-ink-dim disabled:opacity-60'
        }`}
        style={!cta.disabled && amountRaw > 0n ? { background: SPECTRAL } : undefined}
      >
        {cta.label}
      </button>

      {/* the page remembers the last swap (the overlay is transient) */}
      {lastSwap && !dex.running && (
        <div className="mt-2.5 flex items-center justify-center gap-2 font-mono text-[11px] text-ink-dim">
          <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full border border-teal/50 bg-teal/15 text-[9px] text-teal">✓</span>
          <span className="tabular-nums">{lastSwap.label}</span>
          <a href={`${cfg.explorer}/tx/${lastSwap.hash}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
            view tx ↗
          </a>
        </div>
      )}

      {/* run progress */}
      {showSteps && (
        <div className="mt-3 space-y-1.5 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 font-mono text-[11px]">
          {stepsList.map((s, i) => (
            <StepLine key={s.key} n={i + 1} label={s.label} tx={dex.txOf(s.key)} explorer={cfg.explorer} />
          ))}
        </div>
      )}
      {dex.error && (
        <p className="mt-3 rounded-xl border border-magenta/30 bg-magenta/[0.06] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-dim">
          {dex.error}
        </p>
      )}
      {dex.done && (
        <div className="mt-3 rounded-2xl border border-teal/30 bg-teal/[0.06] px-4 py-3 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">Swap complete</div>
          <a
            href={`${cfg.explorer}/tx/${dex.done.hash}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block font-mono text-[10px] text-cyan hover:underline"
          >
            view final tx ↗
          </a>
          {/* second, quieter share-&-earn touch that persists after the overlay
              closes (owner 2026-07-07); buys only, null for the basket's deployer */}
          {dir === 'buy' && (
            <ShareEarnNudge share={swapShare} center className="mt-2.5 border-t border-white/[0.08] pt-2.5" />
          )}
        </div>
      )}

      {pickerOpen && !fixedBasket && (
        <BasketPicker
          heads={heads}
          chainId={chainId}
          onPick={(a) => {
            setBasketAddr(a)
            setPickerOpen(false)
            dex.resetRun()
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* on-brand wait animation while the swap's steps confirm (token page + /swap) */}
      <SwapPendingOverlay
        open={pending && (dex.running || dex.done != null || dex.error != null)}
        dir={dir}
        symbol={ix?.symbol ?? ''}
        steps={stepsList}
        txOf={dex.txOf}
        running={dex.running}
        done={dex.done}
        error={dex.error}
        explorer={cfg.explorer}
        onClose={() => setPending(false)}
        token={ix ? { address: ix.address, chainId } : undefined}
        seeding={dir === 'buy' && ix?.effectiveSupply === 0}
        constituents={ix?.holdings.map((h) => ({ address: h.asset, symbol: h.symbol }))}
        share={swapShare}
        bentoItems={ix?.holdings.map((h) => ({ symbol: h.symbol, address: h.asset, weightPct: h.targetWeightPct, chainId }))}
        decimals={ix?.decimals}
        usdRaw={dex.quote?.usdcLegRaw}
      />
    </div>
  )
}

// ── chips ─────────────────────────────────────────────────────────────────────

function HubChip({
  hub, chainId, open, setOpen, onPick, disabled, choices = HUBS, usdcSym = 'USDC',
}: {
  hub: HubToken
  chainId: number
  open: boolean
  setOpen: (v: boolean) => void
  onPick: (h: HubToken) => void
  disabled?: boolean
  /** The hubs THIS CHAIN can execute (full uni infra = all three; LiFi chain =
   *  ETH + settlement; neither = settlement only). */
  choices?: HubToken[]
  /** Chain settlement-asset display name (USDC / USDG). */
  usdcSym?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, setOpen])

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="press flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1.5 pl-2 pr-3 hover:border-white/30 disabled:opacity-60"
      >
        <HubIcon hub={hub} chainId={chainId} />
        <span className="font-display text-sm font-bold text-ink">{hub === 'USDC' ? usdcSym : hub}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink-faint">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="search-pop absolute right-0 z-40 mt-2 w-44 rounded-2xl border border-white/12 bg-panel/95 p-1.5 shadow-[0_30px_70px_-15px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
          {choices.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                onPick(h)
                setOpen(false)
              }}
              className={`press flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${h === hub ? 'bg-cyan/10 ring-1 ring-inset ring-cyan/30' : 'hover:bg-white/[0.06]'}`}
            >
              <HubIcon hub={h} chainId={chainId} />
              <span className="flex-1">
                <span className="block font-display text-sm font-bold text-ink">{h === 'USDC' ? usdcSym : h}</span>
                <span className="block font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                  {h === 'ETH' ? 'native' : h === 'WETH' ? 'wrapped ether' : 'settlement asset'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Basket side of a box. With onClick it's the picker trigger; without (fixed
// mode) it renders as a static badge — the basket is the page's subject.
function BasketChip({ ix, onClick, disabled }: { ix: { address: string; symbol: string } | null; onClick?: () => void; disabled?: boolean }) {
  const inner = ix ? (
    <>
      <BasketAvatar address={ix.address} symbol={ix.symbol} size={22} />
      <span className="max-w-[6.5rem] truncate font-display text-sm font-bold text-ink">${ix.symbol}</span>
    </>
  ) : (
    <span className="font-display text-sm font-bold text-ink-dim">Select basket</span>
  )
  if (!onClick) {
    return (
      <span className="flex shrink-0 items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1.5 pl-2 pr-3">
        {inner}
      </span>
    )
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="press flex shrink-0 items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1.5 pl-2 pr-3 hover:border-white/30 disabled:opacity-60"
    >
      {inner}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink-faint">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  )
}

// ── basket picker modal ───────────────────────────────────────────────────────

function BasketPicker({
  heads, chainId, onPick, onClose,
}: {
  heads: { address: string; symbol: string; name: string; navPerToken: number; aumUsd: number; change24hPct?: number | null }[]
  chainId: number
  onPick: (address: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return heads
    return heads.filter(
      (b) =>
        b.symbol.toLowerCase().includes(needle) ||
        b.name.toLowerCase().includes(needle) ||
        b.address.toLowerCase().includes(needle),
    )
  }, [heads, q])

  // PORTALED to <body>: mounted inside a row expansion / the Explore hero, an
  // ancestor's transform or filter re-bases `fixed` and the dialog paints in a
  // clipped "weird window" (same trap as the icon popovers). On body it can't.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 pt-[12vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select a basket"
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative w-full max-w-2xl overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL }} />
        <div className="p-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search baskets, name, ticker, or address"
            spellCheck={false}
            className="w-full rounded-xl border border-white/10 bg-void/40 px-3 py-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
          />
          <div className="mt-2 max-h-[46vh] space-y-1 overflow-y-auto pr-1">
            {rows.length === 0 && (
              <p className="px-2 py-6 text-center font-mono text-[11px] text-ink-faint">
                No baskets match{q ? ` “${q}”` : ''} on this network.
              </p>
            )}
            {rows.map((b) => (
              <button
                key={b.address}
                type="button"
                onClick={() => onPick(b.address)}
                className="press flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left hover:bg-white/[0.05]"
              >
                <BasketAvatar address={b.address} symbol={b.symbol} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm font-semibold text-ink">${b.symbol}</span>
                  <span className="block truncate font-mono text-[10px] text-ink-faint">
                    {b.name} · {shortAddr(b.address)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="flex items-baseline justify-end gap-1.5">
                    <span className="font-num text-sm tabular-nums text-ink">${formatNav(b.navPerToken)}</span>
                    {b.change24hPct != null && (
                      <span className={`font-mono text-[9px] tabular-nums ${b.change24hPct >= 0 ? 'text-teal' : 'text-magenta'}`}>
                        {b.change24hPct >= 0 ? '+' : ''}{b.change24hPct.toFixed(1)}%
                      </span>
                    )}
                  </span>
                  <span className="block font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                    {b.aumUsd > 0 ? formatUsdCompact(b.aumUsd) : `on ${chainCfg(chainId).key}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── step line ─────────────────────────────────────────────────────────────────

function StepLine({ n, label, tx, explorer }: { n: number; label: string; tx: DexTxState; explorer: string }) {
  const state =
    tx.status === 'success'
      ? '✓'
      : tx.status === 'signing'
        ? 'sign in wallet…'
        : tx.status === 'confirming'
          ? 'confirming…'
          : tx.status === 'error'
            ? 'failed'
            : '—'
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-dim">
        {n} · {label}
      </span>
      <span className={tx.status === 'error' ? 'text-magenta' : tx.status === 'success' ? 'text-teal' : 'text-ink-faint'}>
        {tx.hash ? (
          <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="hover:underline">
            {state} ↗
          </a>
        ) : (
          state
        )}
      </span>
    </div>
  )
}
