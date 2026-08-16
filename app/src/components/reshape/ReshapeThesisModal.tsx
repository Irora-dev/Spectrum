import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { shortAddr } from '../../lib/spectrum/format'
import { basketHref } from '../../lib/spectrum/short-url'
import { useAllBaskets, useBasketData } from '../../lib/spectrum/hooks'
import { useDeployBasket } from '../../lib/spectrum/use-deploy'
import { deriveLauncher, useVersionSeed } from '../../lib/spectrum/version-seed'
import { getStoredRef, hasCreatorRefBeenUsed, markCreatorRefUsed } from '../../lib/spectrum/referral'
import { useLineageSign } from '../../lib/spectrum/use-lineage-sign'
import { useNetworkSwitch, WrongNetworkNotice, type NetworkSwitch } from '../WrongNetwork'
import { ChainBadge, chainMeta } from '../ChainBadge'
import { Bezel, EASE, Eyebrow } from '../home/Spine'
import { chainLabel } from '../thesis/run-lanes'
import type { ConstituentDiff } from '../../lib/spectrum/versioning'
import { liveAddEffects } from './ShapeEditor'
import { AssetLogo } from '../AssetLogo'
import { AssetSearchModal } from '../AssetSearchModal'
import { BasketBento, type BentoItem } from '../BasketBento'
import { TrimBar } from '../TrimBar'
import { searchTokens } from '../../lib/spectrum/token-search'
import { isDemoLegAddress } from '../../lib/spectrum/thesis-run-types'
import { CAP, equalSplit, MAX_ASSETS, MIN, STEP } from '../../lib/spectrum/weights'
import { clampSymbolInput, validateAddAsset } from './reshape-model'
import { SeedBundleDoor } from './SeedBundleDoor'
import { reshapeSeedPlan } from './seed-plan'
import { compileChains, mergeUnion, unionKey, type CompiledChain, type UnionEdits, type UnionEntry } from './bundle-union'
import { useLaneAutoSwitch } from './use-auto-switch'
import type { ReshapeDraft, ReshapeLeg, ReshapeThesisModalProps, ThesisReshapeLane, VersionSeedResult } from './reshape-types'
import {
  activeLane,
  advanceLane,
  announceLane,
  composeReshapeLanes,
  DEMO_RESHAPE_REFUSAL,
  demoLaneScript,
  demoReshapeRefusal,
  deployStageWords,
  draftDiffFrom,
  honestyPlateWords,
  INTERRUPTION_NOTE,
  laneMarks,
  LINEAGE_REFUSED_NOTE,
  reshapeProgress,
  retryLane,
  runnableLanes,
  type LanePatch,
} from './thesis-reshape-model'

// ─────────────────────────────────────────────────────────────────────────────
// RESHAPE THE BUNDLE — one popup that edits a whole bundle (one basket per
// chain sharing (deployer, name)) and ships the edit as a NEW VERSION on each
// chain, one network at a time. Three stages:
//
//   SHAPE  — the bundle name edited ONCE (it is the grouping key), tickers
//            keep-same by default behind a change toggle, then ONE union mix
//            editor over every network's seeded draft (owner 2026-08-12: no
//            chain selection — reweight/add/remove once, compileChains maps
//            the edit onto each network's own basket, and a network whose
//            compiled draft is unchanged AUTO-SKIPS: it ships nothing and its
//            current version keeps trading). Seeds stay hooks-per-leg via the
//            keyed collector (the LegTradeExecutor pattern).
//   REVIEW — per-chain diff summaries (the versioning diff law, prev version
//            vs draft) + the honesty plate: this is N deploys + N signatures,
//            the current baskets stay exactly as they are.
//   SHIP   — the sequential ceremony, the run overlay's grammar: one lane per
//            un-skipped leg, ONE action at a time — switch (CALLED for the
//            creator since 2026-08-13, see the supersession below) → deploy
//            (the real useDeployBasket; prepare on arm, broadcast on the CTA)
//            → the silent lineage signature. A failed lane holds the queue;
//            retry reads the lane's own evidence (deploy landed ⇒ retry
//            re-offers only the signature).
//
// THE SWITCH IS NOW TAKEN, NOT ONLY OFFERED — A SUPERSESSION, STATED. This
// ceremony read "switch is OFFERED (never taken)" until 2026-08-13, when the owner
// ruled the opposite for the in-ceremony lane advance: "can we auto switch them
// to the next chain, save them a click to switch to eth/base etc". So when the
// cursor lands on a network the wallet is not on, the ceremony CALLS the switch
// itself — once per lane, through the app's own useNetworkSwitch (never a raw
// window.ethereum). The wallet still shows its own prompt, so consent has not
// moved; we saved OUR click, not the wallet's. The switch step STILL completes
// only on the OBSERVED wallet chain, never on the call's return. Never while a
// signature is out, never after a refusal (the manual offer below takes over,
// unchanged), and NEVER in a walkthrough. Laws + reasoning: auto-switch.ts.
//
// NOT ATOMIC, AND SAYS SO. Each network is its own deploy and its own
// signature. There is no persistence machinery in v1 — a deploy leaves a
// durable artifact (the new basket itself), and the footer states the
// recovery story: finished networks keep their new versions; an unsigned
// lineage is linkable later from the new basket's own page.
//
// DEMO MODE is the same lanes driven by DEMO_DEPLOY_SCRIPT (the contract's
// pacing), nothing armed. LAUNCH PRESENTATION (owner 2026-08-10, extended to
// edit ceremonies 2026-08-12): the walkthrough wears the real ceremony's face —
// no pinned chip, the real footer; only the pacing labels and the finish
// plate's copy admit the walk (the real plate claims live versions, which a
// walkthrough must not). Safe because the guard is in the MACHINE: a REAL
// ceremony against a synthetic leg refuses at mount, at compose, and at the
// executor — refusal-first, the thesis-run law.
//
// The lane machine behind the ship stage is pure and tested:
// thesis-reshape-model.ts / thesis-reshape-model.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** The lineage family's house colour (LinkPredecessor, the version surfaces) —
 *  hex because the lane chrome alpha-suffixes it, the run overlay's idiom. */
const ACCENT = '#a48bff'

type StageK = 'shape' | 'review' | 'ship'

