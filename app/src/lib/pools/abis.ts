import { parseAbi, parseAbiItem } from 'viem'

export const v2FactoryAbi = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])

export const v2PairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

export const v3FactoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
])

export const erc20MetaAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

// V4 PoolManager storage reader (StateLibrary slots).
export const poolManagerExtsloadAbi = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
])

// Aerodrome PoolFactory (Velodrome-style): pools are (tokenA, tokenB, stable).
export const aerodromeFactoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
])

// Emitted by the V4 PoolManager on pool creation — the only on-chain way to
// discover V4 pools. id/currency0/currency1 are indexed (filterable).
export const v4InitializeEvent = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)
