import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { formatUnits, parseUnits, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import { clientFor } from '../lib/chain/rpc'
import { erc20BalanceAbi } from '../lib/spectrum/abis-v2'
import { fetchLifiQuote, LIFI_NATIVE, type LifiQuote } from '../lib/spectrum/lifi'
import {
  bridgeRows,
  dismissBridge,
  pollBridge,
  subscribeBridges,
  type PendingBridge,
} from '../lib/spectrum/bridge-pending'
import { DEFAULT_SLIPPAGE_BPS } from '../lib/spectrum/hook-data'
import { hubPay, type PayToken } from '../lib/spectrum/pay-token'
import { useBridgeLeg } from '../lib/spectrum/use-bridge-leg'
import { AssetLogo } from './AssetLogo'
import { PayTokenPicker } from './PayTokenPicker'
import { useNetworkSwitch, WrongNetworkNotice } from './WrongNetwork'

// ─────────────────────────────────────────────────────────────────────────────
// Cross-chain funding, phase 1 (owner 2026-07-29): move funds from another
// network into THIS wallet as the destination chain's settlement asset. The
// destination is always the settlement token — never a basket — so phase 2 (the
// actual buy) runs the ordinary fully-guarded console path off the ARRIVED
// amount. A cross-chain transfer only starts in the signed transaction;
// arrival is tracked via the persisted pending store (survives reloads) and
// surfaced by <BridgeBanner/> until the user acts on it.
// ─────────────────────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000)

function fmt(raw: bigint, decimals: number, dp = 5): string {
  const n = Number(formatUnits(raw, decimals))
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 10_000 ? 2 : dp })
}

/** The source-side pay token resolved to transferable facts. */
function sourceToken(pay: PayToken, srcChainId: number): { address: Address; symbol: string; decimals: number } | null {
  if (pay.kind === 'erc20') return { address: pay.address, symbol: pay.symbol, decimals: pay.decimals }
  const dep = deploymentFor(srcChainId)
  if (pay.hub === 'ETH') return { address: LIFI_NATIVE, symbol: 'ETH', decimals: 18 }
  if (pay.hub === 'WETH') return dep.weth ? { address: dep.weth as Address, symbol: 'WETH', decimals: 18 } : null
  return dep.usdc ? { address: dep.usdc as Address, symbol: chainCfg(srcChainId).usdcSymbol, decimals: 6 } : null
}

