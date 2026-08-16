import { Link } from 'react-router'
import { useAllBaskets, type LineageInfo } from '../lib/spectrum/hooks'
import { basketHref } from '../lib/spectrum/short-url'

// The version lineage of a basket, rendered as quiet pills (v1 · v2 · …). The
// current version is highlighted; others link to their own page. Renders nothing
// for a single-version basket. Lineage is a deployer-signed social convention
// (versioning.ts) — there is no on-chain successor registry.
export function VersionStrip({
  lineage,
  current,
  chainId,
}: {
  lineage: LineageInfo
  current: string
  chainId: number
}) {
  const { data: all } = useAllBaskets()
  if (lineage.count < 2) return null
  const symbolOf = (addr: string) =>
    all?.find((b) => b.address.toLowerCase() === addr.toLowerCase())?.symbol

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Versions</span>
      {lineage.versions.map((addr, i) => {
        const isCurrent = addr.toLowerCase() === current.toLowerCase()
        const sym = symbolOf(addr)
        const label = `v${i + 1}${sym ? ` · $${sym}` : ''}`
        // The page canonicalizes any version's URL forward to the head (the
        // one-link rule), so an OLDER pill must ask for the exact view or the
        // click would bounce straight back. The head pill links plain — it IS
        // the canonical page.
        const isHead = addr.toLowerCase() === (lineage.head ?? '').toLowerCase()
        return isCurrent ? (
          <span
            key={addr}
            aria-current="true"
            className="rounded-full border border-cyan/50 bg-cyan/10 px-2 py-0.5 font-mono text-[10px] text-cyan"
          >
            {label}
          </span>
        ) : (
          <Link
            key={addr}
            // mint the SHORT form (owner 2026-08-01: what the app mints from
            // now on); long links keep resolving, we just stop making them
            to={`${basketHref({ symbol: sym ?? '', address: addr, chainId })}${isHead ? '' : '?v=exact'}`}
            className="press rounded-full border border-white/12 px-2 py-0.5 font-mono text-[10px] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            {label}
          </Link>
        )
      })}
    </div>
  )
}
