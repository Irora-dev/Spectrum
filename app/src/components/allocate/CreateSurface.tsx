import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useAccount } from 'wagmi'
import { PortfolioFlow, type Station } from './PortfolioFlow'
import { channelExecutable,
  adoptGuestDraft,
  GUEST_SCOPE,
  loadExec,
  type ExecutionChannel,
  type ExecutionPlan,
  type FlowIntent,
} from '../../lib/spectrum/allocation'

// ─────────────────────────────────────────────────────────────────────────────
// THE CREATE SURFACE — picker-first Create as ONE implementation with N mounts
// (/create the page, Home embedded below its hero — the owner approved Home = hero
// + picker, 2026-08-01). Owns every money-adjacent beat: the guest scope,
// draft adoption across the connect, the resume of a mid-run build, and the
// connect-when-money-enters moment. Hosts supply (or suppress) the masthead;
// nothing else may fork per mount — one implementation, or the beats drift.
// ─────────────────────────────────────────────────────────────────────────────

const fixtureMode = import.meta.env.VITE_DEV_FIXTURE === '1'
const SIM_WALLET = '0x000000000000000000000000000000000000d0e0'
/** The fixture wallet's demo value (the amount chips' reference). */
const DEMO_WALLET_USD = 4826.19

export function CreateSurface({
  embedded = false,
  chromeless = false,
  masthead,
  intent,
  channel,
  at,
  onDone,
  onStation,
}: {
  /** Embedded in a host page that already has a hero (Home): no masthead of
   *  its own, the connecting notice renders inline, no negative pull. */
  embedded?: boolean
  /** Mounted inside a host PANEL that already supplies the card and the
   *  wayfinding (the rebalance popup): no card of our own, no station rail. */
  chromeless?: boolean
  /** The page mount's hero — receives the connecting state so the notice can
   *  live inside it. */
  masthead?: (connecting: boolean) => ReactNode
  /** Entry intent from a HOST MOUNT rather than the URL. The positions mode
   *  hands its composed plan into the review inside its own popup — there is
   *  no navigation, so there are no query params to read. Props win; the page
   *  mount passes none and reads ?door=/?channel=/?at= exactly as before.
   *  Same URL-intent law either way: intent only, never a computed plan. */
  intent?: FlowIntent
  channel?: ExecutionChannel
  at?: Station
  /** The user pressed the finale's "See your portfolio" — the host decides
   *  what that means. Unhosted, it does what it says: goes to the portfolio
   *  (owner 17:53: "when you click see your portfolio it should obviously go
   *  back to your portfolio"; it previously went nowhere). */
  onDone?: () => void
  /** Which station the flow is on, for hosts that wrap it. */
  onStation?: (s: Station) => void
}) {
  const navigate = useNavigate()
  const { address, isConnected } = useAccount()
  const [simAddress, setSimAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [resumeStation, setResumeStation] = useState<Station | undefined>(undefined)

  const effective = isConnected && address ? address : simAddress
  const scope = effective ?? GUEST_SCOPE

  // The guest's picks follow them through the connect (picker-first law).
  // ADOPTION MUST BEAT THE REMOUNT: the flow's key includes the scope, so the
  // instant `effective` flips the child remounts and reads its draft AT
  // RENDER TIME — an effect here runs after that read, and a guest hitting
  // Confirm resumed into `execute` compiling an EMPTY draft (0/0 steps; bit
  // the picker's publish path 2026-08-03). Adopting inline during render is
  // idempotent, storage-only and guarded to once per address — correctness at
  // the trust boundary over purity.
  const adoptedFor = useRef<string | null>(null)
  if (effective && adoptedFor.current !== effective) {
    adoptedFor.current = effective
    adoptGuestDraft(effective)
  }

  // The flow calls this when a guest hits Confirm — the one moment a wallet
  // matters. After the connect the flow remounts in the wallet's scope at the
  // station it asked to resume on.
  const onNeedConnect = (resumeAt: Station) => {
    setResumeStation(resumeAt)
    if (fixtureMode) {
      setConnecting(true)
      window.setTimeout(() => {
        setSimAddress(SIM_WALLET)
        setConnecting(false)
      }, 900)
    } else {
      window.dispatchEvent(new Event('spectrum:connect'))
    }
  }

  // ?door=keep|publish — entry surfaces that already know the intent (a
  // basket page's CTA, a landing panel) skip the outcome station entirely.
  const [params] = useSearchParams()
  const doorParam = params.get('door')
  const initialIntent: FlowIntent | undefined =
    intent ?? (doorParam === 'keep' || doorParam === 'publish' ? doorParam : undefined)
  // ?channel=market|limit|slices — the blend's preset entries (URL-intent:
  // intent only, unknown values ignored, never a computed plan). NON-EXECUTABLE
  // channels are also ignored AT ENTRY: the review renders them selected-but-
  // disabled while execute runs the market batch regardless, so a URL preset
  // of limit/slices produced a confirm labeled one thing doing another — the
  // exact dead-confirm the blend doctrine forbids. The cards themselves are
  // disabled, so the URL was the only path into that state.
  const channelParam = params.get('channel')
  const known: ExecutionChannel | undefined =
    channel ??
    (channelParam === 'market' || channelParam === 'limit' || channelParam === 'slices' ? channelParam : undefined)
  const initialChannel: ExecutionChannel | undefined = known && channelExecutable(known) ? known : undefined
  // ?at=review — a surface that already composed a plan (the positions mode)
  // hands off TO the review station rather than dumping the user on the
  // picker (the owner 16:22: "it needs to go to the next page… it's just broken").
  // URL-INTENT law: intent only, unknown values ignored, never a computed plan.
  const atParam = params.get('at')
  const initialAt: Station | undefined = at ?? (atParam === 'review' ? 'review' : atParam === 'weight' ? 'weight' : undefined)

  // A mid-run build resumes exactly where it stopped.
  const pending: ExecutionPlan | null = useMemo(() => {
    const p = loadExec(scope)
    return p && p.status === 'running' ? p : null
  }, [scope])

  // Remount the flow when the scope changes (guest → wallet) so it re-reads
  // the adopted draft; carry the resume station through.
  //
  // ⚠ THE REF-COUNTER KEY WAS A REMOUNT LANDMINE (the owner, three live reports
  // 2026-08-14 — "I click Execute, nothing happens… click again, it works" +
  // "Run for real does nothing", surviving every reload and every handler
  // fix). `flowKey.current += 1` inside an effect changes NO state, so the
  // bump sat ARMED until the next parent re-render evaluated the key — and
  // the flow's own onStation callback (setOnReview in PositionsMode) IS a
  // parent re-render, so pressing Execute detonated it: the whole flow
  // REMOUNTED back to its initial station, visually undoing the click. Worse,
  // any parent re-render during a live run (a query refetch, the popup's
  // sizing pass) remounted mid-run and orphaned the runner's promise — the
  // "nothing happens at all" report, with zero console errors by
  // construction. The scope belongs IN the key (that is the remount-on-adopt
  // behavior the ref was simulating); the counter is deleted.

  return (
    <div className={embedded ? '' : 'pb-6'}>
      {!embedded && masthead?.(connecting)}
      {embedded && connecting && (
        <p className="mb-4 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
          {fixtureMode ? 'connecting — simulated wallet, no signature' : 'connecting…'}
        </p>
      )}

      {/* THE FLOW, live from the first pixel — no doors before it, no wallet
          before it. The outcome question waits inside, after the weights. */}
      {/* THE FLOW SITS UP UNDER ITS TITLE (owner 2026-08-06 23:13, desktop AND
          mobile: "there's tons of space between 'buy assets across chains in a
          single flow' and the actual simulation and the choose/weight/outcome —
          that needs to be reduced, we move everything up so it's closer to the
          title, massively closer"). The masthead is a 56svh hero and the pull
          was a flat 192px, so the taller the viewport the bigger the dead band
          under the headline. A viewport-relative pull tracks the hero it is
          pulling against instead of guessing at it. */}
      {/* Owner 2026-08-07: "reduce the gap between the title and the card".
          Measuring it first showed the flat-svh pull was the WRONG SHAPE, not
          merely too small: the title sits at a FIXED offset while both the
          hero (56svh) and the pull were viewport-relative, so the gap was
          0.32×vh − 178 — 110px at 900 tall, 174px at 1100, and a NEGATIVE
          −10px (title/card collision) at 700. Tuning the number would have
          fixed one viewport and broken another.
          Pulling by `56svh − K` cancels the hero's own svh term, so the gap is
          the constant K − (title bottom) at EVERY viewport height. K is per
          breakpoint only because the headline wraps to three lines on a phone
          and two above sm. Verified 700/900/1200 tall. */}
      <div className={embedded ? 'relative z-10' : 'relative z-10 -mt-[calc(56svh-217px)] sm:-mt-[calc(56svh-194px)]'}>
        <PortfolioFlow
          key={`${scope}:${resumeStation ?? initialAt ?? ''}`}
          inline
          chromeless={chromeless}
          address={scope}
          walletUsd={fixtureMode && effective ? DEMO_WALLET_USD : null}
          onClose={() => undefined}
          onCreated={() => {
            setResumeStation(undefined)
            if (onDone) onDone()
            else navigate('/portfolio')
          }}
          onStation={onStation}
          resumePlan={pending}
          initialIntent={initialIntent}
          initialChannel={initialChannel}
          initialStation={resumeStation ?? initialAt}
          onNeedConnect={onNeedConnect}
        />
      </div>
    </div>
  )
}
