import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { isAddress, parseEther, type Address } from 'viem'
import { TRADING_ENABLED } from '../lib/config/features'
import { DEFAULT_CHAIN_ID, chainCfg } from '../lib/chain/chains'
import { usePortfolio, useBasketData, useAllBaskets } from '../lib/spectrum/hooks'
import { fetchFeeState, useFeeState, type FrontendAccrual } from '../lib/spectrum/use-fee-state'
import { useFeeActions, CLAIM_KEY, BURN_KEY, REDEEM_KEY, frontendKey, type TxState } from '../lib/spectrum/use-fee-actions'
import { PROTOCOL_FEE_MODEL } from '../lib/spectrum/fee-model'
import { basketAbi } from '../lib/spectrum/abis-v2'
import { fetchBurnEligible, useBurnEligibility } from '../lib/spectrum/flush-eligibility'
import { useQueries } from '@tanstack/react-query'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'
import { AuctionBurnCanvas } from '../components/AuctionBurnCanvas'
import { PageHeader } from '../components/PageHeader'
import { WalletButton } from '../components/WalletButton'
import { formatGrouped, shortAddr } from '../lib/spectrum/format'

// The Created-basket admin bar (Portfolio) and the standalone /flush nav both
// land here. With ?basket=&chain= we open that basket's fee console; without, a
// picker of the wallet's baskets. The whole surface is TRADING-gated (it signs
// txs); a direct URL with the flag off redirects home, page stays in the tree.

// Mirrors Portfolio's DEV preview wallet (= the dev fixture's MOCK_DEPLOYER) so
// `npm run dev` renders the console populated without a connected wallet.
const DEV_PREVIEW_ADDRESS = '0x000000000000000000000000000000000000d0e0'
const BOUNTY_PCT = PROTOCOL_FEE_MODEL.CRANK_BOUNTY_BPS / 100

