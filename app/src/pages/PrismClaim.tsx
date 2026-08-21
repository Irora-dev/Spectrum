import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatEther, isAddress, type Address } from 'viem'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { clientFor } from '../lib/chain/rpc'
import { nativeEthUsdOnChain } from '../lib/pools/v4-usd'
import { WALLET_ENABLED } from '../lib/config/features'
import { shortAddr } from '../lib/spectrum/format'
import { InfoDot } from '../components/InfoDot'
import { TradePrism } from '../components/TradePrism'
import { PixelRainbow } from '../components/PoweredByPrism'
import heroArt from '../assets/home-hero-v2.jpg'
import heroArt1280 from '../assets/home-hero-v2.1280.jpg'
import {
  PRISM_CLAIM_CHAIN_ID,
  PRISM_CLAIM_ROOT,
  PRISM_CLAIM_VAULT,
  PRISM_V2_HOOK,
  lookupClaim,
  prismHookAbi,
  prismVaultAbi,
  syncGap,
  wholeTokens,
} from '../lib/prism/claim'

// ─────────────────────────────────────────────────────────────────────────────
// /claim — self-serve claim tool for the PRISM v2 make-good airdrop
// (R's spec, 2026-07-30 desk items 72/74/75; owner asked for page + banner,
// then the wide layout with the home hero art behind it + terse copy).
//
// HONESTY CONTRACT (spec): claimed() before gas · not-in-snapshot = plain "not
// eligible" · fee estimate BEFORE the signature (cost scales with WHOLE tokens
// — each mints a fee-share NFT, ≤128/tx) · sub-1-PRISM mints nothing + earns
// nothing from the fee layer, said plainly · prompt syncNFTs(0) while
// nftBalanceOf < floor(balanceOf/1e18) (msg.sender-only) · NO claim-only
// framing (no sweep exists; the community push follows — claim-only asks
// escalate to R) · COMMS RED LINE: community-launched; this site neither
// operates nor stewards the token.
// ─────────────────────────────────────────────────────────────────────────────

const ETHERSCAN = 'https://etherscan.io'
const CLAIMS_URL = 'https://github.com/Irora-dev/prismv2contracts/blob/main/airdrop/claims.json'

// The hero art fades into the page rather than ending as a rectangle: a foot
// fade via mask (the league/home pattern), plus side + bottom void washes so
// the title always sits on ≥4.5:1 ground.
const HERO_MASK = {
  WebkitMaskImage: 'linear-gradient(180deg, black 0%, black 52%, transparent 99%)',
  maskImage: 'linear-gradient(180deg, black 0%, black 52%, transparent 99%)',
} as const

