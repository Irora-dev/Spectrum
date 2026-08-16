import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import type { Thesis } from '../../lib/spectrum/thesis'
import { ChainBadge } from '../ChainBadge'
import { BUNDLE_NAME_LAW, bundleNameOk } from './publish-bundle-model'
import { ReshapeBasketModal } from './ReshapeBasketModal'

// ─────────────────────────────────────────────────────────────────────────────
// THE JOIN DOORS, AS ONE COMPONENT (extracted from pages/Token.tsx,
// 2026-08-10) — which bundle this basket ships into, then the reshape popup
// in join mode. Two steps, one mount: the picker chooses WHICH bundle, and
// the picked name opens the single-basket reshape popup carrying it — the
// rename is the entire join (reshape-types.ts: names are immutable on-chain
// and the grouper keys on (deployer, name), so shipping a renamed version IS
// joining). The Token page's "Add to a bundle" pill and the creator page's
// per-basket doors mount this same component, so the flow cannot drift.
//
// The picker is LOCAL minimal rows (name + chain marks), deliberately not a
// bundle-card lookalike: this is a chooser, and the card components belong to
// the browse surfaces' lane.
//
// Owner 2026-08-12 ("needs less text and also a button on here to create a
// new bundle"): the explainer is one quiet footnote line, the richer-leg
// caveat is chip-length (the full sentence survives as the row's tooltip),
// and the list ends in a new-bundle door — a typed name resolving through the
// SAME onPick as an existing row, because to the grouper a fresh name's first
// version IS a new bundle's first leg; it materializes as a bundle when a
// second network joins the name. The name law is publish-bundle-model's
// bundleNameOk, never restated.
// ─────────────────────────────────────────────────────────────────────────────

/** The choosing step — the extracted picker panel: scroll-locked portal,
 *  Escape closes, first row takes focus. Ends in the new-bundle door (a name
 *  field resolving through the same onPick). Unmounts the moment a bundle is
 *  picked — existing or typed — so its cleanup hands the page back before the
 *  reshape popup takes over. */
function PickBundlePanel({
  bundles,
  symbol,
  currentChainId,
  onPick,
  onClose,
}: {
  bundles: Thesis[]
  symbol: string
  /** The subject basket's own chain — rows covering it carry the richer-leg
   *  caveat, because a fresh version starts poor and the grouper keeps one
   *  leg per chain. */
  currentChainId: number
  onPick: (name: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  // The new-bundle door's one piece of state: null = door closed, a string =
  // the name field revealed with its value (mirrors the parent's name-IS-the-
  // state idiom).
  const [newName, setNewName] = useState<string | null>(null)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-void/60 backdrop-blur-[6px]"
      role="dialog"
      aria-modal="true"
      aria-label={`Add $${showSymbol(symbol)} to a bundle`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="mx-auto my-16 w-[min(480px,calc(100vw_-_2rem))]">
        <div
          ref={panelRef}
          className="panel-in rounded-2xl border border-white/12 bg-panel/95 p-6 shadow-[0_48px_128px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">add to a bundle</p>
              <h2 className="mt-2 font-display text-xl font-bold uppercase leading-tight tracking-tight text-ink">
                Which idea does ${showSymbol(symbol)} join?
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
            >
              ✕
            </button>
          </div>
          <div className="mt-6 space-y-2">
            {bundles.map((t) => {
              const sameChain = t.chainIds.includes(currentChainId)
              return (
                <button
                  key={`${t.deployer}:${t.name}`}
                  type="button"
                  onClick={() => onPick(t.name)}
                  // chip-length caveat below; the full sentence survives on hover
                  title={sameChain ? 'already has a leg on this chain — a bundle shows one leg per chain, the richer one' : undefined}
                  className="press w-full rounded-xl border border-white/10 px-4 py-3 text-left transition-colors hover:border-violet/60"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-display text-sm font-bold text-ink">{showName(t.name)}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {t.chainIds.map((id) => (
                        <ChainBadge key={id} chainId={id} />
                      ))}
                    </span>
                  </span>
                  {sameChain && (
                    <span className="mt-2 block font-mono text-[10px] leading-relaxed text-amber-200/90">
                      already on this network
                    </span>
                  )}
                </button>
              )
            })}
            {/* THE NEW-BUNDLE DOOR (owner 2026-08-12) — the final row: a typed
                name resolves through the SAME onPick as picking a row. Shipping
                this basket's new version under the typed name IS the new
                bundle's first leg. */}
            {newName == null ? (
              <button
                type="button"
                onClick={() => setNewName('')}
                className="press w-full rounded-xl border border-dashed border-violet/40 px-4 py-3 text-left font-display text-sm font-bold text-violet transition-colors hover:border-violet/70 hover:text-violet-bright"
              >
                + Start a new bundle
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (bundleNameOk(newName)) onPick(newName.trim())
                }}
                className="rounded-xl border border-violet/40 px-4 py-3"
              >
                <label className="block">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                    new bundle — {BUNDLE_NAME_LAW}
                  </span>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value.slice(0, 42))}
                    placeholder="Bundle name"
                    autoFocus
                    className="mt-2 w-full rounded-xl border border-white/12 bg-black/30 px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-violet/50"
                  />
                </label>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-dim">
                  this version is its first leg — the bundle appears when a second network joins the name
                </p>
                <button
                  type="submit"
                  disabled={!bundleNameOk(newName)}
                  className="press mt-3 w-full rounded-xl border border-violet/50 bg-violet/10 px-4 py-2.5 font-display text-sm font-bold text-violet transition-colors hover:border-violet/80 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Start the bundle
                </button>
              </form>
            )}
          </div>
          {/* THE HONESTY LINE, quiet-footnote length (owner 2026-08-12: less
              text) — mechanism kept: a new version, under the name, old one
              untouched. */}
          <p className="mt-4 font-mono text-[10px] leading-relaxed text-ink-dim">
            ships a <span className="text-ink">new version</span> under the bundle&rsquo;s name — the current one
            stays live
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function JoinBundlePicker({
  bundles,
  subject,
  demo = false,
  onClose,
}: {
  /** The creator's multi-chain bundles this basket could join. Callers exclude
   *  the subject's own name with the grouper's fold — to the grouper, sharing
   *  the name IS membership (or its same-chain shadow), so that row would sell
   *  a join to nowhere. */
  bundles: Thesis[]
  /** The basket doing the joining — handed whole to the reshape popup once a
   *  bundle is picked; its chain keys the picker's richer-leg caveat. */
  subject: { address: `0x${string}`; chainId: number; symbol: string }
  /** The subject is a demo basket: the reshape ceremony runs as the scripted
   *  walkthrough and arms nothing (the popup's own demo rules). */
  demo?: boolean
  /** The whole flow closed — either step, one exit. */
  onClose: () => void
}) {
  // Two steps, one piece of state: null = choosing, a name = the reshape popup
  // in join mode. The rename is the whole mechanism, so the name IS the state.
  const [joinName, setJoinName] = useState<string | null>(null)

  if (joinName != null) {
    return (
      <ReshapeBasketModal
        address={subject.address}
        chainId={subject.chainId}
        demo={demo}
        joinThesis={{ name: joinName }}
        onClose={onClose}
      />
    )
  }
  return (
    <PickBundlePanel
      bundles={bundles}
      symbol={subject.symbol}
      currentChainId={subject.chainId}
      onPick={setJoinName}
      onClose={onClose}
    />
  )
}
