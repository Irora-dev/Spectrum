// ONE FLOW, ONE BUTTON — the cross-chain bundle launch (owner 2026-08-21: "there
// should never be a time where a user has multiple options, like this should
// just be one deploy flow with one button that takes the user through all the
// steps automatically, exactly like the current /create flow, where it helps
// them deploy all baskets via one button / flow and then helps them with seeding
// the basket (bridging assets if need be) and then showing them all the share
// options").
//
// What it replaces: the finalized crossDraft card used to show one "Deploy on
// <chain>" door PER CHAIN and leave the wrap and the sharing to the reader. That
// is the multiple-options state he rejected.
//
// THIS ORCHESTRATES, IT DOES NOT RE-IMPLEMENT. Every money-shaped step is the
// app's own path, reused verbatim:
//   · each chain's launch  → useDeployBasket (salt mining, live launch price,
//     the batch probe, and the first deposit riding the SAME signature when the
//     wallet can batch). Nothing about a deploy is decided here.
//   · the network hop      → useDeployAutoSwitch, the same translation the
//     single deploy and the ceremonies use, so consent cannot drift: the wallet
//     still shows its own prompt and that prompt is still the only thing that
//     changes a network.
//   · a short first deposit → the app's own BridgeFund, opened on the house
//     shortfall grammar ("Needs $X more") that use-deploy deliberately speaks so
//     a surface can offer a way through instead of dead-ending.
//   · the wrap             → useBundlePublish, the hook BundleForge itself runs.
//   · the sharing          → the REAL ShareModal in its bundle variant, the same
//     drawn card the bundle page raises.
//
// The one thing the single button CANNOT do is sign for the user: each chain's
// launch is its own transaction, so the wallet prompts per chain. That is the
// consent boundary, not a step we forgot to automate — the flow walks up to each
// prompt on its own and carries on after it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { useDeployBasket } from '../../lib/spectrum/use-deploy'
import type { DeployAssetInput } from '../../lib/spectrum/deploy'
import { resolveAsset } from '../../lib/spectrum/version-seed'
import { useDeployAutoSwitch } from '../launch/use-deploy-auto-switch'
import { useNetworkSwitch } from '../WrongNetwork'
import { useActiveChainId } from '../../lib/chain/active-chain'
import { useBundlePublish } from '../BundleForge'
import { encodeBundleParams, type Bundle as BundleT } from '../../lib/spectrum/bundle'
import { equalSplit } from '../../lib/spectrum/weights'
import { DEPLOY_ENABLED } from '../../lib/config/features'
import { chainCfg, CHAINS } from '../../lib/chain/chains'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { basketSignatureColor } from '../../lib/spectrum/signature'
import { readableInk } from '../../lib/spectrum/token-meta'
import { readBrandHex } from '../../theme/brand-colors'
import { BridgeFund } from '../BridgeFund'
import { ShareModal } from '../LaunchBanner'
import { ChainLogo } from '../ChainBadge'
import { SpectrumLoader } from '../SpectrumLoader'
import { CopyRow, cheerSpecter } from './CopyRow'
import { playSfx } from './sfx'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export interface LaunchPick {
  address: Address
  symbol: string
}
export interface LaunchBucket {
  chainId: number
  picks: LaunchPick[]
}
/** A chain's basket, live on chain. */
interface LiveLeg {
  chainId: number
  token: Address
  symbol: string
  /** the first deposit landed with it */
  seeded: boolean
  /** launched by THIS flow (a basket that was already live before we started
   *  says nothing about its first deposit, so it stays out of that note) */
  fresh: boolean
}

const shortName = (id: number) => (CHAINS[id]?.name ?? String(id)).replace(/\s*chain$/i, '')

/** The house shortfall grammar use-deploy speaks so a surface can offer a way
 *  through. Recognising it is the whole reason it is phrased that way, and it is
 *  the ONLY thing standing between a short first deposit and a dead end — so it
 *  is exported and pinned (CrossChainLaunchFlow.test.ts). A silent regex drift
 *  here does not throw, it just quietly stops offering the bridge. */
export function isShortfall(message: string | null | undefined): boolean {
  return !!message && /^Needs \$[\d,.]+ more/.test(message)
}

// ─────────────────────────────────────────────────────────────────────────────

