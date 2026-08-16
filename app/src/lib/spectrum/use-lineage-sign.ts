import { useCallback, useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { usePublish, type UsePublish } from './use-publish'

// ─────────────────────────────────────────────────────────────────────────────
// THE SILENT LINEAGE SIGNATURE — BasketBuilder's :770-791 effect, EXTRACTED
// (owner 2026-07-09 ~16:25, adopted REC). Removing the publish ceremony also
// removed the ONLY vehicle that signed `supersedes`, so a version deploy listed
// as an unrelated basket. The recipe: the moment a VERSION deploy succeeds,
// request exactly ONE wallet signature over a supersedes-only blob — all-null
// metadata, no thesis prose, no ceremony UI — then invalidate queries so
// discovery's tagLineage collapses the pair into one lineage at once.
//
// A REFUSED wallet sheet is a FIRST-CLASS state, not an exception: the deploy
// already succeeded and is not undone by declining the link. retry() re-offers
// the sheet; and independently of this hook, LinkPredecessorButton on the NEW
// basket's own page (Token.tsx renders it from the recorded version intent) is
// the standing recovery — a deployed-but-unlinked version is never stranded.
//
// `publisher`: the builder shares ONE publish machine between its (disabled)
// ceremony and this silent signature — DeployPortal reads that machine's status
// to hold the success card until the lineage settles (silentLineagePending),
// and its Close/Start-over handlers reset it. Pass it to keep that single
// machine; omit it and the hook owns a private one (the reshape popup's case).
// ─────────────────────────────────────────────────────────────────────────────

export type LineageSignStatus = 'idle' | 'signing' | 'done' | 'refused'

export interface LineageSignResult {
  state: LineageSignStatus
  /** The wallet/sign failure line when state === 'refused'. */
  error: string | null
  /** Clear the refusal and re-offer the wallet sheet (requires still-armed args). */
  retry: () => void
}

export function useLineageSign(args: {
  predecessor: `0x${string}` | null
  chainId: number
  newToken: `0x${string}` | null
  armed: boolean
  /** Reuse an existing publish machine (see header). Omitted → private one. */
  publisher?: UsePublish
}): LineageSignResult {
  const { predecessor, chainId, newToken, armed } = args
  // Hooks are unconditional: the private machine always exists; the injected
  // one simply takes precedence (the unused private machine stays idle).
  const own = usePublish(chainId)
  const pub = args.publisher ?? own
  const { address: account } = useAccount()
  const queryClient = useQueryClient()
  // Fire-once latch per lineage PAIR (the thesisTxRef precedent in the builder):
  // StrictMode's double-invoked mount effects and the every-render dep churn of
  // the publish machine's identity must never produce a second wallet sheet for
  // the same predecessor→token link. Keyed by the pair so a sequential caller
  // (the thesis modal's per-chain lanes) re-arms cleanly for each new pair.
  const firedFor = useRef<string | null>(null)

  const key = predecessor && newToken ? `${predecessor.toLowerCase()}>${newToken.toLowerCase()}` : null

  useEffect(() => {
    if (!armed || !key || !predecessor || !newToken || !account) return
    if (firedFor.current === key) return
    if (pub.state.status !== 'idle') {
      // The machine still holds a PREVIOUS pair's settled outcome (sequential
      // lanes) — clear it and let the next pass fire clean. Never yank a
      // machine that is mid-signature.
      if (pub.state.status === 'done' || pub.state.status === 'error' || pub.state.status === 'skipped') pub.reset()
      return
    }
    firedFor.current = key
    void pub
      .publish({
        input: {
          handle: null,
          name: null,
          avatarUrl: null,
          bannerUrl: null,
          tagline: null,
          thesis: null,
          sectors: [],
          postUrl: null,
          supersedes: predecessor,
        },
        basket: newToken,
        signer: account,
      })
      // The invalidate runs on every settlement (publish never throws): success
      // re-runs discovery's tagLineage so the pair collapses into one lineage
      // at once — the builder's exact post-publish step.
      .then(() => void queryClient.invalidateQueries())
  }, [armed, key, predecessor, newToken, account, pub, queryClient])

  const retry = useCallback(() => {
    firedFor.current = null
    pub.reset()
  }, [pub])

  // State is reported for THIS pair only: a machine settled by some other
  // caller (the builder's ceremony) or externally reset (portal Close) reads
  // as idle here, never as this lineage's outcome.
  const fired = key != null && firedFor.current === key
  const state: LineageSignStatus = !fired
    ? 'idle'
    : pub.state.status === 'signing' || pub.state.status === 'persisting'
      ? 'signing'
      : pub.state.status === 'done'
        ? 'done'
        : pub.state.status === 'error' || pub.state.status === 'skipped'
          ? 'refused'
          : 'idle'
  return {
    state,
    error: state === 'refused' ? (pub.state.error ?? 'The signature was declined in the wallet.') : null,
    retry,
  }
}
