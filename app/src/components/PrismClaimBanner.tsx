import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { pageEnabled } from '../theme/brand'
import brand from '../brand.config'
import { clientFor } from '../lib/chain/rpc'
import { PRISM_CLAIM_CHAIN_ID, PRISM_CLAIM_VAULT, isInClaimSnapshot, prismVaultAbi } from '../lib/prism/claim'
import { PixelRainbow } from './PoweredByPrism'

const DISMISS_KEY = 'spectrum:prism-claim-banner'

// Site-wide pointer at /claim (owner ask 2026-07-30: "a prism claim banner and
// page"; "it should be on by default"). DEFAULT-VISIBLE to every visitor —
// including a CONNECTED wallet that isn't in the snapshot: the connected
// wallet being ineligible says nothing about the visitor's other wallets, and
// /claim checks any address (first cut hid it there, and the owner's own
// auto-connected dev wallet made the banner "invisible" on every review pass).
// The copy turns personal when the connected wallet is in the snapshot and
// unpaid; the banner disappears only when that wallet's claim is already PAID
// (the one state with a definitive answer) or on dismiss. Eligibility reads
// the 53KB address index, never the 1.1MB proofs chunk. Dismissal is
// per-SESSION on purpose: an unclaimed holder is re-reminded next visit until
// the vault marks them paid.
/** Slide form — the BannerCarousel consumes this; the component wrapper stays for compatibility. */
export function usePrismClaimSlide() {
  const { address } = useAccount()
  // DEV-only design preview: `?claimBanner=1` forces the PERSONAL variant
  // without a snapshot wallet (the generic variant already shows by default).
  // import.meta.env.DEV compiles to false in prod, so the branch is stripped.
  const [forced] = useState(
    () => import.meta.env.DEV && new URLSearchParams(window.location.search).has('claimBanner'),
  )
  // localStorage, NOT sessionStorage. The banner is default-visible to every
  // visitor, so with a per-session dismissal anyone outside the 1,203-address
  // snapshot — which is almost everyone — dismissed it on every single visit,
  // forever. A dismissal the user has to repeat is not a dismissal.
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  const inSnapshot = useQuery({
    queryKey: ['prism-claim', 'in-index', address?.toLowerCase()],
    queryFn: () => isInClaimSnapshot(address as string),
    enabled: !!address,
    staleTime: Infinity, // the snapshot is immutable
  })
  const claimed = useQuery({
    queryKey: ['prism-claim', 'claimed', address?.toLowerCase()],
    queryFn: () =>
      clientFor(PRISM_CLAIM_CHAIN_ID).readContract({
        address: PRISM_CLAIM_VAULT,
        abi: prismVaultAbi,
        functionName: 'claimed',
        args: [address as `0x${string}`],
      }),
    enabled: !!address && inSnapshot.data === true,
  })

  const eligible = !!address && inSnapshot.data === true
  let variant: 'generic' | 'personal' | null
  if (forced) variant = 'personal'
  else if (dismissed) variant = null
  else if (eligible && claimed.data === true) variant = null // paid — done, gone for good
  else if (eligible && claimed.data === false) variant = 'personal'
  else variant = 'generic' // anonymous, loading, or this wallet not in the snapshot

  if (!pageEnabled(brand.pages, 'claim')) return null
  if (!variant) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setDismissed(true)
  }

  return (
    <div>
    <div className="relative overflow-hidden border-b border-magenta/25">
      {/* the spectral wash: a low-alpha gradient over the void, magenta-anchored */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(90deg, color-mix(in srgb, var(--color-cyan) 9%, transparent), color-mix(in srgb, var(--color-violet) 11%, transparent) 34%, color-mix(in srgb, var(--color-magenta) 13%, transparent) 62%, color-mix(in srgb, var(--color-amber) 9%, transparent))',
        }}
      />
      {/* the sheen — the house bento sweep, slow */}
      <div
        aria-hidden
        className="bento-sheen pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.14) 50%, transparent 58%)',
          animationDuration: '8s',
        }}
      />
      <div className="relative mx-auto flex max-w-[1000px] items-center px-4 py-2 sm:px-6">
        {/* centered content; the dismiss sits at the rail's edge without pulling it off-centre */}
        <span className="flex min-w-0 flex-1 items-center justify-center gap-2.5 text-center font-mono text-[11px] leading-relaxed text-ink-dim">
          <PixelRainbow className="h-3.5 w-auto shrink-0" />
          <span className="min-w-0">
            {variant === 'personal' ? (
              <>
                This wallet has an <span className="text-ink">unclaimed PRISM allocation</span> from
                the community&rsquo;s v2 launch.{' '}
                <Link to="/claim" className="font-semibold text-magenta underline underline-offset-2 hover:text-ink">
                  Claim it →
                </Link>
              </>
            ) : (
              <>
                The <span className="text-ink">PRISM v2 community claim</span> is live.{' '}
                {/* the qualifier is DESKTOP-ONLY (mobile sweep 2026-08-06): the
                    full sentence wrapped to three centred lines and ate ~165px
                    of every page's first viewport on a phone. The link says the
                    action; /claim itself explains the eligibility. */}
                <span className="hidden sm:inline">
                  Held v1 PRISM? Your make-good allocation may be waiting.{' '}
                </span>
                {/* thumb-sized (mobile audit 2026-08-05): was 14px tall */}
                <Link
                  to="/claim"
                  className="inline-flex min-h-[36px] items-center font-semibold text-magenta underline underline-offset-2 hover:text-ink"
                >
                  Check your address →
                </Link>
              </>
            )}
          </span>
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          /* 36px thumb target (mobile sweep 2026-08-06: measured 28×28). The
             GLYPH stays 14px — the target grows, the mark does not. */
          className="press grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
      {/* The disclosure that used to sit here now rides BannerCarousel's RiskSlide and is
          rendered unconditionally by Layout — it must not vanish because the
          banner region capped itself to one strip. */}
    </div>
  )
}

export function PrismClaimBanner() {
  return <>{usePrismClaimSlide()}</>
}
