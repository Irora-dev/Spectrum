import { useEffect, useMemo, useRef, useState } from 'react'
import { HOOK_FLAG_BITS, MINE_EXPECTED_TRIES, type MineProgress } from '../../lib/spectrum/create2-mine'

// ─────────────────────────────────────────────────────────────────────────────
// WATCHING THE SALT SEARCH
//
// Owner, 2026-08-13, watching "mining the new address… (3,421 tries)": "needs to
// be a more visual and fun way to help people understand the waiting time."
//
// ⛔ WHY THERE IS NO PROGRESS BAR IN THE ORDINARY SENSE. This is a memoryless
// geometric search: every address is an independent 1-in-16,384 draw, so the
// 3,421st try is no "closer" than the first. A bar that filled toward a finish
// line would be a lie — it would promise a deadline the mathematics does not
// have. What CAN be said honestly is: how many have been tried, how fast, what
// a typical run costs, and what share of runs would have landed by now. All four
// are measured, none are modelled, and the last one is worded as the odds it is
// rather than as an ETA.
//
// The flickering addresses are the other half of the honesty: they are REAL
// candidates from the real search, and the highlighted tail is the actual thing
// being looked for — an address whose low 14 bits are 0x88, i.e. one ending in
// [0,4,8,c] then 0-8-8. Near-misses are worth watching precisely because they
// are real: "13 of 14 bits" means the search genuinely came within one bit.
// ─────────────────────────────────────────────────────────────────────────────

/** The mark the address must end on: the low 14 bits = 0x88. The fourth-from-last
 *  character keeps its top two bits free, so four values can stand there — which
 *  is why the requirement reads "088, after a 0, 4, 8 or c". */
const TAIL: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['0', '4', '8', 'c']),
  new Set(['0']),
  new Set(['8']),
  new Set(['8']),
]

const ROWS = 6
const REVEAL_MS = 45

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** How many of the four mark characters this candidate already carries. */
function tailMatches(addr: string): boolean[] {
  const tail = addr.slice(-4).toLowerCase()
  return TAIL.map((accepts, i) => accepts.has(tail[i]))
}

/** One candidate: the address, dimmed, with its mark spelled out character by
 *  character so a near-miss is visible rather than merely counted. */
function Candidate({ addr, fade, hit }: { addr: string; fade: number; hit?: boolean }) {
  const matches = tailMatches(addr)
  return (
    <span
      className="flex items-center gap-1 font-mono text-[11px] leading-none tabular-nums"
      style={{ opacity: fade }}
    >
      <span className={hit ? 'text-ink' : 'text-ink-faint'}>
        {addr.slice(0, 6)}…{addr.slice(-8, -4)}
      </span>
      <span className="flex gap-[2px]">
        {addr
          .slice(-4)
          .split('')
          .map((ch, i) => (
            <span
              key={i}
              className="grid h-4 w-[13px] place-items-center rounded-[3px]"
              style={{
                background: matches[i]
                  ? hit
                    ? 'color-mix(in srgb, var(--color-teal) 34%, transparent)'
                    : 'color-mix(in srgb, var(--color-cyan) 20%, transparent)'
                  : 'rgba(255,255,255,0.05)',
                color: matches[i] ? (hit ? 'var(--color-teal)' : 'var(--color-cyan)') : 'var(--color-ink-faint, rgba(255,255,255,0.35))',
              }}
            >
              {ch}
            </span>
          ))}
      </span>
    </span>
  )
}

