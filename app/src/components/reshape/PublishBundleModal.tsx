import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isAddress } from 'viem'
import type { Address } from 'viem'
import { chainCfg } from '../../lib/chain/chains'
import { deploymentFor } from '../../lib/chain/deployments'
import { DEPLOY_ENABLED } from '../../lib/config/features'
import type { FeeConfigInput } from '../../lib/spectrum/abis-v2'
import { useAllBaskets, useDeployPrice } from '../../lib/spectrum/hooks'
import { useFeeBounds } from '../../lib/spectrum/use-basket-fees'
import { useDeployBasket } from '../../lib/spectrum/use-deploy'
import { deriveLauncher } from '../../lib/spectrum/version-seed'
import { getStoredRef, hasCreatorRefBeenUsed, markCreatorRefUsed } from '../../lib/spectrum/referral'
import { loadLandedLanes, setLandedDeployer } from '../../lib/spectrum/landed-lanes'
import { readThesisFunds } from '../../lib/spectrum/thesis-funding'
import { thesisHref } from '../../lib/spectrum/thesis-url'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { chainLabel } from '../thesis/run-lanes'
import { ChainBadge } from '../ChainBadge'
import { BridgeFund } from '../BridgeFund'
import { ClaimHandle } from '../creator/ClaimHandle'
import { useNetworkSwitch, WrongNetworkNotice, type NetworkSwitch } from '../WrongNetwork'
import { FeeSlider, creatorShareBpsOf } from '../launch/BasketBuilder'
import { FeeSplitBar } from '../launch/FeeSplitBar'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { Bezel, Eyebrow } from '../home/Spine'
import { deployStageWords } from './thesis-reshape-model'
import { SeedBundleDoor } from './SeedBundleDoor'
import { DeployPortal } from '../launch/DeployPortal'
import { Carousel } from '../Carousel'
import { RunBeam, RunProgressStyles } from '../thesis/ThesisRunOverlay'
import { publishSeedPlan } from './seed-plan'
import { encodeBasketMetaJson, NOTE_KINDS, notesRegistryAbi } from '../../lib/spectrum/profile-registry'
import { clientFor } from '../../lib/chain/rpc'
import { basketSupply } from '../../lib/spectrum/unseeded-baskets'
import { useLaneAutoSwitch } from './use-auto-switch'
import {
  ADDRESS_UNREAD_NOTE,
  BUNDLE_NAME_LAW,
  DEPLOYS_DISABLED_NOTE,
  PUBLISH_INTERRUPTION_NOTE,
  TICKER_RE,
  activePublishLane,
  advancePublishLane,
  announcePublishLane,
  bundleNameOk,
  cleanTicker,
  defaultTickers,
  deployReadiness,
  deployerRefusal,
  fundingPlan,
  gasSymbol,
  publishLaneMarks,
  publishProgress,
  retryPublishLane,
  seedPublishLanes,
  type BundleGroup,
  type DeployReadiness,
  type PublishLane,
  type PublishLanePatch,
} from './publish-bundle-model'

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISH THE BUNDLE (the owner 2026-08-10: cross-network picks in the create flow
// "prep the entire routing/bridging system to help them get gas on the right
// chain and deploy on each chain") — the ceremony over publish-bundle-model's
// pure machine: SET (one shared name, one ticker, per-network gas readiness —
// the DIAGNOSIS per card, the funding action on the one main button) → SHIP
// (sequential real deploys, one lane per network, the reshape ceremony's
// grammar MINUS lineage — these baskets are born here, nothing is superseded).
//
// The deploy machinery is the house's one implementation: useDeployBasket per
// active lane (mounted through a keyed executor, exactly one at a time), fee
// defaults derived the way BasketBuilder derives them (1% clamped into the
// protocol bounds · creator share at the cap · payout = the connected wallet ·
// launcher via deriveLauncher).
//
// THE SWITCH IS NOW TAKEN, NOT ONLY OFFERED — A SUPERSESSION, STATED. This
// header read "the switch is OFFERED, never taken" until 2026-08-13, when the owner
// ruled the opposite for the in-ceremony lane advance: "can we auto switch them
// to the next chain, save them a click to switch to eth/base etc". So when the
// cursor lands on a network the wallet is not on, the ceremony CALLS the switch
// itself — once per lane, through the app's own useNetworkSwitch (never a raw
// window.ethereum). The wallet still shows its own prompt, so consent has not
// moved an inch; we saved OUR click, not the wallet's. And the sequencer STILL
// advances only when it OBSERVES the wallet on the lane's chain — a switch made
// inside the wallet is identical. Never while a signature is out, never again
// after a refusal (which falls back to the manual offer below, unchanged).
// The four laws and the rest of the reasoning: auto-switch.ts.
//
// ONE DEPLOYER FOR THE WHOLE BUNDLE — THE IDENTITY LOCK (the owner 2026-08-13,
// from a live publish: "during the deploy of the bundle i swapped wallet and
// was able to deploy only the base/rh leg from this new wallet even tho another
// wallet i own was the creator, this messes up the flow and shouldn't be
// possible"). A bundle is the tuple (deployer, name); half a run under a second
// wallet is two fragments that never group. The ANCHOR is the wallet that
// deployed the FIRST LANDED lane — an on-chain fact, taken once and then
// persisted with the landed lanes so a reload cannot launder it. While the
// connected wallet is not the anchor this ceremony OFFERS NOTHING: the
// sequencer holds, the auto-switch stands down, the executor never arms (so
// nothing is prepared, let alone signed), retry and Begin refuse, and the
// refusal names both wallets. The law and the sentence: publish-bundle-model's
// deployerRefusal.
//
// No demo lane: a fresh create has no fixture subject. With deploys disabled
// the modal states DEPLOYS_DISABLED_NOTE and offers nothing.
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT = '#a48bff'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function PublishBundleModal({
  groups,
  seedName,
  seedSymbol,
  onClose,
  onPublished,
  onLaneDone,
  alreadyLive = [],
  lockedName,
  initialFeePct,
  initialCreatorSharePct,
  initialCreatorPayout,
}: {
  /** The per-network plan, grouped by the Composer (publish-bundle-model's
   *  groupBundleDraft — deploy weights already renormalized per network). */
  groups: BundleGroup[]
  /** The Composer's typed name/ticker — seeds, editable here. */
  seedName: string
  seedSymbol: string
  onClose: () => void
  /** Fired ONCE when every lane lands — the caller's cue that the draft it
   *  handed in is now live on-chain (the Composer clears its mix on the next
   *  close, so a finished bundle can't be re-published by accident). */
  onPublished?: () => void
  /** Fired per landed deploy, as it lands, carrying the shared name it shipped
   *  under — the caller remembers both so an INTERRUPTED ceremony can be
   *  reopened without re-deploying (a re-deploy is a paid duplicate, the exact
   *  loss the interruption note promises against). */
  onLaneDone?: (chainId: number, newAddress: `0x${string}` | null, shippedName: string) => void
  /** Deploys that already landed in an interrupted run of THIS draft: their
   *  lanes seed as done (never re-armed), their tickers are shipped facts,
   *  and the shared name LOCKS — the name is the grouping key, and a landed
   *  basket already carries it on-chain; renaming now would split the bundle. */
  alreadyLive?: { chainId: number; newAddress: `0x${string}` | null }[]
  /** The name the landed deploys shipped under. Overrides seedName so an edit
   *  to the composer's field between runs cannot smuggle a rename past the
   *  lock. Meaningful only alongside a non-empty alreadyLive. */
  lockedName?: string
  /** The create flow's fee-station values (owner 2026-08-12 addendum): seed
   *  this ceremony's own dials so what was set on the publish page is what
   *  the ceremony opens showing — still editable here. Absent = the
   *  ceremony's own defaults (1% · max share · this wallet). An explicit
   *  share of 0 is honored: it came from a this-session dial, not a stale
   *  draft. */
  initialFeePct?: string
  initialCreatorSharePct?: string
  initialCreatorPayout?: string
}) {
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const chainIds = useMemo(() => groups.map((g) => g.chainId), [groups])

  const [stage, setStage] = useState<'set' | 'ship'>('set')
  const [sharedName, setSharedName] = useState((lockedName ?? seedName).trim())
  // ONE ticker (owner 2026-08-12: "a single toggle/slider/switch etc for each
  // setting that gets set across each chain, not having to do it multiple
  // times per chain") — every network ships under it. On-chain symbols don't
  // collide across chains, so per-network divergence bought nothing but N
  // inputs. The per-chain map the lanes read is DERIVED.
  const [ticker, setTicker] = useState<string>(() => cleanTicker(seedSymbol))
  const tickers = useMemo(() => defaultTickers(chainIds, ticker), [chainIds, ticker])
  // THE FEE STATION (owner 2026-08-12: "ensure the bundle ceremony also has
  // this — and it sets those fee % / address on each chain"): the builder's
  // three dials, set ONCE and written into every network's deploy. Defaults
  // are what the ceremony always hard-coded (1% · max share · this wallet),
  // so an untouched station ships exactly what it used to.
  const { data: feeBounds } = useFeeBounds(chainIds[0] ?? 8453)
  const [feePct, setFeePct] = useState(() =>
    initialFeePct && parseFloat(initialFeePct) > 0
      ? initialFeePct
      : (Math.min(Math.max(100, feeBounds.minFeeBps), feeBounds.maxFeeBps) / 100).toFixed(2),
  )
  const [creatorSharePct, setCreatorSharePct] = useState(() => {
    const v = initialCreatorSharePct != null ? parseFloat(initialCreatorSharePct) : NaN
    return Number.isFinite(v) && v >= 0 ? initialCreatorSharePct! : String(feeBounds.maxCreatorShareBps / 100)
  })
  const [creatorPayout, setCreatorPayout] = useState(initialCreatorPayout ?? '')
  const [lanes, setLanes] = useState<PublishLane[] | null>(null)
  const [shipRefusal, setShipRefusal] = useState<string | null>(null)
  // the creation show plays once per finish; then the seed door takes over
  const [ceremonyPlayed, setCeremonyPlayed] = useState(false)
  const [signingNow, setSigningNow] = useState(false)
  const [escArm, setEscArm] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [fundFor, setFundFor] = useState<number | null>(null)
  // The seed run overlay portals OVER this ceremony and both listen to window
  // Escape — while it is up, this ceremony's close stands down (the overlay
  // owns the key, and closing the ceremony underneath it would orphan the run).
  const [seedOverlayOpen, setSeedOverlayOpen] = useState(false)
  const escArmRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Per-network native balances for the readiness strip. readThesisFunds OMITS
  // a chain it could not read — absent stays null and reads as unknown, never
  // as broke (the model's deployReadiness states exactly that).
  const { data: funds } = useQuery({
    queryKey: ['publish-bundle-funds', address, chainIds.join(',')],
    queryFn: () => readThesisFunds(chainIds, address as Address),
    enabled: !!address && chainIds.length > 0,
    staleTime: 30_000,
    refetchInterval: 30_000,
  })
  const nativeOf = useCallback(
    (chainId: number): bigint | null => funds?.find((f) => f.chainId === chainId)?.nativeRaw ?? null,
    [funds],
  )

  const active = lanes ? activePublishLane(lanes) : null
  const progress = lanes ? publishProgress(lanes) : null
  const finished = !!progress && progress.total > 0 && progress.finished

  // ── THE IDENTITY LOCK ──────────────────────────────────────────────────────
  // The anchor is whoever deployed the first landed lane. In THIS session that
  // is remembered here; across a reload it rides with the landed lanes (and is
  // only trusted when the persisted row is the very bundle we are resuming —
  // same name, and there is something landed to resume).
  const [sessionDeployer, setSessionDeployer] = useState<string | null>(null)
  const resumedDeployer = useMemo(() => {
    if (alreadyLive.length === 0) return null
    const row = loadLandedLanes()
    if (!row) return null
    const runName = (lockedName ?? seedName).trim()
    return row.name === runName ? row.deployer : null
  }, [alreadyLive.length, lockedName, seedName])
  const deployerAnchor = sessionDeployer ?? resumedDeployer
  // Not connected yet ⇒ no refusal (the connect CTA governs); no anchor ⇒
  // nothing is committed and any wallet may still become this bundle's creator.
  const identityRefusal = deployerRefusal(deployerAnchor, address ?? null)

  // Tell the caller exactly once that the bundle is live.
  const publishedNotifiedRef = useRef(false)
  useEffect(() => {
    if (!finished || publishedNotifiedRef.current) return
    publishedNotifiedRef.current = true
    onPublished?.()
  }, [finished, onPublished])

  // One switch mutation for the whole ceremony; it re-targets as the cursor moves.
  const sw = useNetworkSwitch(active?.chainId ?? chainIds[0] ?? 8453)

  // ONE CLICK, NOT TWO (the owner 2026-08-13, the supersession in this file's
  // header): the ceremony asks the wallet for the lane's network itself. Once
  // per lane, never while a signature is out, never after a refusal — and the
  // sequencer below still advances only on the OBSERVED chain. `demo: false` is
  // a fact here, not a setting: a fresh create has no walkthrough.
  // A wallet that is not this bundle's deployer is never asked to switch
  // networks: with no lane to advance there is nothing to ask FOR.
  useLaneAutoSwitch({
    sw,
    shipping: stage === 'ship',
    demo: false,
    laneChainId: identityRefusal ? null : (active?.chainId ?? null),
    laneState: active?.state ?? null,
    connected: isConnected,
    walletChainId,
    signing: signingNow,
  })

  const patchLane = useCallback((chainId: number, patch: PublishLanePatch) => {
    setLanes((prev) => (prev ? advancePublishLane(prev, chainId, patch) : prev))
  }, [])
  const doRetry = useCallback(
    (chainId: number) => {
      if (identityRefusal) return // a foreign wallet cannot re-arm a lane either
      setLanes((prev) => (prev ? retryPublishLane(prev, chainId) : prev))
    },
    [identityRefusal],
  )

  // The sequencer, UNCHANGED by the auto-switch ruling (law (c)): 'queued'
  // becomes the switch step, and the wallet's OBSERVED chain is what advances it
  // to 'deploying' — never the switch call's return. The call above is a
  // convenience; this observation is the truth.
  useEffect(() => {
    if (stage !== 'ship' || !active) return
    // The cursor HOLDS under a foreign wallet — no lane advances toward a
    // signature that would fragment the bundle.
    if (identityRefusal) return
    if (active.state === 'queued') {
      patchLane(active.chainId, { state: 'switch', note: null })
      return
    }
    if (active.state === 'switch' && isConnected && walletChainId === active.chainId) {
      patchLane(active.chainId, { state: 'deploying', note: null })
    }
  }, [stage, active, isConnected, walletChainId, identityRefusal, patchLane])

  // The ceremony reads its transitions aloud.
  useEffect(() => {
    if (!active) return
    setAnnounce(announcePublishLane(active, chainLabel(active.chainId)))
  }, [active])

  // Close guard: while a signature is out the first Escape/✕ arms instead of
  // closing — finished networks keep their baskets either way (the note says so).
  const requestClose = useCallback(() => {
    if (seedOverlayOpen) return // the seed run owns the screen and the Escape key
    if (!signingNow || escArmRef.current) {
      onClose()
      return
    }
    escArmRef.current = true
    setEscArm(true)
    window.setTimeout(() => {
      escArmRef.current = false
      setEscArm(false)
    }, 5000)
  }, [seedOverlayOpen, signingNow, onClose])

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
    const before = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = prev
      before?.focus?.()
    }
  }, [])

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (!root) return
    const nodes = [...root.querySelectorAll<HTMLElement>('button, [href], select, input, [tabindex]:not([tabindex="-1"])')].filter(
      (n) => !n.hasAttribute('disabled'),
    )
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const current = document.activeElement as HTMLElement | null
    if (e.shiftKey && (current === first || current === root)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && current === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const liveOf = useCallback(
    (chainId: number) => alreadyLive.find((x) => x.chainId === chainId),
    [alreadyLive],
  )
  const nameLocked = alreadyLive.length > 0

  const nameOk = bundleNameOk(sharedName)
  // the builder's own fee derivations, verbatim (payout EMPTY = this wallet,
  // the ceremony's standing default; mixed case => EIP-55 checked)
  const feeBps = useMemo(() => {
    const v = parseFloat(feePct)
    return isFinite(v) ? Math.round(v * 100) : null
  }, [feePct])
  const feeInBounds = feeBps != null && feeBps >= feeBounds.minFeeBps && feeBps <= feeBounds.maxFeeBps
  const creatorShareBps = useMemo(
    () => creatorShareBpsOf(creatorSharePct, feeBounds.maxCreatorShareBps),
    [creatorSharePct, feeBounds.maxCreatorShareBps],
  )
  const payoutTrimmed = creatorPayout.trim()
  const payoutHasCase = /[a-f]/.test(payoutTrimmed.slice(2)) && /[A-F]/.test(payoutTrimmed.slice(2))
  const payoutValid = payoutTrimmed === '' || isAddress(payoutTrimmed, { strict: payoutHasCase })
  const feesOk = feeInBounds && (creatorShareBps === 0 || payoutValid)
  // a landed chain's ticker is a shipped on-chain fact, not an input to validate
  const tickersOk = chainIds.every((id) => liveOf(id)) || TICKER_RE.test(ticker)
  // …and its group no longer needs to pass the fresh-deploy shape gates either
  const allShapeReady = groups.every((g) => g.ready || liveOf(g.chainId))

  // ── ONE FUNDING ACTION (the owner 2026-08-13: "it should just do the right fund
  //    movements via the main button not on each individual basket area") ──
  // The cards keep the DIAGNOSIS; the door moves here. Each card reports its
  // own verdict up (its price read is a hook, so it has to live in the card),
  // and the plan the main button wears is derived from the collected verdicts.
  const [verdicts, setVerdicts] = useState<Record<number, DeployReadiness['kind']>>({})
  const noteVerdict = useCallback((chainId: number, kind: DeployReadiness['kind']) => {
    setVerdicts((prev) => (prev[chainId] === kind ? prev : { ...prev, [chainId]: kind }))
  }, [])
  const funding = useMemo(
    () =>
      fundingPlan(
        groups
          .filter((g) => !liveOf(g.chainId) && verdicts[g.chainId] === 'short')
          .map((g) => ({
            chainId: g.chainId,
            gasSymbol: gasSymbol(g.chainId),
            // the door's OWN hard gate, read the same way it reads it — a chain
            // with no settlement asset is one BridgeFund refuses on arrival
            settlementSymbol: deploymentFor(g.chainId).usdc ? chainCfg(g.chainId).usdcSymbol : null,
          })),
      ),
    [groups, verdicts, liveOf],
  )

  // ── THE FEE, ASKED ONCE (the owner 2026-08-13, on this block: "also this has
  //    already been set before the popup") ──
  // /create's page 3 now sets total fee, creator share and payout before this
  // ceremony ever opens, and prefills them here. Asking the same three
  // questions again is asking twice, so a prefilled ceremony shows a summary
  // row and keeps the station one click away. Paths that never asked (the
  // Composer's research face, the portfolio flow) get today's full station —
  // and so does an invalid config, which must never hide behind a summary.
  const feePrefilled = initialFeePct != null
  const [feeStationOpen, setFeeStationOpen] = useState(false)
  const showFeeStation = !feePrefilled || feeStationOpen || !feesOk

  function beginShip() {
    setShipRefusal(null)
    // a resumed bundle only continues under the wallet that started it
    if (identityRefusal) {
      setShipRefusal(identityRefusal)
      return
    }
    // the model owns resume composition: landed chains seed as done lanes
    // (never re-armed), only the pending groups pass the fresh-deploy gates
    const seeded = seedPublishLanes(groups, alreadyLive)
    if ('refused' in seeded) {
      setShipRefusal(seeded.refused)
      return
    }
    setLanes(seeded)
    setStage('ship')
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] overflow-y-auto overscroll-contain p-4" onClick={requestClose}>
      <div className="absolute inset-0 bg-void/90 backdrop-blur-md" aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`publish the bundle — ${showName(sharedName || seedName)}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        className="relative mx-auto my-4 w-full max-w-[920px] pb-[env(safe-area-inset-bottom)] outline-none"
      >
        <RunProgressStyles />
        <Bezel glow={ACCENT} panel="bg-panel/95">
          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Eyebrow tone="spectral">publish the bundle</Eyebrow>
                <h2 className="mt-1.5 font-display text-2xl font-bold uppercase leading-tight tracking-tight text-ink">
                  {showName(sharedName || 'Your bundle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close"
                className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
              >
                ✕
              </button>
            </div>

            {!DEPLOY_ENABLED ? (
              <p className="mt-5 rounded-xl border border-white/12 bg-white/[0.03] p-4 font-mono text-[11px] leading-relaxed text-ink-dim">
                {DEPLOYS_DISABLED_NOTE}
              </p>
            ) : stage === 'set' ? (
              <>
                {/* ── the shared name: the grouping key, edited once — and
                      LOCKED once any network landed with it (it is on-chain
                      there; a rename now would split the bundle in two) ── */}
                {/* ── name + ticker, ONE row from sm (owner 2026-08-12: one
                      control per setting, set once for every network; less
                      scrolling, one glance). Locked lanes carry theirs on-chain. ── */}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <label className="block min-w-0 flex-1">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      bundle name — {BUNDLE_NAME_LAW}
                    </span>
                    <input
                      value={sharedName}
                      onChange={(e) => setSharedName(e.target.value.slice(0, 42))}
                      disabled={nameLocked}
                      placeholder="Bundle name"
                      className="mt-2 w-full rounded-xl border border-white/12 bg-black/30 px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-violet/50 disabled:opacity-60"
                    />
                  </label>
                  <label className="block sm:w-44">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      ticker — every network
                    </span>
                    <span className="mt-2 flex items-center rounded-xl border border-white/12 bg-black/30 px-3.5">
                      <span aria-hidden className="font-num text-sm text-ink-dim">$</span>
                      <input
                        value={ticker}
                        onChange={(e) => setTicker(cleanTicker(e.target.value))}
                        aria-label="Ticker on every network"
                        placeholder="TICKER"
                        className="min-w-0 flex-1 bg-transparent py-2.5 pl-1 font-display text-sm font-bold uppercase tracking-wide text-ink outline-none placeholder:text-ink-faint"
                      />
                    </span>
                  </label>
                </div>
                {nameLocked && (
                  <span className="mt-1.5 block font-mono text-[10px] leading-relaxed text-ink-dim">
                    A basket already shipped carrying this name — the rest join it by keeping it.
                  </span>
                )}

                {/* ── one card per network: what ships there + its readiness.
                      ACROSS the modal's width, not down its height (the owner
                      2026-08-13: "this whole card has way too much height,
                      condense, use more width") — three networks are a row on
                      a laptop, a pair on a tablet, a stack on a phone. ── */}
                {/* phones swipe networks side by side (the mobile pass law:
                    carousels, never a long stack); sm+ keeps the exact grid */}
                <Carousel
                  className="mt-4"
                  label="Networks in this bundle"
                  gridFrom="sm"
                  gridClassName="sm:grid-cols-2 lg:grid-cols-3 sm:gap-2.5"
                  peek="84%"
                >
                  {groups.map((g) => {
                    const landed = liveOf(g.chainId)
                    return (
                      <div key={g.chainId} className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
                        {/* the network's own colors crown its card (the owner live
                            2026-08-15: "way prettier, larger text, less
                            text") — the weight bar IS the header */}
                        <div aria-hidden className="flex h-[7px] w-full">
                          {g.assets.map((a, k) => (
                            <span
                              key={`bar:${a.chainId}:${a.address.toLowerCase()}`}
                              className="h-full"
                              style={{ width: `${g.deployWeights[k]}%`, background: tokenVisual(a.symbol, a.address).color }}
                            />
                          ))}
                        </div>
                        <div className="flex flex-1 flex-col p-4">
                        <div className="flex items-end justify-between gap-2">
                          <ChainBadge chainId={g.chainId} size="md" />
                          <span className="font-display text-xl font-bold tracking-tight text-ink">
                            {g.mixSharePct}%<span className="ml-1.5 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-ink-faint">of the mix</span>
                          </span>
                        </div>
                        <div className="mb-3 mt-3 space-y-1.5">
                          {g.assets.map((a, k) => (
                            <div key={`${a.chainId}:${a.address.toLowerCase()}`} className="flex items-center justify-between text-[14px]">
                              <span className="inline-flex min-w-0 items-center gap-2 font-display font-bold uppercase tracking-wide text-ink">
                                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: tokenVisual(a.symbol, a.address).color }} />
                                <span className="truncate">{showSymbol(a.symbol)}</span>
                              </span>
                              <span className="font-num tabular-nums text-ink-dim">{g.deployWeights[k]}%</span>
                            </div>
                          ))}
                        </div>
                        {landed ? (
                          <p className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-teal">
                            ✓ deployed in the interrupted run — will not deploy again
                          </p>
                        ) : (
                          <>
                            {!g.ready && g.blocker && (
                              <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-amber-200/90">{g.blocker}</p>
                            )}
                            <NetworkReadiness
                              chainId={g.chainId}
                              nativeRaw={nativeOf(g.chainId)}
                              onVerdict={noteVerdict}
                            />
                          </>
                        )}
                        </div>
                      </div>
                    )
                  })}
                </Carousel>

                {/* ── THE FEE, ALREADY ANSWERED — the quiet summary (the owner
                      2026-08-13: "also this has already been set before the
                      popup"). The same three facts the station would ask for,
                      stated instead of asked, with the station one click away.
                      The split bar rides INSIDE the station only: it is the
                      picture of a question being answered, and there is no
                      question here — the row says the same numbers in words at
                      a fraction of the height the owner asked back for. ── */}
                {!showFeeStation && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">the fee</span>
                    <span className="min-w-0 font-mono text-[11px] leading-relaxed text-ink-dim">
                      {feeBps != null ? (feeBps / 100).toFixed(2) : '—'}% fee ·{' '}
                      {creatorShareBps === 0
                        ? 'all to holders'
                        : `${(creatorShareBps / 100).toFixed(0)}% to you · payout ${payoutTrimmed !== '' && payoutValid ? shortAddr(payoutTrimmed) : 'this wallet'}`}{' '}
                      · every network
                    </span>
                    <button
                      type="button"
                      onClick={() => setFeeStationOpen(true)}
                      className="press ml-auto shrink-0 rounded-lg border border-white/12 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-white/35 hover:text-ink"
                    >
                      Change
                    </button>
                  </div>
                )}

                {/* ── THE FEE STATION (owner 2026-08-12) — the builder's own
                      dials, one config written into every network's deploy.
                      The fallback for every path that never asked, and what
                      "Change" reveals for the paths that did. ── */}
                {showFeeStation && (
                <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
                  {/* the split picture rides the header row — who-gets-what at
                      a glance, beside the question instead of under it */}
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      the fee — set once, written into every network&rsquo;s basket
                    </span>
                    <div className="min-w-[220px] flex-1">
                      {/* league-aware: the highest league among the bundle's
                          networks — the conservative floor for the creator */}
                      <FeeSplitBar creatorShareBps={creatorShareBps} leagueBps={Math.max(0, ...groups.map((g) => deploymentFor(g.chainId).leagueShareBps))} />
                    </div>
                  </div>
                  {/* the station rides the modal's WIDTH like the cards above
                      it (the same 2026-08-13 condense ruling): two dials and
                      the payout share one row on a laptop instead of stacking */}
                  <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
                    <FeeSlider
                      id="bundle-fee-pct"
                      label="Total fee"
                      tip={
                        <>
                          The one fee each of these baskets ever charges: taken once per buy, sell or
                          swap, as a % of that trade. Set now, written into every network&rsquo;s
                          contract forever — nobody (including you) can change it later.
                        </>
                      }
                      value={parseFloat(feePct)}
                      onChange={(v) => setFeePct(v.toFixed(2))}
                      min={feeBounds.minFeeBps / 100}
                      max={feeBounds.maxFeeBps / 100}
                      step={0.05}
                      format={(v) => `${v.toFixed(2)}%`}
                      minLabel={`${(feeBounds.minFeeBps / 100).toFixed(2)}% min · default`}
                      maxLabel={`${(feeBounds.maxFeeBps / 100).toFixed(2)}% max`}
                      defaultValue={1}
                    />
                    <FeeSlider
                      id="bundle-creator-share"
                      label="Your share of it"
                      tip={
                        <>
                          {`Every fee first burns ${(feeBounds.burnShareBps / 100).toFixed(0)}% as PRISM and reserves the small protocol slices. This slider is YOUR cut of what remains, paid to your payout address on every trade, on every network. Holders always keep at least ${(100 - feeBounds.maxCreatorShareBps / 100).toFixed(0)}% of the remainder. Fixed forever at deploy.`}
                        </>
                      }
                      value={parseFloat(creatorSharePct)}
                      onChange={(v) => setCreatorSharePct(String(Math.round(v)))}
                      min={0}
                      max={feeBounds.maxCreatorShareBps / 100}
                      step={1}
                      format={(v) => `${Math.round(v)}%`}
                      minLabel="0% · all to holders"
                      maxLabel={`${(feeBounds.maxCreatorShareBps / 100).toFixed(0)}% max`}
                    />
                    {/* the third cell: where the share goes — the payout when
                        one is owed, the plain fact when it is not */}
                    {creatorShareBps === 0 ? (
                      <p className="self-end font-mono text-[10px] leading-relaxed text-teal sm:col-span-2 lg:col-span-1">
                        You&rsquo;re taking no fee — your whole share flows to each basket&rsquo;s holders.
                      </p>
                    ) : (
                      <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                        <label htmlFor="bundle-creator-payout" className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                          your payout address — every network pays it
                        </label>
                        <input
                          id="bundle-creator-payout"
                          value={creatorPayout}
                          onChange={(e) => setCreatorPayout(e.target.value)}
                          placeholder={address ? `${shortAddr(address)} — this wallet (paste another to redirect)` : '0x…'}
                          spellCheck={false}
                          className={`mt-2 w-full rounded-xl border bg-black/30 px-3.5 py-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-violet/50 ${
                            payoutValid ? 'border-white/12' : 'border-alert/50'
                          }`}
                        />
                        {!payoutValid && (
                          <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-alert">
                            That doesn&rsquo;t read as a valid address{payoutHasCase ? ' — its checksum fails; paste it exactly from your wallet' : ''}.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                )}

                {/* the four fact chips left on the owner's note (2026-08-14
                    live, superseding the 2026-08-10 chips round): the cards
                    state their own figures; the plate carries no chip row. */}

                {/* the identity lock, stated BEFORE the click that would hit it
                    (a resumed bundle opened under a second wallet) */}
                {(identityRefusal || shipRefusal) && (
                  <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[11px] leading-relaxed text-amber-200/90">
                    {identityRefusal ?? shipRefusal}
                  </p>
                )}

                {/* ── THE MAIN BUTTON CARRIES THE FUNDING ACTION (the owner
                      2026-08-13) — and states its reach. A short network is
                      short of GAS, and the door delivers the SETTLEMENT token,
                      so the label says which currency actually moves rather
                      than promising a fix it will not perform (fundingPlan
                      owns that reasoning). Publishing stays reachable beside
                      it: readiness is advisory, use-deploy's preflight is the
                      gate that really refuses. ── */}
                {!isConnected ? (
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('spectrum:connect'))}
                    className="press mt-4 w-full rounded-xl border border-white/15 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-ink hover:border-white/35"
                  >
                    Connect a wallet to publish
                  </button>
                ) : funding?.kind === 'door' ? (
                  <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => setFundFor(funding.openChainId)}
                      className="press min-w-0 flex-1 rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.12em] text-black transition-transform hover:scale-[1.01]"
                      style={{ background: 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))' }}
                    >
                      {funding.label}
                    </button>
                    <button
                      type="button"
                      disabled={!nameOk || !tickersOk || !feesOk || !allShapeReady || !!identityRefusal}
                      onClick={beginShip}
                      className="press shrink-0 rounded-xl border border-white/15 px-5 py-3 font-display text-sm font-bold uppercase tracking-[0.12em] text-ink hover:border-white/35 disabled:cursor-not-allowed disabled:opacity-40 sm:w-52"
                    >
                      Publish anyway →
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!nameOk || !tickersOk || !feesOk || !allShapeReady || !!identityRefusal}
                    onClick={beginShip}
                    className="press mt-4 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform enabled:hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ background: 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))' }}
                  >
                    {`Begin — deploy on ${groups.length} networks →`}
                  </button>
                )}
                {isConnected && funding && (
                  <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">{funding.note}</p>
                )}
                {isConnected && !(nameOk && tickersOk && feesOk && allShapeReady) && (
                  <p className="mt-2 text-center font-mono text-[10px] text-ink-faint">
                    {!nameOk
                      ? 'name the bundle (2+ characters)'
                      : !tickersOk
                        ? 'every network needs a ticker (2–11 letters/digits)'
                        : !feesOk
                          ? !feeInBounds
                            ? 'the total fee is outside the protocol bounds'
                            : 'fix the payout address — or dial your share to 0'
                          : `${chainLabel(groups.find((g) => !g.ready && !liveOf(g.chainId))?.chainId ?? groups[0]?.chainId ?? 0)} isn't ready — its card above says why`}
                  </p>
                )}
              </>
            ) : (
              <>
                {/* ── SHIP: the sequential lanes — until they land.
                      THE FINISHED CEREMONY IS THE PLATE, AND ONLY THE PLATE
                      (the owner 2026-08-13, watching a real publish complete: "when
                      the basket is live the top bit should disappear, the
                      bottom bit from complete onwards should show"). The
                      progress strip at N/N and the lane list both said "all
                      live" a second time, above the half that says it better.
                      Done is the model's own verdict (publishProgress.finished),
                      never a second notion of it — and every fact the lane rows
                      carried travels INTO the plate below (a resumed lane's
                      provenance, an unread address), because a resumed or
                      partially-failed run is exactly when it matters. ── */}
                {progress && !(finished && address) && (
                  <div className="mt-5">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                        {finished ? 'all baskets live' : `deploying ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}
                      </span>
                      <span className="font-num text-xs tabular-nums text-ink-dim">
                        {progress.done}/{progress.total}
                      </span>
                    </div>
                    <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{
                          width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                          background: `linear-gradient(90deg, var(--color-cyan), ${ACCENT})`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {!(finished && address) && (
                  <div className="mt-4 space-y-2.5">
                    {(lanes ?? []).map((lane) => (
                      <LaneRowView
                        key={lane.chainId}
                        lane={lane}
                        ticker={tickers[lane.chainId] ?? ''}
                        isActive={active?.chainId === lane.chainId}
                        retryBlocked={!!identityRefusal}
                        onRetry={() => doRetry(lane.chainId)}
                      />
                    ))}
                  </div>
                )}

                {/* the one-action deck: exactly one thing offered at a time —
                    and NOTHING offered while the connected wallet is not this
                    bundle's deployer (the executor carries its own copy of the
                    refusal, so it is never stated twice) */}
                {identityRefusal && active?.state !== 'deploying' && (
                  <p className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 font-mono text-[11px] leading-relaxed text-amber-200/90">
                    {identityRefusal}
                  </p>
                )}
                {!identityRefusal && active?.state === 'switch' && <SwitchOffer sw={sw} chainId={active.chainId} />}
                {active?.state === 'deploying' && (
                  <LaneExecutor
                    key={active.chainId}
                    chainId={active.chainId}
                    group={groups.find((g) => g.chainId === active.chainId)!}
                    sharedName={sharedName.trim()}
                    ticker={tickers[active.chainId] ?? ''}
                    feeBps={feeBps ?? Math.min(Math.max(100, feeBounds.minFeeBps), feeBounds.maxFeeBps)}
                    creatorShareBps={creatorShareBps}
                    payoutOverride={payoutTrimmed !== '' && payoutValid ? (payoutTrimmed as Address) : null}
                    sw={sw}
                    walletChainId={walletChainId}
                    armBlocked={identityRefusal}
                    onStage={(words) => patchLane(active.chainId, { note: words })}
                    onBusy={setSigningNow}
                    onDone={(token, deployer) => {
                      // THE ANCHOR IS TAKEN HERE — from the wallet that just
                      // landed a basket, not from an intention held earlier.
                      // Every later lane is measured against it, and it rides
                      // with the persisted row so a reload cannot launder it.
                      if (!sessionDeployer && deployer) setSessionDeployer(deployer)
                      // the caller remembers landed deploys, so an interrupted
                      // ceremony reopens without re-deploying them
                      onLaneDone?.(active.chainId, token, sharedName.trim())
                      // …and the anchor merges into the row the caller just
                      // wrote (write-once: a second wallet can never move it)
                      setLandedDeployer(sharedName.trim(), deployer)
                      patchLane(active.chainId, {
                        state: 'done',
                        newAddress: token,
                        note: token ? null : ADDRESS_UNREAD_NOTE,
                      })
                    }}
                    onFail={(message) => patchLane(active.chainId, { state: 'failed', note: message })}
                  />
                )}
                {!identityRefusal && active?.state === 'failed' && (
                  <button
                    type="button"
                    onClick={() => doRetry(active.chainId)}
                    className="press mt-4 w-full rounded-xl border border-amber-400/40 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-amber-200 hover:border-amber-400/70"
                  >
                    Retry the deploy on {chainLabel(active.chainId)}
                  </button>
                )}

                {/* THE CREATION SHOW (the owner live 2026-08-15: "the beautiful
                    creation animation with the asset orbs coming together, I
                    want that before showing the seed popup") — the REAL
                    DeployPortal in show-only mode, played once when the last
                    lane lands; the seed door waits behind it. */}
                {finished && address && !ceremonyPlayed && (
                  <DeployPortal
                    open
                    onClose={() => setCeremonyPlayed(true)}
                    onStartOver={() => setCeremonyPlayed(true)}
                    chainId={groups[0]?.chainId ?? 8453}
                    name={sharedName.trim()}
                    symbol={Object.values(tickers)[0] ?? sharedName.trim()}
                    grad="linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))"
                    blend={['var(--color-violet-bright)', 'var(--color-magenta)', 'var(--color-amber)']}
                    assets={groups.flatMap((g) => g.assets.map((a) => ({ address: a.address, symbol: a.symbol })))}
                    bentoItems={groups.flatMap((g) => g.assets.map((a, i) => ({ symbol: a.symbol, address: a.address, weightPct: g.deployWeights[i] ?? 0, chainId: g.chainId })))}
                    showOnly={() => setCeremonyPlayed(true)}
                  />
                )}
                {finished && address && ceremonyPlayed && (
                  <SuccessPlate
                    lanes={lanes ?? []}
                    tickers={tickers}
                    groups={groups}
                    deployer={address}
                    name={sharedName.trim()}
                    onSeedOverlayChange={setSeedOverlayOpen}
                    onClose={onClose}
                  />
                )}

                {escArm && (
                  <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
                    A signature may be waiting in your wallet. Press Esc again (or ✕) to close — finished networks
                    keep their baskets.
                  </p>
                )}
                {/* the interruption footer, centered and one type step up
                    (the owner 2026-08-13) — the reshape ceremony's own footer
                    reads the same way, so the two never drift */}
                {!finished && (
                  <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-ink-faint">
                    {PUBLISH_INTERRUPTION_NOTE}
                  </p>
                )}
              </>
            )}

            <div aria-live="polite" className="sr-only">
              {announce}
            </div>
          </div>
        </Bezel>
      </div>

      {/* the funding door, opened from the ONE main button (the owner 2026-08-13),
          never from a card. BridgeFund delivers the destination chain's
          SETTLEMENT token — not its gas coin, which is what a short deploy
          actually needs — so the button that opens it says so out loud rather
          than promising a fix this flow cannot perform (fundingPlan). */}
      {fundFor != null && <BridgeFund destChainId={fundFor} onClose={() => setFundFor(null)} />}
    </div>,
    document.body,
  )
}

/** One network's gas verdict — the wallet's native coin against the LIVE
 *  deploy price + the hook's own headroom (deployReadiness mirrors that
 *  preflight exactly, so "ready" here never bounces there). Unreadable is
 *  stated as unknown, never scored.
 *
 *  THE DIAGNOSIS, NOT THE DOOR (the owner 2026-08-13). The card used to carry its
 *  own "Move funds →" button; the action now lives on the ceremony's one main
 *  button, so this reports its verdict UP (the price is a hook, so the read has
 *  to happen here) and states the facts in a label instead of a sentence —
 *  every figure kept, at a third of the width. */
function NetworkReadiness({
  chainId,
  nativeRaw,
  onVerdict,
}: {
  chainId: number
  nativeRaw: bigint | null
  onVerdict: (chainId: number, kind: DeployReadiness['kind']) => void
}) {
  const { data: price } = useDeployPrice(chainId, true)
  const r = deployReadiness(chainId, nativeRaw, price?.priceWei ?? null)
  const tone = r.kind === 'ready' ? 'text-teal' : r.kind === 'short' ? 'text-amber-200/90' : 'text-ink-dim'
  // report on CHANGE only: the verdict object is fresh each render, its kind is not
  useEffect(() => {
    onVerdict(chainId, r.kind)
  }, [chainId, r.kind, onVerdict])
  return (
    <p className={`mt-auto border-t border-white/8 pt-2.5 leading-relaxed ${tone}`} title={r.words}>
      {r.kind === 'ready' ? (
        // the happy case is a CHECK, not a sentence (the owner 2026-08-15: less
        // text) — the full figures stay one hover away in the title
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]">✓ gas covered</span>
      ) : (
        <span className="font-mono text-[11px]">{r.brief}</span>
      )}
    </p>
  )
}

/** The switch offer. Since 2026-08-13 the ceremony has already ASKED once by
 *  the time this renders (useLaneAutoSwitch) — this is the fallback that makes
 *  a refusal a pause rather than a dead end: the same mutation, the same
 *  declined copy, clicked by hand. The sequencer advances only on the OBSERVED
 *  chain, so switching inside the wallet itself works identically. */
function SwitchOffer({ sw, chainId }: { sw: NetworkSwitch; chainId: number }) {
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={sw.switchNow}
        disabled={sw.switching}
        className="press w-full rounded-xl border border-white/15 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-ink hover:border-white/35 disabled:opacity-60"
      >
        {sw.switching ? 'Confirm in wallet…' : `Switch to ${chainLabel(chainId)}`}
      </button>
      <p className="mt-2 text-center font-mono text-[10px] text-ink-faint">switching networks signs nothing</p>
      {sw.declined && (
        <p className="mt-1 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">
          Your wallet stayed on {sw.walletWords}, so nothing was sent — try again when you&rsquo;re ready.
        </p>
      )}
    </div>
  )
}

/** One lane's row: chain · ticker · the [switch → deploy] walk · note/retry. */
function LaneRowView({
  lane,
  ticker,
  isActive,
  retryBlocked,
  onRetry,
}: {
  lane: PublishLane
  ticker: string
  isActive: boolean
  /** The identity lock is on: re-arming would deploy under a second wallet. */
  retryBlocked: boolean
  onRetry: () => void
}) {
  const marks = publishLaneMarks(lane)
  const shell =
    lane.state === 'done'
      ? 'border-teal/25'
      : lane.state === 'failed'
        ? 'border-amber-400/35'
        : isActive
          ? 'border-white/15'
          : 'border-white/8 opacity-75'
  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-white/[0.02] px-4 py-3 transition-colors ${shell}`}
      style={isActive ? { borderColor: `${ACCENT}59`, boxShadow: `inset 0 0 24px ${ACCENT}0f` } : undefined}
    >
      {/* wraps rather than squeezes: an 11-char ticker + the address short
          share one phone line only when they genuinely fit */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <ChainBadge chainId={lane.chainId} size="md" />
        <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
          ${showSymbol(ticker)}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-faint">
          {lane.newAddress ? shortAddr(lane.newAddress) : null}
        </span>
      </div>
      {/* the moving bar while a deploy is genuinely working (the owner live
          2026-08-15: "needs to be more obvious something is happening") */}
      {isActive && lane.state !== 'done' && lane.state !== 'failed' && <RunBeam accent={ACCENT} />}
      {lane.state === 'done' ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-teal">✓ basket live</p>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          {marks.map((m, i) => (
            <span key={m.key} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="h-px w-3 bg-white/10" />}
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]">
                {m.state === 'done' ? (
                  <span className="text-teal">✓</span>
                ) : m.state === 'failed' ? (
                  <span className="text-amber-300">⚠</span>
                ) : m.state === 'active' ? (
                  <span aria-hidden className="h-2 w-2 animate-pulse rounded-full" style={{ background: ACCENT }} />
                ) : (
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/15" />
                )}
                <span className={m.state === 'todo' ? 'text-ink-faint' : 'text-ink-dim'}>{m.label}</span>
              </span>
            </span>
          ))}
        </div>
      )}
      {lane.note && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-ink-dim">{lane.note}</p>
          {lane.state === 'failed' && !retryBlocked && (
            <button
              type="button"
              onClick={onRetry}
              className="press min-h-[36px] shrink-0 rounded-lg border border-amber-400/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200 hover:border-amber-400/70"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The active lane's whole deploy machine — mounted for EXACTLY ONE chain at a
 *  time (keyed by the parent), so useDeployBasket never sees an unvetted or
 *  parallel chain. Prepare arms on mount; broadcast waits for the CTA. */
function LaneExecutor({
  chainId,
  group,
  sharedName,
  ticker,
  feeBps,
  creatorShareBps,
  payoutOverride,
  sw,
  walletChainId,
  armBlocked,
  onStage,
  onBusy,
  onDone,
  onFail,
}: {
  chainId: number
  group: BundleGroup
  sharedName: string
  ticker: string
  /** The SET stage's shared fee station — one config, every network. */
  feeBps: number
  creatorShareBps: number
  /** A payout the creator pasted; null = the connected wallet (the default). */
  payoutOverride: Address | null
  sw: NetworkSwitch
  walletChainId: number | undefined
  /** The identity lock's refusal, or null. Non-null holds the ARM itself — a
   *  foreign wallet never reaches prepare(), so nothing is built and nothing
   *  can be signed. This component stays MOUNTED either way: unmounting it
   *  mid-flight would orphan a signature already out in the wallet, and a
   *  landed deploy nobody recorded is the one loss worse than this bug. */
  armBlocked: string | null
  onStage: (words: string) => void
  onBusy: (busy: boolean) => void
  /** The landed basket AND the wallet that deployed it — the ceremony anchors
   *  its identity on the second argument. */
  onDone: (token: `0x${string}` | null, deployer: string | null) => void
  onFail: (message: string) => void
}) {
  const { address } = useAccount()
  const deploy = useDeployBasket(chainId)
  const { data: bounds } = useFeeBounds(chainId)
  const { data: allBaskets } = useAllBaskets()

  // PREPARE ON ARM (mount): fee config is the SET stage's fee station (owner
  // 2026-08-12 — the creator's total fee, share, and payout, written into
  // every network's deploy; a pasted payout overrides the connected-wallet
  // default). Clamped once more against THIS chain's bounds — belt and
  // braces; today the bounds are protocol constants, identical everywhere.
  // Launcher via deriveLauncher (referral is one-shot: marked used on the
  // arm that applies it, the builder's exact policy — a later lane in this
  // same ceremony reverts to the operator).
  const startedRef = useRef(false)
  // The wallet this lane ARMED under — the deploy is built against it (fee
  // payout included), so it is what we report as the deployer when it lands.
  const armedByRef = useRef<string | null>(null)
  useEffect(() => {
    if (startedRef.current || !address) return
    if (armBlocked) return // the identity lock: never prepare under a foreign wallet
    startedRef.current = true
    armedByRef.current = address
    const laneFeeBps = Math.min(Math.max(feeBps, bounds.minFeeBps), bounds.maxFeeBps)
    const laneShareBps = Math.min(creatorShareBps, bounds.maxCreatorShareBps)
    const { launcher, appliedReferrer } = deriveLauncher({
      account: address,
      allBaskets,
      referrer: getStoredRef(),
      refAlreadyUsed: hasCreatorRefBeenUsed(),
    })
    if (appliedReferrer) markCreatorRefUsed()
    const feeConfig: FeeConfigInput = {
      basketFeeBps: laneFeeBps,
      creatorShareBps: laneShareBps,
      creatorPayout: (laneShareBps > 0 ? (payoutOverride ?? address) : ZERO_ADDR) as Address,
      launcher,
    }
    void deploy.prepare({
      name: sharedName,
      symbol: ticker,
      assets: group.assets.map((a) => ({ address: a.address, decimals: a.decimals, route: a.route })),
      weights: group.deployWeights,
      feeConfig,
      // no seed — the bundle ceremony deploys; buying comes after, on the
      // bundle's own page
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, armBlocked])

  // Report terminal outcomes exactly once; stage words as they change.
  const lastStatusRef = useRef<string | null>(null)
  useEffect(() => {
    if (deploy.status === lastStatusRef.current) return
    lastStatusRef.current = deploy.status
    onBusy(deploy.status === 'signing' || deploy.status === 'confirming' || deploy.status === 'seeding')
    if (deploy.status === 'success') {
      // A confirmed deploy whose receipt hid the address is DONE, never failed
      // — retrying would ship a paid duplicate (the model's ADDRESS_UNREAD rule).
      onDone((deploy.token as `0x${string}` | null) ?? null, armedByRef.current)
      return
    }
    if (deploy.status === 'error') {
      onFail(deploy.error ?? 'The deploy failed.')
      return
    }
    const words = deployStageWords(deploy.status, deploy.attempts)
    if (words) onStage(words)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploy.status, deploy.token, deploy.error, deploy.attempts])

  const preparing = deploy.status === 'mining' || deploy.status === 'preparing' || deploy.status === 'idle'
  const busy = deploy.status === 'signing' || deploy.status === 'confirming' || deploy.status === 'seeding'
  const mismatch = walletChainId !== chainId
  const priceWords =
    deploy.priceWei != null ? `${(Number(deploy.priceWei) / 1e18).toFixed(4)} ETH + gas` : 'the network’s deploy price + gas'

  return (
    <div className="mt-4">
      {armBlocked ? (
        <p className="mb-3 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          {armBlocked}
        </p>
      ) : (
        <WrongNetworkNotice requiredChainId={chainId} action="This deploy signs" sw={sw} compact className="mb-3" />
      )}
      <button
        type="button"
        disabled={preparing || busy || mismatch || !!armBlocked || !deploy.enabled}
        onClick={() => void deploy.broadcast()}
        className="press w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform enabled:hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))' }}
      >
        {armBlocked
          ? 'Wrong wallet for this bundle'
          : busy
            ? deploy.status === 'confirming'
              ? 'Confirming…'
              : 'In your wallet…'
            : preparing
              ? (deployStageWords(deploy.status, deploy.attempts) ?? 'Preparing…')
              : `Deploy on ${chainLabel(chainId)} — ${priceWords}`}
      </button>
    </div>
  )
}

/** Every lane landed: each basket's own door plus the bundle's — the grouper
 *  recognises them on read, so the link is derivable the moment the last
 *  deploy confirms (use-deploy's own blanket invalidation refreshes the list).
 *  And the plate's PRIMARY act (owner 2026-08-12): the baskets are live and
 *  EMPTY — the seed door opens the whole bundle with one stake, through the
 *  run overlay's own routing/bridging, split by the Composer's mix shares.
 *  When the door renders it is the plate's one gradient; the bundle link
 *  demotes to the bordered row beside Done. */
function SuccessPlate({
  lanes,
  tickers,
  groups,
  deployer,
  name,
  onSeedOverlayChange,
  onClose,
}: {
  lanes: PublishLane[]
  tickers: Record<number, string>
  groups: BundleGroup[]
  deployer: string
  name: string
  onSeedOverlayChange: (open: boolean) => void
  onClose: () => void
}) {
  const seedPlan = publishSeedPlan(lanes, tickers, groups)
  const hasDoor = seedPlan.legs.length > 0
  // ── THE POST-SEED FLOW (owner 2026-08-15 11:49: "the flow is concrete from
  // A to Z"). The plate WATCHES the chain for the seed landing (supply 0→>0 on
  // every seedable leg — the claim ceremony's own transition, so a bumped-off
  // or re-opened plate still knows), then walks: thesis (ONE text, one quick
  // gasless signature per basket — no transactions, said out loud) → the share
  // card → the bundle's page. Done goes to the BUNDLE, never back to create
  // (his exact bump). Words persist through the same signed-metadata path the
  // studio uses (deploy-key EIP-712, saveLocalMetadata; publishes wider when
  // the relay ships).
  const navigate = useNavigate()
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const qc = useQueryClient()
  const goBundle = () => {
    // The freshly-published legs are usually NOT in the per-chain basket
    // lists yet — the bundle page groups from those lists, and a stale one
    // makes the bundle read as ONE leg (owner queue item 2026-08-16: "thesis
    // publish lands on ONE leg, not /bundle/:creator/:slug"). Invalidate the
    // published chains' lists so the page groups the whole bundle on arrival.
    for (const l of lanes) void qc.invalidateQueries({ queryKey: ['spectrum', 'baskets', l.chainId] })
    navigate(thesisHref(deployer, name))
    onClose()
  }
  // ⚠ THE WATCH MUST NOT SWAP THE FACE UNDER A LIVE RUN (owner live 2026-08-16:
  // seeding one basket kicked him out of the seed and back to the create flow).
  // The run overlay is MOUNTED INSIDE the door below; the 12s seeded-watch (or
  // its window-focus refetch, which fires the moment the wallet hands focus
  // back) flips `seededAll` mid-run and the branch unmounts door + overlay
  // together — before the finished plate is ever seen. While the overlay is up,
  // the door face stays; the swap happens when the user closes the run.
  const [seedOverlayUp, setSeedOverlayUp] = useState(false)
  const { data: seededAll } = useQuery({
    queryKey: ['seeded-watch', seedPlan.legs.map((l) => `${l.chainId}:${l.address.toLowerCase()}`).join(',')],
    queryFn: async () => {
      const sups = await Promise.all(seedPlan.legs.map((l) => basketSupply(l.chainId, l.address)))
      return sups.length > 0 && sups.every((x) => x != null && x > 0n)
    },
    enabled: hasDoor,
    refetchInterval: (q) => (q.state.data ? false : 12_000),
  })
  const [thesisText, setThesisText] = useState('')
  const [sign, setSign] = useState<{ done: number; total: number; error: string | null; finished: boolean; on?: string }>({ done: 0, total: 0, error: null, finished: false })
  // ON-CHAIN publishing (owner 2026-08-15: "it should always be onchain
  // publishing so others can see it") — one SpectrumNotes setNote tx per
  // basket, the ThesisEditor's exact mechanism, live for every visitor the
  // moment it confirms. Fresh baskets carry no prior note, so thesis-only.
  const signAll = async () => {
    const text = thesisText.trim()
    if (!text) return
    const targets = lanes.filter((l) => l.newAddress)
    setSign({ done: 0, total: targets.length, error: null, finished: false })
    try {
      for (let i = 0; i < targets.length; i++) {
        const lane = targets[i]
        const registry = chainCfg(lane.chainId).notesRegistry
        if (!registry) throw new Error(`${chainLabel(lane.chainId)} has no notes registry configured here — its basket keeps the words unpublished for now`)
        setSign((st) => ({ ...st, on: chainLabel(lane.chainId) }))
        try {
          await switchChainAsync({ chainId: lane.chainId })
        } catch {
          /* already there, or the wallet prompts at signing */
        }
        const h = await writeContractAsync({
          address: registry as Address,
          abi: notesRegistryAbi,
          functionName: 'setNote',
          args: [
            lane.newAddress as Address,
            NOTE_KINDS.thesis,
            encodeBasketMetaJson({ thesis: text, tagline: null, sectors: null, timeHorizon: null, postUrl: null }),
          ],
          chainId: lane.chainId,
        })
        await clientFor(lane.chainId).waitForTransactionReceipt({ hash: h })
        setSign((st) => ({ ...st, done: i + 1 }))
      }
      setSign((st) => ({ ...st, finished: true }))
    } catch (e) {
      setSign((st) => ({ ...st, error: e instanceof Error ? (e.message.split('\n')[0] ?? 'the transaction was declined') : 'the transaction was declined — you can finish from your creator page any time' }))
    }
  }
  const shareLeg = seedPlan.legs[0] ?? null
  return (
    <div className="mt-6 rounded-2xl border border-white/12 bg-white/[0.03] p-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: ACCENT }}>
        complete
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink-dim">
        {lanes.length === 1 ? 'Your basket is live.' : `All ${lanes.length} baskets are live — together, they are the bundle.`}
      </p>
      {/* Every row the lane list used to show, and everything it could SAY:
          the lane note travels here (a resumed lane's "landed in the
          interrupted run", a confirmed-but-unread address and what to do about
          it). A finished ceremony has no failed lane by construction —
          publishProgress only finishes when every lane is done — so the notes
          below are the whole of what the list could still be carrying. */}
      <div className="mt-4 space-y-2.5">
        {lanes.map((lane) => (
          <div key={lane.chainId}>
            <div className="flex items-center gap-2.5">
              <ChainBadge chainId={lane.chainId} size="md" />
              <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                ${showSymbol(tickers[lane.chainId] ?? '')}
              </span>
              {lane.newAddress && (
                <Link
                  to={`/token?addr=${lane.newAddress}&chain=${lane.chainId}`}
                  className="ml-auto font-mono text-[11px] text-ink-dim underline decoration-white/25 underline-offset-4 hover:text-ink"
                >
                  view its page · {shortAddr(lane.newAddress)}
                </Link>
              )}
            </div>
            {lane.note && (
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-faint">{lane.note}</p>
            )}
          </div>
        ))}
      </div>
      {hasDoor && (!seededAll || seedOverlayUp) ? (
        <>
          <SeedBundleDoor
            plan={seedPlan}
            name={name}
            deployer={deployer}
            accent={ACCENT}
            gradient="linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))"
            textClass="text-black"
            onOverlayChange={(up) => {
              setSeedOverlayUp(up)
              onSeedOverlayChange(up)
            }}
          />
          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
            <Link
              to={thesisHref(deployer, name)}
              className="press flex-1 rounded-xl border border-white/12 py-3 text-center font-display text-sm font-bold uppercase tracking-[0.15em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              View the bundle →
            </Link>
            <button
              type="button"
              onClick={goBundle}
              className="press flex-1 rounded-xl border border-white/12 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              Done
            </button>
          </div>
        </>
      ) : hasDoor && seededAll && !sign.finished ? (
        <div className="mt-5 border-t border-white/8 pt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">✓ seeded — one step left</p>
          <label htmlFor="bundle-thesis" className="mt-2 block font-display text-lg font-bold uppercase tracking-tight text-ink">
            Write the thesis — why this mix
          </label>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            one text · published on-chain onto every basket · one small transaction each · live for everyone
          </p>
          <textarea
            id="bundle-thesis"
            value={thesisText}
            onChange={(e) => setThesisText(e.target.value)}
            rows={4}
            placeholder="What this bundle believes, in your own words…"
            className="mt-3 w-full resize-none rounded-xl border border-white/12 bg-black/30 p-3.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-white/30"
          />
          {sign.error && <p className="mt-2 font-mono text-[11px] leading-relaxed text-amber-200/90">{sign.error}</p>}
          <button
            type="button"
            disabled={!thesisText.trim() || (sign.total > 0 && sign.done < sign.total && !sign.error)}
            onClick={() => void signAll()}
            className="press mt-3 inline-flex h-12 w-full items-center justify-center rounded-xl font-display text-[13px] font-bold uppercase tracking-[0.14em] text-black disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))' }}
          >
            {sign.total > 0 && sign.done < sign.total && !sign.error
              ? `publishing on ${sign.on ?? 'its network'} — ${Math.min(sign.done + 1, sign.total)} of ${sign.total} · check your wallet…`
              : `Publish onto ${lanes.filter((l) => l.newAddress).length === 1 ? 'the basket' : `all ${lanes.filter((l) => l.newAddress).length} baskets`} →`}
          </button>
          <button type="button" onClick={goBundle} className="press mt-2.5 w-full py-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink">
            skip for now — straight to the bundle →
          </button>
        </div>
      ) : hasDoor && seededAll && sign.finished ? (
        <div className="mt-5 border-t border-white/8 pt-4 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">✓ seeded · ✓ thesis live on-chain, on every basket</p>
          {/* THE CREATOR-PAGE STEP (owner's queue: "creator-profile step
              missing from the publish flow") — the launch moment is when a
              name matters most, so the REAL ClaimHandle rides the ceremony
              here. It self-resolves: unclaimed shows the claim form; owned
              collapses to the one "Published to /creator/x" line. Skipping
              costs nothing — the studio keeps the offer. */}
          <div className="mx-auto mt-4 max-w-md rounded-xl border border-white/10 bg-white/[0.02] p-4 text-left">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">your creator page</p>
            <ClaimHandle className="mt-3" />
          </div>
          <p className="mx-auto mt-4 max-w-[46ch] text-[13px] leading-relaxed text-ink-dim">
            Grab the share card — the drawn bundle image, ready to copy or save — then land on its page.
          </p>
          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
            {shareLeg && (
              <Link
                /* the drawn card opens on the leg's page; CLOSING it lands on
                   the BUNDLE (owner 2026-08-16: "the see and share [goes] to
                   the bundle/basket image you can copy etc and then after
                   that it should take you to the bundle/basket page") */
                to={`/token?addr=${shareLeg.address}&chain=${shareLeg.chainId}&share=1&then=${encodeURIComponent(thesisHref(deployer, name))}`}
                className="press flex-1 rounded-xl py-3 text-center font-display text-sm font-bold uppercase tracking-[0.15em] text-black"
                style={{ background: 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))' }}
              >
                See &amp; share your card →
              </Link>
            )}
            <button
              type="button"
              onClick={goBundle}
              className="press flex-1 rounded-xl border border-white/12 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              Your bundle →
            </button>
          </div>
        </div>
      ) : (
        <>
          <Link
            to={thesisHref(deployer, name)}
            className="press mt-5 block w-full rounded-xl py-3 text-center font-display text-sm font-bold uppercase tracking-[0.15em] text-black"
            style={{ background: 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))' }}
          >
            View the bundle →
          </Link>
          <button
            type="button"
            onClick={goBundle}
            className="press mt-2.5 w-full rounded-xl border border-white/12 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            Done
          </button>
        </>
      )}
    </div>
  )
}
