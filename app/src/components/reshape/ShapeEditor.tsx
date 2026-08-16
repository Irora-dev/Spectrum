import { useEffect, useRef, useState } from 'react'
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, parseAbi, type Address } from 'viem'
import { clientFor } from '../../lib/chain/rpc'
import { lineageFor } from '../../lib/spectrum/basket-data'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { CAP, MAX_ASSETS, STEP, sum } from '../../lib/spectrum/weights'
import { AssetLogo } from '../AssetLogo'
import { AssetSearchModal } from '../AssetSearchModal'
import { MintOrb, type MintStatus } from '../launch/MintOrb'
import { BasketBento, type BentoItem } from '../BasketBento'
import { TrimBar } from '../TrimBar'
import { resolveAsset } from '../launch/BasketBuilder'
import {
  adjustDraftWeight,
  appendResolvedLeg,
  equalizeDraft,
  removeDraftLeg,
  setDraftWeightPct,
  validateAddAsset,
  type AddAssetEffects,
} from './reshape-model'
import type { ShapeEditorProps } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// The SHAPE stage — PositionsMode's picture-leads idiom under the BUILDER's
// weight law. The real BasketBento as tiles-as-controls; under it a FIXED
// dial slot (min-h-[64px] — the reshape law: the grid below never reflows on
// tap); the real TrimBar snapping to STEP; a List view with −/+ steppers; the
// real AssetSearchModal for adds, each pick validated the builder's way
// through reshape-model's pipeline. Pure controlled: every change lands as
// one onChange(nextDraft).
// ─────────────────────────────────────────────────────────────────────────────

// token0() probe — a pool answers, a plain ERC-20 reverts. SEMANTICS MIRROR
// BasketBuilder's private isPoolToken (BasketBuilder.tsx:90 — module-private
// there, so it cannot be imported): a definitive revert is the plain-ERC-20
// answer; a transient error gets ONE retry; anything still failing fails OPEN
// (not a pool) rather than blocking a legitimate token on an RPC blip.
const token0ProbeAbi = parseAbi(['function token0() view returns (address)'])
async function probeIsPoolToken(addr: string, chainId: number): Promise<boolean> {
  const probe = () =>
    clientFor(chainId).readContract({ address: addr as Address, abi: token0ProbeAbi, functionName: 'token0' })
  try {
    await probe().catch(async (e) => {
      if (
        e instanceof BaseError &&
        e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError)
      )
        throw e
      await new Promise((r) => setTimeout(r, 150))
      return probe()
    })
    return true
  } catch {
    return false
  }
}

/** The live effects behind the add pipeline — the builder's own machinery
 *  (resolveAsset = findBestPool + symbol read; lineageFor = the F7 guard),
 *  never lookalikes. Tests inject their own. EXPORTED for the bundle-union
 *  editor (ReshapeThesisModal), which validates one pick per network through
 *  the same pipeline — one implementation, per the reuse law. */
export const liveAddEffects: AddAssetEffects = {
  isPoolToken: probeIsPoolToken,
  basketLineage: (chainId, address) => lineageFor(chainId, address),
  resolve: (address, chainId, knownSymbol) => resolveAsset(address, chainId, knownSymbol),
}
const LIVE_FX = liveAddEffects