// The pixel bar the owner asked for on 2026-07-31 ("a cool pixel bar that fills
// as you go"), kept — with its constant corrected. It filled against k = 65,536,
// four times the real expected count, so it under-read the whole search; k is now
// MINE_EXPECTED_TRIES (16,384), the same number salt-mining.ts mines against.
// Capped at 96%: the search has no guaranteed finish, so the bar must never
// arrive.
const MINE_CELLS = 24
function ChanceBar({ p }: { p: number }) {
  const capped = Math.min(0.96, p)
  const filled = Math.round(capped * MINE_CELLS)
  return (
    <span className="flex items-center gap-2">
      <span
        className="flex gap-[3px]"
        role="progressbar"
        aria-valuenow={Math.round(capped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Share of searches that would have landed by now (not a deadline)"
      >
        {Array.from({ length: MINE_CELLS }, (_, i) => (
          <span
            key={i}
            className={i === filled ? 'animate-pulse' : undefined}
            style={{
              width: 7,
              height: 10,
              borderRadius: 2,
              background:
                i < filled
                  ? `color-mix(in srgb, var(--color-cyan) ${100 - (i / MINE_CELLS) * 45}%, var(--color-violet))`
                  : i === filled
                    ? 'color-mix(in srgb, var(--color-cyan) 45%, transparent)'
                    : 'rgba(255,255,255,0.08)',
            }}
          />
        ))}
      </span>
      <span className="font-num text-[11px] tabular-nums text-ink-faint">≈{Math.round(capped * 100)}%</span>
    </span>
  )
}

/** Best near-miss, as bits — 14 pips, one per bit of the mask. */
function NearMiss({ bits }: { bits: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex gap-[2px]" aria-hidden>
        {Array.from({ length: HOOK_FLAG_BITS }, (_, i) => (
          <span
            key={i}
            style={{
              width: 4,
              height: 8,
              borderRadius: 1,
              background:
                i < bits
                  ? bits === HOOK_FLAG_BITS
                    ? 'var(--color-teal)'
                    : `color-mix(in srgb, var(--color-cyan) ${60 + (i / HOOK_FLAG_BITS) * 40}%, var(--color-violet))`
                  : 'rgba(255,255,255,0.08)',
            }}
          />
        ))}
      </span>
      <span className="font-num text-[10px] tabular-nums text-ink-faint">
        closest {bits}/{HOOK_FLAG_BITS} bits
      </span>
    </span>
  )
}

export function SaltScanner({
  mining,
  attempts,
  found,
}: {
  mining: MineProgress | null
  /** Tries so far — kept separate so the count is live even before the first
   *  progress report lands. */
  attempts: number
  /** The mined address, once the search is over: the locked frame. */
  found?: string | null
}) {
  const reduced = reducedMotion()
  // Candidates are revealed at a readable pace rather than dumped: on the local
  // path the whole search can finish inside 100 ms, and six addresses arriving
  // in one frame is not something a person can see. Every row shown is a real
  // candidate that was really hashed — the pace is the only thing staged, and
  // the figures beside it stay instant and exact.
  const [shown, setShown] = useState<string[]>([])
  const queue = useRef<string[]>([])
  const seen = useRef(new Set<string>())

  useEffect(() => {
    for (const a of mining?.samples ?? []) {
      if (seen.current.has(a)) continue
      seen.current.add(a)
      queue.current.push(a)
    }
  }, [mining])

  useEffect(() => {
    if (reduced) {
      if (queue.current.length) {
        setShown((s) => [...s, ...queue.current].slice(-ROWS))
        queue.current = []
      }
      return
    }
    const id = window.setInterval(() => {
      if (!queue.current.length) return
      // Fill the empty window quickly, then settle to one row a tick — the box
      // must never sit blank while a search is genuinely running.
      setShown((s) => {
        const take = s.length < ROWS ? 2 : 1
        return [...s, ...queue.current.splice(0, take)].slice(-ROWS)
      })
    }, REVEAL_MS)
    return () => window.clearInterval(id)
  }, [reduced])

  const rate = mining?.rate ?? 0
  const bestBits = mining?.bestBits ?? 0
  const workers = mining?.workers ?? 1
  const localPath = mining?.mode !== 'rpc'

  // The one honest thing a bar can say here: the share of runs that would have
  // finished by this many tries. Never a deadline, never 100%.
  const landedShare = useMemo(() => 1 - Math.exp(-attempts / MINE_EXPECTED_TRIES), [attempts])

  const rows = found ? [...shown.slice(-(ROWS - 1)), found.toLowerCase()] : shown

  return (
    <div className="mt-2 rounded-xl border border-white/10 bg-void/40 px-3 py-3">
      {/* the scan — a fixed-height window so the panel never jumps as rows land */}
      {/* Grows from three rows to six rather than reserving the full window: a
          fast local search may only ever produce a few candidates, and a
          half-empty box reads as something broken. */}
      <div
        className="flex flex-col justify-end gap-1 overflow-hidden"
        style={{ minHeight: 3 * 20, maxHeight: ROWS * 20 }}
        aria-hidden
      >
        {rows.length === 0 ? (
          <span className="font-mono text-[11px] text-ink-faint">scanning…</span>
        ) : (
          rows.map((addr, i) => (
            <Candidate
              key={`${addr}-${i}`}
              addr={addr}
              hit={!!found && i === rows.length - 1}
              fade={found && i === rows.length - 1 ? 1 : 0.25 + (i / Math.max(1, rows.length - 1)) * 0.55}
            />
          ))
        )}
      </div>

      {/* what is being looked for, spelled out */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/8 pt-2 font-mono text-[10px] text-ink-faint">
        <span>
          must end <span className="text-ink-dim">088</span> — after a 0, 4, 8 or c
        </span>
        <NearMiss bits={found ? HOOK_FLAG_BITS : bestBits} />
      </div>

      {/* the measured figures */}
      <div
        className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-num text-[11px] tabular-nums text-ink-dim"
        role="status"
        aria-live="polite"
      >
        <span className="text-ink">{attempts.toLocaleString()}</span>
        <span className="text-ink-faint">tried</span>
        {rate > 0 && (
          <>
            <span className="text-ink">{Math.round(rate).toLocaleString()}/s</span>
            {workers > 1 && <span className="text-ink-faint">on {workers} threads</span>}
          </>
        )}
        <span className="text-ink-faint">typically ~{MINE_EXPECTED_TRIES.toLocaleString()}</span>
      </div>

      {!found && (
        <div className="mt-2">
          <ChanceBar p={landedShare} />
        </div>
      )}

      {/* the odds, in words — the only claim made about "how far along" */}
      <div className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
        {found ? (
          <span className="text-teal">address locked · every basket address is mined this way</span>
        ) : (
          <>
            1 address in {MINE_EXPECTED_TRIES.toLocaleString()} carries the mark. About{' '}
            <span className="text-ink-dim">{Math.min(99, Math.round(landedShare * 100))}%</span> of searches have
            landed by this point — yours can land on the very next one.
          </>
        )}
      </div>

      {/* the interruption note, kept — and told the truth about which search is
          running: minutes are only possible on the chain-probing fallback. */}
      {!found && (
        <div className="mt-2 font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
          {localPath ? 'Usually over in moments…' : 'Could take a few minutes…'}
        </div>
      )}
    </div>
  )
}
