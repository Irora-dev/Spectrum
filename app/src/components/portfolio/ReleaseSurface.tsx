import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import {
  discardQuarantine,
  readReleaseSurface,
  releaseStuckRecord,
  releaseSurfaceHasWork,
  sweepUnknownRows,
  type StuckRecord,
} from '../../lib/spectrum/release-surface'
import { ChainBadge } from '../ChainBadge'

// THE HUMAN RELEASE SURFACE (the go-live interlock's precondition, built
// 2026-08-13 on the owner's runway order). Renders the MODEL's own words verbatim
// — release-surface.ts owns every sentence, so what the tests pin is what a
// person reads. Laws worn here:
//  · SELF-HIDING: no stuck records, no quarantine → this renders NOTHING.
//  · TWO-STEP RELEASE: the destructive act sits behind a confirm that repeats
//    the record's own releaseWarning — never a bare button.
//  · THE EVIDENCE SHOWS BEFORE THE DISCARD: quarantine bytes render (bounded)
//    with a copy path before any discard button exists.
export function ReleaseSurface({ connected }: { connected?: Address }) {
  const [tick, setTick] = useState(0)
  const nowMs = Date.now()
  // storage passed as null-safe default inside the lib; re-read per tick
  const state = useMemo(() => {
    void tick
    return readReleaseSurface(nowMs, safeStore())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [quarantineOpen, setQuarantineOpen] = useState(false)

  if (!releaseSurfaceHasWork(nowMs, safeStore())) return null

  const keyOf = (r: StuckRecord) => `${r.chainId}:${r.stepKey}`
  const release = (r: StuckRecord) => {
    const out = releaseStuckRecord(r, connected, safeStore())
    setVerdict(out.words)
    setConfirming(null)
    setTick((t) => t + 1)
  }

  return (
    <section className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.04] p-4 sm:p-5">
      <h3 className="font-display text-sm font-bold uppercase tracking-wide text-amber-200/90">
        Records waiting on you
      </h3>
      <p className="mt-1 max-w-[62ch] font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-ink-faint">
        Each of these protects money that may already have moved. Nothing here expires on its own —
        resolving them is yours, never automatic.
      </p>

      {state.records.map((r) => (
        <div key={keyOf(r)} className="mt-3 rounded-xl border border-white/10 bg-void/40 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <ChainBadge chainId={r.chainId} />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim">
              {r.kind === 'ambiguous' ? 'wallet never answered' : 'submitted · unresolved'}
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">{r.words}</p>
          {confirming === keyOf(r) ? (
            <div className="mt-3 rounded-lg border border-alert/40 bg-alert/[0.06] p-3">
              <p className="text-[12px] leading-relaxed text-alert">{r.releaseWarning}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => release(r)}
                  className="press rounded-lg border border-alert/50 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-alert hover:bg-alert/10"
                >
                  I checked — release it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="press rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:text-ink"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setVerdict(null)
                setConfirming(keyOf(r))
              }}
              className="press mt-2.5 rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-amber-300/50 hover:text-amber-200"
            >
              Release…
            </button>
          )}
        </div>
      ))}

      {(state.unknownRows > 0 || state.corrupt) && (
        <div className="mt-3 rounded-xl border border-white/10 bg-void/40 p-3.5">
          <p className="text-[13px] leading-relaxed text-ink-dim">
            {state.corrupt
              ? 'The saved records here are unreadable as a whole — every run refuses until this is resolved.'
              : `${state.unknownRows} saved record${state.unknownRows === 1 ? ' is' : 's are'} unreadable — every run refuses while ${state.unknownRows === 1 ? 'it sits' : 'they sit'} in the book.`}{' '}
            Sweeping moves the unreadable bytes to a quarantine you can inspect below; nothing is destroyed.
          </p>
          <button
            type="button"
            onClick={() => {
              sweepUnknownRows(safeStore())
              setTick((t) => t + 1)
            }}
            className="press mt-2.5 rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-amber-300/50 hover:text-amber-200"
          >
            Sweep unreadable records to quarantine
          </button>
        </div>
      )}

      {state.quarantineRaw != null && (
        <div className="mt-3 rounded-xl border border-white/10 bg-void/40 p-3.5">
          <p className="text-[13px] leading-relaxed text-ink-dim">
            Quarantined evidence from earlier sweeps ({state.quarantineRaw.length.toLocaleString('en-US')}{' '}
            bytes). Copy it somewhere safe if you might ever need it — discarding is final.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setQuarantineOpen((v) => !v)}
              aria-expanded={quarantineOpen}
              className="press rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:text-ink"
            >
              {quarantineOpen ? 'Hide the bytes' : 'Show the bytes'}
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(state.quarantineRaw ?? '').catch(() => {})
              }}
              className="press rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:text-ink"
            >
              Copy
            </button>
            {quarantineOpen && (
              <button
                type="button"
                onClick={() => {
                  discardQuarantine(safeStore())
                  setQuarantineOpen(false)
                  setTick((t) => t + 1)
                }}
                className="press rounded-lg border border-alert/50 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-alert hover:bg-alert/10"
              >
                Discard the quarantine
              </button>
            )}
          </div>
          {quarantineOpen && (
            <pre className="mt-2.5 max-h-40 overflow-auto rounded-lg bg-black/40 p-2.5 font-mono text-[10px] leading-relaxed text-ink-faint">
              {state.quarantineRaw}
            </pre>
          )}
        </div>
      )}

      {verdict && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim" role="status">
          {verdict}
        </p>
      )}
    </section>
  )
}

function safeStore(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
