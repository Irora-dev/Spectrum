import { showSymbol } from '../../lib/spectrum/safe-copy'
import {
  PRESET_LABEL,
  PRESET_WHY,
  presetWeights,
  type PresetAsset,
  type PresetKind,
} from '../../lib/spectrum/weight-presets'

// ─────────────────────────────────────────────────────────────────────────────
// THE WEIGHT PRESETS (the owner 2026-08-13, greenlit) — "Even it out" plus two
// more, both one click: by market cap, and by liquidity.
//
// The numbers were already on the picks: TokenHit carries marketCapUsd and
// liquidityUsd for everything the picker offers. All that was missing was the
// one click that turns them into weights.
//
// A PRESET THAT CANNOT RUN IS NOT SHOWN AS A DEAD BUTTON, and — more
// importantly — it never quietly falls back to an even split. An even split
// wearing the label "by market cap" is a lie about how the basket was built, so
// weight-presets.ts returns null instead and the button simply is not there.
//
// A PARTIAL answer is named rather than hidden: assets whose metric nobody
// could read land at the 1% floor because nothing was KNOWN about them, not
// because they were judged small, and the line underneath says which ones.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS: PresetKind[] = ['even', 'market-cap', 'liquidity']

export function WeightPresets({
  assets,
  /** The picked tickers, index-aligned with `assets` — used only to name the
   *  ones a preset had no number for. */
  symbols,
  onApply,
  className = '',
}: {
  assets: readonly PresetAsset[]
  symbols?: readonly string[]
  onApply: (weights: number[]) => void
  className?: string
}) {
  const runnable = KINDS.map((kind) => ({ kind, result: presetWeights(kind, assets) })).filter(
    (r) => r.result != null,
  )
  // One preset means only "even", which the flow already has its own control
  // for — a row of one button is noise.
  if (runnable.length < 2) return null

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {runnable.map(({ kind, result }) => (
          <button
            key={kind}
            type="button"
            onClick={() => onApply(result!.weights)}
            title={PRESET_WHY[kind]}
            className="press inline-flex min-h-[36px] items-center rounded-lg border border-white/12 px-3.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
          >
            {PRESET_LABEL[kind]}
          </button>
        ))}
      </div>
      {runnable.map(({ kind, result }) =>
        result!.unknown.length > 0 ? (
          <p key={kind} className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
            {PRESET_LABEL[kind].toLowerCase()}: no figure for{' '}
            {result!.unknown
              .map((i) => `$${showSymbol(symbols?.[i] ?? '')}`)
              .slice(0, 4)
              .join(' · ')}
            {result!.unknown.length > 4 ? ` +${result!.unknown.length - 4}` : ''} — they sit at the floor
          </p>
        ) : null,
      )}
    </div>
  )
}
