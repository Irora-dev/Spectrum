# Spectrum MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents operate your basket site: discover baskets, read them, and compose transactions to buy, sell, migrate, create, and exit.

It has zero dependencies of its own. The protocol layer is about a hundred lines of newline-delimited JSON-RPC over stdio, and everything that touches money is the app's own code, bundled verbatim at build time. The server and the site can't disagree, because they run the same modules.

## Quickstart

Build the server once, then register it with your MCP client. The build bundles the app's own money modules into a single self-contained file, `mcp/dist/server.mjs`, which `mcp/run.sh` starts. Node 20+ is the only thing you need installed globally; the build borrows esbuild from the app's dependencies, so a fresh clone installs those first.

```sh
cd app && npm install && npm run mcp:build
```

Already run `npm install` in `app/` for the site itself? Then `npm run mcp:build` alone is enough.

For Claude Code, one line registers it:

```sh
claude mcp add spectrum -- /path/to/kit/mcp/run.sh
```

For Claude Desktop (or any client that takes an `mcpServers` config), add:

```json
{
  "mcpServers": {
    "spectrum": { "command": "/path/to/kit/mcp/run.sh" }
  }
}
```

Replace `/path/to/kit` with your checkout. The server starts read-only and compose-only: it can look at chains and prepare transactions for your wallet to sign, and it cannot send anything until you deliberately arm `spectrum_execute` with an operator key (see below). Ask the agent to run `spectrum_health` first; it reports which chains this build supports, whether each RPC answers, and the build's provenance.

## Tools

| Tool | What it does |
|---|---|
| `spectrum_health` | Reports which chains this build supports and whether each RPC answers the right chain, plus build provenance: the kit version and build time stamped into the bundle, and a sha256 digest of the chain and address book actually bundled (a tampered build shows a different digest). Run it first. |
| `spectrum_list_baskets` | Lists every basket the factory knows on a chain. Optional `sort` ("aum" or "change24h", largest first) and `limit` (capped at 100); defaults keep the plain full listing. |
| `spectrum_read_basket` | One basket in full: supply, AUM, NAV with its provenance (on-chain vs reconstructed, partial pricing flagged), and each leg with its symbol, address, and weight. |
| `spectrum_positions` | Which baskets a wallet holds on a chain. Each balance in raw shares (the exact string sell, migrate, and redeem take) and human units. |
| `spectrum_search` | Settles a ticker to a concrete token address with the kit's own discipline: house-pinned beats verified beats 5x liquidity dominance, every supported chain probed, exact-symbol-only across chains. Returns the pick, the contested candidate list, or none. |
| `spectrum_history` | A basket's NAV series over 24h, 7d, or 30d (the same series the app's chart draws) with first, last, change percent, and pricing provenance. |
| `spectrum_compose_redeem_in_kind` | The unconditional exit: `redeemInKind` sends every leg to the holder pro rata. Touches no pool, needs no floor, works even when a pooled sell can't. |
| `spectrum_compose_buy` | Buy shares with settlement. The floor comes from a live simulated fill minus slippage, and the composed bytes are re-simulated before they return. |
| `spectrum_quote_buy` | Read-only preview of a buy: the same live simulation path the compose floors from, returning only numbers and sentences (expected shares, the floor a compose would sign, the price basis). No calldata, nothing registered, nothing executable. |
| `spectrum_quote_sell` | Read-only preview of a sell: simulates the holder's real shares and returns only numbers and sentences (expected settlement out, the floor a compose would sign). No calldata, nothing registered. |
| `spectrum_compose_sell` | Pooled sell into settlement, same simulated floor. Takes `sharesRaw` (exact) or human `shares`, one or the other. A parked leg makes this refuse; the exit still stands. |
| `spectrum_compose_migrate` | Move a holding between baskets in two honest steps: this returns the sell, then you buy the target with the realized proceeds. Two floors, each simulated fresh. |
| `spectrum_compose_create_basket` | Deploy a new basket. Resolves each leg through the kit's route discovery, mines the CREATE2 salt, reads the live deploy price and carries it as a maximum, and returns the deploy calls plus the predicted address. |
| `spectrum_compose_revoke` | Compose `approve(spender, 0)` on a token to withdraw an allowance. The spender defaults to the chain's swap router, the spender the compose tools grant to. Declares zero spend, so an armed execute can always send it. |
| `spectrum_execute` | Off by default. With `MCP_OPERATOR_KEY` set, sends one previously composed call and reports the receipt, including every ERC-20 amount that arrived at the operator account. Bounded by per-transaction and per-session USD ceilings and an optional chain allowlist (see below). Without the key, every tool is compose-only. |

