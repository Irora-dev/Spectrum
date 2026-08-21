import { useAccount, useSwitchChain } from 'wagmi'
import { useActiveChain } from '../lib/chain/active-chain'
import chainBase from '../assets/chains/chain-8453.webp'
import chainEth from '../assets/chains/chain-1.webp'
import chainRh from '../assets/chains/chain-4663.webp'

const LABEL: Record<number, string> = { 1: 'ETH', 8453: 'BASE', 4663: 'RH' }
// the owner's glossy coin art replaces the text labels in the pill (2026-08-19)
const COIN: Record<number, string> = { 1: chainEth, 8453: chainBase, 4663: chainRh }

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
    <div className="net-pill flex h-9 items-center gap-0.5 rounded-full border border-white/12 bg-white/[0.03] px-0.5">
      {supported.map((id) => {
        const active = id === chainId
        return (
          <button
            key={id}
            onClick={() => select(id)}
            aria-label={`Switch to ${LABEL[id] ?? id}`}
            aria-pressed={active}
            title={LABEL[id] ?? String(id)}
            /* min-h on phones (mobile audit 2026-08-05: these measured 25px
               tall, well under a thumb); the desktop chrome is unchanged. */
            className={`press inline-flex h-8 min-h-0 items-center rounded-full px-1.5 transition-all sm:min-h-0 ${
              active ? 'net-chip-active bg-white/10 opacity-100' : 'opacity-40 hover:opacity-75'
            }`}
          >
            {COIN[id] ? (
              <img src={COIN[id]} alt="" aria-hidden draggable={false} width={22} height={22} className={`select-none transition-transform ${active ? 'scale-110' : ''}`} />
            ) : (
              <span className="font-mono text-[11px] uppercase tracking-[0.15em]">{id}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
