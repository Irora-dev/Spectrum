import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { useNavigate } from 'react-router'
import { useActiveChainId, setActiveChainId } from '../lib/chain/active-chain'
import { chainCfg } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import { ROBINHOOD_CHAIN_ID } from '../lib/chain/constants'
import { stocksEnabled } from '../theme/brand'
import brand from '../brand.config'
import { PROTOCOL_FEE_MODEL, feeSplit, type FeeSplit } from '../lib/spectrum/fee-model'
import { formatUsdCompact } from '../lib/spectrum/format'
import { usePrefersReducedMotion, useInViewOnce } from '../lib/motion'
import homeBgBubbles from '../assets/home-bg-bubbles.svg'
import { BasketBento } from '../components/BasketBento'
import { AssetLogo } from '../components/AssetLogo'
import { CreateAssetPicker } from '../components/launch/CreateAssetPicker'
import { resolveAsset, type BuilderAsset } from '../lib/spectrum/version-seed'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'

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
// The LIVE agent, embedded at the page's foot (owner 2026-08-20) — the same
// component the homepage straddle mounts; one shared session site-wide.
const ChatEmbed = lazy(() => import('./Chat').then((m) => ({ default: m.Chat })))

// Exported for the league walkthrough (R 2026-07-29 11:29): the /league popup
// re-tells this page's sections step by step, from the same single source.
export const MIN_FEE_PCT = PROTOCOL_FEE_MODEL.MIN_BASKET_FEE_BPS / 100 // 1.00
export const MAX_FEE_PCT = PROTOCOL_FEE_MODEL.MAX_BASKET_FEE_BPS / 100 // 3.00
export const MAX_CREATOR_PCT = PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS / 100 // 30

