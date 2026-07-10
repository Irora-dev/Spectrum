import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { versionChain } from '../lib/spectrum/leaderboard'
import { PROTOCOL_FEE_MODEL, feeSplit } from '../lib/spectrum/fee-model'
import { formatUsdCompact } from '../lib/spectrum/format'
import { usePrefersReducedMotion, useInViewOnce } from '../lib/motion'
import { ConceptOrbit } from '../components/ConceptReveal'
import { BasketListRow } from '../components/BasketListRow'
import { BasketBento } from '../components/BasketBento'
import { BasketAvatar } from '../components/BasketAvatar'
import { AssetLogo } from '../components/AssetLogo'
import { WeightStrip } from '../components/launch/WeightStrip'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { WarpIdentity } from '../components/WarpIdentity'

// ─────────────────────────────────────────────────────────────────────────────
// "Slash Creators" — the /creators route: a marketing + onboarding funnel for
// KOLs / creators that ends in the real launch flow, embedded inline. Assembled
// from the site's own premium parts so it reads as one object with the app AND
// stays in lockstep with the launch page.
//
// COUNSEL-GATED (fee framing): the earnings language is external-facing marketing
// about fee economics. Every fee number derives from PROTOCOL_FEE_MODEL / feeSplit
// (never hand-typed), honest-first. Still needs an R/counsel pass before publish.
// ─────────────────────────────────────────────────────────────────────────────

// Same component /launch renders, so any launch-flow change shows up here too.
const BasketBuilder = lazy(() =>
  import('../components/launch/BasketBuilder').then((m) => ({ default: m.BasketBuilder })),
)
// The Composer, embedded above the launch section (owner 19:15) — backtest +
// compose a mix here, then launch it just below. `embedded` drops its masthead.
const Composer = lazy(() => import('./Composer').then((m) => ({ default: m.Composer })))

const MIN_FEE_PCT = PROTOCOL_FEE_MODEL.MIN_BASKET_FEE_BPS / 100 // 1.00
const MAX_FEE_PCT = PROTOCOL_FEE_MODEL.MAX_BASKET_FEE_BPS / 100 // 3.00
const MAX_CREATOR_PCT = PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS / 100 // 30

const SPLIT = feeSplit(PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS, { hasInterface: true, hasLauncher: true })
const pct = (frac: number) => Math.round(frac * 100)

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

const FEE_SINKS: { key: string; legend: string; short: string; frac: number; bg: string; text: string; dot: string }[] = [
  { key: 'creator', legend: 'You', short: 'You', frac: SPLIT.creator, bg: 'linear-gradient(135deg,var(--color-cyan),var(--color-violet))', text: '#04040a', dot: 'var(--color-cyan)' },
  { key: 'holders', legend: 'Basket holders', short: 'Holders', frac: SPLIT.holders, bg: '#8b7bff', text: '#04040a', dot: '#8b7bff' },
  { key: 'burn', legend: 'PRISM burn', short: 'Burn', frac: SPLIT.burn, bg: 'var(--color-magenta)', text: '#04040a', dot: 'var(--color-magenta)' },
  { key: 'interface', legend: 'Interface', short: '', frac: SPLIT.interface, bg: '#3b3b52', text: 'var(--color-ink-dim)', dot: '#6b6b8e' },
  { key: 'launcher', legend: 'Launchpad', short: '', frac: SPLIT.launcher, bg: '#2c2c3e', text: 'var(--color-ink-faint)', dot: '#4a4a63' },
]

