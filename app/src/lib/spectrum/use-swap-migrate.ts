import { useCallback, useMemo, useRef, useState } from 'react'
import { usePublicClient, useWriteContract } from 'wagmi'
import type { Address, Hex, PublicClient } from 'viem'
import { erc20Abi } from 'viem'
import { deploymentFor, settlementDecimalsFor } from '../chain/deployments'
import { SWAP_ENABLED } from '../config/features'
import { erc20ApproveAbi, swapRouterAbi } from './abis-v2'
import type { BasketData } from './basket-data'
import { friendlyRevert } from './decode-revert'
import { encodeMintHookData, encodeRedeemHookData, DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { approvalPlan } from './migrate-math'
import { fundingSplitBpsOf, lensFactoryFor, resolveMintFunding } from './mint-funding'
import { getStoredRef } from './referral'
import { buildSwapQuote, type SwapQuote } from './swap-quote'
import { simulateSwapOut } from './swap-sim'
import { verifiedSettlementDecimals } from './settlement-verify'

// ─────────────────────────────────────────────────────────────────────────────
// THE SWAP-ROUTE MIGRATION (owner 2026-08-16: "can we fix this properly tho?
// we have an engine to actually buy this") — the fallback for exactly the
// upgrades the in-kind engine refuses: the new version added a leg the
// redemption cannot supply and nothing dropped can fund it (on RH the added
// leg is typically a stock in a v4 USDG-side pool, unreachable from the
// in-kind delta's V3/WETH hub).
//
// THE WHOLE POINT: no new money primitives. This is a SEQUENCER over the two
// lanes every token page already runs —
//   sell $OLD through its own self-pool  (redeem-via-swap, the console's sell)
//   buy  $NEW through its own self-pool  (mint-via-swap, the console's buy)
// — reusing the exact law-bearing modules those lanes trust: the hook-data
// encoders (the only encoder any transactional path may use), swap-sim's
// realised-output probe, mint-funding's lens-resolved split, swap-quote's
// floor derivation, and the simulate-before-sign discipline. What is new here
// is only what MUST be new: the sequencing, and the measured hand-off between
// the two trades.
//
// THE HAND-OFF LAW (the one law this module adds): the buy spends the
// MEASURED settlement delta of the sell — balanceOf before vs after the sell
// receipt — bounded by boundedBuyIn() below. The bound exists because a
// balance delta can capture money the sale did not produce (an unrelated
// inbound transfer landing between the two reads), and a migration consented
// as "sell my $OLD and buy $NEW with the proceeds" must never quietly sweep
// other money into the buy. Overshoot ABOVE the quote is real (positive
// slippage) and allowed up to a small headroom; anything past it is treated
// as not-the-proceeds and left alone.
//
// HONEST PARTIAL STATE: the two trades cannot be atomic (two self-pools, two
// txs). If the buy fails after the sell landed, the proceeds sit in the
// wallet as the settlement token — named to the user, with a retry that
// resumes from the buy (never re-sells) and the standing escape of buying
// $NEW from its own page. Nothing is ever stranded anywhere but the user's
// own wallet.
// ─────────────────────────────────────────────────────────────────────────────

/** How far above the sell quote's expected output the measured delta may be
 *  attributed to the sale (positive slippage headroom), in bps. */
export const PROCEEDS_HEADROOM_BPS = 300n

/** The buy's spend: the measured delta, bounded by expected + headroom — the
 *  consent bound (see the header). Never negative, never above the bound. */
export function boundedBuyIn(measuredDelta: bigint, expectedOut: bigint): bigint {
  if (measuredDelta <= 0n) return 0n
  const cap = expectedOut + (expectedOut * PROCEEDS_HEADROOM_BPS) / 10_000n
  return measuredDelta > cap ? cap : measuredDelta
}

export type SwapMigrateStepKey = 'approve-sell' | 'sell' | 'approve-buy' | 'buy'
export type SwapMigrateStepStatus = 'pending' | 'active' | 'done' | 'error'
export interface SwapMigrateStep {
  key: SwapMigrateStepKey
  status: SwapMigrateStepStatus
  hash: Hex | null
}

export type SwapMigratePhase = 'idle' | 'planning' | 'ready' | 'running' | 'sold' | 'done' | 'error' | 'unavailable'

export interface SwapMigratePlan {
  /** Full old-version balance — this route migrates the whole position. */
  sellAmountRaw: bigint
  sellQuote: SwapQuote
  /** Preview of the buy at the sell's expected proceeds (display only — the
   *  executable buy re-derives everything at the MEASURED proceeds). */
  estBuySharesRaw: bigint | null
  /** True when the buy preview priced off a real on-chain simulation. */
  buySimulated: boolean
}

export interface SwapMigrateResult {
  soldRaw: bigint
  proceedsRaw: bigint
  boughtSharesRaw: bigint
  sellHash: Hex
  buyHash: Hex
}

const STEP_ORDER: SwapMigrateStepKey[] = ['approve-sell', 'sell', 'approve-buy', 'buy']

async function readAllowance(client: PublicClient, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await client.readContract({ address: token, abi: erc20ApproveAbi, functionName: 'allowance', args: [owner, spender] })) as bigint
}

