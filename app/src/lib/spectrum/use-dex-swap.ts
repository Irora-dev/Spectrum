import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from 'wagmi'
import { encodeFunctionData, formatUnits, parseEventLogs, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { SWAP_ENABLED } from '../config/features'
import type { BasketData } from './basket-data'
import { buildSwapQuote } from './swap-quote'
import { encodeMintHookData, encodeRedeemHookData, clampSlippageBps } from './hook-data'
import { fetchLifiQuote, LIFI_NATIVE } from './lifi'
import { getStoredRef } from './referral'
import { erc20ApproveAbi, erc20BalanceAbi, swapRouterAbi } from './abis-v2'

// ERC-20 Transfer event — used to measure what a swap ACTUALLY delivered from its
// receipt logs (canonical; immune to lagging-RPC balance reads).
const erc20TransferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const
import { bestExactInTier, minOutFor, quoteBuyLegFills, swapRouter02Abi } from './delta-trade'
import { approvalPlan } from './migrate-math'
import { gasWithHeadroom } from './gas'
import { friendlyRevert } from './decode-revert'

// ─────────────────────────────────────────────────────────────────────────────
// The /swap page's DEX-style route executor: pay with ETH / WETH / USDC (or a
// basket when selling) and receive the other side, orchestrated client-side:
//
//   hub leg   — ETH/WETH ↔ USDC through the canonical Uniswap V3 SwapRouter02
//               (native ETH rides msg.value in; unwrapWETH9 multicall out),
//               best fee tier by QuoterV2 quote — same plumbing as the
//               migration's delta trade.
//   basket leg — the protected Spectrum swap (swapExactIn + per-leg floors in
//               hookData), IDENTICAL protections to the Token-page panel: the
//               floors derive from buildSwapQuote (the single source) and are
//               recomputed from the MEASURED hub output before signing.
//
// The deployed SpectrumSwapRouter exposes only swapExactIn (no ETH entrypoints
// on this deployment — verified against the live bytecode), so multi-leg routes
// are sequenced transactions with per-step status, simulate-before-sign and
// named reverts. USDC routes stay the classic approve → swap two-step.
// ─────────────────────────────────────────────────────────────────────────────

export type HubToken = 'ETH' | 'WETH' | 'USDC'
export type DexDirection = 'buy' | 'sell'

/** SwapRouter02's ADDRESS_THIS sentinel — keeps the hop's WETH in the router so
 *  the batched unwrapWETH9 can pay out native ETH. */
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as Address
const USDC_DECIMALS = 6

export type DexTxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error'
export interface DexTxState {
  status: DexTxStatus
  hash: Hex | null
  error: string | null
}
const TX_IDLE: DexTxState = { status: 'idle', hash: null, error: null }

export interface DexQuote {
  /** Raw pay amount (pay-token decimals; 18 for ETH/WETH, 6 USDC, basket decimals on sell). */
  amountInRaw: bigint
  /** Estimated receive amount, raw receive-token decimals. */
  outRaw: bigint
  /** Binding floor on the receive side, raw. */
  minOutRaw: bigint
  /** The USDC that crosses the basket leg (est.), raw 6dp. */
  usdcLegRaw: bigint
  /** Hub-leg fee tier when a hub swap is involved (display). */
  hubFee: number | null
  /** Number of protected constituent legs on a buy (display). */
  legCount: number
}

export interface DexStep {
  key: string
  label: string
}

export function useDexSwap(
  ix: BasketData | null,
  direction: DexDirection,
  hub: HubToken,
  chainId: number,
) {
  const cfg = chainCfg(chainId)
  const dep = deploymentFor(chainId)
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()
  const queryClient = useQueryClient()

  const [quote, setQuote] = useState<DexQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<{ hash: Hex } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txs, setTxs] = useState<Record<string, DexTxState>>({})
  const [payBalance, setPayBalance] = useState<bigint | null>(null)
  const runningRef = useRef(false)
  const quoteSeq = useRef(0)

  const walletReady = isConnected && walletChainId === chainId
  const spectrumRouter = dep.swapRouter
  const usdc = dep.usdc
  const weth = dep.weth
  const router02 = dep.uniV3SwapRouter
  const quoter = dep.uniV3Quoter
  const hubConfigured = !!router02 && !!quoter && !!weth
  // External hub (LiFi) — chains with NO Uniswap periphery (Robinhood): the
  // ETH ↔ settlement hop quotes/executes through LiFi's source-verified diamond
  // (lifi.ts, guards included). Only ever active where uni infra is absent.
  const lifiHub = cfg.externalHubRouter === 'lifi' && !hubConfigured
  const configured = SWAP_ENABLED && !!spectrumRouter && !!usdc && (hub === 'USDC' || hubConfigured || lifiHub)

  const patchTx = useCallback((key: string, p: Partial<DexTxState>) => {
    setTxs((s) => ({ ...s, [key]: { ...(s[key] ?? TX_IDLE), ...p } }))
  }, [])
  const txOf = useCallback((key: string): DexTxState => txs[key] ?? TX_IDLE, [txs])
  const resetRun = useCallback(() => {
    setTxs({})
    setDone(null)
    setError(null)
  }, [])

  // ── pay-side balance (native for ETH) ──────────────────────────────────────
  useEffect(() => {
    let stale = false
    setPayBalance(null)
    if (!address) return
    const client = clientFor(chainId)
    const read = async (): Promise<bigint> => {
      if (direction === 'sell') {
        if (!ix) return 0n
        return client.readContract({
          address: ix.address as Address,
          abi: erc20BalanceAbi,
          functionName: 'balanceOf',
          args: [address],
        })
      }
      if (hub === 'ETH') return client.getBalance({ address })
      const token = hub === 'WETH' ? weth : usdc
      if (!token) return 0n
      return client.readContract({ address: token, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [address] })
    }
    read()
      .then((b) => {
        if (!stale) setPayBalance(b)
      })
      .catch(() => {
        if (!stale) setPayBalance(null)
      })
    return () => {
      stale = true
    }
  }, [address, chainId, direction, hub, ix, usdc, weth, done])

  // ── quoting (debounced by the caller; abortable by sequence) ───────────────
  const refreshQuote = useCallback(
    async (amountInRaw: bigint, slippageBps: number, feeFrac: number) => {
      const seq = ++quoteSeq.current
      setQuoteError(null)
      if (!ix || amountInRaw <= 0n || !Number.isFinite(feeFrac)) {
        setQuote(null)
        return
      }
      setQuoting(true)
      try {
        const client = clientFor(chainId)
        const slip = clampSlippageBps(slippageBps)

        if (direction === 'buy') {
          // hub leg first (ETH/WETH → settlement), then the basket leg off its output
          let usdcLegRaw = amountInRaw
          let hubFee: number | null = null
          if (hub !== 'USDC') {
            if (hubConfigured) {
              const q = await bestExactInTier(client, quoter!, weth!, usdc!, amountInRaw)
              if (!q) throw new Error('No WETH/USDC route quoted.')
              usdcLegRaw = q.amount
              hubFee = q.fee
            } else if (lifiHub && address) {
              const lq = await fetchLifiQuote({
                chainId,
                fromToken: LIFI_NATIVE,
                toToken: usdc!,
                fromAmount: amountInRaw,
                fromAddress: address,
                slippageBps: slip,
              })
              if (seq !== quoteSeq.current) return
              usdcLegRaw = lq.toAmount
            } else if (lifiHub) {
              throw new Error('Connect a wallet to quote this route.')
            } else {
              throw new Error('Uniswap router/quoter not configured for ETH/WETH routes.')
            }
          }
          const usdcFloat = Number(formatUnits(usdcLegRaw, USDC_DECIMALS))
          const bq = buildSwapQuote({
            side: 'buy',
            amount: usdcFloat,
            navPerToken: ix.navPerToken,
            feeFrac,
            slippageBps: slip,
            holdings: ix.holdings,
            basketDecimals: ix.decimals,
          })
          if (seq !== quoteSeq.current) return
          if (!bq) throw new Error('Basket quote unavailable (a leg is unpriced or the amount rounds to zero).')
          // Display estimate: pre-slippage expected shares off NAV; the floor is minOutRaw.
          const estShares = (usdcFloat * (1 - feeFrac)) / ix.navPerToken
          const outRaw = BigInt(Math.floor(estShares * 10 ** Math.min(ix.decimals, 18)))
          setQuote({
            amountInRaw,
            outRaw: outRaw > bq.minOutRaw ? outRaw : bq.minOutRaw,
            minOutRaw: bq.minOutRaw,
            usdcLegRaw,
            hubFee,
            legCount: bq.legCount,
          })
        } else {
          // basket → USDC, then optionally USDC → WETH/ETH
          const sharesFloat = Number(formatUnits(amountInRaw, Math.min(ix.decimals, 18)))
          const bq = buildSwapQuote({
            side: 'sell',
            amount: sharesFloat,
            navPerToken: ix.navPerToken,
            feeFrac,
            slippageBps: slip,
            holdings: ix.holdings,
            basketDecimals: ix.decimals,
          })
          if (!bq) throw new Error('Basket quote unavailable.')
          let outRaw = bq.minOutRaw
          let hubFee: number | null = null
          if (hub !== 'USDC') {
            if (hubConfigured) {
              const q = await bestExactInTier(client, quoter!, usdc!, weth!, bq.minOutRaw)
              if (!q) throw new Error('No USDC/WETH route quoted.')
              outRaw = minOutFor(q.amount, BigInt(slip))
              hubFee = q.fee
            } else if (lifiHub && address) {
              const lq = await fetchLifiQuote({
                chainId,
                fromToken: usdc!,
                toToken: LIFI_NATIVE,
                fromAmount: bq.minOutRaw,
                fromAddress: address,
                slippageBps: slip,
              })
              if (seq !== quoteSeq.current) return
              outRaw = lq.toAmountMin // the router-enforced floor
            } else if (lifiHub) {
              throw new Error('Connect a wallet to quote this route.')
            } else {
              throw new Error('Uniswap router/quoter not configured for ETH/WETH routes.')
            }
          }
          if (seq !== quoteSeq.current) return
          setQuote({
            amountInRaw,
            outRaw,
            minOutRaw: outRaw,
            usdcLegRaw: bq.minOutRaw,
            hubFee,
            legCount: bq.legCount,
          })
        }
      } catch (e) {
        if (seq !== quoteSeq.current) return
        setQuote(null)
        setQuoteError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === quoteSeq.current) setQuoting(false)
      }
    },
    [address, chainId, direction, hub, hubConfigured, lifiHub, ix, quoter, usdc, weth],
  )

  // ── the executable steps for the CTA/progress display ──────────────────────
  // Labels use the chain's settlement symbol (USDC on Base/Ethereum, USDG on
  // Robinhood Chain) — the mechanics are identical, only the name differs.
  const usdcSym = cfg.usdcSymbol
  const steps = useCallback(
    (sym: string): DexStep[] => {
      if (direction === 'buy') {
        const list: DexStep[] = []
        if (hub === 'ETH') list.push({ key: 'hub-in', label: `Swap ETH → ${usdcSym}` })
        if (hub === 'WETH')
          list.push({ key: 'approve-in', label: 'Approve WETH' }, { key: 'hub-in', label: `Swap WETH → ${usdcSym}` })
        list.push({ key: 'approve-usdc', label: `Approve ${usdcSym}` }, { key: 'spectrum', label: `Buy $${sym}` })
        return list
      }
      const list: DexStep[] = [
        { key: 'approve-in', label: `Approve $${sym}` },
        { key: 'spectrum', label: `Sell $${sym} → ${usdcSym}` },
      ]
      if (hub !== 'USDC')
        list.push(
          { key: 'approve-usdc', label: `Approve ${usdcSym}` },
          { key: 'hub-out', label: hub === 'ETH' ? `Swap ${usdcSym} → ETH` : `Swap ${usdcSym} → WETH` },
        )
      return list
    },
    [direction, hub, usdcSym],
  )

  // ── execution ───────────────────────────────────────────────────────────────
  const execute = useCallback(
    async (amountInRaw: bigint, slippageBps: number, feeFrac: number) => {
      // Hard stop independent of UI gating — keep through every refactor.
      if (!SWAP_ENABLED) return setError('Buy/sell is disabled on this build (VITE_ENABLE_SWAP).')
      if (!configured || !spectrumRouter || !usdc) return setError('No swap router configured.')
      if (!address || !walletReady || !publicClient) return setError(`Connect a wallet on ${cfg.name} to trade.`)
      if (!ix) return setError('Pick a basket first.')
      if (runningRef.current) return
      runningRef.current = true
      setRunning(true)
      setError(null)
      setDone(null)

      const client = clientFor(chainId)
      const holder = address
      const basket = ix.address as Address
      const slip = clampSlippageBps(slippageBps)

      const approveIfNeeded = async (key: string, token: Address, spender: Address, needed: bigint) => {
        const allowance = await client.readContract({
          address: token,
          abi: erc20ApproveAbi,
          functionName: 'allowance',
          args: [holder, spender],
        })
        const mode = approvalPlan(allowance, needed)
        if (mode === 'none') {
          patchTx(key, { status: 'success' })
          return
        }
        const values: bigint[] = mode === 'zero-first' ? [0n, needed] : [needed]
        for (const value of values) {
          patchTx(key, { status: 'signing', error: null })
          const h = await writeContractAsync({
            address: token,
            abi: erc20ApproveAbi,
            functionName: 'approve',
            args: [spender, value],
            chainId,
          })
          patchTx(key, { status: 'confirming', hash: h })
          await publicClient.waitForTransactionReceipt({ hash: h })
        }
        patchTx(key, { status: 'success' })
      }

      const balanceOf = (token: Address) =>
        client.readContract({ address: token, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] })

      try {
        if (direction === 'buy') {
          // ── hub leg: ETH/WETH → settlement (Uniswap where present, LiFi where not) ──
          let usdcIn = amountInRaw
          if (hub !== 'USDC') {
            if (!hubConfigured && !lifiHub) throw new Error('Uniswap router/quoter not configured for ETH/WETH routes.')
            let hubReceipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
            if (lifiHub && !hubConfigured) {
              // LiFi: re-quote at execution (fresh route + floor), approve only for
              // ERC-20 pay (ETH rides tx.value), send the guarded transactionRequest
              // verbatim. parseLifiQuote already enforced target==spender, echoed
              // route match, and exact-value — no unchecked fields reach here.
              const lq = await fetchLifiQuote({
                chainId,
                fromToken: LIFI_NATIVE,
                toToken: usdc,
                fromAmount: amountInRaw,
                fromAddress: holder,
                slippageBps: slip,
              })
              patchTx('hub-in', { status: 'signing', error: null })
              const h = await sendTransactionAsync({
                to: lq.tx.to,
                data: lq.tx.data,
                value: lq.tx.value,
                gas: lq.tx.gasLimit ?? undefined,
                chainId,
              })
              patchTx('hub-in', { status: 'confirming', hash: h })
              hubReceipt = await publicClient.waitForTransactionReceipt({ hash: h })
            } else {
              const q = await bestExactInTier(client, quoter!, weth!, usdc, amountInRaw)
              if (!q) throw new Error('No WETH/USDC route.')
              if (hub === 'WETH') await approveIfNeeded('approve-in', weth!, router02!, amountInRaw)
              const params = {
                tokenIn: weth!,
                tokenOut: usdc,
                fee: q.fee,
                recipient: holder,
                amountIn: amountInRaw,
                amountOutMinimum: minOutFor(q.amount, BigInt(slip)),
                sqrtPriceLimitX96: 0n,
              } as const
              const value = hub === 'ETH' ? amountInRaw : 0n
              patchTx('hub-in', { status: 'signing', error: null })
              await publicClient.simulateContract({
                account: holder,
                address: router02!,
                abi: swapRouter02Abi,
                functionName: 'exactInputSingle',
                args: [params],
                value,
              })
              const h = await writeContractAsync({
                address: router02!,
                abi: swapRouter02Abi,
                functionName: 'exactInputSingle',
                args: [params],
                value,
                chainId,
              })
              patchTx('hub-in', { status: 'confirming', hash: h })
              hubReceipt = await publicClient.waitForTransactionReceipt({ hash: h })
            }
            // Measure the delivered USDC from the RECEIPT's own Transfer logs — never a
            // before/after balance diff. The old diff read balances through a different
            // RPC client than the receipt wait; a lagging read node returned the pre-swap
            // balance → 0 diff → a false "delivered no USDC" on a swap that succeeded
            // (owner hit this live on Base, 2026-07-09).
            usdcIn = parseEventLogs({ abi: erc20TransferAbi, logs: hubReceipt.logs })
              .filter(
                (l) =>
                  l.address.toLowerCase() === usdc.toLowerCase() &&
                  (l.args as { to: Address }).to.toLowerCase() === holder.toLowerCase(),
              )
              .reduce((sum, l) => sum + (l.args as { value: bigint }).value, 0n)
            if (usdcIn <= 0n) {
              patchTx('hub-in', { status: 'error', error: `No ${usdcSym} reached your wallet in this transaction.` })
              throw new Error(`Hub swap delivered no ${usdcSym} — aborting before the basket leg.`)
            }
            patchTx('hub-in', { status: 'success' })
          }

          // Fresh basket seed rule (C-1): the FIRST mint must be ≥ 10 USDC.
          if ((ix.effectiveSupply ?? 1) === 0 && usdcIn < 10_000_000n) {
            throw new Error(
              `This is $${ix.symbol}'s first buy — it seeds the basket and needs at least 10 ${usdcSym} on the basket leg (got ${formatUnits(usdcIn, 6)}).`,
            )
          }

          // ── basket leg: floors recomputed off the MEASURED USDC ──
          const usdcFloat = Number(formatUnits(usdcIn, USDC_DECIMALS))
          const bq = buildSwapQuote({
            side: 'buy',
            amount: usdcFloat,
            navPerToken: ix.navPerToken,
            feeFrac,
            slippageBps: slip,
            holdings: ix.holdings,
            basketDecimals: ix.decimals,
          })
          if (!bq) throw new Error('Basket quote unavailable at execution — refresh and retry.')
          await approveIfNeeded('approve-usdc', usdc, spectrumRouter, usdcIn)
          // Per-leg floors off the REAL acquire route (USDC→ETH→leg), not frictionless
          // spot — so a leg whose pool fee+impact exceeds the flat tolerance no longer
          // trips LegMinNotMet on an honest buy. Falls back to the spot floors when the
          // hub can't be quoted. The aggregate `minOut` (bq.minOutRaw) is unchanged.
          let legAmounts = bq.quotedLegAmounts
          if (hubConfigured && weth && quoter) {
            const feeBpsInt = BigInt(Math.round(feeFrac * 10_000))
            const usdcNetRaw = usdcIn - (usdcIn * feeBpsInt) / 10_000n
            const fills = await quoteBuyLegFills(
              client,
              quoter,
              usdc,
              weth,
              ix.holdings.map((h, i) => ({
                asset: h.asset as Address,
                weightPct: h.targetWeightPct,
                isUsdc: h.asset.toLowerCase() === usdc.toLowerCase(),
                spotAmount: bq.quotedLegAmounts[i],
              })),
              usdcNetRaw,
            )
            if (fills) legAmounts = fills
          }
          // Aggregate floor off the REAL mint output, not frictionless NAV. NAV-based
          // minOut (usdcNet/nav × (1−slip)) ignores the double-swap acquisition cost
          // (USDC→ETH→each leg), so the whole tolerance is eaten by structural cost and
          // an honest buy reverts SlippageExceeded. Simulate once with the floor open to
          // read the shares the mint actually yields now, then set minOut a slippage
          // below THAT — a real buffer. Falls back to the NAV floor if the probe can't run.
          let minShares = bq.minOutRaw
          try {
            const probe = encodeMintHookData({ quotedLegAmounts: legAmounts, slippageBps: slip, minOut: 1n })
            const sim = await publicClient.simulateContract({
              account: holder,
              address: spectrumRouter,
              abi: swapRouterAbi,
              functionName: 'swapExactIn',
              args: [basket, usdc, usdcIn, 1n, probe.hookData, holder],
            })
            const real = sim.result as bigint
            if (real > 0n) minShares = minOutFor(real, BigInt(slip))
          } catch {
            /* probe failed — keep the NAV-based floor */
          }
          const mint = encodeMintHookData({
            quotedLegAmounts: legAmounts,
            slippageBps: slip,
            minOut: minShares,
            // referral (owner 2026-07-07): a stored ?ref tags this buy's interface
            // slice to the referrer; null → the operator's default tag.
            interfaceTag: getStoredRef(address),
          })
          const buyArgs = {
            account: holder,
            address: spectrumRouter,
            abi: swapRouterAbi,
            functionName: 'swapExactIn' as const,
            args: [basket, usdc, usdcIn, minShares, mint.hookData, holder] as const,
          }
          patchTx('spectrum', { status: 'signing', error: null })
          await publicClient.simulateContract(buyArgs)
          // Explicit gas — the wallet's estimate under-shoots the basket mint and reverts OOG.
          const buyGas = await gasWithHeadroom(publicClient, buyArgs)
          const h2 = await writeContractAsync({
            address: spectrumRouter,
            abi: swapRouterAbi,
            functionName: 'swapExactIn',
            args: [basket, usdc, usdcIn, minShares, mint.hookData, holder],
            chainId,
            gas: buyGas,
          })
          patchTx('spectrum', { status: 'confirming', hash: h2 })
          await publicClient.waitForTransactionReceipt({ hash: h2 })
          patchTx('spectrum', { status: 'success' })
          setDone({ hash: h2 })
        } else {
          // ── SELL: basket → USDC (protected), then optional USDC → WETH/ETH ──
          const sharesFloat = Number(formatUnits(amountInRaw, Math.min(ix.decimals, 18)))
          const bq = buildSwapQuote({
            side: 'sell',
            amount: sharesFloat,
            navPerToken: ix.navPerToken,
            feeFrac,
            slippageBps: slip,
            holdings: ix.holdings,
            basketDecimals: ix.decimals,
          })
          if (!bq) throw new Error('Basket quote unavailable at execution — refresh and retry.')
          await approveIfNeeded('approve-in', basket, spectrumRouter, amountInRaw)
          const redeem = encodeRedeemHookData({ legCount: bq.legCount, minOut: bq.minOutRaw, interfaceTag: getStoredRef(address) })
          patchTx('spectrum', { status: 'signing', error: null })
          const usdcBefore = await balanceOf(usdc)
          await publicClient.simulateContract({
            account: holder,
            address: spectrumRouter,
            abi: swapRouterAbi,
            functionName: 'swapExactIn',
            args: [basket, basket, amountInRaw, bq.minOutRaw, redeem.hookData, holder],
          })
          const h = await writeContractAsync({
            address: spectrumRouter,
            abi: swapRouterAbi,
            functionName: 'swapExactIn',
            args: [basket, basket, amountInRaw, bq.minOutRaw, redeem.hookData, holder],
            chainId,
          })
          patchTx('spectrum', { status: 'confirming', hash: h })
          const receipt = await publicClient.waitForTransactionReceipt({ hash: h })
          patchTx('spectrum', { status: 'success' })
          const swapped = parseEventLogs({ abi: swapRouterAbi, logs: receipt.logs }).find(
            (l) => l.eventName === 'Swapped',
          )
          const usdcOut = (swapped?.args as { amountOut?: bigint } | undefined)?.amountOut ?? ((await balanceOf(usdc)) - usdcBefore)

          if (hub === 'USDC' || usdcOut <= 0n) {
            setDone({ hash: h })
          } else if (lifiHub && !hubConfigured) {
            // LiFi hub-out: settlement → native ETH through the verified diamond.
            // A failure here strands nothing — the settlement asset is already in
            // the holder's wallet; the error says so plainly.
            const lq = await fetchLifiQuote({
              chainId,
              fromToken: usdc,
              toToken: LIFI_NATIVE,
              fromAmount: usdcOut,
              fromAddress: holder,
              slippageBps: slip,
            }).catch((e) => {
              throw new Error(
                `${e instanceof Error ? e.message : 'No route.'} Your ${cfg.usdcSymbol} is in your wallet; convert it manually.`,
              )
            })
            await approveIfNeeded('approve-usdc', usdc, lq.approvalAddress, usdcOut)
            patchTx('hub-out', { status: 'signing', error: null })
            const h3 = await sendTransactionAsync({
              to: lq.tx.to,
              data: lq.tx.data,
              value: lq.tx.value,
              gas: lq.tx.gasLimit ?? undefined,
              chainId,
            })
            patchTx('hub-out', { status: 'confirming', hash: h3 })
            await publicClient.waitForTransactionReceipt({ hash: h3 })
            patchTx('hub-out', { status: 'success' })
            setDone({ hash: h3 })
          } else {
            if (!hubConfigured) throw new Error('Uniswap router/quoter not configured for ETH/WETH routes.')
            const q = await bestExactInTier(client, quoter!, usdc, weth!, usdcOut)
            if (!q) throw new Error('No USDC/WETH route — your USDC is in your wallet; convert it manually.')
            await approveIfNeeded('approve-usdc', usdc, router02!, usdcOut)
            patchTx('hub-out', { status: 'signing', error: null })
            let h3: Hex
            if (hub === 'WETH') {
              const params = {
                tokenIn: usdc,
                tokenOut: weth!,
                fee: q.fee,
                recipient: holder,
                amountIn: usdcOut,
                amountOutMinimum: minOutFor(q.amount, BigInt(slip)),
                sqrtPriceLimitX96: 0n,
              } as const
              await publicClient.simulateContract({
                account: holder,
                address: router02!,
                abi: swapRouter02Abi,
                functionName: 'exactInputSingle',
                args: [params],
              })
              h3 = await writeContractAsync({
                address: router02!,
                abi: swapRouter02Abi,
                functionName: 'exactInputSingle',
                args: [params],
                chainId,
              })
            } else {
              // Native ETH out: swap lands WETH in the router, unwrapWETH9 pays the holder.
              const minWeth = minOutFor(q.amount, BigInt(slip))
              const datas = [
                encodeFunctionData({
                  abi: swapRouter02Abi,
                  functionName: 'exactInputSingle',
                  args: [
                    {
                      tokenIn: usdc,
                      tokenOut: weth!,
                      fee: q.fee,
                      recipient: ADDRESS_THIS,
                      amountIn: usdcOut,
                      amountOutMinimum: minWeth,
                      sqrtPriceLimitX96: 0n,
                    },
                  ],
                }),
                encodeFunctionData({
                  abi: swapRouter02Abi,
                  functionName: 'unwrapWETH9',
                  args: [minWeth, holder],
                }),
              ]
              await publicClient.simulateContract({
                account: holder,
                address: router02!,
                abi: swapRouter02Abi,
                functionName: 'multicall',
                args: [datas],
              })
              h3 = await writeContractAsync({
                address: router02!,
                abi: swapRouter02Abi,
                functionName: 'multicall',
                args: [datas],
                chainId,
              })
            }
            patchTx('hub-out', { status: 'confirming', hash: h3 })
            await publicClient.waitForTransactionReceipt({ hash: h3 })
            patchTx('hub-out', { status: 'success' })
            setDone({ hash: h3 })
          }
        }
        void queryClient.invalidateQueries()
      } catch (e) {
        const msg = friendlyRevert(e, e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e))
        setTxs((s) => {
          const next = { ...s }
          for (const k of Object.keys(next)) {
            if (next[k].status === 'signing' || next[k].status === 'confirming') {
              next[k] = { ...next[k], status: 'error', error: msg }
            }
          }
          return next
        })
        setError(msg)
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [address, cfg.name, cfg.usdcSymbol, chainId, configured, direction, hub, hubConfigured, lifiHub, ix, patchTx, publicClient, quoter, queryClient, router02, sendTransactionAsync, spectrumRouter, usdc, usdcSym, walletReady, weth, writeContractAsync],
  )

  return {
    configured,
    hubConfigured,
    lifiHub,
    walletReady,
    payBalance,
    quote,
    quoting,
    quoteError,
    refreshQuote,
    steps,
    execute,
    running,
    done,
    error,
    txOf,
    resetRun,
  }
}
