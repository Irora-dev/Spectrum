import { useMemo, useState } from 'react'
import { InfoDot } from '../InfoDot'
import { chainMeta } from '../ChainBadge'
import { SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { addManualAssets, probeAssetAcrossChains, type ChainProbeResult } from '../../lib/spectrum/manual-assets'

// ─────────────────────────────────────────────────────────────────────────────
// PASTE TO ADD (owner 2026-08-12: "we need to allow people to paste a contract
// address to detect any asset that our system didn't pick up automatically";
// then 2026-08-13: "add asset by address also needs to be on the main
// portfolio page somewhere nicely placed").
//
// ONE implementation, own file. It shipped as a local component at the foot of
// the positions card — a seat that needed a full scroll past the whole bento
// (measured 2026-08-13: y=1664 of a 3083px page at 1440, y=2198 of 4082px at
// 390). It now sits in the hero's right column beside "Link a new wallet",
// which is in the first viewport at both widths and is the same FAMILY of act:
// teaching the book about something it doesn't know yet. The trigger wears
// that neighbour's exact idiom so the pair reads as one utility column.
//
// The laws are the module's, unchanged by the move: a token exists PER CHAIN,
// so a paste probes EVERY supported network and adds it only where this wallet
// group actually holds a balance; reads only (describe + balanceOf), nothing
// signs; every shown string is bounded (describeTokens caps the symbol,
// showSymbol bounds the render); a refusal is always NAMED.
// ─────────────────────────────────────────────────────────────────────────────

export function PasteToAdd({
  owners,
  onAdded,
  icon = false,
}: {
  /** The wallet group being read — one address or the linked set. */
  owners: string | string[] | undefined
  /** The book landed a new asset: re-read the sweep. */
  onAdded: () => void
  /** ICON-ONLY at-rest face (the owner live 2026-08-13: the hero pair "can just
   *  be made nice symbols and moved next to each other") — the open editor
   *  is unchanged. Absent = the labelled pill exactly as it was. */
  icon?: boolean
}) {
  const list = useMemo(
    () =>
      (Array.isArray(owners) ? owners : owners ? [owners] : [])
        .map((a) => a.toLowerCase())
        .filter((a, i, arr) => /^0x[0-9a-f]{40}$/.test(a) && arr.indexOf(a) === i),
    [owners],
  )
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<{ kind: 'added' | 'none' | 'refused'; text: string } | null>(null)

  const run = async () => {
    const addr = value.trim().toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      setVerdict({ kind: 'refused', text: 'That is not a contract address — paste the full 0x… token address.' })
      return
    }
    if (list.length === 0) {
      setVerdict({ kind: 'refused', text: 'Connect a wallet first — an asset is added to a book, and there is none yet.' })
      return
    }
    setBusy(true)
    setVerdict(null)
    try {
      const results: ChainProbeResult[] = await probeAssetAcrossChains(addr, list)
      const held = results.filter((r) => r.found && r.amount > 0)
      if (held.length > 0) {
        addManualAssets(list[0], held.map((r) => ({ chainId: r.chainId, address: addr })))
        const where = held.map((r) => `${chainMeta(r.chainId).short} ${r.amount.toPrecision(4)}`).join(' · ')
        setVerdict({
          kind: 'added',
          text: `Added $${showSymbol(held[0].symbol ?? '?')} — ${where}. It joins your book on the next read.`,
        })
        setValue('')
        onAdded()
        return
      }
      const found = results.filter((r) => r.found)
      if (found.length === 0) {
        setVerdict({
          kind: 'refused',
          text: `Nothing at that address answers as a token on ${SUPPORTED_CHAIN_IDS.map((c) => chainMeta(c).short).join(' · ')} — check the address and the network.`,
        })
        return
      }
      // found, but the group holds none of it — and say so honestly if a read failed
      const dark = found.some((r) => r.unreadable)
      setVerdict({
        kind: 'none',
        text: dark
          ? `$${showSymbol(found[0].symbol ?? '?')} exists on ${found.map((r) => chainMeta(r.chainId).short).join(' · ')}, but a balance read didn’t answer — not added; try again in a moment.`
          : `0 balance for this wallet group on any supported network — $${showSymbol(found[0].symbol ?? '?')} was not added.`,
      })
    } catch {
      setVerdict({ kind: 'refused', text: 'That address could not be read just now — nothing was added.' })
    } finally {
      setBusy(false)
    }
  }

  // AT REST: the twin of the wallet-link door it stands beside — same height,
  // radius, type and hover, so the hero's utility column reads as one pair
  // rather than two unrelated controls. No outer margin: the column's own gap
  // places it (the caller owns layout).
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label="Add an asset by address"
        title="Add an asset by address"
        className={
          icon
            ? 'press inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-ink-dim transition-colors hover:border-cyan/40 hover:text-ink'
            : 'press inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-cyan/40 hover:text-ink'
        }
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        {icon ? null : 'Add an asset by address'}
      </button>
    )
  }
  // OPEN: fills whatever column it sits in (w-full) and WRAPS — in the hero's
  // ~300px column that stacks label / input / actions, at full width it is one
  // row. One markup, both widths, no variant flag.
  return (
    <div className="w-full rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="paste-asset" className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          Token contract address
          <InfoDot>
            For anything the automatic sweep missed. We check every supported network for that address and add it
            only where this wallet group actually holds a balance. Reading is free and signs nothing.
          </InfoDot>
        </label>
        <input
          id="paste-asset"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void run()
          }}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 basis-full rounded-lg border border-white/12 bg-void/40 px-3 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50 sm:basis-auto"
        />
        <div className="flex flex-1 items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run()}
            className="press rounded-lg border border-cyan/50 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:enabled:bg-cyan/10 disabled:opacity-60"
          >
            {busy ? 'Checking…' : 'Detect'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setVerdict(null)
            }}
            aria-label="Close"
            className="press rounded-lg border border-white/12 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
          >
            Close
          </button>
        </div>
      </div>
      {verdict && (
        <p
          role="status"
          className={`mt-2.5 font-mono text-[11px] leading-relaxed ${
            verdict.kind === 'added' ? 'text-teal' : verdict.kind === 'none' ? 'text-ink-dim' : 'text-amber-300/85'
          }`}
        >
          {verdict.text}
        </p>
      )}
    </div>
  )
}
