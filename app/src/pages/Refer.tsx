import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { Link as RouterLink } from 'react-router'
import { flowHref } from '../lib/spectrum/flow-link'
import { useAccount, useEnsName } from 'wagmi'
import { MAINNET_CHAIN_ID } from '../lib/chain/constants'
import { SUPPORTED_CHAIN_IDS, chainCfg } from '../lib/chain/chains'
import { WalletButton } from '../components/WalletButton'
import { ConceptReveal } from '../components/ConceptReveal'
import { useReferralEarned } from '../components/ReferralCard'
import { useClaimAll } from '../lib/spectrum/use-fee-actions'
import { refLinkFor } from '../lib/spectrum/referral'
import { TRADING_ENABLED } from '../lib/config/features'
import { shortAddr } from '../lib/spectrum/format'
import { useAllBaskets, usePortfolio } from '../lib/spectrum/hooks'
import { CrownWinnings } from '../components/CrownWinnings'
import { PortfolioClaims } from '../components/PortfolioClaims'

const GRADIENT = 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))'
const CARD_GRAD = 'linear-gradient(135deg, rgba(53,224,255,0.35), rgba(164,139,255,0.18) 45%, rgba(255,77,184,0.28))'
const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── a reusable explainer modal (spectral dress, backdrop/escape close) ────────
function RefModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="w-[min(34rem,100%)] rounded-3xl p-px" style={{ background: CARD_GRAD }} onClick={(e) => e.stopPropagation()}>
        <div className="rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/[0.97] p-6 sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-xl font-bold uppercase tracking-tight text-ink">{title}</h3>
            <button type="button" onClick={onClose} aria-label="Close" className="press grid h-8 w-8 place-items-center rounded-md text-ink-dim hover:bg-white/8 hover:text-ink">✕</button>
          </div>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// A 3-step flow: link → activity → your cut. Used by both rail explainers.
function FlowSteps({ tint, steps }: { tint: string; steps: { icon: ReactNode; label: string }[] }) {
  return (
    <div className="flex items-stretch justify-between gap-1">
      {steps.map((s, i) => (
        <div key={s.label} className="flex flex-1 items-center gap-1">
          <div className="flex flex-1 flex-col items-center gap-2 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-white/12" style={{ color: tint, background: `color-mix(in srgb, ${tint} 14%, transparent)` }}>
              {s.icon}
            </div>
            <span className="font-mono text-[10px] uppercase leading-tight tracking-wide text-ink-dim">{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14m0 0l-5-5m5 5l-5 5" />
            </svg>
          )}
        </div>
      ))}
    </div>
  )
}

const LinkIcon = <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></svg>
const SwapIcon = <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v13m0 0l-3-3m3 3l3-3M17 20V7m0 0l-3 3m3-3l3 3" /></svg>
const CoinIcon = <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v10M14.5 9.2c-.6-.8-1.6-1.2-2.6-1.2-1.4 0-2.5.8-2.5 1.9 0 2.6 5.3 1.3 5.3 3.9 0 1.1-1.2 1.9-2.7 1.9-1.2 0-2.3-.5-2.8-1.3" /></svg>
const LaunchIcon = <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l9 9-9 9-9-9 9-9z" /></svg>

// /refer — referral marketing page (owner 2026-07-07, cleaned up 21:49): hero
// with the link generated INLINE, two trimmed rails, a why strip, then a big
// full-width claimable breakdown. Earn/claim is on-chain (interface + launcher
// slices via flushFrontendFees).

