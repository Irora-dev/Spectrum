// Bundle the chat agent for node (the MCP's own recipe: define map + prelude +
// nodePaths) so conversations can be DRIVEN programmatically against live Base.
import { build } from '../../node_modules/esbuild/lib/main.js'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KIT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')

writeFileSync(join(HERE, 'entry.ts'), `export { handle, DEFAULT_AGENT_CTX } from '${KIT}/app/src/components/chat/agent'\n`)

const VITE_KEYS = ['AERODROME_FACTORY_ADDRESS', 'AGENT_ENDPOINT', 'ALCHEMY_API_KEY', 'BASE_RPC_URL', 'DEFAULT_CHAIN_ID', 'DEV_FIXTURE', 'DIRECT_SWAP_WRAPPER_ADDRESS', 'ENABLE_DEPLOY', 'ENABLE_RANGE_ORDERS', 'ENABLE_SWAP', 'ENABLE_TRADING', 'ENABLE_WALLET', 'EXTRA_CHAIN_IDS', 'FACTORY_ADDRESS', 'HIDDEN_BASKETS', 'LEAGUE_POOL_ADDRESS', 'MAINNET_RPC_URL', 'MIGRATE_REBALANCE', 'NOTES_REGISTRY_ADDRESS', 'POOL_MANAGER_ADDRESS', 'ROBINHOOD_RPC_URL', 'SNAPSHOT_MAX_AGE_SEC', 'SNAPSHOT_URL', 'SWAP_ROUTER_ADDRESS', 'UNIV2_FACTORY_ADDRESS', 'UNIV3_FACTORY_ADDRESS', 'UNIV3_QUOTER_ADDRESS', 'UNIV3_SWAP_ROUTER_ADDRESS', 'UNIVERSAL_ROUTER_ADDRESS', 'USDC_ADDRESS', 'V4_QUOTER_ADDRESS', 'VERIFY_BASKET', 'VERIFY_BATCHER', 'WALLETCONNECT_PROJECT_ID', 'WETH_ADDRESS']
const define = { 'import.meta.glob': 'globalThis.__viteGlob', 'import.meta.env': 'globalThis.__viteEnv', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"production"' }
for (const k of VITE_KEYS) define[`import.meta.env.VITE_${k}`] = `process.env.VITE_${k}`

await build({
  entryPoints: [join(HERE, 'entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(HERE, 'agent-bundle.mjs'),
  define,
  loader: { '.yml': 'text' },
  inject: [join(KIT, 'mcp/prelude.mjs')],
  nodePaths: [join(KIT, 'app/node_modules')],
  logLevel: 'warning',
})
console.log('agent bundled')