export function CrossChainLaunchFlow({
  buckets,
  deployed = [],
  onDeployed,
  onPick,
}: {
  buckets: LaunchBucket[]
  /** baskets in this draft that are ALREADY live (a re-finalize after a partial
   *  run): they count toward the wrap and are never deployed twice */
  deployed?: { chainId: number; address: Address; symbol: string }[]
  /** each basket as it goes live — the chat remembers them for the bundle flow */
  onDeployed?: (leg: { chainId: number; address: Address; symbol: string }) => void
  /** speak a line back into the thread (the advanced doors stay conversational) */
  onPick: (line: string) => void
}) {
  const { address, isConnected } = useAccount()
  const [stage, setStage] = useState<'setup' | 'launch' | 'wrap' | 'done'>('setup')
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [seedUsd, setSeedUsd] = useState('')
  const [cursor, setCursor] = useState(0)
  /** chains the user chose to leave out after a failure — they still count as
   *  settled, or the flow waits on them forever */
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set())
  const [live, setLive] = useState<LiveLeg[]>(() =>
    deployed
      .filter((d) => buckets.some((b) => b.chainId === d.chainId))
      .map((d) => ({ chainId: d.chainId, token: d.address, symbol: d.symbol, seeded: false, fresh: false })),
  )
  const [shareOpen, setShareOpen] = useState(false)

  const nameOk = name.trim().length >= 3
  const symbolOk = /^[A-Za-z0-9]{2,11}$/.test(symbol.trim())
  const ready = nameOk && symbolOk
  const seedEach = Number(seedUsd) > 0 ? Number(seedUsd) : 0
  const chainWords = buckets.map((b) => shortName(b.chainId))

  // ── the wrap: publishing records on the VIEWING chain, same as the forge
  const wrapChainId = useActiveChainId()
  const { registry, state: pubState, error: pubError, slug, publish } = useBundlePublish(wrapChainId)

  const bundleLegs = useMemo(
    () => live.map((l) => ({ chainId: l.chainId, address: l.token, symbol: l.symbol, weight: 100 })),
    [live],
  )
  const shareUrl = useMemo(() => {
    if (bundleLegs.length === 0) return ''
    const params = encodeBundleParams({ legs: bundleLegs, by: address ?? null, name: name.trim() || null } as BundleT)
    return `${typeof window !== 'undefined' ? window.location.origin : ''}/bundle?${params.toString()}`
  }, [bundleLegs, address, name])
  const publishedUrl = useMemo(
    () => (slug && address ? `${typeof window !== 'undefined' ? window.location.origin : ''}/bundle/${address.toLowerCase()}/${slug}` : null),
    [slug, address],
  )

  // EVERY chain ACCOUNTED FOR → straight on, no second decision. Accounted for
  // means live OR skipped: keying this on live.length alone stranded the whole
  // flow in 'launch' forever the moment one chain was skipped, with no wrap and
  // no share step ever reached (found auditing my own flow, same day).
  const settled = live.length + [...skipped].filter((id) => buckets.some((b) => b.chainId === id)).length
  useEffect(() => {
    if (stage === 'launch' && buckets.length > 0 && settled >= buckets.length) setStage('wrap')
  }, [stage, settled, buckets.length])

  // the wrap needs 2+ baskets to BE a bundle; fewer is already finished
  const wrappable = live.length >= 2 && !!registry && !!address
  useEffect(() => {
    if (stage !== 'wrap') return
    if (live.length < 2 || !registry) {
      setStage('done')
      return
    }
    if (pubState === 'done') {
      cheerSpecter()
      playSfx('happy', 0.3)
      setStage('done')
    }
  }, [stage, live.length, registry, pubState])

  // THE WRAP FIRES ITSELF. His rule is one button that takes you through all the
  // steps, and the per-chain launches already auto-sign, so stopping here to ask
  // permission again would be the odd one out. The wallet prompt is still the
  // consent; if it is refused, pubState goes to error and the retry below is the
  // ONE way forward rather than a pair of competing choices.
  const wrapFired = useRef(false)
  useEffect(() => {
    if (stage !== 'wrap' || !wrappable || wrapFired.current) return
    if (pubState === 'busy' || pubState === 'done') return
    if (!address) return
    wrapFired.current = true
    void publish(address as Address, bundleLegs, name.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, wrappable, pubState, address])

  const sigHex = readBrandHex('--color-violet-bright', '#a48bff')
  const shareBundle = useMemo(
    () => ({
      url: publishedUrl ?? shareUrl,
      chainNames: live.map((l) => chainCfg(l.chainId).name),
      legs: live.map((l) => {
        // each tile painted as its basket's signature — the bundle page's own law
        const top = buckets.find((b) => b.chainId === l.chainId)?.picks[0]
        const paint = basketSignatureColor(l.token, top ? { symbol: top.symbol, address: top.address } : undefined)
        return {
          symbol: l.symbol,
          asset: l.token as string,
          targetWeightPct: Math.round(100 / Math.max(1, live.length)),
          color: paint,
          ink: /^#[0-9a-fA-F]{6}$/.test(paint) ? readableInk(paint) : '#0b0b12',
        }
      }),
    }),
    [publishedUrl, shareUrl, live, buckets],
  )

  // ── SETUP: one name, one symbol, one optional first deposit, one button
  if (stage === 'setup') {
    const inputCls =
      'w-full rounded-xl border border-white/[0.14] bg-white/[0.05] px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-white/[0.3]'
    return (
      <div className="flex w-full min-w-0 flex-col gap-2.5 sm:min-w-[var(--chat-card-min,24rem)]">
        <div className="flex flex-col gap-1.5">
          {buckets.map((b) => (
            <div key={b.chainId} className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
              <ChainLogo chainId={b.chainId} size={16} />
              <span className="font-display text-[13px] font-bold text-ink">{shortName(b.chainId)}</span>
              <span className="ml-auto min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint">
                {b.picks.map((p) => `$${showSymbol(p.symbol)}`).join(' · ')}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[13px] leading-snug text-ink-dim">
          One name and ticker for all of them, so the bundle reads as one thing. {buckets.length} baskets get made, then I wrap
          them into one page with a single buy flow.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Bundle name (min 3 chars)" aria-label="Bundle name" className={inputCls} />
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={11} placeholder="SYMBOL" aria-label="Bundle symbol" className={inputCls} />
        </div>
        <input
          value={seedUsd}
          onChange={(e) => setSeedUsd(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="First deposit per chain (optional)"
          aria-label="First deposit per chain in settlement dollars, optional"
          className={inputCls}
        />
        {seedEach > 0 && (
          <p className="text-[12px] text-ink-faint">
            ${seedEach.toLocaleString()} on each of {buckets.length} chains, ${(seedEach * buckets.length).toLocaleString()} in
            total. If a chain is short I offer the bridge there rather than failing.
          </p>
        )}
        {/* buttons BELOW the info, always */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={!ready || !isConnected || !DEPLOY_ENABLED}
            onClick={() => setStage('launch')}
            className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
            style={{ background: GRADIENT }}
          >
            Launch ${symbol.trim().toUpperCase() || '…'} on {chainWords.join(' and ')}
          </button>
        </div>
        {!isConnected && <p className="text-[12px] text-ink-faint">Connect a wallet (top right) to launch.</p>}
        {/* said out loud, never a button that presses into silence: without this
            the launch simply never started and every row sat on "starting" */}
        {!DEPLOY_ENABLED && <p className="text-[12px] text-ink-faint">Launching is switched off on this build (VITE_ENABLE_DEPLOY).</p>}
        <p className="text-[12px] text-ink-faint">
          Your wallet signs once per chain, and switches network itself when it is that chain&rsquo;s turn. Fee defaults to 1%;
          creator share and custom fees live in the composer.
        </p>
      </div>
    )
  }

  // ── LAUNCH / WRAP / DONE: one column, one running story
  const allSettled = settled >= buckets.length
  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5 sm:min-w-[var(--chat-card-min,24rem)]">
      <p className="font-display text-[13px] font-bold uppercase tracking-tight text-ink">
        Launching ${symbol.trim().toUpperCase()} · {live.length} of {buckets.length} live
      </p>
      <div className="flex flex-col gap-2">
        {buckets.map((b, i) => (
          <ChainStep
            key={b.chainId}
            chainId={b.chainId}
            picks={b.picks}
            name={name.trim()}
            symbol={symbol.trim().toUpperCase()}
            seedUsd={seedEach}
            active={stage === 'launch' && i === cursor}
            done={live.some((l) => l.chainId === b.chainId)}
            onLive={(leg) => {
              setLive((prev) => (prev.some((p) => p.chainId === leg.chainId) ? prev : [...prev, { ...leg, fresh: true }]))
              onDeployed?.({ chainId: leg.chainId, address: leg.token, symbol: leg.symbol })
              setCursor((c) => Math.max(c, i + 1))
            }}
            onSkip={() => {
              setSkipped((prev) => new Set(prev).add(b.chainId))
              setCursor((c) => Math.max(c, i + 1))
            }}
            skipped={skipped.has(b.chainId)}
          />
        ))}
      </div>

      {/* THE WRAP — reached and RUN on its own, never a decision to find */}
      {allSettled && live.length >= 2 && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3">
          <p className="text-[13px] leading-snug text-ink">
            {stage === 'done' && publishedUrl
              ? `${name.trim() || 'Your bundle'} is published: ${live.length} baskets, one page, one buy flow.`
              : stage === 'done'
                ? `${live.length} baskets are live. They are not wrapped into one page, so the share link below is what carries them.`
                : `All ${live.length} are live. Wrapping them into a single bundle page on ${shortName(wrapChainId)}, and your wallet signs once more.`}
          </p>
          {pubState === 'busy' && <SpectrumLoader size={22} label="Check your wallet. One signature writes it on-chain." />}
          {/* ONE way forward on a refusal, never a pair of competing choices:
              the retry is the button, carrying on without the wrap is a quiet
              text link because it is a consolation, not an equal option. */}
          {pubError && (
            <>
              <p className="text-[13px]" style={{ color: 'var(--color-alert)' }}>{pubError}</p>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!wrappable}
                  onClick={() => {
                    if (!address) return
                    void publish(address as Address, bundleLegs, name.trim())
                  }}
                  className="w-fit rounded-full px-4 py-2 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
                  style={{ background: GRADIENT }}
                >
                  Try the wrap again
                </button>
                <button
                  type="button"
                  onClick={() => setStage('done')}
                  className="text-[12px] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
                >
                  share them without wrapping
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* THE SHARE STEP — every option, once there is something to share */}
      {stage === 'done' && live.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border p-3" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)' }}>
          <p className="text-[13px] leading-snug text-ink">
            {live.length > 1 ? 'Share the bundle.' : `Share $${live[0].symbol}.`} The link carries your referral when a wallet is
            connected, so trades through it pay you.
          </p>
          {(publishedUrl ?? shareUrl) && <CopyRow url={publishedUrl ?? shareUrl} />}
          {live.some((l) => l.fresh && !l.seeded) && seedEach > 0 && (
            <p className="text-[12px]" style={{ color: 'var(--color-amber)' }}>
              {live.filter((l) => l.fresh && !l.seeded).map((l) => shortName(l.chainId)).join(' and ')} went live without the
              first deposit. Anyone can be first in; say &ldquo;buy&rdquo; to be that.
            </p>
          )}
          {/* buttons BELOW the info, always */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="rounded-full px-4 py-2 font-display text-[13px] font-bold text-void transition-transform hover:scale-[1.02]"
              style={{ background: GRADIENT }}
            >
              Share options
            </button>
            {publishedUrl && (
              <Link
                to={publishedUrl.replace(/^https?:\/\/[^/]+/, '')}
                className="rounded-full border border-white/[0.16] bg-white/[0.06] px-4 py-2 text-[13px] text-ink transition-colors hover:border-white/[0.3]"
              >
                Open the bundle page →
              </Link>
            )}
            <button
              type="button"
              onClick={() => onPick(`read ${live[0].token}`)}
              className="rounded-full border border-white/[0.16] px-4 py-2 text-[13px] text-ink transition-colors hover:border-white/[0.3]"
            >
              Read it here
            </button>
          </div>
        </div>
      )}

      {shareOpen && (
        <ShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          symbol={live.length > 1 ? name.trim() || 'bundle' : live[0]?.symbol ?? 'bundle'}
          name={name.trim() || 'Cross-chain bundle'}
          addr=""
          chainId={live[0]?.chainId ?? wrapChainId}
          sig={sigHex}
          buyInk={/^#[0-9a-fA-F]{6}$/.test(sigHex) ? readableInk(sigHex) : '#0b0b12'}
          holdings={[]}
          navPerToken={0}
          ageHours={null}
          navSeries={[]}
          bundle={shareBundle}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE CHAIN'S LAUNCH. Its own useDeployBasket, so each chain keeps its own state
// machine and a failure on one cannot corrupt another. It advances itself while
// `active`: resolve the legs, mine, then sign as soon as the wallet is on the
// right network. It never loops on its own errors — see signTries.
// ─────────────────────────────────────────────────────────────────────────────

function ChainStep({
  chainId,
  picks,
  name,
  symbol,
  seedUsd,
  active,
  done,
  skipped,
  onLive,
  onSkip,
}: {
  chainId: number
  picks: LaunchPick[]
  name: string
  symbol: string
  seedUsd: number
  active: boolean
  done: boolean
  /** the user left this chain out after a failure */
  skipped: boolean
  onLive: (leg: Omit<LiveLeg, 'fresh'>) => void
  onSkip: () => void
}) {
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const sw = useNetworkSwitch(chainId)
  const { prepare, broadcast, seedNow, reset, enabled, ...state } = useDeployBasket(chainId)
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [bridgeOpen, setBridgeOpen] = useState(false)

  // the same consent translation the single deploy and the ceremonies use: the
  // wallet is asked ONCE, at the moment the signature is next
  useDeployAutoSwitch({ sw, status: state.status, targetChainId: chainId, connected: isConnected, walletChainId })

  const weights = useMemo(() => equalSplit(picks.length), [picks.length])

  // ── step 1: resolve + mine, once, when it is this chain's turn
  const prepared = useRef(false)
  useEffect(() => {
    if (!active || done || prepared.current) return
    if (!enabled || !isConnected) return
    if (state.status !== 'idle') return
    prepared.current = true
    setResolveErr(null)
    setResolving(true)
    void (async () => {
      try {
        // routes re-resolved at deploy time — a stale route must not reach the salt
        const assets: DeployAssetInput[] = []
        for (const p of picks) {
          const a = await resolveAsset(p.address, chainId)
          assets.push({ address: a.address, decimals: a.decimals, route: a.route, symbol: a.symbol })
        }
        await prepare({
          name,
          symbol,
          assets,
          weights,
          feeConfig: {
            basketFeeBps: 100,
            creatorShareBps: 0,
            creatorPayout: '0x0000000000000000000000000000000000000000' as Address,
            launcher: '0x0000000000000000000000000000000000000000' as Address,
          },
          seed: seedUsd > 0 ? { depositUsd: seedUsd } : null,
        })
      } catch (e) {
        setResolveErr(e instanceof Error ? e.message.split('\n')[0] : 'a leg did not resolve')
      } finally {
        setResolving(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, done, enabled, isConnected, state.status])

  // ── step 2: sign, as soon as the wallet is actually on this chain.
  // signTries is the loop guard: broadcast() legitimately returns to 'ready'
  // once when the batch probe has to downgrade (the provider went away), and
  // that path expects a second call. Two is therefore the honest cap — after
  // that the button below is the way through, never an endless retry.
  const signTries = useRef(0)
  useEffect(() => {
    if (!active || done) return
    if (state.status !== 'ready') return
    if (!isConnected || walletChainId !== chainId) return
    if (signTries.current >= 2) return
    signTries.current += 1
    void broadcast()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, done, state.status, isConnected, walletChainId, chainId])

  // ── step 3: it is live. Announce once. A failed first deposit does NOT hold
  // the flow: the basket exists, and the retry lives right here.
  const announced = useRef(false)
  useEffect(() => {
    if (state.status !== 'success' || !state.token || announced.current) return
    announced.current = true
    onLive({ chainId, token: state.token as Address, symbol, seeded: !!state.seeded })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.token])

  const err = resolveErr ?? state.error
  const seedShort = isShortfall(state.seedError)
  const busy = resolving || state.status === 'mining' || state.status === 'preparing' || state.status === 'signing' || state.status === 'confirming' || state.status === 'seeding'
  const liveHere = state.status === 'success' && !!state.token

  const word = liveHere
    ? 'live'
    : // a basket that was ALREADY live when the flow opened, and a chain the
      // user left out, both used to read "waiting its turn" forever
      done
      ? 'already live'
      : skipped
        ? 'left out'
        : resolving
      ? 'checking every leg has a live route'
      : state.status === 'mining'
        ? `mining the address (${state.attempts.toLocaleString()} tries)`
        : state.status === 'preparing'
          ? 'reading the live deploy price'
          : state.status === 'ready'
            ? sw.switching
              ? 'asking your wallet to switch network'
              : 'ready to sign'
            : state.status === 'signing'
              ? 'check your wallet to sign'
              : state.status === 'confirming'
                ? 'on its way to the chain'
                : state.status === 'seeding'
                  ? 'making the first deposit'
                  : active
                    ? 'starting'
                    : 'waiting its turn'

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border p-3"
      style={{
        borderColor: liveHere
          ? 'color-mix(in srgb, var(--color-teal) 40%, transparent)'
          : err
            ? 'color-mix(in srgb, var(--color-alert) 40%, transparent)'
            : 'rgba(255,255,255,0.1)',
        background: liveHere ? 'color-mix(in srgb, var(--color-teal) 5%, transparent)' : 'rgba(255,255,255,0.03)',
      }}
    >
      <div className="flex items-center gap-2">
        <ChainLogo chainId={chainId} size={16} />
        <span className="font-display text-[13px] font-bold text-ink">{shortName(chainId)}</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{word}</span>
      </div>
      {busy && <SpectrumLoader size={20} label={word} />}
      {liveHere && (
        <p className="text-[12px] leading-snug text-ink-dim">
          ${showSymbol(symbol)} at <span className="font-mono text-[11px]">{state.token}</span>
          {state.hasSeed && state.seeded ? '. The first deposit landed with it.' : ''}
        </p>
      )}
      {/* a short first deposit is the one failure with a way through: the app's
          own bridge, then the deposit retries. The basket is already live. */}
      {state.seedError && (
        <>
          <p className="text-[12px] leading-snug" style={{ color: 'var(--color-amber)' }}>
            {state.seedError}
          </p>
          {/* ONE primary, and it is the ACTUAL blocker. When the wallet is
              short, bridging is the way through and retrying now would just
              fail again, so the retry drops to a text link; when the failure is
              something else, the retry IS the way through. */}
          <div className="flex flex-wrap items-center gap-2">
            {seedShort ? (
              <>
                <button
                  type="button"
                  onClick={() => setBridgeOpen(true)}
                  className="w-fit rounded-full px-4 py-2 font-display text-[12px] font-bold text-void transition-transform hover:scale-[1.02]"
                  style={{ background: GRADIENT }}
                >
                  Bridge funds to {shortName(chainId)}
                </button>
                <button
                  type="button"
                  onClick={() => void seedNow()}
                  className="text-[12px] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
                >
                  try the deposit again
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void seedNow()}
                className="w-fit rounded-full px-4 py-2 font-display text-[12px] font-bold text-void transition-transform hover:scale-[1.02]"
                style={{ background: GRADIENT }}
              >
                Try the deposit again
              </button>
            )}
          </div>
        </>
      )}
      {err && (
        <>
          <p className="text-[12px] leading-snug" style={{ color: 'var(--color-alert)' }}>
            {err}
          </p>
          {/* the retry is THE way forward; leaving the chain out is a
              consolation, so it reads as a link rather than a rival button */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                prepared.current = false
                signTries.current = 0
                setResolveErr(null)
                reset()
              }}
              className="w-fit rounded-full px-4 py-2 font-display text-[12px] font-bold text-void transition-transform hover:scale-[1.02]"
              style={{ background: GRADIENT }}
            >
              Try {shortName(chainId)} again
            </button>
            <button
              type="button"
              onClick={onSkip}
              className="text-[12px] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
            >
              carry on without {shortName(chainId)}
            </button>
          </div>
        </>
      )}
      {/* the manual door, only once the automatic path has honestly run out */}
      {!err && state.status === 'ready' && signTries.current >= 2 && (
        <button
          type="button"
          onClick={() => void broadcast()}
          className="w-fit rounded-full px-4 py-2 font-display text-[12px] font-bold text-void transition-transform hover:scale-[1.02]"
          style={{ background: GRADIENT }}
        >
          Sign to deploy on {shortName(chainId)}
        </button>
      )}
      {active && !liveHere && isConnected && walletChainId !== chainId && !err && (
        <p className="text-[12px] text-ink-faint">
          {sw.declined ? `Your wallet declined the switch. Switch it to ${shortName(chainId)} to carry on.` : `Waiting for your wallet to be on ${shortName(chainId)}.`}
        </p>
      )}
      {bridgeOpen && <BridgeFund destChainId={chainId} onClose={() => setBridgeOpen(false)} arrivalsShown={false} />}
      <p className="sr-only">{picks.map((p) => showSymbol(p.symbol)).join(', ')}</p>
      {!address && <span className="sr-only">wallet not connected</span>}
    </div>
  )
}
