import { http, createConfig } from 'wagmi'
import type { Chain, Transport } from 'viem'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'
import { CHAINS, SUPPORTED_CHAIN_IDS } from './lib/chain/chains'
import { rpcUrlFor } from './lib/chain/rpc'
import { WALLET_ENABLED } from './lib/config/features'
import brand from './brand.config'

const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID
// Wallet UI is gated by the RESOLVED flag (env-when-set > the committed
// site.config.json — the same features.ts source the Nav's button uses). This
// used to read the raw env var, which went undefined once flags moved into the
// json: every json-flagged build silently shipped ONLY the injected connector,
// so a browser without a wallet extension had no usable connect option at all
// (owner hit it live, 2026-07-12). Until the flag is on, ship ONLY the
// lightweight `injected` connector — the Coinbase Wallet SDK + WalletConnect
// pull in hundreds of KB that's pure dead weight when the button never renders.
const walletEnabled = WALLET_ENABLED

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
