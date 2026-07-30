import { useEffect, useState } from 'react'
import { encodeFunctionData, formatEther, parseUnits } from 'viem'
import { useAccount, useBalance, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi'
import { deploymentFor } from '../lib/chain/deployments'
import { chainCfg } from '../lib/chain/chains'
import { BURNER, BURNER_V2, BURNER_V2_SLICE_WEI, BURN_PRICE_TOKEN, burnerV2Abi, incumbentBurnerAbi } from '../lib/prism/burn'

// ─────────────────────────────────────────────────────────────────────────────
// The AUCTION BURN canvas (owner 2026-07-07 15:32: "a big canvas that anyone
// can use to burn the ETH / buy and burn the PRISM from the auction fees — we
// don't display that anywhere"). Two permissionless cranks, Ethereum mainnet:
//
//   1. factory.flushAuctionProceeds()  — sends the factory's held auction ETH
//      to the PrismBurner (which burner = the factory's own constant).
//   2. the burner's flush — swaps that ETH for PRISM in the V4 pool and sends
//      it to 0x…dEaD. WHICH burner + WHICH call comes from lib/prism/burn.ts:
//      the incumbent takes whole-balance flush(minPrismOut); the v2 burner
//      (live, flips in with the new factory book) sizes via
//      flushAmount(slice, minPrismOut) and REFUSES floorless/oversized burns —
//      the canvas drains it in slices, syncNFTs-style.
//
// The floor is an OFF-CHAIN quote (DexScreener × 0.9) in both modes — that is
// the real anti-sandwich guard; v2's on-chain minOutFloor is spot-derived and
// deliberately not used as the quote. Facts only in the copy; no value claims.
// ─────────────────────────────────────────────────────────────────────────────

// Typed `number`, not the literal 1: the wagmi config registers chains as
// Chain[] (ids: number), and a literal chainId makes SelectChains Extract to
// `never`, collapsing every mutation overload in this file.
const CHAIN: number = 1 // verified on Ethereum mainnet; Base's burn path isn't wired here
const DEAD = '0x000000000000000000000000000000000000dEaD'

// Sent as raw calldata via sendTransaction — wagmi v2's writeContract
// generics collapse on these single-function ABIs; the bytes are identical.
const FLUSH_AUCTION_SELECTOR = '0x8240efb2' as const // flushAuctionProceeds()

const BTN =
  'press inline-flex items-center justify-center gap-2 rounded-xl border border-cyan/40 bg-cyan/[0.08] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cyan transition-colors hover:enabled:border-cyan hover:enabled:bg-cyan/15 disabled:cursor-not-allowed disabled:opacity-40'

type Phase = 'idle' | 'signing' | 'confirming'

export function AuctionBurnCanvas() {
  const dep = deploymentFor(CHAIN)
  const factory = dep.factory as `0x${string}` | undefined
  const cfg = chainCfg(CHAIN)
  const { isConnected, chainId: walletChain } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const client = usePublicClient({ chainId: CHAIN })

  const { data: factoryBal, refetch: refetchFactory } = useBalance({
    address: factory,
    chainId: CHAIN,
    query: { enabled: !!factory, refetchInterval: 60_000 },
  })
  const { data: burnerBal, refetch: refetchBurner } = useBalance({
    address: BURNER,
    chainId: CHAIN,
    query: { refetchInterval: 60_000 },
  })

  // PRISM-per-ETH estimate — sets the AUTOMATIC slippage floor (owner 15:47:
  // the manual field was "so confusing… set it for the user behind the
  // scenes"). Floor = estimate × 0.9; without an estimate the crank waits
  // (a floorless burn would be sandwich bait, so protection never drops).
  const [prismPerEth, setPrismPerEth] = useState<number | null>(null)
  useEffect(() => {
    let gone = false
    void (async () => {
      try {
        const r = await fetch(`https://api.dexscreener.com/tokens/v1/ethereum/${BURN_PRICE_TOKEN}`, { headers: { Accept: 'application/json' } })
        if (!r.ok) return
        const pairs = (await r.json()) as { priceNative?: string; quoteToken?: { symbol?: string }; liquidity?: { usd?: number } }[]
        const best = (Array.isArray(pairs) ? pairs : [])
          .filter((p) => p.quoteToken?.symbol === 'WETH' && p.priceNative)
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
        const native = best ? parseFloat(best.priceNative!) : NaN
        if (!gone && Number.isFinite(native) && native > 0) setPrismPerEth(1 / native)
      } catch {
        /* estimate only — the input stays manual */
      }
    })()
    return () => {
      gone = true
    }
  }, [])
  // v2 burns in slices (the pool refuses oversized burns); the incumbent takes
  // the whole balance. The floor prices the SLICE actually being burned.
  const sliceWei =
    BURNER_V2 && burnerBal ? (burnerBal.value < BURNER_V2_SLICE_WEI ? burnerBal.value : BURNER_V2_SLICE_WEI) : (burnerBal?.value ?? 0n)
  const sliceEth = Number(formatEther(sliceWei))
  const estPrism = prismPerEth != null && sliceEth > 0 ? sliceEth * prismPerEth : null
  const autoFloor = estPrism != null ? estPrism * 0.9 : null
  const slicesLeft = BURNER_V2 && burnerBal && burnerBal.value > 0n ? Number((burnerBal.value + BURNER_V2_SLICE_WEI - 1n) / BURNER_V2_SLICE_WEI) : 0

  const [phase, setPhase] = useState<{ step: 1 | 2; p: Phase } | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function crank(step: 1 | 2) {
    if (!factory || !client) return
    setError(null)
    setLastTx(null)
    try {
      if (walletChain !== CHAIN) await switchChainAsync({ chainId: CHAIN })
      setPhase({ step, p: 'signing' })
      const floor = parseUnits((autoFloor ?? 0).toFixed(6), 18)
      const data =
        step === 1
          ? FLUSH_AUCTION_SELECTOR
          : BURNER_V2
            ? encodeFunctionData({ abi: burnerV2Abi, functionName: 'flushAmount', args: [sliceWei, floor] })
            : encodeFunctionData({ abi: incumbentBurnerAbi, functionName: 'flush', args: [floor] })
      const hash = await sendTransactionAsync({ to: step === 1 ? factory : BURNER, data, chainId: CHAIN })
      setPhase({ step, p: 'confirming' })
      await client.waitForTransactionReceipt({ hash })
      setLastTx(hash)
      void refetchFactory()
      void refetchBurner()
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
      setError(msg.slice(0, 140))
    } finally {
      setPhase(null)
    }
  }

  if (!factory) return null
  const busy = (step: 1 | 2) => (phase?.step === step ? (phase.p === 'signing' ? 'Confirm in wallet…' : 'Confirming…') : null)

  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/12 bg-white/[0.02] backdrop-blur-md">
      {/* ember field — the burn's own identity */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-magenta/15 blur-[100px]" />
        <div className="absolute -bottom-24 left-1/4 h-64 w-64 rounded-full bg-violet/15 blur-[110px]" />
      </div>

      <div className="relative p-6 sm:p-7">
        <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-ink sm:text-4xl">Auction burn</h2>
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          anyone can crank · gas only · Ethereum
        </div>

        {/* the two steps STACKED — step 1 above step 2 (owner 15:47), each in
            a gradient outline, a downward arrow bridging them (owner 15:55) */}
        <div className="mt-5">
          {/* step 1 — factory → burner */}
          <div className="rounded-2xl p-px" style={{ background: 'linear-gradient(135deg, rgba(53,224,255,0.45), rgba(164,139,255,0.25), rgba(255,77,184,0.35))' }}>
          <div className="rounded-[calc(var(--radius-2xl)_-_1px)] bg-panel p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Step 1 · factory holds</div>
            <div className="mt-2 font-num text-5xl font-light tabular-nums text-ink">
              {factoryBal ? Number(formatEther(factoryBal.value)).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}{' '}
              <span className="text-xl text-ink-dim">ETH</span>
            </div>
            <p className="mt-3 max-w-[26rem] text-balance text-sm leading-snug text-ink-dim">
              Auction fees waiting on the{' '}
              <a href={`${cfg.explorer}/address/${factory}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
                factory
              </a>
              . Flushing sends all of it to the burner.
            </p>
            <button
              type="button"
              disabled={!isConnected || !factoryBal || factoryBal.value === 0n || phase != null}
              onClick={() => void crank(1)}
              className={`${BTN} mt-4 w-full`}
            >
              {busy(1) ?? 'Flush to the burner'}
            </button>
          </div>
          </div>

          {/* the flow arrow — step 1 feeds step 2 */}
          <div aria-hidden className="flex justify-center py-1.5">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4v16m0 0l-5-5m5 5l5-5" />
            </svg>
          </div>

          {/* step 2 — burner → PRISM → dEaD */}
          <div className="rounded-2xl p-px" style={{ background: 'linear-gradient(135deg, rgba(255,77,184,0.4), rgba(164,139,255,0.25), rgba(53,224,255,0.35))' }}>
          <div className="rounded-[calc(var(--radius-2xl)_-_1px)] bg-panel p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Step 2 · burner holds</div>
            <div className="mt-2 font-num text-5xl font-light tabular-nums text-ink">
              {burnerBal ? Number(formatEther(burnerBal.value)).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}{' '}
              <span className="text-xl text-ink-dim">ETH</span>
            </div>
            <p className="mt-3 max-w-[26rem] text-balance text-sm leading-snug text-ink-dim">
              Swaps the ETH for PRISM and sends it to{' '}
              <a href={`${cfg.explorer}/address/${DEAD}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
                the dead address
              </a>
              . Gone for good.
            </p>
            <button
              type="button"
              disabled={!isConnected || !burnerBal || burnerBal.value === 0n || phase != null || autoFloor == null}
              onClick={() => void crank(2)}
              className={`${BTN} mt-4 w-full`}
            >
              {busy(2) ??
                (BURNER_V2 && slicesLeft > 1
                  ? `Buy & burn next ${sliceEth.toLocaleString('en-US', { maximumFractionDigits: 2 })} ETH (${slicesLeft} slices left)`
                  : 'Buy & burn PRISM')}
            </button>
            {/* the slippage guard is AUTOMATIC — one honest line, no field */}
            <p className="mt-2 text-center font-mono text-[10px] text-ink-faint">
              {burnerBal && burnerBal.value === 0n
                ? 'Nothing to burn yet — run step 1 first.'
                : autoFloor != null
                  ? BURNER_V2
                    ? `Sandwich-protected: this slice reverts under ≈ ${autoFloor.toLocaleString('en-US', { maximumFractionDigits: 2 })} PRISM. A revert is the contract refusing a bad burn — repeat with a fresh quote; the pool absorbs the balance in slices.`
                    : `Sandwich-protected: reverts under ≈ ${autoFloor.toLocaleString('en-US', { maximumFractionDigits: 2 })} PRISM.`
                  : 'Waiting for a live price to set the protection floor…'}
            </p>
          </div>
          </div>
        </div>

        {(lastTx || error) && (
          <div className="mt-3 font-mono text-[11px]">
            {lastTx && (
              <span className="text-ink-dim">
                ✓ Crank confirmed ·{' '}
                <a href={`${cfg.explorer}/tx/${lastTx}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
                  view tx ↗
                </a>
              </span>
            )}
            {error && <span className="text-magenta">{error}</span>}
          </div>
        )}
        {!isConnected && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('spectrum:connect'))}
            className="press mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan underline underline-offset-2 hover:text-ink"
          >
            Connect a wallet to crank
          </button>
        )}
      </div>
    </section>
  )
}
