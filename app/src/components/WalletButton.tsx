import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAccount, useConnect, useDisconnect, type Connector } from 'wagmi'
import { useActiveChain } from '../lib/chain/active-chain'
import { hasInjectedProvider, isMobileUA, walletAppLinks } from '../lib/wallet/mobile'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// h-9 + pill: the whole top-right cluster (design toggle · network · wallet)
// shares one height and one shape (owner 2026-08-17: "all different shapes,
// ugly, standardize size/shape")
const btn =
  'press inline-flex h-9 items-center rounded-full border border-white/20 bg-white/[0.04] px-4 font-mono text-xs uppercase tracking-[0.15em] text-ink hover:border-cyan hover:text-cyan'

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
  const { connectors, connect, isPending, error: connectError, reset: resetConnect } = useConnect()
  const [open, setOpen] = useState(false)
  // Which row is being tried, so the dialog can name it in both the pending
  // state and the failure. Cleared when the dialog closes.
  const [trying, setTrying] = useState<string | null>(null)

  // Any surface can summon the connect dialog (the swap console's CTA does) —
  // on a phone "top right" is nothing to point at (mobile UX review 4).
  useEffect(() => {
    const onConnect = () => setOpen(true)
    window.addEventListener('spectrum:connect', onConnect)
    return () => window.removeEventListener('spectrum:connect', onConnect)
  }, [])

  if (isConnected && address) {
    return <ConnectedMenu address={address} />
  }

  // Phone browser with NO provider: the bare injected connector is a dead row
  // (nothing to inject) — the real rails are the wallet apps' own dapp browsers
  // (deep links below) plus Coinbase/WalletConnect, which carry their own
  // mobile transports. Inside a wallet's in-app browser a provider exists and
  // the normal list works. (Owner 2026-07-12: "injected does nothing" on mobile.)
  const mobileNoProvider = isMobileUA() && !hasInjectedProvider()

  // De-dupe by name — EIP-6963 discovery can surface the same wallet twice.
  const seen = new Set<string>()
  const deduped = connectors.filter((c) => {
    const k = c.name.toLowerCase()
    if (seen.has(k)) return false
    if (mobileNoProvider && c.type === 'injected' && k === 'injected') return false
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

  // CLOSE ON SUCCESS, NOT ON CLICK. This used to fire connect() and immediately
  // setOpen(false), so EVERY failure — a declined prompt, a wallet that never
  // answers, and (the case this was written for) a throttled WalletConnect relay
  // once the free tier's monthly cap is reached — closed the dialog and left the
  // user looking at the same Connect button with nothing said. A control that
  // silently does nothing teaches people the site is broken; the same rule the
  // share button already follows.
  //
  // The relay case matters because it looks perfectly normal right up until it
  // doesn't: the row is present, the click registers, and the failure is remote.
  // Keeping the dialog open with the reason in it means the user can fall back
  // to another wallet in the same breath — injected and Coinbase never touch
  // that relay, so the route degrades rather than the product.
  const pick = (c: Connector) => {
    resetConnect()
    setTrying(c.name)
    connect({ connector: c }, { onSuccess: () => setOpen(false) })
  }

  const closeDialog = () => {
    setOpen(false)
    setTrying(null)
    resetConnect()
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className={btn}>
        Connect
      </button>
      {/* PORTALED to body (audit): this button also mounts inside the sticky
          nav, whose backdrop-blur makes the header the CONTAINING BLOCK for
          fixed descendants in Chromium/Firefox — inline, `fixed inset-0`
          resolved to the 64px header strip (dialog top unreachable) and the
          header's stacking context pinned the overlay below the z-40 bands. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={closeDialog}
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
                onClick={closeDialog}
                aria-label="Close"
                className="press -m-2 grid h-10 w-10 place-items-center text-ink-faint hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {mobileNoProvider && (
                <>
                  <p className="text-[13px] leading-relaxed text-ink-dim">
                    On a phone, connect by opening this site inside your wallet's app:
                  </p>
                  {walletAppLinks(window.location.href).map((l) => (
                    <a
                      key={l.name}
                      href={l.href}
                      className="press flex items-center justify-between border border-white/10 px-4 py-3 text-left hover:border-cyan/50 hover:bg-white/[0.04]"
                    >
                      <span className="text-sm text-ink">{l.name}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">Open in app</span>
                    </a>
                  ))}
                </>
              )}
              {!mobileNoProvider && list.length === 0 && (
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
                    {isPending && trying === c.name
                      ? 'Waiting…'
                      : c.type === 'injected'
                        ? 'Injected'
                        : 'Connect'}
                  </span>
                </button>
              ))}
              {connectError && !isPending && (
                <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
                  {trying ? `${trying} didn\u2019t connect.` : 'That didn\u2019t connect.'}{' '}
                  {/rejected|denied|user closed/i.test(connectError.message)
                    ? 'The request was dismissed in the wallet \u2014 try again when you are ready.'
                    : 'Nothing was signed. Try again, or pick another wallet above.'}
                </p>
              )}
              {mobileNoProvider && (
                <p className="border-t border-white/10 pt-2.5 text-[11px] leading-relaxed text-ink-faint">
                  Rainbow, Uniswap, Rabby and other wallet apps: open this site in the wallet's
                  built-in browser{list.some((c) => c.type !== 'injected') ? ', or use a Connect option above' : ''}.
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
