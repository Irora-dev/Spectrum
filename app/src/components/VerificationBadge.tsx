// F6 badge ladder — surfaces the trust tier that is otherwise invisible (signed
// metadata simply doesn't render unless its signature recovers to the on-chain
// deployer). Copy states exactly what the badge proves and never implies
// endorsement (compliance §9). Shared by the creator profile + the leaderboard.
export function VerificationBadge({
  verified,
  hasHandle = false,
  size = 'md',
}: {
  verified: boolean
  hasHandle?: boolean
  size?: 'sm' | 'md'
}) {
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]'
  const icon = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'

  if (verified) {
    return (
      <span
        title={
          hasHandle
            ? 'This creator published metadata signed by their deploy wallet; the signature is verified against the basket’s on-chain deployer. The wallet claims this handle, it is not an endorsement.'
            : 'This creator published metadata signed by their deploy wallet, verified against the on-chain deployer. Proves control of the wallet, not an endorsement.'
        }
        className={`inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal/[0.08] font-mono uppercase tracking-[0.12em] text-teal ${pad}`}
      >
        <svg viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        {size === 'sm' ? 'Signed' : 'Signed identity'}
      </span>
    )
  }
  return (
    <span
      title="No signed metadata published for this creator yet, identity is the on-chain deploy address, the honest fact."
      className={`inline-flex items-center gap-1 rounded-full border border-white/12 font-mono uppercase tracking-[0.12em] text-ink-faint ${pad}`}
    >
      Address only
    </span>
  )
}
