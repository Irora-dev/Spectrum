import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { sanitizePostUrl } from '../../lib/spectrum/creator-metadata'
import { TagInput } from '../TagInput'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { formatEther } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { DEPLOY_ENABLED } from '../../lib/config/features'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { resolveCreator } from '../../lib/spectrum/creator'
import { sanitizeImageUrl } from '../../lib/spectrum/creator-metadata'
import { chainCfg } from '../../lib/chain/chains'
import type { DeployStatus } from '../../lib/spectrum/use-deploy'
import type { PublishStatus } from '../../lib/spectrum/use-publish'
import type { RelayOutcome } from '../../lib/spectrum/persist-metadata'
import { BasketAvatar } from '../BasketAvatar'
import { BasketBento, type BentoItem } from '../BasketBento'

// ─────────────────────────────────────────────────────────────────────────────
// The deploy ceremony — the orbit → gather → drop-through-portal → "Basket Deployed"
// animation from /post-deploy-test, run on the real Launch deploy with the creator's
// own basket, then crossfading to a "ready" reveal card.
//
// The motion is rAF-driven (smooth in a live browser). A real-time backstop timer
// forces the reveal even if rAF is throttled (backgrounded tab / headless preview),
// so the flow always completes.
// ─────────────────────────────────────────────────────────────────────────────

// Chains DexScreener doesn't index (Robinhood 4663) have no slug — the orb
// skips the art fetch and renders its letters fallback instead of wrong-chain art.
const SLUG: Record<number, string> = { 1: 'ethereum', 8453: 'base' }

// One orb = one basket asset (brand-color sphere + the token's logo).
const Orb = forwardRef<HTMLDivElement, { address: string; symbol: string; chainId: number; size: number }>(
  ({ address, symbol, chainId, size }, ref) => {
    const vis = tokenVisual(symbol, address)
    const [ok, setOk] = useState(true)
    const inner = Math.round(size * 0.66)
    return (
      <div
        ref={ref}
        className="absolute left-0 top-0 flex items-center justify-center rounded-full opacity-0"
        style={{
          width: size,
          height: size,
          background: vis.color,
          border: '1px solid rgba(255,255,255,0.25)',
          boxShadow: `0 12px 30px -6px color-mix(in srgb, ${vis.color} 60%, transparent), inset 0 2px 6px rgba(255,255,255,0.4), inset 0 -6px 12px rgba(0,0,0,0.3)`,
          willChange: 'transform, opacity',
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ background: 'linear-gradient(160deg, rgba(255,255,255,0.5), rgba(255,255,255,0) 46%)' }}
        />
        {ok && SLUG[chainId] ? (
          <img
            src={`https://dd.dexscreener.com/ds-data/tokens/${SLUG[chainId]}/${address.toLowerCase()}.png?size=lg`}
            alt={symbol}
            onError={() => setOk(false)}
            className="relative rounded-full object-cover ring-1 ring-white/10"
            style={{ width: inner, height: inner }}
          />
        ) : (
          <span className="relative font-display font-bold uppercase leading-none" style={{ color: vis.ink, fontSize: Math.round(size * 0.3) }}>
            {(symbol || '?').replace(/^\$/, '').slice(0, 3)}
          </span>
        )}
      </div>
    )
  },
)
Orb.displayName = 'Orb'

const easeOutBack = (x: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
const easeInOutBack = (x: number) => {
  const c1 = 1.70158
  const c2 = c1 * 1.525
  return x < 0.5 ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2 : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2
}
const easeInQuint = (x: number) => x * x * x * x * x
const easeOutExpo = (x: number) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x))
const lerp = (start: number, end: number, amt: number) => (1 - amt) * start + amt * end

type Phase = 'FADE_IN' | 'ORBIT' | 'BUNCH' | 'DROP' | 'WAIT' | 'FADE_OUT'

const CONFIG = { fadeIn: 600, orbit: 3600, bunch: 1800, drop: 1200, wait: 1900, fadeOut: 1000, orbitSpeed: 0.002 }
const TOTAL = CONFIG.fadeIn + CONFIG.orbit + CONFIG.bunch + CONFIG.drop + CONFIG.wait + 400

export interface DeployPortalProps {
  open: boolean
  onClose: () => void
  onStartOver: () => void
  chainId: number
  name: string
  symbol: string
  grad: string
  blend: string[]
  avatarUrl?: string
  bannerUrl?: string
  creatorHandle?: string
  creatorName?: string
  creatorAddress?: string
  assets: { address: string; symbol: string }[]
  bentoItems: BentoItem[]
  /** Live on-chain deploy state (from useDeployBasket). Omit for a pure-preview ceremony. */
  deploy?: DeployPortalDeploy
  /** Post-deploy "sign & publish your profile" ceremony (from usePublish). Omit (or
   *  `enabled:false`) to navigate to the basket immediately on success, as before. */
  publish?: DeployPortalPublish
}

// Narrow view of usePublish the reveal card drives once the basket is live. The
// builder maps the hook to this so the ceremony stays decoupled from publish internals.

/** The thesis fields the ceremony collects (v4 signed struct — the creator's own words). */
export interface PublishThesisInput {
  tagline: string
  thesis: string
  sectors: string[]
  timeHorizon: string
  /** The basket's launch post on X — strictly an x.com/…/status/… link. */
  postUrl: string
}

export interface DeployPortalPublish {
  /** A deployed basket + a wallet to sign with (the ceremony itself is skippable). */
  enabled: boolean
  /** True in version mode (the blob carries `supersedes`). Tunes the copy. */
  isVersion: boolean
  status: PublishStatus
  error: string | null
  relay: RelayOutcome | null
  relayVerified: boolean
  /** Convention path the signed blob must be served from (`<chainId>/<basket>.json`). */
  path: string | null
  /** Full convention URL when a metadata host is configured, else null. */
  url: string | null
  onPublish: (thesis?: PublishThesisInput) => void
  onSkip: () => void
  onDownload: () => void
}

