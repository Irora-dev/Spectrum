// ─────────────────────────────────────────────────────────────────────────────
// Robinhood Chain tokenized stocks (lab 2026-07-29) — the curated launcher
// shelf. Addresses from the OFFICIAL registry (docs.robinhood.com/chain/
// contracts — impostor tokens with the same names exist; use ONLY that page),
// captured + on-chain-verified 2026-07-04, pools re-probed live 2026-07-28.
//
// Surfacing ≠ routability: the picker offers these, and the builder's own
// findBestPool resolution stays the honest judge — a stock routes as a basket
// leg only where a real {ETH, stock} hookless v4 pool exists (the deployed
// factory validates exactly that key at construction), and the thin-pool
// warnings fire where depth is missing. Don't pin per-ticker pool claims
// HERE — they age in hours (AAPL was "USDG-quoted only" when first written;
// its ETH pool was initialized and basket-proven on launch night 2026-07-30).
// The deepest liquidity for some tickers remains on USDG-paired pools, which
// the CLEAN lineage cannot use as legs — that class waits on the separate
// stocks (V4Q) lineage.
//
// These are issuer-backed tracking tokens (a Robinhood entity's liability),
// globally pausable, with corporate actions via ERC-8056 uiMultiplier — and
// their pools trade 24/7 while the stock market does not (price can drift
// from the last close over weekends). The picker says so once.
// ─────────────────────────────────────────────────────────────────────────────

export interface StockListing {
  symbol: string
  name: string
  address: string
}

const ROBINHOOD_STOCKS: StockListing[] = [
  { symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
  { symbol: 'AAPL', name: 'Apple', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
  { symbol: 'TSLA', name: 'Tesla', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' },
  { symbol: 'MSFT', name: 'Microsoft', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74' },
  { symbol: 'GOOGL', name: 'Alphabet', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C' },
  { symbol: 'QQQ', name: 'Invesco QQQ ETF', address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68' },
  { symbol: 'SLV', name: 'iShares Silver ETF', address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f' },
]

/** The stock shelf for a chain ([] everywhere but Robinhood Chain). */
export function stocksForChain(chainId: number): StockListing[] {
  return chainId === 4663 ? ROBINHOOD_STOCKS : []
}

/** Is this address a known tokenized stock on the chain? (chip badges) */
export function isKnownStock(chainId: number, address: string): boolean {
  const a = address.toLowerCase()
  return stocksForChain(chainId).some((s) => s.address.toLowerCase() === a)
}
