import { useCallback, useState } from 'react'
import type { Address } from 'viem'
import { useSignTypedData } from 'wagmi'
import { chainCfg } from '../chain/chains'
import { metadataUrlFor } from '../config/operator'
import {
  buildCreatorMetadata,
  fetchSignedMetadata,
  hasPublishableMetadata,
  signCreatorMetadata,
  verifyCreatorMetadata,
  type CreatorMetadataInput,
  type SignedCreatorMetadata,
} from './creator-metadata'
import {
  conventionPath,
  downloadMetadataBlob,
  postToWriteRelay,
  saveLocalMetadata,
  type RelayOutcome,
} from './persist-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// The creator "publish a new basket version / profile" ceremony
// (FE-VERSION-PUBLISH-DESIGN §5, Phase A). The sign/verify/read primitives in
// creator-metadata.ts already exist with ZERO callers — this hook is the missing
// publish step that wires them up: assemble the blob, sign it in the creator's own
// wallet (the FE owns no key — RL-5), then persist it down the ladder
// (persist-metadata.ts). resolveCreatorMeta then renders it behind the same
// on-chain verify gate. Discovery is unchanged.
//
// Optional + skippable: a creator who entered no profile and is launching a root
// basket has nothing to publish (hasPublishableMetadata === false) — the caller
// skips the ceremony entirely. A version-mode launch is always publishable
// (it carries `supersedes`).
// ─────────────────────────────────────────────────────────────────────────────

export type PublishStatus = 'idle' | 'signing' | 'persisting' | 'done' | 'skipped' | 'error'

export interface PublishState {
  status: PublishStatus
  error: string | null
  /** Outcome of the optional operator write-relay rung (null until attempted). */
  relay: RelayOutcome | null
  /** True once a relay-submitted blob was read back from the host + re-verified. */
  relayVerified: boolean
  /** The signed blob (available after a successful sign) — backs the download rung. */
  blob: SignedCreatorMetadata | null
  /** The convention path (`<chainId>/<basket>.json`) the blob must be served from. */
  path: string | null
  /** The full convention URL when a metadata host is configured, else null. */
  url: string | null
}

const IDLE: PublishState = {
  status: 'idle',
  error: null,
  relay: null,
  relayVerified: false,
  blob: null,
  path: null,
  url: null,
}

export interface PublishArgs {
  input: CreatorMetadataInput
  basket: Address
  /** The deploying wallet — equals the basket's on-chain deployer, so it is also
   *  the address the blob's signature must recover to. */
  signer: Address
}

export interface UsePublish {
  state: PublishState
  /** Build → sign → persist. Resolves when the ladder has run (never throws). */
  publish: (args: PublishArgs) => Promise<void>
  /** Decline to publish — leaves the basket on honest deployer-address attribution. */
  skip: () => void
  /** Re-download the signed JSON (self-host / manual operator submission). */
  download: () => void
  reset: () => void
}

export function usePublish(chainId: number): UsePublish {
  const factory = chainCfg(chainId).factory
  const { signTypedDataAsync } = useSignTypedData()
  const [state, setState] = useState<PublishState>(IDLE)

  const publish = useCallback(
    async ({ input, basket, signer }: PublishArgs) => {
      if (!factory) {
        setState({ ...IDLE, status: 'error', error: 'No factory configured for this chain.' })
        return
      }

      // 1 · build + sign (in the creator's wallet)
      let signed: SignedCreatorMetadata
      try {
        const meta = buildCreatorMetadata(input, basket, Math.floor(Date.now() / 1000))
        if (!hasPublishableMetadata(meta)) {
          setState({ ...IDLE, status: 'skipped' })
          return
        }
        setState({ ...IDLE, status: 'signing' })
        signed = await signCreatorMetadata({ meta, signer, chainId, factory, signTypedDataAsync })
      } catch (e) {
        // A user-rejected signature lands here too — treat as a recoverable error
        // (the creator can retry or skip; the deploy itself already succeeded).
        setState({ ...IDLE, status: 'error', error: messageOf(e) })
        return
      }

      const path = conventionPath(chainId, basket)
      const url = metadataUrlFor(chainId, basket)
      setState({ ...IDLE, status: 'persisting', blob: signed, path, url })

      // 2 · persist down the ladder
      // localStorage — ALWAYS, so the creator's own browser shows it immediately.
      saveLocalMetadata(chainId, basket, signed)

      // operator write-relay — only when configured; never authoritative.
      const relay = await postToWriteRelay(chainId, basket, signed)
      let relayVerified = false
      if (relay === 'submitted') {
        // Re-verify before claiming success: read the blob back from the host and
        // check its signature recovers to the deployer (== signer). A relay that
        // accepted but didn't actually serve a valid blob shows as "submitted",
        // not "verified".
        relayVerified = await verifyHosted(chainId, factory, basket, signer)
      }

      setState({ status: 'done', error: null, relay, relayVerified, blob: signed, path, url })
    },
    [chainId, factory, signTypedDataAsync],
  )

  const skip = useCallback(() => setState({ ...IDLE, status: 'skipped' }), [])
  const reset = useCallback(() => setState(IDLE), [])
  const download = useCallback(() => {
    setState((s) => {
      if (s.blob) downloadMetadataBlob(s.blob.metadata.basket, s.blob)
      return s
    })
  }, [])

  return { state, publish, skip, download, reset }
}

/** Read the just-published blob back from the convention host and re-verify it. */
async function verifyHosted(
  chainId: number,
  factory: Address,
  basket: Address,
  expectedDeployer: Address,
): Promise<boolean> {
  const url = metadataUrlFor(chainId, basket)
  if (!url) return false
  const hosted = await fetchSignedMetadata(url)
  if (!hosted) return false
  if (!hosted.metadata?.basket || hosted.metadata.basket.toLowerCase() !== basket.toLowerCase()) return false
  return verifyCreatorMetadata(hosted, { chainId, factory, expectedDeployer })
}

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string') {
    return e.shortMessage
  }
  if (e instanceof Error) return e.message
  return 'Could not sign the metadata.'
}
