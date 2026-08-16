import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { BASKET_ENTRY, factoryInitCodeAbi, FEE_CONFIG, POOL_KEY, type FeeConfigInput } from './abis-v2'
import { predictLocal } from './create2-mine'
import type { DeployBasketEntry } from './deploy'

// ─────────────────────────────────────────────────────────────────────────────
// REBUILDING THE BASKET'S INIT CODE IN THE BROWSER
//
// SpectrumFactory._buildInitCode is the contract this file mirrors, exactly:
//
//   initCode = code(TOKEN_CODE_PROVIDER_0)          // first half of the token's
//            ++ code(TOKEN_CODE_PROVIDER_1)         // creation code (EIP-170 split)
//            ++ abi.encode(POOL_MANAGER, deployer, normalizedBasket,
//                          canonEthUsdcKey, feeConfig)
//
// ⛔ DECIMALS ARE ZEROED before encoding. The factory normalises every entry's
// `decimals` to 0 and the token re-reads the real value on-chain in its ctor, so
// a creator cannot lie about them. Its source says it in capitals — "SALT MINERS
// MUST ZERO DECIMALS TOO" — and a miner that forgets mines a salt for an address
// that will never be deployed.
//
// ⛔ NOTHING HERE IS TRUSTED ON ITS OWN. `deriveInitCodeHash` returns a hash only
// after that hash reproduces a REAL `predictTokenAddress` answer for a real salt.
// A mismatch (a factory of another lineage, a changed struct, a re-deployed code
// provider) returns null and the miner falls back to probing the chain — it never
// mines against a hash it could not prove.
// ─────────────────────────────────────────────────────────────────────────────

const INIT_CODE_ARGS = parseAbiParameters(
  `address poolManager, address deployer, ${BASKET_ENTRY}[] basket, ${POOL_KEY} canonEthUsdcKey, ${FEE_CONFIG} feeConfig`,
)

/** The factory constants the init code is built from. Immutable per factory
 *  (canonEthUsdcKey is ctor-set with no setter), which is why they can be cached. */
export interface FactoryInitCodeParts {
  poolManager: Address
  canonEthUsdcKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  /** Runtime code of the two providers = the token's creation code, in order. */
  code0: Hex
  code1: Hex
}

/** keccak256 of the exact init code the factory will CREATE2 from. Pure. */
export function basketInitCodeHash(args: {
  parts: FactoryInitCodeParts
  basket: DeployBasketEntry[]
  deployer: Address
  feeConfig: FeeConfigInput
}): Hex {
  const { parts, basket, deployer, feeConfig } = args
  // decimals → 0, exactly as _buildInitCode does before it hashes.
  const normalized = basket.map((e) => ({ ...e, decimals: 0 }))
  const encoded = encodeAbiParameters(INIT_CODE_ARGS, [
    parts.poolManager,
    deployer,
    normalized,
    parts.canonEthUsdcKey,
    feeConfig,
  ])
  return keccak256(concatHex([parts.code0, parts.code1, encoded]))
}

// One entry per (chain, factory). The token's creation code is ~29 KB and cannot
// change for a deployed factory (the provider addresses are immutables and their
// runtime code is immutable), so it is fetched once per session, not per launch.
const partsCache = new Map<string, Promise<FactoryInitCodeParts>>()

/** Read (and cache) the factory constants. Rejects if the factory is of another
 *  lineage and has no such getters — the caller treats that as "no local path". */
export function factoryInitCodeParts(
  client: PublicClient,
  factory: Address,
  chainId: number,
): Promise<FactoryInitCodeParts> {
  const key = `${chainId}:${factory.toLowerCase()}`
  const cached = partsCache.get(key)
  if (cached) return cached
  const loading = (async (): Promise<FactoryInitCodeParts> => {
    const read = <T>(functionName: 'POOL_MANAGER' | 'TOKEN_CODE_PROVIDER_0' | 'TOKEN_CODE_PROVIDER_1' | 'canonEthUsdcKey') =>
      client.readContract({ address: factory, abi: factoryInitCodeAbi, functionName }) as Promise<T>
    const [poolManager, provider0, provider1, canon] = await Promise.all([
      read<Address>('POOL_MANAGER'),
      read<Address>('TOKEN_CODE_PROVIDER_0'),
      read<Address>('TOKEN_CODE_PROVIDER_1'),
      read<readonly [Address, Address, number, number, Address]>('canonEthUsdcKey'),
    ])
    const [code0, code1] = await Promise.all([
      client.getCode({ address: provider0 }),
      client.getCode({ address: provider1 }),
    ])
    if (!code0 || !code1 || code0 === '0x' || code1 === '0x') {
      throw new Error('Token code providers hold no code on this chain.')
    }
    return {
      poolManager,
      canonEthUsdcKey: {
        currency0: canon[0],
        currency1: canon[1],
        fee: canon[2],
        tickSpacing: canon[3],
        hooks: canon[4],
      },
      code0,
      code1,
    }
  })()
  // A failed read must not poison the cache — the next launch tries again.
  loading.catch(() => partsCache.delete(key))
  partsCache.set(key, loading)
  return loading
}

/**
 * The init-code hash for this exact launch, PROVEN against the factory.
 *
 * `proof` is a (salt, address) pair already answered by `predictTokenAddress`
 * for the same basket/deployer/feeConfig — the probe the miner makes anyway. If
 * the locally rebuilt hash reproduces that address, the rebuild is correct for
 * every other salt too (CREATE2 is a pure function of the four inputs, and a
 * 160-bit agreement is not reachable by accident). Anything else returns null.
 */
export async function deriveInitCodeHash(args: {
  client: PublicClient
  factory: Address
  chainId: number
  basket: DeployBasketEntry[]
  deployer: Address
  feeConfig: FeeConfigInput
  proof: { salt: Hex; address: Address }
}): Promise<Hex | null> {
  const { client, factory, chainId, basket, deployer, feeConfig, proof } = args
  try {
    const parts = await factoryInitCodeParts(client, factory, chainId)
    const initCodeHash = basketInitCodeHash({ parts, basket, deployer, feeConfig })
    const rebuilt = predictLocal(factory, initCodeHash, proof.salt)
    return rebuilt.toLowerCase() === proof.address.toLowerCase() ? initCodeHash : null
  } catch {
    return null
  }
}

/** Test seam: forget the cached factory code (never called in the app). */
export function resetFactoryInitCodeCache(): void {
  partsCache.clear()
}
