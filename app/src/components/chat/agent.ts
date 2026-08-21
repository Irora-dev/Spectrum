// The chat agent, v1: a DETERMINISTIC conversational engine over the app's own
// money plumbing. It parses intent + slots from plain language, reads the chain
// through the same modules every page uses, and answers with typed actions the
// chat page renders (text, tables, live trade cards, deep links). It never
// invents a floor, never signs, and never guesses an address: everything
// executable is the app's existing pipeline, embedded in the conversation.
//
// The shape is deliberately brain-agnostic: `handle(text, ctx)` is the whole
// contract, so a hosted LLM (an operator's own endpoint) can replace the
// parser later without touching the chat surface. A bundled API key is not an
// option in a static kit: it would ship to every visitor.
import { type Address } from 'viem'
import { CHAINS, SUPPORTED_CHAIN_IDS, DEFAULT_CHAIN_ID, chainCfg } from '../../lib/chain/chains'
import { getBasketData, listBasketsForChain, type BasketData } from '../../lib/spectrum/basket-data'
import { nativeEthUsdOnChain } from '../../lib/pools/v4-usd'
import { friendlyRevert } from '../../lib/spectrum/decode-revert'
import { loadExecLog } from '../../lib/spectrum/exec-log'
import { isAddress, parseAbi } from 'viem'
import { buildCreatorLeaderboard } from '../../lib/spectrum/leaderboard'
import { fetchOnchainBasketMeta } from '../../lib/spectrum/profile-registry'

import { erc20BalanceAbi } from '../../lib/spectrum/abis-v2'
import { clientFor } from '../../lib/chain/rpc'
import { resolveAsset } from '../launch/BasketBuilder'
import { searchTokens, type TokenHit } from '../../lib/spectrum/token-search'
import { basketHref } from '../../lib/spectrum/short-url'
import { refLinkFor } from '../../lib/spectrum/referral'

export type AgentAction =
  | { kind: 'text'; text: string }
  | { kind: 'baskets'; chainId: number; rows: { address: Address; symbol: string; name: string }[] }
  | { kind: 'basket'; chainId: number; data: BasketData; weights: number[] | null }
  | { kind: 'positions'; chainId: number; rows: { address: Address; symbol: string; name: string; shares: string }[] }
  | { kind: 'trade'; chainId: number; side: 'buy' | 'sell'; basket: BasketData; amountUsd: number | null; note?: string; sharesAmount?: string; slippageBps?: number }
  | { kind: 'create'; chainId: number; legs: { address: Address; symbol: string }[]; weights?: number[] }
  | { kind: 'link'; href: string; label: string; text: string }
  | { kind: 'candidates'; chainId: number; ticker: string; hits: TokenHit[]; text: string }
  | {
      kind: 'movers'
      chainId: number
      windowLabel: '24h' | '7d' | '30d'
      assets: { address: Address; symbol: string; changePct: number; fromBasket: string }[]
      baskets: { address: Address; symbol: string; name: string; changePct: number }[]
      partial: boolean
    }
  | { kind: 'hero'; art: 'violet' | 'teal' | 'amber' | 'rainbow'; title: string; lines: string[]; foot?: string; cta?: { label: string; send: string } }
  | { kind: 'steps'; title: string; steps: { text: string; send?: string }[]; foot?: string }
  | { kind: 'compare'; title: string; left: { head: string; rows: string[] }; right: { head: string; rows: string[] }; foot?: string }
  | { kind: 'share'; url: string; symbol: string; text: string }
  | { kind: 'referral'; url: string; text: string }
  | { kind: 'bundle'; legs: { chainId: number; address: Address; symbol: string }[] }
  | { kind: 'claim'; chainId: number; rows: { address: Address; symbol: string; pendingUsd: number }[]; totalUsd: number; refLink: string | null }
  | { kind: 'multiBuy'; chainId: number; baskets: BasketData[]; amountUsd: number; slippageBps?: number }
  | { kind: 'version'; chainId: number; predecessor: BasketData }
  | { kind: 'redeem'; chainId: number; data: BasketData }
  | { kind: 'migrate'; chainId: number; from: { address: Address; symbol: string }; to: { address: Address; symbol: string } }
  | { kind: 'thesis'; chainId: number; basket: Address; symbol: string; deployer: string | null }
  | { kind: 'profile' }
  | { kind: 'perf'; chainId: number; data: BasketData; weights: number[]; range: '24H' | '7D' | '30D'; changePct: number | null }
  | { kind: 'assetPicker'; text: string; picked: { chainId: number; address: Address; symbol: string }[] }
  /** THE CROSS-CHAIN DRAFT, one visual (owner 2026-08-20 19:3x-4x design spec):
   *  all assets across chains read as ONE idea up top, split into per-chain
   *  basket sections beneath (each with its own deploy door), the bundle wrap
   *  as the finale — replaces the old spans-chains text + steps entirely. */
  | { kind: 'crossDraft'; buckets: { chainId: number; picks: { address: Address; symbol: string }[]; weights?: number[] }[]; deployed: { chainId: number; address: Address; symbol: string }[]; mode?: 'building' | 'finalized' }

export interface AgentContext {
  chainId: number
  account: Address | null
  /** conversational memory: the basket the exchange is currently about */
  lastBasket?: { address: Address; chainId: number } | null
  /** the last RAIL shown, for ordinal references ("the first one");
   *  pickedIndex remembers which item the last resolution used, so
   *  "no, the other one" can repair the pick */
  lastList?: { items: { label: string; send: string }[]; pickedIndex?: number } | null
  /** the basket DRAFT built up across turns ("add VVV to my basket"): the
   *  running leg list survives until "start over" or the composer opens */
  draft?: { picks: { address: Address; symbol: string }[] } | null
  /** per-chain draft buckets ("vvv, aero… then cashcat on robinhood"): one
   *  basket per chain, and 2+ live buckets prompt THE BUNDLE flow */
  drafts?: Record<number, { address: Address; symbol: string }[]> | null
  /** baskets deployed IN THIS CHAT (the page appends on DeployCard success);
   *  they prefill the in-chat bundle card */
  deployedBaskets?: { chainId: number; address: Address; symbol: string }[]
  /** the reply's primary suggestion; a spoken yes ("sure", "do it") replays it */
  lastOffer?: string | null
  /** the last trade card shown; "make it $100" re-emits it at the new amount */
  lastTrade?: { side: 'buy' | 'sell'; address: Address; chainId: number } | null
  /** the last list-shaped answer; "and on robinhood?" re-runs it there */
  lastIntent?: { kind: 'baskets' | 'movers'; window?: '24h' | '7d' | '30d' } | null
  /** a question the agent asked and is waiting on ('basket' | 'create-assets') */
  pending?:
    | { intent: 'buy' | 'sell' | 'read'; amountUsd?: number | null; basket?: { address: Address; symbol: string } }
    | {
        intent: 'create'
        /** legs already settled (addresses picked or unambiguous) */
        picks?: { address: Address; symbol: string }[]
        /** tickers still waiting on a candidate pick, in order */
        queue?: string[]
      }
    | null
}

export interface AgentReply {
  actions: AgentAction[]
  ctx: AgentContext
  /** true when something worth celebrating happened (drives the mascot) */
  celebrate?: boolean
  /** suggestion chips tailored to THIS answer (the next step the reader
   *  probably wants); absent = the page derives from the actions */
  chips?: string[]
}


// ── THE READ-THROUGH CACHE (owner 2026-08-20: "rpc usage extremely efficient,
// doesn't cost much per user"). The two heavy reads the whole brain leans on:
// listBasketsForChain is an UNCACHED full factory sweep and getBasketData
// re-reads all live state per call — and a single turn can hit each twice
// (entity layer + the read action). Promise-cached with a TTL: concurrent
// identical calls share ONE in-flight request, repeats inside the window are
// free. MONEY SAFETY: everything the agent hands a card is display + seeding;
// the card itself quotes, floors, and simulates LIVE at interaction time — a
// 30s-stale summary can never reach a signature. Errors never cache.
const READS = new Map<string, { at: number; p: Promise<unknown> }>()
function through<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = READS.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>
  const p = fn().catch((e) => {
    READS.delete(key)
    throw e
  })
  READS.set(key, { at: Date.now(), p })
  while (READS.size > 64) READS.delete(READS.keys().next().value as string)
  return p
}
export const cachedList = (chainId: number): ReturnType<typeof listBasketsForChain> =>
  through(`list:${chainId}`, 60_000, () => listBasketsForChain(chainId))
export const cachedBasket = (address: Address | string, chainId: number): ReturnType<typeof getBasketData> =>
  through(`bd:${chainId}:${String(address).toLowerCase()}`, 30_000, () => getBasketData(address as Address, chainId))

// ── THE WATCH STORE (owner 2026-08-20: watches survive sessions — persisted
// with their NAV baseline; every new session resumes polling and CATCHES UP
// on what moved while no tab was open. No server by design, so nothing fires
// with the site closed: moves are reported on return.) ──────────────────────
export interface Watch {
  chainId: number
  address: Address
  symbol: string
  /** trip threshold, percent (absolute move vs baseline). */
  thresholdPct: number
  /** NAV at set-time (or last notify) — the comparison baseline. */
  baselineNav: number
  setAt: number
  lastNotifiedAt: number | null
}
const WATCH_KEY = 'specter-watch-v1'
export function loadWatches(): Watch[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY)
    const v = raw ? (JSON.parse(raw) as Watch[]) : []
    return Array.isArray(v) ? v.slice(0, 6) : []
  } catch {
    return []
  }
}
export function saveWatches(w: Watch[]): void {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(w.slice(0, 6)))
  } catch {
    /* private mode: the watch just does not persist */
  }
}

// ── THE MISSED-QUESTIONS RING (operator telemetry, local-only): messages the
// endless catch-all had to shrug at, minable into new bank rows. Bounded. ────
const MISSED_KEY = 'specter-missed-v1'
function logMissed(text: string): void {
  try {
    const raw = localStorage.getItem(MISSED_KEY)
    const arr = raw ? (JSON.parse(raw) as { t: string; at: number }[]) : []
    arr.push({ t: text.slice(0, 200), at: Date.now() })
    localStorage.setItem(MISSED_KEY, JSON.stringify(arr.slice(-200)))
  } catch {
    /* telemetry never breaks a turn */
  }
}

const erc20MetaAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
const feeReadAbi = parseAbi([
  'function basketFeeBps() view returns (uint16)',
  'function creatorShareBps() view returns (uint16)',
  'function pendingFrontendFees(address fe) view returns (uint256)',
])

const chainName = (id: number) => CHAINS[id]?.name ?? `chain ${id}`

/** Chain- and indexer-sourced text is attacker-typed. At the agent's OWN
 *  assembly sites (never inside the money libs) it clamps before entering an
 *  action payload: control chars, bidi overrides and the zero-width family
 *  stripped, whitespace collapsed, 64 chars max. Candidate rails keep their
 *  own 80-char clamp in settleTicker. */
export const clampChainText = (s: string | null | undefined): string =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)

function wantChainId(text: string, current: number): number {
  const t = text.toLowerCase()
  if (/\b(base)\b/.test(t) && SUPPORTED_CHAIN_IDS.includes(8453)) return 8453
  if (/\b(ethereum|etherium|ethereom|mainnet|eth chain|on eth)\b/.test(t) && SUPPORTED_CHAIN_IDS.includes(1)) return 1
  if (/\b(robinhood|robinhod|robin hood|rh chain|rh)\b/.test(t) && SUPPORTED_CHAIN_IDS.includes(4663)) return 4663
  return current
}

// chain words are ROUTING, never tickers ("cashcat on robinhood" must not
// look up a $ROBINHOOD token — live find 2026-08-19 22:59)
const CHAIN_WORDS = new Set(['base', 'eth', 'ethereum', 'etherium', 'mainnet', 'robinhood', 'robinhod', 'rh', 'chain', 'on'])
const stripChainWords = (arr: string[]): string[] => arr.filter((w) => !CHAIN_WORDS.has(w.toLowerCase().replace(/^\$/, '')))

const ADDR = /0x[0-9a-fA-F]{40}/
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,11})/
// "$25", "$1,000", "25 usdc", "25 dollars", "for 25". The integer part may
// carry thousands commas — without them the capture stopped at the first comma
// and "$1,000" composed a $1 card (audit 2026-08-21). Commas are stripped at
// consumption via amtNum; the regex only has to stop truncating.
const AMOUNT = /(?:\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:usdc|usd|dollars?|bucks?))/i
/** An AMOUNT capture → number, thousands commas removed. NaN on absent/garbage,
 *  which every caller already treats as "no amount". */
const amtNum = (s: string | null | undefined): number => (s == null ? NaN : Number(s.replace(/,/g, '')))

// ── THE LANGUAGE LAYER (owner 2026-08-19: no LLM — the regex brain goes as
// far as regex can). Normalize first, then intent tests run over synonym
// lexicons with typo-tolerant keyword matching. ──────────────────────────────