async function readBalance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return (await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })) as bigint
}

function messageOf(e: unknown): string {
  const raw =
    e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : String(e)
  return friendlyRevert(e, raw)
}

/**
 * The swap-route migration for (old → new) on one chain. Mount it only when
 * the in-kind engine has refused (the modal's blocked classes) — this route
 * pays both self-pools' swap costs and both basket fees, which the in-kind
 * path exists to avoid, so it must never outrank it.
 */
export function useSwapMigrate(args: {
  from: BasketData | null
  to: BasketData | null
  chainId: number
  holder: Address | undefined
  /** Basket fee fractions (useBasketFees), required to derive floors. */
  fromFeeFrac: number | null
  toFeeFrac: number | null
}) {
  const { from, to, chainId, holder, fromFeeFrac, toFeeFrac } = args
  const client = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const dep = deploymentFor(chainId)
  const router = dep.swapRouter
  const usdc = dep.usdc

  const [phase, setPhase] = useState<SwapMigratePhase>('idle')
  const [plan, setPlan] = useState<SwapMigratePlan | null>(null)
  const [steps, setSteps] = useState<SwapMigrateStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SwapMigrateResult | null>(null)
  // the sold-state survives a failed buy so retry NEVER re-sells.
  // proceedsRaw 0n = "sold, proceeds not yet measured" — committed the moment
  // the sell receipt reads success, BEFORE any later read can throw (audit S1:
  // a lagging balance node in the two-await window after an irreversible sell
  // lost the resume AND stamped ✕ on a sale that succeeded).
  const soldRef = useRef<{ soldRaw: bigint; proceedsRaw: bigint; sellHash: Hex; balBefore: bigint } | null>(null)
  const planningRef = useRef(false)
  const runningRef = useRef(false)

  const stepPatch = useCallback((key: SwapMigrateStepKey, p: Partial<SwapMigrateStep>) => {
    setSteps((cur) => cur.map((s) => (s.key === key ? { ...s, ...p } : s)))
  }, [])

  const configured = SWAP_ENABLED && !!router && !!usdc && !!client && !!holder && !!from && !!to

  /** Read everything and price both lanes — no state is touched on-chain. */
  const buildPlan = useCallback(async (): Promise<void> => {
    if (!configured || !from || !to || !client || !holder || !router || !usdc) {
      setPhase('unavailable')
      return
    }
    if (fromFeeFrac == null || toFeeFrac == null) return // fees still loading; caller re-invokes
    if (planningRef.current) return
    planningRef.current = true
    setPhase('planning')
    setError(null)
    try {
      const sellAmountRaw = await readBalance(client, from.address as Address, holder)
      if (sellAmountRaw <= 0n) {
        setPhase('unavailable')
        setError(`You hold no $${from.symbol} in this wallet.`)
        return
      }
      const sellAllowance = await readAllowance(client, from.address as Address, holder, router)
      const sellRealised = await simulateSwapOut(client, {
        side: 'sell',
        basket: from.address as Address,
        settlement: usdc,
        router,
        amountIn: sellAmountRaw,
        legCount: from.holdings.length,
        holder,
        allowanceCovers: sellAllowance >= sellAmountRaw,
      }).catch(() => null)
      const settlementDec = settlementDecimalsFor(chainId)
      const sellQuote = buildSwapQuote({
        side: 'sell',
        amount: Number(sellAmountRaw) / 10 ** Math.min(from.decimals, 18),
        navPerToken: from.navPerToken,
        feeFrac: fromFeeFrac,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        holdings: from.holdings,
        basketDecimals: from.decimals,
        settlementDecimals: settlementDec,
        realisedOutRaw: sellRealised ?? undefined,
      })
      if (!sellQuote) {
        setPhase('unavailable')
        setError(`$${from.symbol} could not be priced for a protected sale right now.`)
        return
      }
      // The BUY PREVIEW at the sell's expected proceeds — display only. A
      // preview failure does not block the route: the executable buy derives
      // fresh at the measured proceeds and refuses THERE if it must.
      let estBuySharesRaw: bigint | null = null
      let buySimulated = false
      try {
        const est = await priceBuy(client, {
          to,
          chainId,
          holder,
          router,
          usdc,
          amountIn: sellQuote.expectedOutRaw,
          toFeeFrac,
        })
        if (est) {
          estBuySharesRaw = est.quote.expectedOutRaw
          buySimulated = est.quote.basis === 'simulated'
        }
      } catch {
        /* preview only */
      }
      setPlan({ sellAmountRaw, sellQuote, estBuySharesRaw, buySimulated })
      setSteps(STEP_ORDER.map((key) => ({ key, status: 'pending', hash: null })))
      setPhase('ready')
    } catch (e) {
      setPhase('error')
      setError(messageOf(e))
    } finally {
      planningRef.current = false
    }
  }, [configured, from, to, client, holder, router, usdc, chainId, fromFeeFrac, toFeeFrac])

  /** One approve leg: approvalPlan's sequence (zero-first where the token
   *  demands it — the repo's law for exactly this), each receipt CHECKED (a
   *  reverted approve must fail its step, never wear ✓). */
  const approveExact = useCallback(
    async (token: Address, needed: bigint, key: SwapMigrateStepKey): Promise<void> => {
      if (!client || !holder || !router) throw new Error('No connection.')
      stepPatch(key, { status: 'active' })
      const allowance = await readAllowance(client, token, holder, router)
      const mode = approvalPlan(allowance, needed, { chainId, token })
      const values = mode === 'none' ? [] : mode === 'zero-first' ? [0n, needed] : [needed]
      for (const value of values) {
        await client.simulateContract({ account: holder, address: token, abi: erc20ApproveAbi, functionName: 'approve', args: [router, value] })
        const h = await writeContractAsync({ address: token, abi: erc20ApproveAbi, functionName: 'approve', args: [router, value], chainId })
        stepPatch(key, { hash: h })
        const rcpt = await client.waitForTransactionReceipt({ hash: h })
        if (rcpt.status !== 'success') throw new Error('The approval was included and reverted. Nothing further was signed.')
      }
      stepPatch(key, { status: 'done' })
    },
    [client, holder, router, chainId, writeContractAsync, stepPatch],
  )

  /** Run the two lanes. Resumable: a landed sell is never repeated. */
  const execute = useCallback(async (): Promise<void> => {
    if (!configured || !plan || !from || !to || !client || !holder || !router || !usdc) return
    if (!SWAP_ENABLED) return
    if (runningRef.current) return // hard re-entrancy guard (use-sweep's own posture)
    runningRef.current = true
    setPhase('running')
    setError(null)
    try {
      let sold = soldRef.current
      if (!sold) {
        // ── the plan must still describe reality (audit S5): a balance that
        //    moved since planning refuses CLEANLY and re-prices, instead of
        //    reverting raw at simulate with a sentence about allowances ──────
        // law S2b, console form: the floors below convert cents at configured
        // decimals — verify the config against the token before anything signs
        await verifiedSettlementDecimals(client, chainId, usdc)
        const liveBal = await readBalance(client, from.address as Address, holder)
        if (liveBal !== plan.sellAmountRaw) {
          setPhase('idle')
          setPlan(null)
          setError(`Your $${from.symbol} balance changed since this was priced. Repricing now.`)
          void buildPlan()
          return
        }
        await approveExact(from.address as Address, plan.sellAmountRaw, 'approve-sell')

        // ── the SELL, floored by the quote, simulated before signing ───────
        stepPatch('sell', { status: 'active' })
        const interfaceTag = getStoredRef(holder)
        const { hookData } = encodeRedeemHookData({
          legCount: from.holdings.length,
          minOut: plan.sellQuote.minOutRaw,
          interfaceTag,
        })
        const sellArgs = [
          from.address as Address,
          from.address as Address,
          plan.sellAmountRaw,
          plan.sellQuote.minOutRaw,
          hookData,
          holder,
        ] as const
        const balBefore = await readBalance(client, usdc, holder)
        await client.simulateContract({ account: holder, address: router, abi: swapRouterAbi, functionName: 'swapExactIn', args: sellArgs })
        const sellHash = await writeContractAsync({ address: router, abi: swapRouterAbi, functionName: 'swapExactIn', args: sellArgs, chainId })
        stepPatch('sell', { hash: sellHash })
        const sellRcpt = await client.waitForTransactionReceipt({ hash: sellHash })
        if (sellRcpt.status !== 'success') throw new Error('The sale was included and reverted. Nothing was sold.')
        // ── COMMIT THE SALE FIRST (audit S1): the sell is irreversible here,
        //    so the resume state and the ✓ land before any read that can
        //    throw. proceedsRaw 0n = measured at the buy leg below. ──────────
        sold = { soldRaw: plan.sellAmountRaw, proceedsRaw: 0n, sellHash, balBefore }
        soldRef.current = sold
        stepPatch('sell', { status: 'done' })
        setPhase('sold')
      }

      // ── MEASURE the proceeds (the hand-off law; see the header). Re-run on
      //    every retry until it answers — the sale's ✓ is already safe. ──────
      setPhase('running')
      if (sold.proceedsRaw <= 0n) {
        const balAfter = await readBalance(client, usdc, holder)
        const proceedsRaw = boundedBuyIn(balAfter - sold.balBefore, plan.sellQuote.expectedOutRaw)
        if (proceedsRaw <= 0n)
          throw new Error(
            'The sale landed but its settlement proceeds have not appeared in the balance read yet. Nothing further was signed. Retry in a moment.',
          )
        sold = { ...sold, proceedsRaw }
        soldRef.current = sold
      }

      // ── the BUY, derived FRESH at the measured proceeds ───────────────────
      // A null fee is a refusal, never a guessed floor (audit S9 — the module's
      // own law): a 0% entry-fee quote would set minOut too high and revert
      // AFTER the sell, in the worst possible state.
      if (toFeeFrac == null) throw new Error('The new basket’s fee is still loading. Retry in a moment. Nothing further was signed.')
      const priced = await priceBuy(client, { to, chainId, holder, router, usdc, amountIn: sold.proceedsRaw, toFeeFrac })
      if (!priced) throw new Error(`$${to.symbol} could not be priced for a protected buy right now. Your proceeds are in your wallet as the settlement token. Retry, or buy $${to.symbol} from its page.`)

      await approveExact(usdc, sold.proceedsRaw, 'approve-buy')

      stepPatch('buy', { status: 'active' })
      const interfaceTag = getStoredRef(holder)
      const { hookData: buyHookData } = encodeMintHookData({
        quotedLegAmounts: priced.quote.quotedLegAmounts,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        minOut: priced.quote.minOutRaw,
        interfaceTag,
        funding: priced.funding,
      })
      // shares measured around the receipt — the BEFORE read must precede the
      // broadcast (audit S3: wallets that resolve only once mined made the
      // after-read read the bought shares into "before", reporting +0)
      const sharesBefore = await readBalance(client, to.address as Address, holder)
      const buyArgs = [to.address as Address, usdc, sold.proceedsRaw, priced.quote.minOutRaw, buyHookData, holder] as const
      await client.simulateContract({ account: holder, address: router, abi: swapRouterAbi, functionName: 'swapExactIn', args: buyArgs })
      const buyHash = await writeContractAsync({ address: router, abi: swapRouterAbi, functionName: 'swapExactIn', args: buyArgs, chainId })
      stepPatch('buy', { hash: buyHash })
      const buyRcpt = await client.waitForTransactionReceipt({ hash: buyHash })
      if (buyRcpt.status !== 'success') throw new Error('The buy was included and reverted. Your proceeds are still in your wallet. Retry, or buy from the page.')
      const sharesAfter = await readBalance(client, to.address as Address, holder)
      stepPatch('buy', { status: 'done' })
      setResult({
        soldRaw: sold.soldRaw,
        proceedsRaw: sold.proceedsRaw,
        boughtSharesRaw: sharesAfter > sharesBefore ? sharesAfter - sharesBefore : 0n,
        sellHash: sold.sellHash,
        buyHash,
      })
      soldRef.current = null
      setPhase('done')
    } catch (e) {
      // mark the active step failed; a landed sell keeps its done state
      setSteps((cur) => cur.map((s) => (s.status === 'active' ? { ...s, status: 'error' } : s)))
      setError(messageOf(e))
      setPhase(soldRef.current ? 'sold' : 'error')
    } finally {
      runningRef.current = false
    }
  }, [configured, plan, from, to, client, holder, router, usdc, chainId, toFeeFrac, writeContractAsync, stepPatch, approveExact, buildPlan])

  return useMemo(
    () => ({ phase, plan, steps, error, result, configured, buildPlan, execute }),
    [phase, plan, steps, error, result, configured, buildPlan, execute],
  )
}