const fmtPrism = (wei: bigint) => {
  const n = Number(formatEther(wei))
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function useClaimState(account: Address | null) {
  const row = useQuery({
    queryKey: ['prism-claim', 'row', account?.toLowerCase()],
    queryFn: () => lookupClaim(account as string),
    enabled: !!account,
    staleTime: Infinity, // the snapshot is immutable
  })
  const claimed = useQuery({
    queryKey: ['prism-claim', 'claimed', account?.toLowerCase()],
    queryFn: () =>
      clientFor(PRISM_CLAIM_CHAIN_ID).readContract({
        address: PRISM_CLAIM_VAULT,
        abi: prismVaultAbi,
        functionName: 'claimed',
        args: [account as Address],
      }),
    enabled: !!account && row.data != null,
  })
  return { row, claimed }
}

export function PrismClaim() {
  const { address: connected, chainId: walletChainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  // Whose allocation: defaults to the connected wallet; any address can be
  // checked — and claimed FOR (permissionless; delivery can't be redirected).
  const [input, setInput] = useState('')
  // Seed from the wallet, then LET GO (QOL 2026-08-07). With `input` in the
  // deps this refired every time the field went empty and typed the connected
  // address straight back in — so select-all-delete, which is exactly how you
  // start checking a second wallet's allocation, fought you. Keyed on the
  // wallet alone: it still seeds on connect and on an account switch, and the
  // "use connected" button below restores it deliberately.
  useEffect(() => {
    if (connected) setInput(connected)
  }, [connected])
  const trimmed = input.trim()
  const account = isAddress(trimmed, { strict: false }) ? (trimmed as Address) : null
  const isSelf = !!connected && !!account && connected.toLowerCase() === account.toLowerCase()

  const { row, claimed } = useClaimState(account)
  const eligible = row.data != null
  const amount = row.data?.amount ?? 0n
  const whole = wholeTokens(amount)

  // Network-fee estimate BEFORE the signature (spec) — the estimate simulates
  // the real call, so the per-whole-token NFT mints are inside the number.
  // Estimated from the CONNECTED wallet when there is one — that's who pays
  // the gas (self-claim or claim-for), and many snapshot holders sit at 0 ETH,
  // where balance-checking nodes can refuse an estimate "from" them.
  const gas = useQuery({
    queryKey: ['prism-claim', 'gas', account?.toLowerCase(), connected?.toLowerCase()],
    queryFn: async () => {
      const client = clientFor(PRISM_CLAIM_CHAIN_ID)
      const [units, gasPrice, ethUsd] = await Promise.all([
        client.estimateContractGas({
          address: PRISM_CLAIM_VAULT,
          abi: prismVaultAbi,
          functionName: 'claim',
          args: [account as Address, row.data!.amount, row.data!.proof],
          account: (connected ?? account) as Address,
        }),
        client.getGasPrice(),
        nativeEthUsdOnChain(PRISM_CLAIM_CHAIN_ID),
      ])
      const wei = units * gasPrice
      const eth = Number(formatEther(wei))
      return { eth, usd: ethUsd != null ? eth * ethUsd : null }
    },
    enabled: eligible && claimed.data === false,
    staleTime: 30_000,
    retry: 1,
  })

  // Fee-share mirror state for the viewed address (drives the sync prompt).
  const hook = useQuery({
    queryKey: ['prism-claim', 'hook', account?.toLowerCase()],
    queryFn: async () => {
      const client = clientFor(PRISM_CLAIM_CHAIN_ID)
      const [bal, nfts] = await Promise.all([
        client.readContract({ address: PRISM_V2_HOOK, abi: prismHookAbi, functionName: 'balanceOf', args: [account as Address] }),
        client.readContract({ address: PRISM_V2_HOOK, abi: prismHookAbi, functionName: 'nftBalanceOf', args: [account as Address] }),
      ])
      return { bal, nfts, gap: syncGap(bal, nfts) }
    },
    enabled: !!account && eligible,
  })

  // The vault empties as holders claim — the live number is the honest one.
  const vaultLeft = useQuery({
    queryKey: ['prism-claim', 'vault-left'],
    queryFn: () =>
      clientFor(PRISM_CLAIM_CHAIN_ID).readContract({
        address: PRISM_V2_HOOK,
        abi: prismHookAbi,
        functionName: 'balanceOf',
        args: [PRISM_CLAIM_VAULT],
      }),
    refetchInterval: 60_000,
  })

  const [busy, setBusy] = useState<'claim' | 'sync' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claimTx, setClaimTx] = useState<string | null>(null)

  const wrongChain = !!connected && walletChainId !== PRISM_CLAIM_CHAIN_ID

  async function ensureMainnet(): Promise<boolean> {
    if (!wrongChain) return true
    try {
      await switchChainAsync({ chainId: PRISM_CLAIM_CHAIN_ID })
      return true
    } catch {
      setError('Switch your wallet to Ethereum mainnet to continue.')
      return false
    }
  }

  async function doClaim() {
    if (!account || !row.data || busy) return
    setError(null)
    if (!(await ensureMainnet())) return
    setBusy('claim')
    try {
      const hash = await writeContractAsync({
        address: PRISM_CLAIM_VAULT,
        abi: prismVaultAbi,
        functionName: 'claim',
        args: [account, row.data.amount, row.data.proof],
        chainId: PRISM_CLAIM_CHAIN_ID,
      })
      await clientFor(PRISM_CLAIM_CHAIN_ID).waitForTransactionReceipt({ hash })
      setClaimTx(hash)
      void queryClient.invalidateQueries({ queryKey: ['prism-claim'] })
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'Claim failed')
    } finally {
      setBusy(null)
    }
  }

  async function doSync() {
    if (busy) return
    setError(null)
    if (!(await ensureMainnet())) return
    setBusy('sync')
    try {
      // 0 = "no caller-imposed limit"; the contract caps each call at 128 mints
      // (verified in source: `if (max != 0 && want > max) want = max`).
      const hash = await writeContractAsync({
        address: PRISM_V2_HOOK,
        abi: prismHookAbi,
        functionName: 'syncNFTs',
        args: [0n],
        chainId: PRISM_CLAIM_CHAIN_ID,
      })
      await clientFor(PRISM_CLAIM_CHAIN_ID).waitForTransactionReceipt({ hash })
      void queryClient.invalidateQueries({ queryKey: ['prism-claim', 'hook'] })
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'Sync failed')
    } finally {
      setBusy(null)
    }
  }

  const gap = hook.data?.gap ?? 0n
  const presses = gap > 0n ? Number((gap + 127n) / 128n) : 0

  return (
    <div className="pb-4">
      {/* ── HERO: the home art, masked into the page (owner 2026-07-30) ── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        <div className="relative h-[280px] sm:h-[320px]">
          <img
            src={heroArt}
            srcSet={`${heroArt1280} 1280w, ${heroArt} 3840w`}
            sizes="100vw"
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover object-[center_30%] opacity-70"
            style={HERO_MASK}
          />
          {/* legibility washes: bottom + sides into the void */}
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-void via-void/35 to-void/20" />
          <div aria-hidden className="absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-void to-transparent sm:w-40" />
          <div aria-hidden className="absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-void to-transparent sm:w-40" />

          <div className="absolute inset-x-0 bottom-0">
            <div className="mx-auto max-w-[1000px] px-4 pb-6 sm:px-6">
              <div className="flex items-center gap-3">
                <PixelRainbow className="h-5 w-auto shrink-0" />
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-ink-dim">
                  PRISM · community airdrop
                </div>
              </div>
              {/* the site wordmark's spectral-sweep treatment, at hero size (owner) */}
              <h1 className="spectrum-wordmark mt-2 font-display text-6xl font-bold uppercase leading-[0.95] tracking-tight sm:text-7xl">
                Claim PRISM&nbsp;v2
              </h1>
              <p className="mt-3 max-w-2xl text-pretty text-base leading-snug text-ink-dim">
                1,203 v1 holder addresses have a make-good waiting in a permissionless vault on
                Ethereum. Check an address, claim from your own wallet.
                <InfoDot>
                  This page checks the public snapshot and submits the claim from your wallet.
                  Anyone can claim for any address; tokens always deliver to the snapshot address
                  itself, so a claim can&rsquo;t be redirected.
                </InfoDot>
              </p>
              {/* provenance — every claim on this page is checkable */}
              <div className="mt-4 flex flex-wrap gap-2">
                <a
                  className="press inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-void/60 px-3 py-1.5 font-mono text-[10px] text-ink-dim backdrop-blur transition-colors hover:border-white/25 hover:text-ink"
                  href={`${ETHERSCAN}/address/${PRISM_CLAIM_VAULT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  vault {shortAddr(PRISM_CLAIM_VAULT)} <span aria-hidden className="text-ink-faint">↗</span>
                </a>
                <a
                  className="press inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-void/60 px-3 py-1.5 font-mono text-[10px] text-ink-dim backdrop-blur transition-colors hover:border-white/25 hover:text-ink"
                  href={CLAIMS_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  snapshot + proofs <span aria-hidden className="text-ink-faint">↗</span>
                </a>
                <span
                  className="inline-flex items-center rounded-full border border-white/12 bg-void/60 px-3 py-1.5 font-mono text-[10px] text-ink-faint backdrop-blur"
                  title={PRISM_CLAIM_ROOT}
                >
                  root {PRISM_CLAIM_ROOT.slice(0, 10)}…{PRISM_CLAIM_ROOT.slice(-4)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── the tool, full column: console LEFT · vault/buy rail RIGHT ── */}
      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <div className="min-w-0 space-y-6">
          {/* ── whose allocation ── */}
          <div className="card-surface relative overflow-hidden rounded-2xl p-6">
            <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-magenta/10 blur-3xl" />
            <label htmlFor="claim-addr" className="relative block font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
              Holder address
            </label>
            <div className="relative mt-2 flex flex-wrap items-center gap-2">
              <input
                id="claim-addr"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  setClaimTx(null)
                  setError(null)
                }}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-white/12 bg-black/25 px-3 py-2.5 font-mono text-lg text-ink placeholder:text-ink-faint focus:border-cyan/50 focus:outline-none"
              />
              {connected && !isSelf && (
                <button
                  type="button"
                  onClick={() => setInput(connected)}
                  className="press rounded-full border border-white/12 px-3 py-1.5 font-mono text-[11px] text-ink-dim hover:text-ink"
                >
                  use connected
                </button>
              )}
            </div>

            {/* ── status ── */}
            {!account && trimmed && (
              <p className="relative mt-4 font-mono text-[12px] text-magenta">That doesn&rsquo;t parse as an address.</p>
            )}
            {!trimmed && (
              <p className="relative mt-4 font-mono text-[12px] text-ink-faint">
                {WALLET_ENABLED ? 'Connect a wallet or paste an address.' : 'Paste an address to check it.'}
              </p>
            )}
            {account && (row.isLoading || (eligible && claimed.isLoading)) && (
              <p className="relative mt-4 font-mono text-[12px] text-ink-faint">Checking the snapshot…</p>
            )}
            {account && row.isSuccess && !eligible && (
              <p className="relative mt-4 font-mono text-[12px] leading-relaxed text-ink-dim">
                {shortAddr(account)} isn&rsquo;t in the snapshot: nothing to claim here.
                <InfoDot>
                  The make-good covers the 1,203 addresses holding v1 PRISM when the snapshot was
                  taken, before the v2 launch. Holding v1 in a different wallet? Check that
                  address too.
                </InfoDot>
              </p>
            )}

            {account && eligible && claimed.data === true && (
              <div className="relative mt-4 rounded-xl border border-teal/30 bg-teal/[0.06] p-4">
                <div className="font-display text-sm font-bold uppercase tracking-wide text-teal">Already delivered</div>
                <p className="mt-1 font-mono text-[12px] leading-relaxed text-ink-dim">
                  {shortAddr(account)} has its {fmtPrism(amount)} PRISM; the vault marks it claimed.
                </p>
                {claimTx && (
                  <a className="mt-1 inline-block font-mono text-[11px] text-teal underline underline-offset-2" href={`${ETHERSCAN}/tx/${claimTx}`} target="_blank" rel="noreferrer">
                    view the transaction
                  </a>
                )}
              </div>
            )}

            {account && eligible && claimed.data === false && (
              <div className="relative mt-6">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-num text-5xl font-bold tabular-nums text-ink">{fmtPrism(amount)}</span>
                  <span className="font-display text-lg font-bold uppercase tracking-tight text-ink-dim">
                    PRISM <span className="text-magenta">unclaimed</span>
                  </span>
                </div>
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-faint">
                  {gas.data
                    ? `≈ ${gas.data.eth.toLocaleString('en-US', { maximumFractionDigits: 5 })} ETH${gas.data.usd != null ? ` (~$${gas.data.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })})` : ''} network fee at current gas`
                    : gas.isError
                      ? 'Fee estimate unavailable right now; your wallet shows the exact fee before you sign.'
                      : 'Estimating the network fee…'}
                  <InfoDot>
                    The fee scales with whole tokens held, not value: delivery mints one fee-share
                    NFT per whole PRISM (at most 128 per transaction). Under 1 whole PRISM
                    it&rsquo;s a plain transfer, about a dollar at quiet gas.
                  </InfoDot>
                </p>
                {whole === 0n && (
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-amber/90">
                    Under 1 whole PRISM: mints no fee-share NFT, earns nothing from the fee stream.
                    The tokens are still yours.
                  </p>
                )}
                {WALLET_ENABLED ? (
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => {
                      if (!connected) {
                        window.dispatchEvent(new Event('spectrum:connect'))
                        return
                      }
                      void doClaim()
                    }}
                    className="press mt-4 h-12 w-full rounded-xl border border-cyan/50 bg-cyan/15 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-cyan transition-colors hover:enabled:border-cyan hover:enabled:bg-cyan/20 disabled:opacity-60"
                  >
                    {busy === 'claim'
                      ? 'Claiming…'
                      : !connected
                        ? 'Connect a wallet to claim'
                        : wrongChain
                          ? 'Switch to Ethereum + claim'
                          : isSelf
                            ? 'Claim'
                            : `Claim for ${shortAddr(account)}`}
                  </button>
                ) : (
                  <p className="mt-4 font-mono text-[11px] leading-relaxed text-ink-dim">
                    This build ships without wallet features. The claim is permissionless: any
                    wallet can submit it on the{' '}
                    <a className="underline underline-offset-2" href={`${ETHERSCAN}/address/${PRISM_CLAIM_VAULT}#writeContract`} target="_blank" rel="noreferrer">
                      vault&rsquo;s contract page
                    </a>{' '}
                    with the amount + proof from the snapshot above.
                  </p>
                )}
                {/* THE FAILURE BELONGS BESIDE THE BUTTON THAT CAUSED IT (QOL
                    2026-08-07). `error` used to render only at the very bottom
                    of the left column — after this card, after the whole
                    TradePrism panel and the mirror card — so a rejected or
                    reverted claim snapped the button back to "Claim" with the
                    explanation a screenful below, off-screen. It still renders
                    down there for the sync action's own failures; a claim
                    failure now says so where you are looking. */}
                {error && busy !== 'claim' && (
                  <p className="mt-3 rounded-lg border border-magenta/30 bg-magenta/[0.06] px-3 py-2 font-mono text-[11px] leading-relaxed text-magenta">
                    {error}
                  </p>
                )}
                {!isSelf && connected && (
                  <p className="mt-2 font-mono text-[10px] text-ink-faint">
                    You pay the gas; the PRISM delivers to {shortAddr(account)}.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Trade PRISM sits right under the claim card (owner 2026-07-30) */}
          <TradePrism />

          {/* ── fee-share mirror top-up (the step everyone misses) ── */}
          {account && eligible && hook.data && gap > 0n && (
            <div className="card-surface rounded-2xl p-6">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber">
                One more step · fee-share NFTs
              </div>
              <p className="mt-2 font-mono text-[12px] leading-relaxed text-ink-dim">
                Fee-share NFTs mirror whole tokens, at most 128 minted per transaction.
                {' '}{shortAddr(account)} is <span className="text-ink">{gap.toString()} short</span>: fees
                only stream to NFTs you hold, so the gap is lost yield.
                <InfoDot>
                  Holds {fmtPrism(hook.data.bal)} PRISM but {hook.data.nfts.toString()} fee-share
                  NFT{hook.data.nfts === 1n ? '' : 's'}. The mirror mints for the holding wallet
                  only, so nobody can do this on its behalf.
                </InfoDot>
              </p>
              {isSelf && WALLET_ENABLED ? (
                <>
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => void doSync()}
                    className="press mt-3 rounded-xl border border-amber/50 bg-amber/15 px-5 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-amber hover:enabled:border-amber disabled:opacity-60"
                  >
                    {busy === 'sync' ? 'Minting…' : wrongChain ? 'Switch to Ethereum + mirror' : `Mirror ${gap > 128n ? 'next 128' : gap.toString()} NFT${gap === 1n ? '' : 's'}`}
                  </button>
                  {presses > 1 && (
                    <p className="mt-2 font-mono text-[10px] text-ink-faint">
                      About {presses} presses at 128 per transaction; this card disappears when the
                      counts match.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-3 font-mono text-[11px] text-ink-faint">
                  Only {shortAddr(account)} itself can mirror.
                </p>
              )}
            </div>
          )}

          {error && <p className="font-mono text-[12px] text-magenta">{error}</p>}
        </div>

        {/* ── the rail: vault, buy, the plan ── */}
        <div className="min-w-0 space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
            <div className="p-4">
              <div className="truncate font-num text-2xl font-bold tabular-nums text-ink">
                {vaultLeft.data != null ? fmtPrism(vaultLeft.data) : '…'}
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                PRISM still in the vault · live
              </div>
            </div>
            <div className="border-t border-white/[0.07] p-4">
              <div className="font-num text-2xl font-bold tabular-nums text-ink">1,203</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                snapshot addresses
              </div>
            </div>
            <div className="border-t border-white/[0.07] p-4">
              {/* deliberately quieter than the numeric tiles (owner) */}
              <div className="font-display text-base font-bold uppercase tracking-tight text-ink">None</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                deadline · a push covers the rest
              </div>
            </div>
          </div>

          {/* ── the plan, honestly ── */}
          <div className="space-y-2 rounded-xl border border-white/8 bg-white/[0.015] p-4">
            <p className="font-mono text-[11px] leading-relaxed text-ink-faint">
              No deadline. A later community push delivers whatever stays unclaimed;
              self-claiming is just sooner (and cheaper for the push).
            </p>
            <p className="font-mono text-[11px] leading-relaxed text-ink-faint">
              PRISM v2 is community-launched. This site only provides the tool.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