Every compose returns its payload twice: as JSON in the text (with review sentences and a next step), and as the MCP result's `structuredContent` for frameworks that consume results as data. A refusal never carries a payload, and a quote never carries calldata at all.

The server also ships two MCP prompts: `spectrum-safety` (the operating law: address provenance, review-then-confirm, floors never invented, the always-standing exit) and `spectrum-flows` (the worked read, buy, sell, and migrate sequences, including the approval-wait ordering). Any prompt-aware client can load them; they are the same law the Bankr skill text carries.

Read tools answer repeats from a short in-memory cache (health 10s; list, search, history 60s; read, positions 30s) with a "(cached Ns ago)" suffix, so a looping agent cannot hammer the RPC through this server. Composes, quotes, and execute never cache: money runs fresh, every time.

`mcp/tools.json` is the generated manifest of every tool and prompt (name, kind, first sentence), rebuilt by `node mcp/build.mjs` from the live registry. Docs and sites read the manifest; the registry is the only source.

## Safety model

Read this before wiring an agent to money.

- **The server holds no keys and never signs by default.** Compose tools return `{to, data, value}` plus a plain-English review for the wallet on the other side of the agent to sign. That is the shipped posture.
- **Floors are never the agent's.** Every buy and sell floor derives from a live on-chain simulation of the actual trade, minus a bounded slippage (10 to 2000 bps). An agent supplies an amount and a tolerance, nothing else.
- **Composed bytes are proven before they return.** Each compose re-simulates the exact bytes it is about to hand back. Where no allowance stands yet, the proof runs as an `eth_simulateV1` bundle: approve, then swap, from the holder, so the simulation matches the sequence the wallet will actually sign. Unproven bytes never leave the server.
- **Composed bytes are decoded back** and checked to carry exactly the floor, recipient, token, and amount the review states, so the text and the calldata cannot drift apart.
- **Every composed payload passes the calldata lint before it returns.** The same independent lint the app runs at its own wallet seams re-judges composed bytes here: payloads that speak the fee-rail call families run the app's lint strictly (fee rate, native value, floor present, deadline horizon, recipient), and every other payload must decode on the exact ABI it claims. A finding refuses in a sentence naming the law; an unreadable or unknown call never returns.
- **Refusals are sentences.** An unknown chain, a malformed address, a decimal where raw units belong, an unbuyable basket: each says what happened and what to do about it. On-chain reverts are decoded to the protocol's own error names.

## Basket generations (superseded lineages)

A chain can carry more than one contract generation: when a deployment supersedes its factory, the older baskets stay listed and tradable **through their own original router**, and their funding shape belongs to their own factory. The server resolves this per basket, automatically. Composes target the basket's lineage router, so the `swap.to` in a composed payload can legitimately differ from the current deployment book's router; that is expected, not a bug. The funding split is read from the basket's own factory, and `spectrum_read_basket` labels a superseded basket's generation so an agent wiring raw calls knows which router it is dealing with. `spectrum_compose_revoke` takes an optional `holder`: with it, the server reads the live allowances across every router generation and targets the one that actually holds an allowance. Without it, a default-spender revoke on the wrong generation composes a harmless no-op while the real allowance survives. Never hand-pick a router from the deployment book when a basket is involved: ask the tools.

## When a compose refuses (the common diagnoses)

Refusals name their cause; these are the ones worth recognizing on sight:

