import { useEffect, useState } from 'react'

// Surfaces the otherwise-hidden CREATE2 salt mine: every basket is a Uniswap V4 hook
// whose address must end in 0x88 (the BEFORE_SWAP hook flags), so the deployer brute-
// forces a salt until the predicted address lands on those bits. Here it reads as a
// "forge": the hex scrambles while mining (probe count ticking), then locks onto the
// real mined address with the 0x88 tail lit. Idle, it ambiently shimmers as a teaser.

const HEX = '0123456789abcdef'
const rand = (n: number) => {
  let s = ''
  for (let i = 0; i < n; i++) s += HEX[(Math.random() * 16) | 0]
  return s
}

export function HookForge({
  status,
  attempts = 0,
  predicted,
}: {
  status?: string
  attempts?: number
  predicted?: string | null
}) {
  const mining = status === 'mining' && !predicted
  const [body, setBody] = useState(() => rand(4))

  useEffect(() => {
    if (predicted) return
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    const id = window.setInterval(() => setBody(rand(4)), mining ? 50 : 340)
    return () => window.clearInterval(id)
  }, [mining, predicted])

  const head = predicted ? predicted.slice(0, 6) : `0x${body}`
  const tail = predicted ? predicted.slice(-4) : '88'

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          {predicted ? 'Hook address forged' : 'Hook address'}
        </span>
        <span
          className="font-mono text-[9px] uppercase tracking-wide"
          style={{ color: mining ? 'var(--color-cyan)' : '#6b6c80' }}
        >
          {mining ? `${attempts.toLocaleString()} probed` : 'ends in 0x88'}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1.5 font-num text-xl tabular-nums">
        <span className={predicted ? 'text-ink' : 'text-ink-dim'}>{head}</span>
        <span className="text-ink-faint">…</span>
        <span className="font-bold" style={{ color: 'var(--color-cyan)', textShadow: '0 0 10px rgba(53,224,255,0.55)' }}>
          {tail}
        </span>
      </div>

      <div className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
        A Uniswap V4 hook whose address is mined to end in <span className="text-ink-dim">0x88</span>, the
        BEFORE_SWAP flags that let it price mints &amp; redeems at NAV.
      </div>
    </div>
  )
}