export function ShapeEditor({ chainId, draft, onChange, disabled = false, overlayZ }: ShapeEditorProps & { overlayZ?: number }) {
  const [view, setView] = useState<'picture' | 'list'>('picture')
  const [dial, setDial] = useState<string | null>(null)
  // live vs glide motion: 'live' only while the slider is actually moving
  // (PortfolioFlow's markDialing idiom) so the settle still glides.
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

  // ── adds: the search modal picks, the pipeline decides ────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [addBusy, setAddBusy] = useState<string | null>(null) // gating only; the orb is the visible state
  const [addError, setAddError] = useState<string | null>(null)
  // The launch system's own resolving ceremony (owner 2026-08-10: the square
  // with the loading circle that pixel-fades out) — the REAL MintOrb, driven
  // exactly as BasketBuilder drives it: forming while findBestPool runs,
  // 'added' flips the centre and the card disintegrates. A refused add drops
  // the orb and the editor's own error line says why.
  const [orb, setOrb] = useState<{ address: string; symbol: string; status: MintStatus } | null>(null)
  // The pipeline is async; the draft may be re-dialed while it runs. The
  // append lands on the CURRENT draft, never the snapshot the pick saw.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const full = draft.legs.length >= MAX_ASSETS

  const pick = async (a: { address: string; symbol: string; chainId: number }) => {
    setSearchOpen(false)
    setAddError(null)
    setAddBusy(a.symbol)
    setOrb({ address: a.address, symbol: a.symbol, status: 'forming' })
    // Validated against THIS basket's chain — a cross-chain hit from the
    // search either resolves here too, or the pipeline states why not.
    const verdict = await validateAddAsset(draftRef.current, a.address, chainId, LIVE_FX, a.symbol)
    if (!alive.current) return
    setAddBusy(null)
    if (verdict.ok) {
      onChange(appendResolvedLeg(draftRef.current, verdict.leg))
      // flips the centre to "Added"; the orb holds a beat, pixel-dissolves,
      // and clears itself through onDone
      setOrb({ address: a.address, symbol: verdict.leg.symbol, status: 'added' })
    } else {
      setOrb(null)
      setAddError(verdict.reason)
    }
  }

  const removeAt = (i: number) => {
    onChange(removeDraftLeg(draft, i))
    setDial(null)
  }

  const dialIndex = dial ? draft.legs.findIndex((l) => l.address.toLowerCase() === dial) : -1
  const dialLeg = dialIndex >= 0 ? draft.legs[dialIndex] : null
  const total = sum(draft.weights)

  const pill = (active: boolean) =>
    `press rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
      active ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
    }`

  return (
    <div className={disabled ? 'pointer-events-none opacity-60' : undefined} aria-disabled={disabled || undefined}>
      {/* station row: the label + the picture/list toggle (picture leads) */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="font-display text-xl font-bold uppercase tracking-tight text-ink sm:text-2xl">
          Shape the mix
        </div>
        <span className="flex items-center gap-2">
          {(
            [
              { id: 'picture' as const, label: 'Picture' },
              { id: 'list' as const, label: 'List' },
            ]
          ).map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)} className={pill(view === v.id)} disabled={disabled}>
              {v.label}
            </button>
          ))}
        </span>
        {draft.legs.length > 1 && (
          <button
            type="button"
            onClick={() => onChange(equalizeDraft(draft))}
            disabled={disabled}
            className="press ml-auto rounded-full border border-white/15 px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-white/35"
          >
            Even it out
          </button>
        )}
      </div>

      {view === 'picture' ? (
        <div className="mt-6">
          {/* THE PICTURE — the draft as the reshape bento, tiles sized by
              weight, tap to dial. Weights re-land on exactly 100 every dial
              (the builder's law), so no total banner here — it would always
              say 100 and therefore nothing. */}
          <div className="h-[340px]">
            <BasketBento
              items={draft.legs.map(
                (l, i): BentoItem => ({
                  id: l.address.toLowerCase(),
                  symbol: l.symbol,
                  address: l.address,
                  chainId,
                  // layout floor keeps a tiny tile visible + tappable; the
                  // label shows the TRUE weight (the label never lies)
                  weightPct: Math.max(draft.weights[i] ?? 0, 1.6),
                  labelPct: draft.weights[i] ?? 0,
                }),
              )}
              fill
              animateLayout
              layoutMotion={dialing ? 'live' : 'glide'}
              selectedId={dial}
              onSelect={disabled ? undefined : (id) => setDial((k) => (k === id ? null : id))}
            />
          </div>

          {/* the dial slot — FIXED height, always present: the grid below
              never reflows on tap (the reshape law) */}
          <div
            role={dialLeg ? 'group' : undefined}
            aria-label={dialLeg ? `Reweight ${showSymbol(dialLeg.symbol)}` : undefined}
            className="relative mt-3 flex min-h-[64px] items-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-2 sm:h-[64px]"
          >
            {!dialLeg ? (
              <p className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-cyan" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <g>
                    <animateTransform attributeName="transform" type="translate" values="0 0; 1.6 1.6; 0 0" keyTimes="0; 0.35; 1" dur="2.2s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
                    <path d="M5 3l14 7-6.5 1.5L9 18z" fill="currentColor" fillOpacity="0.18" />
                  </g>
                </svg>
                Tap a tile to set its share
              </p>
            ) : (
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex min-w-0 items-center gap-2">
                  <AssetLogo address={dialLeg.address} symbol={dialLeg.symbol} chainId={chainId} size={24} />
                  <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(dialLeg.symbol)}</span>
                  <span className="font-num text-sm font-semibold tabular-nums text-ink-dim">
                    {draft.weights[dialIndex] ?? 0}%
                  </span>
                </span>
                <div className="min-w-[160px] flex-1">
                  <TrimBar
                    symbol={dialLeg.symbol}
                    cur={0}
                    target={draft.weights[dialIndex] ?? 0}
                    scaleUsd={CAP}
                    isNew
                    onTarget={(pct) => {
                      markDialing()
                      onChange(setDraftWeightPct(draft, dialIndex, pct))
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeAt(dialIndex)}
                  disabled={disabled}
                  aria-label={`Remove ${showSymbol(dialLeg.symbol)}`}
                  className="press grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-magenta/60 hover:text-magenta"
                >
                  ✕
                </button>
                <button
                  type="button"
                  onClick={() => setDial(null)}
                  disabled={disabled}
                  aria-label={`Done reweighting ${showSymbol(dialLeg.symbol)}`}
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
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {draft.legs.map((l, i) => {
            const w = draft.weights[i] ?? 0
            return (
              <div
                key={l.address.toLowerCase()}
                className="group flex h-14 items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 transition-colors duration-500 hover:border-white/20 hover:bg-white/[0.04]"
              >
                <span className="flex w-32 items-center gap-3">
                  <AssetLogo address={l.address} symbol={l.symbol} chainId={chainId} size={28} />
                  <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(l.symbol)}</span>
                </span>
                <span className="relative hidden h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06] sm:block">
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                    style={{
                      width: `${Math.min(100, w)}%`,
                      // the asset's OWN identity color — the same one its
                      // bento tile wears (one color story, both views)
                      background: tokenVisual(l.symbol, l.address).color,
                      transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
                    }}
                  />
                </span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onChange(adjustDraftWeight(draft, i, -STEP))}
                    disabled={disabled}
                    aria-label={`Decrease ${showSymbol(l.symbol)} weight`}
                    className="press grid h-8 w-8 place-items-center rounded-lg border border-white/15 font-mono text-[13px] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                  >
                    −
                  </button>
                  <span className="w-12 text-center font-num text-sm font-semibold tabular-nums text-ink">{w}%</span>
                  <button
                    type="button"
                    onClick={() => onChange(adjustDraftWeight(draft, i, +STEP))}
                    disabled={disabled}
                    aria-label={`Increase ${showSymbol(l.symbol)} weight`}
                    className="press grid h-8 w-8 place-items-center rounded-lg border border-white/15 font-mono text-[13px] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                  >
                    +
                  </button>
                </span>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  disabled={disabled}
                  aria-label={`Remove ${showSymbol(l.symbol)}`}
                  className="press grid h-9 w-9 place-items-center rounded-full text-ink-faint transition-opacity hover:text-magenta focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            )
          })}

          {/* the running total — teal when the law holds. Under weights.ts it
              always does; amber/magenta here is a tripwire, not a state the
              controls can reach. */}
          <div
            className={`flex h-12 items-center justify-between rounded-2xl border px-4 transition-all duration-500 ${
              total === CAP ? 'border-teal/40 bg-teal/[0.04] shadow-[0_0_20px_rgba(52,214,196,0.15)]' : 'border-white/10 bg-white/[0.02]'
            }`}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Total</span>
            <span
              className={`font-num text-base font-semibold tabular-nums ${
                total === CAP ? 'text-teal' : total < CAP ? 'text-amber-300/90' : 'text-magenta'
              }`}
            >
              {total}%
              {total !== CAP && (
                <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em]">
                  {total < CAP ? `add ${CAP - total}%` : `remove ${total - CAP}%`}
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* the add bar — the real AssetSearchModal, every pick validated the
          builder's way before it can land */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            disabled={disabled || full || addBusy != null}
            className="press inline-flex h-12 items-center gap-2 rounded-xl border border-dashed border-white/20 px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan disabled:opacity-45"
          >
            ＋ Add an asset
          </button>
          {full && (
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              basket is full · {MAX_ASSETS} assets
            </span>
          )}

        </div>
        {addError && (
          <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
            {addError}
          </p>
        )}
      </div>

      {searchOpen && (
        <AssetSearchModal
          onPick={(a) => void pick(a)}
          onClose={() => setSearchOpen(false)}
          takenKeys={new Set(draft.legs.map((l) => `${chainId}:${l.address.toLowerCase()}`))}
          full={full}
          zIndex={overlayZ}
        />
      )}

      {orb && (
        <MintOrb
          key={orb.address}
          address={orb.address}
          symbol={orb.symbol}
          chainId={chainId}
          status={orb.status}
          onDone={() => setOrb(null)}
          zIndex={overlayZ}
        />
      )}
    </div>
  )
}
