import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import { formatEther } from 'viem'
import { useAccount } from 'wagmi'
import { chainCfg } from '../../lib/chain/chains'
import { DEPLOY_ENABLED } from '../../lib/config/features'
import { LAUNCHER_ADDRESS } from '../../lib/config/operator'
import { useBasketData } from '../../lib/spectrum/hooks'
import { shortAddr } from '../../lib/spectrum/format'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { basketHref } from '../../lib/spectrum/short-url'
import { useDeployBasket } from '../../lib/spectrum/use-deploy'
import { useLineageSign } from '../../lib/spectrum/use-lineage-sign'
import { useVersionSeed } from '../../lib/spectrum/version-seed'
import { computeBasketDiff, type ConstituentDiff } from '../../lib/spectrum/versioning'
import { AssetLogo } from '../AssetLogo'
import { WrongNetwork, useNetworkSwitch } from '../WrongNetwork'
import { ShapeEditor } from './ShapeEditor'
import {
  clampSymbolInput,
  demoSubjectRefusal,
  draftReadyToShip,
  draftToDeployInput,
  draftToDiffSide,
  droppedLine,
} from './reshape-model'
import { DEMO_DEPLOY_SCRIPT, type ReshapeBasketModalProps, type ReshapeDraft } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// RESHAPE, ONE BASKET — three stages in one popup (PositionsMode's grammar).
//
// THE ONE FACT: a published basket is immutable, so "editing" here is shipping
// a NEW VERSION — a real deploy plus one lineage signature. Every stage keeps
// that legible: the review SAYS "ships $SYMV2 as a new version" in words, the
// ceremony is a deploy ceremony, and nothing on this surface is
// mutation-shaped.
//
//   SHAPE  — the seeded draft (useVersionSeed), edited under the builder's law
//   REVIEW — the factual diff + the fee row verbatim + THE HONESTY PLATE
//   SHIP   — the real useDeployBasket ceremony (or the scripted demo), then
//            the silent supersedes signature (useLineageSign)
//
// JOIN MODE (`joinThesis` — reshape-types.ts): the SAME popup is also how a
// basket enters a multichain thesis. The grouper keys on (deployer, name) and
// names are immutable on-chain, so joining is exactly "ship a version renamed
// to the bundle's name" — the draft's name seeds to it, the field carries a
// quiet join note (editing the name un-joins, stated), and the honesty plate
// says what landing under that name does. No fourth stage, no new machinery.
//
// Ceremony host: a COMPACT strip, not DeployPortal. DeployPortal is a
// full-viewport takeover (fixed inset-0 z-[100]) that navigates on its own at
// success (DeployPortal.tsx:518) — inside this modal it would cover the popup
// and leave before the lineage signature, which is the half that makes a
// version a version. The strip speaks the portal's own stage copy instead.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

type Stage = 'shape' | 'review' | 'ship'

const STAGES: { id: Stage; label: string }[] = [
  { id: 'shape', label: 'Shape' },
  { id: 'review', label: 'Review' },
  { id: 'ship', label: 'Ship' },
]

