import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { encodeFunctionData, formatUnits, parseEventLogs, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { SWAP_ENABLED, TRADING_ENABLED } from '../config/features'
import { getBasketData } from './basket-data'
import { erc20ApproveAbi, erc20BalanceAbi, swapRouterAbi } from './abis-v2'
import { bestExactInTier, encodeV3Path, minOutFor, quoteBuyLegFills, swapRouter02Abi } from './delta-trade'
import { approvalPlan } from './migrate-math'
import { gasWithHeadroom } from './gas'
import { buildSwapQuote } from './swap-quote'
import { encodeMintHookData, clampSlippageBps } from './hook-data'
import { getStoredRef } from './referral'
import { friendlyRevert } from './decode-revert'

// ─────────────────────────────────────────────────────────────────────────────
// LEFTOVER SWEEP — the tail of a version migration. mintInKind takes each
// constituent in exact basket proportion, so anything the wallet holds ABOVE
// that proportion (overlap excess, delta-trade rounding, WETH dust) is stranded.
// This hook turns that residue, in one tap, into either:
//   • Compound — swap residue → USDC, then buy more of the basket just migrated into
//   • Cash out — swap residue → USDC, left in the wallet
//
// It builds NO new machinery — it wires together the exact pieces the migration
// already uses: bestExactInTier/QuoterV2 quotes (delta-trade.ts), approvalPlan
// (migrate-math.ts), a single batched SwapRouter02.multicall of exactInput legs
// (delta-trade.ts), and — for compound — the protected SpectrumSwapRouter.swapExactIn
// buy with hookData from buildSwapQuote + encodeMintHookData (the /swap buy leg).
//
// Same idiom as use-migrate: simulate → write → waitForTransactionReceipt per step,
// inline per-step status, no toasts. Always opt-in; every swap floored by a minOut
// the user sees before signing; dust (worth less than its share of gas) is skipped,
// never swept at a loss. Hard-guarded by TRADING_ENABLED; compound also needs
// SWAP_ENABLED (it is a basket buy).
// ─────────────────────────────────────────────────────────────────────────────

/** A constituent left in the wallet after a migration. */
export interface ResidueToken {
  address: Address
  symbol: string
  decimals: number
  /** Raw amount THIS migration left behind (token decimals) — measured against
   *  the pre-flow baseline; the sweep's default scope (owner decision 2026-07-05:
   *  never hoover pre-existing holdings by default). */
  amount: bigint
  /** Full wallet balance (raw) — the opt-in "include everything" scope. */
  walletBalance?: bigint
}

export type SweepMode = 'compound' | 'cashout'
export type SweepTxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error'
export interface SweepTxState {
  status: SweepTxStatus
  hash: Hex | null
  error: string | null
}
const TX_IDLE: SweepTxState = { status: 'idle', hash: null, error: null }

export type SweepPhase = 'idle' | 'quoting' | 'empty' | 'ready' | 'running' | 'done' | 'error'

const SWEEP_SLIPPAGE_BPS = 100n // 1% floor on each residue→USDC swap
const PER_LEG_GAS = 130_000n // ~one V3 swap's worth, for the dust threshold
const GAS_FALLBACK_USDC = 10_000n // $0.01 (6dp) when gas can't be priced

/** One residue token, quoted → USDC, with its sweep disposition. */
export interface SweepRow {
  token: ResidueToken
  /** Quoted USDC out (6dp), or null when no direct pool routes it. */
  usdcOut: bigint | null
  /** Best fee tier for token→USDC, or null. */
  fee: number | null
  /** The token IS USDC — counts directly, no swap. */
  isUsdc: boolean
  /** Skipped: 'dust' (worth less than its gas) or 'no-route'. */
  skip: null | 'dust' | 'no-route'
}

export interface SweepQuote {
  rows: SweepRow[]
  /** Rows that will actually be swept (USDC-direct or routable & above dust). */
  survivors: SweepRow[]
  /** Σ survivor USDC (6dp) — the sweepable value. */
  totalUsdc: bigint
  /** Per-leg gas threshold used for the dust filter (6dp USDC). */
  gasCostUsdc: bigint
}

export interface SweepResult {
  mode: SweepMode
  /** USDC realized by the sweep (6dp). */
  usdc: bigint
  /** Shares minted (compound only). */
  shares?: bigint
  hash: Hex
}

export interface UseSweepArgs {
  residue: ResidueToken[]
  basket: Address
  chainId: number
  /** New basket's fee in bps (for the compound buy quote). */
  feeBps: number
  open: boolean
}

export function useSweep({ residue, basket, chainId, feeBps, open }: UseSweepArgs) {
  const cfg = chainCfg(chainId)
  const dep = deploymentFor(chainId)
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const usdc = dep.usdc
  const weth = dep.weth
  const router02 = dep.uniV3SwapRouter
  const quoter = dep.uniV3Quoter
  const spectrumRouter = dep.swapRouter
  // Cash-out needs only the Uniswap hub (quoter + router02 + usdc).
  const configured = TRADING_ENABLED && !!usdc && !!router02 && !!quoter
  // Compound is a Spectrum basket buy — it additionally needs the buy surface.
  const compoundAvailable = configured && SWAP_ENABLED && !!spectrumRouter

  const walletReady = isConnected && walletChainId === chainId

  const [phase, setPhase] = useState<SweepPhase>('idle')
  const [quote, setQuote] = useState<SweepQuote | null>(null)
  const [mode, setMode] = useState<SweepMode>('compound')
  const [txs, setTxs] = useState<Record<string, SweepTxState>>({})
  const [result, setResult] = useState<SweepResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runningRef = useRef(false)
  const quoteSeq = useRef(0)

  const patchTx = useCallback((key: string, p: Partial<SweepTxState>) => {
    setTxs((s) => ({ ...s, [key]: { ...(s[key] ?? TX_IDLE), ...p } }))
  }, [])
  const txOf = useCallback((key: string): SweepTxState => txs[key] ?? TX_IDLE, [txs])

  // If compound isn't available, don't leave the toggle on it.
  useEffect(() => {
    if (!compoundAvailable) setMode('cashout')
  }, [compoundAvailable])

  // ── quote each residue token → USDC, dust-filter ──────────────────────────
  useEffect(() => {
    if (!open) return
    const seq = ++quoteSeq.current
    if (!configured || residue.length === 0 || !usdc || !quoter) {
      setPhase(residue.length === 0 ? 'empty' : 'idle')
      setQuote(null)
      return
    }
    setPhase('quoting')
    ;(async () => {
      try {
        const client = clientFor(chainId)
        const usdcLow = usdc.toLowerCase()

        // Price one leg's gas in USDC (gasPrice × per-leg gas → wei → USDC via a
        // WETH/USDC quote). Below this, a token costs more to sweep than it's worth.
        let gasCostUsdc = GAS_FALLBACK_USDC
        try {
          const gasPrice = await client.getGasPrice()
          const ethUsd = weth ? await bestExactInTier(client, quoter, weth, usdc, 10n ** 18n) : null
          if (ethUsd && gasPrice > 0n) gasCostUsdc = (PER_LEG_GAS * gasPrice * ethUsd.amount) / 10n ** 18n
        } catch {
          /* keep the fallback */
        }

        const rows = await Promise.all(
          residue.map(async (token): Promise<SweepRow> => {
            if (token.address.toLowerCase() === usdcLow) {
              return { token, usdcOut: token.amount, fee: null, isUsdc: true, skip: null }
            }
            const q = await bestExactInTier(client, quoter, token.address, usdc, token.amount)
            if (!q || q.amount === 0n) return { token, usdcOut: null, fee: null, isUsdc: false, skip: 'no-route' }
            const dust = q.amount < gasCostUsdc
            return { token, usdcOut: q.amount, fee: q.fee, isUsdc: false, skip: dust ? 'dust' : null }
          }),
        )
        if (seq !== quoteSeq.current) return
        const survivors = rows.filter((r) => r.skip === null)
        const totalUsdc = survivors.reduce((s, r) => s + (r.usdcOut ?? 0n), 0n)
        setQuote({ rows, survivors, totalUsdc, gasCostUsdc })
        setPhase(survivors.length === 0 ? 'empty' : 'ready')
      } catch (e) {
        if (seq !== quoteSeq.current) return
        setError(messageOf(e))
        setPhase('error')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, configured, chainId, residue, usdc, quoter, weth])

  // ── execute the chosen sweep ──────────────────────────────────────────────
  const execute = useCallback(async () => {
    if (!TRADING_ENABLED) return setError('Trading is disabled on this build (VITE_ENABLE_TRADING).')
    if (mode === 'compound' && !SWAP_ENABLED) return setError('Buy/sell is disabled on this build (VITE_ENABLE_SWAP).')
    if (!configured || !usdc || !router02 || !quoter) return setError('No swap router configured for the sweep.')
    if (!address || !walletReady || !publicClient) return setError(`Connect a wallet on ${cfg.name} to sweep.`)
    const q = quote
    if (!q || q.survivors.length === 0) return
    if (runningRef.current) return
    runningRef.current = true
    setPhase('running')
    setError(null)

    try {
      const client = clientFor(chainId)
      const holder = address
      const balanceOf = (token: Address) =>
        client.readContract({ address: token, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] })

      const approve = async (key: string, token: Address, spender: Address, needed: bigint) => {
        const allowance = await client.readContract({
          address: token,
          abi: erc20ApproveAbi,
          functionName: 'allowance',
          args: [holder, spender],
        })
        const mode = approvalPlan(allowance, needed)
        const steps: bigint[] = mode === 'zero-first' ? [0n, needed] : mode === 'direct' ? [needed] : []
        for (const value of steps) {
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

      // Non-USDC survivors are swapped → USDC; a USDC-direct survivor just counts.
      const toSwap = q.survivors.filter((r) => !r.isUsdc && r.fee != null && r.usdcOut != null)
      const usdcDirect = q.survivors.filter((r) => r.isUsdc).reduce((s, r) => s + r.token.amount, 0n)

      let swapProceeds = 0n
      if (toSwap.length > 0) {
        // one exact-amount approval per sold token (zero-first for USDT-style)
        for (const r of toSwap) {
          await approve(`approve:${r.token.address.toLowerCase()}`, r.token.address, router02, r.token.amount)
        }
        // all residue→USDC swaps in ONE tx (recipient = holder; USDC lands in wallet)
        const datas = toSwap.map((r) =>
          encodeFunctionData({
            abi: swapRouter02Abi,
            functionName: 'exactInput',
            args: [
              {
                path: encodeV3Path([r.token.address, usdc], [r.fee as number]),
                recipient: holder,
                amountIn: r.token.amount,
                amountOutMinimum: minOutFor(r.usdcOut as bigint, SWEEP_SLIPPAGE_BPS),
              },
            ],
          }),
        )
        const usdcBefore = await balanceOf(usdc)
        patchTx('swap', { status: 'signing', error: null })
        await publicClient.simulateContract({
          account: holder,
          address: router02,
          abi: swapRouter02Abi,
          functionName: 'multicall',
          args: [datas],
        })
        const h = await writeContractAsync({
          address: router02,
          abi: swapRouter02Abi,
          functionName: 'multicall',
          args: [datas],
          chainId,
        })
        patchTx('swap', { status: 'confirming', hash: h })
        await publicClient.waitForTransactionReceipt({ hash: h })
        patchTx('swap', { status: 'success' })
        swapProceeds = (await balanceOf(usdc)) - usdcBefore
      }

      // USDC the sweep produced/consolidated (never touches pre-existing wallet USDC).
      const sweptUsdc = swapProceeds + usdcDirect
      if (sweptUsdc <= 0n) throw new Error('The sweep produced no USDC.')

      if (mode === 'cashout') {
        // Recipient was the holder — USDC is already in the wallet.
        const lastHash = txOf('swap').hash
        setResult({ mode, usdc: sweptUsdc, hash: (lastHash ?? ('0x' as Hex)) })
        setPhase('done')
        void queryClient.invalidateQueries()
        return
      }

      // ── compound: buy more of the basket with the swept USDC ──
      if (!spectrumRouter) throw new Error('No Spectrum router configured for compound.')
      const ix = await getBasketData(basket, chainId)
      const feeFrac = Number.isFinite(feeBps) ? feeBps / 10_000 : 0.01
      const usdcFloat = Number(formatUnits(sweptUsdc, 6))
      const bq = buildSwapQuote({
        side: 'buy',
        amount: usdcFloat,
        navPerToken: ix.navPerToken,
        feeFrac,
        slippageBps: clampSlippageBps(Number(SWEEP_SLIPPAGE_BPS)),
        holdings: ix.holdings,
        basketDecimals: ix.decimals,
      })
      if (!bq) throw new Error('Leftover is too small to compound into shares — cash out instead.')
      await approve('approve-usdc', usdc, spectrumRouter, sweptUsdc)
      // Realistic per-leg floors off the real acquire route (same fix as the buy path)
      // so compounding illiquid-leg baskets doesn't trip LegMinNotMet at 1%.
      let legAmounts = bq.quotedLegAmounts
      if (weth && quoter) {
        const feeBpsInt = BigInt(Math.round(feeFrac * 10_000))
        const usdcNetRaw = sweptUsdc - (sweptUsdc * feeBpsInt) / 10_000n
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
      const slip = clampSlippageBps(Number(SWEEP_SLIPPAGE_BPS))
      // Aggregate floor off the REAL mint output (measured via a floor-open simulate),
      // not frictionless NAV — so the tolerance is a true buffer on the double-swap
      // acquisition cost, not consumed by it (same fix as the buy path's SlippageExceeded).
      let minShares = bq.minOutRaw
      try {
        const probe = encodeMintHookData({ quotedLegAmounts: legAmounts, slippageBps: slip, minOut: 1n })
        const sim = await publicClient.simulateContract({
          account: holder,
          address: spectrumRouter,
          abi: swapRouterAbi,
          functionName: 'swapExactIn',
          args: [basket, usdc, sweptUsdc, 1n, probe.hookData, holder],
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
        interfaceTag: getStoredRef(address), // referral (owner 2026-07-07)
      })
      const compoundArgs = {
        account: holder,
        address: spectrumRouter,
        abi: swapRouterAbi,
        functionName: 'swapExactIn' as const,
        args: [basket, usdc, sweptUsdc, minShares, mint.hookData, holder] as const,
      }
      patchTx('compound', { status: 'signing', error: null })
      await publicClient.simulateContract(compoundArgs)
      // Explicit gas — the wallet's estimate under-shoots the basket mint and reverts OOG.
      const gas = await gasWithHeadroom(publicClient, compoundArgs)
      const h2 = await writeContractAsync({
        address: spectrumRouter,
        abi: swapRouterAbi,
        functionName: 'swapExactIn',
        args: [basket, usdc, sweptUsdc, minShares, mint.hookData, holder],
        chainId,
        gas,
      })
      patchTx('compound', { status: 'confirming', hash: h2 })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: h2 })
      patchTx('compound', { status: 'success' })
      const swapped = parseEventLogs({ abi: swapRouterAbi, logs: receipt.logs }).find((l) => l.eventName === 'Swapped')
      const shares = (swapped?.args as { amountOut?: bigint } | undefined)?.amountOut ?? bq.minOutRaw
      setResult({ mode, usdc: sweptUsdc, shares, hash: h2 })
      setPhase('done')
      void queryClient.invalidateQueries()
    } catch (e) {
      const msg = messageOf(e)
      setTxs((s) => {
        const next = { ...s }
        for (const k of Object.keys(next)) {
          if (next[k].status === 'signing' || next[k].status === 'confirming') next[k] = { ...next[k], status: 'error', error: msg }
        }
        return next
      })
      setError(msg)
      setPhase('error')
    } finally {
      runningRef.current = false
    }
  }, [address, basket, cfg.name, chainId, compoundAvailable, configured, feeBps, mode, patchTx, publicClient, quote, queryClient, quoter, router02, spectrumRouter, txOf, usdc, walletReady, writeContractAsync])

  const reset = useCallback(() => {
    if (runningRef.current) return
    setTxs({})
    setResult(null)
    setError(null)
    setPhase(quote && quote.survivors.length > 0 ? 'ready' : 'empty')
  }, [quote])

  return {
    configured,
    compoundAvailable,
    walletReady,
    phase,
    quote,
    mode,
    setMode,
    txOf,
    execute,
    result,
    error,
    reset,
  }
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
