// Indexing reference, shared by /docs and /integrate: the canonical events with
// their topic0 hashes, verified-source links, and the edge cases an indexer's
// developers hit first. Everything is COMPUTED from the shipped ABIs
// (lib/spectrum/abis-v2.ts) and the live chain config at render, so this
// section can never drift from what the app itself transacts through.
// House style: no em dashes in shown copy.
import { parseAbiItem, toEventSelector, type Abi, type AbiEvent } from 'viem'
import { Callout, Checklist, CopyChip, IC, Table } from './DocKit'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { basketAbi, launchedEvent, swapRouterAbi } from '../lib/spectrum/abis-v2'

// Emitted by the basket at initialize() with its immutable fee config. The app
// itself never decodes it (fee state is read via views), so it lives here as
// documentation rather than in the transacting ABI set (abis-v2.ts documents it
// next to the Launched event).
const feeConfiguredEvent = parseAbiItem(
  'event FeeConfigured(uint16 basketFeeBps, uint16 creatorShareBps, address creatorPayout, address launcher)',
)

function signatureOf(ev: AbiEvent): string {
  const args = ev.inputs
    .map((i) => `${i.type}${'indexed' in i && i.indexed ? ' indexed' : ''}${i.name ? ` ${i.name}` : ''}`)
    .join(', ')
  return `${ev.name}(${args})`
}

// parseAbi returns narrow literal tuples; widen to Abi so a plain event filter types.
const eventsOf = (abi: Abi): AbiEvent[] => abi.filter((i): i is AbiEvent => i.type === 'event')

const EVENT_ROWS: { contract: string; ev: AbiEvent; note: string }[] = [
  { contract: 'Factory', ev: launchedEvent, note: 'One per basket created; ethPaid is the auction price.' },
  { contract: 'Basket', ev: feeConfiguredEvent, note: 'Once at initialize; the immutable fee economics.' },
  ...eventsOf(basketAbi as Abi)
    .map((ev) => ({
      contract: 'Basket',
      ev,
      note:
        ev.name === 'MintedInKind'
          ? 'In-kind mint; per-leg amounts ride the tx calldata, not the event.'
          : ev.name === 'FeesClaimed'
            ? 'Holder pulled accrued fees.'
            : ev.name === 'FrontendFeesFlushed'
              ? 'Interface / launcher / creator accrual pushed out by the crank.'
              : ev.name === 'PrismBurnBridged'
                ? 'Burn-share settlement left for the L1 burner.'
                : 'Lazy-burn queue settled (see the supply note below).',
    })),
  ...eventsOf(swapRouterAbi as Abi)
    .map((ev) => ({
      contract: 'Swap router',
      ev,
      note: 'One per buy or sell: tokenIn is the settlement asset on buys, the basket on sells.',
    })),
]

export function IndexingReference() {
  const chains = SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id]).filter((c) => c.factory)
  return (
    <div className="space-y-4">
      <Table
        head={['Contract', 'Event (canonical signature)', 'topic0']}
        rows={EVENT_ROWS.map(({ contract, ev, note }) => [
          <b key={`${contract}${ev.name}`}>{contract}</b>,
          <span key={`sig${ev.name}`}>
            <IC>{signatureOf(ev)}</IC>
            <span className="mt-1 block text-[12px] text-ink-faint">{note}</span>
          </span>,
          <CopyChip key={`t${ev.name}`} text={toEventSelector(ev)} label={`${toEventSelector(ev).slice(0, 10)}…`} />,
        ])}
      />
      <Checklist
        items={[
          <>
            Trades: the router's <IC>Swapped</IC> is the complete feed. Pool-level fills also appear
            as v4 <IC>PoolManager.Swap</IC> with <IC>poolId</IC> derived from the basket's own{' '}
            <IC>selfKey()</IC>.
          </>,
          <>
            Supply has two numbers: sells can queue burns, so <IC>totalSupply()</IC> ≥{' '}
            <IC>effectiveSupply()</IC>. NAV per token divides by <IC>effectiveSupply()</IC>.
          </>,
          <>
            Fees are pull-based: value accrues in views (<IC>feeReserve()</IC>,{' '}
            <IC>pendingFrontendFees(fe)</IC>) and moves only when the permissionless cranks fire,
            not per trade.
          </>,
          <>
            <IC>currentDeployPrice()</IC> REVERTS between auction slots. That is an honest state
            (one deploy per slot), not an outage.
          </>,
          <>
            Settlement asset per chain: the factory's <IC>USDC()</IC> immutable (USDC on Base and
            Ethereum, USDG on Robinhood Chain), always 6 decimals; baskets are always 18.
          </>,
          <>
            The factory and router are one CREATE2 build: identical addresses on Base and Robinhood
            Chain. Key uniqueness on (chainId, address), never the address alone.
          </>,
          <>
            Token address == hook address (CREATE2-mined to carry the v4 <IC>0x88</IC> permission
            bits), and pool liquidity fields read ~0 by design: reserves live in the basket, so
            depth is <IC>totalReserve()</IC>, never pool reserves.
          </>,
        ]}
      />
      <Callout variant="note" title="ABI and verified source">
        <p>
          The full JSON ABI is on each contract's explorer page
          {chains.length ? (
            <>
              {' '}
              (
              {chains.map((c, i) => (
                <span key={c.chainId}>
                  {i > 0 && ' · '}
                  <a className="text-cyan press" href={`${c.explorer}/address/${c.factory}`} target="_blank" rel="noreferrer">
                    {c.name} factory
                  </a>
                  {c.swapRouter && (
                    <>
                      {', '}
                      <a className="text-cyan press" href={`${c.explorer}/address/${c.swapRouter}`} target="_blank" rel="noreferrer">
                        router
                      </a>
                    </>
                  )}
                </span>
              ))}
              )
            </>
          ) : null}
          , and the maintained typed interface set ships in this kit at{' '}
          <IC>app/src/lib/spectrum/abis-v2.ts</IC>. Basket tokens are factory-deployed, one contract
          per basket; discover them via <IC>Launched</IC> or the factory enumeration.
        </p>
      </Callout>
    </div>
  )
}