/** Lowercase, expand contractions, strip sentence punctuation ($ 0x - _ live). */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/what's/g, 'what is')
    .replace(/how's/g, 'how is')
    .replace(/where's/g, 'where is')
    .replace(/that's/g, 'that is')
    .replace(/i'm/g, 'i am')
    .replace(/i'd/g, 'i would')
    .replace(/don't/g, 'do not')
    .replace(/can't/g, 'cannot')
    .replace(/won't/g, 'will not')
    .replace(/let's/g, 'lets')
    .replace(/[!?.,;:()"'¿¡]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The message with its leading conversational filler stripped ("ok so can
 *  you please add pons" → "add pons"): polite frames and softeners hide the
 *  verb from anchored intent tests. OPERATIONAL detectors (the add lane, the
 *  availability question) read this core; the QA bank and the money verbs
 *  keep reading the full text, so question-shaped trades stay questions and
 *  every existing bank phrasing keeps matching. (Owner 2026-08-20: "we need
 *  to get good at filler words".) */
function coreOf(t: string): string {
  let s = t
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s
      .replace(/^(hey|hi|hello|yo|ok|okay|so|well|um|uh|now|also|and|then|just|please|pls|plz|alright|right|actually|hmm|btw)\s+/, '')
      .replace(/^(can|could|will|would) (you|u|we)( please| pls)?\s+/, '')
      .replace(/^(i (want|need|would like|would love) to|i wanna|id like to|lets|let us|help me|go ahead and)\s+/, '')
    if (s === before) break
  }
  return s
}

// ── THE MULTILINGUAL OPERATIONAL LAYER (owner 2026-08-20: "make the regex
// multi language for mandarin, german, dutch, french, spanish"). Not a
// translated product: a TIGHT lexicon maps unambiguous operational words and
// question frames to their English tokens BEFORE the intent tests run, so
// "compra $25 de SVI" walks the exact buy path a typed English message walks
// and every floor/simulation law applies unchanged. Answers stay in the
// product's English voice; the fallback greets lost users in THEIR language.
const LEX_PHRASES: [RegExp, string][] = [
  // question frames first (longest match wins)
  [/\bque es\b|\bqu ?est[- ]?ce ?(que|qu)?\b|\bwas ist\b|\bwat is\b/g, 'what is'],
  [/\bque tengo\b|\bmis cestas\b|\bmis canastas\b|\bwas besitze ich\b|\bwas halte ich\b|\bmeine korbe\b|\bwat heb ik\b|\bmijn mandjes\b|\bmes paniers\b|\bque possede je\b|\b我持有什么\b|\b我有什么\b/g, 'what do i hold'],
  [/\bcuanto cuesta\b|\bwie viel kostet\b|\bhoeveel kost\b|\bcombien coute\b/g, 'how much does it cost'],
  [/\bcomo funciona\b|\bwie funktioniert\b|\bhoe werkt\b|\bcomment ca marche\b|\bcomment fonctionne\b/g, 'how does it work'],
]
const LEX_WORDS: Record<string, string> = {
  // buy
  compra: 'buy', comprar: 'buy', comprame: 'buy', kaufe: 'buy', kauf: 'buy', kaufen: 'buy', koop: 'buy', kopen: 'buy', achete: 'buy', acheter: 'buy',
  // sell
  vende: 'sell', vender: 'sell', verkaufe: 'sell', verkauf: 'sell', verkaufen: 'sell', verkoop: 'sell', verkopen: 'sell', vends: 'sell', vendre: 'sell',
  // read / show
  lee: 'read', leer: 'read', lies: 'read', lees: 'read', lis: 'read', lire: 'read',
  muestra: 'show', muestrame: 'show', zeig: 'show', zeige: 'show', toon: 'show', montre: 'show', affiche: 'show',
  // create
  crea: 'create', crear: 'create', erstelle: 'create', erstellen: 'create', maak: 'create', creeer: 'create', cree: 'create', creer: 'create',
  // exit / help / fees / price / baskets
  salir: 'exit', retirar: 'exit', ausstieg: 'exit', aussteigen: 'exit', sortir: 'exit',
  ayuda: 'help', hilfe: 'help', hulp: 'help', aide: 'help',
  comisiones: 'fees', tarifas: 'fees', gebuhren: 'fees', kosten: 'fees', frais: 'fees',
  precio: 'price', preis: 'price', prijs: 'price', prix: 'price',
  cesta: 'basket', canasta: 'basket', cestas: 'baskets', canastas: 'baskets', korb: 'basket', korbe: 'baskets', mandje: 'basket', mandjes: 'baskets', panier: 'basket', paniers: 'baskets',
  // fractions + quantities
  mitad: 'half', halfte: 'half', halb: 'half', helft: 'half', moitie: 'half', cuarto: 'quarter', viertel: 'quarter', kwart: 'quarter',
  todo: 'all', alles: 'all', tout: 'all',
  // articles so question frames complete ("que es una cesta" → "what is a basket")
  una: 'a', un: 'a', eine: 'a', ein: 'a', een: 'a', une: 'a', der: 'the', die: 'the', das: 'the', el: 'the', la: 'the', le: 'the', les: 'the', het: 'the', los: 'the', de: 'de',
  cuanto: 'how much', combien: 'how much', hoeveel: 'how much',
}
// CJK has no word boundaries: phrase replaces on the raw string, spaced
const LEX_CJK: [RegExp, string][] = [
  [/什么是|什麼是/g, ' what is '],
  [/我持有什么|我有什么|我的篮子|我的籃子/g, ' what do i hold '],
  [/购买|購買|买入|買入|买|買/g, ' buy '],
  [/出售|卖出|賣出|卖|賣/g, ' sell '],
  [/创建|創建|创造/g, ' create '],
  [/篮子|籃子|籃|篮/g, ' basket '],
  [/价格|價格/g, ' price '],
  [/费用|費用|手续费|手續費/g, ' fees '],
  [/帮助|幫助/g, ' help '],
  [/一半|半/g, ' half '],
  [/全部/g, ' all '],
  [/退出|赎回|贖回/g, ' exit '],
  [/读|讀|查看|显示|顯示/g, ' read '],
  [/是什么|是什麼/g, ' what is '],
]
/** Fold diacritics so qué/hälfte/crée hit the ascii lexicon keys. */
const deburr = (x: string): string => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
function translateOperational(tIn: string): string {
  let x = deburr(tIn)
  for (const [re, en] of LEX_CJK) x = x.replace(re, en)
  for (const [re, en] of LEX_PHRASES) x = x.replace(re, en)
  x = x
    .split(' ')
    .filter(Boolean)
    .map((w) => (w === 'de' ? 'de' : (LEX_WORDS[w] ?? w)))
    .join(' ')
  return x.replace(/\s+/g, ' ').trim()
}
/** Which language the message reads as (for the localized fallback lead). */
function langOf(raw: string): 'es' | 'de' | 'nl' | 'fr' | 'zh' | null {
  if (/[\u4e00-\u9fff]/.test(raw)) return 'zh'
  const d = deburr(raw.toLowerCase())
  if (/[¿¡]|\b(que es|cuanto|cesta|canasta|comprar|vender|ayuda|tengo|entiendo|nada|esto|hola|gracias|quiero|puedo)\b/.test(d)) return 'es'
  if (/\b(was ist|warum|wie viel|korb|kaufen|verkaufen|hilfe|gebuhren|halfte|gruss|grusse|hallo|heute|geht|nicht|und|ich)\b/.test(d)) return 'de'
  if (/\b(wat is|waarom|hoeveel|mandje|kopen|verkopen|hulp|helft)\b/.test(d)) return 'nl'
  if (/\b(qu ?est|pourquoi|combien|panier|acheter|vendre|aide|frais|moitie)\b/.test(d)) return 'fr'
  return null
}
const FALLBACK_LEAD: Record<'es' | 'de' | 'nl' | 'fr' | 'zh', string> = {
  es: 'Hablo mejor ingles, pero opero igual: compra, vende, crea. El mapa:',
  de: 'Ich spreche am besten Englisch, handle aber trotzdem: kaufen, verkaufen, erstellen. Die Karte:',
  nl: 'Ik spreek het best Engels, maar handel gewoon: kopen, verkopen, maken. De kaart:',
  fr: 'Je parle mieux anglais, mais j agis quand meme: acheter, vendre, creer. La carte:',
  zh: '我英文最好，但一样可以操作：买、卖、创建。功能地图：',
}

/** English word-amounts ("fifty bucks", "a hundred dollars") → a number. */
const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, grand: 1000,
}
function wordAmount(t: string): number | null {
  const m = /\b((?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand)(?: [a-z]+)?)\s*(?:bucks?|dollars?|usd|usdc)\b/.exec(t)
  if (!m) return null
  let total = 0
  let cur = 0
  for (const w of m[1].split(' ')) {
    const v = w === 'a' ? 1 : NUM_WORDS[w]
    if (v == null) break
    if (v === 100 || v === 1000) cur = (cur || 1) * v
    else cur += v
  }
  total = cur
  return total > 0 ? total : null
}

/** Bounded Levenshtein (early exit past `max`). */
function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  // bounded DAMERAU: an adjacent transposition counts as ONE edit — "saef" is
  // one slip from "safe", plain distance called it 2 and did-you-mean missed
  // the commonest typo class (Daylight's kit-adoption finding, w-151)
  let prevPrev: number[] | null = null
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    prevPrev = prev
    prev = cur
  }
  return prev[b.length]
}

/** Common words never fuzzy-matched — "tell" must not become "sell". */
const COMMON = new Set(
  'tell well cell fell bell hell will with what when where this that they them then than have has had how who whom whose your you our are was were been being does did doing about above into like more most some such only very just also over under other could would should shall might must its his her him she the and for not but all can may now new one two see get out let say said make made take took want exist exists existed'.split(' '),
)

/** Inline weights spoken at create time: "50/30/20" (positional over the
 *  final legs) or "50% vvv 30% aero 20% pons" (by symbol). Sanity-gated so
 *  dates and "24/7" never read as weights. */
function parseInlineWeights(text: string): { run: number[] | null; bySym: Record<string, number> } | null {
  let run: number[] | null = null
  const runM = /\b(\d{1,2}(?:\s*\/\s*\d{1,2}){1,11})\b/.exec(text)
  if (runM) {
    const ns = runM[1].split('/').map((s) => Number(s.trim()))
    const sum = ns.reduce((a, b) => a + b, 0)
    if (ns.every((n) => Number.isInteger(n) && n >= 1 && n <= 97) && sum >= 99 && sum <= 101) run = ns
  }
  const bySym: Record<string, number> = {}
  for (const m of text.matchAll(/(\d{1,2})\s*%\s*(?:of\s+)?\$?([A-Za-z][A-Za-z0-9]{1,11})/g)) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n >= 1 && n <= 97) bySym[m[2].toUpperCase()] = n
  }
  if (!run && Object.keys(bySym).length === 0) return null
  return { run, bySym }
}

/** Nouns that look ticker-shaped in casual asks but never are — "is there a
 *  fee", "add my token", "do you have an api" must not become live ticker
 *  lookups; their answers live in the bank. */
const GENERIC_NOUNS = new Set(
  'fee fees cost costs charge charges risk risks catch limit limits min minimum max maximum api app apps bot bots way ways chance point price prices chart charts list lists guide docs doc help faq roadmap whitepaper audit audits discord telegram twitter site token tokens coin coins basket baskets bundle bundles question questions problem problems issue issues bug bugs plan plans yield staking rewards airdrop airdrops asset assets stuff something anything more another few couple ticker tickers'.split(
    ' ',
  ),
)
/** Filler words around an "add …" tail that are never the asset itself. */
const ADD_NOISE = new Set(['and', 'also', 'plus', 'with', 'then', 'ok', 'okay', 'yes', 'yeah', 'sure', 'basket', 'draft', 'it', 'them', 'my', 'the', 'to', 'a', 'an', 'some', 'please', 'pls', 'in', 'into', 'for', 'me'])

/** Does the text carry any of these keywords? Exact token hit, or a 1-edit
 *  typo on words of 4+ letters (never against common English words). */
function hasWord(t: string, words: string[]): boolean {
  const toks = t.split(' ')
  for (const w of words) {
    for (const tok of toks) {
      if (tok === w) return true
      if (w.length >= 4 && tok.length >= 4 && !COMMON.has(tok) && lev(tok, w, 1) <= 1) return true
    }
  }
  return false
}

/** Multi-word phrase presence on the normalized text. */
const hasPhrase = (t: string, phrases: string[]): boolean => phrases.some((p) => t.includes(p))

/** "the first one" / "2nd" / "the last one" → an index into the last rail. */
function ordinalOf(t: string): number | null {
  // ordinals are short answers ("the first one"), never clauses inside a real
  // sentence ("…in the last 24 hours" must not resolve to a rail item)
  if (t.split(' ').length > 5) return null
  if (/\b(last one|the last)$/.test(t) || /\blast one\b/.test(t)) return -1
  const m = /\b(?:the )?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|number (\d)|option (\d))\b(?: one)?/.exec(t)
  if (!m) return null
  const word: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 }
  if (m[1] in word) return word[m[1]]
  const n = Number(m[2] ?? m[3])
  return Number.isInteger(n) && n >= 1 ? n - 1 : null
}

/** "no, the other one" — the rail-pick repair phrases, whole-message only
 *  (anchored, so the words inside a real sentence never trigger it). */
const OTHER_ONE_RE = /^(?:no )?(?:not that one(?: the other(?: one)?)?|the other(?: one)?|other one)$/

/** "thats wrong" / "no thats not right" / "wrong basket" — being corrected,
 *  whole-message only: "thats wrong, sell half" must still route the sell. */
const REPAIR_RE = /^(?:no )?(?:(?:that (?:is|was) |thats )(?:wrong|not right|not it|incorrect|not what i (?:meant|asked(?: for)?|wanted))|wrong (?:basket|one|token|asset|chain|answer))$/

async function findBasket(chainId: number, text: string): Promise<{ address: Address; symbol: string; name: string } | null> {
  const list = await cachedList(chainId)
  // matching runs on the raw list; what LEAVES here is clamped (the found
  // symbol/name flow into copy, chips and share payloads)
  const out = (b: { address: string; symbol: string; name: string }) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })
  const addr = text.match(ADDR)?.[0]
  if (addr) {
    const hit = list.find((b) => b.address.toLowerCase() === addr.toLowerCase())
    if (hit) return out(hit)
    // an address the factory does not know is still readable
    return { address: addr as Address, symbol: '', name: '' }
  }
  const tick = text.match(TICKER)?.[1]?.toUpperCase()
  if (tick) {
    const hit = list.find((b) => b.symbol.toUpperCase() === tick)
    if (hit) return out(hit)
  }
  // bare symbol or name words ("buy svi", "read the ai tokens basket")
  const words = text.toLowerCase()
  // ⚠ THE SYMBOL IS ATTACKER-TYPED (anyone deploys a basket). It went into
  // `new RegExp(\`\\b${symbol}\\b\`)` raw — a symbol of "(a+)+$" is catastrophic
  // backtracking that freezes the whole tab, not just the turn (measured 83s
  // at 60 chars; audit 2026-08-21). A basket symbol is a plain ticker, so match
  // it as a LITERAL with hand-checked word boundaries — no regex, no backtrack,
  // and clamp the length a symbol may even attempt (real tickers are <= 11).
  const bySymbol = list.find((b) => {
    const sym = b.symbol.toLowerCase()
    if (!sym || sym.length > 24) return false
    let from = 0
    for (;;) {
      const at = words.indexOf(sym, from)
      if (at < 0) return false
      const before = at === 0 ? '' : words[at - 1]
      const after = at + sym.length >= words.length ? '' : words[at + sym.length]
      const boundaryBefore = before === '' || !/[a-z0-9]/.test(before)
      const boundaryAfter = after === '' || !/[a-z0-9]/.test(after)
      if (boundaryBefore && boundaryAfter) return true
      from = at + 1
    }
  })
  if (bySymbol) return out(bySymbol)
  const byName = list.find((b) => b.name && words.includes(b.name.toLowerCase()))
  return byName ? out(byName) : null
}

/** Settle a ticker against the SAME search the create page uses: house-pinned
 *  and verified identities auto-pick; a genuinely contested ticker returns its
 *  candidates for the human to choose (never a silent guess between coins). */
export function settleFromHits(hits: TokenHit[], ticker: string): { pick: { address: Address; symbol: string } } | { hits: TokenHit[] } | { none: true } {
  const exact = hits.filter((h) => h.symbol.toUpperCase() === ticker.toUpperCase())
  const pool = exact.length > 0 ? exact : hits
  if (pool.length === 0) return { none: true }
  const [a, b] = pool
  const dominant =
    pool.length === 1 ||
    a.housePinned ||
    (a.verified && !b?.verified) ||
    (a.liquidityUsd > 10_000 && a.liquidityUsd >= 5 * Math.max(1, b?.liquidityUsd ?? 0))
  if (dominant) return { pick: { address: a.address as Address, symbol: clampChainText(a.symbol) } }
  // names clamp: one live token carried thousands of characters as its name
  return { hits: pool.slice(0, 6).map((h) => ({ ...h, name: h.name.slice(0, 80), symbol: h.symbol.slice(0, 16) })) }
}

async function settleTicker(ticker: string, chainId: number): Promise<{ pick: { address: Address; symbol: string } } | { hits: TokenHit[] } | { none: true }> {
  return settleFromHits(await searchTokens(ticker, chainId).catch(() => []), ticker)
}

const fmtLiq = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`)

/** Cross-chain settle for the CREATE flow (owner 2026-08-20, live find: "add
 *  aero" on Robinhood offered two $1-liquidity unverifieds while the real
 *  verified AERO lives on Base — "it should check all three chains for the
 *  most applicable"). The active chain settles exactly as before, but every
 *  other supported chain is probed in parallel:
 *  - active offers NOTHING or dust (<$1k liq, nothing verified) while another
 *    chain holds a verified/pinned market with real liquidity → the leg
 *    REDIRECTS to that chain's draft bucket, with the reason said out loud
 *    (the buckets + bundle machinery already handle multi-chain drafts);
 *  - active has a real market but another chain's verified one is ≥25× deeper
 *    → active behavior stands and a pointer names the better chain (the
 *    existing "aero on base" phrasing is the escape hatch). */
export async function settleTickerCross(
  ticker: string,
  activeChain: number,
): Promise<
  | { pick: { address: Address; symbol: string }; chainId: number; note?: string }
  | { hits: TokenHit[]; note?: string }
  | { none: true; note?: string }
> {
  const others = SUPPORTED_CHAIN_IDS.filter((c) => c !== activeChain)
  const [activeHits, ...otherHits] = await Promise.all([
    searchTokens(ticker, activeChain).catch(() => []),
    ...others.map((c) => searchTokens(ticker, c).catch(() => [])),
  ])
  const active = settleFromHits(activeHits, ticker)
  const activeTopLiq = Math.max(0, ...activeHits.map((h) => h.liquidityUsd ?? 0))
  const activeVerified = activeHits.some((h) => h.verified || h.housePinned)
  // a plain loop, not forEach: closure assignment defeats TS narrowing on
  // `best`. Cross-chain candidates are EXACT-symbol ONLY — a fuzzy contains-
  // match must never cross chains ("aero" probed mainnet and got ITAON back).
  const trust = (y: TokenHit) => (y.housePinned ? 2 : 0) + (y.verified ? 1 : 0)
  let best: { h: TokenHit; c: number } | null = null
  for (let i = 0; i < otherHits.length; i++) {
    for (const x of otherHits[i].filter((y) => y.symbol.toUpperCase() === ticker.toUpperCase())) {
      if (!best || trust(x) > trust(best.h) || (trust(x) === trust(best.h) && (x.liquidityUsd ?? 0) > (best.h.liquidityUsd ?? 0))) best = { h: x, c: others[i] }
    }
  }
  // verified/pinned IS strength on its own: the verified-list rung is an
  // identity source and reports liq 0 (the live AERO case) — depth only has
  // to carry unverified candidates
  const strong = best != null && (best.h.housePinned || best.h.verified || (best.h.liquidityUsd ?? 0) > 10_000)
  const cred = (h: TokenHit) => {
    const bits = [h.housePinned ? 'house-pinned' : h.verified ? 'on the verified list' : '', (h.liquidityUsd ?? 0) > 0 ? `liq ${fmtLiq(h.liquidityUsd ?? 0)}` : '']
    return bits.filter(Boolean).join(', ')
  }
  if (best && strong && !activeVerified && activeTopLiq < 1_000) {
    const sym = clampChainText(best.h.symbol)
    return {
      pick: { address: best.h.address as Address, symbol: sym },
      chainId: best.c,
      note: `$${sym} settles on ${chainName(best.c)} (${cred(best.h)}). The ${chainName(activeChain)} matches are unverified dust, so it landed in your ${chainName(best.c)} draft.`,
    }
  }
  const note =
    best && strong && ((trust(best.h) > 0 && !activeVerified) || (best.h.liquidityUsd ?? 0) >= 25 * Math.max(1, activeTopLiq))
      ? `Heads up: on ${chainName(best.c)}, $${ticker.toUpperCase()} is ${cred(best.h)}. Say "${ticker.toLowerCase()} on ${chainName(best.c).toLowerCase()}" to use that one instead.`
      : undefined
  if ('pick' in active) return { ...active, chainId: activeChain, ...(note ? { note } : {}) }
  return { ...active, ...(note ? { note } : {}) }
}

/** Settle new tickers/addresses INTO the running draft, then answer with the
 *  draft's current state: a live compose card at 2+ legs, a progress line at 1.
 *  A contested ticker pauses with its candidate rail; the draft survives turns
 *  (owner 2026-08-19: "keep in memory the ones they add"). */
async function continueCreate(
  ctx: AgentContext,
  incoming: { address: Address; symbol: string }[],
  queue: string[],
  inlineWeights?: { run: number[] | null; bySym: Record<string, number> } | null,
  /** allowSingle: proceed to the compose/deploy card with a SINGLE leg (the
   *  contract minimum is 1 — MIN_ASSETS; two per chain is only a recommendation).
   *  The building flow still nudges a second; the DEPLOY path passes this so a
   *  1-token chain-basket in a multichain bundle can actually deploy. */
  allowSingle = false,
): Promise<AgentReply> {
  const failures: string[] = []
  // buckets: this chain's picks live in drafts[chainId]; a restored old-shape
  // single draft migrates into the current chain's bucket
  const drafts: Record<number, { address: Address; symbol: string }[]> = { ...(ctx.drafts ?? {}) }
  if (ctx.draft?.picks.length && !ctx.drafts) drafts[ctx.chainId] = [...ctx.draft.picks]
  const draft = { picks: [...(drafts[ctx.chainId] ?? [])] }
  const have = new Set(draft.picks.map((x) => x.address.toLowerCase()))
  // addresses arrive pre-identified; the route check below is their gate too
  for (const inc of incoming) {
    if (!have.has(inc.address.toLowerCase())) {
      draft.picks.push(inc)
      have.add(inc.address.toLowerCase())
    }
  }
  const remaining = [...queue]
  const notes: string[] = [] // cross-chain settle explanations, said out loud
  while (remaining.length > 0) {
    const ticker = remaining[0]
    const settled = await settleTickerCross(ticker, ctx.chainId)
    if ('hits' in settled) {
      return {
        actions: [
          {
            kind: 'candidates',
            chainId: ctx.chainId,
            ticker,
            hits: settled.hits,
            text: `“${ticker}” matches ${settled.hits.length} tokens on ${chainName(ctx.chainId)}. Pick the one you mean (liquidity and market cap are measured, verified = the canonical list):`,
          },
          ...(settled.note ? [{ kind: 'text' as const, text: settled.note }] : []),
        ],
        ctx: { ...ctx, draft: null, drafts: { ...drafts, [ctx.chainId]: draft.picks }, pending: { intent: 'create', queue: remaining } },
      }
    }
    remaining.shift()
    if ('pick' in settled) {
      if (settled.chainId !== ctx.chainId) {
        // the cross-chain redirect: route-check on ITS chain, then it joins
        // that chain's bucket — the buckets + bundle machinery carry it
        try {
          const a = await resolveAsset(settled.pick.address, settled.chainId)
          const bucket = drafts[settled.chainId] ?? []
          if (!bucket.some((x) => x.address.toLowerCase() === settled.pick.address.toLowerCase()))
            drafts[settled.chainId] = [...bucket, { address: a.address as Address, symbol: clampChainText(a.symbol || settled.pick.symbol) }].slice(0, 12)
          if (settled.note) notes.push(settled.note)
        } catch {
          failures.push(`${ticker}: settles on ${chainName(settled.chainId)} but no tradeable route answered there`)
        }
      } else {
        if (!have.has(settled.pick.address.toLowerCase())) {
          draft.picks.push(settled.pick)
          have.add(settled.pick.address.toLowerCase())
        }
        if (settled.note) notes.push(settled.note)
      }
    } else {
      failures.push(`${ticker}: nothing by that symbol answers on ${chainName(ctx.chainId)}`)
      if (settled.note) notes.push(settled.note)
    }
  }
  // the route check is the final authority per leg (drops the unroutable)
  const legs: { address: Address; symbol: string }[] = []
  for (const p of draft.picks.slice(0, 12)) {
    try {
      const a = await resolveAsset(p.address, ctx.chainId)
      legs.push({ address: a.address as Address, symbol: clampChainText(a.symbol || p.symbol) })
    } catch (e) {
      failures.push(`${p.symbol}: ${e instanceof Error ? e.message.split('\n')[0] : 'no tradeable route'}`)
    }
  }
  const names = legs.map((l) => `$${l.symbol}`).join(' · ')
  const nextDrafts = { ...drafts, [ctx.chainId]: legs }
  if (legs.length === 0) delete nextDrafts[ctx.chainId]
  const otherBuckets = Object.entries(nextDrafts).filter(([id, p]) => Number(id) !== ctx.chainId && p.length > 0)
  // THE CROSS-CHAIN DRAFT CARD (owner 19:3x-4x: "way less text, way more
  // condensed, more visual" — the spans-chains text + steps became ONE card):
  // 2+ chains holding legs = the unified visual; the REAL BundleCard joins as
  // the finale once two chains have deployed
  const bundleBlock: AgentAction[] =
    otherBuckets.length > 0
      ? [
          {
            kind: 'crossDraft',
            buckets: Object.entries(nextDrafts)
              .filter(([, p]) => p.length > 0)
              .map(([id, p]) => ({ chainId: Number(id), picks: p })),
            deployed: ctx.deployedBaskets ?? [],
          },
          ...(new Set((ctx.deployedBaskets ?? []).map((b) => b.chainId)).size >= 2 ? bundleTail(ctx) : []),
        ]
      : []
  // cross-chain settle explanations lead every shape of answer
  const notesBlock: AgentAction[] = notes.map((n) => ({ kind: 'text' as const, text: n }))
  if (legs.length === 0)
    return {
      actions: [
        ...notesBlock,
        failures.length
          ? { kind: 'text', text: `Nothing settled here:\n${failures.join('\n')}\nName assets as tickers or addresses and I try again.` }
          : notes.length
            ? { kind: 'text', text: `Nothing landed on ${chainName(ctx.chainId)} itself. Keep naming assets, any chain: the right bucket catches each one.` }
            : { kind: 'text', text: `Building on ${chainName(ctx.chainId)} now. Name assets, tickers or contract addresses, and they land in this chain's basket.` },
        ...bundleBlock,
      ],
      ctx: { ...ctx, draft: null, drafts: Object.keys(nextDrafts).length ? nextDrafts : null, pending: { intent: 'create' } },
    }
  // ONE LEG — the contract allows a single-token basket (MIN_ASSETS = 1), so
  // this is a NUDGE, not a wall (owner 2026-08-21: "word it better; two per
  // network is best but not required"). The deploy path (allowSingle) skips
  // the nudge and composes the one-leg basket. During building we still invite
  // a second, and the wording explains the multichain reason plainly.
  if (legs.length === 1 && !allowSingle) {
    const spansChains = otherBuckets.length > 0
    const nudge = spansChains
      ? `Your picks land on different chains, so this is a BUNDLE: each chain becomes its own basket. ${chainName(ctx.chainId).replace(/\s*chain$/i, '')} holds just ${names} so far. Two tokens per network makes a fuller basket, though one is enough to launch. Add more to any chain, or finalize below.`
      : `Your ${chainName(ctx.chainId).replace(/\s*chain$/i, '')} draft holds ${names}. Add another token for a real mix, or launch it as a single-token basket below.`
    return {
      actions: [
        ...notesBlock,
        ...(failures.length ? [{ kind: 'text' as const, text: `Skipped: ${failures.join(' · ')}` }] : []),
        { kind: 'text', text: nudge },
        ...bundleBlock,
        // single-chain gets its compose/deploy card straight away (a 1-leg
        // basket is valid); the multichain bundle shows its crossDraft instead
        ...(spansChains ? [] : [{ kind: 'create' as const, chainId: ctx.chainId, legs }]),
      ],
      ctx: { ...ctx, draft: null, drafts: nextDrafts, pending: { intent: 'create' } },
      // NO 'Deploy it' chip in the single-chain branch: the reply already emits
      // the create card, whose own button deploys. A chip beside it is a second
      // parallel door to the identical money action (owner 2026-08-21).
      chips: spansChains ? ['Finalize basket', 'Best performers in the last 24 hours?', 'Start over'] : ['Add another asset', 'Start over'],
    }
  }
  // spoken weights ("50/30/20", "50% vvv 30% aero") prefill the composer when
  // they line up with the final legs; anything off just leaves the equal split
  const spokenWeights = (() => {
    if (!inlineWeights) return undefined
    if (inlineWeights.run && inlineWeights.run.length === legs.length) {
      const ws = [...inlineWeights.run]
      ws[ws.length - 1] += 100 - ws.reduce((a, b) => a + b, 0)
      if (ws.every((n) => n >= 1 && n <= 97)) return ws
    }
    if (Object.keys(inlineWeights.bySym).length) {
      const ws = legs.map((l) => inlineWeights.bySym[l.symbol.toUpperCase()] ?? 0)
      if (ws.every((n) => n > 0) && ws.reduce((a, b) => a + b, 0) === 100) return ws
    }
    return undefined
  })()
  return {
    actions: [
      ...notesBlock,
      ...(failures.length ? [{ kind: 'text' as const, text: `Skipped: ${failures.join(' · ')}` }] : []),
      { kind: 'text', text: `Your ${chainName(ctx.chainId)} draft: ${names}. Add more, remove one, or deploy below.` },
      { kind: 'create', chainId: ctx.chainId, legs, ...(spokenWeights ? { weights: spokenWeights } : {}) },
      ...bundleBlock,
    ],
    // the slot STAYS armed: the draft is still being built, and the next bare
    // asset (any chain) keeps collecting — strong intents release it anyway
    ctx: { ...ctx, draft: null, drafts: nextDrafts, pending: { intent: 'create' } },
    celebrate: true,
    chips: [`Remove $${legs[legs.length - 1].symbol}`, 'Add another asset', 'Start over'],
  }
}

const WINDOWS = { '24h': 24 * 3600, '7d': 7 * 24 * 3600, '30d': 30 * 24 * 3600 } as const

// movers reads up to 24 baskets whole — a repeated ask must not hammer the RPC
// (self-DoS is abuse too). One-minute memory per (chain, window).
const MOVERS_CACHE = new Map<string, { at: number; action: AgentAction }>()

/** Best performers, measured from what the app itself reads: basket NAV series
 *  for the window, and every constituent's live 24h change — never a ranking
 *  bought from an indexer. */
async function moversFor(chainId: number, windowLabel: keyof typeof WINDOWS): Promise<AgentAction> {
  const cacheKey = `${chainId}:${windowLabel}`
  const cached = MOVERS_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.at < 60_000) return cached.action
  const list = await cachedList(chainId)
  if (list.length === 0) return { kind: 'text', text: `No baskets on ${chainName(chainId)} to measure.` }
  const capped = list.slice(0, 24)
  const datas = (await Promise.all(capped.map((b) => cachedBasket(b.address as Address, chainId).catch(() => null)))).filter(
    (d): d is BasketData => d != null,
  )
  const nowSec = Math.floor(Date.now() / 1000)
  const horizon = WINDOWS[windowLabel]
  let unmeasured = list.length - datas.length
  const baskets = datas
    .map((d) => {
      const s = d.navSeries
      if (!s || s.length < 2) {
        unmeasured++
        return null
      }
      const target = nowSec - horizon
      let base = s[0]
      for (const p of s) {
        if (p.time <= target) base = p
        else break
      }
      const last = s[s.length - 1]
      // a series shorter than half the window cannot honestly claim the window
      if (!(base.value > 0) || last.time - base.time < horizon * 0.5) {
        unmeasured++
        return null
      }
      return { address: d.address as Address, symbol: clampChainText(d.symbol), name: clampChainText(d.name), changePct: (last.value / base.value - 1) * 100 }
    })
    .filter((b): b is NonNullable<typeof b> => b != null)
    .sort((x, y) => y.changePct - x.changePct)
    .slice(0, 6)
  // constituents: every asset baskets hold, its LIVE 24h change (the one
  // window the pair data itself carries)
  const byAddr = new Map<string, { address: Address; symbol: string; changePct: number; fromBasket: string }>()
  for (const d of datas) {
    for (const h of d.holdings) {
      if (h.change24hPct == null) continue
      const key = h.asset.toLowerCase()
      const prev = byAddr.get(key)
      if (!prev || h.change24hPct > prev.changePct)
        byAddr.set(key, { address: h.asset as Address, symbol: clampChainText(h.symbol) || '?', changePct: h.change24hPct, fromBasket: clampChainText(d.symbol) })
    }
  }
  const assets = [...byAddr.values()].sort((x, y) => y.changePct - x.changePct).slice(0, 8)
  const action: AgentAction = { kind: 'movers', chainId, windowLabel, assets, baskets, partial: unmeasured > 0 }
  MOVERS_CACHE.set(cacheKey, { at: Date.now(), action })
  return action
}

async function readBasketAction(chainId: number, address: Address): Promise<AgentAction> {
  const data = await cachedBasket(address, chainId)
  if (!data) return { kind: 'text', text: `That basket did not read on ${chainName(chainId)}. Wrong address, wrong chain, or the RPC could not answer.` }
  // chain-typed names clamp at this boundary before entering the payload
  const shown = { ...data, symbol: clampChainText(data.symbol), name: clampChainText(data.name), holdings: data.holdings.map((h) => ({ ...h, symbol: clampChainText(h.symbol) })) }
  // holdings carry the design weights themselves (targetWeightPct) — no second
  // read to fail, so every basket renders its native bento
  return { kind: 'basket', chainId, data: shown, weights: shown.holdings.map((h) => h.targetWeightPct) }
}


// ── THE QA BANK (owner 2026-08-19: "slightly custom answers for a hugely vast
// range of questions, each furthering the user doing things via the chat").
// Declarative rows, evaluated AFTER every operational intent so a question can
// never shadow a trade. Register: short, mechanism-factual, no promises, no
// advice, every answer ends at an action. All copy public-safe (the kit ships
// this file).
interface BankRow {
  m: RegExp
  /** plain answer; omitted when a rich payload below speaks instead */
  a?: string | ((ctx: AgentContext) => string)
  hero?: Extract<AgentAction, { kind: 'hero' }>
  steps?: Extract<AgentAction, { kind: 'steps' }>
  compare?: Extract<AgentAction, { kind: 'compare' }>
  chips?: string[]
  link?: { href: string; label: string; text: string }
}

const STEER = ['What baskets are there?', 'Best performers in the last 24 hours?', 'Help me create my own basket']

