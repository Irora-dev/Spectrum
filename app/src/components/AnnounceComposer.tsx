import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePublicClient, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { chainCfg } from '../lib/chain/chains'
import { useActiveChainId } from '../lib/chain/active-chain'
import { INTERFACE_TAG_ADDRESS } from '../lib/config/operator'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import { encodeAnnounceJson, useAnnouncement } from '../lib/spectrum/notes-social'

// ─────────────────────────────────────────────────────────────────────────────
// The operator's announcement composer (/setup, operator-gated by the caller):
// one signature publishes a site-wide banner as an on-chain note — author must
// be the committed fee wallet (the read pins it, so only that wallet's words
// ever render). No backend, no CMS; clear = one more signature.
// ─────────────────────────────────────────────────────────────────────────────

export function AnnounceComposer() {
  const chainId = useActiveChainId()
  const registry = (() => {
    try {
      return chainCfg(chainId).notesRegistry
    } catch {
      return null
    }
  })()
  const live = useAnnouncement(chainId, INTERFACE_TAG_ADDRESS)
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [level, setLevel] = useState<'info' | 'warn'>('info')
  const [busy, setBusy] = useState<'publish' | 'clear' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // No registry on this chain, or no committed fee wallet → nothing to compose with.
  if (!registry || !INTERFACE_TAG_ADDRESS) return null

  async function write(note: string, key: 'publish' | 'clear') {
    if (!publicClient || busy) return
    setBusy(key)
    setError(null)
    try {
      const factory = chainCfg(chainId).factory
      if (!factory) throw new Error('No factory configured on this chain.')
      const h = await writeContractAsync({
        address: registry as Address,
        abi: notesRegistryAbi,
        functionName: 'setNote',
        args: [factory, NOTE_KINDS.announce, note],
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      if (key === 'publish') setText('')
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'announce', chainId] })
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Could not publish.') : 'Could not publish.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-2xl border border-line card-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Site announcement</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          publishes on-chain, signed by your fee wallet
        </span>
      </div>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-dim">
        A banner across the top of your site, no backend needed. Visitors can dismiss it; publish an
        empty replacement below to take it down for everyone.
      </p>

      {live.data && (
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">live now</div>
          <p className={`mt-1 text-sm ${live.data.level === 'warn' ? 'text-amber' : 'text-ink-dim'}`}>{live.data.text}</p>
        </div>
      )}

      <div className="mt-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 280))}
          rows={2}
          placeholder="Fees halved this month · maintenance Sunday · new baskets weekly…"
          className="w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-cyan/50 focus:outline-none"
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <div className="flex gap-1.5">
            {(['info', 'warn'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                aria-pressed={level === l}
                className={`press rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${
                  level === l
                    ? l === 'warn'
                      ? 'border-amber/60 bg-amber/15 text-amber'
                      : 'border-cyan/60 bg-cyan/15 text-cyan'
                    : 'border-white/12 text-ink-faint hover:text-ink'
                }`}
              >
                {l === 'warn' ? 'notice' : 'info'}
              </button>
            ))}
          </div>
          <span className="font-num text-[10px] tabular-nums text-ink-faint">{text.length}/280</span>
          <div className="ml-auto flex gap-2">
            {live.data && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => write('', 'clear')}
                className="press rounded-lg border border-white/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:border-magenta/50 hover:text-magenta disabled:opacity-50"
              >
                {busy === 'clear' ? 'Clearing…' : 'Take down'}
              </button>
            )}
            <button
              type="button"
              disabled={!text.trim() || busy !== null}
              onClick={() => write(encodeAnnounceJson({ text, level }), 'publish')}
              className="press rounded-lg bg-cyan px-5 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'publish' ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        </div>
        {error && <p className="mt-2 font-mono text-[11px] text-magenta">{error}</p>}
      </div>
    </div>
  )
}
