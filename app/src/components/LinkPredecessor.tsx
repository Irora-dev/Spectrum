import { useMemo, useState } from 'react'
import { BasketAvatar } from './BasketAvatar'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { isAddress, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { usePublish } from '../lib/spectrum/use-publish'
import type { VerifiedCreatorMeta } from '../lib/spectrum/creator-metadata'
import { shortAddr } from '../lib/spectrum/format'

// Deployer self-action: declare THIS basket's predecessor AFTER deploy — the
// recovery path when the launch-time publish signature was skipped or lost
// (without it, versions list as two unrelated baskets). Same primitives as the
// deploy ceremony: a deployer-signed `supersedes` claim, persisted down the
// ladder (this browser always + download). Deployer-restricted; verification
// (same signer, same deployer on both baskets) is enforced by the read side —
// a bad claim simply never renders. Copy stays mechanical and neutral.
export function LinkPredecessorButton({
  basket,
  deployer,
  chainId,
  hasPredecessor,
  meta,
  initialPredecessor,
}: {
  basket: string
  deployer: string | null
  chainId: number
  hasPredecessor: boolean
  meta: VerifiedCreatorMeta | null
  /** Pre-selected predecessor (the iterate loop's recorded intent) — the modal
   *  opens with it chosen; the deployer still signs, nothing is assumed. */
  initialPredecessor?: string
}) {
  const { address } = useAccount()
  const [open, setOpen] = useState(false)
  if (!address || !deployer || address.toLowerCase() !== deployer.toLowerCase()) return null
  if (hasPredecessor) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="press inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-violet-bright/45 bg-violet-bright/10 px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-[#cabdff] shadow-[0_0_18px_-8px_rgba(164,139,255,0.5)] hover:border-violet-bright hover:bg-violet-bright/20"
      >
        ⛓ Link previous version
      </button>
      {open && (
        <LinkModal
          basket={basket}
          deployer={deployer}
          chainId={chainId}
          meta={meta}
          initialPredecessor={initialPredecessor}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function LinkModal({
  basket,
  deployer,
  chainId,
  meta,
  initialPredecessor,
  onClose,
}: {
  basket: string
  deployer: string
  chainId: number
  meta: VerifiedCreatorMeta | null
  initialPredecessor?: string
  onClose: () => void
}) {
  const { data: all } = useAllBaskets()
  const publisher = usePublish(chainId)
  const queryClient = useQueryClient()
  const [chosen, setChosen] = useState<string>(initialPredecessor?.toLowerCase() ?? '')
  const [custom, setCustom] = useState('')
  const [filter, setFilter] = useState('')

  // Candidates: this deployer's OTHER baskets on this chain that aren't already
  // superseded. For a repair after a version deploy, that's exactly the old version.
  const candidates = useMemo(
    () =>
      (all ?? []).filter(
        (b) =>
          b.chainId === chainId &&
          b.deployer?.toLowerCase() === deployer.toLowerCase() &&
          b.address.toLowerCase() !== basket.toLowerCase() &&
          !b.supersededBy,
      ),
    [all, basket, chainId, deployer],
  )

  const shownCandidates = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (c) => c.symbol.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q) || c.address.toLowerCase().includes(q),
    )
  }, [candidates, filter])

  const predecessor = chosen || custom.trim()
  const predecessorValid = isAddress(predecessor, { strict: false }) && predecessor.toLowerCase() !== basket.toLowerCase()
  const st = publisher.state.status
  const busy = st === 'signing' || st === 'persisting'

  const sign = () => {
    if (!predecessorValid) return
    void publisher
      .publish({
        // Carry any already-published profile fields so re-signing never clobbers them.
        input: {
          handle: meta?.handle ?? null,
          name: meta?.name ?? null,
          avatarUrl: meta?.avatarUrl ?? null,
          bannerUrl: meta?.bannerUrl ?? null,
          tagline: meta?.tagline ?? null,
          postUrl: meta?.postUrl ?? null,
          thesis: meta?.thesis ?? null,
          sectors: meta?.sectors ?? null,
          timeHorizon: meta?.timeHorizon ?? null,
          supersedes: predecessor,
        },
        basket: basket as Address,
        signer: deployer as Address,
      })
      .then(() => void queryClient.invalidateQueries())
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link previous version"
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative w-full max-w-md overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Deployer self-action</div>
              <h2 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink">Link previous version</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>

          <p className="mt-3 text-sm leading-relaxed text-ink-dim">
            Pick the basket this one replaces. You sign the claim with your deploy wallet, free and
            off-chain, and discovery shows one lineage instead of two.
          </p>

          {st !== 'done' && (
            <>
              {/* the pre-filled choice made VISIBLE even when it isn't among
                  the listed candidates (audit C3: signing an invisible
                  selection) — the sign button must never arm on a choice the
                  UI never showed. */}
              {chosen && !candidates.some((c) => c.address.toLowerCase() === chosen) && (
                <div className="mt-4 rounded-xl border border-cyan/40 bg-cyan/[0.06] px-3 py-2.5 font-mono text-[12px] text-ink">
                  Linking to <span className="font-semibold">{shortAddr(chosen)}</span>
                </div>
              )}
              {/* VISUAL PICKER (the owner live 2026-08-15: "choose the basket
                  visually / search, much like baskets look on the creator
                  page") — the same identity mark the creator page draws,
                  searchable past six. */}
              {candidates.length > 6 && (
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search your baskets…"
                  spellCheck={false}
                  className="mt-4 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
                />
              )}
              {shownCandidates.length > 0 && (
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {shownCandidates.map((c) => (
                    <button
                      key={c.address}
                      type="button"
                      onClick={() => {
                        setChosen(c.address.toLowerCase())
                        setCustom('')
                      }}
                      className={`press flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                        chosen === c.address.toLowerCase()
                          ? 'border-cyan/50 bg-cyan/10'
                          : 'border-white/10 hover:border-white/25'
                      }`}
                    >
                      <BasketAvatar symbol={c.symbol} address={c.address} size={40} />
                      <span className="min-w-0">
                        <span className="block truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                          {c.name || `$${showSymbol(c.symbol)}`}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-ink-faint">
                          ${showSymbol(c.symbol)} · {shortAddr(c.address)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-3">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                  {candidates.length > 0 ? 'Or paste its address' : 'Predecessor address'}
                </div>
                <input
                  value={custom}
                  onChange={(e) => {
                    setCustom(e.target.value)
                    setChosen('')
                  }}
                  placeholder="0x…"
                  spellCheck={false}
                  className="w-full rounded-xl border border-white/10 bg-transparent px-3 py-2.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
                />
              </div>

              {publisher.state.error && (
                <p className="mt-3 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] text-ink-dim">
                  {publisher.state.error}
                </p>
              )}

              <button
                type="button"
                disabled={!predecessorValid || busy}
                onClick={sign}
                className="press mt-4 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
              >
                {st === 'signing' ? 'Confirm in wallet…' : st === 'persisting' ? 'Saving…' : 'Sign the link'}
              </button>
            </>
          )}

          {st === 'done' && (
            <div className="mt-4">
              <div className="rounded-xl border border-teal/40 bg-teal/[0.08] p-5 text-center">
                <div aria-hidden className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-teal/50 bg-teal/15 text-teal">
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                </div>
                <div className="mt-3 font-display text-xl font-bold text-ink">Link successful</div>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">
                  The two versions are now linked. Holders of the old version see this one as the newer version and can
                  upgrade to it; discovery shows one lineage.
                </p>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
                  Signed and saved in this browser. Download the signed file to host it durably.
                </p>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={publisher.download}
                  className="press flex-1 rounded-xl border border-white/12 py-2.5 font-mono text-[11px] uppercase tracking-wide text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  Download blob
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="press flex-1 rounded-xl py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-black"
                  style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
