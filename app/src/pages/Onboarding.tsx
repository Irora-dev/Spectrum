import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useAccount, useSignMessage } from 'wagmi'
import { Bezel, Reveal, SectionHead } from '../components/home/Spine'
import { IntroArt } from '../components/home/IntroArt'
import { PortfolioChart, type ChartReadout } from '../components/PortfolioChart'
import { BasketBento } from '../components/BasketBento'
import { LinkedWallets } from '../components/portfolio/LinkedWallets'
import { useAllBaskets, usePortfolio } from '../lib/spectrum/hooks'
import { useWalletGroup } from '../lib/spectrum/use-wallet-group'
import { useRawHoldings } from '../lib/spectrum/use-raw-holdings'
import { basketRowsFromPortfolio, deriveFoundBook } from '../lib/spectrum/found-book'
import { unifyAssets } from '../lib/spectrum/asset-unify'
import { markHomeOnboardingSeen } from '../lib/spectrum/home-onboarding-seen'
import { hasSeenReveal, markSeenReveal } from '../lib/spectrum/onboarding-reveal'
import { anySignedIn, markSignedIn, signInMessage, verifySignIn } from '../lib/spectrum/portfolio-signin'
import { savePortfolioFromHoldings } from '../lib/spectrum/seed-from-holdings'
import { markPortfolioIntroSeen } from '../components/portfolio/PortfolioIntro'
import { DEV_PREVIEW_ADDRESS } from '../lib/spectrum/dev-preview'
import { SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { useCountUp, usePrefersReducedMotion } from '../lib/motion'
import { formatUsdCompact } from '../lib/spectrum/format'
import { chainMeta } from '../components/ChainBadge'
import { InfoDot } from '../components/InfoDot'
import { WALLET_ENABLED } from '../lib/config/features'

// ─────────────────────────────────────────────────────────────────────────────
// /onboarding — the PUBLIC funnel into the portfolio system. Reworked to the
// owner's 2026-08-06 13:30 recording, whose words govern this page's copy:
// hero = "Everything you / hold in one place." + "Every token on every EVM
// chain, as one portfolio." (his commas), the get-started pill GONE, the
// connect button bigger with a glowing gradient; the magic gap shows the DEMO
// portfolio's first card — the beautiful chart, WITHOUT any number — and the
// get-started button LIVES on it; and connecting doesn't say "open your
// portfolio", it turns THIS page into the arrival: an indexing animation, the
// value counting up, the bento assets arriving with their weights, then the
// link-another-wallet ask.
//
// Still composed from the product's real pieces (the convergence law): the
// chart IS PortfolioChart (new `bare` mode — the curve alone), the arrival
// bento IS BasketBento with its own staggered entrance, the wallet ask IS
// LinkedWallets, and the beats are the same IntroArt everywhere else draws.
// ─────────────────────────────────────────────────────────────────────────────

const BEATS = [
  { k: 'One book, every EVM chain', kind: 'book' as const, accent: 'var(--color-cyan)' },
  { k: 'Move weights, not positions', kind: 'weights' as const, accent: 'var(--color-violet-bright)' },
  { k: 'Insights, not advice', kind: 'insights' as const, accent: 'var(--color-teal)' },
]

// The demo card's mix: REAL Base majors (their price history draws the curve —
// live market data), with an ILLUSTRATIVE dollar split. No number ever renders
// (the chart mounts bare), so the level is never presented as a fact.
const DEMO_ASSETS = [
  { chainId: 8453, address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', valueUsd: 19_000 },
  { chainId: 8453, address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', valueUsd: 14_000 },
  { chainId: 8453, address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', valueUsd: 8_000 },
  { chainId: 8453, address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', valueUsd: 6_000 },
]
const DEMO_TOTAL = DEMO_ASSETS.reduce((s, a) => s + a.valueUsd, 0)

const connectWallet = () => window.dispatchEvent(new Event('spectrum:connect'))

// The per-owner reveal memory (hasSeenReveal / markSeenReveal) lives in
// lib/spectrum/onboarding-reveal.ts now — /portfolio's per-wallet invite
// plate reads the same memory (owner report 2026-08-12). Keys unchanged.

/** The demo portfolio's first card, as the magic gap's face: the REAL
 *  PortfolioChart drawing real price history, bare — no numbers anywhere —
 *  with the get-started button living on it (the owner's placement). */
function DemoFirstCard() {
  return (
    <Bezel className="mx-auto w-full max-w-3xl" glow="var(--color-cyan)">
      {/* the WHOLE card is the act, not just the pill (QOL round: a poster-page
          visitor taps the picture) — the inner button stays the real control
          for keyboards and readers; this outer click is pure reach */}
      <div
        className="relative cursor-pointer p-6 transition-colors hover:bg-white/[0.015] sm:p-8"
        onClick={connectWallet}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            Everything you hold
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">demo · illustrative</span>
        </div>
        <div className="mt-4">
          <PortfolioChart assets={DEMO_ASSETS} totalUsd={DEMO_TOTAL} heightClass="h-52" bare hideCoverage />
        </div>
        <div className="mt-6 flex justify-center">
          <GlowConnect label="Get started" />
        </div>
      </div>
    </Bezel>
  )
}

/** The connect act's button — bigger, wearing the glowing gradient the owner
 *  asked for: the spectral fill plus a soft halo of the same gradient behind. */
function GlowConnect({ label, onClick = connectWallet }: { label: string; onClick?: () => void }) {
  return (
    <span className="relative inline-flex">
      <span
        aria-hidden
        className="glow-breathe pointer-events-none absolute -inset-2 rounded-full blur-xl"
        style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
      />
      <button
        type="button"
        onClick={onClick}
        className="spectral-btn press relative inline-flex h-14 items-center rounded-full px-10 font-display text-[15px] font-bold uppercase tracking-[0.12em] text-void"
      >
        {label}
      </button>
    </span>
  )
}

/** THE ARRIVAL — what connecting turns this page into (the owner: "it should
 *  show a really cool animation of it indexing… then below that you actually
 *  start to see the bento assets get added… then it asks, do you want to
 *  connect another wallet"). Three beats, each gated on the previous:
 *    indexing → the real chart assembling over the found book (its own
 *                skeleton IS the indexing animation), the total counting up;
 *    assemble → the bento's staggered entrance, weight-ranked;
 *    ask      → LinkedWallets (the real multi-wallet ceremony) + the door
 *                into the full portfolio.
 *  Reads only — nothing here signs, exactly like the surfaces it reuses. */
function Arrival({ address, demo = false }: { address: string; demo?: boolean }) {
  const walletGroup = useWalletGroup(address)
  const raw = useRawHoldings(walletGroup.addresses)
  const heldBaskets = usePortfolio(walletGroup.addresses)
  const basketChainsFailed = heldBaskets.chainsFailed ?? 0
  const book = useMemo(
    () =>
      deriveFoundBook([
        ...(raw.data?.holdings ?? []),
        ...basketRowsFromPortfolio(heldBaskets.data?.holdings ?? []),
      ]),
    [raw.data, heldBaskets.data],
  )
  // PARTIAL PROGRESS (owner 1410: "the indexing takes ages"): the show starts
  // the moment the RAW read lands — balance multicalls answer in a beat, while
  // basket discovery (3-chain enumeration) takes seconds and folds in late.
  const rawReady = !raw.isLoading
  const indexed = rawReady && !heldBaskets.isLoading
  const reduced = usePrefersReducedMotion()
  // phone-width read-once (audit UX#5): at 390px the wide strip was a 71px
  // sliver bar with 6.5px tickers and no dollars
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 640

  // THE SIGN-IN DOOR (the owner 2026-08-13: "'log into' your portfolio by signing
  // with one of your linked wallets, from both returning and also from the
  // main onboarding flow" — he hit the loop live: the arrival REVEALED his
  // book, Visit Portfolio landed on "complete onboarding", round and round).
  // The signature is the login AND the walk-through completes the ADD: the
  // revealed holdings become the saved allocation (the store /portfolio
  // counts and its gate reads), so the door lands on a book, not a card.
  // The ACTIVE wallet signs — the only one that can (the page law) — and a
  // linked group's merged holdings ride the add under it. A wallet already
  // signed in on this device keeps the plain 'Visit Portfolio' door: no
  // second toll, just the idempotent add-if-missing on the way through.
  const navigate = useNavigate()
  const { signMessageAsync } = useSignMessage()
  const [signin, setSignin] = useState<'idle' | 'signing' | 'adding' | 'declined' | 'unverified'>('idle')
  // group law (the owner's "sign with any of the linked wallets" — yes): a login
  // by ANY verified member latches the whole set on this device
  const alreadyIn = anySignedIn(walletGroup.addresses)
  // the signature usually outlasts the raw sweep; when it doesn't, 'adding'
  // holds the door until the read lands so the add writes real rows
  useEffect(() => {
    if (signin !== 'adding' || !rawReady) return
    savePortfolioFromHoldings(address, raw.data?.holdings ?? [])
    navigate('/portfolio')
    // raw.data is read at completion time; keying on it would re-fire on
    // every refetch while the door idles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signin, rawReady])
  const signIn = async () => {
    if (alreadyIn) {
      setSignin('adding') // the effect completes it (now, if the read is in)
      return
    }
    setSignin('signing')
    const message = signInMessage(address, window.location.host, Date.now())
    try {
      const signature = await signMessageAsync({ account: address as `0x${string}`, message })
      // verify what actually came back before latching (the link ceremony's
      // law): EOA by recovery, smart wallets by the chain's own verifyMessage
      if (!(await verifySignIn(address, message, signature))) {
        setSignin('unverified')
        return
      }
      markSignedIn(address)
      setSignin('adding')
    } catch {
      setSignin('declined')
    }
  }
  // WALLET-SWITCH CONTINUITY (owner live 15:3x: switching accounts "completely
  // removes the assets — it needs to keep the page there, and when you sign
  // the tx it adds/rebalances"). The last real book is HELD: when the active
  // account changes to one that shares no member with the group (a raw
  // switch), the reads re-key and would wipe to a skeleton — instead the held
  // book stays on screen, SAID to be the previous wallet's, with two honest
  // doors: sign the link (the merged read then GROWS the book — the identity
  // audit's carry-over handles linked sets) or start over with the new wallet
  // alone. Nothing is silently wiped, and nothing claims B holds A's assets.
  // The hold is a LATCH, not a loading state (owner live 15:4x: "it still
  // switches" — v1 only held while the new read was in flight, so the moment
  // the new wallet's balances landed the old book vanished anyway). The latch
  // arms when the active account is neither the held owner nor a member of
  // its group, and releases only two ways: the LINK lands (the group gains
  // the held owner — the merged book then GROWS in place) or the user picks
  // "use the new wallet only" (fresh reveal for the new wallet).
  const heldRef = useRef<{ book: typeof book; owner: string } | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  // ONE effect decides the latch AND the hold with the SAME fresh values
  // (audit #3): as two effects, the hold read a one-render-stale
  // pendingSwitch — a re-switch to a cache-warm wallet (A→B→A→B inside the
  // query's staleTime) captured B's own book as "held", the banner then
  // claimed B's book belonged to someone else, and Sign-to-link armed into
  // a self-anchored group that could never offer a candidate.
  useEffect(() => {
    const cur = address.toLowerCase()
    const h = heldRef.current
    const groupHasHeld = h ? walletGroup.addresses.some((a) => a.toLowerCase() === h.owner) : false
    const arming = !!h && h.owner !== cur && !groupHasHeld
    setPendingSwitch(arming ? cur : null)
    // hold the last REAL book — the smallest real book is ONE priced asset
    // (audit #6: the ≥2-tile gate meant a one-asset wallet was displayed but
    // never held, so switching away wiped it — the exact complaint the latch
    // was built for). Never overwrite while arming.
    if (!arming && book.priced.length > 0) {
      heldRef.current = { book, owner: cur }
    }
  }, [address, walletGroup.addresses, book])
  const held = heldRef.current
  const showHeld = pendingSwitch != null && !!held
  const shown = showHeld && held ? held.book : book
  // The banner's Sign-to-link IS the consent: the moment the armed machine
  // offers the already-connected candidate, fire the wallet prompt — no
  // second click inside the panel (owner 16:2x: "doesn't bring up the tx").
  // One-shot, banner-armed only: the panel's own flow never auto-signs.
  const bannerSignArmed = useRef(false)
  // The chart's history hook LATCHES the last settled curve (its own carry) —
  // exactly right for the link-grow (old curve holds, pulse dot, new curve
  // lands in place) and exactly WRONG across an ownership change: "use only
  // this wallet" must not show the old wallet's curve under the new identity
  // (the raw-holdings identity-gate class). The epoch remounts the chart on
  // that one act; the link path never bumps it, so the carry survives there.
  const [chartEpoch, setChartEpoch] = useState(0)
  useEffect(() => {
    if (!bannerSignArmed.current) return
    if (walletGroup.stage === 'sign') {
      bannerSignArmed.current = false
      void walletGroup.signLink()
    } else if (walletGroup.stage === 'idle' && walletGroup.error == null) {
      // arming failed silently (no account) — disarm rather than fire later
      bannerSignArmed.current = false
    }
  }, [walletGroup.stage, walletGroup.error, walletGroup])
  // ONE ASSET, WHEREVER IT LIVES (owner 1603: "I have three ETH bento grids
  // when it should be one, with a little line for which chain — take it from
  // the portfolio"): the book's priced rows fold through the PORTFOLIO'S OWN
  // unifyAssets (same module Yours runs — wrap-forms + curated stables fold,
  // arbitrary symbol twins never do), and a merged tile carries the per-chain
  // split as its breakdown line, chain-labeled like the portfolio's. The
  // sqrt-dampened GEOMETRY then runs on the unified list (labelPct stays the
  // true weight).
  const balancedTiles = useMemo(() => {
    const totalUsd = shown.priced.reduce((sum, h) => sum + (h.usd ?? 0), 0)
    const unified = unifyAssets(
      shown.priced.map((h) => ({
        key: `${h.chainId}:${h.address.toLowerCase()}`,
        chainId: h.chainId,
        address: h.address,
        symbol: h.symbol,
        valueUsd: h.usd ?? 0,
        pct: totalUsd > 0 ? ((h.usd ?? 0) / totalUsd) * 100 : 0,
        basket: h.basket,
        // discovered rows never fold into the symbol families (audit #4)
        verified: h.verified,
      })),
    )
    // sqrt compresses the RANGE; the FLOOR guarantees the smallest position a
    // readable tile (owner live 16:3x: "even 1% shouldn't be crammed into the
    // corner") — every tile's geometry weight acts as at least a 6% position,
    // renormalized; labelPct still tells the truth.
    const damp = unified.map((u) => Math.sqrt(Math.max(u.pct, 0.0001, 6)))
    const dampSum = damp.reduce((a, b) => a + b, 0)
    return unified.map((u, i) => ({
      id: u.id,
      symbol: u.canon,
      address: u.dominant.address,
      chainId: u.dominant.chainId,
      valueUsd: u.valueUsd,
      weightPct: dampSum > 0 ? (damp[i] / dampSum) * 100 : u.pct,
      labelPct: u.pct,
      footer: {
        amount: formatUsdCompact(u.valueUsd),
        breakdown: u.merged
          ? u.parts.map((part) => ({
              label: chainMeta(part.chainId).short,
              amount: formatUsdCompact(part.valueUsd),
              amountUsd: part.valueUsd,
              share: u.valueUsd > 0 ? part.valueUsd / u.valueUsd : undefined,
            }))
          : undefined,
      },
    }))
  }, [shown.priced])
  const chartAssets = useMemo(
    () =>
      shown.priced.map((h) => ({
        chainId: h.chainId,
        address: h.address,
        symbol: h.symbol,
        valueUsd: h.usd ?? 0,
      })),
    [shown.priced],
  )
  // THE GROWTH, corrected (owner 1421: "the chart grows, it doesn't refresh
  // every time — that's not what I meant"): the CURVE is the portfolio's own —
  // mounted ONCE over the full set, one smooth load, hover price popup, real
  // axes ("take the chart functionality from the actual portfolio rather than
  // building it again yourself"). What grows per reveal is the VALUE readout
  // and the GRID: each beat lands one tile and retargets the count-up to the
  // revealed sum. Nothing repaints.
  const total = balancedTiles.length
  const [stage, setStage] = useState(0)
  // RETURNING-VISITOR MEMORY (the consolidation round): the ceremony is a
  // first-meeting gift, not a toll — a wallet whose reveal has already played
  // settles INSTANTLY on every later visit/reload (tiles, value, breakdown,
  // no staging). Per-owner, device-local, capped; a failed read just replays
  // the show (never worse than before).
  // a DEMO plays the whole ceremony on every load and never writes a latch —
  // it is a showroom, not a visit (owner 2026-08-16: "load local host with a
  // demo of this")
  const revealedOnce = useRef(demo ? false : hasSeenReveal(address))
  useEffect(() => {
    if (total > 0 && stage >= total) {
      revealedOnce.current = true
      // the memory belongs to the wallet WHOSE BOOK PLAYED (audit #7: on a
      // switch this effect re-ran with the NEW address over the HELD book
      // and burned the new wallet's one-shot ceremony) — and only a FULL
      // read earns it (a 2-of-6-tiles partial must not be remembered as
      // "seen at 2 tiles" forever)
      if (!showHeld && indexed && !demo) markSeenReveal(address)
    }
  }, [stage, total, address, showHeld, indexed])
  useEffect(() => {
    // the SHOWN book stages: while latched it is the held book (already
    // read), so the live wallet's in-flight sweep must not freeze the show
    // at a partial grid (audit #10)
    if ((!rawReady && !showHeld) || stage >= total) return
    if (reduced) {
      setStage(total)
      return
    }
    if (revealedOnce.current) {
      // a book that GROWS after its reveal (a linked wallet arriving) never
      // replays the ceremony — but five simultaneous liquid fills read as a
      // glitch (audit UX#9), so growth staggers FAST (300ms beats) instead
      // of dumping every new tile in one frame
      const t = window.setTimeout(() => setStage((v) => Math.min(v + 1, total)), 300)
      return () => window.clearTimeout(t)
    }
    // one liquid fill (~700ms) completes before the next tile lands
    const t = window.setTimeout(() => setStage((v) => Math.min(v + 1, total)), stage === 0 ? 250 : 1600)
    return () => window.clearTimeout(t)
  }, [rawReady, stage, total, reduced])
  const revealed = total > 0 && stage >= total
  // the sum runs on the SAME unified tiles the grid stages (audit #2: raw
  // rows vs unified tiles made the headline under-report any folded book —
  // ETH+WETH counted once in the grid but the tail row never joined the sum)
  const revealedUsd = useMemo(
    () => balancedTiles.slice(0, stage).reduce((sum, t) => sum + t.valueUsd, 0),
    [balancedTiles, stage],
  )
  const counted = useCountUp(revealedUsd, stage > 0 && revealedUsd > 0, 500)
  // onReadout stays wired ONLY to slim the chart's own header — the readout
  // itself is hidden on the owner's word (live 15:2x, "hide this started with")
  const setReadout = (_r: ChartReadout | null) => undefined
  // ONE STORY, TOLD ONCE (the standing breadcrumb): a visitor who walked this
  // arrival with a readable book must not get the portfolio ceremony's story
  // pitch again when they open the full page — same latch HomeOnboarding sets.
  useEffect(() => {
    if (demo) return // a showroom must not flip the browser's real latches
    if (indexed && book.top.length > 0) {
      markHomeOnboardingSeen()
      // the OLD portfolio veil's latch too — post-consolidation the /portfolio
      // gate reads either; two latches disagreeing would replay a dead popup
      markPortfolioIntroSeen()
    }
  }, [indexed, book.top.length, demo])
  // Could-not-read ≠ empty (the creator-page lesson, same day): only assert
  // "this wallet reads empty" when every chain actually ANSWERED.
  const chainsFailed = Math.max(raw.data?.chainsFailed ?? 0, basketChainsFailed)
  const failedChainIds = raw.data?.failedChainIds ?? []
  const discoveryGaps = raw.data?.discoveryGaps ?? 0
  const allChainsFailed = indexed && (raw.data?.chainsFailed ?? 0) >= SUPPORTED_CHAIN_IDS.length
  // per-wallet readable totals for the LinkedWallets rows (the group's
  // composition as a fact — same derivation HomeOnboarding uses)
  const readableByWallet = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of raw.data?.holdings ?? [])
      for (const c of h.contributors ?? []) {
        if (c.usd != null && c.usd > 0) m.set(c.owner, (m.get(c.owner) ?? 0) + c.usd)
      }
    return m
  }, [raw.data])
  // BALANCED TILES (owner live 15:2x: "I have a small position I can barely
  // see"): the GEOMETRY runs on square-root-dampened weights, renormalized —
  // a 54%-vs-1% book compresses from 54:1 to ~7:1 in area, so the smallest
  // position stays a readable tile — while labelPct carries the TRUE weight,
  // so the number on the tile never lies. The bento supports exactly this
  // split (labelPct exists for it).

  // The total's per-chain breakdown (owner 1410: "assets on Base, on Eth, on
  // Robinhood"; owner live 14:4x: "it looks like it's only indexing base") —
  // EVERY supported chain gets a row, value or not, so "was RH even swept?"
  // is answerable at a glance: a $0 row means swept-and-empty, a failed chain
  // is already called out by the chainsFailed line below.
  const byChain = useMemo(() => {
    const m = new Map<number, number>(SUPPORTED_CHAIN_IDS.map((c) => [c, 0]))
    for (const h of shown.priced) m.set(h.chainId, (m.get(h.chainId) ?? 0) + (h.usd ?? 0))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [shown.priced])

  return (
    /* full width (owner 1421: "that card needs to use more width — make the
       chart, the price, the amount use all of that width") */
    <div className="w-full">
      {/* clip OFF + no glow: the wallet-link panel opens UPWARD out of the
          card (owner 1410 — it clipped); the glow blob needs clipping, so it
          stays off this one card. */}
      <Bezel clip={false}>
        <div className="p-6 sm:p-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <span className="inline-flex items-center gap-2.5 font-display text-xl font-bold uppercase tracking-[0.08em] text-ink">
              {/* while latched the card SHOWS the held book — claiming
                  "indexing" over a complete book was false (audit #10); the
                  banner already says what is actually happening */}
              {rawReady || showHeld ? 'Your portfolio' : 'Indexing your portfolio…'}
              {!rawReady && !showHeld && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" role="status" aria-label="Indexing" />
              )}
            </span>
            {/* the started-with readout is HIDDEN here on the owner's word
                (live 15:2x) — onReadout stays wired so the chart's own header
                remains slim; the counted total is the card's one number */}
            <span className="inline-flex items-baseline gap-4">
              {stage > 0 && !revealed && total > 2 && (
                /* a 12-asset book is a ~19s show — never a hostage (audit UX#8) */
                <button
                  type="button"
                  onClick={() => setStage(total)}
                  className="press font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
                >
                  show all →
                </button>
              )}
              {stage > 0 && revealedUsd > 0 && (
                <span key={revealed ? 'settled' : 'counting'} className={`font-num text-4xl font-bold tabular-nums text-ink ${revealed ? 'total-settle' : ''}`}>
                  {formatUsdCompact(counted)}
                </span>
              )}
            </span>
          </div>
          {revealed && (
            <div className="mt-2 flex flex-wrap items-baseline justify-end gap-x-5 gap-y-1">
              {byChain.map(([cid, usd], i) => (
                <span
                  key={cid}
                  className="intro-step-in inline-flex items-baseline gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em]"
                  style={{ animationDelay: `${150 + i * 120}ms` }}
                >
                  <span style={{ color: chainMeta(cid).color }}>{chainMeta(cid).short}</span>
                  {/* a chain that never ANSWERED must not print a confident $0
                      (audit UX#15) — a dash, with the reason on hover */}
                  <span
                    className={`font-num tabular-nums ${usd > 0 ? 'text-ink-dim' : 'text-ink-faint'}`}
                    title={failedChainIds.includes(cid) ? `${chainMeta(cid).short} didn’t answer — this may not be zero` : undefined}
                  >
                    {failedChainIds.includes(cid) ? '—' : usd > 0 ? formatUsdCompact(usd) : indexed ? '$0' : '…'}
                  </span>
                </span>
              ))}
            </div>
          )}
          {showHeld && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan/30 bg-cyan/[0.06] px-4 py-3">
              {/* one line, the ⓘ carries the rest (owner live 16:1x) */}
              <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-dim">
                Wallet switched to{' '}
                <span className="font-mono text-ink">{address.slice(0, 6)}…{address.slice(-4)}</span>
                <InfoDot>
                  This book still shows the previous wallet. <strong className="text-ink">Sign to link</strong>{' '}
                  adds the new wallet to it — one signature proving the wallet is yours, and the book grows in
                  place. <strong className="text-ink">Use only this wallet</strong> starts a fresh book for it
                  instead. Reading is free and signs nothing.
                </InfoDot>
              </p>
              {/* the hierarchy is the choice (owner live 16:0x): SIGN TO LINK
                  is the primary act — it arms the ceremony and the panel opens
                  itself, armed (LinkedWallets auto-opens on stage change) —
                  and use-only-this-wallet stands beside it, quiet. */}
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    // join the HELD book's group (the user already switched, so
                    // the active account IS the candidate — arming without
                    // `into` pinned the anchor to itself and no prompt came)
                    bannerSignArmed.current = true
                    walletGroup.beginLink({ into: held?.owner })
                  }}
                  className="spectral-btn press inline-flex h-10 items-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
                >
                  Sign to link
                </button>
                <button
                  type="button"
                  onClick={() => {
                    heldRef.current = null
                    setPendingSwitch(null)
                    revealedOnce.current = false
                    setStage(0) // the new wallet gets its own first reveal
                    setChartEpoch((e) => e + 1) // and its own curve — never the old identity's carry
                  }}
                  className="press rounded-lg border border-white/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:border-white/30 hover:text-ink"
                >
                  Use only this wallet
                </button>
              </div>
            </div>
          )}
          {/* THE ROOM IT DESERVES (owner live 15:0x: "too cramped, chart looks
              bad — beautify"): the half-width squeeze is gone. The chart gets
              the FULL card width — the same width that makes the portfolio's
              own chart beautiful — the bento runs under it as a wide strip,
              and the acts sit in one centered row below both (his geometry).
              One-viewport survives through rhythm, not compression. */}
          <div className="mt-5">
            <PortfolioChart
              key={chartEpoch}
              assets={chartAssets}
              totalUsd={shown.readableUsd}
              heightClass="h-48"
              indexing={!rawReady}
              onReadout={setReadout}
              hideCoverage
            />
          </div>
          {stage > 0 && balancedTiles.length > 0 && (
            <div className="mt-6">
              <BasketBento
                items={balancedTiles.slice(0, stage)}
                aspect={isPhone ? 0.95 : 4.2}
                expandable={!isPhone}
                entrance="fill"
              />
            </div>
          )}
          {/* THE TWO ACTS (owner 2026-08-16: the flow should "genuinely guide
              the user's hand" — and his original 1330 spec already named the
              beat this page was missing: after the reveal "it ASKS, do you
              want to connect another wallet"). The controls were one flat
              centered row; now they are two numbered acts, so the hand is
              guided without anything being gated: 01 asks the wallet
              question with its reason, 02 sets the signature expectation
              before the wallet ever prompts. Present from the first frame
              (the ceremony usually outlasts the skeleton; 'adding' holds the
              walk-through until the read lands) but QUIET while the reveal
              plays — the show owns the eye, then the acts take over. Reduced
              motion never dims. */}
          <div
            className={`mt-8 grid gap-4 border-t border-white/10 pt-6 sm:grid-cols-2 ${
              !reduced && total > 0 && stage < total ? 'pointer-events-none opacity-40' : ''
            } transition-opacity duration-500`}
          >
            <div className="flex flex-col items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-5">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">01 · is this everything?</span>
              <p className="text-sm leading-relaxed text-ink-dim">
                Most people hold across more than one wallet. Link the others and they merge into this
                one book, a signature each to prove they are yours. Nothing moves, nothing is spent.
              </p>
              <div className="mt-auto pt-2">
                <LinkedWallets group={walletGroup} active={address} readableByWallet={readableByWallet} prominent drop="up" />
              </div>
            </div>
            <div className="flex flex-col items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-5">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">02 · make it yours</span>
              <p className="text-sm leading-relaxed text-ink-dim">
                {alreadyIn
                  ? 'You are signed in on this device. Your book is saved, and the full portfolio is open to you.'
                  : 'One free signature signs you in. No gas, nothing moves. Your book saves on this device and the full portfolio opens.'}
              </p>
              <div className="mt-auto pt-2">
                <button
                  type="button"
                  onClick={() => void signIn()}
                  disabled={signin === 'signing' || signin === 'adding'}
                  className="spectral-btn press inline-flex h-12 items-center justify-center rounded-full px-8 font-display text-[14px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {signin === 'signing'
                    ? 'Waiting for your wallet…'
                    : signin === 'adding'
                      ? 'Opening your portfolio…'
                      : alreadyIn
                        ? 'Visit Portfolio →'
                        : 'Sign in to your portfolio →'}
                </button>
              </div>
            </div>
          </div>
          {(signin === 'declined' || signin === 'unverified') && (
            <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint" role="status">
              {signin === 'declined'
                ? 'The signature was declined — nothing signed in.'
                : 'This signature could not be verified as this wallet’s, so it cannot sign in.'}{' '}
              <Link to="/portfolio" className="text-ink-dim underline decoration-white/20 underline-offset-2 hover:text-ink">
                browse without signing in
              </Link>
            </p>
          )}
          {rawReady && !indexed && !showHeld && (
            <p className="mt-4 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint" role="status">
              <span className="h-1 w-1 animate-pulse rounded-full bg-cyan" aria-hidden />
              reading your baskets across {SUPPORTED_CHAIN_IDS.map((c) => chainMeta(c).short).join(' · ')}…
            </p>
          )}
          {indexed && !showHeld && book.readableUsd === 0 && allChainsFailed && (
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <p className="text-sm leading-relaxed text-ink-dim">
                The network didn&rsquo;t answer just now, so nothing could be read — that says
                nothing about what this wallet holds.
              </p>
              {/* the sentence used to ask for a retry the page didn't offer
                  (audit UX#14) */}
              <button
                type="button"
                onClick={() => void raw.refetch()}
                className="press rounded-lg border border-cyan/50 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-cyan hover:bg-cyan/10"
              >
                Try again
              </button>
            </div>
          )}
          {indexed && !showHeld && book.readableUsd === 0 && !allChainsFailed && (
            /* one copy of the acts on this card — the row below already
               carries link-a-wallet and the portfolio door (audit #5 mounted
               a SECOND ceremony panel here, two auto-opening popovers) */
            <p className="mt-5 text-sm leading-relaxed text-ink-dim">
              This wallet reads empty right now — nothing to index yet. Fund it on any EVM chain,
              or link the wallet that holds your assets below: the book merges every wallet you add.
            </p>
          )}
          {indexed && !showHeld && book.readableUsd > 0 && (chainsFailed > 0 || discoveryGaps > 0) && (
            <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              {chainsFailed > 0
                ? `${chainsFailed} network${chainsFailed === 1 ? '' : 's'} didn’t answer — this book may be missing what lives there`
                : 'the unlisted-token scan couldn’t finish on every network — rarely-listed holdings may be missing'}
            </p>
          )}
        </div>
      </Bezel>
    </div>
  )
}

