import { SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { stocksForChain } from '../chain/stocks'
import type { AllocAsset } from './allocation'

/** The flow's example catalog — born inside PortfolioFlow and EXPORTED for the
 *  add-asset popup (owner 15:00: "we should literally just take [it] from the
 *  create flow… don't reinvent the wheel"). Moved out whole (the split's S7):
 *  the picker was importing a 5.7k-line component graph for this one list of
 *  fixtures. Same list, same filter; PortfolioFlow re-exports it so its own
 *  callers are unchanged. */
export function demoCatalog(): AllocAsset[] {
  const stocks = stocksForChain(4663)
  const stock = (sym: string): AllocAsset[] => {
    const s = stocks.find((x) => x.symbol === sym)
    return s ? [{ chainId: 4663, address: s.address, symbol: s.symbol }] : []
  }
  return [
    { chainId: 1, address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', symbol: 'AAVE' },
    { chainId: 1, address: '0x643C4E15d7d62Ad0aBeC4a9BD4b001aA3Ef52d66', symbol: 'SYRUP' },
    ...stock('NVDA'),
    ...stock('AAPL'),
    { chainId: 4663, address: '0x39dBED3a2bd333467115dE45665cC57F813C4571', symbol: 'PONS' },
    { chainId: 8453, address: '0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb', symbol: 'BANKR' },
    { chainId: 8453, address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC' },
    { chainId: 1, address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI' },
    { chainId: 8453, address: '0x0b3e328455c4059EEb9e3f84B5543F74E24e7E1b', symbol: 'VIRTUAL' },
    // An operator build may carry a SUBSET of these networks — anything the
    // book doesn't know is filtered out rather than crashing chainCfg later.
  ].filter((a) => SUPPORTED_CHAIN_IDS.includes(a.chainId))
}
