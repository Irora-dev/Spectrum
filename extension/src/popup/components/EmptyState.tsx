// First-run: one line about what this is, one field. Read-only means you never
// connect a wallet at all — you paste an address.

import { useState } from 'react'
import { isAddress } from 'viem'
import brand from '@app/brand.config'
import { MicroLabel } from './bits'

export function EmptyState({ onWatch }: { onWatch: (address: string) => void }) {
  const [address, setAddress] = useState('')
  const trimmed = address.trim()
  const valid = isAddress(trimmed, { strict: false })

  return (
    <div className="flex min-h-0 flex-1 flex-col items-stretch justify-center px-6 pb-14">
      <div aria-hidden className="mx-auto mb-6 flex h-2 w-24 overflow-hidden rounded-full ring-1 ring-inset ring-white/10">
        <span className="h-full w-1/3" style={{ background: 'var(--color-cyan)' }} />
        <span className="h-full w-1/3" style={{ background: 'var(--color-violet)' }} />
        <span className="h-full w-1/3" style={{ background: 'var(--color-magenta)' }} />
      </div>

      <h1 className="text-center font-display text-[18px] font-semibold leading-snug text-ink">
        A read-only lens over what you hold
      </h1>
      <p className="mt-3 text-center font-mono text-[11px] leading-relaxed text-ink-dim">
        Your held baskets, decomposed into net per-asset exposure across chains, watched while this
        browser is open, acted on at your {brand.name} site.
      </p>

      <form
        className="mt-8"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onWatch(trimmed)
        }}
      >
        <MicroLabel>watch an address</MicroLabel>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          autoFocus
          placeholder="0x…"
          className={`mt-2 w-full rounded-lg border bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint ${
            trimmed === '' || valid ? 'border-line focus:border-line-bright' : 'border-alert/60'
          }`}
        />
        <button
          type="submit"
          disabled={!valid}
          className={`press mt-4 h-10 w-full rounded-xl font-mono text-[11px] font-medium uppercase tracking-[0.16em] ${
            valid ? 'bg-cyan text-void' : 'bg-white/10 text-ink-faint'
          }`}
        >
          watch
        </button>
      </form>

      <p className="mt-6 text-center font-mono text-[10px] leading-relaxed text-ink-faint">
        It never connects, never signs, never asks for a seed phrase.
      </p>
    </div>
  )
}
