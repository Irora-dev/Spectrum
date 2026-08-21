// In-chat thesis writing (owner 2026-08-20: "creating a thesis for a new
// basket or existing basket"). A thin chat frame around the REAL ThesisEditor
// (variant inline, opened straight into the textarea) — the exact component
// the token and creator pages write with: same encode, same setNote, same
// registry. The editor reads/prefills through useCreatorMeta itself.
import { useAccount } from 'wagmi'
import { ThesisEditor } from '../ThesisEditor'
import { useCreatorMeta } from '../../lib/spectrum/hooks'
import { showSymbol } from '../../lib/spectrum/safe-copy'

export function ThesisCard({ chainId, basket, symbol, deployer }: { chainId: number; basket: string; symbol: string; deployer: string | null }) {
  const { address } = useAccount()
  const { data: meta } = useCreatorMeta(basket, chainId)
  const isDeployer = !!address && !!deployer && address.toLowerCase() === deployer.toLowerCase()
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-2xl border border-white/[0.1] bg-white/[0.03] p-3 sm:min-w-[var(--chat-card-min,24rem)]">
      <p className="text-[12px] text-ink-faint">
        Thesis for <span className="font-display font-bold text-ink">${showSymbol(symbol)}</span>
        {isDeployer ? ' · yours to write, one signature publishes' : ' · publishes under the deployer key'}
      </p>
      <ThesisEditor basket={basket} chainId={chainId} deployer={deployer} meta={meta} variant="inline" startOpen />
    </div>
  )
}