- **`InsufficientFunds`**: the wallet does not hold enough of the settlement token (USDC or the chain's equivalent) for this trade. The simulation spends the holder's real funds by design. Check the balance, not the pools; no retry, slippage change, or size change helps until the wallet is funded.
- **`LegMinNotMet`**: a protection floor on one constituent refused. A smaller amount working means a thin pool; the same amount working later means a passing burst; no amount ever working means a constituent has no tradeable market right now.
- **"funding split did not resolve"**: the basket's own factory could not say how to apportion the buy. Usually one odd basket, not a chain condition; try another basket to confirm.
- **"cannot be PROVEN on this RPC"**: the endpoint supports neither `eth_simulateV1` nor state overrides and no allowance stands. Seat a provider RPC (see RPC configuration); read-only tools keep working either way.

### What makes `execute` safe to enable

- **It only sends what this server composed.** Every composed payload is fingerprinted; `execute` refuses anything else before touching an account or the network. The operator key cannot be pointed at arbitrary calldata.
- **A sent payload never sends again.** The server remembers each send with its transaction hash, and a repeat refuses by naming the existing transaction. Re-sending the same swap is a double spend, not a retry; a genuinely repeated action needs a fresh compose.
- **Spend ceilings.** Each payload registers the settlement spend it was composed for (a buy declares its `amountUsd`; sells, redeems, approvals, and revokes declare zero; a create's cost is native deploy price, also zero here). `execute` enforces a per-transaction cap (`MCP_EXECUTE_MAX_TX_USD`, default 500) and a per-session cumulative cap over sends that actually happened (`MCP_EXECUTE_MAX_SESSION_USD`, default 1000). A refusal names the number, the cap, and the env knob that raises it; an unreadable cap value refuses every send rather than guessing.
- **Chain allowlist.** Set `MCP_EXECUTE_CHAINS` to a comma-separated list of chain ids (for example `8453`) and `execute` refuses every other chain in a sentence. Unset, every chain in this build's deployment book is eligible. Composing is unaffected either way.
- **The armed banner.** When an operator key is present, the server prints one line to stderr at boot: the sending address derived from the key, the chains execute may send to, and the live caps. The key itself is never printed, and stdout stays pure protocol.
- **Three checks before a nonce is spent:** the fingerprint registry, the RPC's own chain id against the target, and an `eth_call` of the exact payload from the operator account. A revert stops there, in words.
- **The receipt wait is bounded** to 60 seconds and reports "submitted, watch the explorer" rather than hiding a real send behind a timeout.
- **Nothing hangs the wire.** Every tool call has a 90-second backstop, and process-level failures log to stderr without taking the session down.

## Run it by hand

Registration lives in the Quickstart above. To drive the server directly (debugging, scripting), start it and speak newline-delimited JSON-RPC on stdio:

```sh
cd app && npm run mcp:build   # bundles the server with the app's money modules
../mcp/run.sh                 # newline JSON-RPC over stdio, what MCP clients spawn
```

## RPC configuration

The server reads the same environment the app uses: `VITE_MAINNET_RPC_URL`, `VITE_BASE_RPC_URL`, `VITE_ROBINHOOD_RPC_URL`, or a single `VITE_ALCHEMY_API_KEY` that covers all three chains. Unset, the deployment book's public endpoints apply.

Buy and sell quotes simulate the real trade before composing, which needs an RPC that supports either `eth_simulateV1` or `eth_call` state overrides. Provider endpoints (Alchemy and equivalents) support both; some public endpoints support neither, in which case buys and sells refuse rather than guess, while reads, create, and the exit keep working. Seat a provider RPC for live trading.

`MCP_JOURNAL=/path/to/session.jsonl` opts into a session journal: one JSON line per compose and execute (tool, chain, destination, first sentence; never key material, never full calldata). Unset means zero writes; a failed write never breaks a tool.

`spectrum_execute` needs `MCP_OPERATOR_KEY` in the environment and is otherwise inert. The key is never logged. Three more env knobs bound what an armed server may send: `MCP_EXECUTE_MAX_TX_USD` (per-transaction declared-spend cap, default 500), `MCP_EXECUTE_MAX_SESSION_USD` (cumulative cap over the session's actual sends, default 1000), and `MCP_EXECUTE_CHAINS` (comma-separated chain ids; unset means every configured chain).

## How it's built

`mcp/build.mjs` bundles `server.ts` together with the app's own `lib/` modules using esbuild from the app's `node_modules`. No new dependency is introduced anywhere. `import.meta.env.*` maps to `process.env.*` at build time, so the same source runs node-side unchanged. The output, `dist/server.mjs`, is fully self-contained.

The build also stamps provenance into the bundle: the kit version from the repo root `version.json` and the build time, both reported by `spectrum_health` next to a runtime sha256 of the bundled chain and address book.

Tests: `npm run mcp:test` from `app/` builds the bundle and runs the offline suite against the shipped artifact: protocol handshake, tool registry, every refusal path, the execute bounds (ceilings, allowlist, banner), the calldata-lint dispatch, and golden key-shape pins on every `structuredContent` the server emits. No network required.