// One decimal only when a share is non-integral (the league carve makes creator
// 22.8%), plain integers everywhere else — a non-league chain renders exactly
// the strings it always did.
export const pct = (frac: number) => {
  const v = Math.round(frac * 1000) / 10
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export interface FeeSink {
  key: string
  legend: string
  short: string
  frac: number
  bg: string
  text: string
  dot: string
}

// The marketing split: max creator take, interface + launcher present (the same
// conservative case the launch flow shows). League-aware: on a chain whose
// lineage carves the creator league off the top, the league is a REAL sink —
// omitting it overstated the creator at 24.00% where the contract pays 22.80%
// (kit audit) and left the split bar 5% short of a whole.
export function feeSinksFor(leagueBps: number): { split: FeeSplit; sinks: FeeSink[] } {
  const split = feeSplit(PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS, {
    hasInterface: true,
    hasLauncher: true,
    leagueBps,
  })
  const sinks: FeeSink[] = [
    { key: 'creator', legend: 'You', short: 'You', frac: split.creator, bg: 'linear-gradient(135deg,var(--color-cyan),var(--color-violet))', text: '#04040a', dot: 'var(--color-cyan)' },
    { key: 'holders', legend: 'Basket holders', short: 'Holders', frac: split.holders, bg: '#8b7bff', text: '#04040a', dot: '#8b7bff' },
    { key: 'burn', legend: 'PRISM burn', short: 'Burn', frac: split.burn, bg: 'var(--color-magenta)', text: '#04040a', dot: 'var(--color-magenta)' },
    // Crown gold (PixelCrown's palette): the slice streaming to the league champion.
    ...(split.league > 0
      ? [{ key: 'league', legend: 'Creator league', short: '', frac: split.league, bg: '#FFC53D', text: '#04040a', dot: '#FFC53D' }]
      : []),
    { key: 'interface', legend: 'Interface', short: '', frac: split.interface, bg: '#3b3b52', text: 'var(--color-ink-dim)', dot: '#6b6b8e' },
    { key: 'launcher', legend: 'Launchpad', short: '', frac: split.launcher, bg: '#2c2c3e', text: 'var(--color-ink-faint)', dot: '#4a4a63' },
  ]
  return { split, sinks }
}

/** The ACTIVE chain's league-aware marketing split — the one source every
 *  fee-split surface (this page, the walkthrough) shares. */
export function useFeeSinks() {
  const chainId = useActiveChainId()
  return useMemo(() => feeSinksFor(deploymentFor(chainId).leagueShareBps), [chainId])
}

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

// The concept animation: logos SHOW + SPIN (~2s), then come together and vanish;
// then a DARK basket card reveals — the AI Agents logo + name FIRST, then the
// bento loads in a beat later (owner 17:30); holds a couple seconds, then replays.
// Exported: also the "what is Spectrum" slide of the league walkthrough.
export function NarrativeConverge() {
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
      <div aria-hidden className="ambient-bloom absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl" style={{ background: `${EXAMPLE_SIG}2e` }} />
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
                  <div className="font-display text-2xl font-bold leading-none text-ink">${showSymbol(EXAMPLE.symbol)}</div>
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
// Exported: also the "update any time" slide of the league walkthrough.
export function VersionUpdateCard() {
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
                  <span className="font-display text-base font-bold text-ink">{showSymbol(c.symbol)}</span>
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
  const chainId = useActiveChainId()
  const [volume, setVolume] = useState(50_000)
  const [feeBps, setFeeBps] = useState<number>(PROTOCOL_FEE_MODEL.MIN_BASKET_FEE_BPS)
  // the creator-share dial (owner 2026-08-20: "simulate how much fees they
  // could make on the basket") — the same knob the launch flow locks in,
  // through the same feeSplit math every split surface shares
  const [shareBps, setShareBps] = useState<number>(PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS)
  const { split, sinks } = useMemo(() => {
    const leagueBps = deploymentFor(chainId).leagueShareBps
    const s = feeSplit(shareBps, { hasInterface: true, hasLauncher: true, leagueBps })
    return { split: s, sinks: feeSinksFor(leagueBps) }
  }, [chainId, shareBps])
  const feePool = volume * (feeBps / 10_000)
  const perDay = (frac: number) => feePool * frac
  const others = sinks.sinks.filter((s) => s.key !== 'creator')
  const otherFrac = (key: string) =>
    key === 'holders' ? split.holders : key === 'burn' ? split.burn : key === 'interface' ? split.interface : key === 'league' ? split.league : split.launcher
  return (
    <div className="card-surface mt-4 rounded-2xl p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="font-display text-lg font-bold uppercase tracking-tight text-ink">Simulate your basket</div>
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

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
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
        <div>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">Your creator share</span>
            <span className="font-num text-2xl font-bold tabular-nums text-ink">{shareBps / 100}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS}
            step={100}
            value={shareBps}
            onChange={(e) => setShareBps(Number(e.target.value))}
            aria-label="Creator share of remaining fees"
            className="mt-3 w-full accent-cyan"
          />
          <p className="mt-1 font-mono text-[10px] text-ink-faint">of remaining fees, locked in at launch · max {MAX_CREATOR_PCT}%</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-[1.15fr_1fr]">
        {/* the creator's take — the priority */}
        <div className="relative overflow-hidden rounded-xl border border-cyan/30 bg-cyan/[0.06] p-5">
          <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-cyan/20 blur-2xl" />
          <div className="relative">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Your fees · per day</div>
            <div className="mt-1 font-num text-4xl font-bold tabular-nums text-cyan">{formatUsdCompact(perDay(split.creator))}</div>
            <div className="mt-1 font-mono text-[11px] text-ink-dim">≈ {formatUsdCompact(perDay(split.creator) * 30)} / month at this volume</div>
          </div>
        </div>
        {/* the other sinks, at the dialed share */}
        <div className="grid grid-cols-2 gap-2">
          {others.map((s) => (
            <div key={s.key} className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                <span className="truncate font-mono text-[9px] uppercase tracking-wide text-ink-faint">{s.legend}</span>
              </div>
              <div className="mt-1 font-num text-sm font-semibold tabular-nums text-ink-dim">{formatUsdCompact(perDay(otherFrac(s.key)))}<span className="text-ink-faint">/day</span></div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 font-mono text-[10px] leading-relaxed text-ink-faint">
        Arithmetic on the protocol&rsquo;s split at a {feeBps / 100}% fee and a {shareBps / 100}% creator share, over
        hypothetical daily volume you chose. An illustration of how the split works, not a projection or guarantee
        of earnings.
      </p>
    </div>
  )
}

// ── THE FAQ CAROUSEL (owner 2026-08-20: "a really beautiful faq carousel that
// helps ease their concerns") — every answer is a MECHANIC of the contracts,
// worded from the product's own copy (the chat's QA bank register): facts a
// creator can verify, never reassurance. House snap-rail idiom (the explore
// bands / picker phone rail), arrows in the header per the trending-rail law. ──

const FAQ_CARDS: { q: string; a: string; tag: string; hue: string }[] = [
  {
    q: 'Do I ever hold my audience’s money?',
    tag: 'Custody',
    hue: 'var(--color-cyan)',
    a: 'Never. Buyers hold the basket token in their own wallets, and the contracts have no admin keys. You cannot touch, freeze or move anyone’s funds, and neither can we.',
  },
  {
    q: 'Can holders always get out?',
    tag: 'The exit',
    hue: 'var(--color-teal)',
    a: 'Always. Redeem-in-kind hands back the underlying tokens directly, touching no trading pool. Even if every market for a token died, that exit still works.',
  },
  {
    q: 'Could I quietly raise the fee later?',
    tag: 'No rug',
    hue: 'var(--color-magenta)',
    a: 'No. The fee and your share lock on-chain at launch. What your audience sees at deploy is what it stays, forever. Changing your mind means launching a new version in the open.',
  },
  {
    q: 'What does launching cost?',
    tag: 'Cost',
    hue: 'var(--color-violet-bright)',
    a: 'The factory quotes its live deploy price when you launch, and the transaction carries it as a ceiling: a surprise repricing reverts instead of overcharging you. Plus about a minute of your time.',
  },
  {
    q: 'Do I need to write code?',
    tag: 'No code',
    hue: 'var(--color-cyan)',
    a: 'No. Pick, weight, name, deploy — the whole flow is on this page. The agent below does it conversationally if you prefer talking to clicking.',
  },
  {
    q: 'My thesis changed. Am I stuck?',
    tag: 'Updating',
    hue: 'var(--color-teal)',
    a: 'No. Launch a fresh version that supersedes the old one; holders migrate in one step and the diff shows exactly what changed. Your page keeps the whole lineage.',
  },
  {
    q: 'Which chains can I build on?',
    tag: 'Multichain',
    hue: 'var(--color-violet-bright)',
    a: 'Ethereum, Base and Robinhood Chain. A basket lives on one chain; to span several, you launch one per chain and wrap them into a single bundle page with one buy flow.',
  },
  {
    q: 'How do I actually get paid?',
    tag: 'Getting paid',
    hue: 'var(--color-magenta)',
    a: 'Fees accrue to your address on-chain as trades happen — no invoices, no platform payout day. Withdraw whenever you like; the chat answers “what fees am I earning” live.',
  },
]

function FaqCarousel() {
  const railRef = useRef<HTMLDivElement>(null)
  const turn = (dir: 1 | -1) => {
    const el = railRef.current
    if (el) el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.72), behavior: 'smooth' })
  }
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-end gap-1.5">
        {([-1, 1] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            onClick={() => turn(dir)}
            aria-label={dir === -1 ? 'Previous questions' : 'More questions'}
            className="press grid h-9 w-9 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-cyan/60 hover:text-cyan"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={dir === -1 ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
            </svg>
          </button>
        ))}
      </div>
      <div
        ref={railRef}
        className="scrollbar-none -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain scroll-pl-4 px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {FAQ_CARDS.map((c, i) => (
          <div
            key={c.tag}
            className="card-surface relative flex w-[19rem] shrink-0 snap-start flex-col overflow-hidden rounded-2xl p-6 sm:w-[22rem]"
          >
            <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: c.hue }} />
            <div
              aria-hidden
              className="pointer-events-none absolute -right-12 -top-14 h-32 w-32 rounded-full opacity-20 blur-3xl"
              style={{ background: c.hue }}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim" style={{ borderColor: `color-mix(in srgb, ${c.hue} 45%, transparent)` }}>
                {c.tag}
              </span>
              <span className="font-num text-[11px] tabular-nums text-ink-faint">{String(i + 1).padStart(2, '0')} / {String(FAQ_CARDS.length).padStart(2, '0')}</span>
            </div>
            <div className="mt-4 font-display text-xl font-bold leading-snug tracking-tight text-ink [text-wrap:balance]">{c.q}</div>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">{c.a}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── THE BULLISH FLOW (owner 2026-08-21: "after the hero you select the assets