/** Price the buy of `to` for an exact settlement amount: lens-resolved funding
 *  split → realised on-chain sim carrying that split → floor derivation. Null
 *  when any law-bearing input refuses (never a guessed floor). */
async function priceBuy(
  client: PublicClient,
  args: { to: BasketData; chainId: number; holder: Address; router: Address; usdc: Address; amountIn: bigint; toFeeFrac: number },
) {
  const { to, chainId, holder, router, usdc, amountIn, toFeeFrac } = args
  if (amountIn <= 0n) return null
  const factory = await lensFactoryFor(chainId, to.address as Address)
  if (!factory) return null
  const firstMint = to.effectiveSupply === 0
  const outcome = await resolveMintFunding(client, {
    chainId,
    factory,
    basket: to.address as Address,
    amountIn,
    legCount: to.holdings.length,
    firstMint,
  })
  if (!outcome.ok) return null
  const split = fundingSplitBpsOf(outcome.funding)
  const buyAllowance = await readAllowance(client, usdc, holder, router)
  const realised = await simulateSwapOut(client, {
    side: 'buy',
    basket: to.address as Address,
    settlement: usdc,
    router,
    amountIn,
    legCount: to.holdings.length,
    holder,
    allowanceCovers: buyAllowance >= amountIn,
    fundingSplitBps: split,
  }).catch(() => null)
  const settlementDec = settlementDecimalsFor(chainId)
  const quote = buildSwapQuote({
    side: 'buy',
    amount: Number(amountIn) / 10 ** settlementDec,
    navPerToken: to.navPerToken,
    feeFrac: toFeeFrac,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    holdings: to.holdings,
    basketDecimals: to.decimals,
    settlementDecimals: settlementDec,
    realisedOutRaw: realised ?? undefined,
    fundingSplitBps: split,
  })
  if (!quote) return null
  return { quote, funding: outcome.funding }
}
