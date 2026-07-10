import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect, type Connector } from 'wagmi'
import { useActiveChain } from '../lib/chain/active-chain'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const btn =
  'press border border-white/20 bg-white/[0.04] px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-ink hover:border-cyan hover:text-cyan'

// Connected state: the address opens a small profile menu (copy / explorer /
// disconnect) — clicking your own address must never disconnect you directly.
function ConnectedMenu({ address }: { address: string }) {
  const { disconnect } = useDisconnect()
  const { cfg } = useActiveChain()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable — the full address is visible in the menu */
    }
  }

  const item =
    'press flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim hover:bg-white/[0.06] hover:text-ink'

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={btn}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Wallet menu"
      >
        {short(address)}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Wallet menu"
          className="search-pop absolute right-0 z-50 mt-2 w-64 rounded-2xl border border-white/12 bg-panel/95 p-2 shadow-[0_30px_70px_-15px_rgba(0,0,0,0.8)] backdrop-blur-2xl"
        >
          <div className="break-all border-b border-white/10 px-3 pb-2 pt-1 font-mono text-[11px] leading-relaxed text-ink">
            {address}
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            <button role="menuitem" onClick={copy} className={item}>
              <span>Copy address</span>
              <span className="text-ink-faint">{copied ? '✓ copied' : '⧉'}</span>
            </button>
            <a
              role="menuitem"
              href={`${cfg.explorer}/address/${address}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className={item}
            >
              <span>View on explorer</span>
              <span className="text-ink-faint">↗</span>
            </a>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              className={`${item} hover:text-magenta`}
            >
              <span>Disconnect</span>
              <span className="text-ink-faint">⏻</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function WalletButton() {
  const { address, isConnected } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const [open, setOpen] = useState(false)

  if (isConnected && address) {
    return <ConnectedMenu address={address} />
  }

  // De-dupe by name — EIP-6963 discovery can surface the same wallet twice.
  const seen = new Set<string>()
  const deduped = connectors.filter((c) => {
    const k = c.name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Display order: Rabby first, then MetaMask, then other named wallets (Coinbase,
  // etc.). The universal WalletConnect QR and the generic "Injected" catch-all sink
  // to the bottom. Named wallets only appear when installed (via EIP-6963), so this
  // is a preference, not a guarantee they're present. Stable sort preserves
  // discovery order within a tier; operators can retune `rank` to taste.
  const rank = (name: string): number => {
    const n = name.toLowerCase()
    if (n.includes('rabby')) return 0
    if (n.includes('metamask')) return 1
    if (n === 'injected') return 99 // generic catch-all → last
    if (n.includes('walletconnect')) return 98 // universal QR fallback → near last
    return 10 // other named wallets (Coinbase, Phantom, …)
  }
  const list = deduped.sort((a, b) => rank(a.name) - rank(b.name))

  const pick = (c: Connector) => {
    connect({ connector: c })
    setOpen(false)
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className={btn}>
        Connect
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connect wallet"
            className="search-pop w-[360px] max-w-full border border-white/15 bg-panel p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink">Connect wallet</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="press -m-2 grid h-10 w-10 place-items-center text-ink-faint hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {list.length === 0 && (
                <p className="py-4 text-center text-sm text-ink-faint">
                  No wallet detected. Install Rabby, MetaMask, or Coinbase Wallet.
                </p>
              )}
              {list.map((c) => (
                <button
                  key={c.uid}
                  onClick={() => pick(c)}
                  disabled={isPending}
                  className="press flex items-center justify-between border border-white/10 px-4 py-3 text-left hover:border-cyan/50 hover:bg-white/[0.04] disabled:opacity-50"
                >
                  <span className="text-sm text-ink">{c.name}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    {c.type === 'injected' ? 'Injected' : 'Connect'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
