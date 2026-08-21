// In-chat basket deploy (owner 2026-08-19 21:2x: "the agent shouldn't ever via
// the primary flow force you out of the chat"). A thin chat skin over the
// app's OWN deploy engine — useDeployBasket owns salt mining, the live price,
// the batch probe, and the wallet calls; this card only collects name/symbol
// (+ an optional first deposit) and narrates the state machine in bubbles'
// language. The composer stays linked as the advanced door, never the primary.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { useDeployBasket } from '../../lib/spectrum/use-deploy'
import { resolveAsset } from '../launch/BasketBuilder'
import type { DeployAssetInput } from '../../lib/spectrum/deploy'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { CHAINS } from '../../lib/chain/chains'
import { DEPLOY_ENABLED } from '../../lib/config/features'
import { basketHref } from '../../lib/spectrum/short-url'
import { useNetworkSwitch } from '../WrongNetwork'
import { BridgeFund } from '../BridgeFund'
import { isShortfall } from './CrossChainLaunchFlow'
import { CopyRow } from './CopyRow'
import { playSfx } from './sfx'
import { SpectrumLoader } from '../SpectrumLoader'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function DeployCard({
  chainId,
  legs,
  weights,
  initialName,
  initialSymbol,
  onLive,
}: {
  chainId: number
  legs: { address: Address; symbol: string }[]
  weights: number[]
  /** Prefilled identity — the version flow seeds these from the predecessor so
   *  a successor does not start from an empty name. Additive; every existing
   *  caller keeps the blank fields. */
  initialName?: string
  initialSymbol?: string
  /** the deployed basket is live — the page stages it + celebrates (and the
   *  chat remembers it for the bundle flow, hence the symbol) */
  onLive: (token: Address, symbol: string) => void
}) {
  const { isConnected, chainId: walletChainId } = useAccount()
  const sw = useNetworkSwitch(chainId)
  const { prepare, broadcast, seedNow, reset, enabled, ...state } = useDeployBasket(chainId)
  const [name, setName] = useState(initialName ?? '')
  const [symbol, setSymbol] = useState((initialSymbol ?? '').toUpperCase())
  const [seedUsd, setSeedUsd] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [bridgeOpen, setBridgeOpen] = useState(false)

  const ready = name.trim().length >= 3 && /^[A-Za-z0-9]{2,11}$/.test(symbol.trim())
  const chainName = CHAINS[chainId]?.name ?? chainId
  const seed = Number(seedUsd)

  // 'seeding' BELONGS HERE. Leaving it out was a money footgun, not a cosmetic
  // gap: during an in-flight first deposit the primary re-armed as an enabled
  // "Mine the address", and pressing it re-mined a fresh salt under the running
  // seed — a second deploy and a second launch fee for one intent.
  const busy =
    resolving ||
    state.status === 'mining' ||
    state.status === 'preparing' ||
    state.status === 'signing' ||
    state.status === 'confirming' ||
    state.status === 'seeding'

  async function start() {
    if (!ready || busy) return
    setResolveErr(null)
    setResolving(true)
    try {
      // routes re-resolved at deploy time — a stale route must not reach the salt
      const assets: DeployAssetInput[] = []
      for (const l of legs) {
        const a = await resolveAsset(l.address, chainId)
        assets.push({ address: a.address, decimals: a.decimals, route: a.route, symbol: a.symbol })
      }
      await prepare({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        assets,
        weights,
        feeConfig: {
          basketFeeBps: 100,
          creatorShareBps: 0,
          creatorPayout: '0x0000000000000000000000000000000000000000' as Address,
          launcher: '0x0000000000000000000000000000000000000000' as Address,
        },
        seed: seed > 0 ? { depositUsd: seed } : null,
      })
    } catch (e) {
      setResolveErr(e instanceof Error ? e.message.split('\n')[0] : 'a leg did not resolve')
    } finally {
      setResolving(false)
    }
  }

  const announced = useRef(false)
  useEffect(() => {
    if (state.status === 'success' && state.token && !announced.current) {
      announced.current = true
      playSfx('happy', 0.3)
      onLive(state.token, symbol.trim().toUpperCase())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.token, onLive])

  const inputCls =
    'w-full rounded-xl border border-white/[0.14] bg-white/[0.05] px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-white/[0.3]'

  if (state.status === 'success' && state.token) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border p-4" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)' }}>
        <p className="text-sm font-semibold text-ink">
          ${symbol.trim().toUpperCase()} is LIVE on {chainName} at{' '}
          <span className="font-mono text-[12px]">{state.token}</span>
        </p>
        {state.hasSeed && state.seeded && <p className="text-[13px] text-ink-dim">First deposit landed with it. It is a real basket now.</p>}
        {/* a failed first deposit used to end here, with the reason and nothing
            to do about it — even though the hook exports seedNow. When the
            wallet is simply short, the bridge is the way through and a retry
            would fail again, so IT leads and the retry drops to a link. */}
        {state.hasSeed && !state.seeded && state.seedError && (
          <>
            <p className="text-[13px]" style={{ color: 'var(--color-amber)' }}>Deployed, but the seed did not land: {state.seedError}</p>
            <div className="flex flex-wrap items-center gap-2">
              {isShortfall(state.seedError) ? (
                <>
                  <button
                    type="button"
                    onClick={() => setBridgeOpen(true)}
                    className="w-fit rounded-full px-4 py-2 font-display text-[12px] font-bold text-void transition-transform hover:scale-[1.02]"
                    style={{ background: GRADIENT }}
                  >
                    Bridge funds to {chainName}
                  </button>
                  <button type="button" onClick={() => void seedNow()} className="text-[12px] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink">
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
        {!state.hasSeed && <p className="text-[13px] text-ink-dim">It holds nothing yet. The first buy seeds it: say &ldquo;buy $25 of ${symbol.trim().toUpperCase()}&rdquo;.</p>}
        {/* THE SHARE STEP (owner 2026-08-21: the flow should end by "showing
            them all the share options"). It used to stop at "deployed". */}
        <CopyRow url={`${typeof window !== 'undefined' ? window.location.origin : ''}${basketHref({ symbol: symbol.trim().toUpperCase(), address: state.token, chainId })}`} />
        {bridgeOpen && <BridgeFund destChainId={chainId} onClose={() => setBridgeOpen(false)} arrivalsShown={false} />}
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Basket name (min 3 chars)" aria-label="Basket name" className={inputCls} />
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={11} placeholder="SYMBOL" aria-label="Basket symbol" className={inputCls} />
      </div>
      <input
        value={seedUsd}
        onChange={(e) => setSeedUsd(e.target.value.replace(/[^0-9.]/g, ''))}
        inputMode="decimal"
        placeholder="First deposit in USDC (optional, rides the same signature where the wallet can batch)"
        aria-label="First deposit in USDC, optional"
        className={inputCls}
      />
      {state.status === 'ready' && state.predicted && (
        <p className="text-[13px] leading-relaxed text-ink-dim">
          Mined. It will live at <span className="font-mono text-[11px]">{state.predicted}</span>, deploy cost{' '}
          {state.priceWei != null ? `${(Number(state.priceWei) / 1e18).toFixed(5)} native` : 'read'} (carried as a maximum, a repricing reverts).
          {state.canBatch === false && ' Your wallet cannot batch: the deploy and the seed sign separately.'}
        </p>
      )}
      {busy && (
        <SpectrumLoader
          size={26}
          label={
            resolving
              ? 'Checking every leg has a live route…'
              : state.status === 'mining'
                ? `Mining the address (${state.attempts.toLocaleString()} tries)…`
                : state.status === 'preparing'
                  ? 'Reading the live deploy price…'
                  : state.status === 'signing'
                    ? 'Check your wallet to sign. On phones the wallet app opens.'
                    : state.status === 'seeding'
                      ? 'Making the first deposit…'
                      : 'On its way to the chain…'
          }
        />
      )}
      {(resolveErr || state.error) && <p className="text-[13px]" style={{ color: 'var(--color-alert)' }}>{resolveErr ?? state.error}</p>}
      {/* buttons BELOW the info, always */}
      <div className="flex flex-wrap items-center gap-2.5">
        {state.status !== 'ready' ? (
          <button
            type="button"
            disabled={!ready || busy || !isConnected || walletChainId !== chainId || !enabled}
            onClick={() => void start()}
            className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
            style={{ background: GRADIENT }}
          >
            {busy ? 'Working…' : `Mine the address on ${chainName}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void broadcast()}
            className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform hover:scale-[1.02]"
            style={{ background: GRADIENT }}
          >
            Deploy ${symbol.trim().toUpperCase() || '…'}, your wallet signs
          </button>
        )}
        {state.status === 'error' && (
          <button type="button" onClick={reset} className="rounded-full border border-white/[0.16] px-4 py-2.5 text-[13px] text-ink transition-colors hover:border-white/[0.3]">
            Start again
          </button>
        )}
      </div>
      {!isConnected && <p className="text-[12px] text-ink-faint">Connect a wallet (top right) to deploy.</p>}
      {/* a real switch button, not a geography instruction — the app's own
          useNetworkSwitch, the same one every other surface offers */}
      {isConnected && walletChainId !== chainId && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={sw.switching}
            onClick={sw.switchNow}
            className="rounded-full border border-white/[0.16] px-4 py-2 text-[12px] text-ink transition-colors enabled:hover:border-white/[0.3] disabled:opacity-50"
          >
            {sw.switching ? 'Check your wallet…' : `Switch wallet to ${chainName}`}
          </button>
          {sw.declined && <span className="text-[12px] text-ink-faint">Your wallet declined the switch.</span>}
        </div>
      )}
      {/* said out loud rather than a button that presses into nothing */}
      {!DEPLOY_ENABLED && <p className="text-[12px] text-ink-faint">Launching is switched off on this build (VITE_ENABLE_DEPLOY).</p>}
      {bridgeOpen && <BridgeFund destChainId={chainId} onClose={() => setBridgeOpen(false)} arrivalsShown={false} />}
      <p className="text-[12px] text-ink-faint">
        Fee defaults to 1%. Creator share, custom fees and backtests live in the{' '}
        <Link to={`/createbasket?tokens=${legs.map((l) => l.address).join(',')}&weights=${weights.join(',')}&chain=${chainId}`} className="underline underline-offset-2 hover:text-ink">
          composer
        </Link>{' '}
        if you want them.
      </p>
      <p className="sr-only">{legs.map((l) => showSymbol(l.symbol)).join(', ')}</p>
    </div>
  )
}
