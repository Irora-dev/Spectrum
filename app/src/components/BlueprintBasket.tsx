import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link } from 'react-router'

// ─────────────────────────────────────────────────────────────────────────────
// The BLUEPRINT basket — the ghost that holds the spotlight when no live basket
// clears the listing criteria (owner 2026-07-07 14:1x; tightened to his 14:31
// notes: compact height, words LEFT / schematic RIGHT, one-line description,
// four tiles, no title block, no spec caption). One component serves Home and
// Explore.
//
// Honesty by construction (§9): it is unmistakably a DRAWING — no NAV, no
// performance, no holders. The weights are spec annotations on a blueprint.
// ─────────────────────────────────────────────────────────────────────────────

const BLUE_INK = 'rgba(140,225,255,0.85)' // blueprint line ink (the navy sheet)
const BLUE_FAINT = 'rgba(140,225,255,0.35)'
// bare mode draws on the CHAT STAGE's own plate, so its ink rides the theme
// token: light strokes on void, dark strokes on paper (owner 2026-08-19:
// "needs to be a darker colour on light mode")
const TOKEN_INK = 'color-mix(in srgb, var(--color-ink) 90%, transparent)'
const TOKEN_FAINT = 'color-mix(in srgb, var(--color-ink) 40%, transparent)'

// Four schematic tiles on a 4×2 sheet — spec weights sum to 100. The weights
// SLOWLY CYCLE through example allocations (owner 2026-07-29: the invitation
// demonstrates itself) — a calm 6s cadence, paused for reduced-motion.
const WEIGHT_SETS: [string, string, string, string][] = [
  ['40%', '30%', '18%', '12%'],
  ['55%', '20%', '15%', '10%'],
  ['25%', '25%', '25%', '25%'],
  ['34%', '33%', '22%', '11%'],
]
const TILES: { label: string; cls: string }[] = [
  { label: 'ASSET 01', cls: 'col-span-2 row-span-2' },
  { label: 'ASSET 02', cls: 'col-span-2 row-span-1' },
  { label: 'ASSET 03', cls: 'col-span-1 row-span-1' },
  { label: 'ASSET 04', cls: 'col-span-1 row-span-1' },
]

const hatch: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, transparent, transparent 7px, rgba(140,225,255,0.06) 7px, rgba(140,225,255,0.06) 8px)',
}
const hatchToken: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, transparent, transparent 7px, color-mix(in srgb, var(--color-ink) 7%, transparent) 7px, color-mix(in srgb, var(--color-ink) 7%, transparent) 8px)',
}

export function BlueprintBasket({ compact = false, bare = false }: { compact?: boolean; bare?: boolean }) {
  // the living spec: cycle allocations on a calm cadence; static under
  // prefers-reduced-motion (the first set is a fine drawing on its own)
  const [wi, setWi] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = window.setInterval(() => setWi((i) => (i + 1) % WEIGHT_SETS.length), 6000)
    return () => window.clearInterval(t)
  }, [])
  const weights = WEIGHT_SETS[wi]
  const INK = bare ? TOKEN_INK : BLUE_INK
  const INK_FAINT = bare ? TOKEN_FAINT : BLUE_FAINT
  return (
    <section
      aria-label="Basket blueprint — no live basket holds the spotlight yet"
      className={`relative overflow-hidden rounded-3xl ${compact ? '' : 'border border-white/12'} ${bare ? 'flex h-full flex-col' : ''}`}
      /* blueprint paper derives from the plane's own tokens — night-sky on the
         dark styles, pale drafting-paper on the light one (the 2026-08-17
         dark-gradient sweep; the old #0a1826 bake ignored every style) */
      style={bare ? undefined : { background: 'linear-gradient(160deg, color-mix(in srgb, var(--color-panel-2) 86%, var(--color-cyan) 14%) 0%, var(--color-panel-2) 55%, var(--color-panel) 100%)' }}
    >
      {/* blueprint paper: fine grid + major grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(rgba(140,225,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(140,225,255,0.05) 1px, transparent 1px), linear-gradient(rgba(140,225,255,0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(140,225,255,0.09) 1px, transparent 1px)',
          backgroundSize: '16px 16px, 16px 16px, 80px 80px, 80px 80px',
        }}
      />
      {/* marching-ants frame (geometry via CSS — attribute calc() is flaky in SVG) */}
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full">
        <rect
          fill="none"
          stroke={INK_FAINT}
          strokeWidth="1.5"
          strokeDasharray="10 7"
          className="blueprint-dash"
          style={{ x: 8, y: 8, width: 'calc(100% - 16px)', height: 'calc(100% - 16px)', rx: 18 } as CSSProperties}
        />
      </svg>

      {/* words LEFT · schematic RIGHT (owner 14:31) — `bare` drops the pitch
          copy entirely (owner 2026-08-19: the chat stage wants the DRAWING,
          not a launch ad) */}
      <div
        className={
          bare
            ? 'relative flex min-h-0 flex-1 flex-col p-4 sm:p-5'
            : 'relative grid items-center gap-7 p-7 sm:p-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-12 lg:p-12'
        }
      >
        <div className={bare ? 'hidden' : undefined}>
          <div className="inline-flex items-center gap-2 rounded-full border border-dashed px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em]" style={{ borderColor: INK_FAINT, color: INK }}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: INK }} />
            Basket blueprint
          </div>
          <h2 className="mt-4 font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">
            Yours could
            <br />
            be first.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-dim">Be the first to launch a basket token.</p>
          <Link
            to="/create"
            className="press mt-6 inline-block rounded-xl px-8 py-3.5 font-display text-sm font-bold uppercase tracking-[0.16em] text-black transition-transform hover:scale-[1.02]"
            style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
          >
            Launch a basket
          </Link>
        </div>

        <div className={bare ? 'flex min-h-0 flex-1 flex-col' : undefined}>
          {/* dimension line along the top */}
          <div aria-hidden className="mb-2 flex shrink-0 items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em]" style={{ color: INK_FAINT }}>
            <span className="h-px flex-1" style={{ background: INK_FAINT }} />
            <span>one token · whole basket</span>
            <span className="h-px flex-1" style={{ background: INK_FAINT }} />
          </div>

          {/* bare fills whatever box the stage gives it — the fixed drawing
              aspect clipped on short cards (owner 2026-08-19) */}
          <div className={`grid grid-cols-4 grid-rows-2 gap-2.5 ${bare ? 'min-h-0 flex-1' : 'aspect-[1.9/1]'}`}>
            {TILES.map((t, i) => (
              <div
                key={t.label}
                className={`relative flex flex-col justify-between rounded-xl border border-dashed p-3 ${t.cls}`}
                style={{ borderColor: i === 0 ? INK : INK_FAINT, ...(bare ? hatchToken : hatch) }}
              >
                <div className="flex items-center gap-1.5">
                  {/* dashed avatar placeholder */}
                  <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-dashed" style={{ borderColor: INK_FAINT }}>
                    <span className="h-1 w-1 rounded-full" style={{ background: INK_FAINT }} />
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em]" style={{ color: INK }}>
                    {t.label}
                  </span>
                </div>
                <div className="flex items-end justify-between">
                  <span className="font-mono text-[9px]" style={{ color: INK_FAINT }}>
                    wt.
                  </span>
                  <span className="bp-weight-in font-num text-lg font-light tabular-nums" style={{ color: INK }} key={weights[i]}>
                    {weights[i]}
                  </span>
                </div>
                {/* corner tick, drawing-style */}
                <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 border-r border-t" style={{ borderColor: INK_FAINT }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
