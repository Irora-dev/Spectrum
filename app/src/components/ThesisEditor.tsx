import { useEffect, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { chainCfg } from '../lib/chain/chains'
import { encodeBasketMetaJson, NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import type { VerifiedCreatorMeta } from '../lib/spectrum/creator-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// Deployer-only thesis editor (lab 2026-07-28) — shown on the basket page when
// the connected wallet IS the deployer and the chain has a notes registry.
// Writes the thesis as ONE SpectrumNotes tx (authorship = the tx itself), so it
// is live on every site running the kit the moment it confirms. This is also
// the recovery path when the launch-time thesis prompt was rejected, and the
// upgrade path for every basket deployed before theses existed.
// ─────────────────────────────────────────────────────────────────────────────

export function ThesisEditor({
  basket,
  chainId,
  deployer,
  meta,
  variant = 'corner',
  startOpen = false,
}: {
  basket: string
  chainId: number
  deployer: string | null
  meta: VerifiedCreatorMeta | null | undefined
  /** 'corner' — the token page's absolute top-right pin (its host is
   *  position:relative and sized for it). 'inline' — normal block flow, for
   *  hosts that are not (owner 2026-08-16: "Edit clips, text overlaps it" —
   *  the absolute pin lands on whatever ancestor happens to be positioned). */
  variant?: 'corner' | 'inline'
  /** Open straight into the textarea — for hosts whose whole purpose is
   *  editing (the creator page's thesis popup). */
  startOpen?: boolean
}) {
  const { address } = useAccount()
  const cfg = chainCfg(chainId)
  const registry = cfg.notesRegistry
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const isDeployer = !!address && !!deployer && address.toLowerCase() === deployer.toLowerCase()
  const [open, setOpen] = useState(startOpen)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefill with the live thesis when editing.
  useEffect(() => {
    if (open) setText(meta?.thesis ?? '')
  }, [open, meta?.thesis])

  if (!registry || !isDeployer) return null

  async function publish() {
    if (!publicClient || busy) return
    setBusy(true)
    setError(null)
    try {
      const h = await writeContractAsync({
        address: registry as Address,
        abi: notesRegistryAbi,
        functionName: 'setNote',
        // Keep the fields the current note carries that this box doesn't edit.
        args: [basket as Address, NOTE_KINDS.thesis, encodeBasketMetaJson({
          thesis: text,
          tagline: meta?.tagline ?? null,
          sectors: meta?.sectors ?? null,
          timeHorizon: meta?.timeHorizon ?? null,
          postUrl: meta?.postUrl ?? null,
        })],
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'creatorMeta'] })
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Transaction failed.') : 'Transaction failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    // Corner affordance (owner 2026-07-29): just "Edit" + a pen, pinned to the
    // card's top right (the host section is position:relative). Inline hosts
    // get the same pill in normal flow instead — the absolute pin overlapped
    // their text (owner 2026-08-16).
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={meta?.thesis ? 'Edit your thesis' : 'Write your thesis'}
        className={`press inline-flex items-center gap-1.5 rounded-lg border border-cyan/30 bg-cyan/[0.06] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan hover:border-cyan/60 ${
          variant === 'corner' ? 'absolute right-0 top-2.5' : ''
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
        </svg>
        {meta?.thesis ? 'Edit' : 'Write'}
      </button>
    )
  }

  return (
    <div className="mt-3 space-y-2">
      {/* min-h 160, was 100 (owner 2026-08-16: "needs height") — a thesis is
          a paragraph, and three visible lines invited one-liners */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 4000))}
        placeholder="The narrative behind this basket — what you believe, and why these assets carry it."
        className="min-h-[160px] w-full resize-y rounded-xl border border-white/12 bg-black/40 px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none"
      />
      {error && <p className="font-mono text-[11px] text-magenta">{error}</p>}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={publish}
          disabled={busy}
          className="rounded-lg bg-cyan px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-black press hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Confirming…' : 'Publish on-chain'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="rounded-lg border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint press hover:text-ink"
        >
          Cancel
        </button>
        <span className="font-mono text-[10px] text-ink-faint">One small transaction, visible on every site.</span>
      </div>
    </div>
  )
}