/** Orientation asks, endless ("what can i do here", "im new", "show me
 *  around", "where do i start" — owner 2026-08-20: the live miss). Tested on
 *  the filler-stripped core. Anchored/specific forms so bank rows keep their
 *  own questions ("how easy is it to get started" stays the hero row). */
const ORIENT =
  /what can i do\b|what do i do\b|what am i (supposed|meant) to do|where (do|should|can) i (start|begin)|how do i (start|begin|get started|use this)|show me around|give me (a |the )?tour|what is possible|what are my options|^options\b|\bnew here\b|first time here|what should i do( first| here)?$|^what now$|^now what$|orient me|walk me through (it|this)?$|what does this (site|page|place|app|chat) do|what is this (site|place|page|app|chat|thing)|how does this chat work|what can this (chat )?do|what happens here|what is going on here|^(a )?tour$|^intro$|^menu$/

/** The orientation map: one tappable card of everything the chat operates.
 *  Static and chain-free, so it can never fail — the floor every unmatched
 *  question lands on instead of a shrug (owner: "an endless catch all"). */
function orientationReply(ctx: AgentContext, lead: string): AgentReply {
  return {
    actions: [
      { kind: 'text', text: lead },
      {
        kind: 'steps',
        title: 'What you can do here',
        steps: [
          { text: 'See every live basket', send: 'What baskets are there?' },
          { text: 'Read one: holdings, NAV, fees, measured on-chain', send: 'Read a basket' },
          { text: 'Trade it: buy or sell in the chat, your wallet signs', send: 'Buy a basket' },
          { text: 'Check what you hold', send: 'What do I hold?' },
          { text: 'Build your own: name 2 to 12 assets, deploy from here', send: 'Help me create my own basket' },
          { text: 'Exit any time: sell, or redeem the underlying in kind', send: 'How do I exit?' },
        ],
        foot: 'Everything signs in your wallet. Nothing here holds keys.',
      },
    ],
    ctx,
    chips: ['Best performers in the last 24 hours?', 'What is a basket?', 'Is it safe?'],
  }
}

const QA_BANK: BankRow[] = [
  // ── identity / trust ──
  {
    m: /what is spectrum\b|about spectrum|what does spectrum do/,
    a: 'Spectrum is open-source software for basket tokens: one ERC-20 that holds a weighted mix of assets, tradeable through its own pool. This site is one deployment of it. Easiest way in: look at what exists.',
    chips: STEER,
  },
  {
    m: /open source|github|source code|self host|can i host/,
    a: 'Yes. The whole kit is open source, and anyone can host their own deployment. Agents can even operate it over MCP.',
    link: { href: '/mcp', label: 'The agent surface', text: 'The repo link and the agent tooling live here.' },
    chips: STEER,
  },
  {
    m: /who (built|made|runs|is behind) (this|it|spectrum)|the team\b/,
    a: 'This site runs the open-source Spectrum kit; the deployment is hosted by its operator, and the contracts run on their own with no admin keys. What matters is verifiable: read any basket and check its address on-chain.',
    chips: ['Read a basket', 'What baskets are there?'],
  },
  {
    m: /who is specter|the mascot|the ghost\b|whats the ghost/,
    a: 'Specter is this site’s resident ghost. Boo-lish on baskets, holds no keys, never sleeps on the job (naps occasionally). Try booping it. Then buy something.',
    chips: STEER,
  },
  { m: /^(gm|gm gm|wagmi|lfg|gn)\b/, a: 'gm. The chain never sleeps and neither do baskets. What are we doing today?', chips: STEER },
  { m: /^(thanks|thank you|ty|thx|cheers)\b/, a: 'Anytime. Want to keep going?', chips: STEER },

  // ── the product, compared ──
  {
    m: /\betf\b|index fund|mutual fund|like an index/,
    compare: {
      kind: 'compare',
      title: 'Index fund shape, on-chain plumbing',
      left: { head: 'A traditional index product', rows: ['A manager and a custodian between you and it', 'Market hours, brokers, account paperwork', 'Composition changes decided for you'] },
      right: { head: 'A basket here', rows: ['One token your wallet holds directly', 'Trades any hour, one transaction', 'Immutable mix: nobody can change it under you', 'Exit in-kind to the underlying, any time'] },
      foot: 'Same idea, no middle layer.',
    },
    chips: ['What baskets are there?', 'Buy a basket', 'How do fees work?'],
  },
  {
    m: /buying (tokens|coins|them) (individually|separately|one by one)|why not just buy|vs buying/,
    compare: {
      kind: 'compare',
      title: 'Ten coins vs one basket',
      left: { head: 'Buying them one by one', rows: ['N swaps, N approvals, N gas bills', 'Proportions drift the moment you stop watching', 'Ten positions to price, track, and sell'] },
      right: { head: 'One basket', rows: ['One buy, weights handled by the contract', 'One line in your wallet, one chart', 'One exit, pooled or straight to the underlying'] },
      foot: 'The mix stays true to its weights by construction.',
    },
    chips: ['What baskets are there?', 'Best performers in the last 24 hours?'],
  },
  {
    m: /does spectrum have a token|wen token|native token|governance token/,
    a: 'The software itself has no token. What this deployment lists is whatever baskets its factory holds, and each basket is its own ERC-20.',
    chips: ['What baskets are there?'],
  },

  // ── money-in questions ──
  {
    m: /minimum|how much (money|do i need)|smallest (buy|amount)|min buy/,
    a: 'Any amount above one unit of settlement works for a normal buy. The one exception: the FIRST buy of a brand-new basket seeds its reserves and needs at least $10.',
    chips: ['Buy a basket', 'What baskets are there?'],
  },
  {
    m: /\bgas\b|transaction cost|how expensive|network fee/,
    a: 'You pay the chain’s own gas plus the basket’s fee (set at deploy, contract floor 1%). Base and Robinhood are cheap; Ethereum costs Ethereum prices. Say a chain name any time to switch.',
    chips: ['What baskets are there on Base?', 'How do fees work?'],
  },
  {
    m: /which wallet|what wallets|connect (a |my )?wallet|how do i connect|ledger|trezor|hardware wallet/,
    a: 'The Connect button is top right of this chat. Injected wallets and WalletConnect both work; your keys never touch this site.',
    chips: ['What do I hold?', 'What baskets are there?'],
  },
  { m: /\bmobile\b|on my phone|phone app|iphone|android|\bios\b|app store/, a: 'Works on phones: open this site inside your wallet’s browser and everything here signs the same way.', chips: STEER },
  {
    m: /settlement|why usdc|what currency|pay with eth/,
    a: 'Buys quote in the chain’s settlement asset (the USDC family). Hold something else? The portfolio flows can fund across assets; in this chat, USDC in, basket out.',
    chips: ['Buy a basket', 'What do I hold?'],
  },
  {
    m: /bridge|cross.?chain|move (funds|money) (to|between)/,
    a: 'The bridge lives inside every buy card: "Move funds from another network" brings settlement over (LI.FI powered) and the buy continues with the arrived amount, right here in the chat. Say "on Base" or "on Robinhood" to switch chains first if the basket lives elsewhere.',
    chips: ['Buy a basket', 'What baskets are there on Robinhood?'],
  },

  // ── mechanics: floors, slippage, pricing ──
  {
    m: /slippage|price impact|front.?run|sandwich/,
    a: 'Every trade here signs a floor derived from a live simulation of that exact trade, minus your tolerance. Under the floor, the chain reverts and nothing moves. You set the tolerance when you trade; I never invent one.',
    chips: ['Buy a basket', 'What is NAV?'],
  },
  {
    m: /where do prices come from|price feed|oracle|data source/,
    a: 'From the chain itself: each constituent’s own pools price the basket, and the NAV I show carries its provenance (fully on-chain or partially priced). No off-chain oracle to trust.',
    chips: ['Read a basket', 'What is NAV?'],
  },
  {
    m: /\baum\b|\btvl\b|total value|market cap of/,
    a: 'AUM is what a basket actually holds, valued live. Read any basket and it is right there, next to NAV and supply.',
    chips: ['Read a basket', 'Best performers in the last 24 hours?'],
  },

  // ── safety / control ──
  {
    m: /can (the )?(creator|deployer|owner|team|they) (steal|take|rug|drain|change)/,
    a: 'No. A deployed basket is immutable: no admin keys, no upgrade path, no way for anyone to touch the holdings or the weights. The creator’s only power is the fee share they locked in at deploy.',
    chips: ['Is it safe?', 'Read a basket'],
  },
  {
    m: /audit|audited|is the code (safe|checked)/,
    a: 'The contracts are verifiable on-chain and the kit ships its verification page, so you can check the deployed bytecode yourself rather than trust a badge.',
    link: { href: '/verify', label: 'Verify the contracts', text: 'Every deployed contract, checkable.' },
    chips: ['Is it safe?'],
  },
  {
    m: /contract address|the addresses|which contracts|whats the ca\b|\bca\b of/,
    a: 'Read any basket here and its address is on the card; the deployment’s core contracts live on the verify page.',
    link: { href: '/verify', label: 'Verify the contracts', text: 'Factory, routers, and the rest.' },
    chips: ['Read a basket'],
  },
  {
    m: /token .{0,24}(dies|rugs|goes to zero)|dead (leg|token)|one of the (tokens|assets) (fails|rugs)/,
    a: 'If a constituent’s market dies, a pooled sell may park that leg, but redeem in kind always works: you receive the underlying tokens directly, no pool involved. The exit never depends on the sickest leg.',
    chips: ['How do I exit?', 'What do I hold?'],
  },
  {
    m: /private basket|basket private|make .{0,16}private|hide my|secret basket/,
    a: 'Everything here is on a public chain, so every basket and every holding is public by nature. Name it discreetly if you like; the chain still sees it.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /delete|remove my basket|take it down/,
    a: 'A deployed basket cannot be deleted; it is an immutable contract. You can exit your own holdings any time, and a basket nobody holds simply sits empty.',
    chips: ['How do I exit?', 'What do I hold?'],
  },

  // ── yield / performance / advice-shaped (honest, no promises) ──
  {
    m: /\bapy\b|\byield\b|staking|passive income|interest/,
    a: 'Baskets pay no yield. A basket token tracks the value of what it holds, nothing more. If the mix rises it rises; there is no emissions faucet behind it.',
    chips: ['Best performers in the last 24 hours?', 'What baskets are there?'],
  },
  { m: /dividend/, a: 'No dividends. The token’s value is the holdings’ value; the only cash flows are the fees the contract charges on trades.', chips: ['How do fees work?'] },
  {
    m: /will (it|.*) (go up|pump|moon)|price prediction|predict|forecast/,
    a: 'I do not predict, I measure. What I can give you is what actually moved and what each basket actually holds. Decide from the real numbers.',
    chips: ['Best performers in the last 24 hours?', 'Read a basket'],
  },
  {
    m: /which (basket )?(should|would) i buy|best basket to buy|what do you recommend|recommend/,
    a: 'Not my call to make, and listing here is never an endorsement. My honest offer: the measured movers, and a full read of anything that catches your eye. You decide.',
    chips: ['Best performers in the last 24 hours?', 'What baskets are there?'],
  },
  {
    m: /\btax\b|taxes|taxable/,
    a: 'Not tax advice, and rules differ by country. On-chain history makes your records easy to pull; how they are treated is one for your jurisdiction and adviser.',
    chips: ['What do I hold?'],
  },
  {
    m: /^(?!.*(seed|wallet|key|phrase))(i .*(lost|down)|my basket is down|in the red|losing money)/,
    a: 'A basket tracks its holdings, down as faithfully as up. Your three doors: hold it, sell into settlement, or redeem the underlying tokens in kind. All three work from here.',
    chips: ['What do I hold?', 'How do I exit?'],
  },
  {
    m: /profit|pnl|how am i doing|performance of my/,
    a: 'The portfolio page tracks your positions and their movement over time; in here, ask what you hold and I bring the live rail.',
    link: { href: '/portfolio', label: 'Open the portfolio', text: 'Your full position view.' },
    chips: ['What do I hold?'],
  },

  // ── creating ──
  {
    m: /how (do|can) (creators?|i) (earn|make money|get paid|monetize)/,
    hero: {
      kind: 'hero',
      art: 'amber',
      title: 'Ship the idea. The contract pays you.',
      lines: [
        'Lock a creator share of the basket fee at deploy, up to 30% of it',
        'Paid by the contract on every trade, forever, to your payout address',
        'No listing gate, no middleman, no invoice: it is in the bytecode',
      ],
      foot: 'Whether it trades is up to the basket. The rail is real either way.',
      cta: { label: 'Make your own', send: 'Help me create my own basket' },
    },
    chips: ['Help me create my own basket', 'How do fees work?'],
  },
  {
    m: /add (a |the )?token|list (a |my )?token|can you (add|list)/,
    a: 'Nothing gets "listed" here; if a token has a routable market on the chain, anyone can put it in a basket right now. Name it and I check it live.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /eth (as a )?leg|weth leg|can i (put|add) (eth|weth)/,
    a: 'ETH and WETH cannot be legs; they are the routing hub every leg trades through. Everything else with a live market qualifies.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /how many (assets|legs|tokens) (can|per)|max (assets|legs|tokens)/,
    a: '2 to 12 legs, integer weights from 1 to 99 summing to exactly 100. Drop tickers or addresses here and I collect them as we go.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /fee (bounds|limits|range)|max fee|creator share/,
    a: 'Basket fee: the contract floors it at 1% total. Creator share: 0 to 30% of that fee, locked at deploy. In-chat deploys default to 1% with no creator share; the composer sets custom splits.',
    chips: ['Help me create my own basket', 'How do fees work?'],
  },
  {
    m: /deploy cost|cost to (create|launch|deploy)/,
    a: 'The factory quotes a live deploy price in the chain’s native token; I read it before you sign and carry it as a maximum, so a surprise repricing reverts instead of overpaying.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /salt mining|mining the address|what is create2|predicted address/,
    a: 'Before deploying I search for a CREATE2 address bound to your wallet, so the basket lands exactly where the review says and nobody else can deploy it. It takes seconds to a minute; Specter juggles while you wait.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /^(?!.*phrase)(?=.*(holds? nothing|empty basket|why is my basket empty|\bseed\b))/,
    a: 'Deploying mints nothing; the first buy seeds the reserves ($10 minimum on that first one). Until then the basket is live but empty.',
    chips: ['Buy a basket', 'What do I hold?'],
  },
  {
    m: /copy (a |someone|that|this)|clone (a )?basket|same as/,
    a: 'Read the basket you admire, note its legs and weights, then tell me those assets and set the split. On-chain composition is public; copying it is just building it.',
    chips: ['Read a basket', 'Help me create my own basket'],
  },
  {
    m: /name (my|the|a) basket|what should i (call|name)|basket name/,
    a: 'Name the thesis, not the tokens: what belief does the mix express? Short and memorable beats clever. The symbol is 2 to 11 characters.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /basket ideas|what basket should i (make|create|build)|ideas for|what should i (add|put in)/,
    a: 'Start from what actually moved and what conviction you hold that the market has not priced. The movers are a real starting point; your thesis is the rest.',
    chips: ['Best performers in the last 24 hours?', 'Help me create my own basket'],
  },

  // ── site surfaces ──
  {
    m: /what (is|are) (a )?bundles?\b/,
    a: 'A bundle groups several baskets into one shareable page: a portfolio-of-portfolios a creator publishes. Baskets stay the tradeable unit.',
    link: { href: '/bundle', label: 'See bundles', text: 'Published bundles live here.' },
    chips: ['What baskets are there?'],
  },
  {
    m: /what is (a |the )?thesis\b|thesis page/,
    a: 'The thesis is the creator’s written case for their basket: what the mix believes and why. It lives on the basket’s card and page. The numbers beside it are measured, not claimed.',
    chips: ['Read a basket'],
  },
  {
    m: /creator (page|profile|name)|claim (a )?(name|handle)|@[a-z0-9]+/,
    a: 'Creators can claim an on-chain name that their baskets and pages resolve under. First come, one owner, verifiable from public logs.',
    link: { href: '/creators', label: 'For creators', text: 'Claiming and the creator surface.' },
    chips: ['Help me create my own basket'],
  },
  {
    m: /league|leaderboard|ranking of creators/,
    a: 'The creator league ranks by measured performance of what they shipped.',
    link: { href: '/league', label: 'The creator league', text: 'Standings, from real numbers.' },
    chips: ['Best performers in the last 24 hours?'],
  },
  {
    m: /\bapi\b|\bmcp\b|bots?\b|agents? (use|trade)|automate/,
    a: 'Yes: the kit ships an MCP server, so any MCP-speaking agent can read baskets and compose trades with the same floors this chat uses. Your wallet still signs everything.',
    link: { href: '/mcp', label: 'The agent surface', text: 'Tools, quick start, the Bankr lane.' },
    chips: STEER,
  },

  // ── troubleshooting ──
  {
    m: /(tx|transaction|buy|sell) (failed|reverted|refused|error)|why did (it|my .{0,14}) (fail|revert)/,
    steps: {
      kind: 'steps',
      title: 'A refusal is the floor doing its job',
      steps: [
        { text: 'Read the refusal text: it names the exact reason' },
        { text: 'Market moved past your floor? Re-quote and go again', send: 'Buy a basket' },
        { text: 'Thin pool? Size the trade down' },
        { text: 'A parked leg? The in-kind exit always stands', send: 'How do I exit?' },
      ],
      foot: 'Nothing moved: a revert costs gas, never the trade.',
    },
    chips: ['Buy a basket', 'How do I exit?'],
  },
  {
    m: /cancel (a |the |my )?(tx|transaction)|stuck (tx|transaction)|pending/,
    a: 'A sent transaction belongs to your wallet, not this site; speed it up or cancel from the wallet (same nonce, higher gas). Nothing here can move without a fresh signature from you.',
    chips: ['What do I hold?'],
  },
  // ── mechanics, deeper ──
  {
    m: /what happens when i buy|how does a buy work|buy under the hood/,
    steps: {
      kind: 'steps',
      title: 'What one buy actually does',
      steps: [
        { text: 'Your settlement enters the basket pool in one transaction' },
        { text: 'The contract acquires every leg at its weight, floors riding in the payload' },
        { text: 'Shares mint to you at the measured rate, or the whole thing reverts' },
        { text: 'Try it small', send: 'Buy a basket' },
      ],
      foot: 'The quote IS a simulation of this exact path.',
    },
    chips: ['Buy a basket', 'What is NAV?'],
  },
  {
    m: /redeem in kind|in.?kind (exit|redeem)|what is redeem/,
    hero: {
      kind: 'hero',
      art: 'teal',
      title: 'The exit that cannot be blocked',
      lines: [
        'Burn your shares, receive every constituent token directly',
        'Touches no pool, needs no floor, no market can gate it',
        'Works even when a pooled sell cannot',
      ],
      foot: 'The escape hatch is a contract property, not a promise.',
    },
    chips: ['How do I exit?', 'What do I hold?'],
  },
  {
    m: /limit order|stop loss|take profit order|\bdca\b|recurring buy|auto.?buy|scheduled? buys?/,
    a: 'No order book here: trades execute now, protected by a floor from a live simulation. For exits on your terms, watch the movers and act when the number is yours.',
    chips: ['Best performers in the last 24 hours?', 'What do I hold?'],
  },
  {
    m: /when (do|are) fees (charged|taken)|fee on (buy|sell|hold)/,
    a: 'The basket fee is charged by the contract on pooled buys and sells. Holding costs nothing; redeeming in kind touches no pool.',
    chips: ['How do fees work?', 'Buy a basket'],
  },
  {
    m: /rebalance automatically|auto.?rebalance|does it rebalance/,
    a: 'No silent rebalancing, ever: the weights you see are the weights it keeps. A new mix means a new version, deployed and linked, holders migrate by choice.',
    chips: ['Read a basket', 'Help me create my own basket'],
  },
  {
    m: /what is supply\b|total supply|how many shares/,
    a: 'Supply is how many shares of the basket exist; NAV times supply is the AUM. Every buy mints, every sell or redeem burns.',
    chips: ['Read a basket'],
  },
  {
    m: /which tokens (can|are allowed)|token allowlist|any token/,
    a: 'No allowlist: any token with a live routable market on the chain qualifies as a leg, except ETH and WETH (the routing hub itself). Name one and I check it live.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /how long (does|will) (deploy|it take)|deploy time/,
    a: 'Address mining takes seconds to a minute, the deploy itself is one block. From naming it to live is usually under two minutes.',
    chips: ['Help me create my own basket'],
  },
  {
    m: /change (the )?fee later|edit (the )?fee|fee after deploy/,
    a: 'No: the fee and the creator share are CREATE2-committed at deploy and immutable after. That is a feature; holders can read exactly what they signed up for, forever.',
    chips: ['How do fees work?', 'Help me create my own basket'],
  },
  {
    m: /same basket (on|across)|multiple chains|deploy on (both|all)/,
    a: 'A basket lives on one chain. Name assets across chains and it becomes a BUNDLE: one basket per chain, one page, one buy flow, and one button here that launches them all.',
    chips: ['What baskets are there on Base?', 'Help me create my own basket'],
  },
  {
    m: /interface (fee|share)|who earns from this site|frontend fee/,
    a: 'The protocol pays interfaces about 5% of the basket fees they route, claimable permissionlessly. It is how independent frontends sustain themselves without touching user funds.',
    link: { href: '/integrate', label: 'Route baskets', text: 'The integrator page carries the exact mechanism.' },
    chips: ['How do fees work?'],
  },
  {
    m: /what is robinhood chain|why robinhood|rh chain\b/,
    a: 'Robinhood Chain is one of the three networks this deployment runs on, alongside Base and Ethereum. Same contracts, same rules, its own baskets.',
    chips: ['What baskets are there on Robinhood?'],
  },
  {
    m: /default slippage|what slippage|slippage default/,
    a: 'Trades default to the kit’s own tolerance. Want it different? The trade card has the dial: adjust it there before you sign.',
    chips: ['Buy a basket'],
  },
  {
    m: /gift (a )?basket|send (a )?basket to|transfer (my )?shares/,
    a: 'Basket shares are plain ERC-20s: send them from your wallet like any token. To point a friend here instead, grab the share link.',
    chips: ['Share a basket', 'What do I hold?'],
  },
  {
    m: /airdrops?\b|holder rewards|rewards for holding/,
    a: 'No emissions, no points, no farm: holding a basket is holding the mix, nothing else. The honest pitch is the mix itself.',
    chips: ['Best performers in the last 24 hours?'],
  },
  {
    m: /what makes a good basket|good basket|strong basket/,
    a: 'A thesis someone can disagree with, legs with real liquidity, and weights that mean something. The composer backtests the mix before you commit.',
    chips: ['Help me create my own basket', 'Best performers in the last 24 hours?'],
  },
  {
    m: /is this a (dex|exchange|aggregator)/,
    a: 'It is basket infrastructure: each basket is its own pool, tradeable directly. The swap page handles one-to-one trades; this chat handles baskets end to end.',
    chips: ['What baskets are there?'],
  },
  {
    m: /track my basket|after (i )?deploy|my basket.s (page|link)/,
    steps: {
      kind: 'steps',
      title: 'Your basket, after the deploy',
      steps: [
        { text: 'Read it any time: NAV, holders, the chart', send: 'Read a basket' },
        { text: 'Grab the share link and put it in your bio', send: 'Share a basket' },
        { text: 'Watch it against the field', send: 'Best performers in the last 24 hours?' },
      ],
      foot: 'The first buy seeds it; shares mint from there.',
    },
    chips: ['What do I hold?'],
  },
  {
    m: /privacy|data (do you|does this) collect|cookies/,
    a: 'Reads go straight at the chain and your keys never touch this site. The privacy page states the rest plainly.',
    link: { href: '/privacy', label: 'Privacy', text: 'The whole policy.' },
    chips: STEER,
  },
  {
    m: /terms|legal|disclaimer/,
    a: 'The terms and the risk disclosure are both one click, written to be read.',
    link: { href: '/terms', label: 'Terms', text: 'And /risk for the risk disclosure.' },
    chips: STEER,
  },
  {
    m: /support|contact|help me with a (bug|problem)|report a bug|found a bug|something(s| is) broken/,
    a: 'Start with the Learn page; if something here misbehaved, say exactly what you asked and what came back and I take another run at it.',
    link: { href: '/learn', label: 'Learn', text: 'The full explainer and FAQ.' },
    chips: STEER,
  },
  {
    m: /(site|page|chart|it) (is )?(slow|not loading|broken|stuck)/,
    a: 'Usually the chain’s RPC having a moment. Give it a beat and re-ask; reads here go straight at the chain, so a retry is honest.',
    chips: ['What baskets are there?'],
  },

  // ── the natural-language round (owner 2026-08-20: "catch more questions
  // people have… more natural language") ──
  {
    m: /is (this|it|spectrum) (a scam|legit|real|safe to use)|can i trust (this|it|you)|too good to be true/,
    a: 'Fair question, and you never have to trust words: the code is open source, the contracts have no admin keys, nothing here custodies your assets, and every basket reads on-chain before you touch it. Judge from the reads, not from me.',
    chips: ['Is it safe?', 'Read a basket', 'What baskets are there?'],
  },
  {
    m: /can i lose (money|it all|everything)|how risky|what are the risks|worst case/,
    a: 'Yes: a basket tracks its holdings, so if they fall, it falls. Nothing here promises returns. What the structure protects is custody and exit: immutable weights, your wallet holds the token, and redeem in kind always works. What it holds is your call, so read it first.',
    chips: ['Read a basket', 'Is it safe?'],
  },
  {
    m: /who holds (my|the) (money|funds|tokens|assets)|where (are|is) my (money|funds|assets)|do you (hold|custody|keep) (my|the)/,
    a: 'You do. Basket shares sit in your wallet like any ERC-20, the underlying sits in the basket contract, and no operator key can touch either. This chat only composes transactions; your wallet signs every one.',
    chips: ['What do I hold?', 'Is it safe?'],
  },
  {
    m: /(difference|different) between (a )?basket and (a )?bundle|basket vs bundle|bundle vs basket/,
    a: 'A basket is one ERC-20 holding a weighted mix on one chain. A bundle is a page that groups deployed baskets, across chains, into one buy flow. Basket = the asset, bundle = the storefront.',
    chips: ['What is a bundle?', 'What baskets are there?'],
  },
  {
    m: /version(ing|s)?\b|\bv2\b|next version|supersede|lineage/,
    a: 'A basket cannot be edited, so an update is a NEW basket recorded on chain as the old one\u2019s successor. The link is a signed record, not a migration of anyone\u2019s money: holders stay where they are until they choose to move, and they move IN KIND, redeeming the underlying and putting the shared assets straight back in. Both baskets keep trading meanwhile. Say \u201cnew version of $YOURTICKER\u201d and I carry its legs and weights across, deploy it, and record the link \u2014 all here.',
    chips: ['Help me create my own basket', 'How do I migrate?'],
  },
  {
    m: /change (the )?(weights?|mix|composition|allocation)|edit (my|the) basket|update (the )?(weights?|mix)|swap out a (token|leg)/,
    // the chip used to start a fresh UNLINKED basket, which is not what was
    // just explained; versioning now works right here, so it says so
    a: 'Weights are immutable after deploy: nobody, including the creator, can change the mix under holders. The honest path to a new mix is a fresh basket linked as the next version, and holders migrate if they agree. Say "new version of $YOURTICKER" and I carry its legs across, deploy it, and record the link.',
    chips: ['How does versioning work?', 'How do I exit?'],
  },
  {
    m: /how (do|can) i get usdc|need usdc|where.{0,12}buy usdc|get (the )?settlement (token|currency)|how (do|can) i get eth for gas|need (eth|gas money)/,
    a: 'Any major exchange sells it; withdraw to your wallet on the chain you are buying on. Already on another chain: bridge it over first. Once it lands, a buy here is one transaction.',
    chips: ['Buy a basket', 'What baskets are there?'],
  },
  {
    m: /site (goes|went|is) down|if (this|the) (site|page) (dies|disappears|vanishes)|you (shut|close) down|stops? existing/,
    a: 'Your assets do not care: baskets live on-chain, not on this site. The kit is open source, anyone can host another front end, agents can operate it over MCP, and redeem in kind works straight against the contract.',
    chips: ['Is it safe?', 'How do I exit?'],
  },
  {
    m: /sell (just )?(a )?(part|half|some|portion|bit)|partial(ly)? sell|not sell (it )?all/,
    a: 'Any amount: the sell card takes whatever slice you type, in dollars. The rest keeps riding.',
    chips: ['What do I hold?'],
  },
  {
    m: /prices? (live|real.?time|up to date|current)|how often (do|are) prices|refresh(ed)? prices|prices? update/,
    a: 'Every read here goes straight at the chain when you ask: NAV from the contracts, token prices from their own pools. No cached dashboard between you and it.',
    chips: ['Read a basket', 'Best performers in the last 24 hours?'],
  },
  {
    m: /(see|view|find|check) my (transactions|history|trades|activity)|transaction history|past (trades|buys|sells)/,
    a: 'Your wallet and the chain keep the record: every buy and sell is a normal transaction under your address on the explorer. For live holdings, ask right here.',
    chips: ['What do I hold?'],
  },
  {
    m: /discord|telegram|twitter|\bx account\b|community|socials|follow you|where.{0,12}(announce|updates)/,
    a: 'The software has no official channel: each deployment is run by its operator, so check this site’s footer for theirs. The code and the docs are public either way.',
    chips: ['Is this open source?', 'What is Spectrum?'],
  },
  {
    m: /no.?code|without (code|coding)|do i need to (code|program|know how to code)|not technical|for beginners/,
    a: 'No code anywhere: name the assets here, I stage the basket, your wallet signs the deploy. Reading, buying, and exiting work the same way, buttons and one signature each.',
    chips: ['Help me create my own basket', 'How easy is it to get started?'],
  },
  {
    m: /how long does (a |the )?(buy|purchase|trade) take|is buying instant|does it settle (fast|instantly)/,
    a: 'One transaction: it lands at chain speed, seconds on Base. The card shows the confirmation the moment the receipt is in.',
    chips: ['Buy a basket'],
  },

  // ── the beginner + edge round (owner 2026-08-20: keep catching questions) ──
  {
    m: /what (is|are) (a )?(crypto )?wallets?\b|do i need a wallet|i dont have a wallet/,
    a: 'A wallet is the app that holds your keys and signs transactions: MetaMask, Rabby, Coinbase Wallet, Rainbow all work here. Install one, fund it, hit Connect top right. Nothing here ever holds your keys for you.',
    chips: ['Which wallets work?', 'How easy is it to get started?'],
  },
  {
    m: /lose (my|your) (wallet|keys|seed|phrase)|lost my (wallet|seed|keys)|forgot my (seed|password|keys)|recover my (wallet|account)/,
    a: 'Self-custody is honest about this: your seed phrase IS the account. Lose it with no backup and nobody, including this site, can recover the wallet or the baskets in it. Keep the phrase offline, never type it into a website, and this site will never ask for it.',
    chips: ['Is it safe?', 'Which wallets work?'],
  },
  {
    m: /\bleverage\b|\bshort(ing)?\b|margin|futures|perps?\b|\b\d+x\b/,
    a: 'No leverage, no shorting, no perps: a basket is spot ownership of real tokens, long only. The most you can lose is what the holdings lose.',
    chips: ['What is a basket?', 'Can I lose money?'],
  },
  {
    m: /wen (moon|lambo)|when moon|to the moon|we pumping/,
    a: 'The chain does not do promises and neither do I. What I can give you is measured: who moved in the last 24 hours.',
    chips: ['Best performers in the last 24 hours?', 'What baskets are there?'],
  },
]

