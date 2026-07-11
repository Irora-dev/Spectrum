const META: Record<number, { short: string; color: string }> = {
  1: { short: 'ETH', color: '#a48bff' },
  8453: { short: 'BASE', color: '#4d8bff' },
  4663: { short: 'RH', color: '#5ac53a' },
}

export function ChainBadge({ chainId, className = '' }: { chainId: number; className?: string }) {
  const m = META[chainId] ?? META[8453]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] ${className}`}
      style={{ color: m.color, background: `${m.color}1a`, border: `1px solid ${m.color}33` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.short}
    </span>
  )
}
