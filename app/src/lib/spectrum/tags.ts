import banlistRaw from '../../config/tag-banlist.yml?raw'

// ─────────────────────────────────────────────────────────────────────────────
// The tag system (R+C 2026-07-06 18:26): a big curated vocabulary drives
// autocomplete at launch and inspiration on Explore; creators can still type
// ANY custom tag (their signed metadata is theirs) — the SITE simply refuses
// to render or suggest tags on the ban list (src/config/tag-banlist.yml,
// egregious-only by design). Tags stay creator-invented + neutral: the
// vocabulary is a dictionary, not a taxonomy the protocol enforces.
// ─────────────────────────────────────────────────────────────────────────────

// ── the ban list (YML: one `- entry` per line) ───────────────────────────────
const BANNED: string[] = banlistRaw
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('- '))
  .map((l) => l.slice(2).trim().toLowerCase())
  .filter(Boolean)

const BANNED_WORDS = new Set(BANNED.filter((b) => !/[\s-]/.test(b)))
const BANNED_PHRASES = BANNED.map((b) => b.replace(/[\s-]+/g, '')).filter((b) => b.length >= 4)

/** True when the site will render/suggest this tag. Whole-word + compact-phrase
 *  matching (Scunthorpe-safe: "spice" never trips "spic"). */
export function tagAllowed(tag: string): boolean {
  const lower = tag.toLowerCase()
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((w) => BANNED_WORDS.has(w))) return false
  const compact = lower.replace(/[^a-z0-9]+/g, '')
  return !BANNED_PHRASES.some((p) => compact.includes(p))
}

/** Render-side filter for creator-provided tag arrays. */
export function filterTags(tags: string[]): string[] {
  return tags.filter(tagAllowed)
}

// ── the vocabulary (categorized; autocomplete + suggestions) ─────────────────
export interface TagEntry {
  label: string
  cat: 'sector' | 'theme' | 'strategy' | 'chain' | 'asset-class' | 'culture'
}

const T = (cat: TagEntry['cat'], ...labels: string[]): TagEntry[] => labels.map((label) => ({ label, cat }))

export const TAG_VOCAB: TagEntry[] = [
  ...T(
    'sector',
    'DeFi', 'DEX', 'Lending', 'Perps', 'Derivatives', 'Yield', 'Staking', 'Restaking', 'LST', 'LRT',
    'Stablecoins', 'RWA', 'Payments', 'Insurance', 'Prediction Markets', 'Options', 'Aggregators',
    'Bridges', 'Oracles', 'Data', 'Storage', 'Compute', 'DePIN', 'Privacy', 'Security', 'Identity',
    'Gaming', 'Metaverse', 'NFT', 'SocialFi', 'InfoFi', 'DAO', 'Governance', 'Launchpads',
    'Infrastructure', 'Wallets', 'Indexing', 'Analytics', 'MEV', 'Liquid Staking', 'Money Markets',
  ),
  ...T(
    'theme',
    'AI', 'AI Agents', 'Agents', 'Inference', 'LLM', 'GPU', 'Robotics', 'Machine Learning',
    'Big Data', 'IoT', 'Energy', 'Climate', 'Science', 'DeSci', 'Biotech', 'Space',
    'Gaming Guilds', 'Esports', 'Music', 'Art', 'Photography', 'Fashion', 'Sports',
    'Creator Economy', 'Social Graph', 'Messaging', 'Streaming', 'Virtual Worlds',
    'Interoperability', 'Modular', 'Rollups', 'Zero Knowledge', 'ZK', 'Account Abstraction',
    'Intents', 'Onchain Games', 'Autonomous Worlds', 'Prediction', 'Real Yield', 'Points',
    'Airdrops', 'Narratives', 'Rotation', 'New Listings', 'Micro Caps', 'Emerging',
  ),
  ...T(
    'strategy',
    'Blue Chip', 'Majors', 'Index', 'Equal Weight', 'Market Cap Weighted', 'Barbell',
    'Long Term', 'Conviction', 'High Risk', 'Low Volatility', 'Conservative', 'Aggressive',
    'Momentum', 'Value', 'Growth', 'Income', 'Diversified', 'Concentrated', 'Sector Rotation',
    'Rebalancing', 'Buy and Hold', 'Core Holdings', 'Satellite', 'Thematic', 'Contrarian',
    'Small Caps', 'Large Caps', 'Mixed', 'Balanced', 'Yield Farming', 'Carry',
  ),
  ...T(
    'chain',
    'Ethereum', 'Base', 'L2', 'Layer 2', 'Optimism', 'Arbitrum', 'Polygon', 'Multichain',
    'EVM', 'Mainnet', 'Superchain', 'OP Stack',
  ),
  ...T(
    'asset-class',
    'Bitcoin', 'BTC', 'ETH', 'Wrapped Assets', 'Governance Tokens', 'Utility Tokens',
    'Meme Coins', 'Stables', 'Volatile', 'Commodities', 'Synthetics', 'Tokenized Stocks',
    'Treasuries', 'Gold', 'Basket of Baskets',
  ),
  ...T(
    'culture',
    'Memes', 'Degen', 'Cats', 'Dogs', 'Frogs', 'Pepe', 'Wojak', 'Anime', 'Retro',
    'Community', 'Cult Classics', 'OG', 'Based', 'WAGMI', 'Vibes', 'Fun', 'Casino',
    'Moonshots', 'Gems', 'Bluechip Memes', 'Internet Culture',
  ),
].filter((t) => tagAllowed(t.label))