// An illustrative basket (real Base tokens, illustrative weights) — six assets so
// the interactive weight strip reads cleanly. No fabricated market data.
const EXAMPLE = {
  symbol: 'AGENTS',
  name: 'AI Agents',
  address: '0xA6E4750000000000000000000000000000000000',
  chainId: 8453,
  thesis: 'One token for the whole AI-agent sector on Base: the infra, the launchpads, the flagship agents.',
  items: [
    { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', weightPct: 20 },
    { symbol: 'VVV', address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', weightPct: 15 },
    { symbol: 'AEON', address: '0xbf8e8f0e8866a7052f948c16508644347c57aba3', weightPct: 18 },
    { symbol: 'REI', address: '0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd', weightPct: 17 },
    { symbol: 'BNKR', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', weightPct: 16 },
    { symbol: 'POD', address: '0xed664536023d8e4b1640c394777d34abaff1df8f', weightPct: 14 },
  ],
}
const EXAMPLE_SIG = basketSignatureColor(EXAMPLE.address, EXAMPLE.items[0])
const EXAMPLE_PALETTE = [EXAMPLE_SIG, ...EXAMPLE.items.slice(0, 3).map((i) => tokenVisual(i.symbol, i.address).color)]
const REVEAL_ITEMS = EXAMPLE.items.map((i) => ({ ...i, chainId: EXAMPLE.chainId }))

// An illustrative v1 → v2 change (owner 2026-07-06 17:30: nothing removed — a token
// is ADDED, with a couple of reweights to make room).
const VERSION_KIND: Record<'added' | 'reweighted', { label: string; color: string }> = {
  added: { label: 'Added', color: 'var(--color-teal)' },
  reweighted: { label: 'Reweighted', color: 'var(--color-amber)' },
}
const VERSION_DIFF: { symbol: string; address: string; chainId: number; kind: 'added' | 'reweighted'; from: number | null; to: number }[] = [
  { symbol: 'SURPLUS', address: '0xc52aedec3374422d7510e294cfaa90799595cba3', chainId: 8453, kind: 'added', from: null, to: 10 },
  { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', chainId: 8453, kind: 'reweighted', from: 25, to: 20 },
  { symbol: 'VVV', address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', chainId: 8453, kind: 'reweighted', from: 20, to: 15 },
]
const WT_MAX = 25
// The FULL composition of each version, so v1 shows its base basket (owner 18:05:
// "the V1 still needs to show assets"); v2 = v1 + SURPLUS added, VIRTUAL/VVV down.
const V1_ITEMS = [
  { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', weightPct: 25, chainId: 8453 },
  { symbol: 'VVV', address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', weightPct: 20, chainId: 8453 },
  { symbol: 'AEON', address: '0xbf8e8f0e8866a7052f948c16508644347c57aba3', weightPct: 18, chainId: 8453 },
  { symbol: 'REI', address: '0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd', weightPct: 17, chainId: 8453 },
  { symbol: 'BNKR', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', weightPct: 12, chainId: 8453 },
  { symbol: 'POD', address: '0xed664536023d8e4b1640c394777d34abaff1df8f', weightPct: 8, chainId: 8453 },
]
const V2_ITEMS = [
  { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', weightPct: 20, chainId: 8453 },
  { symbol: 'VVV', address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', weightPct: 15, chainId: 8453 },
  { symbol: 'AEON', address: '0xbf8e8f0e8866a7052f948c16508644347c57aba3', weightPct: 18, chainId: 8453 },
  { symbol: 'REI', address: '0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd', weightPct: 17, chainId: 8453 },
  { symbol: 'BNKR', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', weightPct: 12, chainId: 8453 },
  { symbol: 'POD', address: '0xed664536023d8e4b1640c394777d34abaff1df8f', weightPct: 8, chainId: 8453 },
  { symbol: 'SURPLUS', address: '0xc52aedec3374422d7510e294cfaa90799595cba3', weightPct: 10, chainId: 8453 },
]

// ── small building blocks ────────────────────────────────────────────────────

function Section({ eyebrow, eyebrowClass = 'text-xs', title, intro, introClass = 'max-w-2xl', children, id, titleClass = 'text-3xl sm:text-4xl' }: {
  eyebrow?: string
  eyebrowClass?: string
  title: ReactNode
  intro?: ReactNode
  introClass?: string
  children?: ReactNode
  id?: string
  titleClass?: string
}) {
  return (
    <section id={id} className="mx-auto max-w-5xl scroll-mt-20">
      <div className="enter" style={{ '--enter-i': 0 } as CSSProperties}>
        {eyebrow && <div className={`font-mono uppercase tracking-[0.3em] text-ink-faint ${eyebrowClass}`}>{eyebrow}</div>}
        <h2 className={`mt-3 font-display font-bold uppercase leading-[0.95] tracking-tight text-ink ${titleClass}`}>{title}</h2>
        {intro && <p className={`mt-4 text-pretty text-base leading-snug text-ink-dim ${introClass}`}>{intro}</p>}
      </div>
      {children}
    </section>
  )
}

// The hued square basket "logo" — a bento-style tile with an animated hue.
function HuedSquareLogo({ size = 76 }: { size?: number }) {
  return (
    <div className="relative shrink-0 overflow-hidden rounded-2xl ring-1 ring-white/20" style={{ width: size, height: size, background: `linear-gradient(135deg, ${EXAMPLE_SIG}, color-mix(in srgb, ${EXAMPLE_SIG} 55%, #000))`, boxShadow: `0 0 40px -8px ${EXAMPLE_SIG}` }}>
      <div aria-hidden className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0) 36%, rgba(0,0,0,0.2))' }} />
      <div aria-hidden className="bento-sheen absolute inset-0" style={{ backgroundImage: 'linear-gradient(115deg, transparent 44%, rgba(255,255,255,0.22) 50%, transparent 56%)', animationDuration: '6s' }} />
      <div className="absolute inset-0 grid place-items-center">
        <svg viewBox="0 0 24 24" style={{ width: size * 0.42, height: size * 0.42 }} className="text-black/85" fill="currentColor"><path d="M12 2l9 9-9 9-9-9 9-9z" /></svg>
      </div>
    </div>
  )
}

// The example basket: an INTERACTIVE demo — drag the launch page's own WeightStrip
// and the bento reflows live. A "launch your own" button jumps to the builder.
function ExampleBasket() {
  const sig = EXAMPLE_SIG
  const [weights, setWeights] = useState<number[]>(EXAMPLE.items.map((i) => i.weightPct))
  const assets = EXAMPLE.items.map((i) => ({ symbol: i.symbol, address: i.address }))
  const bentoItems = EXAMPLE.items.map((i, idx) => ({ symbol: i.symbol, address: i.address, weightPct: weights[idx], chainId: EXAMPLE.chainId }))
  const onResize = (k: number, a: number, b: number) =>
    setWeights((w) => {
      const n = [...w]
      n[k] = a
      n[k + 1] = b
      return n
    })
  return (
    <div className="relative mx-auto max-w-5xl">
      <div aria-hidden className="pointer-events-none absolute -inset-x-8 -top-10 bottom-0 opacity-25 blur-3xl" style={{ background: `radial-gradient(55% 60% at 50% 0%, ${sig}, transparent 72%)` }} />
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.14] bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] backdrop-blur-md">
        <div aria-hidden className="h-1.5 w-full" style={{ background: sig }} />
        <div className="grid gap-8 p-6 sm:p-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-4">
              <BasketAvatar address={EXAMPLE.address} symbol={EXAMPLE.symbol} size={76} />
              <div className="min-w-0">
                <div className="font-display text-4xl font-bold leading-none text-ink">${EXAMPLE.symbol}</div>
                <div className="mt-2 text-lg text-ink-dim">{EXAMPLE.name}</div>
              </div>
            </div>
            <p className="text-[15px] leading-relaxed text-ink-dim">{EXAMPLE.thesis}</p>
            <div className="mt-auto space-y-2.5">
              <div className="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.14em] text-ink-dim">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-cyan" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3" /></svg>
                Drag to reweight
              </div>
              <WeightStrip assets={assets} weights={weights} min={3} chainId={EXAMPLE.chainId} onResize={onResize} />
            </div>
          </div>
          <div className="flex items-center">
            <BasketBento items={bentoItems} aspect={1.35} expandable className="w-full" />
          </div>
        </div>
        <a href="#launch" className="group flex items-center justify-center gap-2 border-t border-white/10 bg-white/[0.02] py-4 font-display text-sm font-bold uppercase tracking-[0.16em] text-ink transition-colors hover:bg-white/[0.05]">
          <span className="bg-clip-text text-transparent" style={{ backgroundImage: GRADIENT }}>Launch your own basket</span>
          <span aria-hidden className="text-cyan transition-transform group-hover:translate-y-0.5">↓</span>
        </a>
      </div>
    </div>
  )
}

// The concept animation: logos SHOW + SPIN (~2s), then come together and vanish;
// then a DARK basket card reveals — the AI Agents logo + name FIRST, then the
// bento loads in a beat later (owner 17:30); holds a couple seconds, then replays.
function NarrativeConverge() {
  const reduced = usePrefersReducedMotion()
  const [cycle, setCycle] = useState(0)
  const [phase, setPhase] = useState<number>(reduced ? 3 : 0)
  useEffect(() => {
    if (reduced) return
    let alive = true
    const timers: number[] = []
    const at = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms))
    const run = () => {
      if (!alive) return
      setPhase(0) // show + spin
      at(() => setPhase(1), 2200) // come together + vanish
      at(() => setPhase(2), 3400) // card + logo/name reveal
      at(() => setPhase(3), 4200) // bento loads in
      at(() => {
        setCycle((c) => c + 1)
        run()
      }, 9200) // hold the full card ~5s, then reset + replay
    }
    run()
    return () => {
      alive = false
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [reduced])

  const converging = phase >= 1
  const showCard = phase >= 2
  const showBento = phase >= 3

  return (
    <div className="relative mx-auto my-6 flex min-h-[19rem] w-full max-w-xl items-center justify-center">
      <div aria-hidden className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl" style={{ background: `${EXAMPLE_SIG}2e` }} />
      {!reduced && !showCard && (
        <div key={cycle} className="absolute inset-0">
          <div className="absolute inset-0 animate-spin" style={{ animationDuration: '5s' }}>
            {EXAMPLE.items.map((a, i) => {
              const angle = (i / EXAMPLE.items.length) * 360
              return (
                <div key={a.address} className="absolute left-1/2 top-1/2 transition-all duration-[1100ms] ease-in" style={{ transform: `translate(-50%,-50%) rotate(${angle}deg) translateX(${converging ? 0 : 110}px)`, opacity: converging ? 0 : 1 }}>
                  <AssetLogo address={a.address} symbol={a.symbol} chainId={EXAMPLE.chainId} size={34} discColor={`color-mix(in srgb, ${tokenVisual(a.symbol, a.address).color} 55%, #000)`} />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {/* the reveal: a DARK basket card (logo + name first, then the bento loads) */}
      <div className={`w-full transition-all duration-700 ease-out ${showCard ? 'opacity-100 scale-100' : 'pointer-events-none scale-95 opacity-0'}`}>
        <div className="mx-auto max-w-xl overflow-hidden rounded-2xl border border-white/12 bg-void/95 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-md">
          <div aria-hidden className="h-1 w-full" style={{ background: GRADIENT }} />
          <div className="grid items-center gap-5 p-5 text-left sm:grid-cols-[1fr_1fr] sm:gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <HuedSquareLogo size={52} />
                <div className="min-w-0">
                  <div className="font-display text-2xl font-bold leading-none text-ink">${EXAMPLE.symbol}</div>
                  <div className="mt-1 text-sm text-ink-dim">{EXAMPLE.name}</div>
                </div>
              </div>
              <p className="text-[13px] leading-relaxed text-ink-dim">{EXAMPLE.thesis}</p>
            </div>
            <div className={`transition-all duration-700 ease-out ${showBento ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
              <BasketBento items={REVEAL_ITEMS} aspect={1.35} className="w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// v1 → v2 (owner 17:30): fires only when the card is well into view; shows v1
// first, then pops to v2 and the change rows animate in (a token added, reweights).
function VersionUpdateCard() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInViewOnce(ref, '0px 0px -30% 0px')
  const reduced = usePrefersReducedMotion()
  const [v2, setV2] = useState(reduced)
  useEffect(() => {
    if (reduced || !inView) return
    const t = window.setTimeout(() => setV2(true), 2400)
    return () => window.clearTimeout(t)
  }, [inView, reduced])

  const node = (label: string, active: boolean) => (
    <span className="grid h-8 w-8 place-items-center rounded-full border font-mono text-[11px] tabular-nums transition-all duration-700" style={active ? { color: 'var(--color-ink)', borderColor: EXAMPLE_SIG, background: `${EXAMPLE_SIG}1a`, boxShadow: `0 0 16px -2px ${EXAMPLE_SIG}` } : { color: 'var(--color-ink-faint)', borderColor: 'rgba(255,255,255,0.15)' }}>
      {label}
    </span>
  )

  return (
    <div ref={ref} className="card-surface mt-8 overflow-hidden rounded-2xl p-6 sm:p-8">
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          {node('v1', !v2)}
          <span aria-hidden className="h-px w-8 transition-all duration-700" style={{ background: v2 ? EXAMPLE_SIG : 'rgba(255,255,255,0.2)' }} />
          {node('v2', v2)}
        </div>
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim transition-opacity duration-500">
          {v2 ? 'You shipped version 2' : 'Version 1 is live…'}
        </div>
      </div>

      {/* the basket itself, v1 → v2 (crossfade): v1 shows its base composition,
          v2 shows the same basket with SURPLUS added */}
      <div className="relative mb-5 h-36 sm:h-40">
        <div className={`absolute inset-0 transition-opacity duration-700 ${v2 ? 'opacity-0' : 'opacity-100'}`}>
          <BasketBento items={V1_ITEMS} fill className="h-full w-full" />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-700 ${v2 ? 'opacity-100' : 'opacity-0'}`}>
          <BasketBento items={V2_ITEMS} fill className="h-full w-full" />
        </div>
      </div>

      <ul className="space-y-2">
        {VERSION_DIFF.map((c, i) => {
          const m = VERSION_KIND[c.kind]
          const fromW = c.from ?? 0
          const barW = ((v2 ? c.to : fromW) / WT_MAX) * 100
          return (
            <li key={c.address} className="relative overflow-hidden rounded-xl border border-white/8 py-2.5 pl-4 pr-4" style={{ background: `linear-gradient(90deg, ${m.color}14, ${m.color}05 40%, rgba(255,255,255,0.02) 80%)`, opacity: v2 ? 1 : 0, transform: v2 ? 'none' : 'translateY(8px)', transition: `opacity 0.5s ease ${i * 160}ms, transform 0.5s ease ${i * 160}ms` }}>
              <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: m.color }} />
              <div className="flex items-center gap-3">
                <AssetLogo address={c.address} symbol={c.symbol} chainId={c.chainId} size={28} />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="font-display text-base font-bold text-ink">{c.symbol}</span>
                  <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide" style={{ color: m.color, background: `${m.color}24` }}>{m.label}</span>
                </div>
                <div className="shrink-0 font-num text-base tabular-nums">
                  {c.kind === 'reweighted' ? (
                    <span className="flex items-center gap-2">
                      <span className="text-ink-faint">{fromW}%</span>
                      <span aria-hidden style={{ color: m.color }}>→</span>
                      <span className="font-semibold text-ink">{c.to}%</span>
                    </span>
                  ) : (
                    <span className="font-semibold" style={{ color: m.color }}>+{c.to}%</span>
                  )}
                </div>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full" style={{ width: `${barW}%`, background: m.color, transition: `width 1s cubic-bezier(0.16,1,0.3,1) ${300 + i * 160}ms` }} />
              </div>
            </li>
          )
        })}
      </ul>

      <p className="mt-5 border-t border-white/10 pt-4 text-sm leading-relaxed text-ink-dim">
        Each version is its own immutable basket. The original stays live and unchanged; holders move to the new
        version only if they choose to, and can always redeem the old.
      </p>
    </div>
  )
}

// A volume → earnings calculator (owner 18:05): a daily-volume slider that shows
// what the creator would earn (the priority) plus the other sinks. Honest-first
// and COUNSEL-GATED — labelled an illustration on hypothetical volume, not a
// projection or guarantee; every figure derives from the protocol split.
function VolumeCalculator() {
  const [volume, setVolume] = useState(50_000)
  const [feeBps, setFeeBps] = useState<number>(PROTOCOL_FEE_MODEL.MIN_BASKET_FEE_BPS)
  const feePool = volume * (feeBps / 10_000)
  const perDay = (frac: number) => feePool * frac
  const others = FEE_SINKS.filter((s) => s.key !== 'creator')
  return (
    <div className="card-surface mt-4 rounded-2xl p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="font-display text-lg font-bold uppercase tracking-tight text-ink">See what you&rsquo;d earn</div>
        <div className="flex gap-1.5">
          {[100, 200, 300].map((bps) => (
            <button
              key={bps}
              type="button"
              onClick={() => setFeeBps(bps)}
              className={`press rounded-full border px-3 py-1 font-num text-xs font-semibold tabular-nums transition-colors ${feeBps === bps ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-white/12 text-ink-dim hover:text-ink'}`}
            >
              {bps / 100}% fee
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">Daily trading volume</span>
          <span className="font-num text-2xl font-bold tabular-nums text-ink">{formatUsdCompact(volume)}</span>
        </div>
        <input
          type="range"
          min={1_000}
          max={1_000_000}
          step={1_000}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Daily trading volume"
          className="mt-3 w-full accent-cyan"
        />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-[1.15fr_1fr]">
        {/* the creator's take — the priority */}
        <div className="relative overflow-hidden rounded-xl border border-cyan/30 bg-cyan/[0.06] p-5">
          <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-cyan/20 blur-2xl" />
          <div className="relative">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Your fees · per day</div>
            <div className="mt-1 font-num text-4xl font-bold tabular-nums text-cyan">{formatUsdCompact(perDay(SPLIT.creator))}</div>
            <div className="mt-1 font-mono text-[11px] text-ink-dim">≈ {formatUsdCompact(perDay(SPLIT.creator) * 30)} / month</div>
          </div>
        </div>
        {/* the other sinks */}
        <div className="grid grid-cols-2 gap-2">
          {others.map((s) => (
            <div key={s.key} className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                <span className="truncate font-mono text-[9px] uppercase tracking-wide text-ink-faint">{s.legend}</span>
              </div>
              <div className="mt-1 font-num text-sm font-semibold tabular-nums text-ink-dim">{formatUsdCompact(perDay(s.frac))}<span className="text-ink-faint">/day</span></div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 font-mono text-[10px] leading-relaxed text-ink-faint">
        Estimate at a {feeBps / 100}% fee and the maximum {MAX_CREATOR_PCT}% creator share, on hypothetical daily
        volume. An illustration of the protocol split, not a projection or guarantee of earnings.
      </p>
    </div>
  )
}

// ── the page ─────────────────────────────────────────────────────────────────

export function SlashCreators() {
  const { data, isLoading, isError } = useAllBaskets()
  const heads = (data ?? []).filter((b) => !b.supersededBy)
  const showcase = heads.slice(0, 4)
  const [openPair, setOpenPair] = useState<number | null>(null)
  const chainOf = (b: (typeof heads)[number]) =>
    versionChain(b.address, (data ?? []).filter((x) => x.deployer && b.deployer && x.deployer.toLowerCase() === b.deployer!.toLowerCase()))

  return (
    <div className="pb-8">
      {/* ── HERO ─────────────────────────────────────────────────────────────── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[540px] w-[540px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/15 blur-[130px]" />
          <div className="absolute left-[18%] top-[26%] h-72 w-72 rounded-full bg-cyan/12 blur-[120px]" />
          <div className="absolute right-[16%] top-[44%] h-72 w-72 rounded-full bg-magenta/12 blur-[130px]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
          <ConceptOrbit showCore={false} logoSize={44} className="opacity-40 [--orbit-r:190px] sm:[--orbit-r:290px] lg:[--orbit-r:350px]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(125% 85% at 50% 42%, rgba(5,5,11,0.68) 0%, rgba(5,5,11,0.24) 46%, transparent 78%)' }} />
        <div className="relative z-10 mx-auto flex min-h-[58svh] max-w-4xl flex-col items-center justify-center px-4 pt-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-ink-dim backdrop-blur">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" />
            For creators, ecosystems &amp; KOLs
          </div>
          <h1 className="mt-7 font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl md:text-8xl">
            Turn your thesis
            <br />
            into a <span className="spectral-text">token</span>
          </h1>
          <p className="mt-7 max-w-2xl text-base leading-snug text-ink-dim sm:text-lg">
            Bundle your favorite tokens into one and earn on every trade.
          </p>
        </div>
      </section>

      <div className="-mt-[8svh]">
        <ExampleBasket />
      </div>

      <div className="mt-24 space-y-24">
        {/* ── ONE BUY, THE WHOLE NARRATIVE (white heading; spin → reveal) ─────── */}
        <section className="mx-auto max-w-5xl scroll-mt-20">
          <div className="relative overflow-hidden rounded-3xl border border-white/[0.12] bg-white/[0.02] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md">
            <WarpIdentity
              seed={`slash-creators:${EXAMPLE.address.toLowerCase()}`}
              colors={EXAMPLE_PALETTE}
              drift={false}
              speed={0.7}
              className="pointer-events-none absolute inset-0 mix-blend-screen opacity-[0.28] [mask-image:radial-gradient(120%_100%_at_50%_24%,black_0%,rgba(0,0,0,0.45)_58%,transparent_100%)]"
            />
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute left-[16%] top-[18%] h-64 w-64 rounded-full bg-cyan/10 blur-[120px]" />
              <div className="absolute right-[14%] bottom-[8%] h-64 w-64 rounded-full bg-magenta/10 blur-[120px]" />
            </div>
            <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-16 h-64 opacity-30 blur-3xl" style={{ background: `radial-gradient(50% 60% at 50% 0%, ${EXAMPLE_SIG}, transparent 72%)` }} />
            <div aria-hidden className="absolute inset-x-0 top-0 h-1.5" style={{ background: GRADIENT }} />
            <div className="relative px-6 pb-14 pt-10 text-center sm:px-10 sm:pb-16 sm:pt-12">
              <h2 className="enter font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-6xl" style={{ '--enter-i': 0 } as CSSProperties}>
                One buy, the whole narrative.
              </h2>
              <NarrativeConverge />
              <p className="enter mx-auto max-w-2xl text-lg leading-relaxed text-ink-dim sm:text-xl [text-wrap:balance]" style={{ '--enter-i': 2 } as CSSProperties}>
                Your audience backs an entire sector in a single click, one standing bid across every token you chose.
              </p>
            </div>
          </div>
        </section>

        {/* ── SET THE FEE ─────────────────────────────────────────────────────── */}
        <Section
          id="fees"
          eyebrow="How you earn"
          eyebrowClass="text-sm"
          title={<>Set the fee. <span className="text-ink-dim">Keep a share of it.</span></>}
          titleClass="text-4xl sm:text-5xl"
          intro={<>Every trade pays a small fee between {MIN_FEE_PCT}% and {MAX_FEE_PCT}%. You choose it, and you choose your cut, locked in at launch.</>}
          introClass="max-w-xl [text-wrap:balance]"
        >
          <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_1.25fr]">
            <div className="card-surface relative flex flex-col overflow-hidden rounded-2xl p-8">
              <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-cyan/15 blur-3xl" />
              <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: GRADIENT }} />
              <div className="relative flex items-baseline gap-3">
                <span className="font-num text-8xl font-bold leading-[0.9] tabular-nums spectral-text">{MAX_CREATOR_PCT}%</span>
                <span className="font-display text-xl font-bold uppercase tracking-tight text-ink">of the fee pool</span>
              </div>
              <p className="relative mt-4 max-w-sm text-sm leading-snug text-ink-dim [text-wrap:balance]">
                You earn up to {MAX_CREATOR_PCT}% of the fee pool on every trade, for as long as the basket trades.
              </p>
              <div className="relative mt-auto flex items-center gap-3 border-t border-white/10 pt-5">
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-ink-faint">You set the trade fee</span>
                <span className="rounded-full border border-white/15 bg-white/[0.04] px-4 py-1.5 font-num text-base font-semibold tabular-nums text-cyan">{MIN_FEE_PCT}% to {MAX_FEE_PCT}%</span>
              </div>
            </div>

            <div className="card-surface flex flex-col rounded-2xl p-8">
              <div className="font-display text-lg font-bold uppercase tracking-tight text-ink">Where each trade&rsquo;s fee goes</div>
              <div className="mt-5 flex h-20 w-full overflow-hidden rounded-xl ring-1 ring-white/10">
                {FEE_SINKS.map((s, i) => (
                  <div key={s.key} className="relative flex flex-col items-center justify-center gap-0.5 overflow-hidden" style={{ width: `${s.frac * 100}%`, background: s.bg, boxShadow: 'inset -1px 0 0 rgba(7,7,11,0.55)' }} title={`${s.legend} · ${pct(s.frac)}%`}>
                    <div aria-hidden className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 38%, rgba(0,0,0,0.2))' }} />
                    <div aria-hidden className="bento-sheen absolute inset-0" style={{ backgroundImage: 'linear-gradient(115deg, transparent 44%, rgba(255,255,255,0.18) 50%, transparent 56%)', animationDuration: `${6 + i}s` }} />
                    {s.frac >= 0.12 && (
                      <>
                        <span className="relative font-display text-[11px] font-bold uppercase tracking-wide" style={{ color: s.text }}>{s.short}</span>
                        <span className="relative font-num text-sm font-bold tabular-nums" style={{ color: s.text }}>{pct(s.frac)}%</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-auto pt-6">
                <div className="flex flex-wrap justify-center gap-2">
                  {FEE_SINKS.map((s) => (
                    <span key={s.key} className="inline-flex min-w-[7.5rem] items-center justify-center gap-2 rounded-full border px-3 py-1.5" style={{ borderColor: `${s.dot}66`, background: `${s.dot}14` }}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                      <span className="font-mono text-[11px] text-ink">{s.legend}</span>
                      <span className="font-num text-[11px] font-semibold tabular-nums text-ink-dim">{pct(s.frac)}%</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <VolumeCalculator />
        </Section>

        {/* ── UPDATE YOUR BASKET ──────────────────────────────────────────────── */}
        <Section
          title={<>Update your basket, <span className="spectral-text [filter:drop-shadow(0_0_16px_rgba(123,92,255,0.55))]">any time.</span></>}
          titleClass="text-4xl sm:text-5xl"
          intro="Add, remove or reweight whenever your thesis moves. You launch a fresh version that supersedes the old one, shown as a clean diff."
        >
          <VersionUpdateCard />
        </Section>

        {/* ── SOCIAL PROOF — real baskets; clicking one opens its row-partner too ── */}
        <Section title={<>Creators are already launching.</>} titleClass="text-4xl sm:text-5xl">
          <div className="mt-8">
            {isLoading && (
              <div className="grid gap-2 lg:grid-cols-2" aria-busy="true" aria-label="Loading baskets">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-20 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
                ))}
              </div>
            )}
            {isError && !isLoading && (
              <div className="card-surface rounded-2xl p-8 text-center">
                <p className="font-mono text-sm text-ink-dim">Couldn&rsquo;t load baskets right now.</p>
              </div>
            )}
            {!isLoading && !isError && showcase.length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
                <p className="font-mono text-sm text-ink-dim">No baskets launched yet on this network.</p>
                <p className="mt-1 font-mono text-[11px] text-ink-faint">Be the first. Everything here is read straight from the factory contract.</p>
              </div>
            )}
            {!isLoading && !isError && showcase.length > 0 && (
              <>
                <div className="grid gap-2 lg:grid-cols-2">
                  {showcase.map((b, i) => {
                    const pair = Math.floor(i / 2)
                    return (
                      <BasketListRow
                        key={`${b.chainId}:${b.address}`}
                        ix={b}
                        rank={i + 1}
                        chain={chainOf(b)}
                        open={openPair === pair}
                        onOpenChange={(v) => setOpenPair(v ? pair : null)}
                      />
                    )
                  })}
                </div>
                <div className="mt-6 flex justify-center">
                  <Link to="/explore" className="press rounded-xl border border-white/15 px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan">Explore all baskets →</Link>
                </div>
              </>
            )}
          </div>
        </Section>

        {/* ── COMPOSE — the composer, embedded above launch (owner 19:15) ────── */}
        <section id="compose" className="mx-auto max-w-6xl scroll-mt-20">
          <div className="enter" style={{ '--enter-i': 0 } as CSSProperties}>
            <h2 className="font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">Compose &amp; backtest</h2>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-ink-dim">
              Build a mix and see how it would have performed as a basket token before you launch it. Happy with it?
              Launch it just below.
            </p>
          </div>
          <div className="mt-8">
            <Suspense
              fallback={
                <div className="grid min-h-[40vh] place-items-center rounded-2xl border border-white/10 bg-white/[0.02]" role="status" aria-label="Loading the composer">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
                </div>
              }
            >
              <Composer embedded />
            </Suspense>
          </div>
        </section>

        {/* ── LAUNCH — the real builder, embedded (same component as /launch) ─── */}
        <section id="launch" className="mx-auto max-w-5xl scroll-mt-20">
          <div className="enter" style={{ '--enter-i': 0 } as CSSProperties}>
            <h2 className="font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">Launch your basket</h2>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-ink-dim">
              Pick your tokens, weight them, set your fee, name it, deploy. It takes about a minute. The same flow lives
              on its own page at{' '}
              <Link to="/launch" className="text-ink underline decoration-white/25 underline-offset-2 hover:text-cyan">/launch</Link>.
            </p>
          </div>
          <div className="mt-8">
            <Suspense
              fallback={
                <div className="grid min-h-[40vh] place-items-center rounded-2xl border border-white/10 bg-white/[0.02]" role="status" aria-label="Loading the launcher">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
                </div>
              }
            >
              <BasketBuilder />
            </Suspense>
          </div>
        </section>
      </div>
    </div>
  )
}
