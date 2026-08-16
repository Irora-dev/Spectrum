const META: Record<number, { short: string; name: string; color: string }> = {
  1: { short: 'ETH', name: 'Ethereum', color: '#a48bff' },
  8453: { short: 'BASE', name: 'Base', color: '#4d8bff' },
  4663: { short: 'RH', name: 'Robinhood', color: '#5ac53a' },
}

/** The chain's house identity (dot colour + short code) — for surfaces that
 *  compose their own chain-flavoured control (the spotlight's icon pills)
 *  instead of mounting the whole badge. */
export function chainMeta(chainId: number): { short: string; color: string } {
  return META[chainId] ?? META[8453]
}

/** THE CHAIN'S MARK (the owner 2026-08-06 12:53: "instead of saying the chain
 *  name, you have the logo"). Drawn inline rather than fetched: these sit on
 *  a money line, and a logo that 404s or arrives late leaves a hole in a
 *  sentence about someone's balance — AssetLogo's network ladder is right for
 *  a token grid and wrong here. Each mark wears the chain's house colour, the
 *  same one the dot badge and the spotlight pills already use.
 *
 *  An unknown chain has no mark to draw, so it falls back to its short code in
 *  a tinted disc — a chain we cannot name is never given another chain's face. */
export function ChainLogo({ chainId, size = 16, className = '' }: { chainId: number; size?: number; className?: string }) {
  const m = META[chainId]
  const box = { width: size, height: size }
  if (!m) {
    const short = (META[chainId] ?? { short: String(chainId) }).short
    return (
      <span
        aria-hidden
        className={`inline-grid shrink-0 place-items-center rounded-full font-mono text-[7px] font-bold text-ink-dim ${className}`}
        style={{ ...box, background: 'rgba(255,255,255,0.08)' }}
      >
        {short.slice(0, 2)}
      </span>
    )
  }
  const common = { viewBox: '0 0 24 24', style: box, className: `shrink-0 ${className}`, 'aria-hidden': true } as const
  // ETHEREUM — the octahedron, upper face solid over a receded lower face.
  if (chainId === 1)
    return (
      <svg {...common} fill={m.color}>
        <path d="M12 2 5.5 12.15 12 15.9l6.5-3.75Z" />
        <path d="M12 17.25 5.5 13.4 12 22l6.5-8.6Z" opacity="0.62" />
      </svg>
    )
  // BASE — a whole disc. The brand mark really is a circle with a flat left
  // edge, and drawing it accurately is what the owner read as a defect: "the Base
  // one is also cut off on the left, it shouldn't be cut off" (2026-08-06
  // 14:10). At 17px a chord is indistinguishable from a clipping bug, and the
  // house already identifies Base by this exact blue on the badge dot and the
  // spotlight pills — so the colour carries the identity and the shape stops
  // raising a false alarm.
  if (chainId === 8453)
    return (
      <svg {...common} fill={m.color}>
        <circle cx="12" cy="12" r="10" />
      </svg>
    )
  // ROBINHOOD CHAIN — the feather, quill running past the vane.
  return (
    <svg {...common} fill="none">
      <path d="M19 4c1.1 7.2-3.6 13.9-13 16 .4-7.9 5-14 13-16Z" fill={m.color} />
      <path d="M18.4 4.6 4.4 21.4" stroke={m.color} strokeWidth="1.8" strokeLinecap="round" opacity="0.75" />
    </svg>
  )
}

export function ChainBadge({
  chainId,
  className = '',
  size = 'sm',
}: {
  chainId: number
  className?: string
  /** logo = the Token hero's 32px icon pill (the chain's mark, no letters);
   *  md = the lettered 32px/13px pill (the creator hero's chain row);
   *  sm = the compact badge every other surface renders, unchanged. */
  size?: 'sm' | 'md' | 'logo'
}) {
  const m = META[chainId] ?? META[8453]
  // logo wears the chain's MARK, not its letters (owner 0903: "the RH should
  // be changed to have the base / ethereum / robinhood logo") — the name rides
  // the title/aria so the pill still says what it is. The Token hero's pill
  // row uses it; md keeps the lettered form for rows sized around words.
  if (size === 'logo')
    return (
      <span
        title={m.name}
        aria-label={m.name}
        className={`inline-grid h-8 w-8 shrink-0 place-items-center rounded-full ${className}`}
        style={{ background: `${m.color}1a`, border: `1px solid ${m.color}33` }}
      >
        <ChainLogo chainId={chainId} size={17} />
      </span>
    )
  const chrome =
    size === 'md'
      ? 'h-8 gap-1.5 px-3 text-[13px] font-semibold tracking-[0.08em]'
      : 'gap-1 px-2 py-0.5 text-[9px] font-bold tracking-[0.12em]'
  return (
    <span
      className={`inline-flex items-center rounded-full uppercase ${chrome} ${className}`}
      style={{ color: m.color, background: `${m.color}1a`, border: `1px solid ${m.color}33` }}
    >
      <span className={size === 'md' ? 'h-2 w-2 rounded-full' : 'h-1.5 w-1.5 rounded-full'} style={{ background: m.color }} />
      {m.short}
    </span>
  )
}
