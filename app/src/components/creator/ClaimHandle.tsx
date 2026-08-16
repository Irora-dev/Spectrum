import { useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { getAddress } from 'viem'
import { chainCfg } from '../../lib/chain/chains'
import { WALLET_ENABLED } from '../../lib/config/features'
import {
  HANDLE_FAULT_WORDS,
  handleStateIn,
  normalizeHandle,
  type HandleState,
} from '../../lib/spectrum/creator-handles'
import {
  claimHandleCall,
  HANDLE_AUTHORITY_CHAIN_ID,
  ownerAddress,
} from '../../lib/spectrum/handle-registry'
import { HANDLES_QUERY_KEY, useHandleRegistry } from '../../lib/spectrum/use-handles'
import { useNetworkSwitch, WrongNetworkNotice } from '../WrongNetwork'
import { WalletButton } from '../WalletButton'
import { useCopy } from '../../lib/use-copy'

// ─────────────────────────────────────────────────────────────────────────────
// Claim a creator name (spec: workspace/spectrum-release/creator-handles-spec.md).
//
// One transaction, no account, no backend: the claim is a note about YOURSELF,
// which is why nobody can claim a name for someone else. The check as you type
// costs no network at all, because the whole map is resolved once and cached.
//
// THE RULE THIS SCREEN EXISTS TO KEEP: a name is never shown as available
// unless the site actually resolved the registry. Unknown is not available. A
// failed read disables the button and says so, rather than letting someone pay
// for a name that turns out to be taken.
//
// Not mounted anywhere yet, on purpose — the create flow and the creator page
// are being reworked in parallel. Drop <ClaimHandle /> in and it works.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

const field =
  'w-full rounded-lg border bg-black/30 px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none'

/** What the site can say about the typed name right now. `unknown` is its own
 *  state and never collapses into `free`. */
type Verdict =
  | { kind: 'idle' }
  | { kind: 'unknown' }
  | { kind: 'checking' }
  | { kind: 'state'; state: HandleState }

const sentence = (s: string) => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}.`

function verdictWords(v: Verdict, viewerCanShip: boolean): { tone: 'good' | 'bad' | 'flat'; text: string } | null {
  if (v.kind === 'idle') return null
  if (v.kind === 'checking') return { tone: 'flat', text: 'Checking that name.' }
  if (v.kind === 'unknown') {
    return { tone: 'flat', text: 'We could not check names just now. Try again in a moment.' }
  }
  switch (v.state.state) {
    case 'invalid':
      return { tone: 'bad', text: sentence(HANDLE_FAULT_WORDS[v.state.fault]) }
    case 'taken':
      return { tone: 'bad', text: 'Taken. Another creator claimed this name first.' }
    case 'yours':
      return { tone: 'flat', text: 'This is already your name.' }
    case 'retired':
      return { tone: 'bad', text: 'Retired. A creator used this name and moved on, so it is not free.' }
    case 'reclaimable':
      return { tone: 'good', text: 'This was your name before. You can take it back.' }
    case 'free':
      return viewerCanShip
        ? { tone: 'good', text: 'Free. This one is yours to take.' }
        : { tone: 'flat', text: 'Free, once you have launched a basket.' }
  }
}

export function ClaimHandle({
  className = '',
  initialName = '',
  onClaimed,
}: {
  className?: string
  /** Pre-fills the name field — the unclaimed-URL page passes the name the
   *  visitor was already looking at, so the form opens on their answer. */
  initialName?: string
  /** Fires with the claimed name once the transaction is confirmed. */
  onClaimed?: (handle: string) => void
}) {
  const { address, isConnected } = useAccount()
  const { data: registry, isPending, refetch } = useHandleRegistry()
  const publicClient = usePublicClient({ chainId: HANDLE_AUTHORITY_CHAIN_ID })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const sw = useNetworkSwitch(HANDLE_AUTHORITY_CHAIN_ID)
  const [typed, setTyped] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState<string | null>(null)
  const { copied: linkCopied, copy: copyLink } = useCopy()

  // No registry on the authority chain means this site has no names at all.
  if (!WALLET_ENABLED || registry?.status === 'off') return null

  // ⚠⚠ ONCE YOU OWN A NAME, THE PITCH IS FINISHED (the owner, 2026-08-16: "if you
  // claim then you shouldnt see this you should just see a small line").
  //
  // The card had no owner branch at all — it kept rendering "Claim your name /
  // Turn your creator page from a wallet address into a name" to someone who
  // had already done exactly that, and only answered "This is already your
  // name" if they happened to retype it. A surface that re-pitches a completed
  // job reads as broken, and it buries the one fact the owner actually wants:
  // WHERE their work is published.
  //
  // Hosts were gating this inconsistently (the basket page had a has-name gate,
  // the studio did not), which is the tell that the gate belongs HERE, once,
  // rather than in every mount.
  const owned = registry?.status === 'ok' && address ? (registry.map.byAddress.get(address.toLowerCase()) ?? null) : null
  if (owned && !claimed) {
    return (
      <p className={`font-mono text-[11px] leading-relaxed text-ink-dim ${className}`}>
        Published to{' '}
        <Link to={`/creator/${owned.handle}`} className="text-cyan hover:underline">
          /creator/{owned.display}
        </Link>
      </p>
    )
  }

  const networkName = (() => {
    try {
      return chainCfg(HANDLE_AUTHORITY_CHAIN_ID).name
    } catch {
      return 'the network'
    }
  })()

  const map = registry?.status === 'ok' ? registry.map : null
  const canShip = !!address && registry?.status === 'ok' && registry.shipped.has(address.toLowerCase())
  const verdict: Verdict = !typed.trim()
    ? { kind: 'idle' }
    : isPending && !registry
      ? { kind: 'checking' }
      : map
        ? { kind: 'state', state: handleStateIn(map, typed, address) }
        : { kind: 'unknown' }
  const words = verdictWords(verdict, canShip)
  // Claimable ONLY from a resolved map. Every other path (loading, a failed
  // read, a name already someone's) leaves the button off.
  const claimable =
    verdict.kind === 'state' && (verdict.state.state === 'free' || verdict.state.state === 'reclaimable')
  const ready = claimable && isConnected && !!address && canShip && !sw.mismatch && !busy

  async function claim() {
    if (!address) return
    // No client for the authority chain means this build cannot reach it. Say
    // so rather than letting the button do nothing when it is pressed.
    if (!publicClient) {
      setError(`This site cannot reach ${networkName} right now, so the name cannot be claimed here.`)
      return
    }
    setError(null)
    const call = claimHandleCall(typed, getAddress(address))
    if (!call) {
      setError('That name cannot be claimed.')
      return
    }
    setBusy(true)
    try {
      const hash = await writeContractAsync(call)
      await publicClient.waitForTransactionReceipt({ hash })
      // The map is now stale by exactly one claim: re-read it before anything
      // else can be checked against it.
      await queryClient.invalidateQueries({ queryKey: HANDLES_QUERY_KEY })
      // The canonical form, not the raw keystrokes: the link this hands back
      // has to be the one the site resolves.
      const name = normalizeHandle(typed)?.display ?? typed
      setClaimed(name)
      onClaimed?.(name)
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'The claim did not go through.') : 'The claim did not go through.')
    } finally {
      setBusy(false)
    }
  }

  if (claimed) {
    const claimedUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/creator/${claimed}`
    const xText = `Every basket I make, one page: ${claimedUrl}`
    return (
      <div className={`relative overflow-hidden rounded-2xl border border-cyan/30 bg-cyan/[0.05] p-6 ${className}`}>
        {/* the small ceremony a permanent name deserves — the house gradient,
            once, at the moment it becomes theirs */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL }} />
        <span
          aria-hidden
          className="pointer-events-none absolute -top-16 left-1/2 h-32 w-2/3 -translate-x-1/2 rounded-full opacity-25 blur-3xl"
          style={{ background: 'var(--color-cyan)' }}
        />
        <h3 className="relative font-display text-lg font-semibold text-ink">Your page has a name</h3>
        <p className="relative mt-2 text-sm leading-relaxed text-ink-dim">
          People can find you at{' '}
          <Link to={`/creator/${claimed}`} className="text-cyan underline underline-offset-4">
            /creator/{claimed}
          </Link>
          . Your wallet address still works as a link, and always will.
        </p>
        <div className="relative mt-5 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void copyLink(claimedUrl)}
            className="press rounded-lg bg-cyan px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-[0.14em] text-void hover:opacity-90"
          >
            {linkCopied ? 'Copied ✓' : 'Copy your link'}
          </button>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(xText)}`}
            target="_blank"
            rel="noreferrer"
            className="press rounded-lg border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
          >
            Share on X
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.02] p-6 ${className}`}>
      <h3 className="font-display text-lg font-semibold text-ink">Claim your name</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-dim">
        Turn your creator page from a wallet address into a name people can read and remember.
      </p>

      {!isConnected || !address ? (
        <div className="mt-5 flex flex-col items-start gap-3">
          <p className="text-sm text-ink-dim">Connect the wallet you launch baskets with. The name goes to it.</p>
          <WalletButton />
        </div>
      ) : (
        <>
          <div className="mt-5">
            <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint" htmlFor="creator-handle">
              Your name
            </label>
            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-sm text-ink-faint">/creator/</span>
              <input
                id="creator-handle"
                // the field's ring answers with the words: cyan when the name
                // is takeable, amber when it can't be, quiet otherwise
                className={`${field} ${
                  words?.tone === 'good'
                    ? 'border-cyan/50 focus:border-cyan'
                    : words?.tone === 'bad'
                      ? 'border-amber-400/40 focus:border-amber-400/70'
                      : 'border-white/12 focus:border-cyan/60'
                }`}
                value={typed}
                spellCheck={false}
                autoComplete="off"
                maxLength={40}
                placeholder="basedresearch"
                aria-invalid={words?.tone === 'bad' || undefined}
                onChange={(e) => {
                  setTyped(e.target.value)
                  setError(null)
                }}
                // Enter claims, like the signup form's own field — typing a name
                // and pressing return should not dead-end at a button you have to
                // go find. Gated on the same `ready` as the button, so the
                // keyboard can never fire a claim the button itself refuses.
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), ready && void claim())}
              />
            </div>
            {/* the link it BECOMES — canonical form, so someone typing
                "BasedResearch" sees the lowercase truth before paying for it */}
            {typed.trim() && verdict.kind === 'state' && verdict.state.state !== 'invalid' && (
              <p className="mt-2 truncate font-mono text-[10px] tracking-[0.08em] text-ink-faint">
                {typeof window !== 'undefined' ? window.location.host : ''}
                <span className="text-ink-dim">/creator/{normalizeHandle(typed)?.display ?? typed}</span>
              </p>
            )}
            {words && (
              <p
                className={`mt-2 text-xs leading-relaxed ${
                  words.tone === 'good' ? 'text-cyan' : words.tone === 'bad' ? 'text-amber-300/90' : 'text-ink-faint'
                }`}
                role="status"
              >
                {words.text}
                {verdict.kind === 'state' && verdict.state.state === 'taken' && (
                  <>
                    {' '}
                    <Link
                      to={`/creator/${ownerAddress(verdict.state.owner)}`}
                      className="underline underline-offset-4"
                    >
                      See whose it is
                    </Link>
                    .
                  </>
                )}
              </p>
            )}
            {verdict.kind === 'unknown' && (
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan press"
              >
                Try again
              </button>
            )}
          </div>

          {!canShip && registry?.status === 'ok' && (
            <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-ink-dim">
              {/* the gate counts ANY of the three chains now (owner
                  2026-08-06), so the copy must not name one */}
              Names go to creators who have shipped. Launch a basket on any network first, then this name is
              yours to take.
            </p>
          )}

          <WrongNetworkNotice
            requiredChainId={HANDLE_AUTHORITY_CHAIN_ID}
            action="Creator names live"
            sw={sw}
            className="mt-4"
            button={{
              className:
                'mt-3 w-full rounded-lg border border-cyan/50 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-cyan',
            }}
          />

          <button
            type="button"
            onClick={() => void claim()}
            disabled={!ready}
            className="mt-5 w-full rounded-lg bg-cyan px-5 py-3 font-mono text-xs font-bold uppercase tracking-[0.18em] text-void press disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-ink-faint"
          >
            {busy ? 'Confirm in your wallet' : 'Claim this name'}
          </button>

          {error && <p className="mt-3 text-xs leading-relaxed text-amber-300/90">{error}</p>}

          {/* Say the cost and the permanence plainly, before the signature. */}
          <p className="mt-4 text-xs leading-relaxed text-ink-faint">
            One transaction on {networkName}, network fee only. Public and permanent; renaming retires the old name
            rather than reusing it.
          </p>
        </>
      )}
    </div>
  )
}