const VOCAB_LOWER = TAG_VOCAB.map((t) => ({ ...t, lower: t.label.toLowerCase(), compact: t.label.toLowerCase().replace(/[^a-z0-9]+/g, '') }))

/** Closest-match autocomplete over the vocabulary: prefix beats contains,
 *  compact matching tolerates spaces ("aiagents" hits "AI Agents"). */
export function suggestTags(query: string, limit = 8, exclude: string[] = []): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const qc = q.replace(/[^a-z0-9]+/g, '')
  const ex = new Set(exclude.map((e) => e.toLowerCase()))
  const starts: string[] = []
  const contains: string[] = []
  for (const t of VOCAB_LOWER) {
    if (ex.has(t.lower)) continue
    if (t.lower.startsWith(q) || t.compact.startsWith(qc)) starts.push(t.label)
    else if (t.lower.includes(q) || t.compact.includes(qc)) contains.push(t.label)
  }
  return [...starts, ...contains].slice(0, limit)
}

// Known-asset hints → suggested tags (a light map over the majors; unknown
// symbols simply suggest nothing).
const ASSET_TAGS: Record<string, string[]> = {
  WETH: ['Ethereum', 'Blue Chip', 'Majors'],
  ETH: ['Ethereum', 'Blue Chip', 'Majors'],
  CBETH: ['Liquid Staking', 'LST', 'Ethereum'],
  WSTETH: ['Liquid Staking', 'LST', 'Ethereum'],
  CBBTC: ['Bitcoin', 'Blue Chip', 'Majors'],
  WBTC: ['Bitcoin', 'Blue Chip', 'Majors'],
  USDC: ['Stablecoins', 'Low Volatility'],
  DAI: ['Stablecoins', 'Low Volatility'],
  AERO: ['DEX', 'DeFi', 'Base'],
  DEGEN: ['Memes', 'Base', 'Degen'],
  BRETT: ['Memes', 'Base'],
  UNI: ['DEX', 'DeFi', 'Governance Tokens'],
  LINK: ['Oracles', 'Infrastructure'],
  PEPE: ['Memes', 'Frogs', 'Pepe'],
}

/** Tag suggestions from the basket's selected assets ("recommend you tags" —
 *  R+C): ranked by how many assets vote for each, capped. */
export function suggestTagsForAssets(symbols: string[], limit = 6): string[] {
  const votes = new Map<string, number>()
  for (const s of symbols) {
    for (const tag of ASSET_TAGS[s.toUpperCase()] ?? []) {
      votes.set(tag, (votes.get(tag) ?? 0) + 1)
    }
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
    .filter(tagAllowed)
    .slice(0, limit)
}
