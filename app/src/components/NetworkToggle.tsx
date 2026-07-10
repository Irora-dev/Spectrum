import { useAccount, useSwitchChain } from 'wagmi'
import { useActiveChain } from '../lib/chain/active-chain'

const LABEL: Record<number, string> = { 1: 'ETH', 8453: 'BASE' }

// Global launch-network selector. Sets the app's active chain (drives the launch
// page's assets + deploy contracts) and, when a wallet is connected, switches it too.
export function NetworkToggle() {
  const { chainId, setChainId, supported } = useActiveChain()
  const { isConnected } = useAccount()
  const { switchChain } = useSwitchChain()

  // Auto-hide with exactly one configured chain (the shipped default is Base
  // only — a one-option toggle is noise).
  if (supported.length <= 1) return null

  const select = (id: number) => {
    setChainId(id)
    if (isConnected) {
      try {
        switchChain({ chainId: id })
      } catch {
        /* wallet rejected / chain unsupported — viewing chain still updates */
      }
    }
  }

  return (
    <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5">
      {supported.map((id) => {
        const active = id === chainId
        return (
          <button
            key={id}
            onClick={() => select(id)}
            className={`press rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] ${
              active ? 'bg-white/10 text-cyan' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {LABEL[id] ?? id}
          </button>
        )
      })}
    </div>
  )
}
