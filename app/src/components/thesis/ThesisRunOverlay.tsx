import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import { parseEventLogs, type Address, type Hex } from 'viem'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { thesisNeeds, type Thesis } from '../../lib/spectrum/thesis'
import { thesisRef } from '../../lib/spectrum/thesis-url'
import type { LegFunding, ThesisRun, ThesisRunDirection, ThesisRunStep } from '../../lib/spectrum/thesis-run-types'
import { legFundings, readThesisFunds } from '../../lib/spectrum/thesis-funding'
import {
  composePayFunding,
  firstBuyFloorLine,
  formatAssetCeil,
  readPayBalanceLive,
  thesisPayChoice,
  thesisPayKey,
} from '../../lib/spectrum/thesis-pay-asset'
import { fetchLifiQuote } from '../../lib/spectrum/lifi'
import { nativeEthUsdOnChain } from '../../lib/pools/v4-usd'
import { MIN_FIRST_DEPOSIT_USDC } from '../../lib/spectrum/launch-first-mint'
import {
  activeStep,
  advanceStep,
  buildThesisBuyRun,
  buildThesisSellRun,
  clearThesisRun,
  loadThesisRun,
  retryStep,
  runProgress,
  saveThesisRun,
  setStepAmount,
} from '../../lib/spectrum/thesis-run'
import { thesisSellPlan } from '../../lib/spectrum/thesis-sell'
import { basketHref } from '../../lib/spectrum/short-url'
import { BridgeFund } from '../BridgeFund'
import { useBridgeLeg } from '../../lib/spectrum/use-bridge-leg'
import { useDexSwap } from '../../lib/spectrum/use-dex-swap'
import { useBasketData } from '../../lib/spectrum/hooks'
import { useBasketFees } from '../../lib/spectrum/use-basket-fees'
import { hubPay } from '../../lib/spectrum/pay-token'
import { DEFAULT_SLIPPAGE_BPS } from '../../lib/spectrum/hook-data'
import { bridgeRows, pollBridge, type PendingBridge } from '../../lib/spectrum/bridge-pending'
import { heldPosition, type HeldIndex } from '../../lib/spectrum/held-baskets'
import { clientFor } from '../../lib/chain/rpc'
import { erc20BalanceAbi, swapRouterAbi } from '../../lib/spectrum/abis-v2'
import { useNetworkSwitch, type NetworkSwitch } from '../WrongNetwork'
import { ChainBadge } from '../ChainBadge'
import { Bezel, EASE, Eyebrow } from '../home/Spine'
import { BridgeRunnerGame } from '../allocate/BridgeRunnerGame'
import {
  announceStep,
  centsToUsdcRaw,
  chainLabel,
  demoFundings,
  demoTick,
  deriveLanes,
  describeStep,
  elapsedLabel,
  landedRows,
  laneChainOf,
  payAssetTotal,
  primaryActionLabel,
  rawToCentsFloor,
  runFraction,
  runTotalCents,
  settlementLabel,
  usdCents,
  type Lane,
  type LaneLeg,
  type StepPatch,
} from './run-lanes'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS RUN OVERLAY — the one guided session that buys (or sells) a whole
// thesis, network by network (the owner 2026-08-09: direct route greenlit). One
// lane per network, ONE action offered at a time; everything else on screen is
// state, not choice. Per leg: offer the wallet the chain (never take it) →
// bridge USDC where the chain is short (LI.FI, the proven executor) → wait for
// arrival (bridge-pending's own polling) → buy through the LIVE swapExactIn
// path with every floor and gate intact (use-dex-swap, driven with exactly the
// arguments DexSwapCard passes). Selling mirrors it. No batcher, no batch fee.
//
// NOT ATOMIC, AND SAYS SO. Each network is its own transaction with a couple
// of signatures; the honesty rails state it in the footer, the run persists
// after every transition, and closing the overlay parks the run rather than
// losing it. A run that died mid-signature comes back DEMOTED by the store
// itself (loadThesisRun → failed, "check your wallet's activity before
// retrying"): we cannot know from here whether that transaction landed, so
// the doubt is surfaced as a failure the USER retries, never re-armed.
//
// NO MINIMUM IS PAINTED. shownFloor is passed as null — the documented
// stand-down (shown-floor.ts): a floor gate compares the signed number to a
// number the user READ, and this surface deliberately paints none. The copy
// says "minimum enforced at signing" instead of printing a figure the gate
// would then have to police.
//
// DEMO MODE is the same overlay fed a synthetic run (buildThesisBuyRun with
// demo: true): timers stand in for signatures, the bridge beam lingers long
// enough to be seen, nothing is read, nothing arms. Per the launch-presentation
// ruling (owner 2026-08-10) it wears the real run's face — no chip; only the
// pacing helper under the action button admits the walk. The rendering path is
// IDENTICAL by construction — what the walkthrough shows is what the real run
// looks like.
//
// The model behind the lanes is pure and tested: see run-lanes.ts and
// thesis-run-overlay.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_SIGNER = '0x0000000000000000000000000000000000000000' as Address
/** The walkthrough's stated stake — a number to split, never money. */
const DEMO_AMOUNT_CENTS = 50_000

export type ThesisRunMode = 'buy' | 'sell' | 'demo'

type Stage =
  | { k: 'boot' }
  | { k: 'resume'; saved: ThesisRun }
  | { k: 'sell-setup' }
  | { k: 'prep' }
  | { k: 'refused'; why: string }
  | { k: 'run'; run: ThesisRun }