// The link, generated right in the hero (owner 21:49). Not connected → the
// connect button IS the CTA; connected → "Get your link" reveals it inline.
function HeroLink() {
  const { address } = useAccount()
  // vanity link: prefer the referrer's reverse-ENS name (?ref=name.eth resolves
  // back on capture) over the raw address (owner 2026-07-07).
  const { data: ensName } = useEnsName({ address, chainId: MAINNET_CHAIN_ID })
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  if (!address) {
    return (
      <div className="enter flex flex-col items-center gap-2" style={{ '--enter-i': 3 } as CSSProperties}>
        <WalletButton />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">connect to get your link</span>
      </div>
    )
  }
  if (!revealed) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="enter press inline-flex items-center gap-1.5 rounded-full px-7 py-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-void transition-opacity hover:opacity-90"
        style={{ background: GRADIENT, '--enter-i': 3 } as CSSProperties}
      >
        Get your link
      </button>
    )
  }

  const link = refLinkFor(ensName ?? address, origin)
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent('Trade and launch onchain basket tokens on Spectrum:')}&url=${encodeURIComponent(link)}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const nativeShare = () => {
    // Repositioned per the 2026-08-02 R/C daily (the owner: "it's no longer about
    // 'refer them to build a basket', it's 'refer them to handle their
    // portfolio' — it's much more of an easier sell"). Managing what you hold
    // is the wide door; launching a basket is the thing a few people graduate
    // into, so it stays named but stops leading.
    void navigator
      .share?.({
        title: 'Spectrum',
        text: 'Manage your onchain portfolio across networks, and basket it for others when you want to:',
        url: link,
      })
      .catch(() => {})
  }
  return (
    <div className="w-full max-w-xl rounded-2xl border border-cyan/30 bg-cyan/[0.04] p-4 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-left font-mono text-sm text-ink" title={link}>
          {link}
        </code>
        <button
          type="button"
          onClick={copy}
          className="press rounded-xl border border-cyan/50 bg-cyan/15 px-4 py-2.5 font-display text-sm font-bold uppercase tracking-wide text-cyan hover:border-cyan"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <a
          href={xHref}
          target="_blank"
          rel="noreferrer"
          className="press rounded-xl border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
        >
          Share on X
        </a>
        {canNativeShare && (
          <button
            type="button"
            onClick={nativeShare}
            className="press rounded-xl border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
          >
            Share
          </button>
        )}
      </div>
      <p className="mt-2 font-mono text-[10px] text-ink-faint">Tags activity to {shortAddr(address)} · first-touch, persists per device</p>
    </div>
  )
}

/** Does ANY configured chain carry a league pool? Build-time truth from the
 *  deployments book — chains.ts's own contract is "unset -> no /league page, no
 *  league copy anywhere", so this is what makes the second half true. */
const ANY_LEAGUE_CHAIN = SUPPORTED_CHAIN_IDS.some((id) => {
  try {
    return !!chainCfg(id).leaguePool
  } catch {
    return false
  }
})