/** The bank answer, or null when no row matches. */
function bankAnswer(t: string, ctx: AgentContext): AgentReply | null {
  for (const row of QA_BANK) {
    if (!row.m.test(t)) continue
    const actions: AgentAction[] = []
    if (row.hero) actions.push(row.hero)
    if (row.steps) actions.push(row.steps)
    if (row.compare) actions.push(row.compare)
    if (row.a) actions.push({ kind: 'text', text: typeof row.a === 'function' ? row.a(ctx) : row.a })
    if (row.link) actions.push({ kind: 'link', href: row.link.href, label: row.link.label, text: row.link.text })
    if (actions.length === 0) continue
    return { actions, ctx, chips: row.chips ?? STEER }
  }
  return null
}

/** The active chain's draft bucket, migrating a restored old-shape draft. */
function bucketOf(ctx: AgentContext): { address: Address; symbol: string }[] {
  if (ctx.drafts?.[ctx.chainId]?.length) return ctx.drafts[ctx.chainId]
  if (ctx.draft?.picks.length && !ctx.drafts) return ctx.draft.picks
  return []
}
function anyBucket(ctx: AgentContext): boolean {
  if (ctx.draft?.picks.length) return true
  return Object.values(ctx.drafts ?? {}).some((p) => p.length > 0)
}

/** The bundle door. Baskets deployed in this chat open the IN-CHAT bundle card
 *  prefilled (owner 2026-08-20: end to end without leaving the chat); with
 *  nothing to prefill yet, the builder page link stands. */
/** Every draft leg across every chain bucket — the asset-picker card renders
 *  them as chosen tiles (old-shape single drafts count on the active chain). */
function pickedAcross(ctx: AgentContext): { chainId: number; address: Address; symbol: string }[] {
  const drafts = ctx.drafts ?? (ctx.draft?.picks.length ? { [ctx.chainId]: ctx.draft.picks } : {})
  return Object.entries(drafts).flatMap(([id, picks]) => picks.map((p) => ({ chainId: Number(id), address: p.address, symbol: p.symbol })))
}

/** The per-chain buckets of the running draft, for the crossDraft card. */
function draftBuckets(ctx: AgentContext): { chainId: number; picks: { address: Address; symbol: string }[] }[] {
  const drafts = ctx.drafts ?? (ctx.draft?.picks.length ? { [ctx.chainId]: ctx.draft.picks } : {})
  return Object.entries(drafts)
    .filter(([, p]) => p.length > 0)
    .map(([id, picks]) => ({ chainId: Number(id), picks }))
}

function bundleTail(ctx: AgentContext): AgentAction[] {
  // ALWAYS the in-chat card. BundleCard starts from nothing perfectly well (its
  // own search picks from every deployed basket), so the old empty-case link out
  // to /bundle/new was both unreachable from the single call site AND a way to
  // finish a money action off the chat if it ever became reachable.
  return [{ kind: 'bundle', legs: ctx.deployedBaskets ?? [] }]
}

// ── THE OPERATOR LLM SEAM (the filed next step; kit default = OFF). An
// operator may point VITE_AGENT_ENDPOINT at their own language brain. THE
// CONTRACT KEEPS MONEY DETERMINISTIC: the remote reply may only SPEAK
// (plain sentences), suggest CHIPS, and DELEGATE one message back into this
// regex machinery — it can never fabricate an action payload, so every
// trade, create, redeem, and migrate still flows through the same simulated,
// floor-protected paths as a typed message. Absent env, error, timeout, or
// a malformed reply = the regex brain answers exactly as today.
interface RemoteBrainReply {
  say?: string[]
  sendThrough?: string
  chips?: string[]
}
async function askRemoteBrain(text: string, ctx: AgentContext): Promise<RemoteBrainReply | null> {
  // read per call: Vite inlines this in browser builds; node hosts (the
  // driver, tests) can flip it live
  const endpoint = (import.meta.env.VITE_AGENT_ENDPOINT as string | undefined) ?? ''
  if (!endpoint) return null
  try {
    const res = await Promise.race([
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ctx-lite: the conversation shape, never account-identifying more
        // than the chain (the operator's own brain still never sees keys)
        body: JSON.stringify({
          v: 'specter-brain-1',
          text,
          chainId: ctx.chainId,
          draft: Object.fromEntries(Object.entries(ctx.drafts ?? {}).map(([k, v]) => [k, v.map((p) => p.symbol)])),
          lastBasket: ctx.lastBasket?.address ?? null,
        }),
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('brain timeout')), 6000)),
    ])
    if (!res.ok) return null
    const j = (await res.json()) as unknown
    if (j == null || typeof j !== 'object') return null
    const r = j as Record<string, unknown>
    const out: RemoteBrainReply = {}
    if (Array.isArray(r.say)) out.say = r.say.filter((x): x is string => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 600))
    if (typeof r.sendThrough === 'string' && r.sendThrough.trim()) out.sendThrough = r.sendThrough.trim().slice(0, 400)
    if (Array.isArray(r.chips)) out.chips = r.chips.filter((x): x is string => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 80))
    if (!out.say?.length && !out.sendThrough) return null
    return out
  } catch {
    return null // the regex brain is the always-on floor
  }
}

/** Stamp the turn's rail memory onto a reply: a rail THIS reply showed wins
 *  (fresh list, nothing picked yet); otherwise `keep` carries the previous
 *  rail forward with its picked index, so "no, the other one" can repair a
 *  pick next turn. The first chip doubles as the standing offer a spoken yes
 *  accepts. */
function withRailMemory(reply: AgentReply, keep?: { items: { label: string; send: string }[]; pickedIndex?: number } | null): AgentReply {
  let items: { label: string; send: string }[] | null = null
  for (const a of reply.actions) {
    if (a.kind === 'baskets') items = a.rows.map((r) => ({ label: r.symbol, send: `read $${r.symbol}` }))
    else if (a.kind === 'candidates') items = a.hits.map((h) => ({ label: h.symbol, send: `use ${h.address} for ${a.ticker}` }))
    else if (a.kind === 'positions') items = a.rows.map((r) => ({ label: r.symbol, send: `sell $${r.symbol}` }))
    else if (a.kind === 'movers' && a.baskets.length) items = a.baskets.map((b) => ({ label: b.symbol, send: `read $${b.symbol}` }))
  }
  reply.ctx = { ...reply.ctx, lastList: items ? { items } : (keep ?? null), lastOffer: reply.chips?.[0] ?? null }
  return reply
}

export async function handle(rawText: string, ctxIn: AgentContext): Promise<AgentReply> {
  const raw = rawText.trim().slice(0, 400)
  const norm = normalize(raw)
  // an ordinal answers the last rail ("the first one" after a list) — resolve
  // it to that card's own action line, once (no recursion past one hop). The
  // rail rides along with the picked index remembered, so "no, the other one"
  // can repair the pick next turn.
  const ord = ordinalOf(norm)
  if (ord != null && ctxIn.lastList?.items.length) {
    const items = ctxIn.lastList.items
    const idx = ord === -1 ? items.length - 1 : ord
    const item = items[idx]
    if (item) return withRailMemory(await handleInner(item.send, { ...ctxIn, lastList: null }), { items, pickedIndex: idx })
  }
  // "no, the other one" corrects the last rail pick: on a two-item rail it is
  // the item NOT picked, on a longer rail the next one down. With no pick on
  // record it asks by name instead of guessing.
  if (OTHER_ONE_RE.test(norm) && ctxIn.lastList?.items.length) {
    const { items, pickedIndex } = ctxIn.lastList
    if (pickedIndex != null && items.length >= 2 && items[pickedIndex]) {
      const idx = items.length === 2 ? 1 - pickedIndex : (pickedIndex + 1) % items.length
      const item = items[idx]
      if (item) return withRailMemory(await handleInner(item.send, { ...ctxIn, lastList: null }), { items, pickedIndex: idx })
    }
    return {
      actions: [{ kind: 'text', text: `Which one do you mean? Name it or tap it: ${items.map((i) => i.label).join(' · ')}.` }],
      ctx: { ...ctxIn, lastOffer: null },
      // the chip must SEND what the ordinal path sends. These carried i.label —
      // a bare symbol — so after a holdings read (whose items are sells) TAPPING
      // resolved to a read while "the other one" resolved to a sell: one rail,
      // two different money outcomes depending how you answered it. Sending
      // i.send makes them the same, and makes the chip say what it will do.
      chips: items.slice(0, 6).map((i) => i.send),
    }
  }
  // a spoken YES answers the standing offer (the reply's primary suggestion) —
  // same one-hop rule as ordinals. Bare "ok"/"k" stays a soft ack, not a
  // trigger: people type it as punctuation, not consent.
  const affirmation = /^(yes|yeah|yep|yup|sure|do it|go ahead|lets do it|lets go|sounds good|please do|why not|go for it)( please| now)?$/.test(norm)
  if (affirmation && ctxIn.lastOffer) return withRailMemory(await handleInner(ctxIn.lastOffer, { ...ctxIn, lastOffer: null }))
  if (affirmation)
    return {
      actions: [{ kind: 'text', text: 'To what? Tap a suggestion or name it.' }],
      ctx: ctxIn,
      chips: ['What baskets are there?', 'Best performers in the last 24 hours?', 'Help me create my own basket'],
    }
  // the operator brain gets one look (absent/failed = zero cost): it may
  // speak and/or delegate ONE message through the deterministic machinery
  const remote = await askRemoteBrain(raw, ctxIn)
  if (remote) {
    const said: AgentAction[] = (remote.say ?? []).map((x) => ({ kind: 'text', text: clampChainText(x).slice(0, 600) }))
    if (remote.sendThrough) {
      const inner = await handleInner(remote.sendThrough, ctxIn)
      inner.actions = [...said, ...inner.actions]
      if (remote.chips?.length) inner.chips = remote.chips
      return withRailMemory(inner)
    }
    return { actions: said, ctx: ctxIn, chips: remote.chips, ...(remote.chips?.length ? {} : {}) }
  }
  const reply = await handleInner(raw, ctxIn)
  // a message that IS one of the rail's own items (a chip tap, or its label
  // typed out) counts as a pick: remember the index so "the other one" works
  const rl = raw.toLowerCase()
  const pickedIdx = ctxIn.lastList?.items.findIndex((i) => i.send.toLowerCase() === rl || i.label.toLowerCase() === rl) ?? -1
  // the rail this turn showed (or the kept one) + the first chip as the
  // standing offer, so ordinals and a spoken yes work next turn
  return withRailMemory(reply, pickedIdx >= 0 && ctxIn.lastList ? { items: ctxIn.lastList.items, pickedIndex: pickedIdx } : null)
}

