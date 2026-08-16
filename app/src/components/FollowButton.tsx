import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { useFollows } from '../lib/spectrum/follows'
import { chainCfg } from '../lib/chain/chains'
import { useActiveChainId } from '../lib/chain/active-chain'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import { encodeFollowJson } from '../lib/spectrum/notes-social'

// Follow a creator. The instant layer is THIS browser (lib/spectrum/follows.ts —
// no server, no account; powers the Explore "Following" filter). When the chain
// has a notes registry AND a wallet is connected, the same click ALSO publishes
// the follow on-chain (kind "follow", one setNote tx) — portable across sites
// and countable on the creator's page. The tx is best-effort seasoning: local
// state flips immediately either way, and a rejected signature only means the
// follow stays browser-local.
export function FollowButton({
  deployer,
  className = '',
  variant = 'pill',
}: {
  deployer: string | null
  className?: string
  /** heart = the compact icon form (owner 2026-08-03: "just a small heart
   *  next to the creator address"); pill = the labelled button, unchanged. */
  variant?: 'pill' | 'heart'
}) {
  const { isFollowing, toggle } = useFollows()
  const chainId = useActiveChainId()
  const { address: viewer } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [signing, setSigning] = useState(false)
  if (!deployer) return null
  const following = isFollowing(deployer)
  const registry = (() => {
    try {
      return chainCfg(chainId).notesRegistry
    } catch {
      return null
    }
  })()
  const onchain = !!registry && !!viewer

  function click() {
    const wasFollowing = following
    toggle(deployer!) // the instant, always-works layer
    if (!onchain || !publicClient || signing) return
    setSigning(true)
    void (async () => {
      try {
        const h = await writeContractAsync({
          address: registry as Address,
          abi: notesRegistryAbi,
          functionName: 'setNote',
          // un-follow = clear ("" removes the author's note)
          args: [deployer as Address, NOTE_KINDS.follow, wasFollowing ? '' : encodeFollowJson()],
          chainId,
        })
        await publicClient.waitForTransactionReceipt({ hash: h })
        void queryClient.invalidateQueries({ queryKey: ['spectrum', 'followers', chainId] })
      } catch {
        /* rejected/failed tx → the follow simply stays browser-local */
      } finally {
        setSigning(false)
      }
    })()
  }

  if (variant === 'heart') {
    return (
      <button
        type="button"
        aria-pressed={following}
        aria-label={following ? 'Unfollow this creator' : 'Follow this creator'}
        title={onchain ? 'Follow. Also publishes on-chain (one signature)' : 'Follow. Saved in this browser only'}
        onClick={click}
        className={`press inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
          following ? 'text-cyan' : 'text-ink-faint hover:text-ink'
        } ${signing ? 'animate-pulse' : ''} ${className}`}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill={following ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z" />
        </svg>
      </button>
    )
  }

  return (
    <button
      type="button"
      aria-pressed={following}
      title={onchain ? 'Also publishes on-chain (one signature)' : 'Saved in this browser only'}
      onClick={click}
      className={`press inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
        following
          ? 'border-cyan/50 bg-cyan/10 text-cyan'
          : 'border-white/15 text-ink-dim hover:border-white/35 hover:text-ink'
      } ${className}`}
    >
      {signing ? 'Signing…' : following ? '✓ Following' : '+ Follow'}
    </button>
  )
}
