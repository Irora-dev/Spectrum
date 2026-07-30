import { useState, type ReactNode } from 'react'

// The ⓘ disclosure — R's design law: the label stays one line, the detail lives
// behind the dot. Opens on hover AND on click/tap so touch + keyboard work.
// Extracted from /setup (2026-07-29) so the launch flow shares one implementation.
export function InfoDot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="What this means"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`press grid h-4 w-4 place-items-center rounded-full border font-mono text-[9px] font-bold transition-colors ${
          open ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-white/25 bg-white/[0.07] text-ink-dim hover:border-cyan/50 hover:text-cyan'
        }`}
      >
        i
      </button>
      {open && (
        <span className="absolute left-1/2 top-6 z-30 w-[min(22rem,78vw)] -translate-x-1/2 rounded-xl border border-white/[0.2] bg-panel-2 p-3.5 text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]">
          {children}
        </span>
      )}
    </span>
  )
}