const usd = (n: number) =>
  '$' + (isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const BTN_PRIMARY =
  'press inline-flex items-center justify-center gap-2 rounded-xl border border-cyan/40 bg-cyan/[0.08] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cyan transition-colors hover:border-cyan hover:bg-cyan/15 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-cyan/[0.08] disabled:hover:border-cyan/40'
const BTN_GHOST =
  'press inline-flex items-center justify-center gap-2 rounded-xl border border-white/12 px-3.5 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-white/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40'
const CHIP = 'rounded-full border border-white/12 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.15em] text-ink-faint'

function BountyChip() {
  return <span className={`${CHIP} border-cyan/25 text-cyan/80`}>{BOUNTY_PCT}% bounty</span>
}

export function Flush() {
  const [params] = useSearchParams()
  // Constant per build — the redirect is consistent across renders, so the hook
  // above is never skipped conditionally.
  if (!TRADING_ENABLED) return <Navigate to="/" replace />

  const basketParam = params.get('basket')
  const chainId = Number(params.get('chain')) || DEFAULT_CHAIN_ID
  const basket = basketParam && isAddress(basketParam) ? (basketParam as Address) : null

  return basket ? <FeeConsole basket={basket} chainId={chainId} /> : <FlushPicker />
}

// ── Picker (no ?basket=) ─────────────────────────────────────────────────────

function FlushPicker() {
  const { address, isConnected } = useAccount()
  const effective = isConnected && address ? address : import.meta.env.DEV ? DEV_PREVIEW_ADDRESS : undefined
  const { data: p } = usePortfolio(effective)
  // GLOBAL flush (owner 15:47: "shouldn't the fees and cranks be seen by
  // everyone?") — yes, with the contracts as they are: fee state is public
  // per-basket views, so every directory basket gets a card. Personal rows
  // inside a card simply read zero for non-holders; the cranks are everyone's.
  const { data: all } = useAllBaskets()

  if (!effective) return <ConnectPrompt />

  const created = p?.created ?? []
  // Held baskets the wallet didn't create (creators see theirs under "created").
  const heldOnly = (p?.holdings ?? [])
    .map((h) => h.basket)
    .filter((b) => !created.some((c) => c.address.toLowerCase() === b.address.toLowerCase()))
  // One global list, yours first (owner 16:06).
  const mineKeys = new Set([...created, ...heldOnly].map((b) => `${b.chainId}:${b.address.toLowerCase()}`))
  const sorted = (all ?? [])
    .map((b) => ({ b, mine: mineKeys.has(`${b.chainId}:${b.address.toLowerCase()}`) }))
    .sort((x, y) => Number(y.mine) - Number(x.mine))

  return (
    <div className="space-y-8">
      {/* the eyebrow/sub prose is gone (owner 12:34) — the numbers on each row
          say what this page is for */}
      <PageHeader title={<>Fees &amp; cranks</>} />

      {/* COLUMNS (owner 15:47/15:55): GLOBAL flush leads the wide left column
          (it renders the moment the directory loads — never behind the
          portfolio's loading state, which once hid it entirely); your baskets
          fold into a dropdown beneath; the auction burn rides the right. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5 px-1">
              <div className="flex items-baseline gap-2.5">
                <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">Global flush</h2>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  every basket · fees &amp; cranks are public — anyone can flush
                </span>
              </div>
              <GlobalCrankButton baskets={all ?? []} />
            </div>
            {(all ?? []).length === 0 ? (
              <div className="rounded-2xl card-surface p-8 text-center text-sm text-ink-faint">Loading baskets…</div>
            ) : (
              <div className="space-y-3">
                {/* ONE list, YOURS pinned on top (owner 16:06: "your baskets
                    should appear at the top" — replaces the earlier fold) */}
                {sorted.map(({ b, mine }) => (
                  <BasketFeeCard key={`${b.chainId}:${b.address}`} b={b} holder={effective as Address} mine={mine} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* the protocol-level crank — permissionless, its own column */}
        <div className="min-w-0 lg:sticky lg:top-24">
          <AuctionBurnCanvas />
        </div>
      </div>
    </div>
  )
}

// One compact block inside a basket's fee card (owner 16:48 layout): the
// title reads big top-left, the ACTION sits top-right on every card alike,
// the chip drops under the title, the amount anchors bottom-left.
function FeeLine({
  label,
  chip,
  value,
  hot,
  action,
  tx,
  explorer,
}: {
  label: string
  chip?: string
  value: string
  hot?: boolean
  action: ReactNode
  tx: TxState
  explorer: string
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[13px] font-semibold leading-tight text-ink">{label}</div>
          {chip && (
            <div className="mt-1">
              <span className={`${CHIP} border-cyan/25 text-cyan/80`}>{chip}</span>
            </div>
          )}
          <div className={`mt-2.5 font-num text-2xl leading-none tabular-nums ${hot ? 'text-ink' : 'text-ink-dim'}`}>{value}</div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      <TxFeedback state={tx} explorer={explorer} idleHint={null} />
    </div>
  )
}

// Every basket's fees AND cranks, live on the index itself (owner 13:46) — no
// click-through needed to act; the full console (?basket=) keeps the advanced
// controls (MEV floor, flush-another-address) and stays deep-linkable.
function BasketFeeCard({ b, holder, mine = false }: { b: BasketSummary; holder?: Address; mine?: boolean }) {
  const cfg = chainCfg(b.chainId)
  const { data: fees, isLoading, refetch } = useFeeState(b.address as Address, b.chainId, holder)
  const { data: burnGate } = useBurnEligibility(b.address, b.chainId)
  const actions = useFeeActions(b.address as Address, b.chainId, () => void refetch())
  const busy = (s: TxState) => s.status === 'signing' || s.status === 'confirming'
  const claimState = actions.stateOf(CLAIM_KEY)
  const burnState = actions.stateOf(BURN_KEY)
  const redeemState = actions.stateOf(REDEEM_KEY)

  return (
    <section className="enter relative overflow-hidden rounded-2xl card-surface p-5">
      <BasketWash ix={b} opacity={0.26} />
      <div className="relative flex flex-wrap items-center gap-3">
        <BasketAvatar address={b.address} symbol={b.symbol} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-display text-xl font-bold leading-tight text-ink">{b.name}</div>
            {mine && (
              <span className="shrink-0 rounded-full border border-cyan/40 bg-cyan/10 px-2 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-cyan">
                yours
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-ink-faint">
            ${b.symbol} · {shortAddr(b.address)} · {cfg.name}
          </div>
        </div>
        <Link
          to={`/flush?basket=${b.address}&chain=${b.chainId}`}
          className="press shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-cyan"
        >
          Full console →
        </Link>
      </div>

      {/* the basket's own bento, thin — the identity flavor of its token page
          on the fee card (owner 16:48) */}
      <div className="relative mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/25 p-1.5">
        <BasketWash ix={b} side="full" opacity={0.3} />
        <BasketBento
          items={b.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: b.chainId }))}
          aspect={7}
        />
      </div>

      {isLoading ? (
        <div className="relative mt-4 rounded-xl border border-white/8 p-4 text-center font-mono text-[11px] text-ink-faint">
          Loading fee state…
        </div>
      ) : !fees ? (
        <div className="relative mt-4 rounded-xl border border-dashed border-white/12 p-4 text-center font-mono text-[11px] text-ink-faint">
          No live fee state on {cfg.name}.
        </div>
      ) : (
        <div className="relative mt-4 space-y-2.5">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <FeeLine
              label="Your accrued fees"
              value={usd(fees.claimableUsdc)}
              hot={fees.claimableUsdc > 0}
              tx={claimState}
              explorer={cfg.explorer}
              action={
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={!actions.enabled || fees.claimableUsdc <= 0 || busy(claimState)}
                  onClick={actions.claim}
                >
                  {busy(claimState) ? 'Claiming…' : 'Claim'}
                </button>
              }
            />
            <div>
              <FeeLine
                label="PRISM burn"
                chip={burnGate?.eligible ? 'eligible ✓' : `${BOUNTY_PCT}% bounty`}
                value={usd(fees.pendingBurnUsdc)}
                hot={fees.pendingBurnUsdc > 0}
                tx={burnState}
                explorer={cfg.explorer}
                action={
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    disabled={!actions.enabled || !burnGate?.eligible || busy(burnState)}
                    onClick={() => actions.flushBurn(0n)}
                    title={burnGate?.eligible ? undefined : 'Below the flush threshold — accruing'}
                  >
                    {busy(burnState) ? 'Flushing…' : 'Flush'}
                  </button>
                }
              />
              {/* how close this basket is to a flushable burn (owner 16:06;
                  bigger + ETH-first per 16:23 — the gate is ETH-denominated,
                  ~0.31 ETH of spot value, so ETH is the stable way to read it).
                  The threshold is probed live off the contract's own gate; the
                  bar only draws when the boundary was VERIFIED (sub-1% pendings
                  render <1%, never a fake 41%). */}
              {burnGate && !burnGate.eligible && burnGate.thresholdUsdc != null && burnGate.thresholdUsdc > 0 && (() => {
                const pct = Math.min(100, (fees.pendingBurnUsdc / burnGate.thresholdUsdc) * 100)
                const pctLabel = pct > 0 && pct < 1 ? '<1' : String(Math.round(pct))
                return (
                  <div className="mt-2.5 px-0.5">
                    <div className="flex items-baseline justify-between font-mono text-[11px] tabular-nums">
                      <span className="font-semibold text-ink">{pctLabel}% to flushable</span>
                      <span className="text-ink-faint">
                        needs ≈ {burnGate.thresholdEth != null ? `${burnGate.thresholdEth.toFixed(2)} ETH` : usd(burnGate.thresholdUsdc)}
                        {burnGate.thresholdEth != null ? ` (${usd(burnGate.thresholdUsdc)})` : ''}
                      </span>
                    </div>
                    <div className="mt-1.5 h-3 overflow-hidden rounded-full bg-white/8 ring-1 ring-inset ring-white/10">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan to-violet transition-[width] duration-500"
                        style={{ width: `${Math.max(pct > 0 ? 1.5 : 0, pct)}%` }}
                      />
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
          {/* interface / launcher / creator shares — each recipient flushes here */}
          {fees.frontend.length > 0 && (
            <div className="rounded-xl border border-white/8 bg-black/20 px-3.5 py-1">
              <ul className="divide-y divide-white/8">
                {fees.frontend.map((r) => {
                  const state = actions.stateOf(frontendKey(r.address))
                  return (
                    <li key={r.address} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={CHIP}>{r.role}</span>
                        <span className="truncate font-mono text-[11px] text-ink-faint">{shortAddr(r.address)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-num text-sm tabular-nums text-ink">{usd(r.pendingUsdc)}</span>
                        <button
                          type="button"
                          className={BTN_PRIMARY}
                          disabled={!actions.enabled || busy(state)}
                          onClick={() => actions.flushFrontend(r.address)}
                        >
                          {busy(state) ? '…' : 'Flush'}
                        </button>
                      </div>
                      <TxFeedback state={state} explorer={cfg.explorer} idleHint={null} />
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {fees.pendingClaimsTokens > 0 && (
            <FeeLine
              label="Redemption claims"
              chip="housekeeping · no bounty"
              value={`${formatGrouped(fees.pendingClaimsTokens, 0)} ${b.symbol} queued`}
              tx={redeemState}
              explorer={cfg.explorer}
              action={
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={!actions.enabled || busy(redeemState)}
                  onClick={actions.redeemClaims}
                >
                  {busy(redeemState) ? 'Settling…' : 'Settle'}
                </button>
              }
            />
          )}
        </div>
      )}
    </section>
  )
}

function ConnectPrompt() {
  return (
    <div className="py-16">
      <div className="mx-auto max-w-md rounded-3xl card-surface p-8 text-center backdrop-blur-md">
        <div aria-hidden className="-mt-8 mb-7 h-1 w-full rounded-t-3xl" style={{ background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' }} />
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">Fees &amp; cranks</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-dim">
          Connect a wallet to claim your accrued fees and run a basket&rsquo;s permissionless cranks.
        </p>
        <div className="mt-6 flex justify-center">
          <WalletButton />
        </div>
      </div>
    </div>
  )
}

// ── Console (?basket=0x…) ────────────────────────────────────────────────────

function FeeConsole({ basket, chainId }: { basket: Address; chainId: number }) {
  const cfg = chainCfg(chainId)
  const { address, isConnected } = useAccount()
  const holder = isConnected && address ? address : import.meta.env.DEV ? (DEV_PREVIEW_ADDRESS as Address) : undefined
  const { data: bd } = useBasketData(basket, chainId)
  const { data: fees, isLoading, refetch } = useFeeState(basket, chainId, holder)
  const actions = useFeeActions(basket, chainId, () => void refetch())

  return (
    <div className="space-y-6">
      <div>
        <Link to="/flush" className="press inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint transition-colors hover:text-ink">
          ← All baskets
        </Link>
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-4 rounded-3xl card-surface p-5">
        <BasketAvatar address={basket} symbol={bd?.symbol ?? '—'} size={52} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-xl font-bold tracking-tight text-ink">{bd?.name ?? 'Basket'}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-faint">
            {bd?.symbol && <span className="text-ink-dim">${bd.symbol}</span>}
            <span>{shortAddr(basket)}</span>
            <span className="rounded-full border border-white/10 px-1.5 py-px text-[9px] uppercase tracking-[0.15em]">{cfg.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/token?addr=${basket}&chain=${chainId}`} className={BTN_GHOST}>Basket page</Link>
          <a href={`${cfg.explorer}/address/${basket}`} target="_blank" rel="noreferrer" className={BTN_GHOST}>Explorer</a>
        </div>
      </header>

      {isLoading ? (
        <div className="rounded-2xl card-surface p-8 text-center text-sm text-ink-faint">Loading fee state…</div>
      ) : !fees ? (
        <div className="rounded-2xl border border-dashed border-white/12 p-10 text-center text-sm text-ink-faint">
          No live fee state for this basket. It may not be a Spectrum V2 basket, or no deployment is configured on {cfg.name}.
        </div>
      ) : (
        <>
          <ClaimCard
            claimable={fees.claimableUsdc}
            reserve={fees.feeReserveUsdc}
            holderConnected={!!holder}
            enabled={actions.enabled}
            state={actions.stateOf(CLAIM_KEY)}
            explorer={cfg.explorer}
            onClaim={actions.claim}
          />

          <CrankSection
            fees={fees}
            symbol={bd?.symbol ?? 'tokens'}
            chainName={cfg.name}
            explorer={cfg.explorer}
            actions={actions}
          />
        </>
      )}
    </div>
  )
}

// ── Holder claim ─────────────────────────────────────────────────────────────

function ClaimCard({
  claimable, reserve, holderConnected, enabled, state, explorer, onClaim,
}: {
  claimable: number; reserve: number; holderConnected: boolean; enabled: boolean
  state: TxState; explorer: string; onClaim: () => void
}) {
  const busy = state.status === 'signing' || state.status === 'confirming'
  return (
    <section className="rounded-3xl card-surface p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Your accrued fees</h2>
          <p className="mt-1 max-w-md text-sm leading-relaxed text-ink-dim">
            Holders accrue a share of every fee. Claiming is a pull, no bounty, and a blocklisted
            holder only ever blocks their own claim.
          </p>
        </div>
        <div className="text-right">
          <div className="font-num text-3xl font-light tabular-nums text-ink">{usd(claimable)}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">claimable now</div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-4">
        <span className="font-mono text-[11px] text-ink-faint">
          Holder reserve backing claims: <span className="tabular-nums text-ink-dim">{usd(reserve)}</span>
        </span>
        {holderConnected ? (
          <button type="button" className={BTN_PRIMARY} disabled={!enabled || claimable <= 0 || busy} onClick={onClaim}>
            {busy ? 'Claiming…' : 'Claim fees'}
          </button>
        ) : (
          <WalletButton />
        )}
      </div>
      {holderConnected && claimable <= 0 && state.status === 'idle' && (
        <p className="mt-2 text-right font-mono text-[10px] text-ink-faint">Nothing to claim right now.</p>
      )}
      <TxFeedback state={state} explorer={explorer} idleHint={null} />
    </section>
  )
}

// ── Permissionless cranks ────────────────────────────────────────────────────

function CrankSection({
  fees, symbol, chainName, explorer, actions,
}: {
  fees: { pendingBurnUsdc: number; pendingClaimsTokens: number; frontend: FrontendAccrual[] }
  symbol: string; chainName: string; explorer: string
  actions: ReturnType<typeof useFeeActions>
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">Protocol cranks</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">permissionless</span>
      </div>
      <p className="-mt-1 max-w-2xl text-sm leading-relaxed text-ink-dim">
        Anyone may run these, they settle fees the protocol has already accrued and move no
        one&rsquo;s principal. The two flush cranks pay the caller a {BOUNTY_PCT}% bounty of the
        amount flushed; the redemption-claims crank is pure maintenance and pays none.
      </p>

      <BurnCrankCard
        pending={fees.pendingBurnUsdc}
        enabled={actions.enabled}
        state={actions.stateOf(BURN_KEY)}
        explorer={explorer}
        onFlush={actions.flushBurn}
      />

      <FrontendFlushCard
        rows={fees.frontend}
        chainName={chainName}
        explorer={explorer}
        actions={actions}
      />

      <RedeemClaimsCard
        pendingTokens={fees.pendingClaimsTokens}
        symbol={symbol}
        enabled={actions.enabled}
        state={actions.stateOf(REDEEM_KEY)}
        explorer={explorer}
        onSettle={actions.redeemClaims}
      />
    </section>
  )
}

function RedeemClaimsCard({
  pendingTokens, symbol, enabled, state, explorer, onSettle,
}: {
  pendingTokens: number; symbol: string; enabled: boolean; state: TxState; explorer: string; onSettle: () => void
}) {
  const busy = state.status === 'signing' || state.status === 'confirming'
  return (
    <div className="rounded-2xl card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold text-ink">Redemption claims</h3>
            <span className={CHIP}>maintenance · no bounty</span>
          </div>
          <p className="mt-0.5 max-w-md text-xs leading-relaxed text-ink-dim">
            Settles the lazy-burn queue (burns basket tokens already redeemed). Keeps redemption
            reachable for a frozen leg.
          </p>
        </div>
        <div className="text-right">
          <div className="font-num text-xl font-light tabular-nums text-ink">{formatGrouped(pendingTokens, 0)}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">{symbol} queued</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end border-t border-white/8 pt-3">
        <button type="button" className={BTN_GHOST} disabled={!enabled || pendingTokens <= 0 || busy} onClick={onSettle}>
          {busy ? 'Settling…' : 'Settle claims'}
        </button>
      </div>
      <TxFeedback state={state} explorer={explorer} idleHint={null} />
    </div>
  )
}

function BurnCrankCard({
  pending, enabled, state, explorer, onFlush,
}: {
  pending: number; enabled: boolean; state: TxState; explorer: string; onFlush: (minEthOut: bigint) => void
}) {
  const [showAdv, setShowAdv] = useState(false)
  const [minEth, setMinEth] = useState('')
  const busy = state.status === 'signing' || state.status === 'confirming'

  let minWei = 0n
  let minErr = false
  if (minEth.trim()) {
    try { minWei = parseEther(minEth.trim() as `${number}`) } catch { minErr = true }
  }

  return (
    <div className="rounded-2xl card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold text-ink">PRISM burn</h3>
            <BountyChip />
          </div>
          <p className="mt-0.5 max-w-md text-xs leading-relaxed text-ink-dim">
            Sells the accrued burn share to ETH and bridges it to the L1 PrismBurner.
          </p>
        </div>
        <div className="text-right">
          <div className="font-num text-xl font-light tabular-nums text-ink">{usd(pending)}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">pending</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-3">
        <button type="button" onClick={() => setShowAdv((v) => !v)} className="press font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint transition-colors hover:text-ink">
          {showAdv ? '− Min ETH out' : '+ Min ETH out'}
        </button>
        <button type="button" className={BTN_PRIMARY} disabled={!enabled || pending <= 0 || busy || minErr} onClick={() => onFlush(minWei)}>
          {busy ? 'Flushing…' : 'Flush burn'}
        </button>
      </div>

      {showAdv && (
        <div className="mt-3 space-y-1.5">
          <label className="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">Minimum ETH out (slippage floor)</label>
          <input
            value={minEth}
            onChange={(e) => setMinEth(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            className="w-full rounded-lg border border-white/12 bg-black/20 px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-cyan/50"
          />
          {minErr && <p className="font-mono text-[10px] text-magenta">Enter a valid ETH amount.</p>}
        </div>
      )}
      {/* Always visible (not nested in the advanced panel): the Flush-burn button is
          enabled in the default collapsed state, so a zero floor must never go unwarned. */}
      {pending > 0 && !minErr && minWei === 0n && (
        <p className="mt-2 font-mono text-[10px] text-amber">
          No slippage floor set, this flush accepts any ETH amount.{' '}
          {showAdv ? 'Set a minimum above' : 'Open “Min ETH out” to set one'} if MEV is a concern.
        </p>
      )}
      {pending > 0 && state.status === 'idle' && (
        <p className="mt-2 font-mono text-[10px] text-ink-faint">Very small balances revert until they clear the bridge threshold.</p>
      )}
      <TxFeedback state={state} explorer={explorer} idleHint={null} />
    </div>
  )
}

function FrontendFlushCard({
  rows, chainName, explorer, actions,
}: {
  rows: FrontendAccrual[]; chainName: string; explorer: string; actions: ReturnType<typeof useFeeActions>
}) {
  const [other, setOther] = useState('')
  const otherValid = isAddress(other.trim())

  return (
    <div className="rounded-2xl card-surface p-5">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-sm font-semibold text-ink">Interface, launcher &amp; creator fees</h3>
        <BountyChip />
      </div>
      <p className="mt-0.5 max-w-md text-xs leading-relaxed text-ink-dim">
        Pushes a recipient&rsquo;s accrued fee to them. The interface, launcher and creator shares
        all flush through here.
      </p>

      <ul className="mt-4 divide-y divide-white/8">
        {rows.length === 0 && (
          <li className="py-3 font-mono text-[11px] text-ink-faint">No interface / launcher / creator fees pending.</li>
        )}
        {rows.map((r) => {
          const state = actions.stateOf(frontendKey(r.address))
          const busy = state.status === 'signing' || state.status === 'confirming'
          return (
            <li key={r.address} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-white/12 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.15em] text-ink-dim">{r.role}</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint">{shortAddr(r.address)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-num text-sm tabular-nums text-ink">{usd(r.pendingUsdc)}</span>
                  <button type="button" className={BTN_GHOST} disabled={!actions.enabled || busy} onClick={() => actions.flushFrontend(r.address)}>
                    {busy ? '…' : 'Flush'}
                  </button>
                </div>
              </div>
              <TxFeedback state={state} explorer={explorer} idleHint={null} />
            </li>
          )
        })}
      </ul>

      {/* Advanced: the crank is keyed by an arbitrary recipient. */}
      <details className="mt-4 border-t border-white/8 pt-3">
        <summary className="press cursor-pointer font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint transition-colors hover:text-ink">
          Flush another address
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-white/12 bg-black/20 px-3 py-2 font-mono text-xs text-ink outline-none transition-colors focus:border-cyan/50"
          />
          <button
            type="button"
            className={BTN_GHOST}
            disabled={!actions.enabled || !otherValid}
            onClick={() => otherValid && actions.flushFrontend(other.trim() as Address)}
          >
            Flush
          </button>
        </div>
        <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
          A flush on an address with nothing pending is a harmless no-op. Wallet must be on {chainName}.
        </p>
        {otherValid && <TxFeedback state={actions.stateOf(frontendKey(other.trim()))} explorer={explorer} idleHint={null} />}
      </details>
    </div>
  )
}

// ── Shared tx status line ────────────────────────────────────────────────────

function TxFeedback({ state, explorer, idleHint }: { state: TxState; explorer: string; idleHint: string | null }) {
  if (state.status === 'idle') return idleHint ? <p className="mt-2 font-mono text-[10px] text-ink-faint">{idleHint}</p> : null

  const txLink = state.hash ? (
    <a href={`${explorer}/tx/${state.hash}`} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-ink">
      {shortAddr(state.hash)}
    </a>
  ) : null

  return (
    <div className="enter mt-2 font-mono text-[11px]">
      {state.status === 'signing' && <span className="text-ink-dim">Confirm in your wallet…</span>}
      {state.status === 'confirming' && <span className="text-cyan">Confirming… {txLink}</span>}
      {state.status === 'success' && <span className="text-teal">Done. {txLink}</span>}
      {state.status === 'error' && <span className="text-magenta">{state.error ?? 'Transaction failed.'}</span>}
    </div>
  )
}


// ── "Crank everything" (owner 2026-07-07 16:00: "one click to do all of the
// baskets for anything that is global — not the fees, that's per person. If
// it's possible, build it"). One click scans every basket's PUBLIC fee state
// and walks every permissionless crank with a balance as sequential wallet
// prompts: flushPrismBurn (0n floor — same as the per-basket button),
// flushFrontendFees per accrued recipient, redeemClaims when the lazy-burn
// queue holds tokens. claimFees is deliberately absent (personal). A failed
// crank is skipped, never aborts the run.
interface CrankJob {
  basket: Address
  chainId: number
  symbol: string
  label: string
  fn: 'flushPrismBurn' | 'flushFrontendFees' | 'redeemClaims'
  args: readonly unknown[]
}

function GlobalCrankButton({ baskets }: { baskets: BasketSummary[] }) {
  const { isConnected, chainId: walletChain } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const qc = useQueryClient()
  const [run, setRun] = useState<{ phase: 'scan' | 'crank'; done: number; total: number; label: string } | null>(null)
  const [summary, setSummary] = useState<{ ok: number; failed: number } | null>(null)

  // The passive eligible-vs-not count beside the button (owner 16:06) — the
  // same live gate probe the cards use, one per basket.
  const gates = useQueries({
    queries: baskets.map((b) => ({
      queryKey: ['spectrum', 'burnEligible', b.chainId, b.address.toLowerCase()],
      queryFn: () => fetchBurnEligible(b.address as Address, b.chainId),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
  })
  const eligibleCount = gates.filter((g) => g.data === true).length
  const settled = gates.every((g) => !g.isLoading)

  async function crankEverything() {
    if (!isConnected || run) return
    setSummary(null)
    setRun({ phase: 'scan', done: 0, total: baskets.length, label: 'Reading fee state…' })

    const jobs: CrankJob[] = []
    for (const [i, b] of baskets.entries()) {
      setRun({ phase: 'scan', done: i + 1, total: baskets.length, label: `Reading $${b.symbol}…` })
      const fs = await fetchFeeState(b.address as Address, b.chainId).catch(() => null)
      if (!fs) continue
      const base = { basket: b.address as Address, chainId: b.chainId, symbol: b.symbol }
      // Burns queue only past the contract's own gate — a below-threshold
      // basket is SKIPPED here, not sent to revert (owner 16:06).
      if (fs.pendingBurnUsdc > 0 && (await fetchBurnEligible(b.address as Address, b.chainId)))
        jobs.push({ ...base, label: `$${b.symbol} · PRISM burn (${usd(fs.pendingBurnUsdc)})`, fn: 'flushPrismBurn', args: [0n] })
      for (const fe of fs.frontend)
        jobs.push({ ...base, label: `$${b.symbol} · ${fe.role} fees (${usd(fe.pendingUsdc)})`, fn: 'flushFrontendFees', args: [fe.address] })
      if (fs.pendingClaimsTokens > 0)
        jobs.push({ ...base, label: `$${b.symbol} · settle claim queue`, fn: 'redeemClaims', args: [] })
    }

    if (jobs.length === 0) {
      setRun(null)
      setSummary({ ok: 0, failed: 0 })
      return
    }

    let ok = 0
    let failed = 0
    for (const [i, j] of jobs.entries()) {
      setRun({ phase: 'crank', done: i, total: jobs.length, label: j.label })
      try {
        if (walletChain !== j.chainId) await switchChainAsync({ chainId: j.chainId })
        const hash =
          j.fn === 'flushPrismBurn'
            ? await writeContractAsync({ address: j.basket, abi: basketAbi, functionName: 'flushPrismBurn', args: [0n], chainId: j.chainId })
            : j.fn === 'flushFrontendFees'
              ? await writeContractAsync({ address: j.basket, abi: basketAbi, functionName: 'flushFrontendFees', args: j.args as [Address], chainId: j.chainId })
              : await writeContractAsync({ address: j.basket, abi: basketAbi, functionName: 'redeemClaims', chainId: j.chainId })
        await publicClient?.waitForTransactionReceipt({ hash })
        ok += 1
      } catch {
        failed += 1 // rejected in wallet or reverted — move on, the rest still cranks
      }
    }
    setRun(null)
    setSummary({ ok, failed })
    void qc.invalidateQueries({ queryKey: ['spectrum', 'feeState'] })
  }

  return (
    <span className="flex items-center gap-2.5">
      {run && (
        <span className="font-mono text-[10px] tabular-nums text-ink-faint">
          {run.phase === 'scan' ? run.label : `${run.done + 1}/${run.total} · ${run.label}`}
        </span>
      )}
      {summary && !run && (
        <span className="font-mono text-[10px] text-ink-faint">
          {summary.ok + summary.failed === 0
            ? 'Nothing to crank — all clear.'
            : `✓ ${summary.ok} cranked${summary.failed ? ` · ${summary.failed} skipped` : ''}`}
        </span>
      )}
      {!run && !summary && settled && baskets.length > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-ink-faint">
          {eligibleCount > 0 ? (
            <>
              <span className="text-teal">{eligibleCount} flushable</span> · {baskets.length - eligibleCount} building
            </>
          ) : (
            `0 flushable · ${baskets.length} building`
          )}
        </span>
      )}
      <button
        type="button"
        disabled={!isConnected || run != null || baskets.length === 0}
        onClick={() => void crankEverything()}
        className={BTN_PRIMARY}
        title={isConnected ? 'Run every public crank with a balance, one wallet prompt at a time' : 'Connect a wallet first'}
      >
        {run ? 'Cranking…' : 'Crank everything'}
      </button>
    </span>
  )
}
