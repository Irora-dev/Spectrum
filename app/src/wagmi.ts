import { http, createConfig } from 'wagmi'
import type { Chain, Transport } from 'viem'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'
import { CHAINS, SUPPORTED_CHAIN_IDS } from './lib/chain/chains'
import { rpcUrlFor } from './lib/chain/rpc'
import { WALLET_ENABLED } from './lib/config/features'
import brand from './brand.config'

const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID

// WHO IS ASKING — the identity a wallet puts on its approval screen. Passing no
// metadata left the wallet to scrape the page or show a placeholder at the exact
// moment someone decides whether to trust what they are signing, which is the
// worst possible place for us to be anonymous.
//
// `url` is the LIVE ORIGIN rather than a configured site URL, deliberately:
// wallets compare it against where the request actually came from and warn on a
// mismatch, and this kit is self-hosted onto domains we will never know. The
// origin is the one value that is always true, including on a preview deploy.
// Name and tagline come from brand.config so an operator's build introduces
// itself as itself; the tagline fallback matches Layout's and App's exactly.
const wcMetadata =
  typeof window === 'undefined'
    ? undefined
    : {
        name: brand.name,
        description: brand.tagline?.trim() || 'onchain baskets',
        url: window.location.origin,
        icons: [`${window.location.origin}/icon-512.png`],
      }

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
// `batch: true` coalesces same-tick JSON-RPC calls into one batched POST
// (RPC audit 2026-08-06): the app's READ layer already multicalls through
// lib/chain/rpc's clientFor, but the wagmi-side client — simulates, receipt
// waits, useReadContracts' fallbacks — rode one-call-per-POST. Public nodes
// accept JSON-RPC arrays; writes go through the wallet connector, untouched.
const chains = SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id].viemChain) as [Chain, ...Chain[]]
const transports = Object.fromEntries(
  SUPPORTED_CHAIN_IDS.map((id) => [id, http(rpcUrlFor(id), { batch: true })]),
) as Record<number, Transport>

export const config = createConfig({
  chains,
  connectors: walletEnabled
    ? [
        // injected covers MetaMask, Rabby, Brave, etc.; Coinbase + WalletConnect add the rest.
        injected(),
        // `telemetry: false` — the SDK otherwise injects its Amplitude
        // bootstrap as an INLINE <script> at runtime, which was the CSP's one
        // open "Executing inline script" violation (source found 2026-08-07:
        // ClientAnalytics/base_account_sdk, gated in the SDK on
        // `preference.telemetry !== false`). Off = no injection at all, no
        // device-id fingerprinting, no beacon to an origin our connect-src
        // would refuse anyway. `options: 'all'` is the SDK default, restated
        // because the type requires it once a preference object is passed.
        coinbaseWallet({ appName: brand.name, preference: { options: 'all', telemetry: false } }),
        ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, metadata: wcMetadata })] : []),
      ]
    : [injected()],
  transports,
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