async function handleInner(rawText: string, ctxIn: AgentContext, depth = 0): Promise<AgentReply> {
  // bound the work a single message can cause: 400 chars is a sentence with
  // twelve addresses in it, not a payload
  const text = rawText.trim().slice(0, 400)
  const t = translateOperational(normalize(text))
  const core = coreOf(t)
  const inlineWeights = parseInlineWeights(text)
  const ctx: AgentContext = { ...ctxIn, chainId: wantChainId(t, ctxIn.chainId) }
  const say = (s: string): AgentAction => ({ kind: 'text', text: s })

  // a question-shaped message never routes to an operational verb: "which
  // basket should i buy" is a QUESTION for the bank, not a buy order (the
  // conversation driver caught six of these steals, 2026-08-19)
  const interrogative = /^(what|whats|why|which|when|where|who|is|are|does|do|can|could|should|will|how)\b/.test(t)

  try {
    // ── a candidate pick answers the create flow ("use 0x… for VVV") ────────
    const pickMatch = /^use (0x[0-9a-fA-F]{40}) for (\S+)/i.exec(text)
    if (pickMatch && ctx.pending?.intent === 'create') {
      const picked = { address: pickMatch[1] as Address, symbol: pickMatch[2].replace(/^\$/, '').toUpperCase() }
      const queue = (ctx.pending.queue ?? []).slice(1) // the picked ticker was the queue head
      return continueCreate({ ...ctx, pending: null }, [picked], queue)
    }

    // ── "nevermind" / "cancel": being waved off is a conversation move, not a
    // fallback case. Pending questions drop; a draft PARKS, never wipes. ─────
    if (/^(nevermind|never mind|forget (it|that)|cancel( that| it)?|nah|no thanks|nope|not now|stop|leave it)$/.test(t)) {
      const had = ctx.pending != null || anyBucket(ctx)
      return {
        actions: [say(had ? 'Dropped. Your draft stays parked if you had one; say start over to wipe it.' : 'All good. Anything else?')],
        ctx: { ...ctx, pending: null },
        chips: STEER,
      }
    }

    // ── REPAIR ACKNOWLEDGMENT ("thats wrong", "no thats not right", "wrong
    // basket"): being corrected is a conversation move — own the miss and ask
    // for a plainer handle, never shrug. Whole-message only (anchored on the
    // core), so "thats wrong, sell half" still routes the sell below. Drafts
    // stay intact; the open question and the standing offer drop.
    if (REPAIR_RE.test(core)) {
      return {
        actions: [say('My read was off. Say it plainer for me: a ticker, a contract address, or tap a suggestion.')],
        ctx: { ...ctx, pending: null, lastOffer: null },
        chips: ['What baskets are there?', 'Help me create my own basket', 'What can I do here'],
      }
    }

    // ── COMPOUND SEQUENCES ("read svi then buy $25 of it"): one message, two
    // clauses, run in order. Clause one is a look (read/open/check/look at,
    // two tokens minimum), clause two LEADS with an operational verb — that
    // requirement keeps plain noun lists ("vvv and aero") whole. Clause one's
    // ctx threads into clause two, so "it" means the thing just read. Exactly
    // two clauses, question-shaped messages never split, and the depth guard
    // stops any nesting.
    if (depth === 0 && !interrogative) {
      const seq = /^((?:read|open|check|look at) .+?) (?:and then|then|and) ((?:buy|sell|open|share|watch|redeem) .+)$/.exec(core)
      if (seq) {
        const first = await handleInner(seq[1], ctxIn, depth + 1)
        const second = await handleInner(seq[2], first.ctx, depth + 1)
        return {
          actions: [...first.actions, ...second.actions],
          ctx: second.ctx,
          chips: second.chips ?? first.chips,
          celebrate: first.celebrate === true || second.celebrate === true,
        }
      }
    }

    // ── "and on robinhood?" — a chain reference with nothing else re-runs the
    // last list-shaped answer there; with nothing to re-run it just switches.
    // A live draft keeps its own meaning for chain words (bucket switching). ─
    if (ctx.chainId !== ctxIn.chainId && !anyBucket(ctx) && ctx.pending?.intent !== 'create') {
      const residue = stripChainWords(t.split(' ')).filter((w) => !/^(and|what|about|there|how|now|then|also|too|same|ones?|it)$/.test(w))
      if (residue.length === 0) {
        if (ctx.lastIntent?.kind === 'movers') return { actions: [await moversFor(ctx.chainId, ctx.lastIntent.window ?? '24h')], ctx }
        if (ctx.lastIntent?.kind === 'baskets') {
          const list = await cachedList(ctx.chainId)
          if (list.length === 0) return { actions: [say(`The factory on ${chainName(ctx.chainId)} answered empty. No baskets there yet.`)], ctx }
          return { actions: [{ kind: 'baskets', chainId: ctx.chainId, rows: list.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) }], ctx }
        }
        return { actions: [say(`Switched to ${chainName(ctx.chainId)}. Everything I do now reads there.`)], ctx, chips: STEER }
      }
    }

    // an armed slot or live draft yields to any strong other intent BEFORE the
    // asset heuristics can eat the message (the driver's worst find: "what
    // baskets are there" became ticker lookups for the word "what")
    const STRONG_OTHER_EARLY =
      /best perform|top perform|gainers|movers|winners|trending|what do i|holdings|positions|portfolio|balance|what baskets|list baskets|show baskets|how do|how does|what is|what are|\bhelp\b|read \$|\bbuy\b|\bsell\b|get me out|get out|redeem|referral|share|which chains|how many/
    if ((ctx.pending?.intent === 'create' || anyBucket(ctx)) && (interrogative || STRONG_OTHER_EARLY.test(t))) {
      if (ctx.pending?.intent === 'create') ctx.pending = null
      // the draft itself survives: questions pause building, never destroy it
    }

    // ── "show my draft" — the draft pill's door and a spoken re-open: the
    // compose card comes back with nothing added ─────────────────────────────
    // FINALIZE (owner 2026-08-21): the crossDraft's building view shows only the
    // assets + weights; pressing "Finalize basket" is what reveals WHAT GETS
    // MADE WHERE and moves to deploying. A single-chain draft finalizes straight
    // to its compose/deploy card; a multi-chain draft shows the per-chain
    // breakdown (crossDraft finalized mode) whose card carries ONE launch flow.
    // No per-chain chips here, deliberately (owner, same day: "there should
    // never be a time where a user has multiple options") — a rail of "Deploy
    // on <chain>" chips is that state wearing a different hat. Saying it still
    // works; it is just never offered as a set of choices.
    // the trailing "40% AAVE 30% CRV" the canvas speaks is optional — a bare
    // "finalize basket" typed by a person still matches exactly as before
    if (/^finali[sz]e( (my|the))?( basket| bundle| it)?( \d{1,2}% ?[a-z0-9$ %]+)?$|^finali[sz]e$/.test(core)) {
      if (!anyBucket(ctx)) return { actions: [say('Nothing to finalize yet. Name a couple of assets and a draft starts.')], ctx, chips: STEER }
      const rawBuckets = draftBuckets(ctx)
      // THE CANVAS WEIGHTS NOW BIND (owner 2026-08-21: they were cosmetic).
      // They arrive on the spoken channel as bySym, and each chain becomes its
      // OWN basket, so the shares are renormalised PER CHAIN — a leg that was
      // 30% of the whole bundle is a different share of its own chain's basket.
      // Any chain whose legs are not all named falls back to the equal split
      // rather than deploying a half-read vector.
      const spoken = parseInlineWeights(text)
      const buckets = rawBuckets.map((b) => {
        if (!spoken) return b
        const named: number[] = []
        for (const p of b.picks) {
          const n = spoken.bySym?.[p.symbol.toUpperCase()]
          if (typeof n !== 'number' || n <= 0) return b
          named.push(n)
        }
        const total = named.reduce((a, n) => a + n, 0)
        if (total <= 0) return b
        const w = named.map((n) => Math.max(1, Math.round((n / total) * 100)))
        const drift = 100 - w.reduce((a, x) => a + x, 0)
        if (drift !== 0) {
          let mi = 0
          for (let i = 1; i < w.length; i++) if (w[i] > w[mi]) mi = i
          w[mi] = Math.max(1, w[mi] + drift)
        }
        return { ...b, weights: w }
      })
      const liveChains = buckets.filter((b) => b.picks.length > 0).length
      if (liveChains >= 2) {
        return {
          actions: [
            say('Here is what gets made where. One button below does the whole thing: every chain launched, seeded, then wrapped into one bundle you can share.'),
            { kind: 'crossDraft', buckets, deployed: ctx.deployedBaskets ?? [], mode: 'finalized' },
          ],
          ctx: { ...ctx, pending: { intent: 'create' } },
          chips: ['Add another asset', 'What does it cost to launch?', 'Start over'],
        }
      }
      // one chain: straight to the real compose + deploy card (allowSingle so a
      // one-token basket composes rather than nagging for a second)
      return continueCreate({ ...ctx, pending: null }, [], [], undefined, true)
    }
    // DEPLOY <chain> — the SPOKEN path, kept for anyone who asks for one chain
    // by name. It is no longer offered as a button or a chip anywhere (the
    // finalized card's one flow replaced that); a capability you can ask for is
    // not the same thing as an option put in front of you. allowSingle: a
    // 1-token chain-basket in a multichain bundle is valid and must be able to
    // deploy. Guarded to a draft so a bare "deploy" with nothing building falls
    // through to the bank.
    if (/^deploy( (my|the|this|it))?( basket| bundle)?( on [a-z ]{2,12})?$|^deploy$/.test(core) && anyBucket(ctx)) {
      return continueCreate({ ...ctx, pending: null }, [], [], undefined, true)
    }
    // a chain tail rides fine ("show my draft on base" — the crossDraft card's
    // per-chain door speaks exactly this; wantChainId already routed it)
    if (/^(show|open|view)( me)?( my| the)? draft( on [a-z ]{2,12})?$|^my draft$|^whats in my draft$/.test(core)) {
      if (!anyBucket(ctx)) return { actions: [say('No draft yet. Name assets any time and one starts.')], ctx, chips: STEER }
      return continueCreate({ ...ctx, pending: null }, [], [])
    }

    // ── draft edits: add / remove / start over (the running basket memory) ──
    if (anyBucket(ctx) || /\badd(ing)?\b/.test(t) || /\b(start over|clear|reset)\b/.test(t)) {
      if (/\b(start over|clear|reset)\b/.test(t) && !anyBucket(ctx))
        return { actions: [say('Nothing in progress. Name assets any time and a fresh basket starts.')], ctx: { ...ctx, pending: null }, chips: STEER }
      if (/\b(start over|clear (the )?(basket|draft)|reset (the )?(basket|draft))\b/.test(t)) {
        if (anyBucket(ctx)) return { actions: [say('All drafts cleared, every chain. Name assets whenever you want a fresh one.')], ctx: { ...ctx, draft: null, drafts: null, pending: null } }
      }
      const rm = /\bremove\b\s+\$?([A-Za-z0-9]{2,12})/i.exec(text)
      const bucket = bucketOf(ctx)
      // "undo" / "scratch that" pops the LAST pick from this chain's draft —
      // the spoken twin of the remove verb (QoL round 2026-08-20)
      if (/^(undo|scratch that|remove the last( one| asset)?|drop the last( one)?)$/.test(core) && bucket.length) {
        const dropped = bucket[bucket.length - 1]
        const kept = bucket.slice(0, -1)
        const drafts = { ...(ctx.drafts ?? {}) }
        delete drafts[ctx.chainId]
        if (kept.length === 0)
          return {
            actions: [say(`$${dropped.symbol} dropped. This chain's draft is empty again; name assets whenever.`)],
            ctx: { ...ctx, draft: null, drafts: Object.values(drafts).some((p) => p.length) ? drafts : null, pending: { intent: 'create' } },
          }
        return continueCreate({ ...ctx, draft: null, drafts, pending: null }, kept, [])
      }
      if (rm && bucket.length) {
        const sym = rm[1].toUpperCase()
        const kept = bucket.filter((p) => p.symbol.toUpperCase() !== sym)
        if (kept.length === bucket.length) return { actions: [say(`$${sym} is not in this chain’s draft (${bucket.map((p) => `$${p.symbol}`).join(' · ')}).`)], ctx }
        const drafts = { ...(ctx.drafts ?? {}) }
        delete drafts[ctx.chainId]
        return continueCreate({ ...ctx, draft: null, drafts, pending: null }, kept, [])
      }
      // a message that is ONLY asset-shaped tokens extends a live draft or an
      // armed create slot with no verb needed ("PEPE", "0x… 0x…", "vvv aero")
      if ((anyBucket(ctx) || ctx.pending?.intent === 'create') && !interrogative) {
        const rawToks = text.split(/\s+/).filter(Boolean)
        const toks = t.split(' ').filter(Boolean)
        const noise = new Set(['and', 'also', 'plus', 'add', 'with', 'then', 'ok', 'okay', 'yes', 'yeah', 'sure', 'basket', 'draft', 'it', 'them', 'my', 'the', 'to'])
        const kept = toks.filter((w) => !noise.has(w))
        // a token counts as an ASSET only when it announces itself: an address,
        // a $tick, ALL-CAPS in the raw text, or a short non-word in a tiny
        // message — plain sentences must never become ticker lookups
        const looksAsset = (w: string, i: number): boolean => {
          if (/^0x[0-9a-f]{40}$/.test(w)) return true
          if (w.startsWith('$')) return /^\$[a-z][a-z0-9]{1,11}$/.test(w)
          const raw = rawToks.find((r) => r.toLowerCase().replace(/[^a-z0-9$x]/g, '') === w) ?? rawToks[i] ?? ''
          // ONLY self-announcing tokens: the lowercase fallback turned the word
          // "sell" into a live ticker lookup (owner 23:02)
          return /^[A-Z0-9]{2,11}$/.test(raw.replace(/[^A-Za-z0-9]/g, ''))
        }
        const keptClean = stripChainWords(kept)
        const assetish = keptClean.length > 0 && keptClean.length <= 12 && keptClean.every((w, i) => looksAsset(w, i))
        if (assetish) {
          const addrs2 = keptClean.filter((w) => /^0x[0-9a-f]{40}$/.test(w)) as Address[]
          const syms2 = keptClean.filter((w) => !/^0x/.test(w)).map((w) => w.replace(/^\$/, ''))
          return continueCreate({ ...ctx, pending: null }, addrs2.map((a) => ({ address: a, symbol: a.slice(0, 8) })), syms2, inlineWeights)
        }
        // "cashcat on robinhood" (owner 23:1x, the buckets design case): an
        // explicit "on <chain>" — or a bare chain name — while a draft is
        // building IS the announcement, so the residue harvests as tickers
        // even lowercase. An empty residue is a deliberate bucket switch (the
        // cross-chain steps instruct exactly that message).
        const onChain =
          /\bon\s+(base|robinhood|robinhod|robin hood|rh|ethereum|etherium|mainnet|eth)\b/.test(t) ||
          /^(base|robinhood|robinhod|rh|ethereum|etherium|mainnet)$/.test(t)
        if (onChain && keptClean.length <= 12 && keptClean.every((w) => /^[a-z][a-z0-9]{1,11}$/.test(w) && !COMMON.has(w)))
          return continueCreate({ ...ctx, pending: null }, [], keptClean)
      }
      // THE ADD LANE (owner 2026-08-20: "add pons must just detect pons and
      // add to a basket"). A filler-stripped message that LEADS with add, or
      // any add naming the basket, harvests what follows: cold or mid-draft,
      // lowercase included — the verb is the announcement. "can you add pons"
      // is a request (frame + verb + concrete asset), not a question; an add
      // with NOTHING concrete left stays a question and falls through to the
      // bank ("can you add my token" = the listing-policy row).
      const addLead = /^add(ing)?\b/.test(core) || (/\badd\b/.test(t) && /\b(basket|draft|to it|to mine|to that)\b/.test(t + (anyBucket(ctx) ? ' basket' : '')))
      if (addLead) {
        const symbols = [...text.matchAll(new RegExp(TICKER.source, 'g'))].map((m) => m[1])
        const addrs = [...text.matchAll(new RegExp(ADDR.source, 'g'))].map((m) => m[0] as Address)
        if (symbols.length === 0 && addrs.length === 0) {
          // bare words after "add": "add vvv and aero to my basket", "add pons"
          let tail = /\badd(?:ing)?\b(.+?)(?:\bto\b|$)/i.exec(text)?.[1] ?? ''
          // the chain tail is ROUTING, already consumed by wantChainId — left
          // in place it glues to the last asset ("add vvv and aero on base"
          // made "aero on base" fail the ticker shape and the asset silently
          // vanished; live find 2026-08-21). "then" chains adds ("add vvv then
          // add aero"), so it splits too and each piece sheds its own add-verb.
          tail = tail.replace(/\bon\s+(base|robinhood|robinhod|robin hood|rh|ethereum|etherium|mainnet|eth)\b[\s\S]*$/i, '')
          for (const w of tail.split(/,|\band\b|\bthen\b|\+|\//)) {
            const c = w.trim().replace(/^add(?:ing)?\s+/i, '').replace(/^\$/, '').toLowerCase()
            if (!/^[a-z][a-z0-9]{1,11}$/.test(c)) continue
            if (COMMON.has(c) || GENERIC_NOUNS.has(c) || CHAIN_WORDS.has(c) || ADD_NOISE.has(c)) continue
            symbols.push(c)
          }
        }
        // CAP AT 12 before the settle loop (audit 2026-08-21): continueCreate
        // runs one cross-chain token search PER item, and this lane was the one
        // create path that did not clamp — "add $a0 $a1 … $a94" fanned out ~476
        // upstream calls from a single message (a basket holds 2-12 legs; the
        // rest is abuse). Every other create entry already slices to 12.
        const addrs12 = addrs.slice(0, 12)
        const cleanSyms = stripChainWords(symbols).slice(0, Math.max(0, 12 - addrs12.length))
        if (cleanSyms.length > 0 || addrs12.length > 0)
          return continueCreate({ ...ctx, pending: null }, addrs12.map((a) => ({ address: a, symbol: a.slice(0, 8) })), cleanSyms, inlineWeights)
        // add-intent with nothing concrete: a bare "add another" asks and arms
        // the slot; a question-shaped one falls through to the bank instead
        if (!interrogative)
          return {
            actions: [{ kind: 'assetPicker', text: 'Which asset? Tap a tile, search any network, or paste a contract address.', picked: pickedAcross(ctx) }],
            ctx: { ...ctx, pending: { intent: 'create' } },
          }
      }
    }

    // ── pending slot answers first (the agent asked, the user answered) ─────
    if (ctx.pending && ctx.pending.intent !== 'create') {
      const pendingSlot = ctx.pending as { intent: 'buy' | 'sell' | 'read'; amountUsd?: number | null; basket?: { address: Address; symbol: string } }
      // the agent asked HOW MUCH — a dollar figure (or "$100" chip, or "fifty
      // bucks", or a bare number) completes the trade
      if (pendingSlot.basket && pendingSlot.intent !== 'read') {
        const m0 = text.match(AMOUNT)
        const bare = /^\$?[\d,]+(\.\d+)?$/.test(core) ? amtNum(core.replace('$', '')) : null
        const amt = m0 ? amtNum(m0[1] ?? m0[2]) : (wordAmount(t) ?? bare)
        if (amt != null && amt > 0) {
          const data = await cachedBasket(pendingSlot.basket.address, ctx.chainId)
          if (!data) return { actions: [say(`That basket did not read on ${chainName(ctx.chainId)}.`)], ctx: { ...ctx, pending: null } }
          ctx.pending = null
          ctx.lastBasket = { address: pendingSlot.basket.address, chainId: ctx.chainId }
          ctx.lastTrade = { side: pendingSlot.intent, address: pendingSlot.basket.address, chainId: ctx.chainId }
          return { actions: [{ kind: 'trade', chainId: ctx.chainId, side: pendingSlot.intent, basket: data, amountUsd: amt }], ctx, celebrate: true }
        }
        // not an amount — fall through as a fresh message (the slot releases)
        ctx.pending = null
      } else {
        const found = await findBasket(ctx.chainId, text)
        if (found) {
          const { intent, amountUsd } = pendingSlot
          ctx.pending = null
          ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
          if (intent === 'read') return { actions: [await readBasketAction(ctx.chainId, found.address)], ctx }
          // basket answered but the BUY still has no amount → ask it (the
          // same no-default law as the direct path)
          if (intent === 'buy' && amountUsd == null)
            return {
              actions: [say(`How much would you like to put into $${found.symbol || 'it'}? Name a dollar amount.`)],
              ctx: { ...ctx, pending: { intent: 'buy', basket: { address: found.address, symbol: found.symbol || 'it' } } },
              chips: ['$25', '$100', '$500'],
            }
          const data = await cachedBasket(found.address, ctx.chainId)
          if (!data) return { actions: [say(`That basket did not read on ${chainName(ctx.chainId)}.`)], ctx }
          ctx.lastTrade = { side: intent, address: found.address, chainId: ctx.chainId }
          return { actions: [{ kind: 'trade', chainId: ctx.chainId, side: intent, basket: data, amountUsd: amountUsd ?? null }], ctx, celebrate: true }
        }
        ctx.pending = null // fall through: treat as a fresh message
      }
    }

    // ── help / greeting (but "help me create…" is the guided flow below) ────
    if (
      (/^(hi|hey|hello|hiya|howdy)\b/.test(t) || hasWord(t, ['help', 'commands']) || hasPhrase(t, ['what can you do', 'what do you do', 'who are you']) || ORIENT.test(core)) &&
      !hasWord(t, ['create', 'make', 'build'])
    ) {
      return orientationReply(ctx, `I operate baskets across Ethereum, Base and Robinhood from this chat, and the whole site works from right here. The map:`)
    }

    // ── THE SHOWCASE ANSWERS (owner 2026-08-19 22:1x: first-touch visitors
    // land here with zero knowledge — these four pitch the product beautifully
    // and end at an action; facts only, no promises) ─────────────────────────
    if (hasPhrase(t, ['what is a basket', 'what are baskets', 'what are basket tokens', 'explain baskets to me'])) {
      return {
        actions: [
          {
            kind: 'hero',
            art: 'violet',
            title: 'One token. A whole portfolio.',
            lines: [
              'A basket is one ERC-20 holding a weighted mix of assets',
              'Buy it in one transaction, the proportions handled for you',
              'Immutable after deploy: nobody can change the mix under you',
              'Exit any time, even in-kind straight to the underlying tokens',
            ],
            foot: 'Non-custodial, open source, live on three chains.',
            cta: { label: 'Make your own', send: 'Help me create my own basket' },
          },
        ],
        ctx,
        chips: ['Show me what is live', 'Why baskets beat buying coins?', 'Help me create my own basket'],
      }
    }
    if (hasPhrase(t, ['why baskets', 'baskets beat', 'why use baskets', 'benefits of baskets', 'why is this better'])) {
      return {
        actions: [
          {
            kind: 'hero',
            art: 'teal',
            title: 'Why a basket beats N tabs of coins',
            lines: [
              'One buy instead of N swaps, N approvals, N gas bills',
              'One token to hold, price, and sell, the mix stays true to its weights',
              'Floors from live simulation on every trade, the chain reverts under them',
              'The in-kind exit works even when a single market dies',
            ],
            foot: 'The whole mix, one line in your wallet.',
            cta: { label: 'Make your own', send: 'Help me create my own basket' },
          },
        ],
        ctx,
        chips: ['Show me what is live', 'Best performers in the last 24 hours?', 'Buy a basket'],
      }
    }
    // ── the CREATOR SYSTEM explainer (numbers from the contract's own doc) ──
    if (/how (do|does) (the )?creator (fees?|system|earnings?) work|creator fee (split|structure)|^how do creator fees work\??$/.test(t)) {
      return {
        actions: [
          say('Every basket charges its own fee on pooled buys and sells: the rate is set at deploy (1% floor) and immutable after. The split, in order:'),
          {
            kind: 'steps',
            title: 'Where each fee goes',
            steps: [
              { text: '25% burns PRISM: the protocol\u2019s share, burned on-chain' },
              { text: 'About 5% each to the interface and the launcher that brought the trade' },
              { text: 'Up to 30% of the remainder to YOU, the creator: your share and payout address are locked at deploy' },
              { text: 'The rest accrues to holders (claimFees, pull-claimed)' },
            ],
            foot: 'Accruals sit on the contract until flushed. Nothing routes through this site.',
          },
          { kind: 'link', href: '/flush', label: 'The flush console', text: 'Every accrual on chain, and the permissionless crank. Ask "what fees am I earning?" to claim yours right here.' },
        ],
        ctx,
        chips: ['What fees am I earning?', 'Help me create my own basket', 'Earn as a creator'],
      }
    }

    if (hasPhrase(t, ['earn as a creator', 'creator fee', 'how do creators earn', 'can i earn', 'make money creating'])) {
      return {
        actions: [
          {
            kind: 'hero',
            art: 'amber',
            title: 'Publish an idea. The contract pays you.',
            lines: [
              'Set a creator share of the basket fee at deploy, up to 30% of it',
              'The contract itself pays it on every trade, forever, to your address',
              'No listing process, no permission, no middleman holding your cut',
              'Your basket page, thesis and share link come with it',
            ],
            foot: 'Locked at deploy, on-chain, verifiable by anyone.',
          },
        ],
        ctx,
        chips: ['Help me create my own basket', 'What baskets are there?'],
      }
    }
    if (hasPhrase(t, ['how easy', 'get started', 'getting started', 'how do i start', 'start from zero', 'show me how'])) {
      return {
        actions: [
          {
            kind: 'hero',
            art: 'rainbow',
            title: 'From zero to your first basket, right here',
            lines: [
              'Say "what baskets are there" and swipe the live list',
              'Say "buy $25 of" any of them: the trade card appears, your wallet signs',
              'Say two tickers and the basket builder pops with live weights',
              'Deploy without leaving this chat, then the first buy seeds it',
            ],
            foot: 'Everything signs in YOUR wallet. This chat holds no keys.',
          },
        ],
        ctx,
        chips: ['What baskets are there?', 'Help me create my own basket'],
      }
    }
    if (hasPhrase(t, ['show me what is live', 'show me whats live', 'what is live'])) {
      const list = await cachedList(ctx.chainId)
      return {
        actions: [{ kind: 'baskets', chainId: ctx.chainId, rows: list.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) }],
        ctx,
        chips: ['Best performers in the last 24 hours?', 'Help me create my own basket'],
      }
    }

    // ── the QUESTION layer: what/how answers, honest and short ──────────────
    // These run BEFORE the trade intents so "how do I buy?" explains rather
    // than asking which basket to buy.
    if (/what (is|are) (a |an )?baskets?\b/.test(t) || hasPhrase(t, ['how does this work', 'how does it work', 'how does spectrum work', 'how does the site work', 'what is this', 'explain this', 'explain baskets'])) {
      return {
        actions: [
          say(
            'A basket is one ERC-20 token holding a weighted set of assets. Buy the basket, you own the whole mix. Sell it, you get settlement back. Redeem in kind, you receive every constituent directly. Baskets are immutable once deployed (no one can change the mix under you), non-custodial, and anyone can create one.',
          ),
          { kind: 'link', href: '/learn', label: 'Read the full explainer', text: 'The Learn page covers pricing, fees, risks, and how creation works.' },
        ],
        ctx,
        chips: ['Help me create my own basket', 'What baskets are there?', 'How do fees work?'],
      }
    }
    if ((/how (do|does) (the )?fees? work|what (is|are) the fees?|whats the fees?\b/.test(t) || hasPhrase(t, ['fee structure', 'how much does it cost', 'what does it cost', 'any fees', 'the fees'])) && !/deploy|launch|create/.test(t)) {
      return {
        actions: [
          say(
            'Each basket sets its own fee in basis points at deploy time (the contract floors it at 1%). The fee is charged by the contract itself when you buy or sell through the pool, never by this chat, and part of it can pay the basket creator. The unconditional exit (redeem in kind) touches no pool. Read any basket here and I show you its numbers.',
          ),
        ],
        ctx,
        chips: ['Read a basket', 'What baskets are there?', 'Help me create my own basket'],
      }
    }
    if (/what('s| is) nav\b|net asset value|how (is|are) (it|baskets?) priced|how do you price/.test(t)) {
      return {
        actions: [
          say(
            'NAV is the value of everything a basket holds, divided by its supply. It is read from the chain, not from a chart, and when I show a NAV I show its provenance too (fully on-chain vs partially priced). Execution differs from NAV by the basket fee and the constituents’ own market impact.',
          ),
        ],
        ctx,
        chips: ['Read a basket', 'Best performers in the last 24 hours?'],
      }
    }
    if (/\bis (this|it) safe\b|\bcustody\b|hold my (keys|funds|money)|\brug\b|can i trust/.test(t)) {
      return {
        actions: [
          say(
            'Non-custodial, end to end: nothing here holds your assets or keys. Every action I compose returns a transaction YOUR wallet signs, with the protective floor derived from a live simulation. Baskets are immutable after deploy and the in-kind exit always stands. The honest caveat: anyone can deploy a basket, including bad ones. A listing is not an endorsement, so read what it holds before buying.',
          ),
          { kind: 'link', href: '/risk', label: 'Risk disclosure', text: 'The full risk page, plainly worded.' },
        ],
        ctx,
        chips: ['Read a basket', 'What baskets are there?'],
      }
    }
    if (/which chains|what chains|supported chains|what networks/.test(t)) {
      return {
        actions: [say(`This deployment runs on: ${SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id]?.name ?? id).join(' · ')}. Say a chain name in any message ("on Base") and I switch to it.`)],
        ctx,
        chips: SUPPORTED_CHAIN_IDS.slice(0, 3).map((id) => `What baskets are there on ${CHAINS[id]?.name ?? id}?`),
      }
    }
    if (/how (do|can) i (buy|sell)\b|how does (buying|selling) work/.test(t)) {
      return {
        actions: [
          say(
            'Name the basket and the size, like "buy $25 of SVI", and I put the live trade card right here in the chat: floor pre-simulated, your wallet signs. Selling is the same with "sell". If you don’t know what exists yet, ask "what baskets are there?" first.',
          ),
        ],
        ctx,
        chips: ['What baskets are there?', 'Best performers in the last 24 hours?'],
      }
    }
    if (/how (do|can) i (migrate|switch|swap baskets|move (from|between))/.test(t)) {
      return {
        actions: [
          say(
            'A migration moves you IN KIND: you redeem the underlying tokens, and whatever the two baskets share goes straight back in without touching a DEX. Two to four signatures, all yours, all here. Say "migrate $OLD into $NEW" and the card does the whole move.',
          ),
        ],
        ctx,
        chips: ['What do I hold?'],
      }
    }

    // ── the guided create (owner: "help me create my own basket" end-to-end;
    // the ask went VISUAL 2026-08-20: the create page's own picker in-card) ──
    if (/\bhelp me\b.*\b(create|make|build)\b|\b(create|make|build)\b.*\bmy own\b|\bmy own basket\b/.test(t) && !TICKER.test(text) && !ADDR.test(text)) {
      return {
        actions: [
          {
            kind: 'assetPicker',
            text: 'Drop 2 to 12 assets. Tap tiles, search any network, or type tickers; I keep collecting. Weights and deploy happen right here.',
            picked: pickedAcross(ctx),
          },
        ],
        ctx: { ...ctx, pending: { intent: 'create' } },
        chips: ['VVV and AERO', 'Best performers in the last 24 hours?'],
      }
    }

    // ── the bundle flow, END TO END IN CHAT (owner 2026-08-20: "create a
    // bundle end to end from that chat without ever having to leave"). The
    // card wraps deployed baskets (or any picked here) and publishes with one
    // signature through the forge's own hook. ────────────────────────────────
    if (
      !interrogative &&
      (/\b(make|create|build|start|new)\b.*\bbundle\b/.test(t) ||
        /\bbundle (them|these|those|it|up|everything|my baskets?)\b/.test(t) ||
        /\bwrap (these|those|them|it)\b/.test(t) ||
        /^bundle$/.test(t))
    ) {
      const got = ctx.deployedBaskets ?? []
      return {
        actions: [
          say(
            got.length > 0
              ? 'One page, one buy flow, your deployed baskets as the legs. Weight them below, then publish.'
              : 'A bundle wraps existing baskets into one page with one buy flow. Pick the legs below, weight them, then publish.',
          ),
          { kind: 'bundle', legs: got },
        ],
        ctx: { ...ctx, pending: null },
        celebrate: got.length > 0,
        chips: ['What is a bundle?', 'What baskets are there?'],
      }
    }

    // ── create ──────────────────────────────────────────────────────────────
    // an armed create-slot answers with an ASSET LIST — a message that clearly
    // asks something else releases the slot instead of being eaten by it
    // (owner 21:23: "Best performers…?" answered "name two assets")
    const STRONG_OTHER =
      /best perform|top perform|gainers|movers|winners|trending|what do i|holdings|positions|portfolio|balance|what baskets|list baskets|show baskets|how do|how does|what is|what are|\bhelp\b|read \$|buy \$|\bsell\b|get me out|get out|redeem|referral|share|which chains/
    if (ctx.pending?.intent === 'create' && STRONG_OTHER.test(t)) ctx.pending = null
    // "can i create a basket" is a REQUEST wearing a question mark (owner
    // 19:1x live): request-shaped leads (can/could/how-do/may) walk into the
    // guided create like the plain imperative. Property questions keep their
    // bank rows by leading with what/why/when ("what does it cost to create
    // a basket" stays the cost row).
    const createRequest =
      /^(can|could|how do|how can|how would|may|is it possible)\b/.test(t) &&
      /\b(create|make|start|launch|build)\b/.test(t) &&
      // the basket noun must END the ask (or lead straight into a list/chain
      // tail) — "can i make my basket private" is a property question and the
      // bank's row, not a create ("private" after the noun blocks it)
      /\b(basket|index|portfolio)s?\b\s*(\?|$|(of|with|holding|from|on|for|here|now|please|in)\b)/.test(t)
    if (
      ctx.pending?.intent === 'create' ||
      ((!interrogative || createRequest) && (/\b(create|make|start|build|deploy|launch)\b.*\b(basket|index|portfolio)\b/.test(t) || /\bbasket of\b/.test(t)))
    ) {
      // harvest candidate assets: $TICKERs, addresses, "of X and Y" word lists —
      // and when the guided flow ASKED for assets, the whole bare message is the list
      const symbols = [...text.matchAll(new RegExp(TICKER.source, 'g'))].map((m) => m[1])
      const addrs = [...text.matchAll(new RegExp(ADDR.source, 'g'))].map((m) => m[0])
      const answeringGuide = ctx.pending?.intent === 'create'
      const listSourceRaw = / (?:of|with|holding|from) (.+)$/i.exec(text)?.[1] ?? (answeringGuide ? text : null)
      // spoken weights ride ALONGSIDE the list ("VVV and AERO 70/30",
      // "50% VVV and 50% AERO") — strip them so they never glue to a symbol
      const listSource = listSourceRaw
        ?.replace(/\b\d{1,2}(?:\s*\/\s*\d{1,2}){1,11}\b/g, ' ')
        .replace(/\b\d{1,2}\s*%\s*(?:of\s+)?/g, ' ')
      if (listSource && symbols.length === 0 && addrs.length === 0) {
        for (const w of listSource.split(/,|\band\b|\+|\//)) {
          const s = w.trim().replace(/^\$/, '')
          if (/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(s)) symbols.push(s)
        }
      }
      const inputs = [...addrs, ...stripChainWords(symbols)]
      // TWO OR MORE chain names in one create ask = a cross-chain mix — a
      // basket lives on ONE chain, so the honest product is a BUNDLE (one
      // page, one buy flow, a basket per chain). Explain + route (owner 22:59).
      const chainsNamed = ['base', 'ethereum|etherium|mainnet|\\beth\\b', 'robinhood|robinhod|\\brh\\b'].filter((rx) => new RegExp(rx).test(t)).length
      if (chainsNamed >= 2) {
        // the same ONE-CARD answer the live spans-chains draft gets — with
        // whatever buckets already exist (possibly none; the card's empty
        // state invites the assets), never the old text+steps wall
        const liveBuckets = Object.entries(ctx.drafts ?? {})
          .filter(([, p]) => p.length > 0)
          .map(([id, p]) => ({ chainId: Number(id), picks: p }))
        return {
          actions: [
            say('A basket lives on one chain. Across chains it becomes a BUNDLE: one basket per chain, one page, one buy flow.'),
            { kind: 'crossDraft', buckets: liveBuckets, deployed: ctx.deployedBaskets ?? [] },
          ],
          ctx: { ...ctx, pending: { intent: 'create' } },
          chips: ['Help me create my own basket', 'What is a bundle?'],
        }
      }
      // ZERO assets asks; ONE OR MORE starts the running draft (owner 22:13:
      // a bare "VVV" answer must obviously begin the basket, not reset)
      // the ask is VISUAL (owner 19:1x: "way more beautiful and visual, with
      // an easier way of picking the assets") — the create page's own picker,
      // tappable tiles + cross-chain search, in a chat card. Typing still works.
      if (inputs.length === 0)
        return {
          actions: [
            {
              kind: 'assetPicker',
              text: 'Pick your assets. Tap tiles, search any network, or paste a contract address. Typing "VVV and AERO" works too.',
              picked: pickedAcross(ctx),
            },
          ],
          ctx: { ...ctx, pending: { intent: 'create' } },
        }
      // addresses are already identities; tickers settle through the create
      // page's own search (house-pinned > verified > measured liquidity), and
      // a contested one pauses with its candidate rail
      const picks = addrs.slice(0, 12).map((a) => ({ address: a as Address, symbol: a.slice(0, 8) }))
      const queue = symbols.slice(0, 12 - picks.length)
      // an explicit "create a basket of…" is a FRESH draft; guided answers append
      const fresh = !ctx.pending && /\b(create|make|build|deploy|launch)\b/.test(t)
      return continueCreate({ ...ctx, draft: fresh ? null : ctx.draft, drafts: fresh ? null : ctx.drafts, pending: null }, picks, queue, inlineWeights)
    }

    // ── "compare SVI and WIF": two live baskets side by side, measured ──────
    if (/\bcompare\b|\bversus\b|\bvs\b|which is better/.test(t)) {
      const cands = stripChainWords(t.split(' '))
        .map((w) => w.replace(/^\$/, ''))
        .filter((w) => /^[a-z0-9]{2,11}$/.test(w) && !COMMON.has(w) && !GENERIC_NOUNS.has(w) && !ADD_NOISE.has(w) && !/^(compare|versus|vs|which|better|against)$/.test(w))
      const hits: { address: Address; symbol: string }[] = []
      for (const w of cands.slice(0, 6)) {
        const f = await findBasket(ctx.chainId, w).catch(() => null)
        if (f && f.symbol && !hits.some((h) => h.address === f.address)) hits.push({ address: f.address, symbol: f.symbol })
        if (hits.length === 2) break
      }
      if (hits.length === 2) {
        const [a, b] = hits
        ctx.lastBasket = { address: b.address, chainId: ctx.chainId }
        return {
          actions: [
            say(`$${a.symbol} and $${b.symbol}, measured side by side. Same structure, different holdings: judge from the legs and the moves, not from me.`),
            await readBasketAction(ctx.chainId, a.address),
            await readBasketAction(ctx.chainId, b.address),
          ],
          ctx,
          chips: [`Buy $${a.symbol}`, `Buy $${b.symbol}`, 'Best performers in the last 24 hours?'],
        }
      }
      if (/\bcompare\b/.test(t) && hits.length < 2 && !/etf|index fund|buying|coins/.test(t))
        return { actions: [say(`Name two baskets and I put them side by side, measured. On ${chainName(ctx.chainId)} try: "what baskets are there?" first.`)], ctx, chips: ['What baskets are there?'] }
    }





    // ── THE WHAT-IF TIME MACHINE ("what if i put \$100 in SVI a month ago")
    // — measured from the basket's own NAV series, past-only, never a
    // prediction ─────────────────────────────────────────────────────────────
    {
      const wim = /what if .{0,30}\$?(\d+(?:\.\d+)?)k?\b.{0,40}\b(month|week|day|30 ?d|7 ?d|24 ?h)/i.exec(t)
      if (wim && /what if/.test(t)) {
        const found = await findBasket(ctx.chainId, text)
        if (found) {
          const amt = Number(wim[1]) * (/k\b/.test(wim[0]) ? 1000 : 1)
          const horizon = /month|30 ?d/.test(wim[2]) ? 30 * 86400 : /week|7 ?d/.test(wim[2]) ? 7 * 86400 : 86400
          const d = await cachedBasket(found.address, ctx.chainId)
          const series = (d?.navSeries ?? []).filter((p2) => p2.value > 0)
          const cutoff = Math.floor(Date.now() / 1000) - horizon
          const then = series.find((p2) => p2.time >= cutoff)
          const now2 = series[series.length - 1]
          if (d && then && now2 && then.value > 0 && now2.time > then.time) {
            const worth = (amt * now2.value) / then.value
            const delta = worth - amt
            const pct2 = (now2.value / then.value - 1) * 100
            const windowName = horizon === 30 * 86400 ? 'a month' : horizon === 7 * 86400 ? 'a week' : 'a day'
            return {
              actions: [
                say(
                  `Measured, not predicted: $${amt.toLocaleString()} into $${d.symbol} ${windowName} ago (NAV $${then.value.toFixed(4)}) would be $${worth.toLocaleString(undefined, { maximumFractionDigits: 2 })} today (NAV $${now2.value.toFixed(4)}), ${delta >= 0 ? 'up' : 'down'} $${Math.abs(delta).toFixed(2)} (${pct2 >= 0 ? '+' : ''}${pct2.toFixed(2)}%). The past is a fact; the future is not implied.`,
                ),
                { kind: 'perf', chainId: ctx.chainId, data: d, weights: d.holdings.map((h) => h.targetWeightPct), range: horizon === 86400 ? '24H' : horizon === 7 * 86400 ? '7D' : '30D', changePct: pct2 },
              ],
              ctx,
              chips: [`Buy $${d.symbol}`, `Read $${d.symbol}`, 'Best performers in the last 24 hours?'],
            }
          }
          if (d) return { actions: [say(`$${d.symbol}'s NAV series does not reach back ${/month/.test(wim[2]) ? 'a month' : 'that far'} yet. It is younger than the window.`)], ctx }
        }
      }
    }

    // ── ANY-WALLET READ ("what does 0x… hold") — the positions machinery
    // pointed at an arbitrary address ────────────────────────────────────────
    {
      const am = /(what (does|do)|show|check|inspect)\b.{0,20}\b(0x[0-9a-fA-F]{40})\b.{0,12}\b(hold|own|have)/i.exec(text) ?? (/\b(0x[0-9a-fA-F]{40})\b/.test(text) && /\b(hold|own|holdings|portfolio|whale)\b/.test(t) ? ([null, null, text.match(/0x[0-9a-fA-F]{40}/)![0]] as unknown as RegExpExecArray) : null)
      if (am) {
        const holder = (am[3] ?? am[2]) as Address
        if (isAddress(holder)) {
          const list = await cachedList(ctx.chainId)
          const client = clientFor(ctx.chainId)
          const balances = await Promise.all(
            list.map((b) => client.readContract({ address: b.address as Address, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] }).then((v) => v as bigint).catch(() => 0n)),
          )
          const rows = list
            .map((b, i) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name), raw: balances[i] }))
            .filter((r) => r.raw > 0n)
            .map((r) => ({ address: r.address, symbol: r.symbol, name: r.name, shares: (Number(r.raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 }) }))
          if (rows.length === 0) return { actions: [say(`${holder.slice(0, 6)}…${holder.slice(-4)} holds no baskets on ${chainName(ctx.chainId)}. Everything else it holds is a portfolio-page question.`)], ctx }
          return {
            actions: [say(`${holder.slice(0, 6)}…${holder.slice(-4)} holds ${rows.length} basket${rows.length === 1 ? '' : 's'} on ${chainName(ctx.chainId)}:`), { kind: 'positions', chainId: ctx.chainId, rows }],
            ctx,
          }
        }
      }
    }

    // ── THE DD CHECK ("dd SVI", "health check SVI") — measured diagnostics,
    // scored in words, never advice ──────────────────────────────────────────
    if (/^(dd|due diligence|health ?check|audit)\b/.test(core) || /\b(dd|health ?check)\b.{0,20}\$?[A-Za-z0-9]{2,12}\s*$/.test(core)) {
      const found = (await findBasket(ctx.chainId, text)) ?? (ctx.lastBasket && ctx.lastBasket.chainId === ctx.chainId ? await findBasket(ctx.chainId, ctx.lastBasket.address) : null)
      if (!found) return { actions: [say('DD which basket? Name it and I measure: pricing provenance, leg liquidity, concentration, verification.')], ctx, chips: ['What baskets are there?'] }
      const d = await cachedBasket(found.address, ctx.chainId)
      if (!d) return { actions: [say(`That basket did not read on ${chainName(ctx.chainId)}.`)], ctx }
      const weights = d.holdings.map((h) => h.targetWeightPct)
      const topW = Math.max(...weights, 0)
      const lines: string[] = []
      lines.push(`${d.fullyPriced ? '✓ every leg priced live' : '⚠ NOT every leg priced, so the NAV is partial'} (${d.navSource})`)
      lines.push(topW >= 50 ? `⚠ concentrated: the top leg carries ${topW}%` : `✓ spread: top leg ${topW}%`)
      // per-leg liquidity through the same search the builder trusts
      let thin = 0
      let checked = 0
      for (const h of d.holdings.slice(0, 12)) {
        if (!h.symbol) continue
        const hits = await searchTokens(h.symbol, ctx.chainId).catch(() => [])
        const hit = hits.find((x) => x.address.toLowerCase() === h.asset.toLowerCase())
        if (hit) {
          checked++
          if ((hit.liquidityUsd ?? 0) < 10_000) thin++
        }
      }
      if (checked > 0) lines.push(thin === 0 ? `✓ all ${checked} measurable legs above $10k liquidity` : `⚠ ${thin} of ${checked} measurable legs under $10k liquidity, so exits there move the price`)
      lines.push(`✓ structure: immutable weights, no admin keys, redeem-in-kind always stands`)
      lines.push(`supply ${d.totalSupply} · AUM $${d.aumUsd.toFixed(0)} · deployer ${d.deployer ? `${d.deployer.slice(0, 6)}…${d.deployer.slice(-4)}` : 'unread'}`)
      ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
      return {
        actions: [say(`DD on $${d.symbol}, measured now:\n${lines.join('\n')}\nFacts, not advice. Anyone can deploy a basket, and the legs are the argument:`), await readBasketAction(ctx.chainId, found.address)],
        ctx,
        chips: [`Buy $${d.symbol}`, `Watch ${d.symbol}`, 'Is it safe?'],
      }
    }

    // ── THE WATCHLIST ("watch SVI", "watch SVI, tell me if it moves 3%") ────
    {
      const wm = /\b(watch|track|alert me (on|about)|keep an eye on)\b/.test(t) && !/\bunwatch|stop watch|market|movers\b/.test(t) && !interrogative
      if (wm) {
        const found = (await findBasket(ctx.chainId, text)) ?? (ctx.lastBasket && ctx.lastBasket.chainId === ctx.chainId ? await findBasket(ctx.chainId, ctx.lastBasket.address) : null)
        if (!found) return { actions: [say('Which basket should I watch? Name it, and optionally a threshold ("watch SVI, tell me if it moves 3%").')], ctx, chips: ['What baskets are there?'] }
        const pm = /(\d+(?:\.\d+)?)\s*%/.exec(t)
        const thresholdPct = pm ? Math.min(50, Math.max(0.5, Number(pm[1]))) : 5
        const d = await cachedBasket(found.address, ctx.chainId)
        if (!d || !(d.navPerToken > 0)) return { actions: [say(`$${found.symbol || 'That basket'} did not read a NAV to baseline from. Try again in a moment.`)], ctx }
        const w = loadWatches().filter((x) => !(x.chainId === ctx.chainId && x.address.toLowerCase() === found.address.toLowerCase()))
        if (w.length >= 6) return { actions: [say('Six watches is the cap (each one polls the chain). Unwatch something first ("my watches" shows them).')], ctx }
        w.push({ chainId: ctx.chainId, address: found.address, symbol: found.symbol || d.symbol, thresholdPct, baselineNav: d.navPerToken, setAt: Date.now(), lastNotifiedAt: null })
        saveWatches(w)
        return {
          actions: [
            say(
              `Watching $${found.symbol || d.symbol}: I speak up when NAV moves ${thresholdPct}% either way from $${d.navPerToken.toFixed(4)}. The watch survives refreshes and new sessions, and when you come back I report what moved while you were away. Honest limit: with every tab closed nothing polls, so moves are caught on your return, not pushed to a closed browser.`,
            ),
          ],
          ctx,
          chips: ['My watches', `Read $${found.symbol || d.symbol}`],
        }
      }
    }
    if (/^(unwatch|stop watching)\b/.test(core)) {
      const w = loadWatches()
      if (w.length === 0) return { actions: [say('Nothing is being watched.')], ctx }
      const tick2 = /\b([A-Za-z0-9]{2,12})\s*$/.exec(core.replace(/^unwatch|^stop watching/, '').trim() || '')
      if (/all$/.test(core) || !tick2) {
        saveWatches([])
        return { actions: [say(`All ${w.length} watch${w.length === 1 ? '' : 'es'} cleared.`)], ctx }
      }
      const sym = tick2[1].toUpperCase()
      const kept = w.filter((x) => x.symbol.toUpperCase() !== sym)
      saveWatches(kept)
      return { actions: [say(kept.length === w.length ? `$${sym} was not on the watchlist.` : `$${sym} unwatched. ${kept.length} still watched.`)], ctx }
    }
    if (/^(my )?watch(es|list)$|what am i watching/.test(core)) {
      const w = loadWatches()
      if (w.length === 0) return { actions: [say('Nothing watched yet. "Watch SVI, tell me if it moves 3%" starts one.')], ctx, chips: ['What baskets are there?'] }
      return {
        actions: [say(w.map((x) => `$${x.symbol} on ${chainName(x.chainId)}: ±${x.thresholdPct}% from $${x.baselineNav.toFixed(4)}`).join('\n'))],
        ctx,
        chips: [...w.slice(0, 2).map((x) => `Unwatch ${x.symbol}`), 'Unwatch all'],
      }
    }

    // ── RECENT ACTIVITY ("what did i do today") — the exec-log the portfolio
    // itself writes, read back as chat lines ─────────────────────────────────
    if (/what (did|have) i (do|done|trade|traded)( today| recently)?|my (recent )?(activity|transactions|trades)$|recent transactions/.test(core)) {
      if (!ctx.account) return { actions: [say('Connect a wallet and I read back your recent activity from this device\u2019s own log.')], ctx }
      const entries = loadExecLog(ctx.account).slice(-8).reverse()
      if (entries.length === 0) return { actions: [say('No activity logged on this device for this wallet yet. Trades and runs land here as you make them.')], ctx }
      const lines = entries.map((e) => {
        const when = new Date(e.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        const what = e.changes?.map((c2) => `${c2.deltaUsd >= 0 ? '+' : ''}$${Math.abs(c2.deltaUsd).toFixed(2)} ${clampChainText(c2.symbol)}`).join(', ') ?? e.kind
        return `${when} · ${e.kind}${e.totalUsd != null ? ` $${e.totalUsd.toFixed(2)}` : ''} · ${what}${e.simulated ? ' (simulated)' : ''}`
      })
      return { actions: [say(`Your last ${entries.length} on this device:\n${lines.join('\n')}`)], ctx, chips: ['What do I hold?', 'Best performers in the last 24 hours?'] }
    }

    // ── THE MISSED-QUESTIONS READBACK (operator telemetry, local) ───────────
    if (/^(missed questions|what did people ask|unanswered questions)$/.test(core)) {
      let rows: { t: string; at: number }[] = []
      try {
        rows = JSON.parse(localStorage.getItem('specter-missed-v1') ?? '[]') as { t: string; at: number }[]
      } catch {
        rows = []
      }
      if (rows.length === 0) return { actions: [say('No missed questions logged on this device. Every message so far landed on a real answer.')], ctx }
      const recent = rows.slice(-12).reverse()
      return {
        actions: [say(`${rows.length} message${rows.length === 1 ? '' : 's'} hit the catch-all on this device. The last ${recent.length}:\n${recent.map((r2) => `\u00b7 ${clampChainText(r2.t)}`).join('\n')}\nMine these into new answers; the log is local-only and capped at 200.`)],
        ctx,
      }
    }

    // ── CREATOR FEES, live ("what fees am i earning", "my creator fees") ────
    if (/\b(my (creator )?fees|fees (am i|do i) earn\w*|what have i earned|my earnings|creator earnings)\b/.test(t)) {
      if (!ctx.account) return { actions: [say('Connect a wallet (top right) and I read your accrued fees straight from the contracts.')], ctx }
      const client = clientFor(ctx.chainId)
      const list = await cachedList(ctx.chainId)
      const rows: string[] = []
      const claimable: { address: Address; symbol: string; pendingUsd: number }[] = []
      let totalRaw = 0n
      for (const b of list.slice(0, 24)) {
        const pending = (await client
          .readContract({ address: b.address as Address, abi: feeReadAbi, functionName: 'pendingFrontendFees', args: [ctx.account as Address] })
          .catch(() => 0n)) as bigint
        if (pending > 0n) {
          totalRaw += pending
          rows.push(`$${clampChainText(b.symbol)}: $${(Number(pending) / 1e6).toFixed(2)} accrued`)
          // the same reads now feed a real CLAIM CARD, not a link out
          claimable.push({ address: b.address as Address, symbol: b.symbol, pendingUsd: Number(pending) / 1e6 })
        }
      }
      const mine = list.filter((b) => b.deployer && b.deployer.toLowerCase() === (ctx.account as string).toLowerCase())
      const configLines: string[] = []
      for (const b of mine.slice(0, 6)) {
        const [fee, share] = await Promise.all([
          client.readContract({ address: b.address as Address, abi: feeReadAbi, functionName: 'basketFeeBps' }).catch(() => null),
          client.readContract({ address: b.address as Address, abi: feeReadAbi, functionName: 'creatorShareBps' }).catch(() => null),
        ])
        if (fee != null) configLines.push(`$${clampChainText(b.symbol)}: ${Number(fee) / 100}% basket fee, your share ${share != null ? `${Number(share) / 100}%` : 'unread'} of the remainder`)
      }
      const head =
        rows.length > 0
          ? `Accrued to your address on ${chainName(ctx.chainId)} right now: $${(Number(totalRaw) / 1e6).toFixed(2)} USDC total.\n${rows.join('\n')}`
          : `Nothing accrued to your address on ${chainName(ctx.chainId)} right now.`
      // CLAIMING HAPPENS HERE (owner 2026-08-21). This used to hand out a link
      // to the flush console — the only money action the chat could not finish.
      // With nothing accrued there is nothing to claim, so the answer stays
      // words; the flush crank stays a fact, not a destination.
      const origin2 = typeof window !== 'undefined' ? window.location.origin : ''
      return {
        actions: [
          say([head, ...(configLines.length ? [`Your baskets' fee settings:`, ...configLines] : [])].join('\n')),
          ...(claimable.length > 0
            ? [
                {
                  kind: 'claim' as const,
                  chainId: ctx.chainId,
                  rows: claimable,
                  totalUsd: Number(totalRaw) / 1e6,
                  refLink: ctx.account ? `${origin2}/?ref=${ctx.account}` : null,
                },
              ]
            : []),
        ],
        ctx,
        chips: ['How do creator fees work?', 'How are my baskets doing?', 'Get my referral link'],
      }
    }

    // ── write/update a THESIS in-chat (the real ThesisEditor mounts) ────────
    {
      const thm = /\b(write|add|update|edit|publish|set)\b.{0,24}\bthesis\b|\bthesis for\b/.test(t) && !interrogative
      if (thm) {
        const found = (await findBasket(ctx.chainId, text)) ?? (ctx.lastBasket && ctx.lastBasket.chainId === ctx.chainId ? await findBasket(ctx.chainId, ctx.lastBasket.address) : null)
        if (!found) return { actions: [say('Which basket gets the thesis? Name it (yours to write: you deployed it).')], ctx, chips: ['How are my baskets doing?'] }
        const d = await cachedBasket(found.address, ctx.chainId)
        return {
          actions: [
            say(
              d?.deployer && ctx.account && d.deployer.toLowerCase() === (ctx.account as string).toLowerCase()
                ? `Your basket, your case. Write the thesis for $${found.symbol || 'it'} below; one signature publishes it on-chain and every surface reads it.`
                : `The thesis surfaces under the DEPLOYER's key. Connect the wallet that deployed $${found.symbol || 'it'} to publish one that shows.`,
            ),
            { kind: 'thesis', chainId: ctx.chainId, basket: found.address, symbol: found.symbol || 'BASKET', deployer: d?.deployer ?? null },
          ],
          ctx,
        }
      }
    }

    // ── update the CREATOR PROFILE in-chat (the real CreatorSignup mounts) ──
    if (/\b(update|edit|set up|create|claim)\b.{0,16}\b(creator )?(profile|handle|name)\b/.test(t) && !/basket|thesis/.test(t) && !interrogative) {
      return {
        actions: [
          say('Your creator page, from right here: claim a name, set the profile, one signature each.'),
          { kind: 'profile' },
        ],
        ctx,
        chips: ['How are my baskets doing?', 'What fees am I earning?'],
      }
    }

    // eslint-disable-next-line no-empty -- (anchor)
    // ── THE TX INSPECTOR ("what happened in 0x…", or just a pasted 66-char
    // hash): status, what moved, and on a revert the app's own decoded reason
    // (friendlyRevert) via a replay at the tx's block ────────────────────────
    {
      const txm = /\b(0x[0-9a-fA-F]{64})\b/.exec(text)
      if (txm && !/approve|sign|send/.test(t)) {
        const hash = txm[1] as `0x${string}`
        const client = clientFor(ctx.chainId)
        const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
        if (!receipt) {
          return {
            actions: [say(`No receipt for that hash on ${chainName(ctx.chainId)}: pending, dropped, or another chain. Say "on base" / "on robinhood" / "on ethereum" and paste it again.`)],
            ctx,
          }
        }
        const lines: string[] = [`Status: ${receipt.status === 'success' ? 'landed' : 'REVERTED'} · block ${receipt.blockNumber} · ${receipt.logs.length} logs.`]
        if (receipt.status === 'success') {
          // ERC-20 Transfer legs involving the sender, symbols best-effort
          const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
          const from = receipt.from.toLowerCase()
          const moves = receipt.logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length >= 3)
          const mine = moves
            .map((l) => ({
              token: l.address as Address,
              out: `0x${String(l.topics[1]).slice(26)}`.toLowerCase() === from,
              inn: `0x${String(l.topics[2]).slice(26)}`.toLowerCase() === from,
              raw: BigInt(l.data === '0x' ? 0 : l.data),
            }))
            .filter((m) => m.out || m.inn)
            .slice(0, 4)
          for (const m of mine) {
            const meta = await client
              .readContract({ address: m.token, abi: erc20MetaAbi, functionName: 'symbol' })
              .then(async (sym) => ({ sym: clampChainText(String(sym)), dec: Number(await client.readContract({ address: m.token, abi: erc20MetaAbi, functionName: 'decimals' }).catch(() => 18)) }))
              .catch(() => ({ sym: `${m.token.slice(0, 8)}…`, dec: 18 }))
            lines.push(`${m.inn ? 'received' : 'sent'} ${(Number(m.raw) / 10 ** meta.dec).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${meta.sym}`)
          }
          if (mine.length === 0 && moves.length > 0) lines.push(`${moves.length} token transfer${moves.length === 1 ? '' : 's'} between other parties.`)
        } else {
          // the reason: replay the call at its block, decode with the app's own vocabulary
          const tx = await client.getTransaction({ hash }).catch(() => null)
          if (tx) {
            const why = await client
              .call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber: receipt.blockNumber })
              .then(() => null)
              .catch((e) => friendlyRevert(e, 'the chain kept the reason to itself'))
            lines.push(why ? `Why: ${why}` : 'The replay at that block no longer reverts: state has moved since, and the original reason is not recoverable.')
          }
          lines.push('Nothing moved beyond gas.')
        }
        return { actions: [say(lines.join('\n'))], ctx, chips: ['What do I hold?', 'What baskets are there?'] }
      }
    }

    // ── the CREATOR VIEW ("how are my baskets doing", "baskets i made") ─────
    if (/\b(my (deployed|created) baskets?|baskets? i (made|created|deployed|launched)|how are my baskets)\b/.test(t)) {
      if (!ctx.account) return { actions: [say('Connect a wallet (top right) and I read the baskets you deployed.')], ctx }
      const list = await cachedList(ctx.chainId)
      const mine = list.filter((b) => b.deployer && b.deployer.toLowerCase() === (ctx.account as string).toLowerCase())
      if (mine.length === 0)
        return {
          actions: [say(`No baskets deployed by this wallet on ${chainName(ctx.chainId)}. Deploying one takes two minutes, right here.`)],
          ctx,
          chips: ['Help me create my own basket', 'What baskets are there?'],
        }
      const aum = mine.reduce((s2, b) => s2 + (b.aumUsd || 0), 0)
      return {
        actions: [
          say(`You created ${mine.length} basket${mine.length === 1 ? '' : 's'} on ${chainName(ctx.chainId)}, $${Math.round(aum).toLocaleString()} AUM combined:`),
          { kind: 'baskets', chainId: ctx.chainId, rows: mine.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) },
        ],
        ctx,
        chips: ['Get my referral link', 'Best performers in the last 24 hours?'],
      }
    }

    // ── the LEADERBOARD in chat ("top creators", "the league") ──────────────
    if (/top creators|best creators|creator (league|leaderboard|ranking)|who (makes|made) the best|^(the )?league$|^leaderboard$/.test(core)) {
      const list = await cachedList(ctx.chainId)
      const board = buildCreatorLeaderboard(list).slice(0, 5)
      if (board.length === 0) return { actions: [say(`No creators to rank on ${chainName(ctx.chainId)} yet.`)], ctx }
      const rows = board.map((c2, i) => {
        const aum = c2.baskets.reduce((s2, b) => s2 + (b.aumUsd || 0), 0)
        return `${i + 1}. ${c2.address.slice(0, 6)}…${c2.address.slice(-4)} · ${c2.baskets.length} basket${c2.baskets.length === 1 ? '' : 's'} · $${Math.round(aum).toLocaleString()} AUM · top $${clampChainText(c2.topBasket.symbol)}`
      })
      return {
        actions: [
          say(`The top creators on ${chainName(ctx.chainId)}, ranked from their baskets' own numbers:\n${rows.join('\n')}`),
          { kind: 'link', href: '/league', label: 'The full creator league', text: 'Every creator, ranked live.' },
        ],
        ctx,
        chips: board[0] ? [`Read $${clampChainText(board[0].topBasket.symbol)}`, 'What baskets are there?'] : STEER,
      }
    }

    // ── THE ENTITY LAYER (owner 23:0x: "pre-logic individual tickers, baskets
    // and bundles so it feels incredibly smart"). A question that NAMES a
    // basket answers about THAT basket with live reads; a non-basket ticker
    // gets measured token facts + which baskets hold it. ────────────────────
    {
      const named = await findBasket(ctx.chainId, text).catch(() => null)
      if (named && named.symbol) {
        ctx.lastBasket = { address: named.address, chainId: ctx.chainId }
        const scoped = async (line: string, extraChips: string[] = []): Promise<AgentReply> => ({
          actions: [say(line), await readBasketAction(ctx.chainId, named.address)],
          ctx,
          chips: [`Buy $${named.symbol}`, `Sell $${named.symbol}`, ...extraChips],
        })
        // "why does SVI exist" / "read the thesis" — the creator's own case,
        // straight from the notes registry (the token page's source)
        if (/\bthesis\b|why (does|was) .*(exist|made|created)|the case for/.test(t)) {
          const d = await cachedBasket(named.address, ctx.chainId)
          let thesisText: string | null = null
          try {
            const registry = chainCfg(ctx.chainId).notesRegistry
            if (registry && d?.deployer) {
              const meta = await fetchOnchainBasketMeta(clientFor(ctx.chainId), registry, d.deployer as Address, named.address)
              const raw = (meta?.json as { thesis?: unknown } | null)?.thesis
              if (typeof raw === 'string' && raw.trim()) thesisText = clampChainText(raw).slice(0, 600)
            }
          } catch {
            /* no registry / unreadable = the honest no-thesis answer */
          }
          return scoped(
            thesisText
              ? `The creator's own case for $${named.symbol}:\n\u201c${thesisText}\u201d\nJudge it against the measured legs below:`
              : `$${named.symbol} has no published thesis. The composition IS the argument, measured below:`,
          )
        }
        // "do you have SVI?" / "is there an svi basket?" — availability asked
        // about a live basket answers yes with the read (anchored on the
        // filler-stripped core; a trailing clause like "is there a fee on svi"
        // fails the end anchor and keeps its own meaning)
        if (/^(?:do (?:you|we) (?:have|support|list|offer)|is there|got)\s+(?:a |an |any )?\$?[a-z0-9]{2,11}(?:\s+(?:basket|token|coin))?\s*$/.test(core))
          return scoped(`Yes. $${named.symbol} is live on ${chainName(ctx.chainId)}, measured here:`)
        // "how is SVI doing" / "chart SVI this week" — the VISUAL performance
        // answer: the real spark over the asked window (owner: less text,
        // more visual)
        if (/how (is|has|did|was) .*(doing|done|perform\w*|been|go(ne)?)\b/.test(t) || hasWord(t, ['chart', 'graph']) || /performance of/.test(t)) {
          const range: '24H' | '7D' | '30D' = /month|30 ?d/.test(t) ? '30D' : /week|7 ?d/.test(t) ? '7D' : '24H'
          const d = await cachedBasket(named.address, ctx.chainId)
          if (d) {
            const horizon = range === '30D' ? 30 * 86400 : range === '7D' ? 7 * 86400 : 86400
            const cutoff = Math.floor(Date.now() / 1000) - horizon
            const pts = (d.navSeries ?? []).filter((p) => p.time >= cutoff && p.value > 0)
            const chg = pts.length >= 2 && pts[0].value > 0 ? (pts[pts.length - 1].value / pts[0].value - 1) * 100 : null
            const weights = d.holdings.map((h) => h.targetWeightPct)
            return {
              actions: [
                say(
                  chg != null
                    ? `$${d.symbol} is ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(2)}% over the ${range === '24H' ? 'last 24 hours' : range === '7D' ? 'week' : 'month'}, measured from its own NAV series:`
                    : `$${d.symbol}, measured from its own NAV series (not enough points in this window for a change figure yet):`,
                ),
                { kind: 'perf', chainId: ctx.chainId, data: d, weights, range, changePct: chg },
              ],
              ctx,
              chips: [`Buy $${d.symbol}`, `Sell $${d.symbol}`, 'Best performers in the last 24 hours?'],
            }
          }
        }
        if (/why is .*(down|up)|is .*(down|up)\b|(dropp|pump|dump|crash|moon)(ed|ing)/.test(t)) {
          const d = await cachedBasket(named.address, ctx.chainId)
          const srs = d?.navSeries ?? []
          const chg = srs.length >= 2 && srs[0].value > 0 ? ((srs[srs.length - 1].value / srs[0].value - 1) * 100).toFixed(1) : null
          return scoped(
            chg != null
              ? `$${named.symbol} moved ${Number(chg) >= 0 ? 'up' : 'down'} ${Math.abs(Number(chg))}% over the chart window, and a basket only ever tracks its holdings: the movers are inside. The read shows which legs did it:`
              : `$${named.symbol} tracks its holdings, nothing else. The read shows the legs and their moves:`,
          )
        }
        if (/is .*(safe|legit|a scam|a rug)|can .*(rug|steal)/.test(t))
          return scoped(
            `Structurally $${named.symbol} is as safe as any basket here: immutable mix, no admin keys, the in-kind exit always works. The honest part YOU judge is what it holds. Anyone can deploy a basket, so read the legs:`,
            ['Is it safe?'],
          )
        if (/should i (buy|sell)|worth (buying|it)|good (buy|investment)/.test(t))
          return scoped(`Not my call, and listing is not endorsement. Here is $${named.symbol} measured, decide from the real numbers:`, ['Best performers in the last 24 hours?'])
        if (/who (made|created|deployed)|whose basket/.test(t)) {
          const d = await cachedBasket(named.address, ctx.chainId)
          return scoped(d?.deployer ? `$${named.symbol} was deployed by ${d.deployer}. Every basket page carries its creator; the read:` : `The deployer reads on the basket page:`)
        }
      }
      // a TICKER that is not a basket: measured token facts + who holds it.
      // The $-form announces itself; an availability question ("do you have
      // wif?") announces its bare word the same way — generic nouns stay out
      // so "is there a fee" keeps meaning the bank's fee answer.
      const availM = /^(?:do (?:you|we) (?:have|support|list|offer)|is there|got)\s+(?:a |an |any )?\$?([a-z0-9]{2,11})(?:\s+(?:basket|token|coin))?\s*$/.exec(core)
      const avail = availM && !GENERIC_NOUNS.has(availM[1]) && !COMMON.has(availM[1]) && !CHAIN_WORDS.has(availM[1]) ? availM[1].toUpperCase() : undefined
      const tick = text.match(TICKER)?.[1]?.toUpperCase() ?? avail
      const tradeVerb = /\bbuy\b/.test(t) || hasWord(t, ['sell', 'dump', 'offload', 'liquidate', 'exit', 'redeem', 'withdraw'])
      if (!named && tick && !tradeVerb && !CHAIN_WORDS.has(tick.toLowerCase())) {
        const settled = await settleTicker(tick, ctx.chainId)
        if ('pick' in settled || 'hits' in settled) {
          const hit = 'pick' in settled ? null : settled.hits[0]
          const list = await cachedList(ctx.chainId)
          const holders = [] as { address: Address; symbol: string; name: string }[]
          for (const b of list) {
            if (b.top?.some((x) => x.symbol?.toUpperCase() === tick)) holders.push({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })
          }
          const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`)
          const facts = hit ? `$${tick} on ${chainName(ctx.chainId)}: measured liquidity ${fmt(hit.liquidityUsd)}, mcap ${hit.marketCapUsd > 0 ? fmt(hit.marketCapUsd) : 'unreported'}${hit.verified ? ', on the verified list' : ''}.` : `$${tick} resolves on ${chainName(ctx.chainId)}.`
          return {
            actions: [
              say(`${facts}${holders.length ? ` ${holders.length} basket${holders.length === 1 ? '' : 's'} here hold it:` : ' No basket here holds it yet: be the first.'}`),
              ...(holders.length ? [{ kind: 'baskets' as const, chainId: ctx.chainId, rows: holders }] : []),
            ],
            ctx,
            chips: [`Create a basket of ${tick} and AERO`, 'Best performers in the last 24 hours?'],
          }
        }
      }
    }

    // ── "which baskets hold X" ───────────────────────────────────────────────
    {
      const m = /(which|what) baskets? (hold|holds|contain|have|with)\s+\$?([a-z0-9]{2,11})/.exec(t)
      if (m) {
        const tick = m[3].toUpperCase()
        const list = await cachedList(ctx.chainId)
        const holders = list.filter((b) => b.top?.some((x) => x.symbol?.toUpperCase() === tick))
        return {
          actions: [
            say(holders.length ? `${holders.length} basket${holders.length === 1 ? '' : 's'} on ${chainName(ctx.chainId)} hold $${tick}:` : `No basket on ${chainName(ctx.chainId)} holds $${tick} yet. First-mover slot is open.`),
            ...(holders.length ? [{ kind: 'baskets' as const, chainId: ctx.chainId, rows: holders.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) }] : []),
          ],
          ctx,
          chips: holders.length ? [`Read $${holders[0].symbol}`, `Create a basket of ${tick} and AERO`] : [`Create a basket of ${tick} and AERO`],
        }
      }
    }

    // ── best performers (assets measured live 24h; baskets by NAV history) ──
    if (/best perform|top perform|biggest (gainers?|movers?)/.test(t) || hasWord(t, ['gainers', 'movers', 'winners', 'trending', 'pumping', 'mooning']) || hasPhrase(t, ['what is hot', 'what is moving', 'whats hot', 'best assets', 'top assets', 'best baskets', 'top baskets'])) {
      const windowLabel: keyof typeof WINDOWS = /30 ?d|month/.test(t) ? '30d' : /7 ?d|week/.test(t) ? '7d' : '24h'
      return { actions: [await moversFor(ctx.chainId, windowLabel)], ctx: { ...ctx, lastIntent: { kind: 'movers', window: windowLabel } } }
    }

    // ── share link for a basket ──────────────────────────────────────────────
    if (/\bshare\b.*(link|basket)|\bshare \$|get (the |a )?share/.test(t)) {
      const found = (await findBasket(ctx.chainId, text)) ?? (ctx.lastBasket ? await findBasket(ctx.lastBasket.chainId, ctx.lastBasket.address) : null)
      if (!found) return { actions: [say('Which basket do you want to share? Name it, paste its address, or read one first.')], ctx }
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const url = `${origin}${basketHref({ symbol: found.symbol, address: found.address, chainId: ctx.chainId })}`
      return {
        actions: [
          {
            kind: 'share',
            url,
            symbol: found.symbol || found.address.slice(0, 8),
            text: `Here is the share link for ${found.symbol ? `$${found.symbol}` : found.address} : it opens the basket page directly.`,
          },
        ],
        ctx,
      }
    }

    // ── the caller's referral link ───────────────────────────────────────────
    if (/\breferral\b|\brefer\b|my ref\b|ref link/.test(t)) {
      if (!ctx.account) return { actions: [say('Connect a wallet first (top right) and I mint your referral link from it.')], ctx }
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const url = refLinkFor(ctx.account, origin)
      return {
        actions: [
          {
            kind: 'referral',
            url,
            text: 'Your referral link. Anyone who arrives through it is attributed to your wallet. Claim a creator name on the site and the link gets prettier:',
          },
        ],
        ctx,
      }
    }

    // ── positions ───────────────────────────────────────────────────────────
    if (
      /\bwhat (do|am) i (hold|own|holding)\b/.test(t) ||
      hasWord(t, ['holdings', 'positions', 'portfolio', 'balance', 'balances']) ||
      hasPhrase(t, ['my baskets', 'what do i have', 'do i own', 'do i hold', 'how am i doing', 'my pnl', 'am i up', 'am i down', 'my performance'])
    ) {
      if (!ctx.account) return { actions: [say('Connect a wallet first (top right of this chat) and I will read your basket holdings on-chain.')], ctx }
      // one chain's holdings, as rows — pulled out so "everywhere" can sweep
      const holdingsOn = async (chainId: number) => {
        const list = await cachedList(chainId).catch(() => [])
        if (list.length === 0) return []
        const client = clientFor(chainId)
        const balances = await Promise.all(
          list.map((b) =>
            client
              .readContract({ address: b.address as Address, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [ctx.account as Address] })
              .then((v) => v as bigint)
              .catch(() => 0n),
          ),
        )
        return list
          .map((b, i) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name), raw: balances[i] }))
          .filter((r) => r.raw > 0n)
          .map((r) => ({ address: r.address, symbol: r.symbol, name: r.name, shares: (Number(r.raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 }) }))
      }
      // "what do i hold everywhere / across chains / on all chains" sweeps all
      // three in parallel — one rail per chain that answers with holdings
      if (/everywhere|all (the )?chains|across (the )?chains|every chain|all networks/.test(t)) {
        const swept = await Promise.all(SUPPORTED_CHAIN_IDS.map(async (id) => ({ id, rows: await holdingsOn(id) })))
        const held = swept.filter((sw) => sw.rows.length > 0)
        if (held.length === 0) return { actions: [say('No basket holdings for this wallet on any supported chain.')], ctx }
        return {
          actions: [
            say(`Your baskets across ${held.length === 1 ? chainName(held[0].id) : `${held.length} chains`}:`),
            ...held.map((sw) => ({ kind: 'positions' as const, chainId: sw.id, rows: sw.rows })),
          ],
          ctx,
        }
      }
      const rows = await holdingsOn(ctx.chainId)
      if (rows.length === 0)
        return {
          actions: [say(`No basket holdings for this wallet on ${chainName(ctx.chainId)}. Ask "what do I hold everywhere" and I sweep every chain.`)],
          ctx,
          chips: ['What do I hold everywhere?', 'What baskets are there?'],
        }
      return { actions: [{ kind: 'positions', chainId: ctx.chainId, rows }], ctx }
    }

    // ── "open it" rides the basket the exchange is about (QoL 2026-08-20) ───
    if (ctx.lastBasket && ctx.lastBasket.chainId === ctx.chainId && /^(open( it| that| the (basket )?page)?|take me (there|to it)|go to (it|the page))$/.test(core))
      return {
        // no advertising duplicate money doors elsewhere: buying, selling,
        // redeeming and migrating all complete in here. The page is the chart
        // and the public face of it, which is what "open it" is asking for.
        actions: [{ kind: 'link', href: `/t/${ctx.lastBasket.chainId}/${ctx.lastBasket.address}`, label: 'Open the basket page', text: 'The full chart, the thesis, and the public page you can share.' }],
        ctx,
      }

    // ── NEW VERSION of a basket (owner 2026-08-21). A basket is immutable, so
    // an "update" is a fresh deploy LINKED as the successor and holders migrate
    // (his own correction 2026-08-19). This used to be impossible in the chat:
    // no action, no card, no link, so a chat deploy was always UNLINKED.
    {
      const ver =
        /\b(?:new|next)\s+version\s+of\s+\$?([A-Za-z0-9]{2,12})\b/i.exec(text) ??
        /\b(?:update|upgrade|revise|reissue)\s+(?:my\s+)?\$?([A-Za-z0-9]{2,12})\b/i.exec(text) ??
        /\bv(?:ersion)?\s*2\s+of\s+\$?([A-Za-z0-9]{2,12})\b/i.exec(text)
      if (ver && !interrogative) {
        const word = ver[1].toLowerCase()
        const ref = ['it', 'that', 'this'].includes(word) && ctx.lastBasket?.chainId === ctx.chainId ? ctx.lastBasket.address : ver[1]
        const pred = await findBasket(ctx.chainId, ref).catch(() => null)
        if (pred) {
          const predData = await cachedBasket(pred.address, ctx.chainId)
          if (predData) {
            ctx.lastBasket = { address: pred.address, chainId: ctx.chainId }
            return {
              actions: [
                say(`A new version of $${predData.symbol}, carried across and linked as its successor.`),
                { kind: 'version', chainId: ctx.chainId, predecessor: predData },
              ],
              ctx,
              chips: [`Read $${predData.symbol}`, 'How does versioning work?'],
            }
          }
        }
      }
    }

    // ── migrate: basket → basket, the ONE money flow the chat could not do
    // (the how-to answer existed; the flow did not). The card mounts the REAL
    // MigrateModal — in-kind move, overlap never touches a DEX. ─────────────
    {
      const mig = /\b(?:migrate|switch|rotate|move)\b[\s\S]*?(?:\bmy\b\s+)?\$?([A-Za-z0-9]{2,12}|it|that|this)\s+(?:in)?to\s+\$?([A-Za-z0-9]{2,12})/i.exec(text)
      if (mig && (hasWord(t, ['migrate', 'rotate']) || /\bswitch\b|\bmove\b/.test(t)) && !interrogative) {
        const fromWord = mig[1].toLowerCase()
        const fromRef = ['it', 'that', 'this'].includes(fromWord) && ctx.lastBasket?.chainId === ctx.chainId ? ctx.lastBasket.address : mig[1]
        const from = await findBasket(ctx.chainId, fromRef).catch(() => null)
        const to = await findBasket(ctx.chainId, mig[2]).catch(() => null)
        if (from && to && from.address.toLowerCase() !== to.address.toLowerCase()) {
          ctx.lastBasket = { address: to.address, chainId: ctx.chainId }
          return {
            actions: [
              say(`$${from.symbol} into $${to.symbol}, in kind: you redeem the underlying, and the assets both baskets share go straight back in without touching a DEX. Two to four signatures, all yours.`),
              { kind: 'migrate', chainId: ctx.chainId, from: { address: from.address, symbol: from.symbol }, to: { address: to.address, symbol: to.symbol } },
            ],
            ctx,
            celebrate: true,
            chips: [`Read $${to.symbol}`, 'What do I hold?'],
          }
        }
        if (from && !to)
          return { actions: [say(`$${from.symbol} is real here, but "${mig[2]}" did not match a basket on ${chainName(ctx.chainId)}. Name the target basket (ask "what baskets are there?" to see them).`)], ctx, chips: ['What baskets are there?'] }
        if (!from && to)
          return { actions: [say(`"${mig[1]}" did not match a basket you could migrate from on ${chainName(ctx.chainId)}. Ask "what do I hold?" and pick from there.`)], ctx, chips: ['What do I hold?'] }
      }
    }

    // ── "make it $100": an amount with no new object edits the last trade ────
    if (ctx.lastTrade && AMOUNT.test(text) && !TICKER.test(text) && !ADDR.test(text)) {
      const residue = t
        .split(' ')
        .filter((w) => !/^(make|it|that|this|actually|instead|change|to|do|lets|try|amount|rather|no|wait|hmm|ok|okay|of|worth|usd|usdc|dollars?|bucks?)$/.test(w))
        .filter((w) => !/^\$?[\d,]+(\.\d+)?$/.test(w))
      if (residue.length === 0 && ctx.lastTrade.chainId === ctx.chainId) {
        const m2 = text.match(AMOUNT)
        const amt = m2 ? amtNum(m2[1] ?? m2[2]) : null
        const data2 = await cachedBasket(ctx.lastTrade.address, ctx.chainId)
        if (data2 && amt != null && Number.isFinite(amt) && amt > 0)
          return {
            actions: [{ kind: 'trade', chainId: ctx.chainId, side: ctx.lastTrade.side, basket: data2, amountUsd: amt }],
            ctx,
            celebrate: true,
          }
      }
    }

    // ── buy / sell ──────────────────────────────────────────────────────────
    const sellIntent = hasWord(t, ['sell', 'dump', 'offload', 'liquidate']) || hasPhrase(t, ['trim my', 'reduce my'])
    // 'get me' minus the exit's own phrase: a bare "get me out" was becoming a
    // BUY ask (the new exit probe caught it — pre-existing)
    const buyIntent =
      /\bbuy\b/.test(t) || hasWord(t, ['purchase', 'invest', 'grab']) || /\bput\b.{0,40}\b(into|in)\b/.test(t) || (hasPhrase(t, ['get me', 'ape into', 'ape in']) && !/get (me )?out/.test(t))
    if ((buyIntent || sellIntent) && !(interrogative && !AMOUNT.test(text) && !TICKER.test(text) && !ADDR.test(text))) {
      const side = sellIntent && !buyIntent ? 'sell' : 'buy'
      const m = text.match(AMOUNT)
      const amountParsed = m ? amtNum(m[1] ?? m[2]) : wordAmount(t)
      // a non-finite parse is "no amount" (the ask-how-much path handles it),
      // never a NaN that would ride into a trade card
      const amountUsd = amountParsed != null && Number.isFinite(amountParsed) && amountParsed > 0 ? amountParsed : null
      // "with 1% slippage" / "1% slip" rides into the card's dial (bounds the
      // card's own: 10..2000 bps)
      const slipM = /(\d+(?:\.\d+)?)\s*%\s*(?:slip(page)?)|slip(?:page)?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*%/.exec(t)
      const slippageBps = slipM ? Math.min(2000, Math.max(10, Math.round(Number(slipM[1] ?? slipM[3]) * 100))) : undefined
      let found = await findBasket(ctx.chainId, text)
      // "buy $25 of it" / "buy some" — a pronoun or a truly objectless trade
      // rides the basket the exchange is already about (the exit path's law)
      if (!found && ctx.lastBasket && ctx.lastBasket.chainId === ctx.chainId) {
        const objectless =
          !TICKER.test(text) &&
          !ADDR.test(text) &&
          stripChainWords(t.split(' ')).filter(
            (w) =>
              !/^(buy|sell|purchase|invest|grab|dump|offload|liquidate|trim|reduce|get|ape|into|in|of|worth|for|me|my|it|that|this|one|some|same|again|more|the|a|an|usd|usdc|dollars?|bucks?|please)$/.test(w) &&
              !/^\$?\d+(\.\d+)?$/.test(w),
          ).length === 0
        if (objectless) found = { address: ctx.lastBasket.address, symbol: '', name: '' }
      }
      if (!found) {
        const list = await cachedList(ctx.chainId)
        return {
          actions: [
            say(`Which basket? On ${chainName(ctx.chainId)} I can see: ${list.map((b) => `$${b.symbol}`).join(' · ') || 'none yet'}. Name one, or paste its address.`),
          ],
          ctx: { ...ctx, pending: { intent: side, amountUsd } },
        }
      }
      // MULTI-BUY: "buy $25 each of SVI and TRINITY" → one card per basket
      if (side === 'buy' && amountUsd != null && /\beach\b/.test(t)) {
        const words = stripChainWords(text.split(/\s+/)).map((w) => w.replace(/^\$/, '').replace(/[^A-Za-z0-9]/g, ''))
        const hits: { address: Address; symbol: string }[] = []
        for (const w of words) {
          if (!/^[A-Za-z0-9]{2,12}$/.test(w) || /^\d+$/.test(w)) continue
          const f2 = await findBasket(ctx.chainId, w).catch(() => null)
          if (f2 && f2.symbol && !hits.some((h) => h.address === f2.address)) hits.push({ address: f2.address, symbol: f2.symbol })
          if (hits.length === 4) break
        }
        if (hits.length >= 2) {
          // ONE ORCHESTRATED CARD, not N live ones (owner 2026-08-21). This used
          // to return a trade card per basket — four armed primaries at once and
          // nothing sequencing them. MultiBuyCard shows the whole order, takes
          // one press, and then walks the REAL trade card through them one at a
          // time.
          const found2: BasketData[] = []
          for (const h of hits) {
            const d2 = await cachedBasket(h.address, ctx.chainId)
            if (d2) found2.push(d2)
          }
          if (found2.length >= 2) {
            ctx.lastBasket = { address: hits[hits.length - 1].address, chainId: ctx.chainId }
            return {
              actions: [
                say(`$${amountUsd} into each of ${found2.length}, one at a time so you see every price before you take it.`),
                { kind: 'multiBuy', chainId: ctx.chainId, baskets: found2, amountUsd, slippageBps },
              ],
              ctx,
              celebrate: true,
            }
          }
        }
      }
      // a BUY with no amount ASKS the person (owner 2026-08-20: never default
      // a dollar figure) — the answer rides the pending slot below
      if (side === 'buy' && amountUsd == null) {
        const sym = found.symbol || 'it'
        ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
        return {
          actions: [say(`How much would you like to put into ${found.symbol ? `$${found.symbol}` : 'it'}? Name a dollar amount.`)],
          ctx: { ...ctx, pending: { intent: 'buy', basket: { address: found.address, symbol: sym } } },
          chips: ['$25', '$100', '$500'],
        }
      }
      const data = await cachedBasket(found.address, ctx.chainId)
      if (!data) return { actions: [say(`${found.symbol ? `$${found.symbol}` : 'That basket'} did not read on ${chainName(ctx.chainId)}.`)], ctx }
      ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
      ctx.lastTrade = { side, address: found.address, chainId: ctx.chainId }
      // FRACTIONAL SELLS ("sell half my X", "sell a quarter", "sell 30% of
      // it", "sell everything"): read the holder's REAL balance and preset the
      // card in SHARES — the sell side is denominated in the basket token, so
      // dollars were never the right unit here
      let sharesAmount: string | undefined
      let fracNote: string | undefined
      if (side === 'sell' && ctx.account) {
        const pct = /(\d{1,2}(?:\.\d+)?)\s*%/.exec(t)
        const frac = /\b(half)\b/.test(t) ? 0.5 : /\b(a )?quarter\b/.test(t) ? 0.25 : /\b(all|everything|the lot|whole)\b/.test(t) ? 1 : pct ? Math.min(100, Number(pct[1])) / 100 : null
        if (frac != null && frac > 0) {
          const raw = (await clientFor(ctx.chainId)
            .readContract({ address: found.address, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [ctx.account] })
            .catch(() => 0n)) as bigint
          if (raw > 0n) {
            // integer math on raw units, formatted once — no float share sizing
            const part = (raw * BigInt(Math.round(frac * 10_000))) / 10_000n
            const human = Number(part) / 1e18
            sharesAmount = human.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false })
            fracNote = `${frac === 1 ? 'Everything you hold' : frac === 0.5 ? 'Half your balance' : frac === 0.25 ? 'A quarter of your balance' : `${Math.round(frac * 100)}% of your balance`}: ${sharesAmount} shares, read from the chain just now.`
          } else {
            fracNote = 'This wallet holds no shares of it right now, so nothing was preset.'
          }
        }
      }
      return {
        actions: [
          {
            kind: 'trade',
            chainId: ctx.chainId,
            side,
            basket: data,
            amountUsd,
            sharesAmount,
            slippageBps,
            note: side === 'sell' ? [fracNote, 'Pooled sell. If a leg is parked, redeem in kind always works.'].filter(Boolean).join(' ') : undefined,
          },
        ],
        ctx,
        celebrate: true,
      }
    }

    // ── exit / redeem — BOTH doors in the chat (owner law: primary flows
    // never leave it; the old answer linked out to a basket-page redeem
    // control that never existed — the chat card IS the site's first
    // standalone redeem surface) ────────────────────────────────────────────
    if ((hasWord(t, ['exit', 'redeem', 'withdraw']) || hasPhrase(t, ['get out', 'get me out', 'cash out', 'leave the basket', 'in kind'])) && !/^(what|whats)\b/.test(t)) {
      const found = (await findBasket(ctx.chainId, text)) ?? (ctx.lastBasket ? { address: ctx.lastBasket.address, symbol: '', name: '' } : null)
      if (!found) return { actions: [say('Which basket do you want out of? Name it, paste its address, or ask "what do I hold?" first.')], ctx }
      const exitData = await cachedBasket(found.address, ctx.chainId)
      if (!exitData) return { actions: [say(`That basket did not read on ${chainName(ctx.chainId)}.`)], ctx }
      ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
      // an explicitly in-kind ask gets the redeem card alone; a general exit
      // shows both doors
      if (hasWord(t, ['redeem']) || hasPhrase(t, ['in kind']))
        return {
          actions: [
            say(`The unconditional exit: burn $${exitData.symbol} shares, receive every leg pro-rata. No pool, no floor, works even when a sell cannot.`),
            { kind: 'redeem', chainId: ctx.chainId, data: exitData },
          ],
          ctx,
          chips: [`Sell $${exitData.symbol}`, 'What do I hold?'],
        }
      // ONE WAY OUT ON SCREEN (owner 2026-08-21, the one-button audit). This
      // used to speak an enumerated menu — "Two ways out", "1 · SELL",
      // "2 · REDEEM" — and render BOTH live transaction cards at once, which is
      // the multiple-options state at its most literal.
      //
      // Selling and redeeming stay two real capabilities, because they are
      // genuinely different outcomes rather than one flow split in half. What
      // changed is that only the one they asked for is PUT IN FRONT of them:
      // a bare "exit" means settlement dollars, so the sell card leads, and the
      // in-kind door is one sentence they can take. Saying "redeem" or "in kind"
      // still opens the redeem card alone, as it always did (branch above).
      return {
        actions: [
          say(`Out of $${exitData.symbol} into settlement, priced now. Say "redeem in kind" instead and you get the underlying tokens themselves, touching no pool, which works even when a sell cannot.`),
          { kind: 'trade', chainId: ctx.chainId, side: 'sell', basket: exitData, amountUsd: null },
        ],
        ctx,
        chips: [`Redeem $${exitData.symbol} in kind`, 'What do I hold?'],
      }
    }

    // ── list baskets ────────────────────────────────────────────────────────
    if (((/\b(list|show|what|which|see|all|available|browse|explore)\b.*\bbaskets?\b/.test(t) && !/\bmy\b/.test(t)) || /^baskets?\b/.test(t) || hasPhrase(t, ['what exists', 'what is there', 'whats there'])) && !/apy|yield|airdrop|rug|makes|good|pay|fee|cost|rebalance|private|delete|if a token|should i|worth|recommend/.test(t)) {
      const list = await cachedList(ctx.chainId)
      if (list.length === 0) return { actions: [say(`The factory on ${chainName(ctx.chainId)} answered empty. No baskets there yet.`)], ctx }
      return {
        actions: [{ kind: 'baskets', chainId: ctx.chainId, rows: list.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) }],
        ctx: { ...ctx, lastIntent: { kind: 'baskets' } },
      }
    }

    // ── read one basket (ticker, address, name, or "it") ────────────────────
    const readWords = (hasWord(t, ['read', 'open', 'check', 'inspect', 'details', 'info']) || hasPhrase(t, ['what is in', 'whats in', 'tell me about', 'look at', 'show me', 'more about'])) && !hasPhrase(t, ['open source'])
    if (ADDR.test(text) || TICKER.test(text) || readWords) {
      const found = await findBasket(ctx.chainId, text)
      if (found) {
        ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
        return { actions: [await readBasketAction(ctx.chainId, found.address)], ctx }
      }
      if (/\bit\b|\bthat\b/.test(t) && ctx.lastBasket)
        return { actions: [await readBasketAction(ctx.lastBasket.chainId, ctx.lastBasket.address)], ctx }
      // a read ask with NOTHING named ("Read a basket") gets the rail + the
      // armed slot, never the generic fallback
      if (readWords && !ADDR.test(text) && !TICKER.test(text)) {
        const list = await cachedList(ctx.chainId)
        if (list.length > 0)
          return {
            actions: [
              say('Which one? Tap a card or name it:'),
              { kind: 'baskets', chainId: ctx.chainId, rows: list.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) },
            ],
            ctx: { ...ctx, pending: { intent: 'read' } },
          }
      }
    }

    // ── live ETH price (the chain's own read, the same one NAV math uses) ───
    if (/^(what is |whats |hows )?(the )?(eth|ethereum) price( now| today)?$/.test(core) || /price of (eth|ethereum)\b/.test(t) || /how much is (eth|ethereum)\b/.test(t)) {
      const p = await nativeEthUsdOnChain(ctx.chainId).catch(() => null)
      return {
        actions: [
          say(
            p != null
              ? `ETH is $${p.toLocaleString(undefined, { maximumFractionDigits: 2 })} right now, read from ${chainName(ctx.chainId)}'s own pools, the same figure the NAV math uses.`
              : `The ETH price did not read on ${chainName(ctx.chainId)} just now. Try again in a moment.`,
          ),
        ],
        ctx,
        chips: STEER,
      }
    }

    // ── live TVL ("whats the tvl here") — summed from the factory's own list ─
    if (/\btvl\b|total (aum|value locked|deposits)|how much (money|value) is (in|on|here)/.test(t)) {
      const list = await cachedList(ctx.chainId).catch(() => [])
      if (list.length > 0) {
        const total = list.reduce((s, b) => s + (b.aumUsd || 0), 0)
        const fmt = total >= 1e6 ? `$${(total / 1e6).toFixed(2)}M` : `$${Math.round(total).toLocaleString()}`
        return {
          actions: [say(`${fmt} across ${list.length} baskets on ${chainName(ctx.chainId)}, summed live from each basket's own AUM read. Ask "on ethereum" or "on robinhood" for the other chains.`)],
          ctx,
          chips: ['Best performers in the last 24 hours?', 'What baskets are there?'],
        }
      }
    }

    // ── live count ("how many baskets…") ────────────────────────────────────
    if (/how many baskets|number of baskets|baskets (exist|are there|launched|live)|total baskets/.test(t)) {
      const list = await cachedList(ctx.chainId)
      return {
        actions: [{ kind: 'baskets', chainId: ctx.chainId, rows: list.map((b) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name) })) }],
        ctx,
        chips: ['Best performers in the last 24 hours?', 'Help me create my own basket'],
      }
    }

    // ── "what were we doing?" — the agent reports its own conversation state
    // from ctx: buckets, the last basket, the open slot ──────────────────────
    if (/what (were|are) we (doing|building|working on)|where (were we|was i)|whats my draft|wheres my draft|what did i (just )?(ask|say)|whats (in )?(the|my) (draft|basket so far)/.test(t)) {
      const parts: string[] = []
      for (const [id, picks] of Object.entries(ctx.drafts ?? {})) {
        if (picks.length) parts.push(`${chainName(Number(id))} draft holds ${picks.map((p) => `$${p.symbol}`).join(' · ')}`)
      }
      if (!parts.length && ctx.draft?.picks.length) parts.push(`your draft holds ${ctx.draft.picks.map((p) => `$${p.symbol}`).join(' · ')}`)
      // (a create-pending cannot reach here: the interrogative release above
      // already parked it — the buckets line carries the draft state)
      if (parts.length === 0 && ctx.lastBasket) parts.push(`we were looking at a basket on ${chainName(ctx.lastBasket.chainId)}`)
      if (parts.length === 0)
        return { actions: [say('Fresh slate, nothing in progress. Pick a thread:')], ctx, chips: STEER }
      return {
        actions: [say(`Where we stand: ${parts.join('; ')}.`)],
        ctx,
        chips: anyBucket(ctx) ? ['Add another asset', 'Start over', 'Best performers in the last 24 hours?'] : STEER,
      }
    }

    // ── the QA bank: the wide question surface, every answer steering to an
    // action (operational intents above always win). A two-question message
    // ("whats the fee and how do i exit") answers BOTH rows when both hit. ───
    const banked = bankAnswer(t, ctx)
    if (banked) {
      const halves = t.split(/\band\b|;|\balso\b/).map((s) => s.trim()).filter((s) => s.length > 3)
      if (halves.length === 2) {
        const b1 = bankAnswer(halves[0], ctx)
        const b2 = bankAnswer(halves[1], ctx)
        const textOf = (r: AgentReply | null) => r?.actions.find((a) => a.kind === 'text')
        const t1 = textOf(b1)
        const t2 = textOf(b2)
        if (b1 && b2 && t1 && t2 && t1.kind === 'text' && t2.kind === 'text' && t1.text !== t2.text)
          return { actions: [...b1.actions, ...b2.actions], ctx, chips: b1.chips ?? b2.chips ?? STEER }
      }
      return banked
    }

    // targeted fallbacks before the generic one: guess from what the message
    // CARRIES rather than sending everyone to help
    if (AMOUNT.test(text)) {
      const list = await cachedList(ctx.chainId).catch(() => [])
      return {
        actions: [say(`Looks like a trade. Which basket, and buy or sell? On ${chainName(ctx.chainId)}: ${list.slice(0, 8).map((b) => `$${b.symbol}`).join(' · ') || 'none yet'}.`)],
        ctx,
        chips: list.slice(0, 3).map((b) => `Buy $${b.symbol}`),
      }
    }
    {
      // a lone word that IS a basket symbol reads it
      const found = await findBasket(ctx.chainId, text).catch(() => null)
      if (found) {
        ctx.lastBasket = { address: found.address, chainId: ctx.chainId }
        return { actions: [await readBasketAction(ctx.chainId, found.address)], ctx }
      }
    }
    // two asks in ONE message ("whats the fee and how do i exit"): the whole
    // string matched nothing, so run each half through the pipeline once —
    // one hop, and only when BOTH halves answer for real
    if (depth === 0) {
      const halves = t.split(/\band\b|;|\balso\b/).map((s) => s.trim()).filter((s) => s.length > 3)
      if (halves.length === 2) {
        const generic = (r: AgentReply) => r.actions.length === 1 && r.actions[0].kind === 'text' && /I did not catch that|To what\?/.test(r.actions[0].text)
        const r1 = await handleInner(halves[0], ctx, 1)
        if (!generic(r1)) {
          const r2 = await handleInner(halves[1], r1.ctx, 1)
          if (!generic(r2)) return { actions: [...r1.actions, ...r2.actions], ctx: r2.ctx, chips: r1.chips ?? r2.chips }
        }
      }
    }

    // did-you-mean BEFORE giving up: fuzzy the message tokens against live
    // basket symbols, then the send lexicon (the lev machinery is already
    // here) — the generic fallback is the least agentic moment in the product
    {
      const toks = t.split(' ').filter((w) => w.length >= 3 && !COMMON.has(w) && !GENERIC_NOUNS.has(w) && !ADD_NOISE.has(w) && !CHAIN_WORDS.has(w))
      if (toks.length > 0 && toks.length <= 6) {
        const list = await cachedList(ctx.chainId).catch(() => [])
        for (const tok of toks) {
          for (const b of list) {
            const sym = b.symbol.toLowerCase()
            if (sym.length >= 3 && tok !== sym && lev(tok, sym, 1) <= 1)
              return {
                actions: [say(`Did you mean $${b.symbol}?`)],
                ctx,
                chips: [`Read $${b.symbol}`, `Buy $${b.symbol}`, 'What baskets are there?'],
              }
          }
        }
        const MEANS: [string, string][] = [
          ['fees', 'How do fees work?'],
          ['exit', 'How do I exit?'],
          ['baskets', 'What baskets are there?'],
          ['holdings', 'What do I hold?'],
          ['movers', 'Best performers in the last 24 hours?'],
          ['create', 'Help me create my own basket'],
          ['referral', 'Get my referral link'],
          ['safe', 'Is it safe?'],
        ]
        for (const tok of toks)
          for (const [w, send] of MEANS)
            if (tok !== w && w.length >= 4 && tok.length >= 4 && lev(tok, w, 1) <= 1)
              return { actions: [say(`Did you mean "${send}"?`)], ctx, chips: [send, 'Help'] }
      }
    }
    // THE ENDLESS CATCH-ALL (owner 2026-08-20: "what can i do here" hit the
    // shrug live). A question NEVER dead-ends: anything question-shaped that
    // survived every intent, the bank, and did-you-mean gets the honest map.
    // Only non-question gibberish keeps the did-not-catch line, and even that
    // carries the map now.
    const lang = langOf(rawText)
    logMissed(text)
    if (interrogative || /^(show me|tell me|explain|walk me|teach me|guide me)\b/.test(core))
      return orientationReply(ctx, lang ? FALLBACK_LEAD[lang] : 'Not one I can answer from the chain, so here is the honest map instead:')
    return orientationReply(ctx, lang ? FALLBACK_LEAD[lang] : 'I did not catch that. The map of what works here:')
  } catch (e) {
    return { actions: [say(`Something refused: ${e instanceof Error ? e.message.split('\n')[0] : 'the chain did not answer'}. Nothing was composed or sent.`)], ctx }
  }
}

export const DEFAULT_AGENT_CTX: AgentContext = { chainId: DEFAULT_CHAIN_ID, account: null, lastBasket: null, pending: null }
