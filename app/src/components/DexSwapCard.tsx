import { Link as RouterLink } from 'react-router'
import { showSymbol } from '../lib/spectrum/safe-copy'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'
import { WALLET_ENABLED } from '../lib/config/features'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatUnits, isAddress, parseUnits } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import type { BasketData } from '../lib/spectrum/basket-data'
import { useAllBaskets, useBasketData } from '../lib/spectrum/hooks'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { useDexSwap, type DexQuote, type DexTxState, type HubToken } from '../lib/spectrum/use-dex-swap'
import type { ShownFloor } from '../lib/spectrum/shown-floor'
import {
  hubPay,
  parseStoredPayToken,
  rememberRecentPayToken,
  serializePayToken,
  type PayToken,
} from '../lib/spectrum/pay-token'
import { payTokenFromHoldings } from '../lib/spectrum/pay-prefill'
import { useRawHoldings } from '../lib/spectrum/portfolio-handoff'
import { erc20BalanceAbi } from '../lib/spectrum/abis-v2'
import { clampSlippageBps, DEFAULT_SLIPPAGE_BPS } from '../lib/spectrum/hook-data'
import { formatNav, formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import { AssetLogo } from './AssetLogo'
import { InfoDot } from './InfoDot'
import { BasketAvatar } from './BasketAvatar'
import { BridgeBanner, BridgeFund } from './BridgeFund'
import { appendExec } from '../lib/spectrum/exec-log'
import { PayTokenPicker } from './PayTokenPicker'
import { RevertCauses } from './RevertCauses'
import { SwapPendingOverlay } from './SwapPendingOverlay'
import { ShareEarnNudge } from './ShareEarnNudge'
import { useNetworkSwitch, WrongNetworkNotice } from './WrongNetwork'
import { hasFinePointer } from '../lib/wallet/mobile'

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

/** The one-line strip's CTA label, kept SHORT. The full state machine's labels are
 *  written for the big console and reach 43 characters; in the strip the button is
 *  shrink-0 + nowrap, so a long one overflows the card. Every long state collapses
 *  to a 1–2 word stand-in and the full sentence goes to the button's tooltip. */
const STRIP_LABEL_MAX = 16 // fits "Select a basket" — the longest real short label

export function stripCtaLabel(label: string, amountRaw: bigint, hasBasket: boolean): string {
  if (amountRaw === 0n && hasBasket) return 'Buy'
  const trimmed = label.trim()
  // never render an empty button: an empty/blank label used to pass straight
  // through the length check and produce a button with no text at all
  if (!trimmed) return 'Buy'
  if (trimmed.length <= STRIP_LABEL_MAX) return trimmed
  if (/^Switch wallet/i.test(trimmed)) return 'Switch network'
  if (/^Connect/i.test(trimmed)) return 'Connect'
  if (/no router/i.test(trimmed)) return 'Preview only'
  if (/^First buy/i.test(trimmed)) return 'Minimum'
  if (/insufficient|balance/i.test(trimmed)) return 'Low balance'
  // last resort: cut at the first separator, then at a WORD boundary — a
  // mid-word chop ("Select a baske") reads like a rendering bug
  const head = trimmed.split(/[·—,(]/)[0].trim()
  if (head && head.length <= STRIP_LABEL_MAX) return head
  const words = (head || trimmed).split(/\s+/)
  let out = ''
  for (const w of words) {
    if ((out ? `${out} ${w}` : w).length > STRIP_LABEL_MAX) break
    out = out ? `${out} ${w}` : w
  }
  return out || 'Buy'
}

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
  initialAmount = null,
  initialDir = 'buy',
  initialSlippageBps,
  large = false,
  strip = false,
  defaultHub,
  stayHere,
  payFromHoldings = false,
  onBasketChange,
  onTraded,
}: {
  chainId: number
  /** Lock the console to one already-loaded basket (Token page) — no picker. */
  fixedBasket?: BasketData | null
  /** Free mode: preselect this basket address (deep link). */
  initialBasket?: string | null
  /** Prefill the pay amount (quick-buy deep link) — never blank-by-default. */
  initialAmount?: string | null
  /** Which side the console OPENS on. The chat's sell turns pass 'sell' — a
   *  sell card that opens on buy hands the user a flip they never asked for. */
  initialDir?: 'buy' | 'sell'
  /** Seed the tolerance dial ("with 1% slippage" in chat); clamped to the
   *  card's own bounds. The dial stays fully editable after. */
  initialSlippageBps?: number
  /** Roomier paddings + typography for the standalone /swap page. */
  large?: boolean
  /** The one-row streamlined buy (owner 19:24): pay left → basket right → Buy.
   *  Same state machine, quotes, guards and overlay — just the strip layout. */
  strip?: boolean
  /** Pay-side token preselected on mount — the seed prompt opens on USDC
   *  (owner 2026-07-07 13:57); everywhere else stays ETH. Left UNSET means the
   *  host has no opinion, which is what lets the holdings prefill below have
   *  one; a value here is host context and beats any suggestion. */
  defaultHub?: HubToken
  /** The HOST owns the whole flow and must not hand the user off after a buy
   *  (the chat). Forwarded to the success overlay, which then makes Done the
   *  primary instead of the portfolio hand-off. */
  stayHere?: boolean
  /** Opt in to opening the pay side on what the wallet actually holds (owner
   *  QOL round 2026-08-05). Off by default: it costs a wallet-wide holdings
   *  read, which only the standalone console is roomy enough to earn — the
   *  Explore strips and the Token page card stay exactly as cheap as they were. */
  payFromHoldings?: boolean
  /** Fired when the selected basket changes — lets a host page (the /swap
   *  context panel) follow the console's selection. */
  onBasketChange?: (address: string | null) => void
  /** Fired ONCE per completed swap (the dex.done transition) — lets a host
   *  (the chat) narrate the outcome. Purely observational: no money logic
   *  moves through it, and absent means exactly today's behavior. */
  onTraded?: (info: { side: 'buy' | 'sell'; symbol: string; label: string; hash: string }) => void
}) {
  const cfg = chainCfg(chainId)
  const { isConnected } = useAccount()
  // One switch mutation for the console: the CTA state machine below performs the
  // switch, the shared notice speaks for it (the 2026-08-05 wrong-network
  // consolidation — see WrongNetwork.tsx).
  const netSwitch = useNetworkSwitch(chainId)
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

  const [dir, setDir] = useState<'buy' | 'sell'>(initialDir)
  // Hub availability per chain: full Uniswap infra (Base/Ethereum) = ETH/WETH/
  // settlement; a LiFi external-hub chain (Robinhood) = ETH + settlement (the
  // ETH hop rides LiFi's verified diamond, WETH doesn't exist there); neither =
  // settlement-direct only. Computed here so the DEFAULT is right pre-hook.
  const depHere = deploymentFor(chainId)
  const hubInfra = !!depHere.uniV3SwapRouter && !!depHere.uniV3Quoter && !!depHere.weth
  const lifiHubChain = cfg.externalHubRouter === 'lifi' && !hubInfra
  const hubChoices: HubToken[] = hubInfra ? HUBS : lifiHubChain ? ['ETH', 'USDC'] : ['USDC']
  // Any-token pay side rides LiFi — offered only where LiFi covers the chain.
  const anyTokenPay = cfg.hasLifi
  // Remembered pay token (owner 2026-07-29, ease-of-buying): the pay side is a
  // standing preference, so re-picking it on every visit is pure friction. Per
  // chain, because what a wallet holds differs per chain. A caller-supplied
  // `defaultHub` (the seed prompt's USDC) still wins — it is context, not habit.
  // Since batch 2 the pay side may also be ANY ERC-20 (`PayToken`); hub picks
  // persist as the same bare names as before, so old preferences keep working.
  const payMemKey = `spectrum:pay-token:${chainId}`
  const [pay, setPay] = useState<PayToken>(() => {
    if (!(hubInfra || lifiHubChain)) return hubPay('USDC')
    // CONTEXT BEATS HABIT — and it has to be checked FIRST to mean anything. The
    // saved pick used to be returned before `defaultHub` was consulted at all,
    // which made the comment above false: pick ETH once in a chat card and every
    // later chat buy reopened on ETH, so "buy $25" preset 25 ETH again — the very
    // confusion this prop was added to kill. Only surfaces that QUOTE IN DOLLARS
    // pass defaultHub (the chat card, the seed prompt); /swap and the token page
    // pass nothing and go on remembering, which is right for them.
    if (defaultHub) return hubPay(defaultHub)
    try {
      const saved = parseStoredPayToken(window.localStorage.getItem(payMemKey), chainId, hubInfra ? HUBS : ['ETH', 'USDC'])
      if (saved && (saved.kind === 'hub' || anyTokenPay)) return saved
    } catch {
      /* privacy mode — fall through to the default */
    }
    return hubPay('ETH')
  })
  // The hub view of the pay side (null = a custom ERC-20 riding LiFi).
  const hub: HubToken | null = pay.kind === 'hub' ? pay.hub : null
  const paySymbol = pay.kind === 'hub' ? (pay.hub === 'USDC' ? cfg.usdcSymbol : pay.hub) : pay.symbol
  // Persist ONLY on an explicit pick (audit 2026-07-29 #3): the old effect ran
  // on every pay/key change, so an in-place chain switch wrote the PREVIOUS
  // chain's pay token over the NEW chain's saved preference before the fit
  // fallback could run — destroying exactly what the feature remembers.
  const persistPay = (p: PayToken) => {
    try {
      window.localStorage.setItem(payMemKey, serializePayToken(p))
    } catch {
      /* storage unavailable — the preference is a nicety */
    }
  }
  useEffect(() => {
    // A pay side that no longer fits the chain falls back to settlement: a hub
    // this chain can't execute, an ERC-20 pinned to a DIFFERENT chain (addresses
    // mean nothing across chains), or an ERC-20 where LiFi has no coverage.
    if (pay.kind === 'hub' && !hubChoices.includes(pay.hub)) setPay(hubPay('USDC'))
    if (pay.kind === 'erc20' && (pay.chainId !== chainId || !anyTokenPay)) {
      const saved = parseStoredPayToken(
        (() => {
          try {
            return window.localStorage.getItem(payMemKey)
          } catch {
            return null
          }
        })(),
        chainId,
        hubInfra ? HUBS : ['ETH', 'USDC'],
      )
      setPay(saved && (saved.kind === 'hub' || anyTokenPay) ? saved : hubPay('USDC'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubInfra, lifiHubChain, chainId])
  // Display name of the settlement asset: USDC on Base/Ethereum, USDG on
  // Robinhood Chain. Mechanics identical — labels only.
  const usdcSym = cfg.usdcSymbol
  // A prefilled amount (quick-buy from a card) — an empty field is a decision
  // forced on the buyer, so a caller can hand one over.
  const [amount, setAmount] = useState(initialAmount ?? '')
  const [slippageBps, setSlippageBps] = useState(initialSlippageBps != null ? clampSlippageBps(initialSlippageBps) : DEFAULT_SLIPPAGE_BPS)
  const [customSlip, setCustomSlip] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hubMenuOpen, setHubMenuOpen] = useState(false)
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false)
  // Cross-chain funding (owner 2026-07-29, phase 2): move funds from another
  // network into this wallet as settlement, then buy with the ARRIVED amount.
  const [bridgeOpen, setBridgeOpen] = useState(false)
  const bridgeAvailable = cfg.hasLifi && SUPPORTED_CHAIN_IDS.some((id) => id !== chainId && chainCfg(id).hasLifi)
  const useArrived = (arrivedRaw: bigint) => {
    hubPicked.current = true
    setDir('buy')
    setPay(hubPay('USDC'))
    persistPay(hubPay('USDC'))
    setAmount(formatUnits(arrivedRaw, 6))
    dex.resetRun()
  }
  const [flipped, setFlipped] = useState(false)
  // Trade details (fee/min/route/slippage) fold behind one summary row — the
  // rail stays clean until the user asks for the numbers (owner ask 2026-07-05).
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Whether the pending-animation pop-up is showing (opened on execute, dismissed
  // by the user on done/error).
  const [pending, setPending] = useState(false)
  /** THE FLOOR AS PAINTED — the other half of the displayed-vs-signed gate.
   *  Written in an effect below (never during render, never in a memo) so it
   *  holds what was on screen when the user decided, which is the only thing
   *  worth comparing a click-time recomputation against. Null whenever the
   *  minimum is not on screen, which is normal: see lib/spectrum/shown-floor.ts
   *  for why null must mean "no promise made" rather than "refuse". */
  const shownFloorRef = useRef<ShownFloor | null>(null)

  const dex = useDexSwap(ix, dir, pay, chainId)

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
    setPay(hubPay('USDC'))
  }, [viewerUsdc, hub, dir, ix?.effectiveSupply])

  // ── THE CONSOLE KNOWS WHAT YOU HOLD ────────────────────────────────────────
  // Owner QOL round 2026-08-05, from his own captured idea: the swap page should
  // interface the portfolio and basket systems and be smart about what you
  // already have. First step, and deliberately the smallest one: the pay box
  // OPENS on the wallet's largest priced holding on this network instead of a
  // static ETH. Form default only — quoting, routing, approvals and slippage are
  // untouched. The choice itself lives in pay-prefill.ts (pure, with the honesty
  // laws: unpriced is null and never "biggest", and nothing priced here means the
  // existing default stands exactly as it was).
  //
  // A SUGGESTION, NEVER A HIJACK. It applies at most once, and only to a form
  // nobody has expressed anything about yet:
  //  · `hubPicked` — the user chose a pay token — blocks it forever, exactly as
  //    it blocks the seed default above. Their pick is never overridden.
  //  · A REMEMBERED pay token for this chain is that same pick from a past visit
  //    (only an explicit pick is ever persisted), so it wins outright.
  //  · A host-supplied `defaultHub` and a quick-buy `initialAmount` are
  //    instructions from a link, and an instruction beats a guess. The amount
  //    matters twice: an amount is denominated in the PAY token, so re-seating
  //    the token would silently change what that number means.
  //  · A typed amount closes the window for that same reason.
  //  · Buys only, and never mid-run: in sell mode this side is the basket.
  // ONE-SHOT THROUGH A REF, NOT A TIMER: the holdings read refetches on its own
  // schedule, and re-applying on a refetch would yank the box out from under
  // somebody who had already moved on. The ref also switches the read off again,
  // so the sweep stops the moment the question is answered. Switching network
  // does NOT re-open it either — one mount, one suggestion; the chain toggle
  // keeps whatever the pay side already is, exactly as it did before.
  const payPrefilled = useRef(false)
  const rememberedPay = useMemo(() => {
    try {
      const saved = parseStoredPayToken(window.localStorage.getItem(payMemKey), chainId, hubInfra ? HUBS : ['ETH', 'USDC'])
      return saved != null
    } catch {
      return false // privacy mode: no stored preference to respect
    }
  }, [payMemKey, chainId, hubInfra])
  const wantPayPrefill =
    payFromHoldings &&
    isConnected &&
    !!viewerAddr &&
    !payPrefilled.current &&
    !hubPicked.current &&
    !rememberedPay &&
    defaultHub == null &&
    !initialAmount &&
    amount === '' &&
    dir === 'buy' &&
    !dex.running &&
    dex.done == null
  // The portfolio's own reader, not a second one — and the CONNECTED wallet
  // alone, never the linked-wallet group the book pages read: this console spends
  // from one wallet, and suggesting a token a different wallet holds would seat a
  // balance of zero.
  const { data: rawBook } = useRawHoldings(wantPayPrefill ? viewerAddr : undefined)
  useEffect(() => {
    // Anything the user does to this form closes the window for good: a box that
    // has been typed in (even if cleared again) or flipped to sell is not an
    // untouched form, so the suggestion never gets a second chance at it.
    if (amount !== '' || dir !== 'buy') payPrefilled.current = true
    if (!wantPayPrefill || payPrefilled.current || !rawBook) return
    // Wait for the basket, then stand aside for an UNSEEDED first buy: the seed
    // default above is about the trade being possible at all (the 10 USDC floor
    // on the basket leg), which outranks a comfort default.
    if (!ix || ix.effectiveSupply === 0) return
    // Asked once, answered once — whatever the answer.
    payPrefilled.current = true
    const next = payTokenFromHoldings(rawBook.holdings, {
      chainId,
      hubChoices,
      anyTokenPay,
      weth: depHere.weth,
      usdc: depHere.usdc,
      exclude: [ix.address],
    })
    if (!next) return // nothing priced on this network: leave the default alone
    // No-op guard: the default may already be the right answer.
    if (next.kind === 'hub' && pay.kind === 'hub' && pay.hub === next.hub) return
    if (next.kind === 'erc20' && pay.kind === 'erc20' && pay.address.toLowerCase() === next.address.toLowerCase()) return
    // NOT persisted: a suggestion is not a preference. persistPay is for picks.
    setPay(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawBook, wantPayPrefill, amount, dir, chainId, ix?.address, ix?.effectiveSupply])

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
    const text = `I just added $${showSymbol(ix.symbol)} to my portfolio, take a look`
    const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
    return { url, xHref }
  })()

  const paySideDecimals = pay.kind === 'hub' ? hubDecimals(pay.hub) : pay.decimals
  const payDecimals = dir === 'buy' ? paySideDecimals : Math.min(ix?.decimals ?? 18, 18)
  const receiveDecimals = dir === 'buy' ? Math.min(ix?.decimals ?? 18, 18) : paySideDecimals
  const amountRaw = useMemo(() => {
    try {
      const v = parseUnits(amount || '0', payDecimals)
      return v > 0n ? v : 0n
    } catch {
      return 0n
    }
  }, [amount, payDecimals])

  // Debounced quoting. Keyed on `pay` (the object), NOT the derived `hub` —
  // hub is null for EVERY custom token, so an erc20→erc20 switch with the same
  // decimals would otherwise keep showing the previous token's quote (audit
  // 2026-07-29; execution always re-quotes fresh, this is display integrity).
  useEffect(() => {
    const t = window.setTimeout(() => void dex.refreshQuote(amountRaw, slippageBps, feeFrac), 320)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountRaw, slippageBps, feeFrac, pay, dir, ix?.address, chainId])

  const wrongChain = netSwitch.mismatch
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

  // NAV-fair deviation of the LIVE quote (the LPADS report, 2026-08-02): a
  // basket whose holdings have DRIFTED from its target weights mints every buy
  // at the most-drifted leg (the router splits funding by TARGET weights; the
  // min-rule keeps the other legs' overshoot in the basket), so fills can sit
  // FAR under NAV at every size — measured live: −28% flat from $10 to $1,000.
  // The number is honest; unexplained it reads as a wrong price. Facts only:
  // both sides are already valued above (receive at NAV, pay in settlement $).
  const navDeviationPct =
    payUsd != null && receiveUsd != null && payUsd > 0 && ix?.navPerToken
      ? (receiveUsd / payUsd - 1) * 100
      : null
  const showNavGap = navDeviationPct != null && navDeviationPct < -3

  // ── CTA state machine ────────────────────────────────────────────────────
  let cta: { label: string; onClick?: () => void; disabled: boolean } = { label: 'Swap', disabled: true }
  if (!dex.configured) cta = { label: 'Preview only · no router configured', disabled: true }
  else if (!ix)
    cta = fixedBasket
      ? { label: 'Loading basket…', disabled: true }
      : { label: 'Select a basket', onClick: () => setPickerOpen(true), disabled: false }
  // The CTA CONNECTS instead of pointing at desktop geography ("top right" is
  // nothing on a phone; mobile UX review 4) — WalletButton listens for this.
  else if (!isConnected)
    cta = { label: 'Connect wallet', onClick: () => window.dispatchEvent(new Event('spectrum:connect')), disabled: false }
  else if (wrongChain)
    cta = {
      label: netSwitch.switching ? 'Confirm in wallet…' : `Switch wallet to ${cfg.name}`,
      onClick: netSwitch.switchNow,
      disabled: netSwitch.switching,
    }
  else if (dex.running) cta = { label: 'Swapping…', disabled: true }
  else if (dex.done) cta = { label: 'Swap again', onClick: () => { setAmount(''); dex.resetRun() }, disabled: false }
  else if (amountRaw === 0n) cta = { label: 'Enter an amount', disabled: true }
  else if (insufficient) cta = { label: `Insufficient ${dir === 'buy' ? paySymbol : `$${showSymbol(ix.symbol)}`} balance`, disabled: true }
  else if (seedShort) cta = { label: `First buy needs ≥ 10 ${usdcSym} on the basket leg`, disabled: true }
  else if (dex.quoting) cta = { label: 'Quoting…', disabled: true }
  else if (!Number.isFinite(feeFrac)) cta = { label: 'Loading fees…', disabled: true }
  else if (!dex.quote)
    // a re-quote lever, not a dead label (audit 2026-08-16: the quote effect
    // only re-fires on input changes, so this state had no way out)
    cta = { label: 'Re-quote', onClick: () => dex.refreshQuote(amountRaw, slippageBps, feeFrac), disabled: false }
  else if (dex.error) cta = { label: 'Retry swap', onClick: () => runSwap(), disabled: false }
  else cta = { label: dir === 'buy' ? `Buy $${showSymbol(ix.symbol)}` : `Sell $${showSymbol(ix.symbol)}`, onClick: () => runSwap(), disabled: false }

  // The last completed swap, kept AFTER the overlay closes — the page itself
  // remembers what just happened (expected units captured at fire time; the
  // receipt is the tx, linked).
  const [lastSwap, setLastSwap] = useState<{ hash: string; label: string } | null>(null)
  const pendingRef = useRef<string | null>(null)
  useEffect(() => {
    if (dex.done && pendingRef.current) {
      setLastSwap({ hash: dex.done.hash, label: pendingRef.current })
      if (ix) onTraded?.({ side: dir, symbol: ix.symbol, label: pendingRef.current, hash: dex.done.hash })
      pendingRef.current = null
      // SINGLE SWAPS JOIN THE HISTORY (owner 2026-08-16: "recent transactions
      // still only show basket trades, should show all txs") — one exec-log
      // row per completed console swap, the same store the portfolio runs
      // write, so the recent-transactions card reads one stream. The dollar
      // figure is the quote's settlement leg captured at fire time; unknown
      // stays null, never zero.
      if (viewerAddr && ix) {
        const usd = dex.quote?.usdcLegRaw != null ? Number(dex.quote.usdcLegRaw) / 1e6 : null
        appendExec(viewerAddr, {
          ts: Date.now(),
          kind: 'swap',
          totalUsd: dir === 'buy' ? usd : null,
          changes: [{ symbol: ix.symbol, deltaUsd: usd == null ? 0 : dir === 'buy' ? usd : -usd }],
          simulated: false,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex.done])

  // Kick off the swap AND raise the pending pop-up (the on-brand wait animation).
  function runSwap() {
    const out = dex.quote ? fmtAmt(dex.quote.outRaw, receiveDecimals) : null
    pendingRef.current =
      out && ix
        ? dir === 'buy'
          ? `≈ ${out} $${showSymbol(ix.symbol)} received`
          : `≈ ${out} ${showSymbol(paySymbol)} received`
        : 'Swap confirmed'
    setLastSwap(null)
    setPending(true)
    void dex.execute(amountRaw, slippageBps, feeFrac, shownFloorRef.current)
  }

  // THE CAPTURE, in an effect so it records what was PAINTED rather than what a
  // memo happens to hold at click — the distinction is the whole gate, because
  // comparing a click-time value against another click-time value can never fire.
  //
  // ⚠ THE CLAIM IS STICKY PER QUOTE, NOT PER FOLD (specallocator's cold pass,
  // 2026-08-07). The first version cleared it whenever `detailsOpen` went false,
  // which discarded a promise that HAD been made: open the fold, read "Minimum
  // received", close the fold, swap — three clicks, and the gate silently
  // stopped applying because of a UI action with nothing to do with the money.
  // Hiding a number does not unsee it. So the claim now survives the fold
  // closing and dies only when a NEWER quote replaces the one that was painted.
  //
  // Keying on `[dex.quote]` alone would be wrong in the OPPOSITE direction: a
  // fold never opened would carry a claim about a number nobody ever saw, and
  // refuse on it. `paintedForRef` is what separates the three states this
  // reasoning actually needs — never painted (no claim), painted and visible
  // (claim), painted then hidden (claim persists).
  const paintedForRef = useRef<DexQuote | null>(null)
  useEffect(() => {
    const q = dex.quote
    if (detailsOpen && q) {
      paintedForRef.current = q
      shownFloorRef.current = {
        minOutRaw: q.minOutRaw,
        quotedInRaw: q.amountInRaw,
        floorBasis: q.floorBasis,
        // what this claim is ABOUT — switching baskets does not remount this
        // card, so without these the claim outlives the trade it describes
        basket: ix?.address ?? '',
        chainId,
        direction: dir,
      }
    } else if (q !== paintedForRef.current) {
      // no quote at all, or a quote NEWER than the painted one — either way the
      // claim describes a number that is no longer the one on screen
      paintedForRef.current = null
      shownFloorRef.current = null
    }
  }, [dex.quote, detailsOpen])

  const boxPad = large ? 'p-6' : 'p-5'
  const amountText = large ? 'text-5xl' : 'text-4xl'
  // The pay/receive boxes are backdrop-filter surfaces, so each is its own
  // stacking context — the hub dropdown would paint UNDER the next card. The
  // box hosting the open menu is raised above its siblings while open.
  const hubBoxZ = hubMenuOpen ? 'z-30' : 'z-[1]'

  const hubChip = (
    <PayChip
      pay={pay}
      chainId={chainId}
      open={hubMenuOpen}
      setOpen={setHubMenuOpen}
      onPickHub={(h) => { hubPicked.current = true; setPay(hubPay(h)); persistPay(hubPay(h)); dex.resetRun() }}
      onAnyToken={anyTokenPay ? () => { setHubMenuOpen(false); setTokenPickerOpen(true) } : undefined}
      disabled={dex.running}
      choices={hubChoices}
      usdcSym={usdcSym}
    />
  )
  const payTokenPicker = tokenPickerOpen ? (
    <PayTokenPicker
      chainId={chainId}
      exclude={[depHere.usdc, depHere.weth, ix?.address]}
      onPick={(t) => {
        hubPicked.current = true
        rememberRecentPayToken(t)
        setPay(t)
        persistPay(t)
        setTokenPickerOpen(false)
        dex.resetRun()
      }}
      onClose={() => setTokenPickerOpen(false)}
    />
  ) : null
  const basketChip = (
    <BasketChip ix={ix} onClick={fixedBasket ? undefined : () => setPickerOpen(true)} disabled={dex.running} />
  )

  // ── the STRIP: buy-only — every guard/quote/overlay shared. Two balanced,
  //    labeled cells (You pay | You receive) bridged by a directional badge,
  //    the CTA riding the right edge (owner 2026-07-07 14:5x: "way more
  //    beautiful and balanced"). ONE line on sm+ (owner 2026-07-29 — never
  //    two); MOBILE stacks cleanly full-width (nowrap there crushed the chips
  //    into each other — his overlap report). ─────────────────────────────────
  if (strip) {
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
        {/* ONE LINE when it FITS, two when it doesn't — keyed to the CONTAINER,
            not the viewport (owner 2026-07-30: "the quick swap buttons overlap,
            they should never overlap, make the card wider to fit it").
            Why it overlapped: every element except the amount input and the
            estimate is `shrink-0` (chips truncate, the CTA is nowrap), so those
            two were the only give in the row — they collapsed to zero width and
            then the fixed items still overflowed and collided. A `sm:` viewport
            breakpoint can't see that, because this strip is embedded at wildly
            different widths (a narrow Explore column, a full-width expansion, a
            phone). So: `@container` here + `@min-[34rem]` for the single-row
            layout, and the two flexible zones carry a real min width so the row
            WRAPS instead of squeezing. Same state machine and guards. */}
        <div
          className={`@container relative flex flex-wrap items-center gap-2 rounded-2xl card-surface p-2 backdrop-blur-md ${hubMenuOpen ? 'z-30' : ''}`}
        >
          {/* pay: token + amount. `flex-[1.1_1_0]` sets basis 0 EXPLICITLY —
              `flex-[1.1]` alone leaves basis at content width, and the later
              `basis-auto` used to re-assert it, so this cell started at full
              content size while the receive cell (flex-1 → basis 0) collapsed:
              the exact overlap the container-query change was meant to end. */}
          <div className="flex min-w-0 basis-full items-center gap-1.5 @min-[34rem]:flex-[1_1_0]">
            {hubChip}
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal" enterKeyHint="done" autoComplete="off"
              placeholder="0"
              size={1}
              disabled={dex.running}
              aria-label="Amount to pay"
              /* min-w keeps the amount readable: without it this was the first
                 thing to collapse to 0, and the row then overflowed (overlapping
                 controls) instead of wrapping */
              className="min-w-[3.5rem] flex-1 bg-transparent text-right font-num text-lg font-light tabular-nums text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            {dex.payBalance != null && (
              <button
                type="button"
                onClick={setMax}
                title={`Balance ${fmtAmt(dex.payBalance, payDecimals)} — use it all`}
                className="press shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint hover:text-cyan"
              >
                Max
              </button>
            )}
          </div>

          <span
            aria-hidden
            className={`hidden shrink-0 font-mono text-sm @min-[34rem]:inline ${dex.quote ? 'text-cyan' : 'text-ink-faint'}`}
          >
            →
          </span>

          {/* receive: basket + estimate + Buy — one wrapping unit, so the CTA
              always travels with the row it belongs to instead of being orphaned
              onto a line of its own */}
          <div className="flex basis-full items-center gap-2 @min-[34rem]:flex-[1.2_1_0] @min-[34rem]:basis-auto">
            {/* min-w-[7rem], not min-w-0: with 0 this box squeezed BELOW its
                content instead of forcing a wrap, which is how the chip and the
                estimate ended up painted over the Buy button */}
            <div className="flex min-w-[7rem] flex-1 items-center gap-1.5">
            {basketChip}
            <span
              title="Estimated amount received"
              className={`min-w-[3.5rem] flex-1 truncate text-right font-num text-lg font-light tabular-nums ${dex.quote ? 'text-ink' : 'text-ink-faint'}`}
            >
              {dex.quoting ? <span className="animate-pulse">…</span> : fmtAmt(dex.quote?.outRaw ?? null, receiveDecimals)}
            </span>
            </div>

            {/* SHORT label only. cta.label runs up to 43 chars ("Preview only ·
                no router configured", "First buy needs ≥ 10 USDG …") and this
                button is shrink-0 + nowrap inside an unclipped card, so the long
                states used to bleed straight out of the card at every width. The
                full text rides the tooltip; the strip is not where prose goes. */}
            <button
              type="button"
              disabled={cta.disabled}
              onClick={cta.onClick}
              title={cta.label}
              className={`press shrink-0 whitespace-nowrap rounded-xl px-4 py-2 font-display text-[11px] font-bold uppercase tracking-[0.12em] transition-transform hover:enabled:scale-[1.02] active:enabled:scale-[0.97] disabled:cursor-not-allowed ${
                !cta.disabled && amountRaw > 0n ? 'text-black' : 'border border-white/12 bg-white/[0.04] text-ink-dim disabled:opacity-70'
              }`}
              style={!cta.disabled && amountRaw > 0n ? { background: SPECTRAL } : undefined}
            >
              {stripCtaLabel(cta.label, amountRaw, !!ix)}
            </button>
          </div>
        </div>
        {/* Wrong network, said before the signature. The strip is ONE line and is
            not where prose goes (see the CTA label comment above), so the shared
            notice rides below the card in its compact form: both networks named,
            the CTA above stays the switch, its short label unchanged. */}
        <WrongNetworkNotice
          sw={netSwitch}
          requiredChainId={chainId}
          action="This swap runs"
          enabled={dex.configured}
          compact
          className="mt-2"
        />
        {/* THE REASON THE BUTTON IS DEAD, WHERE A FINGER CAN READ IT (QOL
            2026-08-07). The strip returns long before the full card's seed-min
            and quote-error notices, so on this layout those two states reached
            the user as a TRUNCATED label and nothing else — "Quote unavailable"
            became "Quote", "First buy needs ≥ 10 USDG…" became "Minimum" — with
            the sentence itself only in title=, which a phone cannot show at all.
            The compact wrong-network notice directly above is the precedent: the
            strip stays one line and the prose rides underneath it. */}
        {seedShort && ix && (
          <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
            This is ${showSymbol(ix.symbol)}&rsquo;s FIRST buy, it seeds the basket&rsquo;s reserves and the
            contract requires at least 10 {usdcSym} to reach the basket leg. Increase the amount.
          </div>
        )}
        {dex.quoteError && amountRaw > 0n && !dex.quoting && (
          <p className="mt-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
            {dex.quoteError}
          </p>
        )}
        {/* the strip states WHY a swap failed (audit 2026-08-16: the reason
            lived only in the transient overlay — closed, it was gone, leaving
            a bare Retry label; the full card always had this block) */}
        {dex.error && !dex.running && (
          <p className="mt-2 rounded-lg border border-magenta/25 bg-magenta/[0.05] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
            {dex.error}
            <RevertCauses error={dex.error} />
          </p>
        )}
        {/* the low-balance state gets its sentence AND its bridge door on the
            strip too (they were full-card-only; on touch the title attr where
            the sentence hid is unreachable) */}
        {insufficient && dir === 'buy' && bridgeAvailable && (
          <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
            Not enough {paySymbol} on {cfg.name} for this buy.{' '}
            <button type="button" onClick={() => setBridgeOpen(true)} className="press text-cyan hover:underline">
              Move funds from another network →
            </button>
          </p>
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
        {payTokenPicker}
        {/* arrivals banner — the STANDALONE swap page only (owner 2026-08-16:
            "shouldnt show above the swap on basket/bundle page"); compact
            hosts ride without it */}
        {large && (
          <div className="mt-2 empty:hidden">
            <BridgeBanner chainId={chainId} onUse={useArrived} />
          </div>
        )}
        <SwapPendingOverlay
          stayHere={stayHere}
          onRetry={() => void runSwap()}
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
        {/* the strip's own mount — the full card's (below) is unreachable
            from this early return */}
        {bridgeOpen && <BridgeFund destChainId={chainId} onClose={() => setBridgeOpen(false)} arrivalsShown={large} />}
      </div>
    )
  }

  return (
    <div className="relative">
      {/* live cross-chain arrivals into this wallet (persisted; survives
          reload) — the STANDALONE swap page only (owner 2026-08-16: the
          basket/bundle pages' consoles stay clean; /swap is where funding
          and bridging is the page's own job) */}
      {large && (
        <div className="mb-3 empty:hidden">
          <BridgeBanner chainId={chainId} onUse={useArrived} />
        </div>
      )}

      {/* ── PAY ─────────────────────────────────────────────────────────── */}
      <section className={`relative rounded-3xl card-surface backdrop-blur-md transition-shadow focus-within:ring-1 focus-within:ring-cyan/25 ${boxPad} ${dir === 'buy' ? hubBoxZ : 'z-[1]'}`}>
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          <span>You pay</span>
          {dex.payBalance != null && (
            <span className="flex items-center gap-1">
              <span className="mr-1 tabular-nums">{fmtAmt(dex.payBalance, payDecimals)}</span>
              {/* visual size unchanged; after:-inset expands the TOUCH target
                  toward the 44px floor — these are precision-critical money
                  chips (mis-tap Max vs 50%; mobile UX review 6) */}
              {([25, 50] as const).map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setAmount(formatUnits((dex.payBalance! * BigInt(pct)) / 100n, payDecimals))}
                  className="press relative rounded-md border border-white/10 px-1.5 py-0.5 after:absolute after:-inset-2.5 hover:border-cyan/40 hover:text-cyan"
                >
                  {pct}%
                </button>
              ))}
              <button type="button" onClick={setMax} className="press relative rounded-md border border-cyan/30 px-1.5 py-0.5 text-cyan after:absolute after:-inset-2.5 hover:border-cyan/60">
                Max
              </button>
            </span>
          )}
        </div>
        {/* mt-4 on phones (owner 2026-08-06 23:13: "a little bit more padding
            between the ETH and the buttons above it"). 8px put the ETH chip
            directly under the balance row's 25%/50%/Max chips — and those chips
            carry an `after:-inset-2.5` touch pad that reaches 10px DOWN, i.e.
            past the gap and into the chip's own tap area. 16px clears the pad
            and gives the money row room to breathe. sm: keeps desktop at 8px. */}
        <div className="mt-4 flex items-center gap-3 sm:mt-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal" enterKeyHint="done" autoComplete="off"
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
        {dir === 'buy' && bridgeAvailable && (
          <div className="mt-2 text-right">
            <button
              type="button"
              onClick={() => setBridgeOpen(true)}
              /* thumb target + no orphaned arrow (mobile sweep 2026-08-06: a
                 ~13px hit area, wrapping with the → alone on line 2). Its
                 setMax/half siblings already got this treatment.
                 ONE LINE at phone width (owner 2026-08-06 23:13: "that just
                 needs to be maybe just one line of text"): `text-balance` still
                 gave two lines because the old question-form label measured
                 ~315px inside a ~292px card. The question form is gone — the
                 label is now the imperative it always meant, short enough to
                 hold one line in the narrowest host that mounts this console
                 (the seed modal, ~270px inner), and `whitespace-nowrap` keeps
                 it that way. The 36px thumb target stays. */
              className="press inline-flex min-h-[36px] items-center whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-cyan sm:min-h-0"
            >
              Move funds from another network →
            </button>
          </div>
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
        {/* same phone gap as the pay box above — the two boxes are one visual
            pair on a phone, and only one of them breathing reads as a bug */}
        <div className="mt-4 flex items-center gap-3 sm:mt-2">
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
      {/* WHAT HAPPENS WHEN I BUY (owner 2026-08-03: the buy moment is where a
          newcomer hesitates) — three steps, one quiet line, buys only, and
          deliberately OUTSIDE the typed-amount gate: the person this serves
          has an empty console. */}
      {/* the you-pay-it-buys explainer left entirely on the owner's
          2026-08-18 word ("remove … text on the basket / bundle individual
          pages") — the 08-15 one-line cut finished the journey to zero */}
      {(amountRaw > 0n || dex.quote != null) && (
        <>
        {showNavGap && (
          <p className="mt-3 flex items-baseline gap-1.5 rounded-xl border border-magenta/25 bg-magenta/[0.05] px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-ink-dim">
            <span className="font-num font-semibold tabular-nums text-magenta">{navDeviationPct!.toFixed(1)}%</span>
            <span>
              vs the basket&rsquo;s NAV price
              <InfoDot>
                {dir === 'buy' ? (
                  <>
                    This basket&rsquo;s holdings have drifted from its target mix, and a buy mints
                    at the most-drifted holding: the buy is split by the ORIGINAL target weights,
                    and whatever overshoots on the other holdings stays in the basket for its
                    existing holders. Nobody collects this as a fee, and a smaller buy does not
                    reduce it — the gap is the same at every size until the basket is rebalanced
                    back toward its targets or the drifted holding&rsquo;s price converges.
                  </>
                ) : (
                  <>
                    This sale fills below the basket&rsquo;s NAV price: exiting sells each holding
                    into its own pool, and thin pools plus fees take their real cost. The quote is
                    what the chain pays right now.
                  </>
                )}
              </InfoDot>
            </span>
          </p>
        )}
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
                  ? `1 ${showSymbol(paySymbol)} ≈ ${rate.toLocaleString('en-US', { maximumFractionDigits: 4 })} $${showSymbol(ix.symbol)}`
                  : `1 $${showSymbol(ix.symbol)} ≈ ${rate.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${showSymbol(paySymbol)}`
              ) : (
                <span className="text-ink-faint">Trade details</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-ink-faint">
              {/* A WIDE TOLERANCE ON A SELL IS THE EXPOSURE (SpectrumContracts
                  measured it 2026-08-04: a floorless sell gave up 700 BPS to a
                  sandwich, and the aggregate floor IS the seller's only
                  protection — there are no per-leg floors on this path). Our
                  own revert advice suggests raising tolerance, so the cost of
                  doing it has to be visible at the place it is set. */}
              <span
                className={`tabular-nums ${dir === 'sell' && slippageBps > DEFAULT_SLIPPAGE_BPS ? 'text-amber-300/90' : ''}`}
                title={
                  dir === 'sell' && slippageBps > DEFAULT_SLIPPAGE_BPS
                    ? 'On a sell this tolerance is your only protection — a wide one is what a sandwich extracts'
                    : undefined
                }
              >
                {(slippageBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% slip
              </span>
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
                {/* The fee in DOLLARS beside the percent (owner 2026-08-03:
                    simplify — say the money). payUsd is the quote's own USDC
                    mid-leg, the same money the route pivots through — never a
                    second price. Buys only: exits carry no basket fee here. */}
                <span className="tabular-nums">
                  {fees ? `${(fees.basketFeeBps / 100).toFixed(2)}%` : '—'}
                  {fees && dir === 'buy' && payUsd != null && payUsd > 0 && (
                    <span className="text-ink-faint">
                      {' '}
                      · ≈ ${(payUsd * feeFrac).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} on this buy
                    </span>
                  )}
                </span>
              </div>
              {/* WE MAY ONLY CALL IT A MINIMUM IF WE SIGN IT (audit 2026-08-07).
                  On a buy whose quote fell back to the NAV estimate, this number
                  sits ABOVE what the mint can deliver — the acquisition cost is
                  not in it — so the execute path probes the real fill and signs a
                  LOWER floor on purpose, otherwise honest buys revert. Printing
                  "Minimum received" for that case promised a protection the
                  signature never carried. The number still shows, because it is
                  the best estimate we have; what changes is that it stops
                  claiming to be the floor. */}
              {/* THE TWO NUMBERS SIT TOGETHER (SpectrumContracts w-166, 2026-08-21).
                  A user read this floor as the payout and reported ~10% slippage on
                  a basket whose measured exit cost is 2.6% FLAT at every size. Their
                  fork numbers fit exactly: marks 132 → expected 128.6 → the 300bps
                  floor 124.7, which is the "125" they saw. The expected figure was
                  in the receive box far above, so opening the details left the FLOOR
                  as the only receive-shaped number on screen. Now they are adjacent
                  and the floor says what it is for. Second user in a week to read a
                  protection number as a price. */}
              {/* ONE PRICE ON SCREEN — THE QUOTE (owner 2026-08-21, after w-166:
                  "ensure we dont show the protection numbers, we try to show the
                  quote price"). Showing expected and the floor side by side was
                  half a fix: two currency figures in the same register is the
                  condition that let a floor be read as a payout in the first
                  place. So the floor is no longer rendered as an AMOUNT anywhere.
                  Nothing is hidden by that — the protection is still fully stated
                  as the slippage tolerance below (and it is adjustable there),
                  which is a percentage and cannot be mistaken for a price. */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Quote</span>
                <span className="tabular-nums">
                  {dex.quote ? `${fmtAmt(dex.quote.outRaw, receiveDecimals)} ${dir === 'buy' ? `$${ix?.symbol ?? ''}` : paySymbol}` : '—'}
                </span>
              </div>
              {dex.quote?.floorBasis === 'nav' && (
                <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
                  This route could not be simulated, so the quote is an estimate and the protection
                  actually signed is measured live at the moment you confirm.
                </p>
              )}
              {/* THE COST, MEASURED, NOT ESTIMATED (SpectrumContracts w-166 ask 2).
                  They suggested the caveat could carry a quantitative exit cost from
                  statically-known parts (basket fee + each leg's pool tier). The
                  holdings do not carry leg tiers client-side, but this quote already
                  measures the whole thing live at THIS size — navDeviationPct was
                  computed and only ever used to trigger a warning below −3%. Shown
                  plainly it reads −2.6% for the basket in that report, which is
                  exactly the figure their fork measured, and it answers the question
                  the user actually had. */}
              {navDeviationPct != null && (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-faint">{dir === 'sell' ? 'Cost vs NAV mark' : 'Fill vs NAV mark'}</span>
                    <span className="tabular-nums">
                      {navDeviationPct >= 0 ? '+' : ''}
                      {navDeviationPct.toFixed(2)}%
                    </span>
                  </div>
                  <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
                    {dir === 'sell'
                      ? 'What the exit costs against what your shares mark at: the basket fee above, plus each leg’s own pool fee. Measured on this size, not a guess.'
                      : 'How this fill sits against NAV: the basket fee above, plus each leg’s own pool fee, plus any drift in the mix. Measured on this size, not a guess.'}
                  </p>
                </>
              )}
              {dex.quote?.floorBasis === 'nav' && (
                <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
                  An estimate — this route could not be simulated, so the floor actually signed is
                  measured from a live simulation at the moment you confirm, and can land below this.
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Route</span>
                <span className="truncate">
                  {ix
                    ? dir === 'buy'
                      ? hub === 'USDC'
                        ? `${usdcSym} → $${showSymbol(ix.symbol)} · self-pool`
                        : `${showSymbol(paySymbol)} → ${usdcSym} → $${showSymbol(ix.symbol)} · ${pay.kind === 'erc20' || lifiHubChain ? 'LiFi' : 'V3'} + self-pool`
                      : hub === 'USDC'
                        ? `$${showSymbol(ix.symbol)} → ${usdcSym} · self-pool`
                        : `$${showSymbol(ix.symbol)} → ${usdcSym} → ${showSymbol(paySymbol)} · self-pool + ${pay.kind === 'erc20' || lifiHubChain ? 'LiFi' : 'V3'}`
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
                      inputMode="decimal" enterKeyHint="done" autoComplete="off"
                      className="w-11 bg-transparent text-right text-[12px] tabular-nums text-ink outline-none placeholder:text-ink-faint"
                    />
                    <span className="text-[12px] text-ink-faint">%</span>
                  </span>
                </span>
              </div>
              {/* THE PROTECTION, STATED IN FULL, AS A PERCENTAGE (owner 2026-08-21).
                  With the floor no longer shown as an amount, this row is the only
                  place the protection is disclosed — so it says what the tolerance
                  DOES rather than leaving the reader to infer it. A percentage
                  cannot be misread as a payout, which is the whole point. */}
              <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
                Your protection: the trade reverts rather than filling more than{' '}
                {(slippageBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% below the quote above. Wider
                tolerance fills more often and protects less.
              </p>
              <p className="border-t border-white/[0.07] pt-2.5 text-[9px] uppercase leading-relaxed tracking-wider text-ink-faint">
                Multi-leg routes run as sequenced transactions, each simulated before you sign.
              </p>
            </div>
          )}
        </div>
        </>
      )}

      {/* seed-min warning */}
      {seedShort && ix && (
        <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          This is ${showSymbol(ix.symbol)}&rsquo;s FIRST buy, it seeds the basket&rsquo;s reserves and the contract
          requires at least 10 {usdcSym} to reach the basket leg. Increase the amount.
        </div>
      )}

      {/* quote error */}
      {dex.quoteError && amountRaw > 0n && !dex.quoting && (
        <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
          {dex.quoteError}
        </p>
      )}

      {/* wrong network, in words, above the action. The CTA below IS the switch in
          this state, so the notice carries no button of its own; `enabled` mirrors
          the state machine's own precedence (a preview-only build with no router,
          or no basket picked yet, has no signature to warn about). */}
      <WrongNetworkNotice
        sw={netSwitch}
        requiredChainId={chainId}
        action="This swap runs"
        enabled={dex.configured && !!ix}
        className="mt-3"
      />

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
          {/* the post-trade seam: the result lives in the book */}
          {WALLET_ENABLED && pageEnabled(brand.pages, 'portfolio') && (
            <RouterLink to="/portfolio" className="text-cyan hover:underline">
              portfolio →
            </RouterLink>
          )}
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
          <RevertCauses error={dex.error} />
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
      {payTokenPicker}
      {bridgeOpen && <BridgeFund destChainId={chainId} onClose={() => setBridgeOpen(false)} arrivalsShown={large} />}

      {/* on-brand wait animation while the swap's steps confirm (token page + /swap) */}
      <SwapPendingOverlay
          stayHere={stayHere}
        onRetry={() => void runSwap()}
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

function PayChip({
  pay, chainId, open, setOpen, onPickHub, onAnyToken, disabled, choices = HUBS, usdcSym = 'USDC',
}: {
  pay: PayToken
  chainId: number
  open: boolean
  setOpen: (v: boolean) => void
  onPickHub: (h: HubToken) => void
  /** Opens the any-token picker; undefined = the chain has no LiFi coverage
   *  and the pay side stays hubs-only. */
  onAnyToken?: () => void
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

  const hub = pay.kind === 'hub' ? pay.hub : null
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="press flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1.5 pl-2 pr-3 hover:border-white/30 disabled:opacity-60"
      >
        {pay.kind === 'hub' ? (
          <HubIcon hub={pay.hub} chainId={chainId} />
        ) : (
          <AssetLogo address={pay.address} symbol={pay.symbol} chainId={chainId} size={22} />
        )}
        <span className="max-w-[6.5rem] truncate font-display text-sm font-bold text-ink">
          {pay.kind === 'hub' ? (pay.hub === 'USDC' ? usdcSym : pay.hub) : pay.symbol}
        </span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink-faint">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="search-pop absolute right-0 z-40 mt-2 w-48 rounded-2xl border border-white/12 bg-panel/95 p-1.5 shadow-[0_30px_70px_-15px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
          {choices.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                onPickHub(h)
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
          {onAnyToken && (
            <button
              type="button"
              onClick={onAnyToken}
              className={`press mt-1 flex w-full items-center gap-2.5 rounded-xl border-t border-white/[0.07] px-2.5 py-2 text-left ${pay.kind === 'erc20' ? 'bg-cyan/10 ring-1 ring-inset ring-cyan/30' : 'hover:bg-white/[0.06]'}`}
            >
              {pay.kind === 'erc20' ? (
                <AssetLogo address={pay.address} symbol={pay.symbol} chainId={chainId} size={22} />
              ) : (
                <span aria-hidden className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-dashed border-white/25 text-[13px] leading-none text-ink-dim">
                  +
                </span>
              )}
              <span className="flex-1">
                <span className="block font-display text-sm font-bold text-ink">
                  {pay.kind === 'erc20' ? pay.symbol : 'Another token'}
                </span>
                <span className="block font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                  {pay.kind === 'erc20' ? 'change token' : 'pay with anything'}
                </span>
              </span>
            </button>
          )}
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
      <span className="max-w-[6.5rem] truncate font-display text-sm font-bold text-ink">${showSymbol(ix.symbol)}</span>
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
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[12vh]" onClick={onClose}>
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
            // desktop only: on touch, autoFocus pops the keyboard over the very
            // list the user opened to browse (mobile UX review 11)
            autoFocus={hasFinePointer()}
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
                  <span className="block truncate font-display text-sm font-semibold text-ink">${showSymbol(b.symbol)}</span>
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