export function ThesisRunOverlay({
  thesis,
  accent,
  mode,
  amountCents,
  held,
  seedShares,
  onClose,
  onOfferPayAsset,
}: {
  thesis: Thesis
  /** The thesis's signature colour (Thesis.tsx derives it) — the run glows in
   *  the idea's own accent, not a generic one. */
  accent: string
  mode: ThesisRunMode
  /** Buy mode: the user's typed total, integer cents. */
  amountCents?: number
  /** The page's one held-positions read — the sell entry's evidence. */
  held?: HeldIndex
  /** SEED MODE (the ceremonies' "Seed the bundle" door, owner 2026-08-12): a
   *  just-shipped version has ZERO AUM on every leg, which thesisNeeds refuses
   *  by law — live AUM carries no signal there. The ceremony holds the
   *  creator's own deploy weights; this map (chainId → share) hands them to
   *  thesisNeeds as the explicit split. Absent = the live-AUM split, unchanged. */
  seedShares?: ReadonlyMap<number, number>
  onClose: () => void
  /** THE SHORTFALL OFFER (the owner live 2026-08-15: "not revert but just show
   *  the person we can bridge them gas by swapping out of a default asset on
   *  another chain"). When the host owns a pay-asset picker, a planning
   *  refusal for MONEY (not gas-viability) renders a door that closes this
   *  overlay and opens that picker. Absent = the plain refusal, unchanged. */
  onOfferPayAsset?: () => void
}) {
  const direction: ThesisRunDirection = mode === 'sell' ? 'sell' : 'buy'
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const refId = useMemo(() => thesisRef(thesis.name), [thesis.name])
  const legs = useMemo<LaneLeg[]>(
    () => thesis.legs.map((l) => ({ chainId: l.chainId, address: l.address, symbol: l.symbol })),
    [thesis.legs],
  )
  // Registry rows carry addresses as strings; the run builder signs against
  // Address. The cast is the house idiom at this exact boundary (`ix.address
  // as Address`) — these rows came from the factory registry, not user input.
  const runLegs = useMemo(
    () => thesis.legs.map((l) => ({ chainId: l.chainId, address: l.address as Address })),
    [thesis.legs],
  )

  const [stage, setStage] = useState<Stage>({ k: 'boot' })
  const [escArm, setEscArm] = useState(false)
  const [bridgeBusy, setBridgeBusy] = useState(false)
  // ⚠ THE GAME OUTLIVES THE BRIDGE (the owner 2026-08-16: "ensure the bridge runner
  // game doesnt get disrupted if the bridge completes, the person gets notified
  // bridge is done and can end/pause to continue"). The run advances the moment
  // funds land, which would unmount a canvas mid-jump and throw away a score
  // for no reason: the arrival is good news, not an interruption. So the player
  // dismisses it, never the state machine.
  const [gameOpen, setGameOpen] = useState(false)
  const [gameLanded, setGameLanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [announce, setAnnounce] = useState('')
  // The fundings the run was BUILT from — the refuel riders live here, not on
  // the persisted steps. A resumed run has none (stated limitation: its
  // bridges ride without a refuel), so this is a ref, never re-read state.
  const fundingsRef = useRef<LegFunding[] | null>(null)
  // When each awaiting step started, for the in-flight clock. Falls back to
  // the bridge-pending row's own startedAt, then the run's.
  const awaitingSinceRef = useRef<Record<string, number>>({})
  const escArmRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const bridgeLeg = useBridgeLeg()

  const run = stage.k === 'run' ? stage.run : null
  const finished = run ? runProgress(run).finished : false
  // The sequencer's own linear cursor: first non-terminal step; failed steps
  // hold it (retry is the only exit), awaiting bridges hold it by design.
  const primary = run && !finished ? activeStep(run) : null
  // ⚠ OPEN ON THE WAIT, CLOSE ONLY ON THE PLAYER'S WORD. The run advances the
  // instant funds land, so keying the canvas straight off the step would unmount
  // it mid-jump; the arrival is good news and must not read as a crash.
  const waitingOnBridge = primary?.kind === 'await-bridge'
  const gameOpenRef = useRef(false)
  gameOpenRef.current = gameOpen
  useEffect(() => {
    if (waitingOnBridge) {
      setGameOpen(true)
      setGameLanded(false)
      return
    }
    setGameLanded((was) => was || gameOpenRef.current)
  }, [waitingOnBridge])
  // Where the NEXT signature happens: bridges AND conversions sign on their
  // source chain (a conversion sells where the pay asset lives).
  const signsOn = primary
    ? primary.kind === 'bridge' || primary.kind === 'consolidate' || primary.kind === 'convert'
      ? (primary.bridgeFromChainId ?? primary.chainId)
      : primary.chainId
    : (thesis.legs[0]?.chainId ?? 8453)
  const sw = useNetworkSwitch(signsOn)
  // The console's pay-source choice rides the leg-set-keyed session store —
  // the page that mounts both surfaces stays untouched. Read at PLAN time
  // only (prepBuy); demo and sell paths never consult it.
  const payKey = useMemo(() => thesisPayKey(thesis.legs.map((l) => ({ chainId: l.chainId, address: l.address }))), [thesis.legs])

  // ── one state transition, persisted (real runs) after every change ─────────
  // The reducers return the SAME reference on a refused/no-op call, so an
  // unchanged run writes nothing and re-renders nothing.
  const mutateRun = useCallback((fn: (r: ThesisRun) => ThesisRun) => {
    setStage((s) => {
      if (s.k !== 'run') return s
      const next = fn(s.run)
      if (next === s.run) return s
      if (!next.demo) saveThesisRun(next)
      return { k: 'run', run: next }
    })
  }, [])

  const apply = useCallback(
    (patches: [string, StepPatch][]) =>
      mutateRun((r) => patches.reduce((acc, [id, p]) => advanceStep(acc, id, p), r)),
    [mutateRun],
  )

  const doRetry = useCallback(
    (stepId: string) => {
      bridgeLeg.reset()
      setStage((s) => {
        if (s.k !== 'run') return s
        const next = retryStep(s.run, stepId)
        if (!next.demo) saveThesisRun(next)
        return { k: 'run', run: next }
      })
    },
    [bridgeLeg],
  )

  // ── entry: resume offer → sell setup → funds read → run ────────────────────
  function prepBuy(signer: Address) {
    setStage({ k: 'prep' })
    void (async () => {
      try {
        const cents = amountCents ?? 0
        if (!Number.isFinite(cents) || cents <= 0) {
          setStage({ k: 'refused', why: 'Put in an amount first — the run needs to know how much to split.' })
          return
        }
        // feeBps 0: the direct route charges NO batching fee — funding needs
        // are the buys alone (the batch fee is a batcher-contract field, and
        // no batcher is involved here).
        const needs = thesisNeeds(thesis, cents / 100, 0, seedShares)
        if (!needs || needs.length === 0) {
          setStage({
            k: 'refused',
            why: 'The creator’s split cannot be read right now, and dividing your money evenly would invent their intent — nothing was started. Try again in a moment.',
          })
          return
        }
        // THE DONOR-CHAIN FIX (the owner live 2026-08-14, TESTV3: "$500 across 2
        // networks / no other network holds enough" while his cash sat on
        // Base): the read covered only the bundle's own chains, so money on
        // any OTHER supported chain was invisible to pickSource — the
        // one-bridge-per-leg planner was blinkered by its caller, not by its
        // own math. Read the UNION of the bundle's chains and every supported
        // chain; a donor chain with no leg of its own donates through the
        // planner's existing surplus walk.
        const funds = await readThesisFunds([...new Set([...thesis.chainIds, ...SUPPORTED_CHAIN_IDS])], signer)
        // THE PAY-ASSET BRANCH (the owner 2026-08-13, ruling his own 2026-08-11
        // question): a non-settlement choice covers each leg's shortfall by
        // SELLING that asset via the same LI.FI executor bridges ride, quoted
        // now for the plan and re-quoted fresh at each signature. null — the
        // default — is today's settlement path, byte for byte. prepBuy only
        // ever runs REAL buys, so the walkthrough can never reach a quote.
        const pay = thesisPayChoice(payKey)
        const fundings =
          pay == null
            ? legFundings(needs, funds)
            : (
                await composePayFunding({
                  needs,
                  funds,
                  pay,
                  holder: signer,
                  quote: fetchLifiQuote,
                  nativeUsd: nativeEthUsdOnChain,
                  readBalance: readPayBalanceLive,
                })
              ).legs
        fundingsRef.current = fundings
        const built = buildThesisBuyRun({
          ref: refId,
          deployer: thesis.deployer,
          signer,
          amountCents: cents,
          legs: runLegs,
          fundings,
          demo: false,
        })
        if ('refused' in built) setStage({ k: 'refused', why: built.refused })
        else {
          saveThesisRun(built)
          setStage({ k: 'run', run: built })
        }
      } catch (e) {
        setStage({ k: 'refused', why: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  function startDemo() {
    const needs = thesisNeeds(thesis, DEMO_AMOUNT_CENTS / 100, 0, seedShares)
    if (!needs || needs.length === 0) {
      setStage({ k: 'refused', why: 'This demo bundle has no readable split to walk through.' })
      return
    }
    const built = buildThesisBuyRun({
      ref: refId,
      deployer: thesis.deployer,
      signer: DEMO_SIGNER,
      amountCents: DEMO_AMOUNT_CENTS,
      legs: runLegs,
      fundings: demoFundings(needs, needs[0].chainId),
      demo: true,
    })
    if ('refused' in built) setStage({ k: 'refused', why: built.refused })
    // never persisted — a walkthrough is not a resumable money state
    else setStage({ k: 'run', run: built })
  }

  function startSell(signer: Address, fraction: number, consolidateTo: number | null) {
    setStage({ k: 'prep' })
    void (async () => {
      try {
        // The plan wants RAW balances (float-multiplying an 18dp balance is a
        // wrong trade — thesis-sell's own header), and the page's held index
        // carries floats. So the sell reads each leg's balanceOf fresh, per
        // chain: exact, and it also catches a position the index has not
        // caught up to yet.
        let unreadable = 0
        const heldRows = (
          await Promise.all(
            thesis.legs.map(async (l) => {
              try {
                const balanceRaw = (await clientFor(l.chainId).readContract({
                  address: l.address as Address,
                  abi: erc20BalanceAbi,
                  functionName: 'balanceOf',
                  args: [signer],
                })) as bigint
                return { chainId: l.chainId, address: l.address, balanceRaw }
              } catch {
                unreadable++
                return null // an unreadable chain sells nothing — stated below if it mattered
              }
            }),
          )
        ).filter((h): h is { chainId: number; address: string; balanceRaw: bigint } => h != null)

        const plan = thesisSellPlan({
          // Basket tokens in this kit are 18dp ERC-20s by construction;
          // decimals here only shapes the DISPLAY estimate (estCents) — the
          // signed amount is pure raw bigint math in the plan itself.
          legs: thesis.legs.map((l) => ({
            chainId: l.chainId,
            address: l.address as Address,
            decimals: 18,
            navPerToken: Number.isFinite(l.navPerToken) && l.navPerToken > 0 ? l.navPerToken : null,
          })),
          held: heldRows,
          fraction,
          consolidateTo,
        })
        if (!plan || plan.steps.length === 0) {
          setStage({
            k: 'refused',
            why:
              unreadable > 0
                ? `Nothing sellable could be verified — ${unreadable} ${unreadable === 1 ? 'network' : 'networks'} did not answer the balance read, so nothing was planned for ${unreadable === 1 ? 'it' : 'them'}. Try again in a moment.`
                : 'Nothing sellable was found for this wallet across the bundle. If you only just bought, the reads may still be catching up — try again in a moment.',
          })
          return
        }
        const built = buildThesisSellRun({ ref: refId, deployer: thesis.deployer, signer, plan, legs: runLegs, demo: false })
        if ('refused' in built) setStage({ k: 'refused', why: built.refused })
        else {
          saveThesisRun(built)
          setStage({ k: 'run', run: built })
        }
      } catch (e) {
        setStage({ k: 'refused', why: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    if (mode === 'demo') {
      startedRef.current = true
      startDemo()
      return
    }
    if (!address) return // the render below offers Connect; this re-runs when it lands
    startedRef.current = true
    // loadThesisRun has already applied the money-law demotion (mid-signature
    // steps come back 'failed' with its honest note), so the saved run is
    // offered exactly as the store vouches for it.
    const saved = loadThesisRun(address, refId, direction)
    if (saved && !runProgress(saved).finished) setStage({ k: 'resume', saved })
    else if (mode === 'sell') setStage({ k: 'sell-setup' })
    else prepBuy(address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, address])

  // ── drivers ─────────────────────────────────────────────────────────────────

  // The demo's metronome: pure demoTick decides the transition AND the hold, so
  // the pacing is tested; this effect only owns the setTimeout.
  useEffect(() => {
    if (!run || !run.demo) return
    const tick = demoTick(run)
    if (!tick) return
    const t = window.setTimeout(() => apply(tick.patches), tick.delayMs)
    return () => window.clearTimeout(t)
  }, [run, apply])

  // A switch step is DONE the moment the wallet is observed on the chain — the
  // wallet's own state is the truth, never the switch call resolving (the
  // optimistic-switch lesson). Works for "already there" too.
  useEffect(() => {
    if (!run || run.demo || !primary || primary.kind !== 'switch') return
    if (isConnected && walletChainId === primary.chainId) apply([[primary.id, { state: 'done' }]])
  }, [run, primary, isConnected, walletChainId, apply])

  // A consolidate whose amount was never measured resolves to FAILED with the
  // honest note — bridging a guessed amount is not an option (it would strand
  // or invent), and runtime transitions into 'skipped' are illegal by the
  // sequencer's own law (skipped is a plan-time verdict). The note says
  // plainly that a retry cannot re-measure and that nothing is stuck.
  useEffect(() => {
    if (!run || run.demo || !primary || primary.kind !== 'consolidate') return
    if (primary.state !== 'queued' && primary.state !== 'active') return
    if (primary.amountCents != null && primary.amountCents > 0) return
    const from = primary.bridgeFromChainId ?? primary.chainId
    apply([
      [
        primary.id,
        {
          state: 'failed',
          note: `Nothing measured to bridge home from ${chainLabel(from)} — the sale's proceeds are already safe in your wallet there as ${settlementLabel(from)}, and this step cannot re-measure them. Nothing is stuck; you can close.`,
        },
      ],
    ])
  }, [run, primary, apply])

  // Awaiting bridges: join bridge-pending by txHash (12s tick, the BridgeFund
  // pattern). A run resumed after a reload re-joins here with nothing lost; a
  // row missing from local storage is reconstructed from the step itself.
  const awaitingKey = run && !run.demo
    ? run.steps
        .filter((s) => s.state === 'awaiting' && s.bridgeTxHash)
        .map((s) => `${s.id}:${s.bridgeTxHash}`)
        .join('|')
    : ''
  useEffect(() => {
    if (!awaitingKey || !run) return
    const waiting = run.steps.filter((s) => s.state === 'awaiting' && s.bridgeTxHash)
    const ctrl = new AbortController()
    const settle = (s: ThesisRunStep, status: { state: string; toAmount?: bigint; reason?: string }) => {
      if (status.state === 'done') {
        const cents = status.toAmount != null ? rawToCentsFloor(status.toAmount) : 0
        apply([[s.id, { state: 'done', note: cents > 0 ? `${usdCents(cents)} arrived` : 'arrived' }]])
      } else if (status.state === 'failed') {
        apply([[s.id, { state: 'failed', note: status.reason ?? 'The transfer failed.' }]])
      } else if (status.state === 'refunded') {
        apply([
          [s.id, { state: 'failed', note: 'The bridge refunded on the source network — your funds stayed where they were. Retry when ready.' }],
        ])
      }
      // 'pending' / 'unknown' change nothing — the next tick retries; an
      // unreachable status service is never a verdict (bridge-pending's law).
    }
    const poll = async (s: ThesisRunStep) => {
      const hash = s.bridgeTxHash as Hex
      const existing = bridgeRows().find((r) => r.txHash.toLowerCase() === hash.toLowerCase())
      if (existing?.resolved) {
        settle(
          s,
          existing.resolved.state === 'done'
            ? { state: 'done', toAmount: existing.resolved.toAmount }
            : existing.resolved.state === 'failed'
              ? { state: 'failed', reason: existing.resolved.reason }
              : { state: 'refunded' },
        )
        return
      }
      const from =
        s.bridgeFromChainId ??
        run.steps.find((x) => (x.kind === 'bridge' || x.kind === 'convert') && x.chainId === s.chainId)?.bridgeFromChainId ??
        s.chainId
      // A reconstruction (localStorage lost the row) states what was actually
      // SENT: for a conversion that is the pay asset, not settlement.
      const convertSibling = run.steps.find((x) => x.kind === 'convert' && x.chainId === s.chainId)
      const row: PendingBridge = existing ?? {
        txHash: hash,
        fromChainId: from,
        toChainId: s.chainId,
        holder: run.signer,
        fromSymbol: convertSibling?.paySymbol ?? settlementLabel(from),
        fromAmountRaw: convertSibling?.payAmountRaw ?? centsToUsdcRaw(s.amountCents ?? 0),
        fromDecimals: convertSibling?.payDecimals ?? 6,
        quotedToAmountRaw: 0n,
        startedAt: awaitingSinceRef.current[s.id] ?? run.startedAt,
      }
      try {
        settle(s, await pollBridge(row, ctrl.signal))
      } catch {
        /* status service unreachable — the next tick retries */
      }
    }
    const tick = () => {
      for (const s of waiting) void poll(s)
    }
    tick()
    const t = window.setInterval(tick, 12_000)
    return () => {
      ctrl.abort()
      window.clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingKey])

  // The in-flight clock (15s is plenty for a minutes-scale label).
  useEffect(() => {
    if (!run || !run.steps.some((s) => s.state === 'awaiting')) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [run])

  // Step transitions read aloud (aria-live=polite below).
  useEffect(() => {
    if (!run) return
    if (finished) setAnnounce(direction === 'buy' ? 'The buy is complete.' : 'The sale is complete.')
    else if (primary) setAnnounce(announceStep(primary))
  }, [run, primary, finished, direction])

  // ── actions ─────────────────────────────────────────────────────────────────

  async function handleBridge(step: ThesisRunStep) {
    if (!address || bridgeBusy || !run) return
    setBridgeBusy(true)
    apply([[step.id, { state: 'signing' }]])
    try {
      const from = step.bridgeFromChainId ?? step.chainId

      // A CONVERSION: sell the plan's pay asset into this leg's settlement —
      // the SAME executor as every bridge (quoteAndSendToken: fresh quote,
      // exact approval, verbatim send, pending row). No refuel can ride it
      // (the executor's own settlement-anchor law); the plan already refused
      // any leg that needed one.
      if (step.kind === 'convert') {
        if (
          step.payTokenAddress == null ||
          step.paySymbol == null ||
          step.payDecimals == null ||
          step.payAmountRaw == null ||
          step.payAmountRaw <= 0n
        ) {
          apply([[step.id, { state: 'failed', note: 'The saved run does not carry this conversion’s amounts, so nothing can be signed for it. Close and start over.' }]])
          return
        }
        const res = await bridgeLeg.quoteAndSendToken({
          fromChainId: from,
          toChainId: step.chainId,
          fromToken: { address: step.payTokenAddress, symbol: step.paySymbol, decimals: step.payDecimals },
          amountRaw: step.payAmountRaw,
          holder: address,
        })
        if ('error' in res) {
          bridgeLeg.reset()
          apply([[step.id, { state: 'failed', note: res.error }]])
          return
        }
        if (from === step.chainId) {
          // Same-chain sale: it settles in its own transaction (lifi.ts), so
          // this step holds the linear cursor as 'confirming' until the
          // receipt lands — the buy behind it spends the proceeds.
          apply([[step.id, { state: 'confirming', bridgeTxHash: res.txHash }]])
          try {
            const receipt = await clientFor(from).waitForTransactionReceipt({ hash: res.txHash })
            if (receipt.status === 'success') {
              apply([[step.id, { state: 'done' }]])
            } else {
              apply([[step.id, { state: 'failed', note: `The conversion reverted on ${chainLabel(from)} — nothing was sold. You can retry.` }]])
            }
          } catch {
            // The chain may still confirm it — never declare a live sale dead,
            // and never let a retry silently re-sell (the hash is kept).
            apply([[step.id, { state: 'failed', note: `Could not confirm the conversion on ${chainLabel(from)} — check your wallet’s activity before retrying.` }]])
          }
        } else {
          const arrivalId = run.steps.find((x) => x.kind === 'await-bridge' && x.chainId === step.chainId)?.id ?? null
          awaitingSinceRef.current[arrivalId ?? step.id] = Date.now()
          const patches: [string, StepPatch][] = [[step.id, { state: 'done', bridgeTxHash: res.txHash }]]
          if (arrivalId) patches.push([arrivalId, { state: 'awaiting', bridgeTxHash: res.txHash }])
          apply(patches)
        }
        return
      }

      // Smart gas routing from day 1: the refuel rider computed at plan time
      // travels with the quote so the destination lands WITH gas. A resumed
      // run no longer holds the plan → rides without one (stated limitation).
      const refuel =
        step.kind === 'bridge' ? (fundingsRef.current?.find((f) => f.chainId === step.chainId)?.bridge?.refuelWeiNeeded ?? null) : null
      const res = await bridgeLeg.quoteAndSend({
        fromChainId: from,
        toChainId: step.chainId,
        amountRaw: centsToUsdcRaw(step.amountCents ?? 0),
        holder: address,
        ...(refuel != null && refuel > 0n ? { refuelWeiNeeded: refuel } : {}),
      })
      if ('txHash' in res) {
        const arrivalId = step.kind === 'bridge' ? run.steps.find((x) => x.kind === 'await-bridge' && x.chainId === step.chainId)?.id : null
        awaitingSinceRef.current[arrivalId ?? step.id] = Date.now()
        const patches: [string, StepPatch][] =
          step.kind === 'bridge'
            ? [[step.id, { state: 'done', bridgeTxHash: res.txHash }]]
            : [[step.id, { state: 'awaiting', bridgeTxHash: res.txHash }]]
        if (arrivalId) patches.push([arrivalId, { state: 'awaiting', bridgeTxHash: res.txHash }])
        apply(patches)
      } else {
        bridgeLeg.reset()
        apply([[step.id, { state: 'failed', note: res.error }]])
      }
    } catch (e) {
      bridgeLeg.reset()
      apply([[step.id, { state: 'failed', note: e instanceof Error ? e.message : String(e) }]])
    } finally {
      setBridgeBusy(false)
    }
  }

  function handleTradePhase(step: ThesisRunStep, phase: 'signing' | 'confirming') {
    apply([[step.id, { state: phase }]])
  }

  function handleTradeFail(step: ThesisRunStep, message: string) {
    apply([[step.id, { state: 'failed', note: message }]])
  }

  function handleTradeDone(step: ThesisRunStep, hash: Hex) {
    if (step.kind === 'sell') {
      void sellLanded(step, hash)
      return
    }
    apply([[step.id, { state: 'done', note: step.amountCents != null ? `${usdCents(step.amountCents)} in` : null }]])
  }

  /** A sell landed: read what it ACTUALLY realised from the receipt's own
   *  Swapped event (never a balance diff — the lagging-RPC lesson) and feed
   *  the measured cents to this chain's consolidate step via setStepAmount —
   *  the sequencer's one late-bound money field — which is what makes "bring
   *  the money home" bridge a real number instead of a guess. */
  async function sellLanded(step: ThesisRunStep, hash: Hex) {
    const consolidate = run?.steps.find((x) => x.kind === 'consolidate' && x.bridgeFromChainId === step.chainId) ?? null
    // The executor already awaited confirmation, so the receipt exists — but
    // one lagging read node must not lose the measurement: three patient tries.
    let outCents: number | null = null
    for (let attempt = 0; attempt < 3 && outCents == null; attempt++) {
      try {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
        const receipt = await clientFor(step.chainId).getTransactionReceipt({ hash })
        const swapped = parseEventLogs({ abi: swapRouterAbi, logs: receipt.logs }).find((l) => l.eventName === 'Swapped')
        const out = (swapped?.args as { amountOut?: bigint } | undefined)?.amountOut
        if (out != null && out > 0n) outCents = rawToCentsFloor(out)
        else break // a receipt with no Swapped event will not grow one — stop
      } catch {
        /* lagging read — retry */
      }
    }
    mutateRun((r) => {
      let next = advanceStep(r, step.id, { state: 'done', note: outCents != null ? `${usdCents(outCents)} out` : 'sold' })
      if (consolidate) {
        if (outCents != null && outCents > 0) {
          next = setStepAmount(next, consolidate.id, (consolidate.amountCents ?? 0) + outCents)
        } else {
          // Measured nothing (or under a cent): the consolidate resolves NOW
          // with the honest sentence instead of dangling until it activates.
          next = advanceStep(next, consolidate.id, {
            state: 'failed',
            note: `Could not measure what this sale landed on ${chainLabel(step.chainId)}, so nothing will be bridged home from there — your ${settlementLabel(step.chainId)} is already safe in your wallet on that network.`,
          })
        }
      }
      return next
    })
  }

  function demoKick() {
    if (!run || !run.demo) return
    const tick = demoTick(run)
    if (tick) apply(tick.patches)
  }

  function finishAndClose() {
    if (run && !run.demo) clearThesisRun(run.signer, run.ref, run.direction)
    onClose()
  }

  // ── shell behaviour: esc (confirm while signing), focus trap, scroll lock ──
  // The guard covers every state a person plausibly abandons MID-MONEY (audit
  // 2026-08-16): 'signing' (a prompt may be open), 'awaiting' (a bridge is in
  // flight), and a failed step on an unfinished run (money partway). The old
  // signing-only guard let ✕ close those silently, with no word that the run
  // persists or where the un-spent money sits — the note below says both.
  const signingNow =
    !!run &&
    !run.demo &&
    (run.steps.some((s) => s.state === 'signing' || s.state === 'awaiting') ||
      (run.steps.some((s) => s.state === 'failed') && !runProgress(run).finished))
  const requestClose = useCallback(() => {
    if (signingNow && !escArmRef.current) {
      escArmRef.current = true
      setEscArm(true)
      window.setTimeout(() => {
        escArmRef.current = false
        setEscArm(false)
      }, 5000)
      return
    }
    onClose()
  }, [signingNow, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const prevFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = prev
      prevFocus?.focus?.()
    }
  }, [])

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (!root) return
    const focusables = [...root.querySelectorAll<HTMLElement>('button, [href], select, input, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute('disabled'),
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const current = document.activeElement
    if (e.shiftKey && (current === first || current === root)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && current === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const sinceOf = (step: ThesisRunStep): number => {
    const local = awaitingSinceRef.current[step.id]
    if (local) return local
    if (step.bridgeTxHash) {
      const row = bridgeRows().find((r) => r.txHash.toLowerCase() === step.bridgeTxHash!.toLowerCase())
      if (row) return row.startedAt
    }
    return run?.startedAt ?? Date.now()
  }

  // ── render ──────────────────────────────────────────────────────────────────
  // LAUNCH PRESENTATION (owner 2026-08-10): the demo walkthrough wears the
  // real run's face — same eyebrow, no chip, the real footer. Safe because
  // the guard is in the MACHINE: demo legs cannot arm (builder + load
  // refusals) and the fixture module cannot exist in a production bundle.
  const eyebrowText = mode === 'sell' ? 'selling the whole bundle' : 'buying the whole bundle'
  const lanes: Lane[] = run ? deriveLanes(run, legs) : []
  const totalCents = run ? runTotalCents(run) : mode === 'buy' ? (amountCents ?? null) : null
  const fraction = run ? runFraction(run) : 0
  // What the run pays in the chosen asset, beside the USD anchor — the sum of
  // the plan's quoted sale sizings, ≈-marked (run-lanes.payAssetTotal).
  const payTotal = run ? payAssetTotal(run) : null
  // FIRST-BUY FLOOR AWARENESS (display honesty — the refusal ruling stays
  // the owner's; the CONTRACT already reverts under MIN_FIRST_DEPOSIT on a
  // zero-supply basket, launch-first-mint.ts). seedShares present = every leg
  // just shipped empty, so each leg's share is checked against the floor and
  // said OUT LOUD before anything is signed, with the smallest total that
  // clears it. The allocator is thesisNeeds itself — the split law lives in
  // exactly one place.
  const runAmountCents = run?.amountCents ?? 0
  const floorLine = useMemo(() => {
    if (!seedShares || !run || run.direction !== 'buy' || runAmountCents <= 0) return null
    const needsNow = thesisNeeds(thesis, runAmountCents / 100, 0, seedShares)
    if (!needsNow || needsNow.length === 0) return null
    return firstBuyFloorLine(needsNow, (cents) => thesisNeeds(thesis, cents / 100, 0, seedShares), MIN_FIRST_DEPOSIT_USDC * 100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedShares, runAmountCents, run?.direction, thesis])
  const floorWords = useMemo(() => {
    if (!floorLine) return null
    const legsSaid = floorLine.under.map((u) => `${chainLabel(u.chainId)}’s leg lands at ${usdCents(u.buysCents)}`).join(' · ')
    const raise = floorLine.raiseToCents != null ? `; raise the amount to at least $${Math.ceil(floorLine.raiseToCents / 100)}` : ''
    return `${legsSaid} — under the $${MIN_FIRST_DEPOSIT_USDC} first-buy minimum a brand-new basket enforces at signing${raise}.`
  }, [floorLine])

  const connectChip = (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('spectrum:connect'))}
        className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
      >
        Connect wallet to continue
      </button>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">connecting signs nothing</p>
    </div>
  )

  function actionArea() {
    if (!run || finished) return null
    if (run.demo) {
      return (
        <div className="mt-6">
          <button
            type="button"
            onClick={demoKick}
            className="press inline-flex h-12 w-full items-center justify-center rounded-xl border px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink"
            style={{ borderColor: `${accent}59`, background: `${accent}14` }}
          >
            {primaryActionLabel(primary) ?? 'Watching the bridge…'}
          </button>
          <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            the walkthrough advances by itself — tap to move it along
          </p>
        </div>
      )
    }
    if (!isConnected || !address) return connectChip
    if (!primary) return null
    return (
      <div className="mt-6">
        {gameOpen && (
          /* ⚠ MOUNTED FROM STATE, NOT FROM THE CURRENT STEP — that is the whole
             point. Keying it to `await-bridge` unmounted the canvas the instant
             funds landed, wiping a run mid-jump. It opens when a wait begins and
             closes only when the player says so; the arrival becomes a banner
             on top of a still-playable game. */
          <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            {gameLanded && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal/30 bg-teal/[0.06] px-3 py-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-teal">funds landed · the run carried on</span>
                <button
                  type="button"
                  onClick={() => {
                    setGameOpen(false)
                    setGameLanded(false)
                  }}
                  className="press rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-teal/60 hover:text-teal"
                >
                  finish up
                </button>
              </div>
            )}
            <BridgeRunnerGame />
          </div>
        )}
        {primary.state === 'failed' ? (
          <button
            type="button"
            onClick={() => doRetry(primary.id)}
            className="press inline-flex h-12 w-full items-center justify-center rounded-xl border border-amber-400/40 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-amber-200 hover:bg-amber-400/10"
          >
            Retry — {describeStep(primary)} on {chainLabel(laneChainOf(primary))}
          </button>
        ) : primary.kind === 'switch' ? (
          <SwitchOffer sw={sw} chainId={primary.chainId} why="switching networks signs nothing" />
        ) : primary.kind === 'await-bridge' ? (
          /* THE WAIT GETS SOMETHING TO DO (the owner 2026-08-16: "show a cool
             animation whilst bridging on baskets happens so it feels like a
             fun way to pass the time"). The portfolio lane already has one, so
             this mounts THAT component rather than growing a second: same game,
             same behaviour, one place to change it. Copy balanced over two
             lines with no em dash, per the house rule. */
          <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="flex min-h-12 items-center justify-center gap-3">
              <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: accent }} />
              <span className="min-w-0 text-center font-mono text-[11px] leading-relaxed text-ink-dim">
                Funds in flight to {chainLabel(primary.chainId)} · {elapsedLabel(sinceOf(primary), now)}
                <br />
                Bridges usually land in seconds. Nothing for you to do here.
              </span>
            </div>
          </div>
        ) : primary.kind === 'bridge' || primary.kind === 'consolidate' || primary.kind === 'convert' ? (
          walletChainId !== signsOn ? (
            <SwitchOffer
              sw={sw}
              chainId={signsOn}
              why={`this ${primary.kind === 'convert' ? 'conversion' : 'bridge'} signs on ${chainLabel(signsOn)}`}
            />
          ) : (
            (() => {
              const label = primaryActionLabel(primary)
              if (!label) return null // unmeasured consolidate — the skip effect handles it
              const busy = bridgeBusy || primary.state === 'signing' || primary.state === 'confirming'
              return (
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBridge(primary)}
                    className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? (primary.state === 'confirming' ? 'Confirming…' : 'In your wallet…') : label}
                  </button>
                  <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                    {primary.kind === 'convert'
                      ? `a signature or two · quoted fresh at signing · lands as ${settlementLabel(primary.chainId)} in your own wallet`
                      : `one transaction · lands as ${settlementLabel(primary.chainId)} in your own wallet`}
                  </p>
                </div>
              )
            })()
          )
        ) : walletChainId !== primary.chainId ? (
          <SwitchOffer sw={sw} chainId={primary.chainId} why={`this leg signs on ${chainLabel(primary.chainId)}`} />
        ) : (
          <div>
            {/* LI.FI gives no verifiable refuel echo (use-bridge-leg's stated
                consumer obligation), so when this leg's gas RODE THE BRIDGE the
                destination balance is verified before the buy is offered as
                ready — a zero balance gets the honest wait note, not a button
                that fails on gas. */}
            {primary.kind === 'buy' &&
              ((fundingsRef.current?.find((f) => f.chainId === primary.chainId)?.bridge?.refuelWeiNeeded ?? 0n) > 0n) && (
                <RefuelGasNote chainId={primary.chainId} holder={address} />
              )}
            <LegTradeExecutor
              key={`${primary.id}:${primary.legAddress ?? ''}`}
              step={primary}
              onPhase={(p) => handleTradePhase(primary, p)}
              onDone={(h) => handleTradeDone(primary, h)}
              onFail={(m) => handleTradeFail(primary, m)}
            />
          </div>
        )}
      </div>
    )
  }

  const body = (() => {
    switch (stage.k) {
      case 'boot':
      case 'prep':
        return (
          <div className="mt-8 space-y-3">
            {thesis.legs.map((l) => (
              <div key={`${l.chainId}:${l.address}`} className="h-16 animate-pulse rounded-xl border border-white/5 bg-white/[0.02] motion-reduce:animate-none" />
            ))}
            <p className="pt-2 text-center font-mono text-[11px] text-ink-dim">
              {stage.k === 'prep'
                ? `Reading your balances across ${thesis.legs.length} ${thesis.legs.length === 1 ? 'network' : 'networks'}…`
                : mode !== 'demo' && !address
                  ? 'Waiting for a wallet…'
                  : 'Setting up…'}
            </p>
            {mode !== 'demo' && !address && connectChip}
          </div>
        )
      case 'refused':
        return (
          <div className="mt-8">
            <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-4 font-mono text-[11px] leading-relaxed text-amber-200/90">
              {stage.why}
            </div>
            {/* every sentence that lands here is pre-send and mostly transient
                ("try again in a moment", an RPC blip, reads catching up), so
                the remedy it names is a BUTTON now (audit 2026-08-16: the only
                control was Close, making the named remedy homework — close,
                re-open, re-arm). Demo never retries; no address falls through
                to Close (the setup face owns the connect chip). */}
            {mode !== 'demo' && address && (
              <button
                type="button"
                onClick={() => {
                  if (mode === 'sell') setStage({ k: 'sell-setup' })
                  else prepBuy(address)
                }}
                className="spectral-btn press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
              >
                Try again →
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="press mt-2 inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              Close
            </button>
          </div>
        )
      case 'resume':
        return (
          <div className="mt-8 rounded-2xl border border-white/12 bg-white/[0.03] p-6">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">a run is already underway</div>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">
              You started {direction === 'buy' ? `buying ${usdCents(stage.saved.amountCents)} of this bundle` : 'selling this bundle'} and got
              partway. Resuming keeps everything already done; starting over abandons the record of it.
            </p>
            <div className="mt-4 h-[3px] overflow-hidden rounded-full bg-white/8">
              <div className="h-full rounded-full" style={{ width: `${Math.round(runFraction(stage.saved) * 100)}%`, background: accent }} />
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => setStage({ k: 'run', run: stage.saved })}
                className="spectral-btn press inline-flex h-12 flex-1 items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
              >
                Resume where you left off
              </button>
              <button
                type="button"
                onClick={() => {
                  clearThesisRun(stage.saved.signer, stage.saved.ref, stage.saved.direction)
                  if (mode === 'sell') setStage({ k: 'sell-setup' })
                  else if (address) prepBuy(address)
                }}
                className="press inline-flex h-12 flex-1 items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
              >
                Start over
              </button>
            </div>
          </div>
        )
      case 'sell-setup':
        return (
          <SellSetup
            thesis={thesis}
            held={held}
            onStart={(fractionPart, home) => {
              if (address) startSell(address, fractionPart, home)
            }}
          />
        )
      case 'run': {
        if (finished && run) {
          // An all-skipped run is finished-with-nothing-to-do (0/0) by the
          // sequencer's own definition — it gets the refusals, per network,
          // never a success plate over zero transactions.
          const rows = landedRows(run, legs)
          if (rows.every((r) => !r.ok)) {
            // ── A FUNDING SHORTFALL THE PAY DOOR CAN COVER IS A QUESTION, NOT
            // AN ERROR (owner 2026-08-15: "it shouldnt throw an error about
            // nothing ran if its asking you to choose how you want to fund the
            // leg — a small question to start things off"). The amber wall only
            // remains for refusals the picker cannot answer. ──
            // STRUCTURED FIRST (the prose-keyed-matcher root fix): the code cannot
            // drift when copy is edited; the phrase fallback keeps runs
            // persisted before codes existed working.
            const fundable = !!onOfferPayAsset && rows.some((r) => r.noteCode === 'needs-funds' || /Needs \$/.test(r.words))
            if (fundable) {
              return (
                <div className="mt-8">
                  <div className="rounded-2xl border border-white/12 bg-white/[0.03] px-5 py-6 text-center">
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">one thing first</div>
                    <p className="mx-auto mt-2 max-w-[44ch] font-display text-xl font-bold tracking-tight text-ink">
                      How do you want to fund this?
                    </p>
                    <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-relaxed text-ink-dim">
                      Pick another asset you hold and the run sells and moves it for you.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        finishAndClose()
                        onOfferPayAsset()
                      }}
                      className="spectral-btn press mt-4 inline-flex h-12 items-center justify-center rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void"
                    >
                      Pay from another asset →
                    </button>
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                      {rows.map((r) => {
                        const m = r.words.match(/Needs (\$[\d,.]+) more on (\w[\w ]*?);/)
                        return (
                          <span key={r.chainId} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-ink-faint">
                            <ChainBadge chainId={r.chainId} size="sm" />
                            {m ? `short ${m[1]}` : 'short'}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={finishAndClose}
                    className="press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
                  >
                    Close
                  </button>
                </div>
              )
            }
            return (
              <div className="mt-8">
                <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">nothing ran</div>
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-amber-200/90">
                    Every leg was refused at planning, so no transaction was ever offered. The reasons, per network:
                  </p>
                </div>
                <div className="mt-3 space-y-2">
                  {rows.map((r) => (
                    <div key={r.chainId} className="rounded-xl border border-white/8 bg-black/20 px-3.5 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <ChainBadge chainId={r.chainId} size="md" />
                        <span className="min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-ink-dim">{r.words}</span>
                      </div>
                      {/* the buy-on-its-page escape rides every refused row —
                          a per-leg remedy the wall used to state and not offer */}
                      {r.legAddress != null && r.legSymbol != null && (
                        <div className="mt-2">
                          <Link
                            to={basketHref({ chainId: r.chainId, address: r.legAddress, symbol: r.legSymbol })}
                            className="press inline-flex min-h-[36px] items-center rounded-lg border border-white/15 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                          >
                            Buy this leg on its page →
                          </Link>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={finishAndClose}
                  className="press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  Close
                </button>
              </div>
            )
          }
          return (
            <SuccessPlate
              run={run}
              legs={legs}
              accent={accent}
              thesisName={thesis.name}
              demo={run.demo}
              onDone={finishAndClose}
              onOfferPayAsset={onOfferPayAsset}
            />
          )
        }
        return (
          <>
            <div className="mt-8 space-y-3">
              {floorWords && (
                <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">first-buy minimum</div>
                  <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-amber-200/90">{floorWords}</p>
                </div>
              )}
              {lanes.map((lane) => (
                <LaneRow key={lane.chainId} lane={lane} accent={accent} primaryId={primary?.id ?? null} now={now} sinceOf={sinceOf} onRetry={doRetry} />
              ))}
            </div>
            {actionArea()}
            {escArm && (
              <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">
                This run is mid-flight: a signature may be waiting, a transfer may be traveling, and what
                landed already is in your wallet. Press Esc again (or ✕) to close. The run resumes right
                here when you come back.
              </p>
            )}
          </>
        )
      }
    }
  })()

  return createPortal(
    <div
      className="fixed inset-0 z-[90] overflow-y-auto overscroll-contain p-4 sm:p-6"
      onClick={requestClose}
    >
      <div className="absolute inset-0 bg-void/90 backdrop-blur-md" aria-hidden />
      <RunStyles />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${eyebrowText} — ${showName(thesis.name)}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        className="relative mx-auto my-6 w-full max-w-2xl pb-[env(safe-area-inset-bottom)] outline-none"
      >
        <Bezel glow={accent} panel="bg-panel/95">
          <div className="p-5 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <Eyebrow tone="spectral">{eyebrowText}</Eyebrow>
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close"
                className="press grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink"
              >
                ✕
              </button>
            </div>
            <h2 className="mt-4 break-words font-display text-2xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-3xl">
              {showName(thesis.name)}
            </h2>
            {totalCents != null && (
              <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-num text-2xl font-light tabular-nums text-ink">
                  {run?.direction === 'sell' ? '≈ ' : ''}
                  {usdCents(totalCents)}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                  across {thesis.legs.length} {thesis.legs.length === 1 ? 'network' : 'networks'}
                </span>
              </div>
            )}
            {/* the pay asset's own total beside the USD anchor — what the
                conversions sell, summed from the plan's quoted sizings */}
            {payTotal != null && (
              <div className="mt-1 font-mono text-[11px] tabular-nums text-ink-dim">
                paid from ≈ {formatAssetCeil(payTotal.totalRaw, payTotal.decimals)} {payTotal.symbol} on{' '}
                {chainLabel(payTotal.fromChainId)} · quoted fresh at each signature
              </div>
            )}
            <div className="mt-5 h-[3px] overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none"
                style={{
                  width: `${Math.round(fraction * 100)}%`,
                  background: `linear-gradient(90deg, var(--color-cyan), ${accent})`,
                  transitionTimingFunction: EASE,
                }}
              />
            </div>

            {body}

            {/* the standing footer is gone (the owner 2026-08-16): both branches said
                the same sentence, it repeated what the step cards already show,
                and it sat under every state including the ones it did not
                describe. The resume promise is kept where it is actually load
                bearing, on the close guard itself. */}
          </div>
        </Bezel>
      </div>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>,
    document.body,
  )
}

// ── the one lane ──────────────────────────────────────────────────────────────

function LaneRow({
  lane,
  accent,
  primaryId,
  now,
  sinceOf,
  onRetry,
}: {
  lane: Lane
  accent: string
  primaryId: string | null
  now: number
  sinceOf: (step: ThesisRunStep) => number
  onRetry: (stepId: string) => void
}) {
  // A SKIPPED LANE IS NOT A DEAD END (owner 2026-08-16, on a conversion-route
  // refusal leaving him with 2 of 3 legs: "you need to be able to try and
  // retry or bridge manually so the buy can still happen"). The doors below
  // are the completion path that is safe TODAY: bridge settlement to the
  // chain yourself (the REAL BridgeFund), then buy the missing leg alone on
  // its own page — re-running the whole bundle would re-buy the done legs,
  // because the split is amount-derived, not netted against holdings.
  const [bridgeOpen, setBridgeOpen] = useState(false)
  const active = primaryId != null && lane.steps.some((s) => s.id === primaryId) && lane.tone !== 'done' && lane.tone !== 'skipped'
  const shell =
    lane.tone === 'failed'
      ? 'border-amber-400/30 bg-amber-400/[0.04]'
      : lane.tone === 'done'
        ? 'border-white/8 bg-white/[0.02]'
        : lane.tone === 'skipped'
          ? 'border-white/8 bg-transparent opacity-70'
          : 'border-white/10 bg-white/[0.03]'
  const settledWords = lane.steps.find((s) => s.kind === 'buy' || s.kind === 'sell')?.note ?? 'settled'
  return (
    <div
      className={`relative overflow-hidden rounded-xl border px-4 py-3 ${shell}`}
      style={active ? { borderColor: `${accent}59`, boxShadow: `inset 0 0 24px ${accent}0f` } : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ChainBadge chainId={lane.chainId} size="md" />
        {lane.legSymbol != null && (
          <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
            ${showSymbol(lane.legSymbol)}
          </span>
        )}
        <span className="flex-1" />
        {lane.dollarsCents != null && (
          <span className={`font-num text-lg font-light tabular-nums ${lane.tone === 'done' ? 'text-ink-dim' : 'text-ink'}`}>
            {lane.estimated ? '≈ ' : ''}
            {usdCents(lane.dollarsCents)}
          </span>
        )}
      </div>
      {lane.tone === 'done' ? (
        <div className="mt-2.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          <span className="text-teal" aria-hidden>
            ✓
          </span>
          {settledWords}
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {lane.steps.map((s, i) => (
            <StepMark key={s.id} step={s} first={i === 0} accent={accent} isPrimary={s.id === primaryId} now={now} sinceOf={sinceOf} />
          ))}
        </div>
      )}
      {(lane.tone === 'failed' || lane.tone === 'skipped') && lane.note && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className={`min-w-0 flex-1 font-mono text-[10px] leading-relaxed ${lane.tone === 'failed' ? 'text-amber-200/90' : 'text-ink-faint'}`}>
            {lane.note}
          </p>
          {lane.tone === 'failed' && (
            <button
              type="button"
              onClick={() => {
                const failedStep = lane.steps.find((s) => s.state === 'failed')
                if (failedStep) onRetry(failedStep.id)
              }}
              className="press inline-flex min-h-[36px] shrink-0 items-center rounded-lg border border-amber-400/40 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200 hover:bg-amber-400/10"
            >
              Retry
            </button>
          )}
          {lane.tone === 'skipped' && (
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setBridgeOpen(true)}
                className="press inline-flex min-h-[36px] items-center rounded-lg border border-white/15 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
              >
                Bridge funds →
              </button>
              {lane.legAddress != null && lane.legSymbol != null && (
                <Link
                  to={basketHref({ chainId: lane.chainId, address: lane.legAddress, symbol: lane.legSymbol })}
                  className="press inline-flex min-h-[36px] items-center rounded-lg border border-white/15 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                >
                  Buy this leg on its page →
                </Link>
              )}
            </span>
          )}
        </div>
      )}
      {bridgeOpen && <BridgeFund destChainId={lane.chainId} onClose={() => setBridgeOpen(false)} />}
      {lane.tone === 'awaiting' && <RunBeam accent={accent} />}
    </div>
  )
}

function StepMark({
  step,
  first,
  accent,
  isPrimary,
  now,
  sinceOf,
}: {
  step: ThesisRunStep
  first: boolean
  accent: string
  isPrimary: boolean
  now: number
  sinceOf: (step: ThesisRunStep) => number
}) {
  const st = step.state
  const lit = isPrimary || st === 'signing' || st === 'confirming' || st === 'awaiting'
  return (
    <span className="flex items-center gap-2">
      {!first && <span aria-hidden className="h-px w-3 bg-white/10" />}
      <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]">
        {st === 'done' ? (
          <span className="text-teal" aria-hidden>
            ✓
          </span>
        ) : st === 'failed' ? (
          <span className="text-amber-300" aria-hidden>
            ⚠
          </span>
        ) : st === 'signing' ? (
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 animate-pulse rounded-full border motion-reduce:animate-none"
            style={{ borderColor: accent, background: `${accent}66` }}
          />
        ) : st === 'confirming' || st === 'awaiting' ? (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: accent }} />
        ) : isPrimary ? (
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border" style={{ borderColor: accent }} />
        ) : (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/15" />
        )}
        <span className={st === 'failed' ? 'text-amber-200/90' : lit ? 'text-ink' : st === 'skipped' ? 'text-ink-faint opacity-70' : 'text-ink-faint'}>
          {describeStep(step)}
        </span>
        {st === 'signing' && (
          <span className="animate-pulse rounded-full border px-2 py-0.5 text-[9px] normal-case tracking-normal motion-reduce:animate-none" style={{ borderColor: `${accent}66`, color: accent }}>
            in your wallet
          </span>
        )}
        {st === 'awaiting' && (
          <span className="rounded-full border border-white/12 px-2 py-0.5 text-[9px] normal-case tracking-normal text-ink-dim">
            in flight · {elapsedLabel(sinceOf(step), now)}
          </span>
        )}
        {st === 'confirming' && <span className="text-[9px] normal-case tracking-normal text-ink-dim">confirming</span>}
      </span>
    </span>
  )
}

// ── the per-leg trade executor ───────────────────────────────────────────────
// Mounted for the ACTIVE buy/sell leg only, keyed by that leg, so useDexSwap's
// whole quote/floor/gate machinery re-mounts per leg. This IS the live money
// path — the same hook, driven with the same arguments DexSwapCard passes
// (amountRaw, DEFAULT_SLIPPAGE_BPS, the READ feeFrac, shownFloor) — with
// shownFloor null: this overlay paints no minimum, and null is the documented
// "no promise painted" stand-down, so the copy says where the floor lives.

function LegTradeExecutor({
  step,
  onPhase,
  onDone,
  onFail,
}: {
  step: ThesisRunStep
  onPhase: (phase: 'signing' | 'confirming') => void
  onDone: (hash: Hex) => void
  onFail: (message: string) => void
}) {
  const dir = step.kind === 'sell' ? 'sell' : 'buy'
  const legAddress = step.legAddress ?? null
  const { data: fetched } = useBasketData(legAddress ?? undefined, step.chainId)
  const basketData = fetched ?? null
  const { data: fees } = useBasketFees(basketData?.address, step.chainId)
  // Mirrors DexSwapCard:193 exactly: NaN until the fee is READ — a NaN fee
  // refuses to execute rather than guessing zero.
  const feeFrac = fees ? fees.basketFeeBps / 10_000 : Number.NaN
  const dex = useDexSwap(basketData, dir, hubPay('USDC'), step.chainId)
  const amountRaw = dir === 'buy' ? centsToUsdcRaw(step.amountCents ?? 0) : (step.sellRaw ?? 0n)

  // Step state follows the money path's own per-tx statuses (approve → swap),
  // so "in your wallet" is only ever said while a signature really is out.
  const spectrumTx = dex.txOf('spectrum')
  const approveTx = dex.txOf(dir === 'buy' ? 'approve-usdc' : 'approve-in')
  const phase =
    spectrumTx.status === 'signing' || approveTx.status === 'signing'
      ? ('signing' as const)
      : spectrumTx.status === 'confirming' || approveTx.status === 'confirming'
        ? ('confirming' as const)
        : null
  const phaseRef = useRef<'signing' | 'confirming' | null>(null)
  useEffect(() => {
    if (phase && phase !== phaseRef.current) {
      phaseRef.current = phase
      onPhase(phase)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Terminal outcomes on the running edge, reported once.
  const wasRunning = useRef(false)
  const settled = useRef(false)
  useEffect(() => {
    if (dex.running) {
      wasRunning.current = true
      settled.current = false
      return
    }
    if (!wasRunning.current || settled.current) return
    if (dex.done) {
      settled.current = true
      onDone(dex.done.hash)
    } else if (dex.error) {
      settled.current = true
      wasRunning.current = false
      phaseRef.current = null
      onFail(dex.error)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex.running, dex.done, dex.error])

  const missing = !legAddress || amountRaw <= 0n
  const reading = !missing && (!basketData || !Number.isFinite(feeFrac))
  const busy = dex.running
  const label = missing
    ? 'This leg is missing from the saved run'
    : reading
      ? 'Reading the basket…'
      : busy
        ? phase === 'confirming'
          ? 'Confirming…'
          : 'In your wallet…'
        : (primaryActionLabel(step) ?? (dir === 'buy' ? 'Buy this leg' : 'Sell this leg'))

  return (
    <div>
      <button
        type="button"
        disabled={missing || reading || busy || !dex.configured}
        onClick={() => void dex.execute(amountRaw, DEFAULT_SLIPPAGE_BPS, feeFrac, null)}
        className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
      >
        {label}
      </button>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        a signature or two · minimum enforced at signing
      </p>
      {missing && (
        <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">
          The saved run does not carry this leg&rsquo;s amount, so nothing can be signed for it. Close and start over.
        </p>
      )}
      {/* the fourth disabler says its name (audit 2026-08-16: missing/reading/
          busy all explain themselves; an unconfigured lane was just a dead
          button) — the console's own sentence for the same state */}
      {!dex.configured && !missing && (
        <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">
          Buying is switched off on this deployment, so this leg cannot be signed here.
        </p>
      )}
      {dex.error && !busy && <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">{dex.error}</p>}
    </div>
  )
}

// ── refuel arrival check ─────────────────────────────────────────────────────
// LI.FI carries the gas top-up inside the transfer with NO verifiable echo, so
// the only honest evidence that a refueled chain can pay for its buy is the
// destination native balance itself. Zero = the note; anything else = silence.
// (Dust above zero is the wallet's own to price — the simulate-before-sign in
// the live path still refuses loudly if gas really cannot cover it.)

function RefuelGasNote({ chainId, holder }: { chainId: number; holder: Address }) {
  const [confirmedEmpty, setConfirmedEmpty] = useState(false)
  useEffect(() => {
    let stale = false
    const check = () => {
      clientFor(chainId)
        .getBalance({ address: holder })
        .then((b) => {
          if (!stale) setConfirmedEmpty(b === 0n)
        })
        .catch(() => {
          if (!stale) setConfirmedEmpty(false) // unreadable is not evidence — no alarm on a guess
        })
    }
    check()
    const t = window.setInterval(check, 6_000)
    return () => {
      stale = true
      window.clearInterval(t)
    }
  }, [chainId, holder])
  if (!confirmedEmpty) return null
  return (
    <p className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 font-mono text-[10px] leading-relaxed text-amber-200/90">
      Gas for {chainLabel(chainId)} rode the bridge and has not landed in your wallet yet. Give it a moment — a buy
      signed before it arrives cannot pay for itself.
    </p>
  )
}

// ── the network-switch offer (never taken silently) ─────────────────────────

function SwitchOffer({ sw, chainId, why }: { sw: NetworkSwitch; chainId: number; why: string | null }) {
  return (
    <div>
      <button
        type="button"
        onClick={sw.switchNow}
        disabled={sw.switching}
        className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
      >
        {sw.switching ? 'Confirm in wallet…' : `Switch to ${chainLabel(chainId)}`}
      </button>
      {why && <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{why}</p>}
      {sw.declined && (
        <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-300/90">
          Your wallet stayed on {sw.walletWords}, so nothing was sent. Try again when you are ready, or change the network in your wallet.
        </p>
      )}
    </div>
  )
}

// ── the sell setup (fraction + optional consolidation) ──────────────────────

function SellSetup({
  thesis,
  held,
  onStart,
}: {
  thesis: Thesis
  held?: HeldIndex
  onStart: (fraction: number, consolidateTo: number | null) => void
}) {
  const [pct, setPct] = useState(100)
  const [home, setHome] = useState<number | ''>('')
  const heldLegs = thesis.legs.filter((l) => heldPosition(held ?? null, l) != null)
  const pricedUsd = heldLegs.reduce((s, l) => s + (heldPosition(held ?? null, l)?.valueUsd ?? 0), 0)
  const estCents = pricedUsd > 0 ? Math.round(pricedUsd * pct) : null // ×100 for cents, ×pct/100 for the fraction

  return (
    <div className="mt-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">what you hold</div>
      <div className="mt-3 space-y-2">
        {heldLegs.map((l) => {
          const pos = heldPosition(held ?? null, l)
          return (
            <div key={`${l.chainId}:${l.address}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/10 bg-black/20 px-3.5 py-2.5">
              <ChainBadge chainId={l.chainId} size="md" />
              <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">${showSymbol(l.symbol)}</span>
              <span className="flex-1" />
              {/* null value = unpriced, and the fact of holding still shows —
                  "$0" next to a real position is a lie we cannot tell */}
              {pos?.valueUsd != null && <span className="font-num text-base font-light tabular-nums text-ink">{usdCents(Math.round(pos.valueUsd * 100))}</span>}
            </div>
          )
        })}
        {heldLegs.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/12 px-4 py-4 text-center font-mono text-[11px] text-ink-dim">
            No held legs were found for this wallet right now.
          </p>
        )}
      </div>

      <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">how much of it</div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {[25, 50, 75, 100].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setPct(v)}
            className={`press inline-flex h-9 items-center rounded-lg border px-3.5 font-mono text-[11px] ${
              pct === v ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-white/12 text-ink-dim hover:border-cyan/40 hover:text-ink'
            }`}
          >
            {v}%
          </button>
        ))}
        {estCents != null && <span className="font-mono text-[11px] text-ink-faint">≈ {usdCents(estCents)} before costs</span>}
      </div>

      <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">after selling</div>
      <select
        value={home}
        onChange={(e) => setHome(e.target.value === '' ? '' : Number(e.target.value))}
        className="mt-3 h-12 w-full rounded-xl border border-white/12 bg-panel px-3 font-mono text-[12px] text-ink outline-none focus:border-cyan/50"
      >
        <option value="">Leave the proceeds on each network</option>
        {thesis.chainIds.map((id) => (
          <option key={id} value={id}>
            Bring the money home to {chainLabel(id)}
          </option>
        ))}
      </select>

      <button
        type="button"
        disabled={heldLegs.length === 0}
        onClick={() => onStart(pct / 100, home === '' ? null : home)}
        className="spectral-btn press mt-6 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
      >
        Sell {pct}% across {heldLegs.length} {heldLegs.length === 1 ? 'network' : 'networks'}
      </button>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        one sale per network · floors enforced at signing · bringing money home bridges what actually landed
      </p>
    </div>
  )
}

// ── the success plate ────────────────────────────────────────────────────────

function SuccessPlate({
  run,
  legs,
  accent,
  thesisName,
  demo,
  onDone,
  onOfferPayAsset,
}: {
  run: ThesisRun
  legs: readonly LaneLeg[]
  accent: string
  thesisName: string
  demo: boolean
  onDone: () => void
  /** Absent = this host has no picker, so the offer is not shown at all rather
   *  than rendered as a button that goes nowhere. */
  onOfferPayAsset?: () => void
}) {
  const rows = landedRows(run, legs)
  const okCount = rows.filter((r) => r.ok).length
  // the skipped rows' bridge door (audit 2026-08-16: LaneRow's doors vanished
  // the moment `finished` swapped it for this plate — exactly when the user is
  // reading the damage). One mount, keyed to the pressed row's chain.
  const [bridgeChain, setBridgeChain] = useState<number | null>(null)
  return (
    <div className="relative mt-8 overflow-hidden rounded-2xl border border-white/12 bg-white/[0.03] p-6">
      {/* one-off spectral pass over the plate — celebration, not a state */}
      <span
        aria-hidden
        className="trov-shimmer pointer-events-none absolute inset-0"
        style={{ background: `linear-gradient(100deg, transparent 35%, ${accent}2e 50%, transparent 65%)`, backgroundSize: '250% 100%' }}
      />
      <div className="relative">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: accent }}>
          complete
        </div>
        <div className="mt-3 break-words font-display text-xl font-bold uppercase tracking-tight text-ink">{showName(thesisName)}</div>
        <div className="mt-2 text-sm leading-relaxed text-ink-dim">
          {run.direction === 'buy' ? 'yours' : 'sold'} across {okCount} {okCount === 1 ? 'network' : 'networks'}
          {rows.length > okCount ? ` · ${rows.length - okCount} ${rows.length - okCount === 1 ? 'leg was' : 'legs were'} skipped, noted below` : ''}
        </div>
        <div className="mt-5 space-y-2">
          {rows.map((r) => (
            <div key={r.chainId} className="rounded-xl border border-white/8 bg-black/20 px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ChainBadge chainId={r.chainId} size="md" />
                {r.legSymbol != null && (
                  <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">${showSymbol(r.legSymbol)}</span>
                )}
                <span className="flex-1" />
                <span className={`font-mono text-[11px] ${r.ok ? 'text-ink-dim' : 'text-amber-200/80'}`}>{r.words}</span>
              </div>
              {/* a skipped row keeps its doors on the FINISHED plate too —
                  LaneRow's exact pair, so the remedy survives the handoff */}
              {!r.ok && !demo && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setBridgeChain(r.chainId)}
                    className="press inline-flex min-h-[36px] items-center rounded-lg border border-white/15 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                  >
                    Bridge funds →
                  </button>
                  {r.legAddress != null && r.legSymbol != null && (
                    <Link
                      to={basketHref({ chainId: r.chainId, address: r.legAddress, symbol: r.legSymbol })}
                      className="press inline-flex min-h-[36px] items-center rounded-lg border border-white/15 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                    >
                      Buy this leg on its page →
                    </Link>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        {bridgeChain != null && <BridgeFund destChainId={bridgeChain} onClose={() => setBridgeChain(null)} />}
        {/* ⚠⚠ A SHORTFALL IS A QUESTION ON A PARTIAL RUN TOO (the owner 2026-08-16:
            "if nothing is free to bridge then it should just first ask what you
            want to sell to fund the seed/bridging like my eth on mainnet").
            This door already existed but ONLY on the all-refused branch
            (`rows.every(r => !r.ok)`), so a run where some legs landed and
            others came up short dead-ended in a note — the exact case he hit,
            while holding plenty of ETH that could have covered it. The money to
            fix it is usually right there; not offering is the bug. */}
        {!!onOfferPayAsset && rows.some((r) => !r.ok && (r.noteCode === 'needs-funds' || /Needs \$/.test(r.words))) && (
          <div className="mt-6 rounded-xl border border-white/12 bg-white/[0.03] px-4 py-4 text-center">
            <p className="mx-auto max-w-[44ch] text-[13px] leading-relaxed text-ink-dim">
              Pick another asset you hold and the run sells and moves it for you.
            </p>
            <button
              type="button"
              onClick={() => {
                onDone()
                onOfferPayAsset()
              }}
              className="spectral-btn press mt-3 inline-flex h-11 items-center justify-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
            >
              Pay from another asset →
            </button>
          </div>
        )}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          {!demo && (
            <Link
              to="/portfolio"
              className="press inline-flex h-12 flex-1 items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-cyan/50 hover:text-ink"
            >
              View portfolio
            </Link>
          )}
          <button
            type="button"
            onClick={onDone}
            className="spectral-btn press inline-flex h-12 flex-1 items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** The demo's own traveling light line, EXPORTED for the real run surface
 *  (the owner 2026-08-15 0008: "a little like moving light line below each card…
 *  keep that and use it") — the reuse law: the real component, never a
 *  lookalike. Hosts must also mount <RunProgressStyles /> once. */
export function RunBeam({ accent }: { accent: string }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] overflow-hidden">
      <span className="trov-beam absolute inset-y-0 w-1/2" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
    </span>
  )
}

// ── self-contained keyframes (this overlay may not touch index.css) ─────────

export function RunProgressStyles() {
  return <RunStyles />
}

function RunStyles() {
  return (
    <style>{`
@keyframes trov-beam { from { transform: translateX(-100%); } to { transform: translateX(200%); } }
.trov-beam { animation: trov-beam 2.4s ease-in-out infinite; }
@keyframes trov-shimmer { from { background-position: 200% 0; opacity: 1; } to { background-position: -60% 0; opacity: 0; } }
.trov-shimmer { animation: trov-shimmer 1.6s ease-out 1 forwards; }
@media (prefers-reduced-motion: reduce) {
  .trov-beam, .trov-shimmer { animation: none; display: none; }
}
`}</style>
  )
}
