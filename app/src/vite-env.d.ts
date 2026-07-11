/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ALCHEMY_API_KEY?: string
  readonly VITE_BASE_RPC_URL?: string
  readonly VITE_MAINNET_RPC_URL?: string
  // Robinhood Chain has no Alchemy tier — this explicit URL or its public endpoint.
  readonly VITE_ROBINHOOD_RPC_URL?: string
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
  // feature flags (default off)
  readonly VITE_ENABLE_WALLET?: string
  readonly VITE_ENABLE_DEPLOY?: string
  readonly VITE_ENABLE_TRADING?: string
  readonly VITE_ENABLE_SWAP?: string
  readonly VITE_MIGRATE_REBALANCE?: string
  // deployment address overrides (default chain)
  readonly VITE_FACTORY_ADDRESS?: string
  readonly VITE_USDC_ADDRESS?: string
  readonly VITE_POOL_MANAGER_ADDRESS?: string
  readonly VITE_WETH_ADDRESS?: string
  readonly VITE_UNIV2_FACTORY_ADDRESS?: string
  readonly VITE_UNIV3_FACTORY_ADDRESS?: string
  readonly VITE_UNIV3_SWAP_ROUTER_ADDRESS?: string
  readonly VITE_UNIV3_QUOTER_ADDRESS?: string
  readonly VITE_AERODROME_FACTORY_ADDRESS?: string
  readonly VITE_V4_QUOTER_ADDRESS?: string
  readonly VITE_SWAP_ROUTER_ADDRESS?: string
  readonly VITE_UNIVERSAL_ROUTER_ADDRESS?: string
  // operator list-curation (comma-separated basket addresses hidden from
  // this build's discovery listings; on-chain enumeration is untouched)
  readonly VITE_HIDDEN_BASKETS?: string
  // operator identity
  readonly VITE_SITE_URL?: string
  readonly VITE_PARTNER_APP_URL?: string
  readonly VITE_INTERFACE_TAG_ADDRESS?: string
  readonly VITE_LAUNCHER_ADDRESS?: string
  // creator metadata (optional; host serves deployer-signed content only)
  readonly VITE_METADATA_BASE_URL?: string
  readonly VITE_METADATA_WRITE_URL?: string
  readonly VITE_IPFS_GATEWAY_URL?: string
  // multichain: comma-separated extra chain ids to expose (e.g. "1" for Ethereum)
  readonly VITE_EXTRA_CHAIN_IDS?: string
  // optional pre-baked discovery snapshot (zero-RPC first paint)
  readonly VITE_SNAPSHOT_URL?: string
  readonly VITE_SNAPSHOT_MAX_AGE_SEC?: string
  // dev-only: design-review fixture (never shipped in a build)
  readonly VITE_DEV_FIXTURE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