export function Onboarding() {
  const { address, isConnected, isReconnecting } = useAccount()
  // THE DEMO DOOR (owner 2026-08-16: "load local host with a demo of this") —
  // /onboarding?demo=1 plays the whole connected arrival off the dev preview
  // identity's fixtures, no wallet needed. Dev-gated like the portfolio's own
  // demo door; a real connect always outranks it. Latch-free by construction
  // (the Arrival's demo flag), so replaying it never spends anything real.
  const [params] = useSearchParams()
  const demo = import.meta.env.DEV && params.get('demo') === '1'
  // SEEING THIS PAGE IS SEEING THE STORY (audit #1 — the gate loop): the
  // latches used to be written only by a connected wallet with a readable
  // book, so a disconnected visitor, an empty wallet, or a private-mode
  // browser could NEVER reach /portfolio — the gate bounced them here off
  // the page's own Visit-Portfolio button, forever. The funnel's job is the
  // pitch; once pitched, /portfolio opens. (The reveal keeps its own
  // per-wallet memory separately.)
  useEffect(() => {
    markHomeOnboardingSeen()
  }, [])
  const { data: all } = useAllBaskets()
  const connected = WALLET_ENABLED && isConnected && address ? address : demo ? DEV_PREVIEW_ADDRESS : undefined
  // On the connect ITSELF (not on arriving already-connected), carry the
  // visitor to the arrival — the owner: connecting "throws you into actually
  // seeing the assets in that wallet", no navigation, no button in between.
  // On the connect ITSELF, carry the visitor UP: the book renders in the hero
  // (the 1359 recording — the hero collapses into the wallet card), so a
  // connect from the demo card mid-page must surface it, not leave the viewer
  // staring at the section that just emptied.
  const wasConnected = useRef(!!connected)
  const reduced = usePrefersReducedMotion()
  useEffect(() => {
    if (connected && !wasConnected.current) {
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
    }
    wasConnected.current = !!connected
  }, [connected, reduced])

  return (
    <div className="pb-24">
      {/* ── HERO (the 1330 recording: pill gone, headline up, his lines) ──── */}
      <section className={`relative overflow-hidden ${connected ? "pt-4 sm:pt-5" : "pt-12 sm:pt-16"}`}>
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-[12%] top-[8%] h-72 w-72 rounded-full bg-cyan/10 blur-[130px]" />
          <div className="absolute right-[10%] top-[30%] h-72 w-72 rounded-full bg-magenta/10 blur-[130px]" />
          <div className="absolute left-[45%] top-[55%] h-56 w-56 rounded-full bg-teal/10 blur-[120px]" />
        </div>
        <div className={`relative mx-auto px-4 text-center sm:px-6 ${connected ? "max-w-6xl" : "max-w-5xl"}`}>
          {/* THE COLLAPSE (the 1359 recording): connecting doesn't send you
              anywhere — the hero moves up and gets smaller, the description
              and the buttons drop away, and your book IS the hero. */}
          {/* CONNECTED = ONE LINE (owner live 15:1x: "doesn't fit in one
              viewport" — his latest word; it supersedes 1410's big-title for
              the connected face only, per the 1359 collapse instinct). The
              DISCONNECTED hero keeps the stunning two-line title. */}
          <Reveal>
            <h1
              className={`font-display font-bold uppercase leading-[0.95] tracking-tight text-ink ${
                connected ? 'text-2xl sm:text-4xl' : 'text-5xl sm:text-7xl'
              }`}
            >
              Everything you
              {connected ? ' ' : <br />}
              hold <span className="spectral-text">in one place.</span>
            </h1>
          </Reveal>
          {!connected && (
            <Reveal delay={120}>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-dim [text-wrap:balance] sm:text-xl">
                Every token on every EVM chain, as one portfolio.
              </p>
            </Reveal>
          )}
          {!connected && (
            <Reveal delay={200}>
              <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
                {/* while wagmi resumes a prior session, don't pitch a connect
                    the page is about to contradict (audit UX#16 — the
                    disconnected face flashed before the arrival swapped in) */}
                {WALLET_ENABLED && isReconnecting && (
                  <span className="inline-flex h-14 items-center gap-2.5 px-4 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint" role="status">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" aria-hidden />
                    resuming your session…
                  </span>
                )}
                {WALLET_ENABLED && !isReconnecting && <GlowConnect label="Connect a wallet to begin" />}
                {/* the demo door only where the demo can actually answer — the
                    fixtures are dev-gated (production cannot show a fake book) */}
                {import.meta.env.DEV && (
                  <Link
                    to="/portfolio?demo=1"
                    className="press inline-flex h-14 items-center rounded-full border border-white/15 px-8 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                  >
                    Watch the demo
                  </Link>
                )}
              </div>
            </Reveal>
          )}
          {connected && (
            <div className="arrival-enter mt-5 text-left">
              <Arrival address={connected} demo={demo && !(isConnected && address)} />
            </div>
          )}
        </div>
      </section>

      {/* ── THE BENEFITS, drawn by the product itself ────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 sm:pt-32">
        <div className="grid gap-4 lg:grid-cols-3">
          {BEATS.map((c, i) => (
            <Reveal key={c.k} delay={i * 90} className="h-full">
              <Bezel className="h-full" glow={c.accent}>
                <div className="flex h-full flex-col gap-4 p-8">
                  <span aria-hidden className="h-px w-12" style={{ background: c.accent }} />
                  <h3 className="font-display text-lg font-bold uppercase tracking-[0.04em] text-ink">{c.k}</h3>
                  <IntroArt kind={c.kind} accent={c.accent} baskets={all ?? []} />
                </div>
              </Bezel>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── THE MAGIC: the demo's first card, then — connected — the arrival ── */}
      {WALLET_ENABLED && !connected && (
        <section className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 sm:pt-32">
          <Reveal>
            <SectionHead
              eyebrow="See the magic"
              size="display"
              title={
                <>
                  Connect, and this page
                  <br />
                  becomes <span className="spectral-text">your book.</span>
                </>
              }
              sub="No account, no import, no spreadsheet."
            />
          </Reveal>
          <div className="mt-14">
            <Reveal delay={80}>
              <DemoFirstCard />
            </Reveal>
          </div>
        </section>
      )}

      {/* ── quiet doors out ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-4 pt-24 sm:px-6 sm:pt-32">
        <div className="flex flex-wrap items-center justify-center gap-3 border-t border-white/10 pt-10">
          {[
            { to: '/learn', label: 'How it works' },
            { to: '/explore', label: 'Explore baskets' },
            { to: '/creators', label: 'For creators' },
          ].map((d) => (
            <Link
              key={d.to}
              to={d.to}
              className="press rounded-lg border border-white/12 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint hover:border-cyan/50 hover:text-cyan"
            >
              {d.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