export function BridgeFund({ destChainId, onClose }: { destChainId: number; onClose: () => void }) {
  const dest = chainCfg(destChainId)
  const destUsdc = deploymentFor(destChainId).usdc
  const { address: holder, isConnected } = useAccount()

  const sources = SUPPORTED_CHAIN_IDS.filter((id) => id !== destChainId && chainCfg(id).hasLifi)
  const [srcChainId, setSrcChainId] = useState<number>(sources[0])
  const [pay, setPay] = useState<PayToken>(hubPay('ETH'))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<LifiQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  // The money path lives in useBridgeLeg (BridgeFund's extracted executor —
  // fresh quote, exact approval, verbatim send, pending row, and the unmount
  // latch that stops the transfer if this modal closes between the approval
  // and the signature; leaving mid-flow is what costs money, audit 2026-08-07).
  // This surface always showed ONE label across quote+approve, so the hook's
  // 'quoting' renders as 'approving' — every state below is unchanged.
  const legRun = useBridgeLeg()
  const phase = legRun.phase === 'quoting' ? 'approving' : legRun.phase
  // Everything between the first wallet popup and the signed transfer. Both
  // dismissal paths consult this.
  const inFlight = phase === 'approving' || phase === 'signing'
  const [error, setError] = useState<string | null>(null)
  // Armed by the first mid-flight exit attempt. A wallet that never answers
  // leaves `phase` stuck forever and this modal has no ✕ of its own, so the way
  // out must survive the guard — it is made deliberate, never taken away.
  const [confirmExit, setConfirmExit] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!inFlight || confirmExit) onClose()
      else setConfirmExit(true) // first press only arms the notice by the CTA
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, inFlight, confirmExit])

  // A source-chain switch invalidates an erc20 pick (addresses are per-chain).
  // ONLY that reset clears the amount — it was typed against a token we just
  // took away. A bare network switch (people flip chains to compare routes)
  // keeps what was typed; wiping it unconditionally read as the input eating
  // keystrokes (audit 2026-08-07). `pay` is deliberately not a dep: this fires
  // on a source switch, and the effect sees the current pick either way.
  useEffect(() => {
    if (pay.kind === 'erc20' && pay.chainId !== srcChainId) {
      setPay(hubPay('ETH'))
      setAmount('')
    }
    setQuote(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcChainId])

  const src = chainCfg(srcChainId)
  // The network this modal needs is the SOURCE chain, not the destination: the
  // transfer is signed where the funds leave from. One switch mutation for the
  // whole modal — the CTA below performs it, the notice speaks for it (the
  // 2026-08-05 wrong-network consolidation; see WrongNetwork.tsx).
  const netSwitch = useNetworkSwitch(srcChainId)
  const token = sourceToken(pay, srcChainId)
  const amountRaw = useMemo(() => {
    if (!token) return 0n
    try {
      const v = parseUnits(amount || '0', token.decimals)
      return v > 0n ? v : 0n
    } catch {
      return 0n
    }
  }, [amount, token])

  // Source-side balance (native or ERC-20, on the SOURCE chain's client).
  useEffect(() => {
    let stale = false
    setBalance(null)
    if (!holder || !token) return
    const client = clientFor(srcChainId)
    const read =
      token.address === LIFI_NATIVE
        ? client.getBalance({ address: holder })
        : client.readContract({ address: token.address, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] })
    read.then((b) => !stale && setBalance(b)).catch(() => !stale && setBalance(null))
    return () => {
      stale = true
    }
  }, [holder, srcChainId, token?.address])

  // Debounced cross-chain quote — the guarded parse refuses any route whose
  // ends differ from what we asked (lifi.ts).
  useEffect(() => {
    const my = ++seq.current
    setQuote(null)
    setQuoteError(null)
    if (!holder || !token || !destUsdc || amountRaw <= 0n) {
      setQuoting(false) // audit #5: an orphaned in-flight quote can't clear it
      return
    }
    setQuoting(true)
    const t = window.setTimeout(async () => {
      try {
        const q = await fetchLifiQuote({
          chainId: destChainId,
          fromChainId: srcChainId,
          fromToken: token.address,
          toToken: destUsdc as Address,
          fromAmount: amountRaw,
          fromAddress: holder,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        })
        if (my !== seq.current) return
        setQuote(q)
      } catch (e) {
        if (my !== seq.current) return
        setQuoteError(e instanceof Error ? e.message : String(e))
      } finally {
        if (my === seq.current) setQuoting(false)
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [holder, token?.address, srcChainId, destChainId, destUsdc, amountRaw])

  const wrongChain = netSwitch.mismatch
  const insufficient = balance != null && amountRaw > 0n && amountRaw > balance

  async function send() {
    if (!holder || !token || !destUsdc || amountRaw <= 0n || legRun.phase !== 'idle') return
    setError(null)
    setConfirmExit(false) // a retry after a failure starts from an unarmed exit
    // The executor owns the sequence (fresh quote → exact approval → verbatim
    // send → pending row) and settles back to idle on failure.
    const r = await legRun.quoteAndSendToken({
      fromChainId: srcChainId,
      toChainId: destChainId,
      fromToken: token,
      amountRaw,
      holder,
    })
    if ('error' in r) setError(r.error)
  }

  // ── CTA state ──────────────────────────────────────────────────────────────
  let cta: { label: string; onClick?: () => void; disabled: boolean }
  if (!isConnected) cta = { label: 'Connect a wallet first', disabled: true }
  else if (!destUsdc) cta = { label: `No settlement asset configured on ${dest.name}`, disabled: true }
  else if (wrongChain)
    cta = {
      label: netSwitch.switching ? 'Confirm in wallet…' : `Switch wallet to ${src.name}`,
      onClick: netSwitch.switchNow,
      disabled: netSwitch.switching,
    }
  else if (amountRaw === 0n) cta = { label: 'Enter an amount', disabled: true }
  else if (insufficient) cta = { label: `Insufficient ${token?.symbol ?? ''} on ${src.name}`, disabled: true }
  else if (quoting) cta = { label: 'Finding a route…', disabled: true }
  else if (!quote) cta = { label: 'No route available', disabled: true }
  else if (phase === 'approving') cta = { label: 'Approve in wallet…', disabled: true }
  else if (phase === 'signing') cta = { label: 'Sign in wallet…', disabled: true }
  else cta = { label: `Move funds to ${dest.name}`, onClick: () => void send(), disabled: false }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[10vh]">
      {/* THE DISMISSAL LIVES ON THE SCRIM, not on the container around it. The
          pay-token picker is a React CHILD of this modal but PORTALS out of it
          in the DOM, and React bubbles synthetic events along the REACT tree —
          so with the handler on the container, closing the PICKER by its own
          backdrop bubbled up and took the whole funding modal with it, typed
          amount and all, for someone who only meant to back out of a token
          list. The scrim is not an ancestor of the picker in either tree, so
          only a real click on the dark area reaches it. It still covers the
          full container (inset-0), so every outside-the-dialog click lands
          here exactly as before. Inert while the wallet holds a transaction. */}
      <div
        className="absolute inset-0 bg-void/85 backdrop-blur-sm"
        onClick={inFlight ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Fund this wallet on ${dest.name}`}
        className="search-pop relative w-full max-w-md overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <div className="space-y-4 p-5">
          <div>
            <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">
              Fund this wallet on {dest.name}
            </h2>
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-dim">
              Your funds arrive as {dest.usdcSymbol} in your own wallet on {dest.name}, usually within a few
              minutes. Then you complete the buy here.
            </p>
          </div>

          {phase === 'sent' ? (
            <div className="rounded-2xl border border-teal/30 bg-teal/[0.06] px-4 py-4 text-center">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">Transfer signed</div>
              <p className="mt-2 text-sm text-ink-dim">
                We&rsquo;ll track arrival here, you can close this and keep browsing. The buy console will offer
                the arrived {dest.usdcSymbol} when it lands.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="press mt-3 rounded-lg bg-cyan px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-black"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              {/* source network */}
              <div>
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">From network</div>
                <div className="flex flex-wrap gap-2">
                  {sources.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSrcChainId(id)}
                      className={`press rounded-lg border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] ${
                        id === srcChainId
                          ? 'border-cyan/50 bg-cyan/10 text-cyan'
                          : 'border-white/12 bg-white/[0.03] text-ink-dim hover:border-white/30'
                      }`}
                    >
                      {chainCfg(id).name}
                    </button>
                  ))}
                </div>
              </div>

              {/* what to send */}
              <div className="rounded-xl border border-white/[0.07] bg-black/30 px-3.5 py-2.5">
                <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                  <span>You send on {src.name}</span>
                  {balance != null && token && (
                    <button
                      type="button"
                      onClick={() => {
                        const reserve = token.address === LIFI_NATIVE ? parseUnits('0.005', 18) : 0n
                        const max = balance > reserve ? balance - reserve : 0n
                        setAmount(formatUnits(max, token.decimals))
                      }}
                      className="press whitespace-nowrap hover:text-cyan"
                    >
                      {fmt(balance, token.decimals)} · Max
                    </button>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="press flex shrink-0 items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1.5 pl-2 pr-3 hover:border-white/30"
                  >
                    {pay.kind === 'erc20' ? (
                      <AssetLogo address={pay.address} symbol={pay.symbol} chainId={srcChainId} size={20} />
                    ) : (
                      <span className="font-display text-sm font-bold text-ink">{token?.symbol ?? 'ETH'}</span>
                    )}
                    {pay.kind === 'erc20' && <span className="font-display text-sm font-bold text-ink">{showSymbol(pay.symbol)}</span>}
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink-faint" aria-hidden>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal" enterKeyHint="done" autoComplete="off"
                    placeholder="0"
                    size={1}
                    aria-label={`Amount to send from ${src.name}`}
                    className="min-w-[2.5rem] flex-1 bg-transparent text-right font-num text-2xl font-light tabular-nums text-ink outline-none placeholder:text-ink-faint"
                  />
                </div>
              </div>

              {/* what arrives */}
              <div className="rounded-xl border border-white/[0.07] bg-black/30 px-3.5 py-2.5">
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                  Arrives on {dest.name} (est.)
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-3">
                  <span className="font-display text-sm font-bold text-ink">{showSymbol(dest.usdcSymbol)}</span>
                  <span className={`font-num text-2xl font-light tabular-nums ${quote ? 'text-ink' : 'text-ink-faint'}`}>
                    {quoting ? <span className="animate-pulse">…</span> : quote ? fmt(quote.toAmount, 6) : '—'}
                  </span>
                </div>
                {quote && (
                  <div className="mt-1 font-mono text-[10px] tabular-nums text-ink-faint">
                    floor {fmt(quote.toAmountMin, 6)} · via {quote.tool} · settles in minutes, tracked here
                  </div>
                )}
              </div>

              {quoteError && amountRaw > 0n && !quoting && (
                <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-dim">
                  {quoteError}
                </p>
              )}
              {error && (
                <p className="rounded-xl border border-magenta/30 bg-magenta/[0.06] px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                  {error}
                </p>
              )}

              {/* wrong network, stated before the signature. No button of its own:
                  the CTA right below IS the switch in this state (unchanged). */}
              <WrongNetworkNotice
                sw={netSwitch}
                requiredChainId={srcChainId}
                action="This transfer starts"
                enabled={!!destUsdc}
              />

              <button
                type="button"
                disabled={cta.disabled}
                onClick={cta.onClick}
                className={`press w-full rounded-2xl py-3.5 font-display text-sm font-bold uppercase tracking-[0.15em] transition-transform hover:enabled:scale-[1.01] disabled:cursor-not-allowed ${
                  cta.disabled ? 'border border-white/12 bg-white/[0.04] text-ink-dim opacity-70' : 'text-black'
                }`}
                style={!cta.disabled ? { background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' } : undefined}
              >
                {cta.label}
              </button>

              {/* The way out while the wallet has the transaction. The backdrop
                  no longer closes and the first Escape only arms this, but a
                  wallet that never answers must not trap anyone here — and on
                  touch there is no Escape at all, so the hatch has to be a
                  control you can see and press twice. */}
              {inFlight && (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5">
                  <p className="font-mono text-[10px] leading-relaxed text-ink-dim">
                    Your wallet has the transaction. Keep this open — leaving between the approval and the
                    transfer means you paid for the approval and nothing moved.
                  </p>
                  <button
                    type="button"
                    onClick={() => (confirmExit ? onClose() : setConfirmExit(true))}
                    className="press mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint underline underline-offset-2 hover:text-ink"
                  >
                    {confirmExit ? 'Close anyway — press again' : 'Wallet never answered? Close anyway'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {pickerOpen && (
        <PayTokenPicker
          chainId={srcChainId}
          onPick={(t) => {
            setPay(t)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>,
    document.body,
  )
}

// ── the live pending banner (phase 1 → phase 2 handoff) ──────────────────────

export function useBridgesFor(chainId: number, holder: string | undefined): PendingBridge[] {
  const all = useSyncExternalStore(subscribeBridges, bridgeRows, () => [] as PendingBridge[])
  return useMemo(
    () =>
      holder
        ? all.filter((r) => r.toChainId === chainId && r.holder.toLowerCase() === holder.toLowerCase())
        : [],
    [all, chainId, holder],
  )
}

/** Two-or-more finished arrivals as ONE line: total, count, one Use-it that
 *  spends the sum and dismisses the rows it spent, and a details toggle that
 *  keeps every per-transfer fact reachable. */
function ArrivalsSummary({
  rows,
  chainId,
  onUse,
}: {
  rows: PendingBridge[]
  chainId: number
  onUse?: (arrivedRaw: bigint) => void
}) {
  const [detail, setDetail] = useState(false)
  const cfgOf = (id: number) => chainCfg(id)
  const total = rows.reduce((s, r) => s + (r.resolved?.state === 'done' ? r.resolved.toAmount : 0n), 0n)
  const symbol = cfgOf(chainId).usdcSymbol
  return (
    <div className="rounded-xl border border-teal/30 bg-teal/[0.06] px-3.5 py-2.5 font-mono text-[11px] text-ink-dim">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1">
          <span className="text-teal">
            {fmt(total, 6)} {symbol} arrived
          </span>{' '}
          across {rows.length} transfers, in your wallet now.
        </span>
        {onUse && (
          <button
            type="button"
            onClick={() => {
              onUse(total)
              for (const r of rows) dismissBridge(r.txHash)
            }}
            className="press shrink-0 rounded-lg bg-teal px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-black"
          >
            Use it
          </button>
        )}
        <button
          type="button"
          onClick={() => setDetail((v) => !v)}
          className="press shrink-0 text-cyan hover:underline"
        >
          {detail ? 'hide' : 'details'}
        </button>
        <button
          type="button"
          aria-label="Dismiss all arrivals"
          onClick={() => {
            for (const r of rows) dismissBridge(r.txHash)
          }}
          className="press shrink-0 text-ink-faint hover:text-ink"
        >
          ✕
        </button>
      </div>
      {detail && (
        <div className="mt-2 space-y-1 border-t border-teal/15 pt-2">
          {rows.map((r) => (
            <div key={r.txHash} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 tabular-nums">
                {r.resolved?.state === 'done' ? fmt(r.resolved.toAmount, 6) : ''} {symbol} from{' '}
                {cfgOf(r.fromChainId).name}
              </span>
              <a
                href={`${cfgOf(r.fromChainId).explorer}/tx/${r.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-cyan hover:underline"
              >
                tx ↗
              </a>
              <button
                type="button"
                aria-label="Dismiss this arrival"
                onClick={() => dismissBridge(r.txHash)}
                className="press shrink-0 text-ink-faint hover:text-ink"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Renders the wallet's live/finished transfers into this chain; polls the
 *  unresolved ones (12s tick). `onUse` hands the ARRIVED amount to the host
 *  console (pay = settlement, amount prefilled). */
export function BridgeBanner({
  chainId,
  onUse,
}: {
  chainId: number
  onUse?: (arrivedRaw: bigint) => void
}) {
  const { address } = useAccount()
  const rows = useBridgesFor(chainId, address)

  useEffect(() => {
    const open = rows.filter((r) => !r.resolved)
    if (open.length === 0) return
    const ctrl = new AbortController()
    const tick = () => {
      for (const r of open) void pollBridge(r, ctrl.signal)
    }
    tick()
    const t = window.setInterval(tick, 12_000)
    return () => {
      ctrl.abort()
      window.clearInterval(t)
    }
  }, [rows])

  if (rows.length === 0) return null
  const cfgOf = (id: number) => chainCfg(id)

  // TWO OR MORE FINISHED ARRIVALS COLLAPSE INTO ONE LINE (owner 2026-08-16,
  // on four stacked banners over the swap console: "shouldnt show up like
  // this"). The sum is lawful — every row here bridged INTO this chain's own
  // settlement token, so the amounts share one unit and one wallet. Use-it
  // hands the console the TOTAL and dismisses the rows it spent; the details
  // toggle keeps every per-transfer fact (source chain, amount, tx link)
  // reachable. In-flight, refunded and failed transfers never collapse:
  // each of those is its own distinct fact.
  const done = rows.filter((r) => r.resolved?.state === 'done')
  const rest = rows.filter((r) => r.resolved?.state !== 'done')
  const collapse = done.length >= 2
  const shown = collapse ? rest : rows

  return (
    <div className="space-y-2">
      {collapse && <ArrivalsSummary rows={done} chainId={chainId} onUse={onUse} />}
      {shown.map((r) => {
        const state = r.resolved?.state ?? 'pending'
        const age = Math.max(0, nowSec() - Math.floor(r.startedAt / 1000))
        const ageLabel = age < 90 ? `${age}s` : `${Math.floor(age / 60)}m`
        return (
          <div
            key={r.txHash}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3.5 py-2.5 font-mono text-[11px] ${
              state === 'done'
                ? 'border-teal/30 bg-teal/[0.06] text-ink-dim'
                : state === 'refunded' || state === 'failed'
                  ? 'border-amber-400/30 bg-amber-400/[0.06] text-ink-dim'
                  : 'border-cyan/25 bg-cyan/[0.04] text-ink-dim'
            }`}
          >
            {state === 'pending' && (
              <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-cyan" />
            )}
            <span className="min-w-0 flex-1">
              {state === 'pending' && (
                <>
                  Moving {fmt(r.fromAmountRaw, r.fromDecimals)} {r.fromSymbol} from {cfgOf(r.fromChainId).name} · ≈{' '}
                  {fmt(r.quotedToAmountRaw, 6)} {cfgOf(r.toChainId).usdcSymbol} arriving · {ageLabel}
                </>
              )}
              {state === 'done' && r.resolved?.state === 'done' && (
                <>
                  <span className="text-teal">
                    {fmt(r.resolved.toAmount, 6)} {cfgOf(r.toChainId).usdcSymbol} arrived
                  </span>{' '}
                  from {cfgOf(r.fromChainId).name}, in your wallet now.
                </>
              )}
              {state === 'refunded' && (
                <>
                  The transfer was refunded on {cfgOf(r.fromChainId).name} — your {r.fromSymbol} is back in your
                  wallet there. Nothing arrived here.
                </>
              )}
              {state === 'failed' && r.resolved?.state === 'failed' && (
                <>Transfer failed: {r.resolved.reason} Check the source transaction before retrying.</>
              )}
            </span>
            {state === 'done' && r.resolved?.state === 'done' && onUse && (
              <button
                type="button"
                onClick={() => {
                  if (r.resolved?.state === 'done') onUse(r.resolved.toAmount)
                  dismissBridge(r.txHash)
                }}
                className="press shrink-0 rounded-lg bg-teal px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-black"
              >
                Use it
              </button>
            )}
            <a
              href={`${cfgOf(r.fromChainId).explorer}/tx/${r.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-cyan hover:underline"
            >
              tx ↗
            </a>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissBridge(r.txHash)}
              className="press shrink-0 text-ink-faint hover:text-ink"
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
