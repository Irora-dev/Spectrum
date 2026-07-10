import { http, createConfig } from 'wagmi'
import type { Chain, Transport } from 'viem'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'
import { CHAINS, SUPPORTED_CHAIN_IDS } from './lib/chain/chains'
import { rpcUrlFor } from './lib/chain/rpc'
import brand from './brand.config'

const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID
// Wallet UI is gated (VITE_ENABLE_WALLET). Until it's on, ship ONLY the lightweight
// `injected` connector — the Coinbase Wallet SDK + WalletConnect pull in hundreds of
// KB that's pure dead weight (the connect button isn't even rendered). The flag is a
// build-time constant, so the heavy connector SDKs tree-shake out of the gated build.
const walletEnabled = import.meta.env.VITE_ENABLE_WALLET === 'true'

// Chains come from the configured registry (shipped default: Base only).
const chains = SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id].viemChain) as [Chain, ...Chain[]]
const transports = Object.fromEntries(
  SUPPORTED_CHAIN_IDS.map((id) => [id, http(rpcUrlFor(id))]),
) as Record<number, Transport>

export const config = createConfig({
  chains,
  connectors: walletEnabled
    ? [
        // injected covers MetaMask, Rabby, Brave, etc.; Coinbase + WalletConnect add the rest.
        injected(),
        coinbaseWallet({ appName: brand.name }),
        ...(wcProjectId ? [walletConnect({ projectId: wcProjectId })] : []),
      ]
    : [injected()],
  transports,
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
