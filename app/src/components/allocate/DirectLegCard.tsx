import { useCallback, useEffect, useRef, useState } from 'react'
import { parseEther, parseEventLogs, type Address, type Hex } from 'viem'
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi'
import { chainCfg } from '../../lib/chain/chains'
import { settlementDecimalsFor } from '../../lib/chain/deployments'
import { clientFor } from '../../lib/chain/rpc'
import { nativeEthUsdOnChain } from '../../lib/pools/v4-usd'
import { erc20ApproveAbi } from '../../lib/spectrum/abis-v2'
import {
  discoverDirectRoute,
  feeChargedEventAbi,
  quoteAndComposeDirectSwap,
} from '../../lib/spectrum/direct-swap-lane'
import { writeRunLanded } from '../../lib/spectrum/run-landed'
import { WRAPPER_FEE_BPS } from '../../lib/spectrum/direct-swap-wrapper'
import { DEFAULT_SLIPPAGE_BPS } from '../../lib/spectrum/hook-data'
import { approvalPlan } from '../../lib/spectrum/migrate-math'
import { appendExec } from '../../lib/spectrum/exec-log'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { ChainBadge } from '../ChainBadge'
import { RunBeam } from '../run-progress'
import { lintWrapperCalldata } from '../../lib/spectrum/calldata-lint'

// ─────────────────────────────────────────────────────────────────────────────
// THE DIRECT-LANE LEG CARD — the PRISM carve's grammar (identity · money · one
// quiet status line), generalized to ANY asset the batch could not carry: the
// 0x-refused-at-size class (LNOC), the hooked-market class (FWA), and every
// aggregator refusal with a live native route. One leg like any other; the
// mechanics stay out of the copy. The fee is stated because it is charged ON
// TOP (the number shown is the number that decides): 0.4%, 100% burns PRISM.
//
// CONSENT: this card MOUNTS from a click on a refusal/failure door — the
// click is the consent to buy THIS leg in its own transaction. Execution is
// quote-at-click (the directPrism pattern): the lane probes the real wrapper
// call, floors the measured output, RE-PROVES the floored bytes, and only
// those proven bytes are signed. A route that cannot prove itself refuses in
// its own words and nothing is sent.
// ─────────────────────────────────────────────────────────────────────────────

export interface DirectLegSpec {
  chainId: number
  asset: Address
  symbol: string
  usdCents: number
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'routing' }
  | { kind: 'quoting' }
  | { kind: 'approving'; hash?: Hex }
  | { kind: 'wallet' }
  | { kind: 'confirming'; hash: Hex }
  | { kind: 'done'; hash: Hex; feeBurned: boolean; feeless?: boolean }
  | { kind: 'failed'; note: string }

