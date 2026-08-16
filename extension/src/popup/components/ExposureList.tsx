// The exposure lens — the reason this surface exists. Not a token list
// (wallets already do token lists): net per-asset exposure across every held
// basket, each row in the asset's own deterministic color. Where a target is
// set, the row's bar carries a tick at the target weight — the drift is
// visible as the gap between fill and tick before it's read as a number.
// Each row opens into the drill the site's exposure cards offer: WHICH held
// baskets drive the line.

import { useMemo, useState } from 'react'
import { formatUsdCompact } from '@app/lib/spectrum/format'
import { tokenVisual } from '@app/lib/spectrum/token-meta'
import type { DriftReport, SnapshotAsset } from '../../shared/portfolio'
import { tokenUrl } from '../../shared/deeplink'
import { AssetMark, chainLabel, SectionRule, SignedFigure } from './bits'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={`h-2.5 w-2.5 shrink-0 text-ink-faint transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ExposureList({
  assets,
  drift,
  degraded,
  targets,
  base,
  onSaveTargets,
}: {
  assets: SnapshotAsset[]
  drift: DriftReport
  /** A chain read failed — drift is paused (weights are shares of a partial
   *  total), so the set-targets hint must not beckon. */
  degraded: boolean
  targets: Record<string, number>
  /** Deep-link base for the drill's basket click-throughs, when configured. */
  base: string | null
  onSaveTargets: (next: Record<string, number>) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const multiChain = new Set(assets.map((a) => a.chainId)).size > 1
  const deltaByKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of drift.perAsset) m.set(d.key, d.deltaPts)
    return m
  }, [drift])

  const startEditing = () => {
    const d: Record<string, string> = {}
    for (const a of assets) {
      const t = targets[a.key]
      if (Number.isFinite(t)) d[a.key] = String(t)
    }
    setDraft(d)
    setOpenKey(null)
    setEditing(true)
  }

  const finishEditing = () => {
    const next: Record<string, number> = {}
    for (const [key, raw] of Object.entries(draft)) {
      const n = Number(raw)
      if (raw.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100) next[key] = n
    }
    // Awaited on purpose: storage.sync caps one item at ~8 KB, so a very
    // diversified target map CAN be refused — swallowing that rejection would
    // silently discard the user's targets. Failure keeps the editor open.
    onSaveTargets(next).then(
      () => {
        setSaveError(null)
        setEditing(false)
      },
      () => {
        setSaveError(
          'Browser sync refused this. It caps targets at roughly 150 assets. Nothing was saved; trim a few and try again.',
        )
      },
    )
  }

  const draftSum = Object.values(draft).reduce((s, v) => s + (Number(v) || 0), 0)

  if (assets.length === 0) return null

  return (
    <section className="px-4 pt-6">
      <div className="mb-2">
        <SectionRule
          right={
            <div className="flex items-center gap-3">
              {editing && (
                <span
                  className={`font-mono text-[10px] tnum ${Math.abs(draftSum - 100) <= 0.01 || draftSum === 0 ? 'text-ink-faint' : 'text-amber'}`}
                  title="Targets don't have to sum to 100, this is just the running total."
                >
                  Σ {draftSum.toFixed(0)}%
                </span>
              )}
              <button
                type="button"
                onClick={editing ? finishEditing : startEditing}
                className="press rounded-full border border-line bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-line-bright hover:text-ink"
              >
                {editing ? 'save targets' : 'targets'}
              </button>
            </div>
          }
        >
          exposure
        </SectionRule>
      </div>

      {saveError && (
        <p className="mb-2 flex items-start gap-2 font-mono text-[10px] leading-relaxed text-ink-dim">
          <span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-alert" />
          {saveError}
        </p>
      )}

      <ul className="divide-y divide-white/5">
        {assets.map((a) => {
          const vis = tokenVisual(a.symbol, a.address)
          const delta = deltaByKey.get(a.key)
          const target = targets[a.key]
          const open = openKey === a.key
          const contributions = a.contributions ?? []
          const canDrill = !editing && contributions.length > 0

          const mainRow = (
            <>
              <AssetMark address={a.address} symbol={a.symbol} chainId={a.chainId} size={20} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12px] font-medium text-ink">{a.symbol}</span>
                  {multiChain && (
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                      {chainLabel(a.chainId)}
                    </span>
                  )}
                  {canDrill && <Chevron open={open} />}
                </div>
                {/* Fill = current weight; the tick = target weight. Drift is
                    the visible gap between them. */}
                <div className="relative mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.min(100, a.pct)}%`, background: vis.color }}
                  />
                  {!degraded && Number.isFinite(target) && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 w-px bg-white/50"
                      style={{ left: `${Math.min(100, target as number)}%` }}
                    />
                  )}
                </div>
              </div>

              {editing ? (
                <label className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-ink-dim">
                  <input
                    inputMode="decimal"
                    aria-label={`Target weight for ${a.symbol}, percent`}
                    value={draft[a.key] ?? ''}
                    placeholder="—"
                    onChange={(e) => setDraft((d) => ({ ...d, [a.key]: e.target.value }))}
                    className="w-12 rounded-md border border-line bg-white/[0.04] px-2 py-1 text-right text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-bright"
                  />
                  %
                </label>
              ) : (
                <div className="shrink-0 text-right">
                  <div className="flex items-baseline justify-end gap-2">
                    {delta != null && (
                      <span className="font-mono text-[10px]">
                        <SignedFigure value={delta} suffix="pts" />
                      </span>
                    )}
                    <span className="font-display text-[13px] font-semibold text-ink tnum">{a.pct.toFixed(1)}%</span>
                  </div>
                  <div className="font-mono text-[10px] text-ink-dim tnum">{formatUsdCompact(a.valueUsd)}</div>
                </div>
              )}
            </>
          )

          return (
            <li key={a.key}>
              {canDrill ? (
                <button
                  type="button"
                  onClick={() => setOpenKey(open ? null : a.key)}
                  aria-expanded={open}
                  className="flex h-12 w-full items-center gap-3 text-left"
                  title={`${a.symbol} · in ${a.basketCount} basket${a.basketCount === 1 ? '' : 's'}`}
                >
                  {mainRow}
                </button>
              ) : (
                <div className="flex h-12 items-center gap-3">{mainRow}</div>
              )}

              {open && !editing && (
                <div className="space-y-1.5 pb-3 pl-8">
                  {contributions.map((c) => {
                    const share = a.valueUsd > 0 ? (c.valueUsd / a.valueUsd) * 100 : 0
                    const inner = (
                      <>
                        <span className="w-16 shrink-0 truncate font-mono text-[10px] text-ink-dim">{c.basketSymbol}</span>
                        <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                          <span
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${share}%`, background: vis.color }}
                          />
                        </span>
                        <span className="w-12 shrink-0 text-right font-mono text-[10px] text-ink-dim tnum">
                          {formatUsdCompact(c.valueUsd)}
                        </span>
                        <span className="w-8 shrink-0 text-right font-mono text-[9px] text-ink-faint tnum">
                          {share.toFixed(0)}%
                        </span>
                      </>
                    )
                    const key = `${c.chainId}:${c.basketAddress}`
                    return base ? (
                      <a
                        key={key}
                        href={tokenUrl(base, c.basketAddress, c.chainId)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 rounded-md px-1 -mx-1 transition-colors hover:bg-white/5"
                      >
                        {inner}
                      </a>
                    ) : (
                      <div key={key} className="flex items-center gap-2 px-1 -mx-1">
                        {inner}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {!editing && drift.aggregatePts == null && !degraded && (
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-faint">
          Set targets to see drift: how far what you hold sits from what you chose.
        </p>
      )}
    </section>
  )
}
