# Supervised execute proof

Everything about `spectrum_execute` is tested to the wallet boundary: the composed-payload registry, the chain-id check, the pre-send `eth_call`, and the send-once guard are proven offline. The one thing the offline suite cannot prove is an actual broadcast, because a real send needs a funded key. This runbook is the single supervised run that closes that gap.

Run it against test contracts you deployed for the purpose, or on a testnet. Never against production, and never with a production key.

## What the operator provides (environment only, never committed)

- `MCP_OPERATOR_KEY`: a throwaway private key holding a little gas on the target test chain. Never a production key. It is read from the environment and never logged.
- The test deployment's addresses (basket, router, factory), wired into a gitignored `.env.local` and clearly labelled as test addresses. Never committed to a shared branch.

## The run

```sh
cd app && npm run mcp:build
# with the test env loaded (.env.local) and MCP_OPERATOR_KEY set:
#   1. compose the smallest safe action against the TEST basket:
#      spectrum_compose_redeem_in_kind (a single call, no approval), or a
#      small spectrum_compose_buy if the test basket is seeded
#   2. execute the returned {to,data,value} verbatim:
#      spectrum_execute re-checks the registry, the RPC chain id, and
#      eth_call from the operator account, sends, and reports the receipt
```

## What the proof confirms

- The registry admits a payload the server composed this session (it refuses any other; that half is already unit-proven).
- The chain-id and `eth_call` gates pass against a live network.
- A real transaction lands and the receipt reads back `status: success`, with any tokens delivered to the operator account reported from the receipt's own events.
- A second execute of the same payload refuses and names the existing transaction hash.

## Rules

Test addresses live in the environment only: labelled, gitignored, never committed, never pointed at by production configuration. If a test address ever heads toward a shared branch or a live deployment config, stop; an immutable contract wired into production cannot be undone. The production key never touches this proof.