export function DirectLegCard({
  spec,
  autoRun = false,
  onSettled,
  onTerminal,
}: {
  spec: DirectLegSpec
  /** ROUTING IS THE MACHINE'S DECISION (the owner 2026-08-18: "it shouldn't
   *  inform the user of what it's doing… it should just happen auto as part
   *  of the flow"): true = this leg executes itself when its turn comes —
   *  the run's one consent covered it; the card is a progress surface, not a
   *  question. False keeps the manual button (a standalone mount). */
  autoRun?: boolean
  onSettled?: () => void
  /** Fires once on EITHER terminal (done or failed) — the auto-queue's
   *  advance signal, so one refused leg never stalls the legs behind it. */
  onTerminal?: () => void
}) {
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId: spec.chainId })
  const { sendTransactionAsync } = useSendTransaction()
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [routeWords, setRouteWords] = useState<string | null>(null)
  const startedRef = useRef(false)
  const terminalRef = useRef(false)
  const fireTerminal = useCallback(() => {
    if (terminalRef.current) return
    terminalRef.current = true
    onTerminal?.()
  }, [onTerminal])

  const run = useCallback(async () => {
    if (startedRef.current || !address) return
    startedRef.current = true
    try {
      try {
        await switchChainAsync({ chainId: spec.chainId })
      } catch {
        /* already there, or the wallet prompts at signing */
      }
      setPhase({ kind: 'routing' })
      const found = await discoverDirectRoute(spec.chainId, spec.asset, 'buy')
      if (!found.ok) throw new Error(found.reason)
      const route = found.route
      setRouteWords(route.route.kind === 'v4' && route.route.hooked ? `rides $${showSymbol(spec.symbol)}’s own hooked market` : null)

      // Size the input at CLICK time. Settlement routes spend the leg's
      // budget directly; native routes convert it at the chain's own live
      // ETH read — an unreadable price refuses (never a guessed conversion).
      let sellAmountRaw: bigint
      if (route.counter === 'settlement') {
        sellAmountRaw = BigInt(spec.usdCents) * 10n ** BigInt(settlementDecimalsFor(spec.chainId) - 2)
      } else {
        const ethUsd = await nativeEthUsdOnChain(spec.chainId).catch(() => null)
        if (ethUsd == null || !(ethUsd > 0)) throw new Error('No readable ETH price on this network right now — try again.')
        sellAmountRaw = parseEther((spec.usdCents / 100 / ethUsd).toFixed(6))
      }
      if (sellAmountRaw <= 0n) throw new Error('This leg sizes to nothing readable.')

      setPhase({ kind: 'quoting' })
      const composed = await quoteAndComposeDirectSwap({
        route,
        sellAmountRaw,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        holder: address,
        nowSec: Math.floor(Date.now() / 1000),
      })
      if (!composed.ok) throw new Error(composed.reason)
      const swap = composed.swap

      // THE PULL LAW: the wrapper takes sell + fee, so the exact approval is
      // the lane's own number — never re-derived here (one seam, one number).
      if (swap.approval && publicClient) {
        const allowance = (await publicClient
          .readContract({
            address: swap.approval.token,
            abi: erc20ApproveAbi,
            functionName: 'allowance',
            args: [address, swap.approval.spender],
          })
          .catch(() => 0n)) as bigint
        const mode = approvalPlan(allowance, swap.approval.amountRaw, { chainId: spec.chainId, token: swap.approval.token })
        const values = mode === 'none' ? [] : mode === 'zero-first' ? [0n, swap.approval.amountRaw] : [swap.approval.amountRaw]
        for (const value of values) {
          setPhase({ kind: 'approving' })
          const h = await writeContractAsync({
            address: swap.approval.token,
            abi: erc20ApproveAbi,
            functionName: 'approve',
            args: [swap.approval.spender, value],
            chainId: spec.chainId,
          })
          setPhase({ kind: 'approving', hash: h })
          await publicClient.waitForTransactionReceipt({ hash: h })
        }
      }

      if (swap.feeless)
        setRouteWords(`$${showSymbol(spec.symbol)} refuses fee-wrapped routing (its own transfer rule) — buying direct, no fee`)
      // THE CROSS-CHECK before the prompt: fee-wrapped bytes get an
      // independent decode against the money laws (a feeless restricted-token
      // fill goes direct to the router — different call shape, not this
      // lint's subject). Strict: no consent surface on this card.
      if (!swap.feeless) {
        const findings = lintWrapperCalldata({
          data: swap.call.data,
          value: swap.call.value,
          expected: { nowSeconds: Math.floor(Date.now() / 1000) },
        })
        if (findings.length > 0) throw new Error(findings[0].sentence)
      }
      setPhase({ kind: 'wallet' })
      const hash = await sendTransactionAsync({ to: swap.call.to, data: swap.call.data, value: swap.call.value, chainId: spec.chainId })
      setPhase({ kind: 'confirming', hash })
      const receipt = await clientFor(spec.chainId).waitForTransactionReceipt({ hash })
      // THE FIRST-SWAP CHECK, automated per receipt: FeeCharged must exist —
      // a wrapper that took no fee is a mis-wire worth surfacing, not hiding.
      // A feeless (restricted-token) fill charges none BY DISCLOSURE, so the
      // check stands down there instead of crying wolf.
      let feeBurned = false
      try {
        feeBurned = parseEventLogs({ abi: feeChargedEventAbi, logs: receipt.logs }).length > 0
      } catch {
        feeBurned = false
      }
      setPhase({ kind: 'done', hash, feeBurned, feeless: swap.feeless === true })
      appendExec(address, {
        ts: Date.now(),
        kind: 'swap',
        totalUsd: spec.usdCents / 100,
        changes: [{ symbol: spec.symbol, deltaUsd: spec.usdCents / 100 }],
        simulated: false,
      })
      // the carve is a landing too — the portfolio's bento must greet it the
      // same way a batch does (announce: false; the flow's unmount announces)
      writeRunLanded([`${spec.chainId}:${spec.asset.toLowerCase()}`], [], { announce: false })
      onSettled?.()
      fireTerminal()
    } catch (e) {
      startedRef.current = false // a failure may retry
      setPhase({ kind: 'failed', note: e instanceof Error ? (e.message.split('\n')[0] ?? 'failed') : 'failed' })
      fireTerminal()
    }
  }, [address, publicClient, sendTransactionAsync, switchChainAsync, writeContractAsync, spec, onSettled, fireTerminal])

  // the auto lane: when the queue hands this card its turn, it runs itself —
  // once (startedRef holds the line through re-renders and retries alike)
  useEffect(() => {
    if (autoRun && address && !startedRef.current) void run()
  }, [autoRun, address, run])

  const active = phase.kind !== 'idle' && phase.kind !== 'done' && phase.kind !== 'failed'
  const hash = phase.kind === 'confirming' || phase.kind === 'done' ? phase.hash : phase.kind === 'approving' ? phase.hash : undefined
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="relative flex items-end justify-between gap-3">
        <span className="inline-flex items-center gap-3">
          <ChainBadge chainId={spec.chainId} size="md" />
          <span className="font-display text-2xl font-bold tracking-tight text-ink">${showSymbol(spec.symbol)}</span>
        </span>
        <span className="font-num text-[15px] tabular-nums text-ink-dim">${(spec.usdCents / 100).toLocaleString()}</span>
      </div>
      <p
        className={`relative mt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
          phase.kind === 'done' ? 'text-teal' : phase.kind === 'failed' ? 'text-amber-200/90' : phase.kind === 'idle' ? 'text-ink-faint' : 'text-ink'
        }`}
      >
        {phase.kind === 'idle' && `${autoRun ? 'runs with this plan · ' : ''}its own transaction · +${(WRAPPER_FEE_BPS / 100).toFixed(1)}% fee, 100% burns PRISM`}
        {phase.kind === 'routing' && 'finding its market…'}
        {phase.kind === 'quoting' && 'quoting…'}
        {phase.kind === 'approving' && 'approving…'}
        {phase.kind === 'wallet' && 'check your wallet'}
        {phase.kind === 'confirming' && 'confirming…'}
        {phase.kind === 'done' &&
          (phase.feeless ? 'bought ✓ · direct, no fee (this token’s own rule)' : phase.feeBurned ? 'bought ✓ · fee charged on-chain' : 'bought ✓ · ⚠ no fee event — tell the operator')}
        {phase.kind === 'failed' && phase.note}
        {hash && (
          <a href={`${chainCfg(spec.chainId).explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="ml-2 font-mono text-[11px] normal-case text-cyan hover:underline">
            tx ↗
          </a>
        )}
      </p>
      {routeWords && <p className="relative mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{routeWords}</p>}
      {(phase.kind === 'failed' || (phase.kind === 'idle' && !autoRun)) && (
        <button
          type="button"
          onClick={() => {
            terminalRef.current = false // a retry earns a fresh terminal signal
            void run()
          }}
          className="spectral-btn press relative mt-3 inline-flex h-10 items-center justify-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
        >
          {phase.kind === 'failed' ? 'Try again →' : `Buy $${showSymbol(spec.symbol)} →`}
        </button>
      )}
      {active && <RunBeam accent="var(--color-cyan)" />}
    </div>
  )
}
