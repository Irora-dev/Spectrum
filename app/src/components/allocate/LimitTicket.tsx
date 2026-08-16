import { useEffect, useMemo, useRef, useState } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { formatUnits, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi'
import {
  buildLimitOrder,
  COW_VAULT_RELAYER,
  cowSupportsChain,
  limitOrderRefusal,
  limitOrderTypedData,
  type CowChainId,
} from '../../lib/spectrum/cow'
import { fetchCowQuote, postCowOrder } from '../../lib/spectrum/cow-api'
import { confirmSignableAmount, limitAmountFromPrice } from '../../lib/spectrum/limit-price'
import { markerPosition, readOutlook, type OutlookRead } from '../../lib/spectrum/order-intent'
import { committedOf, overCommitWarning, planApproval, readBalance } from '../../lib/spectrum/order-commitments'
import { ordersFor, upsertOrder } from '../../lib/spectrum/cow-pending'
import { spectrumAppDataHex } from '../../lib/spectrum/app-data'
import { erc20ApproveAbi } from '../../lib/spectrum/abis-v2'

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
import { InfoDot } from '../InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// THE LIMIT TICKET — the surface over the rail (Ⓡ the owner 2026-08-02: "it needs
// to be given to the specallocator to bake into the execution frontend").
// Contract + invariants: docs/allocator/LIMIT-ORDERS-INTEGRATION.md.
//
// THE ONE SENTENCE THAT SHAPES EVERY DECISION HERE: the signature IS the
// authorization. There is no simulate-then-sign, no revert to save anyone, no
// second confirmation. Once signed and posted a solver can take it at that
// price and it is final. So this component's real job is not "collect a price"
// — it is to make sure the number the user is looking at is the number they
// sign, and to refuse when it cannot promise that.
//
// It walks the doc's sequence in order and does not improvise:
//   quote the market → convert the typed price through limitAmountFromPrice →
//   read the outlook → check commitments → plan the approval → build → LAST
//   GATE confirmSignableAmount → sign → post → store.
//
// THE AXIS IS PRICE, NEVER TIME. No timeline is drawn anywhere, because this
// has no schedule to draw: where the price sits against the market is the
// entire explanation of what will happen.
// ─────────────────────────────────────────────────────────────────────────────

/** balanceOf alone — the repo keeps ABIs narrow so a typo cannot reach a
 *  function nobody meant to call. `erc20ApproveAbi` covers allowance/approve. */
const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

export interface LimitLeg {
  chainId: number
  sellToken: Address
  buyToken: Address
  sellSymbol: string
  buySymbol: string
  sellDecimals: number
  buyDecimals: number
  sellAmountRaw: bigint
}

/** Where the user's price stands against the market, drawn once and reused for
 *  every outcome — the distance IS the explanation. */
function PriceScale({ read }: { read: OutlookRead }) {
  const pos = markerPosition(read.awayPct)
  const tone =
    read.severity === 'danger' ? 'var(--color-magenta)' : read.severity === 'caution' ? 'var(--color-amber)' : 'var(--color-teal)'
  return (
    <div aria-hidden className="mt-4">
      <div className="relative h-2 w-full rounded-full bg-white/[0.07]">
        {/* the market, at centre — the thing every price is relative to */}
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/35" />
        {/* the user's price. markerPosition CLAMPS, so a wild number pins to
            the end of the track instead of leaving it (the overflow class we
            keep re-learning) */}
        <span
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel transition-[left] duration-300"
          style={{ left: `${pos * 100}%`, background: tone }}
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
        <span>below market</span>
        <span>market</span>
        <span>above market</span>
      </div>
    </div>
  )
}

export function LimitTicket({ leg, owner, onPlaced }: { leg: LimitLeg; owner: Address; onPlaced?: () => void }) {
  const chainId = leg.chainId
  const supported = cowSupportsChain(chainId)
  // Narrowed once: usePublicClient returns a union across configured chains,
  // which collapses readContract's overloads to `never` at the call site.
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const { chainId: walletChainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  /** THE WALLET MUST BE ON THE LEG'S CHAIN BEFORE ANYTHING IS SENT OR SIGNED.
   *  ~~Passing an explicit chainId to the write call does not typecheck~~ —
   *  SUPERSEDED 2026-08-07 (four-reviewer audit): it does, as a plain `number`
   *  variable (the LITERAL forms are what wagmi's overload rejects; see the
   *  note at the writes). Both approves now carry the id, so wagmi refuses a
   *  wallet that lied about switching. This UI gate REMAINS load-bearing for
   *  what the write-level check cannot cover: the typed-data SIGNATURE below
   *  binds a chain in its domain, and no chainId param protects a signature. */
  const wrongNetwork = walletChainId != null && walletChainId !== chainId

  const [priceText, setPriceText] = useState('')
  const [market, setMarket] = useState<{ rate: number; asOfMs: number } | null>(null)
  const [marketNote, setMarketNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'quoting' | 'approving' | 'signing' | 'posting'>(null)
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<string | null>(null)

  const appData = useMemo<Hex>(() => spectrumAppDataHex(), [])

  /** THE NUMBER THE USER ACTUALLY LOOKED AT (UIGuy's finding). My first version
   *  called confirmSignableAmount(priced.minBuyAmountRaw, order.buyAmount) —
   *  the same value on both sides, so it compared a value to ITSELF, always
   *  returned null and protected nothing. It read perfectly in the diff, which
   *  is what made it dangerous rather than merely useless.
   *
   *  For the gate to mean anything the displayed value has to be captured when
   *  it was RENDERED and held across the render, then compared against a fresh
   *  computation at click time. This ref is written in an effect, so it holds
   *  what was painted, not what a memo happens to hold at click. */
  const renderedMinBuyRef = useRef<bigint | null>(null)

  // ── 2 · QUOTE THE MARKET. This is the reference we SHOW; it is never signed.
  useEffect(() => {
    if (!supported) return
    let live = true
    setBusy('quoting')
    fetchCowQuote(chainId as CowChainId, {
      sellToken: leg.sellToken,
      buyToken: leg.buyToken,
      owner,
      sellAmountRaw: leg.sellAmountRaw,
      appData,
    })
      .then((r) => {
        if (!live) return
        setBusy(null)
        if (r.ok) {
          const sell = Number(formatUnits(leg.sellAmountRaw, leg.sellDecimals))
          const buy = Number(formatUnits(r.value.buyAmountRaw, leg.buyDecimals))
          if (sell > 0 && buy > 0) {
            setMarket({ rate: buy / sell, asOfMs: Date.now() })
            setMarketNote(null)
            return
          }
        }
        // A MISSING QUOTE IS NOT A VERDICT (invariant 4): say we could not
        // check, never imply the price is fine.
        setMarket(null)
        setMarketNote(r.ok ? 'The market reply had no usable price in it.' : r.message)
      })
      .catch(() => {
        if (!live) return
        setBusy(null)
        setMarket(null)
        setMarketNote('Could not reach the market to check your price.')
      })
    return () => {
      live = false
    }
  }, [supported, chainId, leg.sellToken, leg.buyToken, leg.sellAmountRaw, leg.sellDecimals, leg.buyDecimals, owner, appData])

  // ── 3 · CONVERT THE TYPED PRICE. Never hand-rolled: six protections live in
  //        limitAmountFromPrice and doing the multiply here loses all six.
  const priced = useMemo(
    () =>
      priceText.trim() === ''
        ? null
        : limitAmountFromPrice({
            priceText,
            sellAmountRaw: leg.sellAmountRaw,
            sellDecimals: leg.sellDecimals,
            buyDecimals: leg.buyDecimals,
            market: market ?? undefined,
            nowMs: Date.now(),
          }),
    [priceText, leg.sellAmountRaw, leg.sellDecimals, leg.buyDecimals, market],
  )

  // ── 4 · THE OUTLOOK — what will actually happen, in the rail's own words.
  const outlook = useMemo<OutlookRead | null>(() => {
    if (!market || priceText.trim() === '') return null
    const limitRate = Number(priceText)
    if (!Number.isFinite(limitRate) || limitRate <= 0) return null
    return readOutlook(market.rate, limitRate)
  }, [market, priceText])

  // ── 5 · WHAT IS ALREADY SPOKEN FOR.
  const committed = useMemo(
    () => committedOf(ordersFor(owner, chainId), chainId, leg.sellToken),
    [owner, chainId, leg.sellToken],
  )
  const [balanceRaw, setBalanceRaw] = useState<bigint | null>(null)
  const [allowanceRaw, setAllowanceRaw] = useState<bigint | null>(null)
  useEffect(() => {
    if (!publicClient || !supported) return
    let live = true
    Promise.all([
      publicClient.readContract({ address: leg.sellToken, abi: balanceAbi, functionName: 'balanceOf', args: [owner] }),
      publicClient.readContract({
        address: leg.sellToken,
        abi: erc20ApproveAbi,
        functionName: 'allowance',
        args: [owner, COW_VAULT_RELAYER],
      }),
    ])
      .then(([b, a]) => {
        if (!live) return
        setBalanceRaw(b as bigint)
        setAllowanceRaw(a as bigint)
      })
      // A FAILED READ IS NOT A VERDICT either — leaving these null makes the
      // warnings say "could not check" rather than "you are fine".
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [publicClient, supported, leg.sellToken, owner, placed])

  const balance = balanceRaw != null ? readBalance(balanceRaw, committed) : null
  const overCommit = balance ? overCommitWarning(balance, leg.sellAmountRaw, leg.sellSymbol) : null

  // THE BLOCKING RULE (invariant 2): a danger outlook must make signing
  // unreachable, not merely red. A sell far below the market fills instantly
  // and the loss is irreversible; every other bad outcome only costs time.
  const blocked =
    !supported ||
    priced == null ||
    !priced.ok ||
    (outlook?.blocking ?? false) ||
    wrongNetwork ||
    busy != null ||
    placed != null

  async function place() {
    if (blocked || !priced?.ok || !publicClient) return
    // Re-apply the guard `supported` was derived from: storing its result in a
    // boolean at the top of the component DISCARDS the type narrowing, and
    // wagmi's registered-config overload wants the literal CowChainId union on
    // the writes below (a plain `number` resolves the whole mutation to
    // `never`, which is the wall the header comment hit). This is a checked
    // narrowing, not a cast — an unsupported chain still refuses.
    if (!cowSupportsChain(chainId)) return
    setError(null)
    try {
      // belt and braces: even with the button gated, never send on a chain the
      // order was not built for
      if (walletChainId !== chainId) {
        await switchChainAsync({ chainId })
      }
      // ── 6 · THE APPROVAL, for committed + adding. Never for this order
      //        alone: an allowance is ONE number per token, so approving just
      //        this one would drop it below what an open order already needs.
      const plan = planApproval({
        currentAllowanceRaw: allowanceRaw ?? 0n,
        committedRaw: committed,
        addingRaw: leg.sellAmountRaw,
        chainId,
        token: leg.sellToken,
      })
      // ⚠ chainId ON BOTH WRITES (four-reviewer audit, 2026-08-07): these two
      // approves were the only writes in the app without one. The
      // switchChainAsync above resolves OPTIMISTICALLY on wallets that report
      // a switch they did not make, and an approve carrying no chainId then
      // lands on whatever chain the wallet is really on — where this token
      // address is a DIFFERENT token, now approved to the relayer. With the
      // id, wagmi refuses the mismatch instead of sending.
      //
      // WHY A SWITCH AND NOT `chainId,`: wagmi's registered-config overload
      // takes a literal chain id but NOT their union — `1` typechecks where
      // `1 | 8453` resolves the whole mutation to `never` (measured, not
      // guessed: the `as 1` probe compiled). The header comment's old answer
      // was to leave the id off entirely; an exhaustive switch keeps the
      // protection with zero casts, and the `never` arm makes ADDING a CoW
      // chain a compile error here instead of a silently unprotected write.
      // WHY THE WIDENING ANNOTATION: wagmi's registered-config overload here
      // accepts chainId as a plain `number` VARIABLE but rejects a LITERAL or
      // the CowChainId union (measured with a four-variant probe — the literal
      // is the one that resolves the mutation to `never`, which is the wall
      // this file's header comment hit and answered by leaving the id off).
      // Widening a value the guard above already proved to be a CoW chain is
      // safe in both directions: the type system loses precision it was
      // rejecting anyway, and the runtime check wagmi performs against the
      // wallet's REAL chain — the whole point — needs only the number.
      const writeChainId: number = chainId
      if (plan.kind !== 'none') {
        setBusy('approving')
        // ⚠ chainId ON BOTH WRITES (four-reviewer audit, 2026-08-07): these two
        // approves were the only writes in the app without one. The
        // switchChainAsync above resolves OPTIMISTICALLY on wallets that report
        // a switch they did not make, and an approve carrying no chainId then
        // lands on whatever chain the wallet is really on — where this token
        // address is a DIFFERENT token, now approved to the relayer. With the
        // id, wagmi refuses the mismatch instead of sending.
        if (plan.kind === 'reset-then-approve') {
          // some tokens refuse a non-zero→non-zero change
          await writeContractAsync({
            address: leg.sellToken,
            abi: erc20ApproveAbi,
            functionName: 'approve',
            args: [COW_VAULT_RELAYER, 0n],
            chainId: writeChainId,
          })
        }
        await writeContractAsync({
          address: leg.sellToken,
          abi: erc20ApproveAbi,
          functionName: 'approve',
          // THE VAULT RELAYER, never the settlement contract: approving
          // settlement leaves every order silently unfillable.
          args: [COW_VAULT_RELAYER, plan.requiredRaw],
          chainId: writeChainId,
        })
      }

      // ── 7 · BUILD
      const nowSec = Math.floor(Date.now() / 1000)
      const buildArgs = {
        sellToken: leg.sellToken,
        buyToken: leg.buyToken,
        owner,
        sellAmountRaw: leg.sellAmountRaw,
        minBuyAmountRaw: priced.minBuyAmountRaw,
        validForSec: 7 * 24 * 60 * 60,
        nowSec,
        appData,
      }
      // refusal FIRST so the user gets the sentence; buildLimitOrder THROWS on
      // the same conditions, so checking after would only ever be belt-and-braces
      const refusal = limitOrderRefusal(buildArgs)
      if (refusal) {
        setBusy(null)
        setError(refusal)
        return
      }
      const order = buildLimitOrder(buildArgs)

      // ── 8 · THE LAST GATE, and it is only a gate because the two sides come
      //        from different moments: what was on screen when the user decided,
      //        against what this click is about to sign. Same-value-both-sides
      //        is the failure mode that made the first version a no-op.
      const displayed = renderedMinBuyRef.current
      if (displayed == null) {
        setBusy(null)
        setError('Could not confirm the amount you were shown. Re-enter your price.')
        return
      }
      const mismatch = confirmSignableAmount(displayed, BigInt(order.buyAmount))
      if (mismatch) {
        setBusy(null)
        setError(mismatch)
        return
      }

      // ── 9 · SIGN, POST, STORE
      setBusy('signing')
      const typed = limitOrderTypedData(chainId as CowChainId, order)
      const signature = (await signTypedDataAsync({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      })) as Hex

      setBusy('posting')
      const posted = await postCowOrder(chainId as CowChainId, order, owner, signature)
      if (!posted.ok) {
        setBusy(null)
        setError(posted.message)
        return
      }
      upsertOrder({
        uid: posted.value,
        chainId: chainId as CowChainId,
        owner,
        sellToken: leg.sellToken,
        buyToken: leg.buyToken,
        sellSymbol: leg.sellSymbol,
        buySymbol: leg.buySymbol,
        sellDecimals: leg.sellDecimals,
        buyDecimals: leg.buyDecimals,
        sellAmountRaw: leg.sellAmountRaw,
        minBuyAmountRaw: priced.minBuyAmountRaw,
        validTo: order.validTo,
        createdAtMs: Date.now(),
        status: 'open',
        executedSellRaw: 0n,
        executedBuyRaw: 0n,
      })
      setBusy(null)
      setPlaced(posted.value)
      onPlaced?.()
    } catch (e) {
      setBusy(null)
      // A rejected prompt is not an error worth shouting about.
      const msg = e instanceof Error ? e.message : String(e)
      setError(/user rejected|denied|rejected the request/i.test(msg) ? null : msg)
    }
  }

  // ── HOOKS ABOVE THE EARLY RETURNS (the hook gate's finding #2, UIGuy's
  //    word: this one fired on SUCCESS — `placed` flipping true dropped the
  //    hook count and crashed exactly on "your order is live"). Written AFTER
  //    paint so it holds what the user was ACTUALLY SHOWN — and on renders
  //    where no ticket is on screen (placed / unsupported) it must hold NULL:
  //    retaining a quote no longer shown is the stale-display binding the
  //    double-submit work exists to prevent. ────────────────────────────────
  const ticketOnScreen = supported && !placed
  useEffect(() => {
    renderedMinBuyRef.current = ticketOnScreen && priced?.ok ? priced.minBuyAmountRaw : null
  }, [priced, ticketOnScreen])

  if (!supported) {
    return (
      <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        limit orders are not available on this network
        <InfoDot>
          The settlement contract these orders rely on is not deployed here, so an order placed on
          this network could never be filled. Market buys work as normal.
        </InfoDot>
      </p>
    )
  }

  if (placed) {
    return (
      <div className="mt-4 rounded-2xl border border-teal/30 bg-teal/[0.06] p-5">
        <p className="font-display text-[15px] font-bold text-ink">Your order is live</p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">
          It fills at your price or better, in one piece or several, and expires in 7 days if the
          market never reaches it. Cancelling costs no gas.
        </p>
      </div>
    )
  }

  const sellHuman = formatUnits(leg.sellAmountRaw, leg.sellDecimals)

  return (
    <div className="relative mt-5 overflow-hidden rounded-2xl border border-white/12 bg-white/[0.02] p-6">
      {/* the spectral hairline — the house signature for a money-adjacent beat */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL }} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Your price</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          selling{' '}
          <span className="font-num text-xs font-semibold tabular-nums text-ink-dim">
            {Number(sellHuman).toLocaleString(undefined, { maximumFractionDigits: 6 })}
          </span>{' '}
          ${showSymbol(leg.sellSymbol)} for ${showSymbol(leg.buySymbol)}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <span className="relative">
          <input
            inputMode="decimal"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            placeholder={market ? market.rate.toPrecision(6) : '0.00'}
            aria-label={`Price in ${showSymbol(leg.buySymbol)} per ${showSymbol(leg.sellSymbol)}`}
            className="h-14 w-60 rounded-xl border border-white/15 bg-white/[0.04] px-4 font-num text-2xl font-semibold tabular-nums text-ink transition-colors placeholder:text-ink-faint/50 focus:border-cyan/60 focus:outline-none"
          />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          ${showSymbol(leg.buySymbol)} per ${showSymbol(leg.sellSymbol)}
        </span>
        {market && (
          <button
            type="button"
            onClick={() => setPriceText(market.rate.toPrecision(6))}
            className="press ml-auto inline-flex h-8 items-center rounded-full border border-white/15 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
          >
            Use market
          </button>
        )}
      </div>

      {/* THE MARKET COULD NOT BE READ — said plainly, never implied away. */}
      {marketNote && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
          couldn&rsquo;t check the market: {marketNote}
        </p>
      )}

      {/* WHAT YOU RECEIVE AT LEAST — displayed on purpose, not merely computed.
          The last gate protects "the number the user looked at", so there has to
          BE a number they looked at; an amount that only ever existed in a memo
          is not one. This is also the honest headline of a limit order: the
          price is the instruction, this is the promise. */}
      {priced?.ok && (
        <p className="mt-4 text-[13px] text-ink-dim">
          You receive at least{' '}
          <span className="font-num text-base font-semibold tabular-nums text-ink">
            {Number(formatUnits(priced.minBuyAmountRaw, leg.buyDecimals)).toLocaleString(undefined, {
              maximumFractionDigits: 6,
            })}
          </span>{' '}
          ${showSymbol(leg.buySymbol)}
          <InfoDot>
            Your limit is a floor, never a target: solvers fill at this or better, and anything
            they beat it by is yours. This exact amount is what gets signed.
          </InfoDot>
        </p>
      )}

      {/* The rail's own words for what this price buys. */}
      {outlook && (
        <>
          <PriceScale read={outlook} />
          <p className="mt-4">
            <span
              className={`inline-flex items-center rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${
                outlook.severity === 'danger'
                  ? 'border-magenta/50 bg-magenta/[0.10] text-magenta'
                  : outlook.severity === 'caution'
                    ? 'border-amber-300/40 bg-amber-300/[0.08] text-amber-300/90'
                    : 'border-teal/40 bg-teal/[0.08] text-teal'
              }`}
            >
              {outlook.label}
            </span>
          </p>
          <p className="mt-2.5 max-w-[64ch] text-[13px] leading-relaxed text-ink-dim">{outlook.line}</p>
        </>
      )}

      {/* A refusal from the converter is shown verbatim: it is the reason the
          number cannot be turned into an order, and it is always specific. */}
      {priced && !priced.ok && (
        <p className="mt-3 text-[13px] text-magenta">{priced.reason}</p>
      )}

      {/* What is already spoken for. WARN, never block (invariant 3's sibling). */}
      {overCommit && (
        <p className="mt-3 text-[12px] leading-relaxed text-amber-300/90">{overCommit}</p>
      )}
      {balance && committed > 0n && !overCommit && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {formatUnits(committed, leg.sellDecimals)} ${showSymbol(leg.sellSymbol)} is already committed to open orders
        </p>
      )}

      {wrongNetwork && (
        <p className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-amber-300/90">
          Your wallet is on another network.
          <button
            type="button"
            onClick={() => switchChainAsync({ chainId }).catch(() => undefined)}
            className="press inline-flex h-8 items-center rounded-full border border-amber-300/40 px-3 font-mono text-[10px] uppercase tracking-[0.14em] hover:border-amber-300/80"
          >
            Switch network
          </button>
        </p>
      )}

      {error && <p className="mt-3 text-[13px] text-magenta">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          expires in 7 days · cancelling costs no gas
          <InfoDot>
            You sign the order; you do not send a transaction. Solvers fill it at your price or
            better, in one piece or several. Anything unfilled at expiry simply lapses, which is
            the order doing exactly what you asked. Cancelling is an off-chain signed request, so
            it costs nothing.
          </InfoDot>
        </p>
        <button
          type="button"
          onClick={place}
          disabled={blocked}
          className="spectral-btn press inline-flex h-11 items-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'quoting'
            ? 'Reading the market…'
            : busy === 'approving'
              ? 'Approve in your wallet…'
              : busy === 'signing'
                ? 'Sign in your wallet…'
                : busy === 'posting'
                  ? 'Placing…'
                  : 'Place this order'}
        </button>
      </div>
    </div>
  )
}
