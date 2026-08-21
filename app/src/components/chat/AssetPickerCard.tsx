import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentAction } from './agent'
import { CreateAssetPicker } from '../launch/CreateAssetPicker'
import { chainCfg } from '../../lib/chain/chains'

// ── THE CREATE ASK, VISUAL (owner 2026-08-20 19:1x: "way more beautiful and
// visual, with an easier way of picking the assets") ──────────────────────────
// The chat's "name your assets" moment mounts the create page's OWN picker —
// trending tiles + the cross-chain search, the real component, zero drift.
// A tap SPEAKS: it sends "add <address> on <chain>" through the same message
// machinery as typing, so the draft, the buckets, and the bundle prompt all
// behave exactly as if the user had typed the words. Un-tapping a chosen tile
// speaks the remove. The card echoes taps locally so tiles highlight at once;
// the agent's next compose card remains the draft's truth.

type PickerAction = Extract<AgentAction, { kind: 'assetPicker' }>
type PickRef = { chainId: number; address: string; symbol?: string }

const keyOf = (p: { chainId: number; address: string }) => `${p.chainId}:${p.address.toLowerCase()}`
/** the spoken chain word the agent's router understands ("Robinhood Chain" → "robinhood") */
const chainWord = (chainId: number) => chainCfg(chainId).name.toLowerCase().replace(/\s*chain$/, '')

export function AssetPickerCard({ action, onPick }: { action: PickerAction; onPick: (line: string) => void }) {
  // the card measures ITS OWN width — the viewport breakpoints cannot see a
  // 400px widget popover on a wide screen (the picker's colsOverride seam)
  const boxRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState<1 | 2>(1)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const read = () => setCols(el.getBoundingClientRect().width >= 560 ? 2 : 1)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // local echo over the emit-time snapshot: taps highlight immediately, the
  // agent's reply carries the resolved truth a moment later
  const [localAdds, setLocalAdds] = useState<PickRef[]>([])
  const [localDrops, setLocalDrops] = useState<Set<string>>(new Set())
  const chosen = useMemo(() => {
    const m = new Map<string, PickRef>()
    for (const p of action.picked) m.set(keyOf(p), p)
    for (const p of localAdds) m.set(keyOf(p), p)
    for (const k of localDrops) m.delete(k)
    return [...m.values()]
  }, [action.picked, localAdds, localDrops])

  return (
    <div ref={boxRef} className="flex w-full min-w-0 flex-col gap-3 sm:min-w-[var(--chat-card-min,26rem)]">
      <p className="text-sm leading-relaxed text-ink">{action.text}</p>
      <div className="rounded-2xl border border-white/[0.12] bg-white/[0.04] p-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)]">
        <CreateAssetPicker
          picked={chosen}
          full={chosen.length >= 12}
          busy={false}
          colsOverride={cols}
          autoFocus={false}
          onPick={(chainId, address, symbol) => {
            setLocalDrops((d) => {
              if (!d.has(keyOf({ chainId, address }))) return d
              const next = new Set(d)
              next.delete(keyOf({ chainId, address }))
              return next
            })
            setLocalAdds((l) => [...l, { chainId, address, symbol }])
            onPick(`add ${address} on ${chainWord(chainId)}`)
          }}
          onRemove={(chainId, address) => {
            const sym = chosen.find((p) => keyOf(p) === keyOf({ chainId, address }))?.symbol
            setLocalDrops((d) => new Set(d).add(keyOf({ chainId, address })))
            if (sym) onPick(`remove ${sym} on ${chainWord(chainId)}`)
          }}
        />
      </div>
    </div>
  )
}
