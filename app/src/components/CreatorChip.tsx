import { Link } from 'react-router-dom'
import { BasketAvatar } from './BasketAvatar'
import { useCreatorMeta } from '../lib/spectrum/hooks'
import { resolveCreator } from '../lib/spectrum/creator'

// Compact creator attribution used on cards / spotlights. Shows the creator's
// verified X avatar + handle when a deployer-signed metadata blob is published
// (creator-metadata.ts), else the honest on-chain deployer-address attribution
// (resolveCreator's fallback chain). Links to the creator profile unless
// `asLink={false}` (e.g. inside another anchor, like TopBasket's card link).
export function CreatorChip({
  deployer,
  basket,
  chainId,
  size = 18,
  asLink = true,
  className = '',
}: {
  deployer: string | null
  basket: string
  chainId: number
  size?: number
  asLink?: boolean
  className?: string
}) {
  const { data: meta } = useCreatorMeta(basket, chainId)
  const resolved = resolveCreator({
    handle: meta?.handle,
    name: meta?.name,
    deployer,
    basketAddress: basket,
  })
  const avatarSymbol = resolved.kind === 'address' ? 'x' : resolved.label.replace(/^@/, '')

  const inner = (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <BasketAvatar
        address={deployer ?? basket}
        symbol={avatarSymbol}
        imageUrl={meta?.avatarUrl ?? undefined}
        size={size}
      />
      <span className="truncate">{resolved.label}</span>
    </span>
  )

  if (asLink && deployer) {
    return (
      <Link
        to={`/creator/${deployer}`}
        onClick={(e) => e.stopPropagation()}
        className="pointer-events-auto inline-flex min-w-0 items-center text-ink-dim transition-colors hover:text-cyan"
      >
        {inner}
      </Link>
    )
  }
  return <span className="inline-flex min-w-0 items-center text-ink-dim">{inner}</span>
}
