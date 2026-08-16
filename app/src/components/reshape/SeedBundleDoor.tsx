import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { SWAP_ENABLED } from '../../lib/config/features'
import {
  readPayAssetOptions,
  setThesisPayChoice,
  thesisPayChoice,
  thesisPayKey,
  type PayAssetOption,
} from '../../lib/spectrum/thesis-pay-asset'
import { PayAssetPicker } from '../thesis/PayAssetPicker'
import { ThesisRunOverlay } from '../thesis/ThesisRunOverlay'
import { chainLabel, settlementLabel } from '../thesis/run-lanes'
import { seedThesisOf, type SeedPlan } from './seed-plan'

// ─────────────────────────────────────────────────────────────────────────────
// THE SEED DOOR — the ceremonies' primary next act (owner 2026-08-12: after a
// publish or reshape each new version starts EMPTY; the first buy opens it,
// and the creator seeds the whole bundle straight from the success plate,
// through the existing routing/bridging run). This component is only the door
// and the stake: the run overlay behind it is the ONE cross-chain buy machine
// the bundle page already mounts — same lanes, same bridges, same refusals —
// handed the deploy weights as its split (seedShares), because a fresh bundle
// has no AUM to split by.
//
// LAWS (seed-plan.ts holds the tested halves): zero seedable legs = the caller
// renders nothing (never a dead button); an excluded lane is NAMED under the
// door; demo mounts the overlay in walkthrough mode — the run machine's own
// demo path arms nothing.
//
// While the overlay is up the ceremony must not close underneath it (both
// listen to window Escape) — `onOverlayChange` is the ceremony's cue to stand
// its close handler down.
// ─────────────────────────────────────────────────────────────────────────────

/** The walkthrough's prefilled stake — the run overlay's own demo number. */
const DEMO_STAKE = '500'