export function ReshapeThesisModal({ deployer, name, legs, demo = false, onClose }: ReshapeThesisModalProps) {
  const { address, isConnected, chainId: walletChainId } = useAccount()

  // Refusal-first: a real ceremony over synthetic legs never even opens the
  // editor (the executor and compose re-check — belt and braces).
  const mountRefusal = useMemo(
    () => (legs.length === 0 ? 'This bundle has no legs to reshape.' : demoReshapeRefusal(legs, demo)),
    [legs, demo],
  )

  const [stage, setStage] = useState<StageK>('shape')
  const [sharedName, setSharedName] = useState(name)
  const [seeds, setSeeds] = useState<Record<number, VersionSeedResult>>({})
  const [drafts, setDrafts] = useState<Record<number, ReshapeDraft>>({})
  // ONE EDIT SURFACE (owner 2026-08-12: "the chain selection shouldnt be
  // needed — you reweight the whole basket and add assets and we then
  // know/compute which assets need updating on each chain"). The creator's
  // edits live here as UNION operations; compileChains applies them to every
  // network's own current draft and a network whose compiled draft is
  // unchanged ships NOTHING (auto-skip is a computation, not a toggle).
  const [reweights, setReweights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [removals, setRemovals] = useState<ReadonlySet<string>>(() => new Set())
  const [adds, setAdds] = useState<UnionEdits['adds'][number][]>([])
  // TICKERS default to keep-same (owner 2026-08-12: "the default should be to
  // keep the same ticker and give people a toggle if they do want to change
  // it") — and the change is ONE input for every network (same owner, same
  // day: one control per setting, never one per chain).
  const [newTicker, setNewTicker] = useState('')
  const [changeTickers, setChangeTickers] = useState(false)
  const [lanes, setLanes] = useState<ThesisReshapeLane[] | null>(null)
  const [shipRefusal, setShipRefusal] = useState<string | null>(null)
  const [signingNow, setSigningNow] = useState(false)
  const [escArm, setEscArm] = useState(false)
  const [announce, setAnnounce] = useState('')
  // The seed run overlay portals OVER this ceremony and both listen to window
  // Escape — while it is up, this ceremony's close stands down (the overlay
  // owns the key, and closing the ceremony underneath it would orphan the run).
  const [seedOverlayOpen, setSeedOverlayOpen] = useState(false)
  const escArmRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // ── seeding (one hook call per leg, via the keyed collector below) ──────────
  const adoptSeed = useCallback((chainId: number, r: VersionSeedResult) => {
    setSeeds((prev) => ({ ...prev, [chainId]: r }))
    if (r.status === 'ready' && r.draft) {
      // adopt once — never clobber a draft the creator has touched
      setDrafts((prev) => (prev[chainId] ? prev : { ...prev, [chainId]: r.draft! }))
    }
  }, [])

  // ── the union view + the per-chain compilation (all pure, all live) ─────────
  const draftsMap = useMemo(() => {
    const m = new Map<number, ReshapeDraft>()
    for (const l of legs) {
      const d = drafts[l.chainId]
      if (d) m.set(l.chainId, d)
    }
    return m
  }, [legs, drafts])
  const union = useMemo(() => mergeUnion(draftsMap), [draftsMap])
  const edits: UnionEdits = useMemo(() => ({ reweights, removals, adds }), [reweights, removals, adds])
  const compiled = useMemo(() => compileChains(draftsMap, edits), [draftsMap, edits])
  const compiledFor = useCallback(
    (chainId: number) => compiled.find((c) => c.chainId === chainId) ?? null,
    [compiled],
  )

  const nameOk = sharedName.trim().length > 0
  const nameChanged = sharedName.trim() !== name
  // the shared current ticker, when every network agrees — the change input's
  // natural placeholder (they usually do; a bundle is one product)
  const commonTicker = useMemo(() => {
    const syms = [...new Set(legs.map((l) => drafts[l.chainId]?.symbol).filter((x): x is string => !!x))]
    return syms.length === 1 ? syms[0] : null
  }, [legs, drafts])
  const tickerChanged = useCallback(
    (chainId: number) => {
      if (!changeTickers || newTicker.trim() === '') return false
      return newTicker !== (drafts[chainId]?.symbol ?? '')
    },
    [changeTickers, newTicker, drafts],
  )

  // The final per-chain drafts the ceremony deploys: the COMPILED legs/weights
  // under the shared name, with any retyped ticker applied. A kept chain
  // (inapplicable edit / unreadable seed) has no final draft — it ships nothing.
  const finalDrafts = useMemo(() => {
    const out: Record<number, ReshapeDraft> = {}
    for (const c of compiled) {
      if (!c.draft) continue
      const t = changeTickers && newTicker.trim() !== '' ? newTicker : null
      out[c.chainId] = {
        ...c.draft,
        name: sharedName.trim() || c.draft.name,
        symbol: t ?? c.draft.symbol,
      }
    }
    return out
  }, [compiled, changeTickers, newTicker, sharedName])

  // A network ships when its composition changed, its ticker was retyped, or
  // the whole bundle was renamed (the name is the grouping key — a rename is a
  // new version everywhere it can be read).
  const shipChainIds = useMemo(() => {
    const out = new Set<number>()
    for (const c of compiled) {
      if (!c.draft) continue
      if (c.changed || tickerChanged(c.chainId) || nameChanged) out.add(c.chainId)
    }
    return out
  }, [compiled, tickerChanged, nameChanged])
  const autoSkipped = useMemo(
    () => new Set(legs.map((l) => l.chainId).filter((id) => !shipChainIds.has(id))),
    [legs, shipChainIds],
  )

  const pendingSeeds = legs.filter((l) => {
    const s = seeds[l.chainId]
    return !s || s.status === 'loading'
  })
  const canReview = mountRefusal == null && pendingSeeds.length === 0 && nameOk && shipChainIds.size >= 1
  const reviewBlocker = !nameOk
    ? 'Give the bundle its name first — every new version ships under it.'
    : pendingSeeds.length > 0
      ? `Still reading ${pendingSeeds.length === 1 ? 'one network’s current version' : `${pendingSeeds.length} networks’ current versions`}…`
      : shipChainIds.size === 0
        ? 'No edits yet — every network keeps its current version.'
        : null

  // ── the ship ceremony (skips are COMPUTED — unchanged networks ship nothing) ─
  const enterShip = useCallback(() => {
    const composed = composeReshapeLanes({
      legs: legs.map((l) => ({ chainId: l.chainId, address: l.address })),
      skipped: autoSkipped,
      demo,
    })
    if ('refused' in composed) {
      setShipRefusal(composed.refused)
      setLanes(null)
    } else {
      setShipRefusal(null)
      setLanes(composed)
    }
    setStage('ship')
  }, [legs, autoSkipped, demo])

  const patchLane = useCallback((chainId: number, patch: LanePatch) => {
    setLanes((ls) => {
      if (!ls) return ls
      const next = advanceLane(ls, chainId, patch)
      return next === ls ? ls : next
    })
  }, [])

  const doRetry = useCallback((chainId: number) => {
    setLanes((ls) => (ls ? retryLane(ls, chainId) : ls))
  }, [])

  const active = lanes ? activeLane(lanes) : null
  const progress = lanes ? reshapeProgress(lanes) : null
  const finished = !!progress && progress.total > 0 && progress.finished
  const sw = useNetworkSwitch(active?.chainId ?? legs[0]?.chainId ?? 8453)

  // ONE CLICK, NOT TWO (the owner 2026-08-13, the supersession in this file's
  // header): the ceremony asks the wallet for the lane's network itself. Once
  // per lane, never while a signature is out, never after a refusal, and never
  // in the walkthrough — `demo` is passed straight through as law (d).
  useLaneAutoSwitch({
    sw,
    shipping: stage === 'ship',
    demo,
    laneChainId: active?.chainId ?? null,
    laneState: active?.state ?? null,
    connected: isConnected,
    walletChainId,
    signing: signingNow,
  })

  // The switch step's law, UNCHANGED by that ruling: the wallet's own observed
  // chain is the truth — a switch is DONE the moment the wallet is there,
  // whether we asked, the creator clicked, or they changed it in the wallet.
  useEffect(() => {
    if (demo || stage !== 'ship' || !active) return
    if (active.state === 'queued') {
      patchLane(active.chainId, { state: 'switch', note: null })
      return
    }
    if (active.state === 'switch' && isConnected && walletChainId === active.chainId) {
      patchLane(active.chainId, { state: 'deploying', note: null })
    }
  }, [demo, stage, active, isConnected, walletChainId, patchLane])

  // ── the demo metronome: pure beats (tested) — this effect owns only the
  //    setTimeout, the run overlay's division of labour ───────────────────────
  const beats = useMemo(() => demoLaneScript(), [])
  const [beatIdx, setBeatIdx] = useState(0)
  const activeChainForBeats = demo && stage === 'ship' ? (active?.chainId ?? null) : null
  useEffect(() => {
    setBeatIdx(0)
  }, [activeChainForBeats])
  useEffect(() => {
    if (!demo || stage !== 'ship' || activeChainForBeats == null) return
    const beat = beats[beatIdx]
    if (!beat) return
    const t = window.setTimeout(() => {
      patchLane(activeChainForBeats, beat.patch)
      setBeatIdx((i) => i + 1)
    }, beat.waitMs)
    return () => window.clearTimeout(t)
  }, [demo, stage, activeChainForBeats, beats, beatIdx, patchLane])

  const demoKick = () => {
    if (activeChainForBeats == null) return
    const beat = beats[beatIdx]
    if (!beat) return
    patchLane(activeChainForBeats, beat.patch)
    setBeatIdx((i) => i + 1)
  }

  // Lane transitions read aloud (aria-live=polite below).
  useEffect(() => {
    if (stage !== 'ship' || !lanes) return
    if (finished) setAnnounce('The reshape is complete.')
    else if (active) setAnnounce(announceLane(active, chainLabel(active.chainId)))
  }, [stage, lanes, active, finished])

  // ── shell behaviour: esc (confirm while a signature is out), trap, lock ─────
  const requestClose = useCallback(() => {
    if (seedOverlayOpen) return // the seed run owns the screen and the Escape key
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
    const focusables = [
      ...root.querySelectorAll<HTMLElement>('button, [href], select, input, [tabindex]:not([tabindex="-1"])'),
    ].filter((el) => !el.hasAttribute('disabled'))
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

  const connectChip = (
    <div className="mt-6">
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

  // ── the one-action deck (ship stage) ────────────────────────────────────────
  function shipDeck() {
    if (!lanes || finished || !active) return null
    if (demo) {
      return (
        <div className="mt-6">
          <button
            type="button"
            onClick={demoKick}
            className="press inline-flex h-12 w-full items-center justify-center rounded-xl border px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink"
            style={{ borderColor: `${ACCENT}59`, background: `${ACCENT}14` }}
          >
            {demoDeckLabel(active)}
          </button>
          <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            the walkthrough advances by itself — tap to move it along
          </p>
        </div>
      )
    }
    if (!isConnected || !address) return connectChip
    const draft = finalDrafts[active.chainId]
    return (
      <div className="mt-6">
        {active.state === 'failed' ? (
          <button
            type="button"
            onClick={() => doRetry(active.chainId)}
            className="press inline-flex h-12 w-full items-center justify-center rounded-xl border border-amber-400/40 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-amber-200 hover:bg-amber-400/10"
          >
            Retry — {active.newAddress != null ? 'the lineage signature' : 'the deploy'} on {chainLabel(active.chainId)}
          </button>
        ) : active.state === 'switch' ? (
          <SwitchOffer sw={sw} chainId={active.chainId} why="switching networks signs nothing" />
        ) : active.state === 'deploying' ? (
          draft ? (
            <LaneDeployExecutor
              key={`${active.chainId}:${active.predecessor}`}
              lane={active}
              draft={draft}
              thesisName={sharedName.trim()}
              sw={sw}
              walletChainId={walletChainId}
              demoLeg={demoReshapeRefusal([{ address: active.predecessor }], demo) != null}
              onStage={(words) => patchLane(active.chainId, { note: words })}
              onBusy={setSigningNow}
              onShipped={(token) => patchLane(active.chainId, { state: 'signing-lineage', newAddress: token, note: null })}
              onFail={(message) => patchLane(active.chainId, { state: 'failed', note: message })}
            />
          ) : (
            // Unreachable through the gates (review requires every un-skipped
            // draft); stated rather than guessed if a future caller skips them.
            <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-4 font-mono text-[11px] leading-relaxed text-amber-200/90">
              This network&rsquo;s draft is missing, so nothing can be shipped for it. Close and reopen the reshape.
            </p>
          )
        ) : active.state === 'signing-lineage' && active.newAddress ? (
          <LaneLineageSigner
            key={`${active.chainId}:${active.newAddress}`}
            lane={active}
            newToken={active.newAddress}
            onBusy={setSigningNow}
            onDone={() => patchLane(active.chainId, { state: 'done', note: null })}
            onRefused={() => patchLane(active.chainId, { state: 'failed', note: LINEAGE_REFUSED_NOTE })}
          />
        ) : null}
      </div>
    )
  }

  // ── stage bodies ─────────────────────────────────────────────────────────────
  const body = (() => {
    if (mountRefusal) {
      return (
        <div className="mt-8">
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-4 font-mono text-[11px] leading-relaxed text-amber-200/90">
            {mountRefusal}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            Close
          </button>
        </div>
      )
    }

    if (stage === 'shape') {
      return (
        <div className="mt-6">
          {/* the one name — the grouping key. TEXT DIET (the owner 2026-08-12:
              "way way less text"): the law rides the title, not a paragraph. */}
          <label htmlFor="reshape-thesis-name" className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            bundle name
          </label>
          <input
            id="reshape-thesis-name"
            value={sharedName}
            onChange={(e) => setSharedName(e.target.value)}
            maxLength={48}
            title="edited once, shipped everywhere — the shared name is what groups the bundle"
            className="mt-2 h-12 w-full rounded-xl border border-white/12 bg-transparent px-4 font-display text-base font-bold text-ink outline-none focus:border-cyan/50"
          />

          {/* TICKERS — keep-same by default (owner 2026-08-12), ONE compact
              row (the text diet): label · fact/input · the toggle. The
              two-live-versions law rides the revealed input's title. */}
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/10 px-4 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">tickers</span>
            {changeTickers ? (
              /* ONE input — every network's new version ships under it
                 (one control per setting, never one per chain). */
              <span className="flex min-w-0 flex-1 items-center rounded-xl border border-white/12 bg-black/20 px-3.5">
                <span aria-hidden className="font-num text-sm text-ink-dim">$</span>
                <input
                  aria-label="New ticker on every network"
                  value={newTicker}
                  maxLength={11}
                  placeholder={commonTicker ?? 'TICKER'}
                  title="one ticker for every network — the current versions keep trading under their own until holders migrate"
                  onChange={(e) => setNewTicker(clampSymbolInput(e.target.value))}
                  className="min-w-0 flex-1 bg-transparent py-2 pl-1 font-mono text-[13px] font-bold uppercase text-ink outline-none placeholder:text-ink-faint"
                />
              </span>
            ) : (
              <span className="min-w-0 flex-1 font-mono text-[11px] text-ink-dim">keep current</span>
            )}
            <button
              type="button"
              aria-pressed={changeTickers}
              onClick={() => {
                setChangeTickers((v) => {
                  // toggling back = keep-same again: the retyped value drops so
                  // the review can never ship a ticker the face stopped showing
                  if (v) setNewTicker('')
                  return !v
                })
              }}
              className="press inline-flex min-h-[32px] items-center rounded-lg border border-white/12 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              {changeTickers ? 'Keep current' : 'Change'}
            </button>
          </div>

          {/* ONE MIX, EVERY NETWORK — reads from the seeded drafts, edits land
              as union operations, and the summary below shows what each
              network's own basket does with them. */}
          {pendingSeeds.length > 0 ? (
            <div className="mt-5 space-y-3">
              <div className="h-24 animate-pulse rounded-xl border border-white/5 bg-white/[0.02] motion-reduce:animate-none" />
              <p className="text-center font-mono text-[11px] text-ink-dim">
                Reading {pendingSeeds.length === 1 ? 'one network’s current version' : `${pendingSeeds.length} networks’ current versions`}…
              </p>
            </div>
          ) : (
            <UnionMixEditor
              legs={legs}
              seeds={seeds}
              union={union}
              reweights={reweights}
              removals={removals}
              adds={adds}
              onReweight={(key, pct) => setReweights((prev) => new Map(prev).set(key, pct))}
              onToggleRemove={(key) =>
                setRemovals((prev) => {
                  const next = new Set(prev)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
              onAdd={(add) => setAdds((prev) => [...prev, add])}
              onAdjustAdd={(key, pct) => setAdds((prev) => prev.map((a) => (a.key === key ? { ...a, weightPct: pct } : a)))}
              onDropAdd={(key) => setAdds((prev) => prev.filter((a) => a.key !== key))}
              compiled={compiled}
              tickersChanged={legs.some((l) => tickerChanged(l.chainId))}
              nameChanged={nameChanged}
            />
          )}

          {/* footer nav */}
          <div className="mt-8 border-t border-white/8 pt-4">
            <button
              type="button"
              disabled={!canReview}
              onClick={() => setStage('review')}
              className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
            >
              Review — ships on {shipChainIds.size} of {legs.length} {legs.length === 1 ? 'network' : 'networks'}
            </button>
            {reviewBlocker && (
              <p className="mt-3 text-center font-mono text-[10px] leading-relaxed text-ink-faint">{reviewBlocker}</p>
            )}
          </div>
        </div>
      )
    }

    if (stage === 'review') {
      return (
        <div className="mt-6">
          <div
            className="rounded-xl border px-4 py-4 font-mono text-[11px] leading-relaxed text-ink-dim"
            style={{ borderColor: `${ACCENT}40`, background: `${ACCENT}0d` }}
          >
            {honestyPlateWords(shipChainIds.size)}
          </div>

          <div className="mt-4 space-y-3">
            {legs.map((l) => {
              if (!shipChainIds.has(l.chainId)) {
                const c = compiledFor(l.chainId)
                return (
                  <div key={l.chainId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/8 bg-transparent px-4 py-3 opacity-70">
                    <ChainBadge chainId={l.chainId} size="md" />
                    <span className="min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-ink-faint">
                      {c?.kept ?? 'nothing changes here — keeps its current version'}
                    </span>
                  </div>
                )
              }
              return finalDrafts[l.chainId] ? (
                <LegReviewRow key={l.chainId} leg={l} draft={finalDrafts[l.chainId]} newName={sharedName.trim()} />
              ) : null
            })}
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => setStage('shape')}
              className="press inline-flex h-12 flex-1 items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              Back to editing
            </button>
            <button
              type="button"
              onClick={enterShip}
              className="spectral-btn press inline-flex h-12 flex-1 items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
            >
              {demo ? 'Watch the ceremony' : `Ship on ${shipChainIds.size} ${shipChainIds.size === 1 ? 'network' : 'networks'}`}
            </button>
          </div>
        </div>
      )
    }

    // ship
    if (shipRefusal) {
      return (
        <div className="mt-8">
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-4 font-mono text-[11px] leading-relaxed text-amber-200/90">
            {shipRefusal}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            Close
          </button>
        </div>
      )
    }
    if (!lanes) return null
    if (finished) {
      return (
        <SuccessPlate
          lanes={lanes}
          drafts={finalDrafts}
          name={sharedName.trim() || name}
          deployer={deployer}
          demo={demo}
          onSeedOverlayChange={setSeedOverlayOpen}
          onDone={onClose}
        />
      )
    }
    return (
      <>
        <div className="mt-6 space-y-3">
          {lanes.map((lane) => (
            <LaneRowView
              key={lane.chainId}
              lane={lane}
              symbol={finalDrafts[lane.chainId]?.symbol ?? null}
              isActive={active?.chainId === lane.chainId}
              onRetry={() => doRetry(lane.chainId)}
            />
          ))}
        </div>
        {shipDeck()}
        {escArm && (
          <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">
            A signature may be waiting in your wallet. Press Esc again (or ✕) to close — finished networks keep their new versions.
          </p>
        )}
      </>
    )
  })()

  const fraction = stage === 'ship' && progress && progress.total > 0 ? progress.done / progress.total : 0

  return createPortal(
    /* THE BOTTOM BREAK (the owner 2026-08-12: "it breaks at the bottom"): the veil
       was an absolute inset-0 CHILD of this scroller, so it covered only the
       first viewport — scrolled past ~100vh, the raw page blazed through the
       translucent panel under the verdicts and the Review CTA. The veil now
       rides the fixed scroller itself (ReshapeBasketModal's posture), covering
       every scrolled pixel by construction. WIDTH: 920px-class — the reshape
       modal's own width (ReshapeBasketModal:377) — so the bento breathes. */
    <div
      className="fixed inset-0 z-[90] overflow-y-auto overscroll-contain bg-void/90 p-4 backdrop-blur-md sm:p-6"
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`reshape the bundle — ${showName(sharedName || name)}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        className="relative mx-auto my-6 w-full max-w-[920px] pb-[env(safe-area-inset-bottom)] outline-none"
      >
        <Bezel glow={ACCENT} panel="bg-panel/95">
          <div className="p-5 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <Eyebrow tone="spectral">reshape the bundle</Eyebrow>
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
              {showName(sharedName || name)}
            </h2>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.16em]">
              {(['shape', 'review', 'ship'] as const).map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="h-px w-3 bg-white/10" />}
                  <span style={stage === s ? { color: ACCENT } : undefined} className={stage === s ? '' : 'text-ink-faint'}>
                    {s}
                  </span>
                </span>
              ))}
              <span className="flex-1" />
              <span className="text-ink-faint normal-case tracking-normal">
                a new version per network. The current ones stay live
              </span>
            </div>
            {stage === 'ship' && !shipRefusal && !mountRefusal && (
              <div className="mt-5 h-[3px] overflow-hidden rounded-full bg-white/8">
                <div
                  className="h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none"
                  style={{
                    width: `${Math.round(fraction * 100)}%`,
                    background: `linear-gradient(90deg, var(--color-cyan), ${ACCENT})`,
                    transitionTimingFunction: EASE,
                  }}
                />
              </div>
            )}

            {body}

            {/* centered already; one type step up + no em dash to match the
                publish ceremony's footer (the owner 2026-08-13) */}
            <p className="mt-8 border-t border-white/8 pt-4 text-center font-mono text-[11px] leading-relaxed text-ink-faint">
              {INTERRUPTION_NOTE}
            </p>
          </div>
        </Bezel>
      </div>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      {/* the seed collectors — one hook mount per leg, alive across every stage
          so review and ship never wait on a tab the creator visited last */}
      {mountRefusal == null &&
        legs.map((l) => <LegSeed key={l.address} address={l.address} chainId={l.chainId} onResult={adoptSeed} />)}
      {/* deployer identity rides the aria label only — every shown string above
          goes through showName/showSymbol (the glob guard) */}
      <span className="sr-only">{shortAddr(deployer)}</span>
    </div>,
    document.body,
  )
}

// ── the seed collector (hooks-per-leg, the LegTradeExecutor pattern) ──────────

function LegSeed({
  address,
  chainId,
  onResult,
}: {
  address: `0x${string}`
  chainId: number
  onResult: (chainId: number, r: VersionSeedResult) => void
}) {
  const seed = useVersionSeed(address, chainId)
  useEffect(() => {
    onResult(chainId, seed)
    // Push on MATERIAL change only — the hook may return a fresh object per
    // render, and echoing identity churn back into parent state would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, onResult, seed.status, seed.draft, seed.error])
  return null
}

// ── the union mix editor — ONE picture, every network (owner 2026-08-12) ──────
//
// THE HOUSE RESHAPE GRAMMAR (owner 2026-08-12, live on this modal: "this whole
// edit page needs to use the bento click and drag the bar to reweight like the
// reshape from your portfolio — all edit systems should use that same reshape
// bento system"): the real BasketBento over the bundle's combined assets
// (mergeUnion folds by ticker across chains; adds ride the same board), tap a
// tile → the real TrimBar in a FIXED dial slot (the reshape law: the grid
// below never reflows on tap — ShapeEditor's idiom, mirrored never recreated).
// Editing is still union OPERATIONS — reweight/remove/add — and the panel
// under the board shows what each network's own basket does with them
// (compileChains): an untouched network reads "no changes" and ships nothing.
// Where networks hold the same asset at DIFFERENT weights the tile shows the
// LARGEST holding (the label carries a true number) and the dial's presence
// line keeps the per-network truth until one drag converges them. Removed
// entries LEAVE the board — removal is everywhere — and stay one tap from
// reversible as undo chips under the dial. Adds go through the builder's own
// validation per network (validateAddAsset + liveAddEffects — the ShapeEditor
// pipeline, one implementation); a network where the pick has no route is
// stated, never silently thinner.

/** Union dial bounds: per-network Σ=100 under the 1% floor is enforced at
 *  compile by the draft ops (setDraftWeightPct snaps to STEP, setWeight
 *  clamps); the display target just stays inside the law's outer box. */
const UNION_MIN = MIN
const UNION_MAX = CAP - MIN

function UnionMixEditor({
  legs,
  seeds,
  union,
  reweights,
  removals,
  adds,
  onReweight,
  onToggleRemove,
  onAdd,
  onAdjustAdd,
  onDropAdd,
  compiled,
  tickersChanged,
  nameChanged,
}: {
  legs: { address: `0x${string}`; chainId: number; symbol: string }[]
  seeds: Record<number, VersionSeedResult>
  union: UnionEntry[]
  reweights: ReadonlyMap<string, number>
  removals: ReadonlySet<string>
  adds: UnionEdits['adds'][number][]
  onReweight: (key: string, pct: number) => void
  onToggleRemove: (key: string) => void
  onAdd: (add: UnionEdits['adds'][number]) => void
  onAdjustAdd: (key: string, pct: number) => void
  onDropAdd: (key: string) => void
  compiled: readonly CompiledChain[]
  tickersChanged: boolean
  nameChanged: boolean
}) {
  const chainIds = useMemo(() => legs.map((l) => l.chainId), [legs])

  // ── the dial (tiles-as-controls — ShapeEditor's idiom) ─────────────────────
  const [dial, setDial] = useState<string | null>(null)
  // live vs glide motion: 'live' only while the slider is actually moving
  // (ShapeEditor's markDialing idiom) so the settle still glides.
  const [dialing, setDialing] = useState(false)
  const dialingTimer = useRef<number | null>(null)
  const markDialing = () => {
    setDialing(true)
    if (dialingTimer.current != null) window.clearTimeout(dialingTimer.current)
    dialingTimer.current = window.setTimeout(() => setDialing(false), 220)
  }
  useEffect(
    () => () => {
      if (dialingTimer.current != null) window.clearTimeout(dialingTimer.current)
    },
    [],
  )

  // ── the views (ShapeEditor's picture-leads idiom) ───────────────────────────
  const [view, setView] = useState<'picture' | 'list'>('picture')
  const pill = (active: boolean) =>
    `press rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
      active ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
    }`

  // ── adds: the REAL AssetSearchModal picks (ShapeEditor's add door — its
  //    search already asks every network and merges on deepest liquidity);
  //    the union then lands the pick per network through the builder's own
  //    validation, exactly as before ─────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [addBusy, setAddBusy] = useState<string | null>(null)
  const [addNote, setAddNote] = useState<string | null>(null)

  async function pickFromSearch(a: { address: string; symbol: string; chainId: number }) {
    const key = unionKey(a.symbol)
    if (addBusy) return
    setSearchOpen(false)
    if (union.some((u) => u.key === key) || adds.some((x) => x.key === key)) {
      setAddNote(`$${showSymbol(a.symbol)} is already in the mix.`)
      return
    }
    setAddBusy(key)
    setAddNote(null)
    try {
      // The modal picked ONE canonical face (deepest-liquidity, its law); the
      // union lands per network — re-find the ticker on each bundle chain and
      // validate through the builder's own pipeline. A network with no
      // matching listing simply doesn't take the add — stated, never silent.
      const perChain: { chainId: number; leg: ReshapeLeg }[] = []
      const refused: string[] = []
      for (const chainId of chainIds) {
        const seedDraft = seeds[chainId]?.draft
        if (!seedDraft) {
          refused.push(chainLabel(chainId))
          continue
        }
        const addr =
          chainId === a.chainId
            ? a.address
            : await searchTokens(a.symbol, chainId)
                .then((rows) => rows.find((h) => unionKey(h.symbol) === key)?.address ?? null)
                .catch(() => null)
        if (!addr) {
          refused.push(chainLabel(chainId))
          continue
        }
        const verdict = await validateAddAsset(seedDraft, addr, chainId, liveAddEffects, a.symbol)
        if (verdict.ok) perChain.push({ chainId, leg: verdict.leg })
        else refused.push(chainLabel(chainId))
      }
      if (perChain.length === 0) {
        setAddNote(`$${showSymbol(a.symbol)} could not be validated on any of this bundle's networks.`)
        return
      }
      onAdd({ key, symbol: a.symbol, weightPct: 10, perChain })
      if (refused.length > 0)
        setAddNote(`$${showSymbol(a.symbol)} added — no route on ${refused.join(' · ')}, so those networks don't take it.`)
    } finally {
      setAddBusy(null)
    }
  }

  // union display value: the shared pct when every network agrees, else null
  // (mixed — chips carry the truth; the first step converges to the largest).
  function displayPct(u: UnionEntry): number | null {
    const target = reweights.get(u.key)
    if (target != null) return target
    const vals = [...new Set(u.perChain.map((c) => c.weightPct))]
    return vals.length === 1 ? vals[0] : null
  }

  function stepFrom(u: UnionEntry): number {
    return displayPct(u) ?? Math.max(...u.perChain.map((c) => c.weightPct))
  }

  const clampPct = (n: number) => Math.min(UNION_MAX, Math.max(UNION_MIN, n))

  // THE BOARD: union survivors (a removed entry LEAVES — removal is
  // everywhere) plus the adds, one tile each. Geometry floors at 1.6 so a 1%
  // tile stays visible + tappable; labelPct carries the TRUE display number
  // (the label never lies) — for a MIXED entry that is the LARGEST holding,
  // and the dial's presence line keeps the per-network truth.
  const removedEntries = union.filter((u) => removals.has(u.key))
  const bentoItems: BentoItem[] = [
    ...union
      .filter((u) => !removals.has(u.key))
      .map((u): BentoItem => {
        const display = stepFrom(u) // the shared pct, else the largest holding
        return {
          id: u.key,
          symbol: u.symbol,
          address: u.perChain[0].leg.address,
          chainId: u.perChain[0].chainId,
          weightPct: Math.max(display, 1.6),
          labelPct: display,
        }
      }),
    ...adds.map(
      (a): BentoItem => ({
        id: a.key,
        symbol: a.symbol,
        address: a.perChain[0].leg.address,
        chainId: a.perChain[0].chainId,
        weightPct: Math.max(a.weightPct, 1.6),
        labelPct: a.weightPct,
        // the bento's own just-arrived glow carries the old rows' "added" mark
        isNew: true,
      }),
    ),
  ]

  // The dialed entry — a union survivor or an add, normalized for the slot.
  // Keys are disjoint by pickFromSearch's dupe rule, and unionKey is already
  // case-folded, so BasketBento's lowercased onSelect ids round-trip unchanged.
  type DialEntry = {
    key: string
    symbol: string
    address: string
    chainId: number
    /** the shown number; null = the networks disagree (mixed) */
    pct: number | null
    /** where the thumb starts: the shared pct, else the largest holding */
    target: number
    /** per-network presence; weightPct null where none applies (an add) */
    chains: { chainId: number; weightPct: number | null }[]
    isAdd: boolean
  }
  const dialUnion = dial != null ? (union.find((u) => u.key === dial && !removals.has(u.key)) ?? null) : null
  const dialAdd = dial != null && !dialUnion ? (adds.find((a) => a.key === dial) ?? null) : null
  const dialEntry: DialEntry | null = dialUnion
    ? {
        key: dialUnion.key,
        symbol: dialUnion.symbol,
        address: dialUnion.perChain[0].leg.address,
        chainId: dialUnion.perChain[0].chainId,
        pct: displayPct(dialUnion),
        target: stepFrom(dialUnion),
        chains: dialUnion.perChain.map((c) => ({ chainId: c.chainId, weightPct: c.weightPct })),
        isAdd: false,
      }
    : dialAdd
      ? {
          key: dialAdd.key,
          symbol: dialAdd.symbol,
          address: dialAdd.perChain[0].leg.address,
          chainId: dialAdd.perChain[0].chainId,
          pct: dialAdd.weightPct,
          target: dialAdd.weightPct,
          chains: dialAdd.perChain.map((c) => ({ chainId: c.chainId, weightPct: null })),
          isAdd: true,
        }
      : null

  // "Even it out" — ShapeEditor's affordance in union terms: one equal target
  // per board entry; each network's own compile re-lands Σ=100 under the law.
  const evenOut = () => {
    const survivors = union.filter((u) => !removals.has(u.key))
    const n = survivors.length + adds.length
    if (n < 2) return
    const w = equalSplit(n)
    survivors.forEach((u, i) => onReweight(u.key, w[i]))
    adds.forEach((a, i) => onAdjustAdd(a.key, w[survivors.length + i]))
  }

  // the search modal's shown-not-pickable keys: every address already on the
  // board, on every network it rides
  const takenKeys = new Set([
    ...union.flatMap((u) => u.perChain.map((c) => `${c.chainId}:${c.leg.address.toLowerCase()}`)),
    ...adds.flatMap((a) => a.perChain.map((c) => `${c.chainId}:${c.leg.address.toLowerCase()}`)),
  ])
  const full = bentoItems.length >= MAX_ASSETS

  return (
    <div className="mt-5">
      {/* the station row — ShapeEditor's: one short label + the Picture/List
          pills + Even it out (the text diet: the snap law rides the title —
          setDraftWeightPct snaps to STEP, setWeight floors at MIN). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span
          title={`reweights snap to ${STEP}% · floor ${MIN}%`}
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint"
        >
          shape the mix — every network follows
        </span>
        <span className="flex items-center gap-2">
          {(
            [
              { id: 'picture' as const, label: 'Picture' },
              { id: 'list' as const, label: 'List' },
            ]
          ).map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)} className={pill(view === v.id)}>
              {v.label}
            </button>
          ))}
        </span>
        {bentoItems.length > 1 && (
          <button
            type="button"
            onClick={evenOut}
            className="press ml-auto rounded-full border border-white/15 px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-white/35"
          >
            Even it out
          </button>
        )}
      </div>

      {view === 'picture' ? (
        <>
      {/* THE PICTURE — the union as the reshape bento, tiles sized by weight
          (the largest holding while mixed), tap to dial. ShapeEditor's frame,
          motion and floor, verbatim — on a BLACK PLATE (the owner 2026-08-12: "a
          black bg behind the basket"): the portfolio board sits on the page's
          own void; inside a panel this plate supplies it so the tiles pop. */}
      <div className="mt-3 rounded-2xl bg-black/40 p-2">
        <div className="h-[340px]">
          <BasketBento
            items={bentoItems}
            fill
            animateLayout
            layoutMotion={dialing ? 'live' : 'glide'}
            selectedId={dial}
            onSelect={(id) => setDial((k) => (k === id ? null : id))}
          />
        </div>
      </div>

      {/* the dial slot — FIXED height, always present: the grid below never
          reflows on tap (the reshape law) */}
      <div
        role={dialEntry ? 'group' : undefined}
        aria-label={dialEntry ? `Reweight ${showSymbol(dialEntry.symbol)}` : undefined}
        className="relative mt-3 flex min-h-[64px] items-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-2 sm:h-[64px]"
      >
        {!dialEntry ? (
          <p className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-cyan" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <g>
                <animateTransform attributeName="transform" type="translate" values="0 0; 1.6 1.6; 0 0" keyTimes="0; 0.35; 1" dur="2.2s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
                <path d="M5 3l14 7-6.5 1.5L9 18z" fill="currentColor" fillOpacity="0.18" />
              </g>
            </svg>
            tap a tile to reweight it — every network follows
          </p>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex min-w-0 items-center gap-2">
              <AssetLogo address={dialEntry.address} symbol={dialEntry.symbol} chainId={dialEntry.chainId} size={24} />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(dialEntry.symbol)}</span>
                  {dialEntry.isAdd && (
                    <span className="font-mono text-[9px] uppercase tracking-[0.16em]" style={{ color: '#34d6c4' }}>
                      added
                    </span>
                  )}
                  <span className="font-num text-sm font-semibold tabular-nums text-ink-dim">
                    {dialEntry.pct == null ? 'mixed' : `${dialEntry.pct}%`}
                  </span>
                </span>
                {/* per-network presence: dots always; per-chain % chips only
                    while MIXED — the truth the old rows carried stays visible */}
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {dialEntry.chains.map((c) => {
                    const m = chainMeta(c.chainId)
                    return (
                      <span key={c.chainId} className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-faint">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
                        {dialEntry.pct == null && c.weightPct != null ? `${c.weightPct}%` : m.short}
                      </span>
                    )
                  })}
                  <span className="font-mono text-[10px] text-ink-faint">
                    {dialEntry.chains.length} of {legs.length} {legs.length === 1 ? 'network' : 'networks'}
                  </span>
                </span>
              </span>
            </span>
            <div className="min-w-[160px] flex-1">
              <TrimBar
                symbol={dialEntry.symbol}
                cur={0}
                target={dialEntry.target}
                scaleUsd={CAP}
                isNew
                onTarget={(pct) => {
                  markDialing()
                  const next = clampPct(Math.round(pct))
                  if (dialEntry.isAdd) onAdjustAdd(dialEntry.key, next)
                  else onReweight(dialEntry.key, next)
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                if (dialEntry.isAdd) onDropAdd(dialEntry.key)
                else onToggleRemove(dialEntry.key)
                setDial(null)
              }}
              aria-label={dialEntry.isAdd ? `Drop the ${showSymbol(dialEntry.symbol)} add` : `Remove ${showSymbol(dialEntry.symbol)} everywhere`}
              className="press grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-magenta/60 hover:text-magenta"
            >
              ✕
            </button>
            <button
              type="button"
              onClick={() => setDial(null)}
              aria-label={`Done reweighting ${showSymbol(dialEntry.symbol)}`}
              className="press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-teal/40 bg-teal/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal hover:border-teal/70"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 13l4 4L19 7" />
              </svg>
              Done
            </button>
          </div>
        )}
      </div>

      {/* removed everywhere — the tiles leave the board (removal is
          everywhere); each stays one tap from reversible */}
      {removedEntries.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">removed everywhere</span>
          {removedEntries.map((u) => (
            <button
              key={u.key}
              type="button"
              onClick={() => onToggleRemove(u.key)}
              aria-label={`Undo removing ${showSymbol(u.symbol)}`}
              className="press inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-white/12 px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              <span className="text-ink-faint line-through">${showSymbol(u.symbol)}</span>
              undo
            </button>
          ))}
        </div>
      )}
        </>
      ) : (
        /* THE LIST — ShapeEditor's list idiom in union terms: compact rows,
           −/+ steppers on the builder's STEP, mixed shown as per-chain chips,
           removed rows struck with Undo inline. No total banner: the union is
           a cross-network view — each network's own Σ=100 is the compile's
           law, not a number this list can honestly show. */
        <div className="mt-3 space-y-2">
          {union.map((u) => {
            const removed = removals.has(u.key)
            const pct = displayPct(u)
            return (
              <div
                key={u.key}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5 ${
                  removed ? 'border-white/8 opacity-50' : 'border-white/10'
                }`}
              >
                <AssetLogo address={u.perChain[0].leg.address} symbol={u.symbol} chainId={u.perChain[0].chainId} size={28} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-display text-sm font-bold uppercase tracking-wide ${removed ? 'text-ink-faint line-through' : 'text-ink'}`}>
                    ${showSymbol(u.symbol)}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {u.perChain.map((c) => {
                      const m = chainMeta(c.chainId)
                      return (
                        <span key={c.chainId} className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-faint">
                          <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
                          {pct == null ? `${c.weightPct}%` : m.short}
                        </span>
                      )
                    })}
                  </div>
                </div>
                {removed ? (
                  <button
                    type="button"
                    onClick={() => onToggleRemove(u.key)}
                    className="press inline-flex min-h-[32px] items-center rounded-lg border border-white/12 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
                  >
                    Undo
                  </button>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`Lower ${showSymbol(u.symbol)}`}
                        onClick={() => onReweight(u.key, clampPct(stepFrom(u) - STEP))}
                        className="press grid h-8 w-8 place-items-center rounded-lg border border-white/12 font-mono text-sm text-ink-dim hover:border-white/30 hover:text-ink"
                      >
                        −
                      </button>
                      <span className="w-14 text-center font-mono text-[13px] font-bold text-ink">
                        {pct == null ? 'mixed' : `${pct}%`}
                      </span>
                      <button
                        type="button"
                        aria-label={`Raise ${showSymbol(u.symbol)}`}
                        onClick={() => onReweight(u.key, clampPct(stepFrom(u) + STEP))}
                        className="press grid h-8 w-8 place-items-center rounded-lg border border-white/12 font-mono text-sm text-ink-dim hover:border-white/30 hover:text-ink"
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${showSymbol(u.symbol)} everywhere`}
                      onClick={() => onToggleRemove(u.key)}
                      className="press grid h-8 w-8 place-items-center rounded-lg text-ink-faint hover:bg-white/8 hover:text-ink"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            )
          })}
          {adds.map((a) => (
            <div key={a.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5" style={{ borderColor: '#34d6c440' }}>
              <AssetLogo address={a.perChain[0].leg.address} symbol={a.symbol} chainId={a.perChain[0].chainId} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                  ${showSymbol(a.symbol)}{' '}
                  <span className="font-mono text-[9px] uppercase tracking-[0.16em]" style={{ color: '#34d6c4' }}>
                    added
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {a.perChain.map((c) => {
                    const m = chainMeta(c.chainId)
                    return (
                      <span key={c.chainId} className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-faint">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
                        {m.short}
                      </span>
                    )
                  })}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`Lower ${showSymbol(a.symbol)}`}
                  onClick={() => onAdjustAdd(a.key, clampPct(a.weightPct - STEP))}
                  className="press grid h-8 w-8 place-items-center rounded-lg border border-white/12 font-mono text-sm text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  −
                </button>
                <span className="w-14 text-center font-mono text-[13px] font-bold text-ink">{a.weightPct}%</span>
                <button
                  type="button"
                  aria-label={`Raise ${showSymbol(a.symbol)}`}
                  onClick={() => onAdjustAdd(a.key, clampPct(a.weightPct + STEP))}
                  className="press grid h-8 w-8 place-items-center rounded-lg border border-white/12 font-mono text-sm text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                aria-label={`Drop the ${showSymbol(a.symbol)} add`}
                onClick={() => onDropAdd(a.key)}
                className="press grid h-8 w-8 place-items-center rounded-lg text-ink-faint hover:bg-white/8 hover:text-ink"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* the add door — ShapeEditor's own: the real AssetSearchModal (already
          cross-chain: every network asked at once, deepest liquidity wins);
          each pick lands per network through the builder's pipeline */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            disabled={full || addBusy != null}
            className="press inline-flex h-12 items-center gap-2 rounded-xl border border-dashed border-white/20 px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan disabled:opacity-45"
          >
            ＋ Add an asset
          </button>
          {full && (
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              bundle is full · {MAX_ASSETS} assets
            </span>
          )}
          {addBusy != null && (
            <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              <span aria-hidden className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
              validating on every network…
            </span>
          )}
        </div>
        {addNote && <p className="mt-2 font-mono text-[10px] leading-relaxed text-amber-200/90">{addNote}</p>}
      </div>

      {searchOpen && (
        <AssetSearchModal
          onPick={(a) => void pickFromSearch(a)}
          onClose={() => setSearchOpen(false)}
          takenKeys={takenKeys}
          full={full}
          zIndex={100}
        />
      )}

      {/* WHAT EACH NETWORK DOES WITH THE EDIT — the computed per-chain verdicts.
          This panel is the ruling made visible: nobody chose networks; the
          system says which baskets update and which have nothing to do. */}
      <div className="mt-5 space-y-2">
        {legs.map((l) => {
          const seed = seeds[l.chainId]
          const c = compiled.find((x) => x.chainId === l.chainId) ?? null
          const m = chainMeta(l.chainId)
          if (seed?.status === 'error' || !c?.draft) {
            // THE CONSTITUENTS ANSWER (the owner 2026-08-12: "why cant read
            // constituents"): a fixture bundle's non-RH baskets carry DISPLAY
            // tokens (demo-baskets.ts picks them for their logo colors), so
            // re-resolving them against LIVE pools can only fail — the seed's
            // honest refusal, not a bug. Say that, short; retrying can't help
            // a synthetic leg, so the Retry button is real-bundles-only.
            const demoLeg = seed?.status === 'error' && isDemoLegAddress(l.address)
            return (
              <div key={l.chainId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-400/25 bg-amber-400/[0.04] px-3.5 py-2.5">
                <ChainBadge chainId={l.chainId} size="md" />
                <span className="min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-amber-200/90">
                  {demoLeg
                    ? 'demo bundle — these legs only walk on Robinhood, so this network has nothing real to re-seed'
                    : (c?.kept ?? seed?.error ?? 'This network’s current version could not be read — it keeps its current version.')}
                </span>
                {seed?.status === 'error' && !demoLeg && (
                  <button
                    type="button"
                    onClick={seed.retry}
                    className="press inline-flex min-h-[28px] items-center rounded-lg border border-amber-400/40 px-2.5 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200 hover:bg-amber-400/10"
                  >
                    Retry
                  </button>
                )}
              </div>
            )
          }
          const ships = c.changed || tickersChanged || nameChanged
          const dropped = seed?.dropped ?? []
          // the verdict says WHAT changes, not just that something does —
          // counted against this network's own current version
          const cur = seeds[l.chainId]?.draft
          const parts: string[] = []
          if (cur && c.changed) {
            const curBy = new Map(cur.legs.map((leg, k) => [leg.address.toLowerCase(), cur.weights[k]]))
            const nextBy = new Map(c.draft.legs.map((leg, k) => [leg.address.toLowerCase(), c.draft!.weights[k]]))
            let added = 0, removed = 0, rew = 0
            for (const [a] of nextBy) if (!curBy.has(a)) added++
            for (const [a, w] of curBy) {
              if (!nextBy.has(a)) removed++
              else if (nextBy.get(a) !== w) rew++
            }
            if (rew) parts.push(`${rew} reweighted`)
            if (added) parts.push(`${added} added`)
            if (removed) parts.push(`${removed} removed`)
          }
          if (tickersChanged) parts.push('new ticker')
          if (nameChanged) parts.push('renamed')
          return (
            <div key={l.chainId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-white/8 px-3.5 py-2.5">
              <ChainBadge chainId={l.chainId} size="md" />
              <span className={`min-w-0 flex-1 font-mono text-[10px] leading-relaxed ${ships ? 'text-ink-dim' : 'text-ink-faint'}`}>
                {ships ? (
                  <span style={{ color: m.color }}>ships an update{parts.length > 0 ? ` — ${parts.join(' · ')}` : ''}</span>
                ) : (
                  'no changes — keeps its current version'
                )}
                {c.unresolvedAdds.length > 0 && <> · no route for {c.unresolvedAdds.map((s) => `$${showSymbol(s)}`).join(', ')} here</>}
                {dropped.length > 0 && <> · not carried: {dropped.map((d) => showSymbol(d.symbol)).join(', ')}</>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── the review row (prev version vs draft, the versioning diff law) ──────────

/** Hex (not CSS vars) — the chip tints alpha-suffix these (`${color}24`),
 *  which only composes on a literal hex value. Same hues the BasketDiff
 *  surface names for the three kinds. */
const DIFF_COLOR: Record<'added' | 'removed' | 'reweighted', string> = {
  added: '#34d6c4',
  removed: '#ff4d6d',
  reweighted: '#fbbf24',
}

function wtWords(p: number | null): string {
  return p == null ? '—' : `${p.toFixed(p % 1 === 0 ? 0 : 1)}%`
}

function LegReviewRow({
  leg,
  draft,
  newName,
}: {
  leg: { address: `0x${string}`; chainId: number; symbol: string }
  draft: ReshapeDraft
  newName: string
}) {
  const { data: prev, isLoading } = useBasketData(leg.address, leg.chainId)
  const diff = useMemo(() => (prev ? draftDiffFrom(prev, draft) : null), [prev, draft])
  const changed = useMemo(() => (diff ? diff.constituents.filter((c) => c.kind !== 'unchanged') : []), [diff])
  const unchangedCount = diff ? diff.constituents.length - changed.length : 0

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ChainBadge chainId={leg.chainId} size="md" />
        <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
          ${showSymbol(leg.symbol)} <span aria-hidden className="text-ink-faint">→</span> ${showSymbol(draft.symbol)}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">ships {showName(newName)}</span>
      </div>
      {isLoading ? (
        <div className="mt-3 h-10 animate-pulse rounded-lg border border-white/5 bg-white/[0.02] motion-reduce:animate-none" />
      ) : !diff ? (
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-faint">
          The live composition could not be read just now, so the change summary cannot be shown — the ship stage
          re-checks everything before any signature.
        </p>
      ) : changed.length === 0 ? (
        <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.04] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          No composition changes on this network — this would ship an identical basket for a real deploy price. Consider
          keeping the current version instead.
        </p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {changed.map((c: ConstituentDiff) => {
            const color = DIFF_COLOR[c.kind as 'added' | 'removed' | 'reweighted']
            return (
              <div key={c.asset} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-black/20 px-3 py-2">
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide"
                  style={{ color, background: `${color}24` }}
                >
                  {c.kind}
                </span>
                <span className={`font-display text-sm font-bold ${c.kind === 'removed' ? 'text-ink-faint line-through' : 'text-ink'}`}>
                  {showSymbol(c.symbol)}
                </span>
                <span className="flex-1" />
                <span className="font-num text-sm tabular-nums text-ink-dim">
                  {c.kind === 'reweighted' ? (
                    <>
                      <span className="text-ink-faint">{wtWords(c.fromWeightPct)}</span>{' '}
                      <span aria-hidden style={{ color }}>→</span> {wtWords(c.toWeightPct)}
                    </>
                  ) : c.kind === 'added' ? (
                    wtWords(c.toWeightPct)
                  ) : (
                    wtWords(c.fromWeightPct)
                  )}
                </span>
              </div>
            )
          })}
          {unchangedCount > 0 && (
            <p className="px-1 font-mono text-[10px] text-ink-faint">
              + {unchangedCount} unchanged {unchangedCount === 1 ? 'holding' : 'holdings'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── the ship lanes ────────────────────────────────────────────────────────────

function LaneRowView({
  lane,
  symbol,
  isActive,
  onRetry,
}: {
  lane: ThesisReshapeLane
  symbol: string | null
  isActive: boolean
  onRetry: () => void
}) {
  const shell =
    lane.state === 'failed'
      ? 'border-amber-400/30 bg-amber-400/[0.04]'
      : lane.state === 'done'
        ? 'border-white/8 bg-white/[0.02]'
        : lane.state === 'skipped'
          ? 'border-white/8 bg-transparent opacity-70'
          : 'border-white/10 bg-white/[0.03]'
  const marks = laneMarks(lane)
  const working = lane.state === 'deploying' || lane.state === 'signing-lineage'
  return (
    <div
      className={`relative overflow-hidden rounded-xl border px-4 py-3 ${shell}`}
      style={isActive && lane.state !== 'skipped' ? { borderColor: `${ACCENT}59`, boxShadow: `inset 0 0 24px ${ACCENT}0f` } : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ChainBadge chainId={lane.chainId} size="md" />
        {symbol != null && (
          <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
            ${showSymbol(symbol)}
          </span>
        )}
        <span className="flex-1" />
        {lane.newAddress &&
          (symbol != null ? (
            /* the shipped version is a DOOR, not dead text (audit 2026-08-16:
               on a partial run — the worst outcome — these were the only
               record of what the money bought, and they linked nowhere) */
            <Link
              to={basketHref({ chainId: lane.chainId, address: lane.newAddress, symbol })}
              className="press font-mono text-[10px] text-cyan hover:underline"
            >
              {shortAddr(lane.newAddress)} →
            </Link>
          ) : (
            <span className="font-mono text-[10px] text-ink-faint">{shortAddr(lane.newAddress)}</span>
          ))}
      </div>
      {lane.state === 'done' ? (
        <div className="mt-2.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          <span className="text-teal" aria-hidden>
            ✓
          </span>
          new version live · lineage signed
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {marks.map((m, i) => (
            <span key={m.key} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="h-px w-3 bg-white/10" />}
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]">
                {m.state === 'done' ? (
                  <span className="text-teal" aria-hidden>
                    ✓
                  </span>
                ) : m.state === 'failed' ? (
                  <span className="text-amber-300" aria-hidden>
                    ⚠
                  </span>
                ) : m.state === 'active' ? (
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full border ${working ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                    style={{ borderColor: ACCENT, background: working ? `${ACCENT}66` : undefined }}
                  />
                ) : (
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/15" />
                )}
                <span className={m.state === 'failed' ? 'text-amber-200/90' : m.state === 'active' ? 'text-ink' : 'text-ink-faint'}>
                  {m.label}
                </span>
              </span>
            </span>
          ))}
        </div>
      )}
      {lane.note && lane.state !== 'done' && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p
            className={`min-w-0 flex-1 font-mono text-[10px] leading-relaxed ${
              lane.state === 'failed' ? 'text-amber-200/90' : lane.state === 'skipped' ? 'text-ink-faint' : 'text-ink-dim'
            }`}
          >
            {lane.note}
          </p>
          {lane.state === 'failed' && (
            <button
              type="button"
              onClick={onRetry}
              className="press inline-flex min-h-[36px] shrink-0 items-center rounded-lg border border-amber-400/40 px-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200 hover:bg-amber-400/10"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── the switch offer (the run overlay's grammar; candidate for a shared export) ─
// Since 2026-08-13 the ceremony has already ASKED once by the time this renders
// (useLaneAutoSwitch) — this is what makes a refusal a pause, not a dead end:
// the same mutation, the same declined copy, clicked by hand.

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
          Your wallet stayed on {sw.walletWords}, so nothing was sent. Try again when you are ready, or change the
          network in your wallet.
        </p>
      )}
    </div>
  )
}

// ── the per-leg deploy executor ───────────────────────────────────────────────
// Mounted for the ACTIVE lane only, keyed by that lane, so useDeployBasket's
// whole machine re-mounts per leg (the LegTradeExecutor pattern). PREPARE ON
// ARM (mount), BROADCAST ON THE CTA. Every write carries this lane's chainId —
// useDeployBasket enforces walletChainId === chainId before anything arms.

function LaneDeployExecutor({
  lane,
  draft,
  thesisName,
  sw,
  walletChainId,
  demoLeg,
  onStage,
  onBusy,
  onShipped,
  onFail,
}: {
  lane: ThesisReshapeLane
  draft: ReshapeDraft
  thesisName: string
  sw: NetworkSwitch
  walletChainId: number | undefined
  /** True ⇒ this predecessor is synthetic and the ceremony is REAL — refuse. */
  demoLeg: boolean
  onStage: (words: string) => void
  onBusy: (busy: boolean) => void
  onShipped: (token: Address) => void
  onFail: (message: string) => void
}) {
  const { address } = useAccount()
  const deploy = useDeployBasket(lane.chainId)
  const { data: allBaskets } = useAllBaskets()
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    // The last line of the refusal-first law: an executor must never prepare
    // against a synthetic predecessor in a real ceremony.
    if (demoLeg) {
      startedRef.current = true
      onFail(DEMO_RESHAPE_REFUSAL)
      return
    }
    if (!address) return // the deck offers connect before mounting this; belt and braces
    startedRef.current = true
    // The launcher is the ONE feeConfig field never carried from v1: the seed
    // writes an explicit zero placeholder that deploy stages MUST replace
    // (seedFeeConfig, version-seed.ts). Re-derive it from live wallet/referral
    // state exactly as PublishBundleModal's LaneExecutor does — deriveLauncher
    // is the one implementation, and the referral is one-shot: marked used on
    // the arm that applies it, so a later lane reverts to the operator.
    const { launcher, appliedReferrer } = deriveLauncher({
      account: address,
      allBaskets,
      referrer: getStoredRef(),
      refAlreadyUsed: hasCreatorRefBeenUsed(),
    })
    if (appliedReferrer) markCreatorRefUsed()
    void deploy.prepare({
      name: thesisName,
      symbol: draft.symbol,
      assets: draft.legs.map((l) => ({ address: l.address, decimals: l.decimals, route: l.route })),
      weights: draft.weights,
      // rate/share/payout carried VERBATIM from the current version (the
      // contract's rule — fee editing lives in the full studio, not this
      // popup); ONLY the launcher is replaced, per the contract above
      feeConfig: { ...draft.feeConfig, launcher },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  // Surface the deploy machine's stages in the lane, and report terminal
  // outcomes exactly once.
  const lastStatusRef = useRef<string | null>(null)
  useEffect(() => {
    if (deploy.status === lastStatusRef.current) return
    lastStatusRef.current = deploy.status
    onBusy(deploy.status === 'signing' || deploy.status === 'confirming' || deploy.status === 'seeding')
    if (deploy.status === 'success') {
      if (deploy.token) onShipped(deploy.token)
      else onFail('The deploy confirmed but the new address could not be read from the receipt — check your wallet activity before retrying.')
      return
    }
    if (deploy.status === 'error') {
      onFail(deploy.error ?? 'The deploy failed.')
      return
    }
    const words = deployStageWords(deploy.status)
    if (words) onStage(words)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploy.status, deploy.token, deploy.error])

  useEffect(() => () => onBusy(false), [onBusy])

  const priceWords =
    deploy.priceWei != null ? `${(Number(deploy.priceWei) / 1e18).toFixed(4)} ETH + gas` : 'the network’s deploy price + gas'
  const busy = deploy.status === 'signing' || deploy.status === 'confirming'
  const preparing = deploy.status === 'mining' || deploy.status === 'preparing' || deploy.status === 'idle'
  const mismatch = walletChainId !== lane.chainId

  return (
    <div>
      {mismatch && (
        <WrongNetworkNotice
          requiredChainId={lane.chainId}
          action="This deploy signs"
          sw={sw}
          compact
          className="mb-3"
        />
      )}
      <button
        type="button"
        disabled={preparing || busy || mismatch || !deploy.enabled}
        onClick={() => void deploy.broadcast()}
        className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy
          ? deploy.status === 'confirming'
            ? 'Confirming…'
            : 'In your wallet…'
          : preparing
            ? (deployStageWords(deploy.status, deploy.attempts) ?? 'Preparing…')
            : `Ship on ${chainLabel(lane.chainId)} — ${priceWords}`}
      </button>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        one deploy transaction · the current version keeps trading
      </p>
      {!deploy.enabled && !mismatch && deploy.status === 'ready' && (
        <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-200/90">
          Deploys are disabled on this build, so the ceremony cannot arm here.
        </p>
      )}
    </div>
  )
}

// ── the lineage signer (the silent supersedes signature) ─────────────────────
// One hook mount per (lane, newAddress), armed the moment the deploy landed.
// The consumed surface is the seam's documented minimum: status / error /
// sign(). A refusal is surfaced as the lane's failed state with the recovery
// note — the deploy is NOT retried for a missing signature.

function LaneLineageSigner({
  lane,
  newToken,
  onBusy,
  onDone,
  onRefused,
}: {
  lane: ThesisReshapeLane
  newToken: `0x${string}`
  onBusy: (busy: boolean) => void
  onDone: () => void
  onRefused: () => void
}) {
  // armed:true fires the wallet sheet ONCE on mount (the hook's own one-shot
  // latch); this component's button exists for the refused → retry re-offer.
  const lineage = useLineageSign({ predecessor: lane.predecessor, chainId: lane.chainId, newToken, armed: true })
  const doneRef = useRef(false)
  const refusedRef = useRef(false)

  useEffect(() => {
    onBusy(lineage.state === 'signing')
    if (lineage.state === 'signing') refusedRef.current = false
    if (lineage.state === 'done' && !doneRef.current) {
      doneRef.current = true
      onDone()
    } else if (lineage.state === 'refused' && !refusedRef.current) {
      // reported once per attempt — a retry that gets refused again re-reports,
      // a retry that succeeds still reaches onDone (never latched by a refusal)
      refusedRef.current = true
      onRefused()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineage.state])

  useEffect(() => () => onBusy(false), [onBusy])

  const busy = lineage.state === 'signing'
  return (
    <div>
      <button
        type="button"
        disabled={busy || lineage.state === 'done'}
        onClick={() => lineage.retry()}
        className="spectral-btn press inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'In your wallet…' : `Sign the lineage on ${chainLabel(lane.chainId)}`}
      </button>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        free, off-chain · marks the new version as this basket&rsquo;s successor
      </p>
    </div>
  )
}

// ── the success plate ─────────────────────────────────────────────────────────

function SuccessPlate({
  lanes,
  drafts,
  name,
  deployer,
  demo,
  onSeedOverlayChange,
  onDone,
}: {
  lanes: ThesisReshapeLane[]
  drafts: Record<number, ReshapeDraft>
  /** The shipped name — the seed run's identity. */
  name: string
  deployer: string
  demo: boolean
  onSeedOverlayChange: (open: boolean) => void
  onDone: () => void
}) {
  const shipped = runnableLanes(lanes)
  // The plate's PRIMARY act (owner 2026-08-12): the new versions start EMPTY —
  // the seed door opens the whole bundle with one stake through the run
  // overlay's own routing/bridging, split by the shipped deploy weights. In a
  // walkthrough the door mounts the overlay's demo — nothing arms.
  const seedPlan = reshapeSeedPlan(lanes, drafts, demo)
  const hasDoor = seedPlan.legs.length > 0
  return (
    <div className="relative mt-6 overflow-hidden rounded-2xl border border-teal/30 bg-teal/[0.04] p-6">
      {/* A SHIP DESERVES A CEREMONY (owner 2026-08-16: "it didnt show any pop
          up like congrats you created a new version, it just went back to the
          creator page") — the quiet 'complete' eyebrow read as nothing having
          happened. Headline at display size, the claim-card's own gradient
          crown; the zero-shipped case keeps the honest quiet face instead of
          congratulating nobody. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
      {shipped.length > 0 && !demo ? (
        <>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">✓ shipped</div>
          <h3 className="mt-2 font-display text-2xl font-bold tracking-tight text-ink">
            Your new {shipped.length === 1 ? 'version is' : 'versions are'} live
          </h3>
        </>
      ) : (
        <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: ACCENT }}>
          complete
        </div>
      )}
      <p className="mt-3 text-sm leading-relaxed text-ink-dim">
        {demo ? 'That is the whole ceremony — in a real reshape each network would now hold a live new version.' : shipped.length === 0 ? (
          'Nothing shipped — every network kept its current version (the rows below say why per network).'
        ) : (
          <>
            Live on {shipped.length} {shipped.length === 1 ? 'network' : 'networks'}. The current baskets stay exactly
            as they were — holders can swap into each new version from its page, on their own schedule. Each new
            version starts empty — the first buy on each network opens it.
          </>
        )}
      </p>
      <div className="mt-5 space-y-2">
        {lanes.map((lane) => (
          <div key={lane.chainId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/8 bg-black/20 px-3.5 py-2.5">
            <ChainBadge chainId={lane.chainId} size="md" />
            {drafts[lane.chainId]?.symbol != null && lane.state === 'done' && (
              <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                ${showSymbol(drafts[lane.chainId].symbol)}
              </span>
            )}
            <span className="flex-1" />
            {lane.state === 'skipped' ? (
              <span className="font-mono text-[11px] text-ink-faint">kept its current version</span>
            ) : lane.newAddress ? (
              <Link
                to={`/token?addr=${lane.newAddress}&chain=${lane.chainId}`}
                className="press font-mono text-[11px] text-ink-dim underline decoration-white/20 underline-offset-4 hover:text-ink"
              >
                view its page · {shortAddr(lane.newAddress)}
              </Link>
            ) : (
              <span className="font-mono text-[11px] text-ink-dim">{demo ? 'shipped (walkthrough)' : 'shipped'}</span>
            )}
          </div>
        ))}
      </div>
      {hasDoor ? (
        <>
          <SeedBundleDoor
            plan={seedPlan}
            name={name}
            deployer={deployer}
            demo={demo}
            accent={ACCENT}
            gradient={`linear-gradient(90deg, var(--color-cyan), ${ACCENT})`}
            textClass="text-void"
            onOverlayChange={onSeedOverlayChange}
          />
          <button
            type="button"
            onClick={onDone}
            className="press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/12 px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            Done
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onDone}
          className="spectral-btn press mt-6 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
        >
          Done
        </button>
      )}
    </div>
  )
}

// ── demo deck words ──────────────────────────────────────────────────────────

function demoDeckLabel(active: ThesisReshapeLane): string {
  switch (active.state) {
    case 'queued':
    case 'switch':
      return `Switch to ${chainLabel(active.chainId)}`
    case 'deploying':
      return `Ship on ${chainLabel(active.chainId)}`
    case 'signing-lineage':
      return `Sign the lineage on ${chainLabel(active.chainId)}`
    default:
      return 'Watching the ceremony…'
  }
}
