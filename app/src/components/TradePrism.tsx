import { useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatEther, formatUnits, parseAbi, parseEther, parseEventLogs, parseUnits } from 'viem'
import { useAccount, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi'
import brand from '../brand.config'
import { prismCreditEnabled } from '../theme/brand'
import { SWAP_ENABLED } from '../lib/config/features'
import { clientFor } from '../lib/chain/rpc'
import { fetchLifiQuote, LIFI_NATIVE, LifiQuoteError, type LifiQuote } from '../lib/spectrum/lifi'
import { clampSlippageBps } from '../lib/spectrum/hook-data'
import { erc20ApproveAbi } from '../lib/spectrum/abis-v2'
import { approvalPlan } from '../lib/spectrum/migrate-math'
import { PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK } from '../lib/prism/claim'
import { PERMIT2, PRISM_POOL_KEY, encodePrismPoolSwap, permit2Abi, quotePrismPool, universalRouterAddress } from '../lib/prism/pool'
import { directSwapWrapperFor, swapWithFeeCall, wrapperFeeBpsFor } from '../lib/spectrum/direct-swap-wrapper'
import { lintWrapperCalldata } from '../lib/spectrum/calldata-lint'
import { backOutWrapperFee } from '../lib/spectrum/direct-swap-lane'
import { encodeUrV4SellToWeth } from '../lib/spectrum/universal-router'
import { deploymentFor, feeGenerationFor } from '../lib/chain/deployments'
import { INTERFACE_TAG_ADDRESS } from '../lib/config/operator'
import { PixelRainbow } from './PoweredByPrism'

// ─────────────────────────────────────────────────────────────────────────────
// "Trade PRISM — the token that powers Spectrum" (owner asks 2026-07-30): a
// banner below the swap console (+ Home, /claim) expanding into a small,
// self-contained ETH ⇄ PRISM trade on Ethereum mainnet. Buy is the default;
// Sell is one toggle away (owner: both, defaulting to buy — the v4 hook pool
// is the default route either way).
//
// Deliberately NOT wired into DexSwapCard: the console is basket-centric and
// SACRED (release-gated swap path) — PRISM is a plain ERC-20, so both
// directions ride the SAME audit-hardened same-chain LiFi leg the any-token
// pay side uses (guarded parse, router-enforced floor, re-quote at execution;
// selling approves the route's spender exact-amount via the house
// approvalPlan) and the success line reports what ACTUALLY moved, measured
// from the receipt — PRISM via its Transfer logs, ETH via the balance delta
// with the tx's own gas added back — never the quote.
//
// Gates: prismCredit (operators who dropped the ecosystem credit ship no
// PRISM trade CTA) + SWAP_ENABLED (a live trade surface never ships on an
// info build — the ungated league-withdraw lesson).
// ─────────────────────────────────────────────────────────────────────────────

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

const DEFAULT_SLIP_BPS = 100 // 1% — the PRISM pool is young and thin; the knob is right there

const fmtPrism = (raw: bigint) =>
  Number(formatUnits(raw, 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })
const fmtEth = (raw: bigint) =>
  Number(formatEther(raw)).toLocaleString('en-US', { maximumFractionDigits: 5 })

type Dir = 'buy' | 'sell'

/** `buyOnly` renders the plain "Buy PRISM" banner with no direction toggle —
 *  Home and /swap ship that (owner 2026-07-30: the sell side lives on /claim
 *  only, where holders arrive already holding PRISM). */
export function TradePrism({ className = '', buyOnly = false, initialAmount }: { className?: string; buyOnly?: boolean; initialAmount?: string }) {
  const { address, chainId: walletChainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState<Dir>('buy')
  const [amount, setAmount] = useState(() => initialAmount || '0.1')
  const [slipBps, setSlipBps] = useState(DEFAULT_SLIP_BPS)
  const [customSlip, setCustomSlip] = useState('')
  const [busy, setBusy] = useState<'approve' | 'trade' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ label: string; hash: string } | null>(null)

  // Both sides are 18-decimal, so one parse serves buy (ETH in) and sell (PRISM in).
  let amountRaw = 0n
  try {
    amountRaw = dir === 'buy' ? parseEther(amount || '0') : parseUnits(amount || '0', 18)
  } catch {
    amountRaw = 0n
  }

  const fromToken = dir === 'buy' ? LIFI_NATIVE : PRISM_V2_HOOK
  const toToken = dir === 'buy' ? PRISM_V2_HOOK : LIFI_NATIVE

  // The seller's PRISM balance — drives the % chips and the over-balance guard.
  const prismBal = useQuery({
    queryKey: ['trade-prism', 'bal', address?.toLowerCase()],
    queryFn: () =>
      clientFor(PRISM_CLAIM_CHAIN_ID).readContract({
        address: PRISM_V2_HOOK,
        abi: balanceAbi,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      }),
    enabled: open && !!address && dir === 'sell',
  })
  const overBalance = dir === 'sell' && prismBal.data != null && amountRaw > prismBal.data

  // Quote: aggregator first (it can split venues), the pool DIRECTLY when the
  // aggregator has no route — its coverage of the young pool proved transient
  // (routed at 16:00, gone by 20:30 the same day), while the pool itself
  // quotes fine on-chain. Same shape either way: estimate + enforced floor.
  const quote = useQuery({
    queryKey: ['trade-prism', 'quote', dir, address?.toLowerCase(), amountRaw.toString(), slipBps],
    queryFn: async (): Promise<
      { source: 'lifi'; toAmount: bigint; toAmountMin: bigint; lq: LifiQuote } | { source: 'pool'; toAmount: bigint; toAmountMin: bigint }
    > => {
      // FEE-FIRST, BOTH DIRECTIONS (owner 2026-08-16 "ensure fees are kept
      // for stuff outside the main batcher"; sells joined 2026-08-17 once the
      // contracts lane fork-confirmed the WETH-out payload and the
      // feeGeneration-2 wrapper shipped the PRISM Permit2 skip): with the
      // wrapper seated, the POOL path leads — it is PRISM's real market (the
      // hooked v4 pool aggregators cannot reach) and the wrapper captures the
      // house fee. The aggregator becomes the fallback. Displayed source must
      // match the executed one, so this order — and the sell's backed-out
      // input — mirrors trade() exactly.
      const wrapperSeated =
        !!directSwapWrapperFor(PRISM_CLAIM_CHAIN_ID) &&
        (dir === 'buy' ? !!INTERFACE_TAG_ADDRESS : feeGenerationFor(PRISM_CLAIM_CHAIN_ID) === 2)
      const poolQuote = async () => {
        if (!universalRouterAddress()) throw new Error('No Universal Router configured.')
        // a wrapper SELL pulls sell + fee, so the fee backs OUT of the typed
        // amount (you part with what you typed, never more) — the quoted
        // input must be the same backed-out number the execution signs
        const quoteIn =
          dir === 'sell' && wrapperSeated ? backOutWrapperFee(amountRaw, wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID)).sellRaw : amountRaw
        if (quoteIn <= 0n) throw new Error('Amount too small to quote.')
        const out = await quotePrismPool(clientFor(PRISM_CLAIM_CHAIN_ID), dir, quoteIn)
        const minOut = (out * BigInt(10_000 - slipBps)) / 10_000n
        return { source: 'pool' as const, toAmount: out, toAmountMin: minOut }
      }
      const lifiQuote = async () => {
        const lq = await fetchLifiQuote({
          chainId: PRISM_CLAIM_CHAIN_ID,
          fromToken,
          toToken,
          fromAmount: amountRaw,
          fromAddress: address as `0x${string}`,
          slippageBps: slipBps,
        })
        return { source: 'lifi' as const, toAmount: lq.toAmount, toAmountMin: lq.toAmountMin, lq }
      }
      if (wrapperSeated) {
        try {
          return await poolQuote()
        } catch {
          return await lifiQuote()
        }
      }
      try {
        return await lifiQuote()
      } catch (e) {
        if (!(e instanceof LifiQuoteError) || !universalRouterAddress()) throw e
        return await poolQuote()
      }
    },
    enabled: open && !!address && amountRaw > 0n && !overBalance,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: false,
  })

  if (!prismCreditEnabled(brand) || !SWAP_ENABLED) return null

  const wrongChain = !!address && walletChainId !== PRISM_CLAIM_CHAIN_ID

  function switchDir(next: Dir) {
    if (next === dir) return
    setDir(next)
    setAmount(next === 'buy' ? '0.1' : '')
    setError(null)
    setDone(null)
  }

  async function trade() {
    if (!address || busy || amountRaw <= 0n || overBalance) return
    setError(null)
    if (wrongChain) {
      try {
        await switchChainAsync({ chainId: PRISM_CLAIM_CHAIN_ID })
      } catch {
        setError('Switch your wallet to Ethereum mainnet to trade.')
        return
      }
    }
    try {
      // Re-quote at execution (fresh route + floor) in the SAME order the
      // display quote used — the shown source must be the executed source.
      setBusy('trade')
      const client = clientFor(PRISM_CLAIM_CHAIN_ID)
      let exec: {
        to: `0x${string}`
        data: `0x${string}`
        value: bigint
        gas?: bigint
        spender: `0x${string}` | null
        /** the wrapper's exact ERC-20 pull (sell + fee) when it differs from
         *  amountRaw — the approval's number, never re-derived */
        pull?: bigint
        /** proceeds arrive as WETH (the wrapper cannot deliver native out) */
        wethOut?: boolean
      }
      // THE FEE RAIL (owner 2026-08-16 "ensure fees are kept for stuff
      // outside the main batcher"; the fee is 100% burn on a feeGeneration-2
      // chain, 7/8-burn with an operator eighth on gen-1): with the wrapper
      // seated the POOL path leads both directions. Aggregator falls back.
      const poolExec = async (): Promise<typeof exec> => {
        if (!universalRouterAddress()) throw new Error('No Universal Router configured.')
        if (dir === 'buy') {
          const out = await quotePrismPool(client, dir, amountRaw)
          const minOut = (out * BigInt(10_000 - slipBps)) / 10_000n
          const tx = encodePrismPoolSwap(dir, amountRaw, minOut)
          const wrapped = swapWithFeeCall({
            chainId: PRISM_CLAIM_CHAIN_ID,
            sellToken: null,
            sellAmount: amountRaw,
            buyToken: PRISM_V2_HOOK,
            minBuyAmount: minOut,
            poolData: tx.data,
            // ⚠ the WRAPPER's rate, not the batcher's 25: no 0x skim exists
            // on this lane (the ruled fee model 2026-08-16; this call
            // undercharged at 25 until 2026-08-17)
            feeBps: wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID),
            feeRecipient: INTERFACE_TAG_ADDRESS,
            nowSec: Math.floor(Date.now() / 1000),
          })
          if (wrapped) return { to: wrapped.to, data: wrapped.data, value: wrapped.value, spender: null }
          return { ...tx, spender: null }
        }
        // SELL through the FEE RAIL (wired 2026-08-17 — the WETH-out payload
        // the contracts lane fork-confirmed, DirectSwapWrapperSellFork.t.sol
        // 4/4: WRAP_ETH carries the CONTRACT_BALANCE sentinel so nothing
        // strands on the router, and the feeGeneration-2 build skips the
        // Permit2 approve PRISM hard-refuses). PRISM in → WETH out, the same
        // asset as ETH, unwrap any time. The wrapper PULLS sell + fee, so the
        // fee backs OUT of the typed amount and the pull IS the approval.
        const wrapper = directSwapWrapperFor(PRISM_CLAIM_CHAIN_ID)
        const weth = deploymentFor(PRISM_CLAIM_CHAIN_ID).weth
        if (wrapper && weth && feeGenerationFor(PRISM_CLAIM_CHAIN_ID) === 2) {
          const backed = backOutWrapperFee(amountRaw, wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID))
          if (backed.sellRaw > 0n) {
            const out = await quotePrismPool(client, dir, backed.sellRaw)
            const minOut = (out * BigInt(10_000 - slipBps)) / 10_000n
            const nowSec = Math.floor(Date.now() / 1000)
            const poolData = encodeUrV4SellToWeth({
              poolKey: PRISM_POOL_KEY,
              amountIn: backed.sellRaw,
              amountOutMin: minOut,
              deadline: nowSec + 1200,
            })
            const wrapped = swapWithFeeCall({
              chainId: PRISM_CLAIM_CHAIN_ID,
              sellToken: PRISM_V2_HOOK,
              sellAmount: backed.sellRaw,
              buyToken: weth as `0x${string}`,
              minBuyAmount: minOut,
              poolData,
              feeBps: wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID),
              feeRecipient: INTERFACE_TAG_ADDRESS,
              nowSec,
            })
            if (wrapped)
              return {
                to: wrapped.to,
                data: wrapped.data,
                value: wrapped.value,
                spender: wrapper,
                pull: backed.sellRaw + wrapped.feeRaw,
                wethOut: true,
              }
          }
        }
        // No wrapper (or a pre-fee-model generation): the direct router path,
        // native ETH out. The Universal Router pulls ERC-20 input through
        // Permit2, not a direct allowance — spender: null marks that path.
        const out = await quotePrismPool(client, dir, amountRaw)
        const minOut = (out * BigInt(10_000 - slipBps)) / 10_000n
        return { ...encodePrismPoolSwap(dir, amountRaw, minOut), spender: null }
      }
      const lifiExec = async (): Promise<typeof exec> => {
        const lq = await fetchLifiQuote({
          chainId: PRISM_CLAIM_CHAIN_ID,
          fromToken,
          toToken,
          fromAmount: amountRaw,
          fromAddress: address,
          slippageBps: slipBps,
        })
        return { to: lq.tx.to, data: lq.tx.data, value: lq.tx.value, gas: lq.tx.gasLimit ?? undefined, spender: lq.approvalAddress }
      }
      const wrapperSeated =
        !!directSwapWrapperFor(PRISM_CLAIM_CHAIN_ID) &&
        (dir === 'buy' ? !!INTERFACE_TAG_ADDRESS : feeGenerationFor(PRISM_CLAIM_CHAIN_ID) === 2)
      if (wrapperSeated) {
        try {
          exec = await poolExec()
        } catch {
          exec = await lifiExec()
        }
      } else {
        try {
          exec = await lifiExec()
        } catch (e) {
          if (!(e instanceof LifiQuoteError) || !universalRouterAddress()) throw e
          exec = await poolExec()
        }
      }

      // Selling spends PRISM: grant exactly what this trade needs.
      if (dir === 'sell') {
        setBusy('approve')
        if (exec.spender) {
          // Aggregator/wrapper route: plain ERC-20 approve of ITS spender
          // (house approvalPlan handles reset-to-zero tokens; PRISM is
          // standard toward normal spenders — only Permit2 approvals are the
          // token's fixed-infinity special case). The amount is the route's
          // own pull: the wrapper takes sell + fee, the aggregator amountRaw.
          const need = exec.pull ?? amountRaw
          const allowance = await client.readContract({
            address: PRISM_V2_HOOK,
            abi: erc20ApproveAbi,
            functionName: 'allowance',
            args: [address, exec.spender],
          })
          const plan = approvalPlan(allowance, need)
          for (const value of plan === 'none' ? [] : plan === 'zero-first' ? [0n, need] : [need]) {
            const ah = await writeContractAsync({
              address: PRISM_V2_HOOK,
              abi: erc20ApproveAbi,
              functionName: 'approve',
              args: [exec.spender, value],
              chainId: PRISM_CLAIM_CHAIN_ID,
            })
            await client.waitForTransactionReceipt({ hash: ah })
          }
        } else {
          // Pool route: the two-step Permit2 ladder (ERC-20 → Permit2, then
          // Permit2 → router, exact amount, 30-day expiry).
          const ur = universalRouterAddress()!
          const erc20Allowance = await client.readContract({
            address: PRISM_V2_HOOK,
            abi: erc20ApproveAbi,
            functionName: 'allowance',
            args: [address, PERMIT2],
          })
          if (erc20Allowance < amountRaw) {
            const ah = await writeContractAsync({
              address: PRISM_V2_HOOK,
              abi: erc20ApproveAbi,
              functionName: 'approve',
              args: [PERMIT2, amountRaw],
              chainId: PRISM_CLAIM_CHAIN_ID,
            })
            await client.waitForTransactionReceipt({ hash: ah })
          }
          const [p2Amount, p2Expiry] = await client.readContract({
            address: PERMIT2,
            abi: permit2Abi,
            functionName: 'allowance',
            args: [address, PRISM_V2_HOOK, ur],
          })
          const now = Math.floor(Date.now() / 1000)
          if (p2Amount < amountRaw || p2Expiry <= now) {
            const ph = await writeContractAsync({
              address: PERMIT2,
              abi: permit2Abi,
              functionName: 'approve',
              args: [PRISM_V2_HOOK, ur, amountRaw > (1n << 160n) - 1n ? (1n << 160n) - 1n : amountRaw, now + 30 * 24 * 3600],
              chainId: PRISM_CLAIM_CHAIN_ID,
            })
            await client.waitForTransactionReceipt({ hash: ph })
          }
        }
        setBusy('trade')
      }

      // THE CROSS-CHECK, then the simulation (two independent gates, in that
      // order): when these bytes head for the fee wrapper, an independent
      // decode re-judges the money laws — rate, exact native value, floor
      // present, deadline horizon — before any RPC sees them. Strict: this
      // lane has no consent surface, so every finding refuses in its own words.
      if (exec.to === directSwapWrapperFor(PRISM_CLAIM_CHAIN_ID)) {
        const findings = lintWrapperCalldata({
          data: exec.data,
          value: exec.value,
          expected: { nowSeconds: Math.floor(Date.now() / 1000), feeRecipient: INTERFACE_TAG_ADDRESS ?? undefined },
        })
        if (findings.length > 0) throw new Error(findings[0].sentence)
      }
      // Simulate-then-sign (house rule): the exact bytes must pass eth_call
      // before a wallet ever sees them — a bad route/encoding stops HERE.
      await client.call({ account: address, to: exec.to, data: exec.data, value: exec.value })

      const balBefore = dir === 'sell' ? await client.getBalance({ address }) : 0n
      const hash = await sendTransactionAsync({
        to: exec.to,
        data: exec.data,
        value: exec.value,
        gas: exec.gas,
        chainId: PRISM_CLAIM_CHAIN_ID,
      })
      const receipt = await client.waitForTransactionReceipt({ hash })

      if (dir === 'buy') {
        // What ACTUALLY arrived: PRISM Transfer logs to the buyer, never the quote.
        const delivered = parseEventLogs({ abi: transferAbi, logs: receipt.logs, eventName: 'Transfer' })
          .filter(
            (l) =>
              l.address.toLowerCase() === PRISM_V2_HOOK.toLowerCase() &&
              l.args.to.toLowerCase() === address.toLowerCase(),
          )
          .reduce((acc, l) => acc + l.args.value, 0n)
        setDone({ label: `Bought ${fmtPrism(delivered)} PRISM`, hash })
      } else if (exec.wethOut) {
        // Wrapper route: proceeds arrive as WETH — measured from the WETH
        // Transfer logs to the seller, never the quote. Same asset as ETH;
        // the label says so in the house words.
        const weth = deploymentFor(PRISM_CLAIM_CHAIN_ID).weth
        const received = parseEventLogs({ abi: transferAbi, logs: receipt.logs, eventName: 'Transfer' })
          .filter((l) => l.address.toLowerCase() === (weth ?? '').toLowerCase() && l.args.to.toLowerCase() === address.toLowerCase())
          .reduce((acc, l) => acc + l.args.value, 0n)
        setDone({
          label:
            received > 0n
              ? `Sold ${fmtPrism(amountRaw)} PRISM for ${fmtEth(received)} WETH (wrapped ETH — same asset, unwrap any time)`
              : `Sold ${fmtPrism(amountRaw)} PRISM`,
          hash,
        })
      } else {
        // ETH received = balance delta with this tx's own gas added back. If
        // something else moved the balance in the same block, say less, not more.
        const balAfter = await client.getBalance({ address })
        const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice
        const received = balAfter - balBefore + gasPaid
        setDone({
          label:
            received > 0n
              ? `Sold ${fmtPrism(amountRaw)} PRISM for ${fmtEth(received)} ETH`
              : `Sold ${fmtPrism(amountRaw)} PRISM`,
          hash,
        })
      }
      // PRISM balance moved → the claim page's fee-share mirror gap may too.
      void queryClient.invalidateQueries({ queryKey: ['prism-claim'] })
      void queryClient.invalidateQueries({ queryKey: ['trade-prism', 'bal'] })
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'Trade failed')
    } finally {
      setBusy(null)
    }
  }

  const paySymbol = dir === 'buy' ? 'ETH' : 'PRISM'
  const fmtOut = dir === 'buy' ? fmtPrism : fmtEth
  const outSymbol = dir === 'buy' ? 'PRISM' : 'ETH'

  return (
    <div className={`overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] ${className}`}>
      {/* ── the banner ── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press group relative flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <div aria-hidden className="ambient-bloom pointer-events-none absolute -left-12 -top-14 h-36 w-36 rounded-full bg-magenta/15 blur-3xl" />
        <div
          aria-hidden
          className="bento-sheen pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'linear-gradient(115deg, transparent 44%, rgba(255,255,255,0.08) 50%, transparent 56%)', animationDuration: '7s' }}
        />
        <span className="relative flex min-w-0 items-center gap-3.5">
          <PixelRainbow className="h-5 w-auto shrink-0" />
          <span className="min-w-0">
            <span className="block font-display text-base font-bold uppercase tracking-tight text-ink">
              {buyOnly ? 'Buy PRISM' : 'Trade PRISM'}
            </span>
            <span className="block truncate font-mono text-[11px] text-ink-dim">
              the token that powers Spectrum
            </span>
            {/* the burn line stands alone, glowing (owner 2026-07-30) */}
            {/* WRAPS, never truncates (mobile sweep 2026-08-06): at 390w the
                single-line clip cut it to "…buys & bu", which reads as broken
                rather than as the fact it states. A two-line fact is fine; a
                half-sentence is not. */}
            <span className="mt-0.5 block font-mono text-[11px] font-semibold leading-snug text-amber [text-shadow:0_0_14px_rgba(255,146,72,0.75),0_0_4px_rgba(255,146,72,0.5)] sm:truncate">
              25% of every basket fee buys &amp; burns PRISM
            </span>
          </span>
        </span>
        <span
          aria-hidden
          className={`relative shrink-0 font-display text-xl text-magenta transition-transform ${open ? 'rotate-90' : 'group-hover:translate-x-1'}`}
        >
          →
        </span>
      </button>

      {/* ── the trade, inline: a mini console (pay → receive → go) ── */}
      {open && (
        <div className="border-t border-white/10 p-4">
          {done ? (
            <div className="relative overflow-hidden rounded-xl border border-teal/30 bg-teal/[0.06] p-4">
              <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-teal/15 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <PixelRainbow className="h-6 w-auto shrink-0" />
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-teal">Delivered</div>
                  <div className="truncate font-num text-xl font-bold tabular-nums text-ink">{done.label}</div>
                  <p className="mt-1 font-mono text-[11px] text-ink-dim">
                    Measured from the transaction itself.{' '}
                    <a className="underline underline-offset-2 hover:text-ink" href={`https://etherscan.io/tx/${done.hash}`} target="_blank" rel="noreferrer">
                      View it
                    </a>
                    {' · '}
                    <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setDone(null)}>
                      trade again
                    </button>
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* direction — /claim only; buy-only mounts never show it */}
              {!buyOnly && (
                <div className="mb-3 inline-flex rounded-lg p-0.5 ring-1 ring-inset ring-white/10">
                  {(['buy', 'sell'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => switchDir(d)}
                      className={`press rounded-md px-4 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.12em] ${dir === d ? 'bg-magenta/15 text-magenta' : 'text-ink-faint hover:text-ink'}`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}

              {/* you pay */}
              <div className="rounded-xl border border-white/12 bg-black/25 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">You pay</span>
                  <span className="flex items-center gap-1">
                    {dir === 'buy' ? (
                      ['0.05', '0.1', '0.5'].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => {
                            setAmount(v)
                            setError(null)
                          }}
                          className={`press rounded-full border px-2.5 py-1 font-num text-[11px] font-semibold tabular-nums transition-colors ${amount === v ? 'border-magenta/60 bg-magenta/15 text-magenta' : 'border-white/12 text-ink-dim hover:text-ink'}`}
                        >
                          {v}
                        </button>
                      ))
                    ) : (
                      <>
                        {prismBal.data != null && (
                          <span className="mr-1 font-mono text-[10px] tabular-nums text-ink-faint">
                            balance {fmtPrism(prismBal.data)}
                          </span>
                        )}
                        {(['half', 'max'] as const).map((k) => (
                          <button
                            key={k}
                            type="button"
                            disabled={prismBal.data == null || prismBal.data === 0n}
                            onClick={() => {
                              const bal = prismBal.data ?? 0n
                              setAmount(formatUnits(k === 'max' ? bal : bal / 2n, 18))
                              setError(null)
                            }}
                            className="press rounded-full border border-white/12 px-2.5 py-1 font-mono text-[10px] uppercase text-ink-dim transition-colors hover:text-ink disabled:opacity-50"
                          >
                            {k}
                          </button>
                        ))}
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-3">
                  <input
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value.replace(/[^0-9.]/g, ''))
                      setError(null)
                    }}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.0"
                    aria-label={`${showSymbol(paySymbol)} amount`}
                    className="w-full min-w-0 bg-transparent font-num text-3xl font-semibold tabular-nums text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                  <span className="shrink-0 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 font-mono text-[11px] font-semibold text-ink-dim">
                    {paySymbol}
                  </span>
                </div>
                {overBalance && (
                  <p className="mt-1 font-mono text-[10px] text-magenta">More than this wallet holds.</p>
                )}
              </div>

              {/* the hinge */}
              <div className="relative z-10 -my-3 flex justify-center">
                <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full border border-white/12 bg-void font-display text-sm text-magenta shadow-[0_0_16px_rgba(255,77,184,0.25)]">
                  ↓
                </span>
              </div>

              {/* you receive */}
              <div className="relative overflow-hidden rounded-xl border border-magenta/25 bg-magenta/[0.05] p-4">
                <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-12 -top-14 h-32 w-32 rounded-full bg-magenta/15 blur-3xl" />
                <div className="relative flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      You receive · estimate
                    </span>
                    {!address ? (
                      <div className="mt-2 font-mono text-[12px] leading-relaxed text-ink-dim">
                        Connect a wallet to quote the route.
                      </div>
                    ) : quote.data ? (
                      <>
                        <div className="mt-1 truncate font-num text-3xl font-bold tabular-nums text-ink">
                          {fmtOut(quote.data.toAmount)}{' '}
                          <span className="text-base font-semibold text-ink-dim">{showSymbol(outSymbol)}</span>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-ink-faint">
                          minimum {fmtOut(quote.data.toAmountMin)} · enforced by the route
                          {quote.data.source === 'pool' ? ' · direct pool' : ''}
                        </div>
                      </>
                    ) : quote.isFetching ? (
                      <div className="mt-2 h-9 w-40 animate-pulse rounded-lg bg-white/5" aria-label="Quoting" />
                    ) : quote.isError ? (
                      <div className="mt-2 font-mono text-[12px] leading-relaxed text-magenta">
                        No route right now: {(quote.error as Error)?.message ?? 'try again shortly'}
                      </div>
                    ) : (
                      <div className="mt-2 font-mono text-[12px] text-ink-dim">Enter an amount to quote.</div>
                    )}
                  </div>
                  <PixelRainbow className="mt-1 h-6 w-auto shrink-0" />
                </div>
              </div>

              {/* slippage — same knob the console offers, in this card's register */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Max slippage</span>
                <span className="flex items-center gap-1.5">
                  {[50, 100, 300].map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      onClick={() => {
                        setSlipBps(bps)
                        setCustomSlip('')
                      }}
                      className={`press rounded-lg px-2.5 py-1 font-num text-[11px] font-semibold tabular-nums ${slipBps === bps && !customSlip ? 'bg-magenta/15 text-magenta ring-1 ring-inset ring-magenta/30' : 'text-ink-faint ring-1 ring-inset ring-white/10 hover:text-ink'}`}
                    >
                      {bps / 100}%
                    </button>
                  ))}
                  <span className="flex items-center rounded-lg px-2 py-1 ring-1 ring-inset ring-white/10">
                    <input
                      value={customSlip}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^0-9.]/g, '')
                        setCustomSlip(raw)
                        const pct = parseFloat(raw)
                        if (Number.isFinite(pct) && pct > 0) setSlipBps(clampSlippageBps(Math.round(pct * 100)))
                      }}
                      placeholder="1.0"
                      inputMode="decimal"
                      enterKeyHint="done"
                      autoComplete="off"
                      aria-label="Custom slippage percent"
                      className="w-9 bg-transparent text-right font-num text-[11px] tabular-nums text-ink outline-none placeholder:text-ink-faint"
                    />
                    <span className="font-num text-[11px] text-ink-faint">%</span>
                  </span>
                </span>
              </div>

              {/* go */}
              <button
                type="button"
                disabled={busy != null || (!!address && (amountRaw <= 0n || overBalance || quote.isError))}
                onClick={() => {
                  if (!address) {
                    window.dispatchEvent(new Event('spectrum:connect'))
                    return
                  }
                  void trade()
                }}
                className="press mt-4 h-12 w-full rounded-xl border border-magenta/50 bg-magenta/15 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-magenta transition-colors hover:enabled:border-magenta hover:enabled:bg-magenta/20 disabled:opacity-60"
              >
                {busy === 'approve'
                  ? 'Approving…'
                  : busy === 'trade'
                    ? dir === 'buy'
                      ? 'Buying…'
                      : 'Selling…'
                    : !address
                      ? 'Connect to trade'
                      : wrongChain
                        ? `Switch to Ethereum + ${dir}`
                        : dir === 'buy'
                          ? 'Buy PRISM'
                          : 'Sell PRISM'}
              </button>
              <p className="mt-3 text-center font-mono text-[10px] text-ink-faint">
                Ethereum mainnet · the route enforces your minimum · what arrives is measured from the
                transaction, never the quote{dir === 'sell' ? ' · selling approves the route exact-amount first' : ''}
                {/* the fee this trade actually pays, stated where it is
                    signed (audit 2026-08-16: the wrapper's cut was charged and
                    disclosed nowhere on this card) — only when the wrapper is
                    seated, which is when it is charged. Sells state it too
                    (wired 2026-08-17) plus the WETH arrival fact. */}
                {directSwapWrapperFor(PRISM_CLAIM_CHAIN_ID) != null && (dir === 'buy' || feeGenerationFor(PRISM_CLAIM_CHAIN_ID) === 2)
                  ? ` · a ${(wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID) / 100).toFixed(1)}% Spectrum fee is ${dir === 'buy' ? 'added on top' : 'taken inside the amount you sell'} and buys & burns PRISM${dir === 'sell' ? ' · proceeds arrive as WETH (same as ETH, unwrap any time)' : ''}`
                  : ''}
              </p>
            </>
          )}
          {error && <p className="mt-3 text-center font-mono text-[11px] text-magenta">{error}</p>}
        </div>
      )}
    </div>
  )
}