export function SeedBundleDoor({
  plan,
  name,
  deployer,
  demo = false,
  accent,
  gradient,
  textClass,
  onOverlayChange,
}: {
  plan: SeedPlan
  /** The shipped bundle name — the run's identity. */
  name: string
  /** The creator the seeded thesis belongs to. */
  deployer: string
  /** Walkthrough mode: the overlay mounts as the scripted demo, nothing arms. */
  demo?: boolean
  /** The ceremony's accent — the overlay glows in the ceremony's own colour. */
  accent: string
  /** The door's background — each ceremony's own gradient idiom. */
  gradient: string
  /** Text colour class matching that gradient (`text-black` / `text-void`). */
  textClass: string
  /** Fired when the run overlay opens/closes — the ceremony stands down its
   *  own Escape/backdrop close while the run is up. */
  onOverlayChange?: (open: boolean) => void
}) {
  const [stake, setStake] = useState(() => (demo ? DEMO_STAKE : ''))
  const [open, setOpen] = useState(false)
  const inputId = useId()

  const seed = useMemo(() => seedThesisOf(plan, name, deployer), [plan, name, deployer])
  const cents = useMemo(() => {
    const v = parseFloat(stake)
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0
  }, [stake])

  // ── the pay-source door (owner 2026-08-15, live: "i obviously want to see it
  // use the gas bridging system we have" — his seed wallet held only native ETH,
  // every leg refused "Needs $X more", and this ceremony offered NO way through,
  // while the thesis console's picker existed one page away). The door hosts the
  // SAME picker the console mounts; the choice travels to the overlay through
  // the leg-set-keyed session store (thesis-pay-asset.ts), so the overlay reads
  // it with no new plumbing. On a pick the overlay reopens and the run rebuilds
  // with the conversion sales composed first — same laws, same components.
  const { address } = useAccount()
  const legs = seed?.thesis.legs ?? []
  const payKey = useMemo(() => thesisPayKey(legs.map((l) => ({ chainId: l.chainId, address: l.address }))), [legs])
  const [pay, setPay] = useState<PayAssetOption | null>(() => thesisPayChoice(payKey))
  const [payOpen, setPayOpen] = useState(false)
  const chainIds = useMemo(() => legs.map((l) => l.chainId), [legs])
  const settlementWords = useMemo(
    () => [...new Set(chainIds.map((id) => settlementLabel(id)))].join(' · '),
    [chainIds],
  )
  const { data: payOptions, isLoading: payLoading } = useQuery({
    queryKey: ['seed-pay-options', address, [...chainIds].sort().join(',')],
    queryFn: () => readPayAssetOptions(chainIds, address as Address),
    enabled: SWAP_ENABLED && !demo && !!address && chainIds.length > 0,
    staleTime: 30_000,
  })
  const pickPay = (opt: PayAssetOption | null) => {
    setPay(opt)
    setThesisPayChoice(payKey, opt)
    setPayOpen(false)
    // resume where the refusal interrupted: the stake still stands, the run
    // rebuilds on mount and now reads the stored pay choice
    if (cents > 0 || demo) setOpen(true)
  }
  // A wallet switch invalidates the choice — another account's holdings are
  // not this one's (the console's own guard, same reason; the ref-compare
  // keeps a store-restored pick alive on mount).
  const prevAddr = useRef(address)
  useEffect(() => {
    if (prevAddr.current === address) return
    prevAddr.current = address
    if (thesisPayChoice(payKey) != null) setThesisPayChoice(payKey, null)
    setPay(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  useEffect(() => {
    // the ceremony stands its close handler down while EITHER surface is up —
    // the picker is part of the run, not a detour the ceremony may close over
    onOverlayChange?.(open || payOpen)
    return () => onOverlayChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payOpen])

  // Zero seedable legs = no door, by law — the plate's own rows already say
  // what happened per network.
  if (!seed) return null

  const n = plan.legs.length
  const armed = demo || cents > 0

  return (
    <div className="mt-5 border-t border-white/8 pt-4">
      {/* the seed imperative, said at size (the owner live 2026-08-15: combine
          the two facts, two aligned lines, bigger — people must know the
          first buy is the safety step) */}
      <label htmlFor={inputId} className="block text-center">
        <span className="block font-display text-lg font-bold uppercase tracking-tight text-ink">
          Seed it now — the first buy locks your baskets safe
        </span>
        <span className="mt-1 block font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          one stake, split across the networks · empty baskets stay claimable until seeded
        </span>
      </label>
      <div className="mt-3 flex h-12 items-center rounded-xl border border-white/12 bg-black/30 px-3.5 focus-within:border-white/30">
        <span aria-hidden className="font-num text-base text-ink-dim">
          $
        </span>
        <input
          id={inputId}
          value={stake}
          onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          aria-label="Stake to seed the bundle, in dollars"
          placeholder={DEMO_STAKE}
          className="min-w-0 flex-1 bg-transparent py-2.5 pl-1.5 font-num text-base tabular-nums text-ink outline-none placeholder:text-ink-faint"
        />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          across {n} {n === 1 ? 'network' : 'networks'}
        </span>
      </div>
      <button
        type="button"
        disabled={!armed}
        onClick={() => setOpen(true)}
        className={`press mt-3 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[13px] font-bold uppercase tracking-[0.14em] transition-transform enabled:hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 ${textClass}`}
        style={{ background: gradient }}
      >
        Seed the bundle
      </button>
      {!armed && (
        <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          put in a stake first · the run needs to know how much to split
        </p>
      )}
      {plan.excluded.map((chainId) => (
        <p key={chainId} className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 font-mono text-[10px] leading-relaxed text-amber-200/90">
          {chainLabel(chainId)}&rsquo;s address couldn&rsquo;t be read back — seed it from its own page once it appears.
        </p>
      ))}
      {open && (
        <ThesisRunOverlay
          thesis={seed.thesis}
          accent={accent}
          mode={demo ? 'demo' : 'buy'}
          amountCents={cents}
          seedShares={seed.seedShares}
          onClose={() => setOpen(false)}
          onOfferPayAsset={() => setPayOpen(true)}
        />
      )}
      {payOpen && (
        <PayAssetPicker
          options={payOptions ?? null}
          loading={payLoading}
          current={pay}
          spendableCents={null}
          networks={plan.legs.length}
          settlementWords={settlementWords}
          demo={demo}
          onPick={pickPay}
          onClose={() => setPayOpen(false)}
        />
      )}
    </div>
  )
}
