import { Link, useNavigate } from 'react-router'
import { useAccount } from 'wagmi'
import { DEPLOY_ENABLED } from '../lib/config/features'
import { flowHref } from '../lib/spectrum/flow-link'
import { seedDraftFromComposition, type CompositionLeg } from '../lib/spectrum/seed-from-holdings'
import { recordVersionIntent } from '../lib/spectrum/version-intent'

// "New version" — THE ITERATE LOOP's front door (ratified plan #1,
// 2026-08-04). A new version is a separate immutable deployment the creator
// anoints as successor via signed metadata (versioning.ts); baskets are never
// edited in place. Shown only to the basket's own deployer, and only when
// deploy is enabled on this build (a creator self-action).
//
// Where it goes: the CURRENT publish flow when this build carries it, with the
// recipe seeded as the draft (never clobbering a standing one — the flow's
// Resume semantics stand) and the supersedes INTENT recorded, so the deployed
// basket's page can pre-wire the lineage signature instead of leaving it as a
// separate chore. Builds without the flow keep the legacy /launch prefill —
// and still record the intent, so the post-deploy prompt works on both paths.
export function VersionButton({
  basket,
  deployer,
  chainId,
  holdings,
  className = '',
  prominent = false,
}: {
  basket: string
  deployer: string | null
  chainId: number
  /** The basket's designed recipe — enables the flow path's seed. Callers
   *  without holdings in hand (the creator page's rows) still get the loop:
   *  intent is recorded either way. */
  holdings?: CompositionLeg[]
  className?: string
  /** Headline styling (cyan fill + glow) — the Token page's version-strip row. */
  prominent?: boolean
}) {
  const { address } = useAccount()
  const navigate = useNavigate()
  if (!DEPLOY_ENABLED) return null
  if (!address || !deployer || address.toLowerCase() !== deployer.toLowerCase()) return null
  // Prominent = the Token-page deployer pair (rides the constituent-icons row,
  // side by side with "Link previous version" — matched pills, owner 2026-07-07).
  const style = prominent
    ? 'h-9 rounded-full border border-cyan/50 bg-cyan/10 px-4 font-semibold text-cyan shadow-[0_0_18px_-6px_rgba(53,224,255,0.55)] hover:border-cyan hover:bg-cyan/20'
    : 'rounded-lg border border-white/12 px-3 py-1.5 text-ink-dim hover:border-cyan/50 hover:text-cyan'
  const chrome = `press inline-flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] ${style} ${className}`

  const publishFlow = flowHref('publish')
  if (publishFlow && holdings && holdings.length >= 2) {
    return (
      <button
        type="button"
        onClick={() => {
          // Intent follows the SEED (audit C2): with a standing draft the
          // recipe does not ride (never-clobber — the flow resumes the old
          // draft), and recording an intent for a publish that isn't this
          // recipe would mislabel an unrelated basket as the new version.
          const r = seedDraftFromComposition(address, holdings)
          if (r?.seeded) recordVersionIntent(deployer, { predecessor: basket, chainId })
          navigate(publishFlow)
        }}
        className={chrome}
      >
        ↻ New version
      </button>
    )
  }
  return (
    <Link
      to={`/create?from=${basket}&chain=${chainId}`}
      onClick={() => recordVersionIntent(deployer, { predecessor: basket, chainId })}
      className={chrome}
    >
      ↻ New version
    </Link>
  )
}