export function Refer() {
  const { address } = useAccount()
  const { items, total, claimableTotal, loading: earningsLoading } = useReferralEarned()
  const ca = useClaimAll()
  // Only genuinely flushable pots reach the claim button — a mainnet pot at or
  // under the 10-USDC crank floor is refused by the contract (F-1), so sending
  // it would only confuse (and on the incumbent lineage, strip it to the cranker).
  const flushableItems = items.filter((it) => it.flushable)
  // `!ca.running` used to be part of this, which UNMOUNTED the button the
  // instant it was pressed (QOL 2026-08-07): the sweep then fired a wallet
  // prompt per pot with nothing on the page saying it was running, and the
  // button's own "Claiming x/y…" label and disabled state were unreachable
  // code. Running is a DISABLED state, not an absent one — the classic Earn
  // card (Portfolio.tsx:268) and PortfolioClaims.tsx:83 both already do that.
  const canClaim = TRADING_ENABLED && flushableItems.length > 0
  const [modal, setModal] = useState<null | 'buyer' | 'creator' | 'spectrum'>(null)

  // Creator earnings belong on this page too (owner 2026-07-30): the accrual
  // mapping is ONE per-address pot (pendingFrontendFees), so `total` already
  // contains creator fees on baskets you deployed and any fee-tag accruals.
  // Derived from the basket list alone — no per-holding balance multicall
  // (audit) — and the label claims only what deployer-keying supports: "your
  // basket" (the creator fee pays creatorPayout, which may not be the
  // deployer, so the row never asserts WHICH slice filled the pot).
  const { data: allBaskets, chainsFailed } = useAllBaskets()
  // Holder-fee reads are ~9 contract calls per basket, so they are scoped to the
  // baskets this wallet actually HOLDS — the same subset the Portfolio's Earn
  // card uses, and the same query keys, so the two pages share one cache. An
  // earlier pass here passed EVERY basket on every chain and turned this page's
  // per-basket cost from 1 read into ~10 (caught in review, 2026-08-01).
  const { data: portfolio } = usePortfolio(address)
  const heldBaskets = (portfolio?.holdings ?? []).map((h) => h.basket)
  const me = address?.toLowerCase()
  const created = me
    ? (allBaskets ?? []).filter((b) => b.deployer?.toLowerCase() === me && !b.supersededBy)
    : []
  const createdKeys = new Set(created.map((b) => `${b.chainId}:${b.address.toLowerCase()}`))
  const earningKeys = new Set(items.map((it) => `${it.chainId}:${it.address.toLowerCase()}`))
  const quietCreated = created.filter((b) => !earningKeys.has(`${b.chainId}:${b.address.toLowerCase()}`))

  return (
    <div className="pb-10">
      {/* ── HERO (full-bleed) with the link generated inline ──────────────── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/15 blur-[130px]" />
          <div className="absolute left-[18%] top-[28%] h-72 w-72 rounded-full bg-cyan/12 blur-[120px]" />
          <div className="absolute right-[16%] top-[42%] h-72 w-72 rounded-full bg-magenta/12 blur-[130px]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(125% 85% at 50% 42%, rgba(5,5,11,0.6) 0%, rgba(5,5,11,0.2) 46%, transparent 78%)' }} />
        <div className="relative z-10 mx-auto flex min-h-[56svh] max-w-4xl flex-col items-center justify-center px-4 pt-6 text-center">
          <div className="enter inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-ink-dim backdrop-blur" style={{ '--enter-i': 0 } as CSSProperties}>
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" />
            Earn · permissionless
          </div>
          <h1 className="enter mt-7 font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl md:text-8xl" style={{ '--enter-i': 1 } as CSSProperties}>
            Share Spectrum, earn the <span className="spectral-text">fees</span>.
          </h1>
          <p className="enter mx-auto mt-7 max-w-xl text-base leading-snug text-ink-dim sm:text-lg" style={{ '--enter-i': 2 } as CSSProperties}>
            Every trade in every basket launched through your link pays you a slice of the protocol
            fee, onchain in USDC, with no signup.
          </p>
          <div className="mt-9 flex w-full flex-col items-center">
            <HeroLink />
          </div>
          {/* the earn→create seam (owner ~17:1x): the homepage sends people
              HERE to learn about the fee — this sends them back to create the
              thing that earns it. Gated on the flow; never a dead door. */}
          {flowHref('publish') && (
            <p className="enter mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint" style={{ '--enter-i': 3 } as CSSProperties}>
              the creator fee starts with a basket ·{' '}
              <RouterLink to="/create" className="text-cyan transition-colors hover:text-ink">
                create one →
              </RouterLink>
            </p>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-16 px-1">
        {/* ── CLAIMABLE — first thing under the hero (owner 2026-07-29): every
               earning type in one place — referral interface fees, launcher
               fees, and pointers to creator-fee + poke claims ── */}
        <section className="rounded-3xl border border-cyan/25 bg-cyan/[0.03] p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-cyan">Claimable · USDC</div>
              {/* A TOTAL IS NOT AN ANSWER UNTIL THE READS LAND (QOL
                  2026-08-07). The hook sums `q.data ?? 0`, so mid-flight is
                  arithmetically identical to nothing-earned — and this page is
                  SHARED, so a cold load told a referrer with real pending fees
                  "$0.00" with a straight face. An ellipsis while counting. */}
              <div className="mt-1 font-num text-5xl font-semibold tabular-nums text-ink sm:text-6xl">
                {!TRADING_ENABLED ? '—' : earningsLoading ? '…' : fmtUsd(claimableTotal)}
              </div>
              {/* pots under a chain's crank floor accrue but can't flush yet —
                  count them separately, never inside "claimable" (F-1) */}
              {TRADING_ENABLED && total - claimableTotal > 0.005 && (
                <div className="mt-1 font-mono text-[11px] text-ink-faint">
                  + {fmtUsd(total - claimableTotal)} accruing toward the $10 minimum
                </div>
              )}
            </div>
            {canClaim && (
              <button
                type="button"
                disabled={ca.running}
                onClick={() => void ca.claimAll(flushableItems.map((it) => ({ address: it.address, chainId: it.chainId, kind: 'flush' as const })))}
                className="press rounded-xl px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-void transition-opacity hover:opacity-90 disabled:opacity-60"
                style={{ background: GRADIENT }}
              >
                {ca.running ? `Claiming ${ca.done + ca.failed}/${ca.total}…` : 'Claim all'}
              </button>
            )}
          </div>

          {items.length > 0 || quietCreated.length > 0 ? (
            <div className="mt-6 divide-y divide-white/8 border-t border-white/10">
              {items.map((it) => (
                <div key={`${it.chainId}:${it.address}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">${showSymbol(it.symbol)}</span>
                    {createdKeys.has(`${it.chainId}:${it.address.toLowerCase()}`) && (
                      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">your basket</span>
                    )}
                    {!it.flushable && (
                      <span
                        className="rounded-full border border-amber/30 bg-amber/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.12em] text-amber"
                        title="Ethereum refuses frontend-fee flushes at or under 10 USDC — the pot keeps accruing and flushes once it clears the floor."
                      >
                        accruing · flushes over $10
                      </span>
                    )}
                  </span>
                  <span className={`font-num text-sm tabular-nums ${it.flushable ? 'text-teal' : 'text-ink-dim'}`}>{fmtUsd(it.usdc)}</span>
                </div>
              ))}
              {/* deployed baskets with nothing pending yet, at $0.00 — the row
                  claims only "you deployed this, nothing pending to you here"
                  (whether its creator fee pays you depends on the payout
                  address chosen at launch) */}
              {quietCreated.map((b) => (
                <div key={`q:${b.chainId}:${b.address}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="font-display text-sm font-bold uppercase tracking-wide text-ink-dim">${showSymbol(b.symbol)}</span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">your basket</span>
                  </span>
                  <span className="font-num text-sm tabular-nums text-ink-faint">{fmtUsd(0)}</span>
                </div>
              ))}
            </div>
          ) : earningsLoading ? (
            /* "nothing yet" is a CLAIM about the chain, and it needs the reads
               to have finished before it can be made honestly */
            <p className="mt-4 text-sm text-ink-dim">Checking every basket for fees accrued to you…</p>
          ) : (
            <p className="mt-4 text-sm text-ink-dim">
              Nothing to claim yet. Share your link with someone managing a portfolio, or launch a
              basket of your own — referral, launcher and creator fees all accrue here.
            </p>
          )}

          <p className="mt-5 font-mono text-[10px] leading-relaxed text-ink-faint">
            Everything your address earns, across all baskets: interface fees on referred trades, launcher
            fees on referred launches, creator fees where a basket&rsquo;s payout address is yours, and any
            other fee tag pointing at you. Fixed protocol slices redirected to you, never an added fee.
            {total > 0 && total < 1 ? ' Small balances may cost more in gas to claim than they’re worth — let them build up.' : ''}
            {ca.skippedOtherChain > 0 && !ca.running ? ` ${ca.skippedOtherChain} on another network — switch to claim those.` : ''}
            {ca.error && !ca.running ? ` ${ca.error}` : ''}
            {chainsFailed > 0 ? ` ${chainsFailed} network${chainsFailed === 1 ? '' : 's'} unavailable right now — the total may be missing accruals there.` : ''}
            {' '}This total is fee-TAG income only — fees your address earns because a trade, launch or
            basket points at it. Fees you earn as a HOLDER accrue per token to each basket&rsquo;s own
            reserve and are claimed per basket; they are listed separately below.
            {/* THE LEAGUE IS ROBINHOOD-ONLY (the owner ruled 2026-08-04, relayed by
                SpectrumContracts): mainline src carries ZERO league references, so
                on Base/Ethereum a creator earns their creator share and NOTHING
                from a league. This sentence promised crown income on every chain —
                the dishonest-copy class. Said only where a league pool exists. */}
            {ANY_LEAGUE_CHAIN && (
              <>
                {' '}Crown earnings from the creator league are separate and withdrawable any time,
                also below.
              </>
            )}
          </p>
        </section>

        {/* Holder fees — a DIFFERENT pot from the fee-tag total above: the
            holder share accrues per token to each basket's reserve beside NAV,
            so it never appears in pendingFrontendFees. It was visible only on
            the Token holdings card and the Portfolio summary, which made this
            page's "everything your address earns" line untrue for anyone
            holding a basket (owner 2026-08-01: "the claim page isnt correctly
            showing all fees accured, there definitely is fees on the wallet im
            connected to for holder fees"). Same query keys as those two
            surfaces, so it re-reads nothing. Self-hides with no claim. */}
        <PortfolioClaims baskets={heldBaskets} holderOnly />

        {/* crown winnings — a won season is real money that lived only on
            /league before (owner 2026-07-30); self-hides until one exists */}
        <CrownWinnings />

        {/* ── TWO WAYS TO EARN — just the numbers (owner 21:49) ──────────── */}
        <section>
          <h2 className="text-center font-display text-4xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-5xl">
            Two ways to earn
          </h2>
          <div className="mt-9 grid gap-5 md:grid-cols-2">
            <div className="relative flex flex-col overflow-hidden rounded-3xl border border-white/[0.12] bg-white/[0.02] p-8 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,var(--color-cyan),transparent)' }} />
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan">Refer a buyer</div>
              {/* "of the FEES" — the slice is ~5% of each trade's fee, not of the
                  trade; the old tile overstated ~33-100× (audit, owner rule) */}
              <div className="mt-3 font-display text-6xl font-bold leading-none tracking-tight text-ink">~5%</div>
              <div className="mt-3 font-display text-lg font-bold uppercase tracking-tight text-ink">of the fees on every trade they make</div>
              <button type="button" onClick={() => setModal('buyer')} className="press mx-auto mt-6 rounded-full border border-white/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim hover:border-cyan/50 hover:text-cyan">
                How it works
              </button>
            </div>
            <div className="relative flex flex-col overflow-hidden rounded-3xl border border-white/[0.12] bg-white/[0.02] p-8 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,var(--color-magenta),transparent)' }} />
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-magenta">Refer a creator</div>
              <div className="mt-3 font-display text-6xl font-bold leading-none tracking-tight text-ink">~5%</div>
              <div className="mt-3 font-display text-lg font-bold uppercase tracking-tight text-ink">of their basket&rsquo;s fees, forever</div>
              <button type="button" onClick={() => setModal('creator')} className="press mx-auto mt-6 rounded-full border border-white/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim hover:border-magenta/60 hover:text-magenta">
                How it works
              </button>
            </div>
          </div>
          <div className="mt-6 text-center">
            <button type="button" onClick={() => setModal('spectrum')} className="press inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim hover:border-white/30 hover:text-ink">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-violet" />
              How Spectrum works
            </button>
          </div>
        </section>

        {/* ── WHY ───────────────────────────────────────────────────────── */}
        <section className="grid gap-4 sm:grid-cols-3">
          {[
            { t: 'Paid onchain, in USDC', d: 'The fee slice accrues to your address on the contract itself, not an IOU on our books.' },
            { t: 'No signup, permissionless', d: 'Your wallet is your account. Share a link, that’s it. Nobody approves you.' },
            { t: 'Claim anytime', d: 'Your accrued fees are yours to pull whenever you like, right below.' },
          ].map((c) => (
            <div key={c.t} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="font-display text-base font-bold uppercase tracking-tight text-ink">{c.t}</div>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{c.d}</p>
            </div>
          ))}
        </section>

      </div>

      {modal === 'buyer' && (
        <RefModal title="Refer a buyer" onClose={() => setModal(null)}>
          <div className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-5">
            <FlowSteps
              tint="var(--color-cyan)"
              steps={[
                { icon: LinkIcon, label: 'You share your link' },
                { icon: SwapIcon, label: 'They trade a basket' },
                { icon: CoinIcon, label: 'You earn ~5% of the fee' },
              ]}
            />
          </div>
          <div className="mt-5 space-y-2.5 text-sm leading-relaxed text-ink-dim">
            <p>
              Anyone who lands on Spectrum through your link is tagged to you. On every buy or sell
              they make, the protocol routes its <span className="text-ink">interface slice — about
              5% of the trade&rsquo;s fee</span> — to your address.
            </p>
            <p>
              It settles onchain in USDC as they trade, and you claim it here anytime. It&rsquo;s a
              fixed slice of the existing fee redirected to you, not an extra charge to the trader.
            </p>
          </div>
        </RefModal>
      )}

      {modal === 'creator' && (
        <RefModal title="Refer a creator" onClose={() => setModal(null)}>
          <div className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-5">
            <FlowSteps
              tint="var(--color-magenta)"
              steps={[
                { icon: LinkIcon, label: 'You share your link' },
                { icon: LaunchIcon, label: 'They launch a basket' },
                { icon: CoinIcon, label: 'You earn ~5% of its fees, forever' },
              ]}
            />
          </div>
          <div className="mt-5 space-y-2.5 text-sm leading-relaxed text-ink-dim">
            <p>
              When someone launches a basket after arriving through your link, you&rsquo;re set as its
              <span className="text-ink"> launcher</span> — earning about 5% of that basket&rsquo;s fees
              for as long as it trades. It&rsquo;s written into the basket at deploy and is permanent.
            </p>
            <p>
              The creator sees it disclosed at the deploy step, so it&rsquo;s never a surprise — it&rsquo;s a
              fixed protocol slice that comes with launching through your link, claimed here.
            </p>
          </div>
        </RefModal>
      )}

      {modal === 'spectrum' && (
        <RefModal title="How Spectrum works" onClose={() => setModal(null)}>
          <div className="mt-4">
            <ConceptReveal />
          </div>
          <p className="mt-4 text-center text-sm leading-relaxed text-ink-dim">
            Buy or sell the whole basket in one swap. A small fee on each trade is split across the
            creator, holders, a burn, and the interface — the slices your referrals earn from.
          </p>
        </RefModal>
      )}
    </div>
  )
}