// you're bullish on, then it explains how basket tokens work, then one-click
// create") — the page's spine. The REAL create-page picker up top (tap what you
// believe in), a concise explainer of what you're making, then a Create button
// that seeds the REAL builder and hands you the deploy. One basket, one chain
// (the active one); cross-chain bundles stay the chat's job. ──────────────────
type BullPick = { chainId: number; address: string; symbol: string }
const bullKey = (p: { chainId: number; address: string }) => `${p.chainId}:${p.address.toLowerCase()}`

// How basket tokens work, SHOWN not told (owner 2026-08-21 "make this way more
// visual"): each beat carries a real illustration built from the app's own
// pieces — the bento (many as one), an overlapping logo cluster under a one-tap
// buy (one click, the whole set), and the real fee split with You glowing.
function HowBasketsWork() {
  const { sinks } = useFeeSinks()
  const cluster = EXAMPLE.items.slice(0, 5)
  return (
    <div className="mt-8 grid gap-4 sm:grid-cols-3">
      {/* 01 · many tokens become one coin — the real bento */}
      <div className="card-surface flex flex-col overflow-hidden rounded-2xl p-5">
        <div className="relative mb-4 h-28 overflow-hidden rounded-xl ring-1 ring-white/[0.08]">
          <BasketBento items={REVEAL_ITEMS} fill className="h-full w-full" />
        </div>
        <div className="font-num text-[11px] tabular-nums text-ink-faint">01</div>
        <div className="mt-1 font-display text-base font-bold leading-snug text-ink [text-wrap:balance]">One token holds them all</div>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">Your picks become a single coin, at the weights you choose.</p>
      </div>

      {/* 02 · one tap buys the whole set — the logos, one Buy */}
      <div className="card-surface flex flex-col overflow-hidden rounded-2xl p-5">
        <div className="relative mb-4 grid h-28 place-content-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02]">
          <div className="flex items-center justify-center">
            {cluster.map((a, i) => (
              <span key={a.address} className="rounded-full" style={{ marginLeft: i === 0 ? 0 : -10, zIndex: cluster.length - i, boxShadow: '0 0 0 2px var(--color-panel)' }}>
                <AssetLogo address={a.address} symbol={a.symbol} chainId={EXAMPLE.chainId} size={38} discColor={`color-mix(in srgb, ${tokenVisual(a.symbol, a.address).color} 55%, #000)`} />
              </span>
            ))}
          </div>
          <div className="mx-auto rounded-full px-5 py-1.5 font-display text-[12px] font-bold uppercase tracking-wide text-void" style={{ background: GRADIENT }}>Buy · one click</div>
        </div>
        <div className="font-num text-[11px] tabular-nums text-ink-faint">02</div>
        <div className="mt-1 font-display text-base font-bold leading-snug text-ink [text-wrap:balance]">Your audience buys it in one click</div>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">One standing bid across every token. No spreadsheet, no ten trades.</p>
      </div>

      {/* 03 · you earn on every trade — the real split, You glowing */}
      <div className="card-surface flex flex-col overflow-hidden rounded-2xl p-5">
        <div className="relative mb-4 grid h-28 content-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4">
          <div className="flex h-10 w-full overflow-hidden rounded-lg ring-1 ring-white/10">
            {sinks.map((s) => (
              <div
                key={s.key}
                className="relative grid place-items-center"
                title={`${s.legend} · ${pct(s.frac)}%`}
                style={{ width: `${s.frac * 100}%`, background: s.bg, boxShadow: s.key === 'creator' ? '0 0 20px -2px var(--color-cyan)' : 'inset -1px 0 0 rgba(7,7,11,0.4)' }}
              >
                {s.key === 'creator' && <span className="font-display text-[11px] font-bold uppercase tracking-wide" style={{ color: s.text }}>You</span>}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim">
            <span className="h-2 w-2 rounded-full bg-cyan" /> your share, locked at launch
          </div>
        </div>
        <div className="font-num text-[11px] tabular-nums text-ink-faint">03</div>
        <div className="mt-1 font-display text-base font-bold leading-snug text-ink [text-wrap:balance]">You earn on every trade</div>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">A fee you set. Holders can always redeem the underlying, so it can never trap them.</p>
      </div>
    </div>
  )
}

function BullishFlow() {
  const navigate = useNavigate()
  const [picks, setPicks] = useState<BullPick[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const builderKey = useRef(0)

  // PICK FROM ANY CHAIN, NO ERROR (owner 2026-08-21). Same chain across all
  // picks = one basket, built here. Two or more chains = a BUNDLE (a basket per
  // chain, wrapped): that flow lives in the chat, so we hand it the picks and
  // it builds the bundle directly. Never a "wrong network" refusal.
  const chains = [...new Set(picks.map((p) => p.chainId))]
  const isBundle = chains.length >= 2
  const canCreate = picks.length >= 2 && !busy

  const add = (chainId: number, address: string, symbol?: string) =>
    setPicks((ps) => (ps.some((p) => bullKey(p) === bullKey({ chainId, address })) ? ps : [...ps, { chainId, address, symbol: symbol ?? address.slice(0, 6) }]))
  const remove = (chainId: number, address: string) => setPicks((ps) => ps.filter((p) => bullKey(p) !== bullKey({ chainId, address })))

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      // ACROSS CHAINS → the bundle flow: hand the picks to the chat, which
      // buckets them per chain, deploys each, and wraps them into one bundle.
      if (isBundle) {
        navigate(`/chat?q=${encodeURIComponent('create a basket of ' + picks.map((p) => p.symbol).join(', '))}`)
        return
      }
      // ONE CHAIN → one basket, built right here. Align the app (and the wallet
      // prompt) to that chain, then seed the real builder for it.
      const cid = chains[0] ?? picks[0]?.chainId
      if (cid == null) {
        setError('Pick at least two assets to begin.')
        setBusy(false)
        return
      }
      setActiveChainId(cid)
      const resolved: BuilderAsset[] = []
      for (const p of picks.slice(0, 12)) {
        try {
          resolved.push(await resolveAsset(p.address, cid, p.symbol))
        } catch {
          /* an asset with no tradeable route on its chain is dropped */
        }
      }
      if (resolved.length < 2) {
        setError('At least two of your picks need a tradeable market. Try different assets.')
        setBusy(false)
        return
      }
      const n = resolved.length
      const even = Math.floor(100 / n)
      const weights = resolved.map((_, i) => (i === n - 1 ? 100 - even * (n - 1) : even))
      const { seedLaunchDraft } = await import('../components/launch/BasketBuilder')
      seedLaunchDraft(cid, { assets: resolved, weights })
      builderKey.current += 1
      setBuilding(true)
    } catch {
      setError('Could not prepare the builder just now. Try again.')
    }
    setBusy(false)
  }

  if (building) {
    return (
      <div className="mx-auto max-w-5xl px-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim">Name it and deploy · your picks are loaded</div>
          <button
            type="button"
            onClick={() => setBuilding(false)}
            className="press rounded-full border border-white/15 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
          >
            ← Change assets
          </button>
        </div>
        <Suspense
          fallback={
            <div className="grid min-h-[40vh] place-items-center rounded-2xl border border-white/10 bg-white/[0.02]" role="status" aria-label="Loading the launcher">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
            </div>
          }
        >
          <BasketBuilder key={builderKey.current} wizard />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4">
      <div className="mb-5 text-center">
        <h2 className="font-display text-3xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-4xl">Pick what you&rsquo;re bullish on</h2>
        <p className="mt-3 font-mono text-[12px] uppercase tracking-[0.16em] text-ink-faint">Tap the tokens · search any network · paste an address</p>
      </div>
      <div className="card-surface rounded-2xl p-4 sm:p-6">
        <CreateAssetPicker picked={picks.map((p) => ({ chainId: p.chainId, address: p.address }))} full={picks.length >= 12} busy={busy} onPick={add} onRemove={remove} />
      </div>

      {isBundle && (
        <p className="mt-3 text-center font-mono text-[11px] leading-relaxed text-ink-faint">
          Your picks span {chains.map((c) => chainCfg(c).name.replace(/\s*chain$/i, '')).join(', ')}. A basket lives on one chain, so this becomes a BUNDLE: one basket per chain, wrapped into a single page. The next step builds it for you.
        </p>
      )}

      <HowBasketsWork />

      {error && <p className="mt-6 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 text-center font-mono text-[12px] text-ink-dim">{error}</p>}

      <div className="mt-8 flex flex-col items-center gap-3">
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => void create()}
          className="press w-full max-w-md rounded-2xl px-6 py-4 text-center font-display text-base font-bold uppercase tracking-[0.06em] text-void transition-transform enabled:hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: GRADIENT }}
        >
          {busy ? 'Preparing…' : !canCreate ? 'Pick at least 2 assets' : isBundle ? `Create your bundle · ${picks.length} assets across ${chains.length} chains` : `Create your basket · ${picks.length} assets`}
        </button>
        <p className="font-mono text-[11px] text-ink-faint">No code · about a minute · you set the fee and name at deploy</p>
      </div>
    </div>
  )
}

// ── the page ─────────────────────────────────────────────────────────────────

export function SlashCreators() {
  const activeChainId = useActiveChainId()
  const rhStocks = activeChainId === ROBINHOOD_CHAIN_ID && stocksEnabled(brand)

  // adopt the SAME backdrop the homepage and chat use (owner 2026-08-21): the
  // shared body::after layer, driven by --chat-bg-url + --chat-bg-live (flipped
  // to the plane's --home-bg-opacity cap). Replaces the hero's own blur blobs,
  // which clipped at the overflow-hidden section edges. HomeSpine's exact wiring.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--chat-bg-url', `url(${homeBgBubbles})`)
    const t = requestAnimationFrame(() => root.style.setProperty('--chat-bg-live', 'var(--home-bg-opacity, 0)'))
    return () => {
      cancelAnimationFrame(t)
      root.style.setProperty('--chat-bg-live', '0')
      root.style.removeProperty('--chat-bg-url')
    }
  }, [])

  return (
    <div className="pb-8">
      {/* ── HERO ─────────────────────────────────────────────────────────────── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        {/* no in-hero backdrop: the shared body::after pastel wash (set in the
            effect above) is the ground now — the old blur blobs clipped at this
            section's overflow-hidden edges (owner 2026-08-21 "weird gradient bg
            that clips"). */}
        <div className="relative z-10 mx-auto flex min-h-[46svh] max-w-4xl flex-col items-center justify-center px-4 pb-10 pt-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-ink-dim backdrop-blur">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" />
            For creators, ecosystems &amp; KOLs
          </div>
          <h1 className="mt-7 font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl md:text-8xl">
            Turn your thesis
            <br />
            into a <span className="spectral-text">token</span>
          </h1>
          {/* THE ONE LINE (owner 2026-08-20: "stupidly easy to understand what
              this is in one line") — the whole product in one sentence, said
              plainly, bigger than a sub normally is. */}
          <p className="mt-7 max-w-2xl text-lg font-medium leading-snug text-ink sm:text-xl [text-wrap:balance]">
            {rhStocks
              ? 'You pick stocks and tokens. They become one coin your audience can buy. You earn a cut of every trade.'
              : 'You pick the tokens. They become one coin your audience can buy. You earn a cut of every trade.'}
          </p>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            {rhStocks ? 'NVDA · SPY · ETH in a single basket · no code, about a minute' : 'No code · about a minute · across Ethereum, Base and Robinhood'}
          </p>
        </div>
      </section>

      <div className="mt-8 space-y-20 sm:mt-10 sm:space-y-24">
        {/* ── THE SPINE: pick what you're bullish on → how baskets work → create
            (owner 2026-08-21). The real picker, a concise explainer, one click
            into the real builder. ─────────────────────────────────────────── */}
        <BullishFlow />

        {/* ── WHAT YOU'D EARN (subordinate to the action above) ─────────────── */}
        <Section
          id="earn"
          eyebrow="How you earn"
          eyebrowClass="text-sm"
          title={<>You keep a share of every trade.</>}
          titleClass="text-3xl sm:text-4xl"
          intro={<>Every trade pays a fee between {MIN_FEE_PCT}% and {MAX_FEE_PCT}% that you set. You keep up to {MAX_CREATOR_PCT}% of what remains, locked in at launch.</>}
          introClass="max-w-xl [text-wrap:balance]"
        >
          <VolumeCalculator />
        </Section>

        {/* ── FAQ — the concerns, faced head-on ─────────────────────────────── */}
        <Section
          id="faq"
          eyebrow="Straight answers"
          title={<>The questions you should ask.</>}
          titleClass="text-3xl sm:text-4xl"
          intro="Every card is a mechanic of the contracts, not a promise."
        >
          <FaqCarousel />
        </Section>

        {/* ── ASK — the live agent (questions + cross-chain bundles) ─────────── */}
        <section id="ask" className="scroll-mt-20">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="font-display text-3xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-4xl">Prefer to talk it out?</h2>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-ink-dim">
              Specter answers anything here and builds the whole thing in chat, including baskets that span Ethereum, Base
              and Robinhood wrapped into one bundle. Ask it the hard questions first.
            </p>
          </div>
          <div className="relative z-20 mt-8 px-0 sm:px-2">
            <Suspense fallback={<div className="mx-auto h-[560px] w-full max-w-[1480px] rounded-[24px] border border-white/[0.08] bg-white/[0.02] lg:h-[680px]" aria-hidden />}>
              <ChatEmbed embed />
            </Suspense>
          </div>
        </section>
      </div>
    </div>
  )
}