// Narrow view of useDeployBasket the reveal card renders — the builder maps the hook to
// this so the ceremony stays decoupled from the deploy internals.
export interface DeployPortalDeploy {
  status: DeployStatus
  attempts: number
  predicted: string | null
  priceWei: bigint | null
  txHash: string | null
  token: string | null
  error: string | null
  /** DEPLOY_ENABLED && wallet connected on this chain — gates the sign button. */
  enabled: boolean
  onSign: () => void
}

const shortHex = (h?: string | null) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '—')

export function DeployPortal({
  open,
  onClose,
  onStartOver,
  chainId,
  name,
  symbol,
  grad,
  avatarUrl,
  bannerUrl,
  creatorHandle,
  creatorName,
  creatorAddress,
  assets,
  bentoItems,
  deploy,
  publish,
}: DeployPortalProps) {
  const creator = resolveCreator({ handle: creatorHandle, name: creatorName, deployer: creatorAddress })
  const avatar = sanitizeImageUrl(avatarUrl ?? '') ?? undefined
  const banner = sanitizeImageUrl(bannerUrl ?? '') ?? undefined
  const orbTokens = assets.slice(0, 14)
  const [revealed, setRevealed] = useState(false)
  const [runId, setRunId] = useState(0)
  const navigate = useNavigate()

  const overlayRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const orbRefs = useRef<(HTMLDivElement | null)[]>([])
  const coreRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)
  const holeRef = useRef<HTMLDivElement>(null)
  const coreLightRef = useRef<HTMLDivElement>(null)
  const frontLipRef = useRef<HTMLDivElement>(null)
  const energyRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const statusTextRef = useRef<HTMLHeadingElement>(null)
  const statusSubRef = useRef<HTMLParagraphElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const successRef = useRef<HTMLDivElement>(null)

  const ORB = 56

  useEffect(() => {
    if (!open) {
      setRevealed(false)
      return
    }
    setRevealed(false)

    // Real-time backstop: guarantees the reveal even if rAF is throttled.
    const backstop = window.setTimeout(() => {
      if (overlayRef.current) overlayRef.current.style.opacity = '0'
      setRevealed(true)
    }, TOTAL + 400)

    const orbs = orbRefs.current.slice(0, orbTokens.length).filter(Boolean) as HTMLDivElement[]
    const scene = sceneRef.current
    const overlay = overlayRef.current
    const ring = ringRef.current
    const glow = glowRef.current
    const hole = holeRef.current
    const coreLight = coreLightRef.current
    const frontLip = frontLipRef.current
    const energy = energyRef.current
    const core = coreRef.current
    const header = headerRef.current
    const statusText = statusTextRef.current
    const statusSub = statusSubRef.current
    const indicator = indicatorRef.current
    const success = successRef.current
    if (!orbs.length || !scene || !overlay || !ring || !glow || !hole || !coreLight || !frontLip || !energy || !core || !header || !statusText || !statusSub || !indicator || !success)
      return () => window.clearTimeout(backstop)

    let radius = 200
    let bunchTargetY = -250
    let dropTargetY = 300
    let orbitCenterY = 0
    let orbitRy = 100

    const nodes = orbs.map((el, index) => {
      const angle = (index / orbs.length) * Math.PI * 2
      return { el, initialAngle: angle, currentX: 0, currentY: 0, startX: 0, startY: 0, bunchTargetX: Math.cos(angle) * 20, bunchTargetY: 0 }
    })

    function calculateLayout() {
      const minDim = Math.min(window.innerWidth, window.innerHeight)
      radius = minDim > 800 ? 280 : minDim > 500 ? 200 : 140
      const pr = ring!.getBoundingClientRect()
      const sr = scene!.getBoundingClientRect()
      const hr = header!.getBoundingClientRect()
      dropTargetY = pr.top + pr.height / 2 - sr.top
      const bandTop = hr.bottom + 80
      const bandBottom = pr.top - 24
      const bandCenter = (bandTop + bandBottom) / 2
      orbitCenterY = bandCenter - sr.top
      orbitRy = Math.max(48, Math.min(radius * 0.4, (bandBottom - bandTop) / 2 - ORB / 2 - 12))
      bunchTargetY = orbitCenterY - orbitRy * 0.55
      nodes.forEach((n) => {
        n.bunchTargetY = bunchTargetY + Math.sin(n.initialAngle) * 16
      })
    }

    function setStatus(text: string, sub: string, color: string, dot: string) {
      statusText!.textContent = text
      statusText!.style.color = color
      statusSub!.textContent = sub
      indicator!.style.backgroundColor = dot
    }

    function updateUIState(phase: Phase) {
      if (phase === 'FADE_IN') {
        setStatus('GATHERING ASSETS', 'Phase 1 of 3', '#c7d2fe', '#6366f1')
      } else if (phase === 'BUNCH') {
        setStatus('ASSEMBLING BASKET', 'Phase 2 of 3', '#f0abfc', '#d946ef')
        core!.style.transform = 'scale(0.5)'
        core!.style.opacity = '0'
        ring!.style.borderColor = 'rgba(217,70,219,0.4)'
        ring!.style.boxShadow = '0 0 50px rgba(192,38,211,0.4), inset 0 0 20px rgba(192,38,211,0.3)'
        frontLip!.style.borderBottomColor = 'rgba(232,121,249,0.6)'
        glow!.style.backgroundColor = 'rgba(217,70,219,0.12)'
      } else if (phase === 'DROP') {
        setStatus('DEPLOYING BASKET', 'Phase 3 of 3', '#a5f3fc', '#22d3ee')
        ring!.style.transform = 'scale(1.05)'
        ring!.style.borderColor = 'rgba(34,211,238,0.8)'
        ring!.style.boxShadow = '0 0 80px rgba(34,211,238,0.6), inset 0 0 40px rgba(34,211,238,0.5)'
        frontLip!.style.borderBottomColor = 'rgba(103,232,249,0.8)'
        glow!.style.backgroundColor = 'rgba(34,211,238,0.2)'
        hole!.style.backgroundColor = '#041224'
      } else if (phase === 'WAIT') {
        header!.style.opacity = '0'
        ring!.classList.add('portal-success-pulse')
        ring!.style.borderColor = 'rgba(52,211,153,0.85)'
        frontLip!.style.borderBottomColor = 'rgba(110,231,183,0.85)'
        coreLight!.style.backgroundColor = 'rgba(52,211,153,0.85)'
        coreLight!.style.boxShadow = '0 0 100px 30px rgba(52,211,153,0.6)'
        glow!.style.backgroundColor = 'rgba(16,185,129,0.22)'
        success!.style.opacity = '1'
        success!.style.transform = 'scale(1)'
      }
    }

    function reset() {
      core!.style.transform = 'scale(1)'
      core!.style.opacity = '1'
      ring!.classList.remove('portal-success-pulse')
      ring!.style.transform = 'scale(1)'
      ring!.style.borderColor = 'rgba(6,182,212,0.4)'
      ring!.style.boxShadow = '0 0 40px rgba(6,182,212,0.3), inset 0 0 20px rgba(6,182,212,0.3)'
      frontLip!.style.borderBottomColor = 'rgba(34,211,238,0.6)'
      hole!.style.backgroundColor = '#02040a'
      coreLight!.style.transform = 'scale(1)'
      coreLight!.style.opacity = '0.5'
      coreLight!.style.backgroundColor = 'rgba(34,211,238,0.2)'
      coreLight!.style.boxShadow = 'none'
      energy!.style.opacity = '0.6'
      glow!.style.backgroundColor = 'rgba(6,182,212,0.10)'
      header!.style.opacity = '1'
      success!.style.opacity = '0'
      success!.style.transform = 'scale(0.95)'
      setStatus('GATHERING ASSETS', 'Phase 1 of 3', '#c7d2fe', '#6366f1')
      nodes.forEach((n) => {
        n.el.style.opacity = '0'
        n.el.style.transform = 'translate(-50%, -50%) scale(0)'
        n.currentX = 0
        n.currentY = 0
        n.startX = 0
        n.startY = 0
      })
    }

    let phase: Phase = 'FADE_IN'
    let phaseStart = performance.now()
    let rafId = 0

    function animate(time: number) {
      let elapsed = time - phaseStart
      const prev = phase

      if (phase === 'FADE_IN' && elapsed > CONFIG.fadeIn) {
        phase = 'ORBIT'
        phaseStart = time
        elapsed = 0
      } else if (phase === 'ORBIT' && elapsed > CONFIG.orbit) {
        phase = 'BUNCH'
        phaseStart = time
        elapsed = 0
        nodes.forEach((n) => {
          n.startX = n.currentX
          n.startY = n.currentY
        })
      } else if (phase === 'BUNCH' && elapsed > CONFIG.bunch) {
        phase = 'DROP'
        phaseStart = time
        elapsed = 0
        nodes.forEach((n) => {
          n.startX = n.currentX
          n.startY = n.currentY
        })
      } else if (phase === 'DROP' && elapsed > CONFIG.drop) {
        phase = 'WAIT'
        phaseStart = time
        elapsed = 0
      } else if (phase === 'WAIT' && elapsed > CONFIG.wait) {
        phase = 'FADE_OUT'
        overlay!.style.opacity = '0'
        setRevealed(true)
        return
      }

      if (phase !== prev) updateUIState(phase)

      nodes.forEach((n, i) => {
        let x = 0
        let y = 0
        let scale = 1
        let opacity = 1

        if (phase === 'FADE_IN') {
          const p = Math.min(elapsed / CONFIG.fadeIn, 1)
          const a = n.initialAngle + elapsed * CONFIG.orbitSpeed
          x = Math.cos(a) * radius
          y = orbitCenterY + Math.sin(a) * orbitRy
          scale = lerp(0, 1, easeOutBack(p))
          opacity = easeOutExpo(p)
          n.currentX = x
          n.currentY = y
        } else if (phase === 'ORBIT') {
          const totalT = CONFIG.fadeIn + elapsed
          const a = n.initialAngle + totalT * CONFIG.orbitSpeed
          x = Math.cos(a) * radius
          y = orbitCenterY + Math.sin(a) * orbitRy + Math.sin(time * 0.002 + i) * 12
          n.el.style.zIndex = String(Math.round(y) + 100)
          n.currentX = x
          n.currentY = y
        } else if (phase === 'BUNCH') {
          const p = Math.min(elapsed / CONFIG.bunch, 1)
          const e = easeInOutBack(p)
          x = lerp(n.startX, n.bunchTargetX, e)
          y = lerp(n.startY, n.bunchTargetY, e)
          n.el.style.zIndex = String(200 + i)
          n.currentX = x
          n.currentY = y
        } else if (phase === 'DROP') {
          const p = Math.min(elapsed / CONFIG.drop, 1)
          x = lerp(n.startX, n.bunchTargetX * 0.1, p)
          y = lerp(n.startY, dropTargetY, easeInQuint(p))
          scale = lerp(1, 0.2, p)
          if (p > 0.8) opacity = lerp(1, 0, (p - 0.8) * 5)
          n.el.style.zIndex = '10'
          n.currentX = x
          n.currentY = y
        } else if (phase === 'WAIT' || phase === 'FADE_OUT') {
          scale = 0
          opacity = 0
        }

        n.el.style.transform = `translate(-50%, -50%) translate(${n.currentX}px, ${n.currentY}px) scale(${scale})`
        n.el.style.opacity = String(opacity)
      })

      if (phase === 'DROP') {
        const p = Math.min(elapsed / CONFIG.drop, 1)
        if (p > 0.5) {
          const r = (p - 0.5) * 2
          coreLight!.style.transform = `scale(${lerp(1, 1.8, easeOutExpo(r))})`
          coreLight!.style.opacity = String(lerp(0.5, 1, r))
          energy!.style.opacity = String(lerp(0.6, 1, r))
        }
      }

      rafId = requestAnimationFrame(animate)
    }

    calculateLayout()
    window.addEventListener('resize', calculateLayout)
    reset()
    overlay.style.opacity = '1'
    phase = 'FADE_IN'
    phaseStart = performance.now()
    updateUIState('FADE_IN')
    rafId = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(rafId)
      window.clearTimeout(backstop)
      window.removeEventListener('resize', calculateLayout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orbTokens.length, runId])

  // On a real successful deploy, hand off to the live basket page (it opens
  // straight onto the seed prompt via `deployed=1`) rather than keeping the
  // in-modal card.
  const goToBasket = useCallback(() => {
    if (!deploy?.token) return
    navigate(`/token?addr=${deploy.token}&chain=${chainId}&deployed=1`)
    onClose()
  }, [deploy?.token, chainId, navigate, onClose])

  // Once the basket is LIVE, every way out of this popup lands on the basket
  // page + its seed prompt — Escape, backdrop, footer, all of it (owner
  // 2026-07-07 12:11: "any button there should take you to seed the basket,
  // you shouldn't be able to get away from that"). Before success, exits close.
  const deployed = deploy?.status === 'success' && !!deploy.token
  const exitPortal = deployed ? goToBasket : onClose

  // The thesis form state lives HERE, not in the panel: the ceremony has ONE
  // button hierarchy (owner 2026-07-07 13:57) — Sign & publish / Skip sit in
  // the card FOOTER (the main slot), so the footer needs the form's values.
  const [pubTagline, setPubTagline] = useState('')
  const [pubThesis, setPubThesis] = useState('')
  const [pubSectors, setPubSectors] = useState<string[]>([])
  const [pubHorizon, setPubHorizon] = useState('')
  const [pubPostUrl, setPubPostUrl] = useState('')
  const pubPostUrlValid = pubPostUrl.trim() === '' || sanitizePostUrl(pubPostUrl) != null
  const pubBusy = publish?.status === 'signing' || publish?.status === 'persisting'
  const pubSettled = publish?.status === 'done' || publish?.status === 'skipped'
  const signAndPublish = () =>
    publish?.onPublish({
      tagline: pubTagline,
      thesis: pubThesis,
      sectors: pubSectors,
      timeHorizon: pubHorizon,
      postUrl: sanitizePostUrl(pubPostUrl) ?? '',
    })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitPortal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, exitPortal])

  // When there's nothing to publish (no profile / preview build), navigate straight
  // through on success — the prior behaviour. When a publish step IS enabled, hold on
  // the card so the signed blob is never lost; navigation then waits until the creator
  // publishes (Continue button) or skips.
  // Version deploys with the ceremony OFF get a SILENT lineage-only signature (one
  // wallet prompt, fired by the builder on success): hold the card until it settles
  // ('done' navigates; an error holds so the note isn't missed — the footer's
  // Continue button is always the manual way through).
  const silentLineagePending =
    !!publish && !publish.enabled && publish.isVersion && publish.status !== 'done' && publish.status !== 'skipped'
  useEffect(() => {
    if (!(open && deploy?.status === 'success' && deploy.token)) return
    if (publish?.enabled && publish.status !== 'skipped') return
    if (silentLineagePending) return
    goToBasket()
  }, [open, deploy?.status, deploy?.token, publish?.enabled, publish?.status, silentLineagePending, goToBasket])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-hidden">
      {/* dark backdrop */}
      <div className="absolute inset-0 bg-void/92 backdrop-blur-sm" />

      {/* ── animation overlay (orbs + portal + success) ─────────────────── */}
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 transition-opacity duration-1000">
        {/* status header */}
        <div ref={headerRef} className="absolute left-1/2 top-28 z-20 flex w-full -translate-x-1/2 flex-col items-center gap-2 text-center transition-opacity duration-300">
          <div className="flex items-center gap-3">
            <div ref={indicatorRef} className="h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: '#6366f1' }} />
            <h1 ref={statusTextRef} className="text-sm font-medium uppercase tracking-[0.4em] md:text-base" style={{ color: '#c7d2fe' }}>
              Gathering Assets
            </h1>
          </div>
          <p ref={statusSubRef} className="text-xs uppercase tracking-wider text-slate-500">
            Phase 1 of 3
          </p>
        </div>

        {/* scene: central core + orbs */}
        <div ref={sceneRef} className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-0 w-0">
          <div ref={coreRef} className="absolute -left-10 -top-10 flex h-20 w-20 items-center justify-center rounded-full border border-indigo-500/20 shadow-[0_0_60px_rgba(99,102,241,0.15)] transition-[transform,opacity] duration-700 ease-in-out">
            <div className="absolute inset-0 animate-pulse rounded-full bg-indigo-500/10 blur-xl" />
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-indigo-400/30 bg-indigo-400/20 shadow-[inset_0_0_15px_rgba(255,255,255,0.2)] backdrop-blur-sm">
              <div className="h-2 w-2 animate-ping rounded-full bg-indigo-200" />
            </div>
          </div>

          {orbTokens.map((t, i) => (
            <Orb
              key={`${t.address}-${i}`}
              ref={(el) => {
                orbRefs.current[i] = el
              }}
              address={t.address}
              symbol={t.symbol}
              chainId={chainId}
              size={ORB}
            />
          ))}
        </div>

        {/* portal */}
        <div className="absolute bottom-[15vh] left-0 right-0 z-30 mx-auto flex w-[400px] flex-col items-center justify-center">
          <div className="relative flex h-[100px] w-full items-center justify-center" style={{ perspective: '1000px' }}>
            <div ref={glowRef} className="absolute inset-0 m-auto h-[120px] w-[350px] rounded-[100%] blur-[50px] transition-[background-color] duration-500" style={{ backgroundColor: 'rgba(6,182,212,0.10)' }} />
            <div
              ref={ringRef}
              className="absolute inset-0 m-auto flex h-[70px] w-[280px] items-center justify-center overflow-hidden rounded-[100%] border-[2px] transition-[transform,border-color,box-shadow] duration-500"
              style={{ borderColor: 'rgba(6,182,212,0.4)', boxShadow: '0 0 40px rgba(6,182,212,0.3), inset 0 0 20px rgba(6,182,212,0.3)', backgroundColor: '#050914' }}
            >
              <div ref={energyRef} className="absolute inset-0 transition-opacity duration-300" style={{ opacity: 0.6 }}>
                <div className="portal-spin absolute inset-[-50%]" style={{ backgroundImage: 'conic-gradient(from 0deg, transparent 0 340deg, rgba(6,182,212,0.8) 360deg)' }} />
                <div className="portal-spin-reverse absolute inset-[-50%]" style={{ backgroundImage: 'conic-gradient(from 0deg, transparent 0 340deg, rgba(99,102,241,0.8) 360deg)' }} />
              </div>
              <div ref={holeRef} className="absolute flex h-[55px] w-[260px] items-center justify-center rounded-[100%] border border-cyan-900/50 shadow-[inset_0_0_30px_rgba(0,0,0,1)] transition-colors duration-500" style={{ backgroundColor: '#02040a' }}>
                <div ref={coreLightRef} className="h-[20px] w-[100px] rounded-[100%] blur-xl transition-[transform,opacity,background-color,box-shadow] duration-500" style={{ backgroundColor: 'rgba(34,211,238,0.2)' }} />
              </div>
            </div>
            <div ref={frontLipRef} className="pointer-events-none absolute inset-0 z-30 m-auto h-[70px] w-[280px] rounded-[100%] border-b-[3px] transition-colors duration-500" style={{ borderBottomColor: 'rgba(34,211,238,0.6)' }} />
          </div>
        </div>

        {/* end-of-animation message — HONEST about deploy state: the ceremony
            finishing only means the basket is ASSEMBLED. "Deployed" is earned by
            the on-chain receipt (deploy.status === 'success'), never by a timer.
            The pure-preview ceremony (no deploy prop) keeps the celebration. */}
        <div ref={successRef} className="pointer-events-none absolute inset-0 z-40 flex scale-95 items-center justify-center opacity-0 transition-[opacity,transform] duration-1000">
          <div className="text-center">
            {!deploy || deploy.status === 'success' ? (
              <>
                <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_60px_rgba(16,185,129,0.3)]">
                  <svg viewBox="0 0 24 24" className="h-9 w-9 text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.8)]" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="mb-3 font-display text-4xl font-bold tracking-tight text-white md:text-5xl">Basket Deployed</h2>
                <p className="text-sm uppercase tracking-widest text-emerald-200/80">${symbol || 'BASKET'} is live</p>
              </>
            ) : (
              <>
                <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full border border-cyan/30 bg-cyan/10 shadow-[0_0_60px_rgba(53,224,255,0.25)]">
                  <svg viewBox="0 0 24 24" className="h-9 w-9 text-cyan drop-shadow-[0_0_10px_rgba(53,224,255,0.7)]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v10m0 0l-3.5-3.5M12 13l3.5-3.5M5 21h14" />
                  </svg>
                </div>
                <h2 className="mb-3 font-display text-4xl font-bold tracking-tight text-white md:text-5xl">Basket Assembled</h2>
                <p className="text-sm uppercase tracking-widest text-cyan/80">not deployed yet, your signature launches it</p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── reveal card ─────────────────────────────────────────────────── */}
      {revealed && (
        <div className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto p-4" onClick={exitPortal}>
          <div
            // Width follows the stage: the publish ceremony spreads into two
            // columns (owner: "too vertically high — use more width, it needs
            // to all be within the viewport"), the pre-deploy card gets a
            // little more room than the old max-w-md.
            className={`relative w-full ${deployed ? 'max-w-3xl' : 'max-w-lg'}`}
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'portal-success-pulse 0.6s ease-out' }}
          >
            <div className="overflow-hidden rounded-3xl card-surface backdrop-blur-md">
              {banner && (
                <div className="relative h-24 w-full">
                  <img src={banner} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover ring-1 ring-white/10" />
                  <div aria-hidden className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(11,11,18,0.1), rgba(11,11,18,0.85))' }} />
                </div>
              )}
              <div className="relative px-6 pt-6">
                <div className="absolute -top-20 left-1/2 h-40 w-[120%] -translate-x-1/2 opacity-50 blur-3xl" style={{ background: grad }} aria-hidden />
                <div className="relative flex items-center gap-3">
                  <div className="relative shrink-0">
                    <div className="absolute -inset-1 rounded-2xl opacity-60 blur-md" style={{ background: grad }} aria-hidden />
                    <div className="relative grid h-14 w-14 place-items-center rounded-2xl ring-1 ring-white/25" style={{ background: grad }}>
                      <span className="font-display text-xl font-bold text-black/75">◆</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-cyan">${symbol || 'BASKET'}</span>
                    </div>
                    <div className="mt-1 truncate font-display text-xl font-bold uppercase leading-tight tracking-tight text-ink">{name || symbol || 'Your basket'}</div>
                  </div>
                </div>
                <StatusBadge status={deploy?.status} hasDeploy={!!deploy} />
                <div className="relative mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-dim">
                  {avatar && (
                    <BasketAvatar
                      address={creator.address ?? creatorAddress ?? '0x0000000000000000000000000000000000000000'}
                      symbol={creator.kind === 'address' ? 'x' : creator.label.replace(/^@/, '')}
                      imageUrl={avatar}
                      size={16}
                    />
                  )}
                  <span>
                    created by{' '}
                    <span className="text-ink">{creator.label}</span>
                  </span>
                </div>
              </div>

              <div className="mt-4 px-6">
                {/* Flatter bento once the card is wide (publish stage) — the
                    ceremony must fit the viewport without scrolling. */}
                <BasketBento items={bentoItems} aspect={deployed ? 3.6 : 2.4} reveal={{ delayMs: 150, stepMs: 100 }} show={revealed} />
              </div>

              <div className="mt-4 px-6 font-mono text-[10px] leading-relaxed text-ink-dim">
                {!deploy || deploy.status === 'idle' ? (
                  <>{assets.length} assets · starts at $1.00 NAV.</>
                ) : deploy.status === 'mining' ? (
                  <>Mining the 0x88 hook address… {deploy.attempts.toLocaleString()} salts tried (CREATE2)</>
                ) : deploy.status === 'preparing' ? (
                  <>Hook address mined · reading the Dutch-auction price…</>
                ) : deploy.status === 'error' ? (
                  <span className="text-rose-300">Deploy halted: {deploy.error}</span>
                ) : deploy.status === 'success' ? (
                  <div className="space-y-3">
                    <div>
                      Deployed —{' '}
                      <a
                        href={`${chainCfg(chainId).explorer}/address/${deploy.token}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan underline-offset-4 hover:underline"
                      >
                        {shortHex(deploy.token)}
                      </a>
                    </div>
                    {publish?.enabled && (
                      <PublishPanel
                        publish={publish}
                        tagline={pubTagline}
                        onTagline={setPubTagline}
                        thesis={pubThesis}
                        onThesis={setPubThesis}
                        sectors={pubSectors}
                        onSectors={setPubSectors}
                        timeHorizon={pubHorizon}
                        onTimeHorizon={setPubHorizon}
                        postUrl={pubPostUrl}
                        onPostUrl={setPubPostUrl}
                        postUrlValid={pubPostUrlValid}
                      />
                    )}
                    {publish && !publish.enabled && publish.isVersion && (
                      <SilentLineageNote status={publish.status} error={publish.error} />
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div>
                      Hook <span className="text-ink">{shortHex(deploy.predicted)}</span> · auction{' '}
                      {deploy.priceWei != null ? formatEther(deploy.priceWei) : '—'} ETH · starts at $1.00 NAV
                    </div>
                    {deploy.txHash && (
                      <div>
                        tx{' '}
                        <a
                          href={`${chainCfg(chainId).explorer}/tx/${deploy.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-cyan underline-offset-4 hover:underline"
                        >
                          {shortHex(deploy.txHash)}
                        </a>
                      </div>
                    )}
                    {deploy.enabled ? (
                      // THE deploy action — the one button that costs money. Primary
                      // gradient so it can never be mistaken for a footnote.
                      <button
                        type="button"
                        onClick={deploy.onSign}
                        disabled={deploy.status !== 'ready'}
                        className="press w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                        style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
                      >
                        {deploy.status === 'signing'
                          ? 'Confirm in wallet…'
                          : deploy.status === 'confirming'
                            ? 'Deploying…'
                            : `Sign & deploy · ${deploy.priceWei != null ? formatEther(deploy.priceWei) : '—'} ETH`}
                      </button>
                    ) : (
                      <DeployGate chainId={chainId} />
                    )}
                  </div>
                )}
              </div>

              <div className="mt-4 flex gap-2 border-t border-white/10 p-4">
                {deployed ? (
                  // The basket is LIVE: ONE button hierarchy in ONE place (owner
                  // 13:57). While the thesis form shows, the primary IS "Sign &
                  // publish" with Skip beside it (skip = straight to seeding);
                  // once published/skipped, the primary becomes Continue → seed.
                  // No Replay/Start-over once money moved.
                  publish?.enabled && !pubSettled ? (
                    <>
                      <button
                        type="button"
                        onClick={signAndPublish}
                        disabled={pubBusy || !pubPostUrlValid}
                        className="flex-1 rounded-xl py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                        style={{ background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' }}
                      >
                        {publish.status === 'signing'
                          ? 'Confirm in wallet…'
                          : publish.status === 'persisting'
                            ? 'Publishing…'
                            : publish.status === 'error'
                              ? 'Try again · sign & publish'
                              : 'Sign & publish the thesis'}
                      </button>
                      <button
                        type="button"
                        onClick={publish.onSkip}
                        disabled={pubBusy}
                        className="press rounded-xl border border-white/12 px-4 py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-ink-dim hover:enabled:border-white/30 hover:enabled:text-ink disabled:opacity-60"
                      >
                        Skip · seed the basket
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={goToBasket}
                      className="flex-1 rounded-xl py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01]"
                      style={{ background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' }}
                    >
                      Continue · seed your basket →
                    </button>
                  )
                ) : (
                  <>
                    {!deploy ? (
                      <button
                        type="button"
                        onClick={onClose}
                        className="flex-1 rounded-xl py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01]"
                        style={{ background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' }}
                      >
                        Done
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onClose}
                        className="press flex-1 rounded-xl border border-white/12 py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-ink-dim hover:border-white/30 hover:text-ink"
                      >
                        Close
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRevealed(false)
                        setRunId((n) => n + 1)
                      }}
                      className="press rounded-xl border border-white/12 px-4 py-2.5 font-mono text-[11px] uppercase tracking-wide text-ink-dim hover:border-white/30 hover:text-ink"
                    >
                      ↻ Replay
                    </button>
                    <button
                      type="button"
                      onClick={onStartOver}
                      className="press rounded-xl border border-white/12 px-4 py-2.5 font-mono text-[11px] uppercase tracking-wide text-ink-dim hover:border-white/30 hover:text-ink"
                    >
                      Start over
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}

// The silent version-link status line — the only UI the lineage signature gets
// (the ceremony stays off). It exists so the wallet prompt is never unexplained:
// an unannounced typed-data request right after a deploy reads as a drainer.
// Neutral, mechanical copy; an error is amber (recoverable from the basket page),
// never a hard stop — the footer's Continue button stays the way through.
function SilentLineageNote({ status, error }: { status: PublishStatus; error: string | null }) {
  if (status === 'skipped') return null
  if (status === 'error') {
    return (
      <p className="text-amber-200/90">
        Version link not signed{error ? `: ${error}` : ''}. Continue to seeding, you can link the
        versions any time from the basket page.
      </p>
    )
  }
  if (status === 'done') {
    return <p className="text-teal">✓ Versions linked</p>
  }
  if (status === 'persisting') {
    return <p className="text-ink-dim">Saving the version link…</p>
  }
  // idle (the builder is about to fire) / signing — one prompt, plainly announced.
  return (
    <p className="text-ink-dim">
      One more signature links this to the version it replaces, confirm it in your wallet (free,
      off-chain, no transaction).
    </p>
  )
}

// ── Publish ceremony (Phase A) ───────────────────────────────────────────────
// Shown inside the reveal card once the basket is live. The creator signs their
// profile / version-link blob in their own wallet (the FE owns no key) and it
// persists down the ladder (localStorage always · operator relay if configured ·
// download for self-host). Skippable — declining leaves honest deployer-address
// attribution. Note: the publish copy below is user-facing on a public build —
// keep it neutral and free of performance or ownership claims.
function PublishPanel({
  publish,
  tagline,
  onTagline,
  thesis,
  onThesis,
  sectors,
  onSectors,
  timeHorizon,
  onTimeHorizon,
  postUrl,
  onPostUrl,
  postUrlValid,
}: {
  publish: DeployPortalPublish
  tagline: string
  onTagline: (v: string) => void
  thesis: string
  onThesis: (v: string) => void
  sectors: string[]
  onSectors: (v: string[]) => void
  timeHorizon: string
  onTimeHorizon: (v: string) => void
  postUrl: string
  onPostUrl: (v: string) => void
  postUrlValid: boolean
}) {
  const { status, isVersion, relay, relayVerified, path, url, error } = publish
  const busy = status === 'signing' || status === 'persisting'
  // Form only — the Sign & publish / Skip / Continue actions live in the card
  // FOOTER (one button hierarchy, owner 2026-07-07 13:57). State is lifted to
  // the portal so the footer can submit it.

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-teal/30 bg-teal/[0.06] p-3">
        <div className="font-mono text-xs uppercase tracking-[0.16em] text-teal">
          ✓ {isVersion ? 'Version published' : 'Thesis published'}
        </div>
        <p className="mt-1.5 text-ink-dim">Saved to this browser, your basket shows it here now.</p>
        {relay === 'submitted' && (
          <p className="mt-1 text-ink-dim">
            {relayVerified
              ? 'Live on the metadata host ✓'
              : 'Submitted to the metadata host, it may take a moment to appear for others.'}
          </p>
        )}
        {relay === 'failed' && (
          <p className="mt-1 text-amber-300">Couldn’t reach the metadata host, download the file and host it yourself.</p>
        )}
        {relay !== 'submitted' && (
          <p className="mt-1 text-ink-dim">
            To show it to everyone,{' '}
            {url ? (
              <>place the file at <span className="text-ink">{url}</span>.</>
            ) : (
              <>add it to your site at <span className="text-ink">app/metadata/{path}</span> and redeploy.</>
            )}
          </p>
        )}
        <button
          type="button"
          onClick={publish.onDownload}
          className="press mt-2.5 rounded-lg border border-white/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-ink hover:border-white/35"
        >
          ↓ Download JSON
        </button>
      </div>
    )
  }

  if (status === 'skipped') {
    return (
      <div className="rounded-lg border border-white/12 bg-white/[0.02] p-3">
        <p className="text-ink-dim">
          Nothing published, your basket shows your wallet identity (ENS name or address).
          You can write and sign a thesis any time from the basket page.
        </p>
      </div>
    )
  }

  const labelCls = 'font-mono text-xs uppercase tracking-[0.15em] text-ink-dim'
  const inputCls =
    'mt-1.5 w-full rounded-lg border border-white/12 bg-black/45 px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/60 focus:bg-black/55 disabled:opacity-60'

  return (
    <div>
      {/* The heading IS the instruction — no wallet-mechanics preamble (owner 13:57). */}
      <div className="font-display text-lg font-bold tracking-tight text-ink">
        Create and publish a thesis for this basket
      </div>

      <div className="mt-3.5 grid gap-3 md:grid-cols-2 md:gap-4">
        <div className="space-y-3">
          <label className="block">
            <span className={labelCls}>
              Thesis title <span className="normal-case tracking-normal text-ink-faint">(the bold one-liner · optional)</span>
            </span>
            <input
              value={tagline}
              onChange={(e) => onTagline(e.target.value.slice(0, 140))}
              placeholder="Blue-chip DeFi in one basket."
              disabled={busy}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>
              Launch post <span className="normal-case tracking-normal text-ink-faint">(your X post · optional)</span>
            </span>
            <input
              value={postUrl}
              onChange={(e) => onPostUrl(e.target.value.trim())}
              placeholder="https://x.com/you/status/1234567890"
              disabled={busy}
              inputMode="url"
              className={`${inputCls} ${postUrlValid ? '' : 'border-magenta/50 focus:border-magenta/70'}`}
            />
            <span className={`mt-1 block font-mono text-[10px] ${postUrlValid ? 'text-ink-faint' : 'text-magenta'}`}>
              {postUrlValid
                ? 'Only a link to an X post is accepted, it renders next to your thesis.'
                : 'That isn’t an X post link, it must look like x.com/you/status/123…'}
            </span>
          </label>
        </div>
        <label className="flex flex-col">
          <span className={labelCls}>
            Thesis <span className="normal-case tracking-normal text-ink-faint">(why these assets, why now · optional)</span>
          </span>
          <textarea
            value={thesis}
            onChange={(e) => onThesis(e.target.value.slice(0, 4000))}
            placeholder="What you believe, what's in the basket because of it, and what would make you ship the next version."
            rows={4}
            disabled={busy}
            className={`${inputCls} flex-1 resize-y leading-relaxed md:min-h-0 md:resize-none`}
          />
          {thesis.length > 3400 && (
            <span className="mt-1 font-mono text-[10px] text-ink-faint">{4000 - thesis.length} characters left</span>
          )}
        </label>
        {/* Tags + time horizon SPAN the full width — from the title's left edge
            to the thesis card's right edge (owner 13:57). */}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px] md:col-span-2">
          <div className="block">
            <span className={labelCls}>
              Tags <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
            </span>
            <div className="mt-1.5">
              <TagInput value={sectors} onChange={onSectors} disabled={busy} />
            </div>
          </div>
          <label className="block">
            <span className={labelCls}>
              Time horizon <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
            </span>
            <select
              value={timeHorizon}
              onChange={(e) => onTimeHorizon(e.target.value)}
              disabled={busy}
              className="mt-1.5 w-full rounded-lg border border-white/12 bg-void px-3 py-2.5 text-sm text-ink outline-none focus:border-cyan/60 disabled:opacity-60"
            >
              <option value="">—</option>
              <option value="short-term">Short-term</option>
              <option value="medium-term">Medium-term</option>
              <option value="long-term">Long-term</option>
            </select>
          </label>
        </div>
      </div>

      {status === 'error' && error && (
        <p className="mt-2 text-rose-300">Couldn’t publish: {error}</p>
      )}
    </div>
  )
}

// Reveal-card status badge — tracks the REAL deploy state. "Deployed · live
// onchain" is earned by the receipt, never by the animation finishing. The
// pure-preview ceremony (no deploy prop) keeps the celebration badge.
function StatusBadge({ status, hasDeploy }: { status?: DeployStatus; hasDeploy: boolean }) {
  const deployed = !hasDeploy || status === 'success'
  const [label, tone] = deployed
    ? ['Deployed · live onchain', 'teal']
    : status === 'mining' || status === 'preparing'
      ? ['Assembling · not deployed yet', 'cyan']
      : status === 'ready'
        ? ['Ready · awaiting your signature', 'amber']
        : status === 'signing'
          ? ['Confirm in wallet…', 'amber']
          : status === 'confirming'
            ? ['Deploying…', 'amber']
            : status === 'error'
              ? ['Deploy halted', 'rose']
              : ['Not deployed yet', 'cyan']
  const tones: Record<string, string> = {
    teal: 'border-teal/30 bg-teal/10 text-teal',
    cyan: 'border-cyan/30 bg-cyan/10 text-cyan',
    amber: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
    rose: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  }
  const dot: Record<string, string> = { teal: 'bg-teal', cyan: 'bg-cyan', amber: 'bg-amber-300', rose: 'bg-rose-300' }
  return (
    <div className={`relative mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 ${tones[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot[tone]} ${tone === 'amber' ? 'animate-pulse' : ''}`} />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{label}</span>
    </div>
  )
}

// Why the "Sign & deploy" button isn't armed — named precisely, never a vague
// "off on this build" when the flag IS on (that read as mock mode). The wallet
// being on the wrong network is the common case: offer the switch right here.
function DeployGate({ chainId }: { chainId: number }) {
  const cfg = chainCfg(chainId)
  const { isConnected, chainId: walletChainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()

  if (!DEPLOY_ENABLED) {
    return (
      <div className="text-ink-dim/70">
        Basket deploy is off on this build (VITE_ENABLE_DEPLOY), but the hook address and auction price
        above are real (mined + read live), not a mock.
      </div>
    )
  }
  if (!isConnected) {
    return (
      <div className="text-amber-200/90">
        Connect a wallet (top right) to sign &amp; deploy, everything above is live, waiting on a signer.
      </div>
    )
  }
  if (walletChainId !== chainId) {
    return (
      <div className="space-y-2">
        <div className="text-amber-200/90">
          Your wallet is on the wrong network, this deploy signs on {cfg.name}.
        </div>
        <button
          type="button"
          onClick={() => switchChain({ chainId })}
          disabled={isPending}
          className="press rounded-lg border border-cyan/40 bg-cyan/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-cyan hover:enabled:bg-cyan/20 disabled:opacity-60"
        >
          {isPending ? 'Confirm in wallet…' : `Switch wallet to ${cfg.name}`}
        </button>
      </div>
    )
  }
  // enabled=false with the flag on, a wallet connected AND the right chain
  // shouldn't happen — surface it honestly rather than pretending it's fine.
  return <div className="text-amber-200/90">Deploy is not armed, reconnect your wallet and retry.</div>
}