/** Percent from bps for the display-only fee row. */
function pctOfBps(bps: number): string {
  const pct = bps / 100
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 2)}%`
}

// The diff row grammar is BasketDiff.tsx's own (rail + chip + from→to); the
// component itself reads BOTH baskets from chain (useBasketDiff), and the next
// version does not exist yet here — so the rows are drawn locally over
// computeBasketDiff, in the same idiom, symbols bounded.
const KIND_META: Record<ConstituentDiff['kind'], { label: string; color: string }> = {
  added: { label: 'Added', color: 'var(--color-teal)' },
  removed: { label: 'Removed', color: '#ff4d6d' },
  reweighted: { label: 'Reweighted', color: 'var(--color-amber)' },
  unchanged: { label: 'Unchanged', color: 'var(--color-ink-dim)' },
}

const wt = (p: number | null): string => (p == null ? '—' : `${p.toFixed(p % 1 === 0 ? 0 : 1)}%`)

/** The five beats of the ship ceremony, in the deploy hook's own order. */
const BEATS = [
  { id: 'mine', label: 'Mine the hook address' },
  { id: 'price', label: 'Price + simulate' },
  { id: 'sign', label: 'Your signature' },
  { id: 'confirm', label: 'Confirm on-chain' },
  { id: 'link', label: 'Link the lineage' },
] as const

function beatIndex(status: string): number {
  switch (status) {
    case 'mining':
      return 0
    case 'preparing':
      return 1
    case 'ready':
    case 'signing':
      return 2
    case 'confirming':
    case 'seeding':
      return 3
    case 'success':
      return 4
    default:
      return -1 // idle / error: no current beat
  }
}

/** The grouper's own name fold (thesis.ts keeps its copy private): case and
 *  whitespace differences are one name to it, so the "joined" check below must
 *  fold the same way — a check stricter than the grouping it predicts would
 *  call a shipping join broken. */
function foldName(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function ReshapeBasketModal({ address, chainId, demo = false, joinThesis, onClose }: ReshapeBasketModalProps) {
  const [stage, setStage] = useState<Stage>('shape')
  const [draft, setDraft] = useState<ReshapeDraft | null>(null)
  // KEEP-SAME ticker (owner 2026-08-12): the draft seeds v1's own symbol, so
  // the ticker is stated as a quiet fact until the creator asks to change it.
  const [changeTicker, setChangeTicker] = useState(false)
  const navigate = useNavigate()
  const { isConnected } = useAccount()

  const seed = useVersionSeed(address, chainId)
  const v1 = useBasketData(address, chainId)
  const deploy = useDeployBasket(chainId)
  const sw = useNetworkSwitch(chainId)

  // Seed the editable draft ONCE when the resolution lands; later seed
  // refreshes must not clobber edits in progress. In join mode the name seeds
  // to the TARGET THESIS's name over the predecessor's — that rename is the
  // entire join mechanism (reshape-types.ts on `joinThesis`).
  useEffect(() => {
    if (seed.status === 'ready' && seed.draft && draft == null) {
      setDraft(joinThesis ? { ...seed.draft, name: joinThesis.name } : seed.draft)
    }
  }, [seed.status, seed.draft, draft, joinThesis])

  // Joined is a LIVE fact about the draft, not a mode flag: the name is what
  // groups, so the moment it stops matching, this ships as its own basket and
  // every join sentence below must disappear with it.
  const joined = joinThesis != null && draft != null && foldName(draft.name) === foldName(joinThesis.name)

  // THE REFUSAL LAW, first line of anything that could arm (thesis-run.ts:134):
  // REAL mode on a demo subject never deploys a version of nothing.
  const refusal = demoSubjectRefusal(address, demo)

  const lineage = useLineageSign({
    predecessor: (seed.predecessor ?? address) as `0x${string}`,
    chainId,
    newToken: deploy.token,
    armed: !demo && !refusal && deploy.status === 'success' && !!deploy.token,
  })

  // ── demo ceremony: the SAME strip, driven by the script on timers ─────────
  const [demoIdx, setDemoIdx] = useState(0)
  const [demoLineage, setDemoLineage] = useState<'idle' | 'signing' | 'done'>('idle')
  const [demoRun, setDemoRun] = useState(0) // bump to replay
  useEffect(() => {
    if (stage !== 'ship' || !demo) return
    setDemoIdx(0)
    setDemoLineage('idle')
    const timers: number[] = []
    let acc = 0
    DEMO_DEPLOY_SCRIPT.forEach((_, i) => {
      if (i === 0) return
      acc += DEMO_DEPLOY_SCRIPT[i - 1].ms
      timers.push(window.setTimeout(() => setDemoIdx(i), acc))
    })
    const total = DEMO_DEPLOY_SCRIPT.reduce((s, b) => s + b.ms, 0)
    timers.push(window.setTimeout(() => setDemoLineage('signing'), total + 400))
    timers.push(window.setTimeout(() => setDemoLineage('done'), total + 400 + 1800))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [stage, demo, demoRun])

  // ── the real arm: prepare on entering SHIP, once per entry ────────────────
  const armedRef = useRef(false)
  const [armError, setArmError] = useState<string | null>(null)
  useEffect(() => {
    if (stage !== 'ship' || demo || refusal) return
    if (!DEPLOY_ENABLED || !isConnected || sw.mismatch) return
    if (!draftReadyToShip(draft)) return
    if (armedRef.current || deploy.status !== 'idle') return
    armedRef.current = true
    try {
      void deploy.prepare(draftToDeployInput(draft, { launcher: (LAUNCHER_ADDRESS ?? ZERO_ADDR) as `0x${string}` }))
    } catch (e) {
      // the stage gate should make this unreachable; if it isn't, refuse
      // loudly rather than shape a dishonest deploy
      setArmError(e instanceof Error ? e.message : String(e))
    }
  }, [stage, demo, refusal, isConnected, sw.mismatch, draft, deploy])

  const backToReview = () => {
    // leaving the ship stage un-arms it: a re-entered ceremony re-prepares
    // against the CURRENT draft (a stale salt would deploy a stale shape)
    armedRef.current = false
    setArmError(null)
    deploy.reset()
    setStage('review')
  }

  // ── close discipline (PositionsMode's law: layered Esc, guarded mid-run) ──
  const realBusy =
    !demo &&
    (deploy.status === 'signing' ||
      deploy.status === 'confirming' ||
      deploy.status === 'seeding' ||
      lineage.state === 'signing')
  const [escArmed, setEscArmed] = useState(false)
  const escTimer = useRef<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef(stage)
  stageRef.current = stage
  const busyRef = useRef(realBusy)
  busyRef.current = realBusy
  const successRef = useRef(false)
  successRef.current = demo ? demoLineage === 'done' : deploy.status === 'success'
  const backRef = useRef(backToReview)
  backRef.current = backToReview

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const opener = document.activeElement as HTMLElement | null
    panelRef.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      // a stacked dialog (the asset search) owns its own keys: while focus
      // lives in another dialog, this popup neither steps back nor traps Tab
      const t = e.target
      if (t instanceof Element && !panelRef.current?.contains(t) && t.closest('[role="dialog"]')) return
      if (e.key === 'Escape') {
        if (busyRef.current) {
          // mid-deploy: the first Esc arms a stated confirm, the second closes.
          // The transaction continues on-chain either way — closing hides the
          // ceremony, it cannot un-sign anything.
          setEscArmed((armed) => {
            if (armed) {
              onClose()
              return armed
            }
            if (escTimer.current != null) window.clearTimeout(escTimer.current)
            escTimer.current = window.setTimeout(() => setEscArmed(false), 4000)
            return true
          })
          return
        }
        const s = stageRef.current
        if (s === 'ship') {
          if (successRef.current) onClose()
          else backRef.current()
        } else if (s === 'review') setStage('shape')
        else onClose()
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, a[href], [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
      if (escTimer.current != null) window.clearTimeout(escTimer.current)
      opener?.focus?.()
    }
  }, [onClose])

  // a new page of the popup starts at its top, focus inside it
  const veilRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    veilRef.current?.scrollTo({ top: 0 })
    panelRef.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus()
  }, [stage])

  // ── derived render facts ───────────────────────────────────────────────────
  const v1Symbol = v1.data?.symbol ?? null
  const diff = useMemo(
    () => (v1.data && draft ? computeBasketDiff(v1.data, draftToDiffSide(draft, chainId)) : null),
    [v1.data, draft, chainId],
  )
  const dropped = droppedLine(seed.dropped)
  const chainName = chainCfg(chainId).name

  const demoStatus = DEMO_DEPLOY_SCRIPT[demoIdx]?.status ?? 'mining'
  const ceremonyStatus = demo ? demoStatus : deploy.status
  const lineageState = demo ? demoLineage : lineage.state
  const shipped = demo ? demoStatus === 'success' : deploy.status === 'success'
  const currentBeat = shipped && lineageState !== 'done' ? 4 : beatIndex(ceremonyStatus)
  const settled = shipped && (demo ? demoLineage === 'done' : lineage.state === 'done' || lineage.state === 'refused')

  const newSym = draft ? showSymbol(draft.symbol) : ''
  const oldSym = v1Symbol ? showSymbol(v1Symbol) : null
  // Keep-same tickers (the default since 417da71) make symbol-led copy read as
  // nonsense — "links $AICYCLE → $AICYCLE", "$AICYCLE stays exactly as it is"
  // right after "This ships $AICYCLE": one symbol, two tokens. Where the two
  // symbols are EQUAL the copy speaks in versions instead (the file's own
  // null-fallback idiom); where they differ, the $OLD → $NEW form stays.
  const sameSym = !!oldSym && oldSym === newSym
  // the ticker input stays out once asked for — and structurally whenever the
  // draft's symbol already differs from v1's, so the quiet "same ticker" fact
  // line can never sit over an edited ticker
  const showTickerInput = changeTicker || (draft != null && v1Symbol != null && draft.symbol !== v1Symbol)

  const viewNew = () => {
    if (!deploy.token || !draft) return
    onClose()
    navigate(basketHref({ symbol: draft.symbol, address: deploy.token, chainId }))
  }

  const ghostBtn =
    'press inline-flex h-10 items-center gap-2 rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan'
  const primaryBtn =
    'spectral-btn press inline-flex h-11 items-center gap-2 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50'

  // ── sub-copy for the ceremony beats (the portal's own stage language) ──────
  const beatSub = (i: number): string | null => {
    if (i !== currentBeat) return null
    if (i === 0)
      return demo
        ? 'walking the CREATE2 salt search — the real one can take minutes'
        : `Mining the 0x88 hook address… ${deploy.attempts.toLocaleString()} salts tried (CREATE2) · could take a few minutes`
    if (i === 1) return 'hook address mined · reading the launch price + dry-running the deploy'
    if (i === 2)
      return ceremonyStatus === 'signing'
        ? demo
          ? 'the wallet prompt would open here'
          : 'confirm in your wallet…'
        : demo
          ? 'this is where the ship button arms'
          : `ready · launch price ${deploy.priceWei != null ? formatEther(deploy.priceWei) : '—'} ETH + gas — nothing ships until you press`
    if (i === 3) return `confirming on ${chainName} — keep this open`
    if (i === 4) {
      if (lineageState === 'signing')
        return demo
          ? 'the silent supersedes signature — it declares the succession, no money moves'
          : `one more signature links ${sameSym || !oldSym ? 'the current version' : `$${oldSym}`} → ${sameSym ? 'the new version' : `$${newSym}`} — it declares the succession, no money moves`
      return null
    }
    return null
  }

  return createPortal(
    <div
      ref={veilRef}
      className="fixed inset-0 z-50 overflow-y-auto bg-void/60 backdrop-blur-[6px]"
      role="dialog"
      aria-modal="true"
      aria-label={v1Symbol ? `Reshape $${showSymbol(v1Symbol)} — ship a new version` : 'Reshape — ship a new version'}
      onClick={(e) => {
        if (e.target === e.currentTarget && !realBusy) onClose()
      }}
    >
      <div className="mx-auto my-3 w-[min(920px,calc(100vw_-_1rem))] sm:my-6 sm:w-[min(920px,calc(100vw_-_2rem))]">
        <div
          ref={panelRef}
          className="panel-in flex flex-col overflow-hidden rounded-[2rem] border border-white/12 bg-panel/90 shadow-[0_48px_128px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
        >
          {/* the spectral top bar — the popup's own signature */}
          <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL, backgroundSize: '300% 100%', animation: 'spectrum-refract 16s ease-in-out infinite' }} />

          <div className="p-5 sm:p-8">
            {/* ── header: station eyebrow + title + close ── */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                  <span>ship a new version</span>
                  <span aria-hidden>·</span>
                  {STAGES.map((s, i) => (
                    <span key={s.id} className={s.id === stage ? 'text-cyan' : undefined}>
                      {i + 1} {s.label}
                    </span>
                  ))}
                </p>
                <h2 className="mt-2 font-display text-3xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-4xl">
                  <span className="block">Reshape</span>
                  <span className="block text-ink-dim">{v1Symbol ? `$${showSymbol(v1Symbol)}` : shortAddr(address)}</span>
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {escArmed && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200/90">
                    deploy in flight — Esc again closes; it continues on-chain
                  </span>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="press grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* ════ STAGE 1 · SHAPE ════ */}
            {stage === 'shape' && (
              <div className="mt-6">
                {seed.status === 'loading' && (
                  <div aria-busy="true" className="space-y-3">
                    <div className="h-12 w-2/3 animate-pulse rounded-xl bg-white/[0.04]" />
                    <div className="h-[340px] animate-pulse rounded-2xl bg-white/[0.03]" />
                    <div className="h-[64px] animate-pulse rounded-2xl bg-white/[0.03]" />
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint" role="status">
                      reading v1's legs and re-resolving each pool…
                    </p>
                  </div>
                )}

                {seed.status === 'error' && (
                  <div className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.05] p-5">
                    <p className="font-display text-sm font-bold uppercase tracking-wide text-amber-200">
                      The draft could not be seeded
                    </p>
                    <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                      {seed.error ?? 'v1 could not be read right now.'}
                    </p>
                    <button type="button" onClick={seed.retry} className={`${ghostBtn} mt-4`}>
                      Try again
                    </button>
                  </div>
                )}

                {seed.status === 'ready' && draft && (
                  <>
                    {dropped && (
                      <p className="mb-6 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
                        {dropped}
                      </p>
                    )}

                    {/* identity — editable. The ticker seeds as v1's OWN symbol
                        (keep-same default, owner 2026-08-12): a quiet fact line
                        until the change-ticker toggle reveals the input. In
                        join mode the name arrives as the thesis's and wears a
                        quiet mark; it is still a plain input — un-joining is
                        typing, not a control. */}
                    <div className="flex flex-wrap items-end gap-4">
                      <label className="min-w-0 flex-1 basis-64">
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                          {joined ? (
                            <>
                              Name <span className="text-cyan">· joining</span>
                            </>
                          ) : (
                            'Name'
                          )}
                        </span>
                        <input
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                          placeholder="Basket name"
                          className={`mt-1 h-12 w-full rounded-xl border ${joined ? 'border-cyan/40' : 'border-white/15'} bg-white/[0.04] px-4 font-display text-sm font-bold text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none`}
                        />
                      </label>
                      {showTickerInput ? (
                        <label className="w-40">
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                            Ticker
                          </span>
                          <input
                            value={draft.symbol}
                            onChange={(e) => setDraft({ ...draft, symbol: clampSymbolInput(e.target.value) })}
                            placeholder="TICKER"
                            autoFocus
                            className="mt-1 h-12 w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 font-mono text-sm font-bold uppercase text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none"
                          />
                        </label>
                      ) : (
                        <div className="flex items-center gap-3 pb-4">
                          <span className="font-mono text-[10px] leading-relaxed text-ink-faint">
                            ships as <span className="text-ink-dim">${showSymbol(draft.symbol)}</span> — same ticker
                          </span>
                          <button
                            type="button"
                            onClick={() => setChangeTicker(true)}
                            className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan underline-offset-4 hover:underline"
                          >
                            Change the ticker
                          </button>
                        </div>
                      )}
                    </div>

                    {/* the change-ticker hint — the mechanism stated once the
                        input is out: shipping never renames the old version */}
                    {showTickerInput && (
                      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
                        {oldSym
                          ? `the old version keeps trading as $${oldSym} until holders migrate, so two live tokens may briefly share the ticker.`
                          : 'the old version keeps trading under its ticker until holders migrate, so two live tokens may briefly share it.'}
                      </p>
                    )}

                    {/* the join note — quiet, and honest in BOTH directions:
                        while the name matches it says what the match does;
                        the moment it stops matching it says this ships outside
                        the thesis, with the one-tap way back. */}
                    {joinThesis && (
                      <p className={`mt-2 font-mono text-[10px] leading-relaxed ${joined ? 'text-cyan/90' : 'text-amber-200/90'}`}>
                        {joined ? (
                          <>
                            joining the bundle &lsquo;{showName(joinThesis.name)}&rsquo; — the name is what groups
                            them; editing the name un-joins
                          </>
                        ) : (
                          <>
                            the name no longer matches &lsquo;{showName(joinThesis.name)}&rsquo; — this ships as its
                            own basket, outside the bundle.{' '}
                            <button
                              type="button"
                              onClick={() => setDraft({ ...draft, name: joinThesis.name })}
                              className="underline underline-offset-2 hover:text-ink"
                            >
                              restore the bundle name
                            </button>
                          </>
                        )}
                      </p>
                    )}

                    <div className="mt-6">
                      <ShapeEditor chainId={chainId} draft={draft} onChange={setDraft} />
                    </div>

                    <div className="mt-8 flex flex-wrap items-center gap-4">
                      <span className="font-mono text-[10px] leading-relaxed text-ink-faint">
                        editing ships a new version — nothing changes on{' '}
                        {v1Symbol ? `$${showSymbol(v1Symbol)}` : 'the live basket'} itself
                      </span>
                      <button
                        type="button"
                        disabled={!draftReadyToShip(draft)}
                        onClick={() => setStage('review')}
                        className={`${primaryBtn} ml-auto`}
                      >
                        Review the new version →
                      </button>
                    </div>
                    {/* the disabled CTA states its blocker (audit 2026-08-16:
                        clearing Name or Ticker killed the button with nothing
                        said anywhere — the weights case had ShapeEditor's
                        running total, the identity cases had silence). The
                        sibling modal's reviewBlocker grammar. */}
                    {/* an empty identity IS the not-ready case for these two
                        fields, so the trims are the whole test (the ready
                        predicate is a type guard and would narrow draft away) */}
                    {(!draft.name.trim() || !draft.symbol.trim()) && (
                      <p className="mt-2 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200/80">
                        {!draft.name.trim()
                          ? 'give the new version its name first'
                          : 'give the new version its ticker first'}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ════ STAGE 2 · REVIEW ════ */}
            {stage === 'review' && draft && (
              <div className="mt-6">
                <div className="flex items-center justify-between gap-4">
                  <button type="button" onClick={() => setStage('shape')} className={ghostBtn}>
                    ← Back to shape
                  </button>
                </div>

                {/* identity change, stated when it exists */}
                {v1.data && (draft.symbol !== v1.data.symbol || draft.name !== v1.data.name) && (
                  <p className="mt-6 font-mono text-[11px] leading-relaxed text-ink-dim">
                    <span className="text-ink-faint">identity · </span>
                    {showName(v1.data.name)} (${showSymbol(v1.data.symbol)}){' '}
                    <span aria-hidden className="text-cyan">
                      →
                    </span>{' '}
                    <span className="text-ink">
                      {showName(draft.name)} (${showSymbol(draft.symbol)})
                    </span>
                  </p>
                )}

                {/* the factual diff — on-chain v1 against the draft */}
                <div className="mt-6">
                  {v1.isLoading && <div className="h-28 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />}
                  {!v1.isLoading && !diff && (
                    <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
                      v1 could not be read right now, so the change list can't be drawn — the shape you
                      reviewed on the last page is still exactly what ships.
                    </p>
                  )}
                  {diff && (
                    <ul className="space-y-2">
                      {diff.constituents.map((c) => {
                        const m = KIND_META[c.kind]
                        const removed = c.kind === 'removed'
                        return (
                          <li
                            key={c.asset}
                            className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-white/8 py-2.5 pl-4 pr-4"
                            style={{ background: `linear-gradient(90deg, ${m.color}14, ${m.color}05 40%, rgba(255,255,255,0.02) 80%)` }}
                          >
                            <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: m.color }} />
                            <AssetLogo address={c.asset} symbol={c.symbol} chainId={chainId} size={28} />
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className={`truncate font-display text-base font-bold ${removed ? 'text-ink-faint line-through' : 'text-ink'}`}>
                                ${showSymbol(c.symbol)}
                              </span>
                              <span
                                className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide"
                                style={{ color: m.color, background: `${m.color}24` }}
                              >
                                {m.label}
                              </span>
                            </div>
                            <div className="shrink-0 font-num text-base tabular-nums">
                              {c.kind === 'reweighted' ? (
                                <span className="flex items-center gap-2">
                                  <span className="text-ink-faint">{wt(c.fromWeightPct)}</span>
                                  <span aria-hidden style={{ color: m.color }}>
                                    →
                                  </span>
                                  <span className="font-semibold text-ink">{wt(c.toWeightPct)}</span>
                                </span>
                              ) : c.kind === 'added' ? (
                                <span className="font-semibold" style={{ color: m.color }}>
                                  +{wt(c.toWeightPct)}
                                </span>
                              ) : removed ? (
                                <span className="text-ink-faint line-through">{wt(c.fromWeightPct)}</span>
                              ) : (
                                <span className="text-ink-dim">{wt(c.toWeightPct)}</span>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>

                {/* the fee row — VERBATIM from v1, display-only */}
                <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">fees · carried from v1</span>
                  <span className="font-mono text-[11px] tabular-nums text-ink">
                    fee {pctOfBps(draft.feeConfig.basketFeeBps)} · creator share {pctOfBps(draft.feeConfig.creatorShareBps)}
                    {draft.feeConfig.creatorShareBps > 0 && ` · payout ${shortAddr(draft.feeConfig.creatorPayout)}`}
                  </span>
                  <Link
                    to={`/create?from=${address}&chain=${chainId}`}
                    className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-cyan underline-offset-4 hover:underline"
                  >
                    edit fees in the full studio →
                  </Link>
                </div>

                {/* THE HONESTY PLATE — this sentence is the product. The join
                    sentence rides it ONLY while the name still matches: the
                    name is the join, so a renamed draft gets no thesis claim. */}
                <div className="relative mt-6 overflow-hidden rounded-xl border border-cyan/25 bg-cyan/[0.04] py-4 pl-5 pr-4">
                  <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-cyan" />
                  <p className="text-sm leading-relaxed text-ink">
                    This ships <span className="font-display font-bold">${newSym}</span> as a{' '}
                    <span className="font-display font-bold">new version</span>.{' '}
                    {oldSym && !sameSym ? `$${oldSym}` : 'The current version'} stays exactly as it is and keeps
                    trading. Holders see the new version on {oldSym && !sameSym ? `$${oldSym}'s` : 'its'} page and can
                    swap into it in one move, on their own schedule.
                    {joined && joinThesis && (
                      <>
                        {' '}
                        Shipping this version under the thesis&rsquo;s name adds it to{' '}
                        <span className="font-display font-bold">{showName(joinThesis.name)}</span> — the thesis page
                        shows it as a new network the moment it lands.
                      </>
                    )}
                  </p>
                </div>

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <span className="font-mono text-[10px] text-ink-faint">nothing deploys on this step</span>
                  <button type="button" onClick={() => setStage('ship')} className={`${primaryBtn} ml-auto`}>
                    Continue →
                  </button>
                </div>
              </div>
            )}

            {/* ════ STAGE 3 · SHIP ════ */}
            {stage === 'ship' && draft && (
              <div className="mt-6">
                {demo && (
                  <div className="mb-6 flex justify-center">
                    <span className="rounded-full border border-amber-400/40 bg-void/95 px-3.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-200">
                      demo — nothing deploys, no wallet involved
                    </span>
                  </div>
                )}

                {/* refusal first: REAL mode on a demo subject never arms */}
                {refusal ? (
                  <div className="rounded-2xl border border-magenta/40 bg-magenta/[0.05] p-5">
                    <p className="font-display text-sm font-bold uppercase tracking-wide text-magenta">Not armed</p>
                    <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-dim">{refusal}</p>
                  </div>
                ) : !demo && !DEPLOY_ENABLED ? (
                  /* deploys off on this build: state it plainly, offer nothing */
                  <div className="rounded-2xl border border-white/12 bg-white/[0.02] p-5">
                    <p className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                      Deploying is switched off on this build
                    </p>
                    <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                      Shipping a version is a real deploy, and this deployment has VITE_ENABLE_DEPLOY off — so
                      there is nothing this stage can honestly offer. The draft you shaped is not lost; it is
                      exactly what you reviewed.
                    </p>
                  </div>
                ) : !demo && !isConnected ? (
                  <div className="rounded-2xl border border-white/12 bg-white/[0.02] p-5">
                    <p className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                      A wallet signs the deploy
                    </p>
                    <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                      Shipping ${newSym} deploys a real basket on {chainName} — connect the wallet that will own
                      it.
                    </p>
                    <button
                      type="button"
                      onClick={() => window.dispatchEvent(new Event('spectrum:connect'))}
                      className={`${ghostBtn} mt-4`}
                    >
                      Connect wallet
                    </button>
                  </div>
                ) : !demo && sw.mismatch ? (
                  /* the deploy needs the wallet on the basket's chain — the
                     switch is OFFERED, never taken */
                  <WrongNetwork
                    requiredChainId={chainId}
                    action={`Shipping $${newSym} deploys`}
                    button={{ className: ghostBtn }}
                  />
                ) : armError ? (
                  <div className="rounded-2xl border border-magenta/40 bg-magenta/[0.05] p-5">
                    <p className="font-display text-sm font-bold uppercase tracking-wide text-magenta">Refused to arm</p>
                    <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-dim">{armError}</p>
                  </div>
                ) : (
                  <>
                    {/* the ceremony strip — the portal's stages, compact */}
                    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                      <ol className="space-y-3">
                        {BEATS.map((b, i) => {
                          const done =
                            i < currentBeat || (i === 4 && lineageState === 'done') || (i < 4 && shipped)
                          const current = i === currentBeat && !done
                          const sub = beatSub(i)
                          return (
                            <li key={b.id} className="flex items-start gap-3">
                              <span
                                aria-hidden
                                className={`mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${
                                  done
                                    ? 'bg-teal/20 text-teal'
                                    : current
                                      ? 'bg-cyan/20 text-cyan'
                                      : 'bg-white/[0.06] text-ink-faint'
                                }`}
                              >
                                {done ? '✓' : current ? <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" /> : ''}
                              </span>
                              <div className="min-w-0">
                                <p
                                  className={`font-mono text-[11px] uppercase tracking-[0.14em] ${
                                    done ? 'text-teal' : current ? 'text-ink' : 'text-ink-faint'
                                  }`}
                                >
                                  {b.label}
                                </p>
                                {sub && <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-dim">{sub}</p>}
                              </div>
                            </li>
                          )
                        })}
                      </ol>

                      {/* the deploy error, stated beside a free retry — the
                          mined salt survives a declined signature */}
                      {!demo && deploy.status === 'error' && deploy.error && (
                        <p className="mt-4 rounded-lg border border-magenta/40 bg-magenta/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
                          {deploy.error}
                        </p>
                      )}

                      {/* THE deploy action — the one button that costs money */}
                      {!demo && !shipped && (
                        <button
                          type="button"
                          onClick={() => {
                            if (deploy.salt) void deploy.broadcast()
                            else {
                              // prepare itself failed — re-arm from the top
                              armedRef.current = false
                              deploy.reset()
                            }
                          }}
                          disabled={deploy.status !== 'ready' && deploy.status !== 'error'}
                          className="press mt-5 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                          style={{ background: SPECTRAL }}
                        >
                          {deploy.status === 'error'
                            ? 'Try again · ship the new version'
                            : deploy.status === 'signing'
                              ? 'Confirm in wallet…'
                              : deploy.status === 'confirming'
                                ? 'Deploying…'
                                : deploy.status === 'ready'
                                  ? `Ship the new version · ${deploy.priceWei != null ? formatEther(deploy.priceWei) : '—'} ETH`
                                  : 'Preparing…'}
                        </button>
                      )}
                      {demo && !shipped && (
                        <button
                          type="button"
                          disabled
                          className="press mt-5 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black opacity-60"
                          style={{ background: SPECTRAL }}
                        >
                          Ship the new version
                        </button>
                      )}
                    </div>

                    {/* the lineage refusal — recoverable, and it says how */}
                    {!demo && shipped && lineage.state === 'refused' && (
                      <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3">
                        <p className="font-mono text-[10px] leading-relaxed text-amber-200/90">
                          Version link not signed{lineage.error ? `: ${lineage.error}` : ''}. ${newSym} is live
                          without it — its page has “Link previous version” whenever you want to sign the link.
                        </p>
                        <button type="button" onClick={lineage.retry} className={`${ghostBtn} mt-3`}>
                          Sign the link now
                        </button>
                      </div>
                    )}

                    {/* the success plate */}
                    {shipped && (
                      <div className="mt-4 rounded-2xl border border-teal/40 bg-teal/[0.04] p-5">
                        <p className="font-display text-lg font-bold uppercase tracking-wide text-teal">
                          {demo ? `$${newSym} would be live` : `$${newSym} is live`}
                        </p>
                        <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                          {/* same-symbol rule as the honesty plate: right after
                              "$X is live", "$X's page" would name two tokens
                              with one symbol — the old side speaks in versions */}
                          {lineageState === 'done'
                            ? `${oldSym && !sameSym ? `$${oldSym}` : 'The old version'}'s page now wears the version strip — holders swap across in one move, on their own schedule.`
                            : lineageState === 'signing'
                              ? 'finishing the lineage signature…'
                              : `the version strip appears on ${oldSym && !sameSym ? `$${oldSym}` : 'the old version'}'s page once the link is signed.`}
                          {!demo && ' Its first deposit is still open — make it from its page; the first deposit sets the live composition.'}
                        </p>
                        <div className="mt-4 flex flex-wrap items-center gap-4">
                          {demo ? (
                            <>
                              <button type="button" disabled className={`${primaryBtn} opacity-50`}>
                                View ${newSym} →
                              </button>
                              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                                a real ship opens the new basket's page — nothing was deployed here
                              </span>
                              <button type="button" onClick={() => setDemoRun((n) => n + 1)} className={`${ghostBtn} ml-auto`}>
                                Replay the walkthrough
                              </button>
                            </>
                          ) : shipped && !deploy.token ? (
                            /* audit 2026-08-16: deploy success with a NULL token
                               is reachable (use-deploy patches success when the
                               receipt yields no address) — this face used to
                               leave the only door permanently disabled under a
                               FALSE reason ("the link signature settles first";
                               no signature would ever fire). The sibling
                               modal's honest sentence + the tx door instead. */
                            <>
                              <span className="min-w-0 font-mono text-[10px] uppercase tracking-wide text-amber-200/90">
                                the deploy confirmed but the new address could not be read from the receipt.
                                check your wallet activity before retrying
                              </span>
                              {deploy.txHash && (
                                <a
                                  href={`${chainCfg(chainId).explorer}/tx/${deploy.txHash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="press ml-auto shrink-0 font-mono text-[11px] text-cyan hover:underline"
                                >
                                  view the deploy tx ↗
                                </a>
                              )}
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={viewNew}
                                disabled={!settled || !deploy.token}
                                className={primaryBtn}
                              >
                                View ${newSym} →
                              </button>
                              {!settled && (
                                <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                                  the link signature settles first
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* back — offered only while nothing real is committed */}
                {!realBusy && !shipped && (
                  <div className="mt-6">
                    <button type="button" onClick={backToReview} className={ghostBtn}>
                      ← Back to review
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
