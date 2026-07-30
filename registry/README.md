# `registry/` — lab-only contract sketches

This is a scratch foundry project for prototyping registry contracts against the
kit. Anything proven here **graduates to the contracts repo**; nothing here is a
source of truth.

## Graduated (do not re-add here)

- **`SpectrumNotes.sol`** → `Irora-dev/spectrum-contracts`,
  `src/registry/SpectrumNotes.sol` (moved 2026-07-29, owner call). Its test suite
  (`test/SpectrumNotes.t.sol`, 11 tests incl. hand-crafted calldata attacks) and
  deploy script (`script/DeployNotes.s.sol`, CREATE2 → the same address on every
  chain) live there too. The kit's E2E (`app/scripts/notes-social-e2e.ts`) reads
  that repo's build artifact, so the bytecode has one source.

## Still here (prototype)

- **`LeaguePool.sol`** — anvil-proven prototype only. Its canonical home is the
  V3 lineage (the fee slice that funds it comes from the V3 factory's split), and
  unlike Notes it HOLDS FUNDS, so it needs the same audit treatment the mainline
  contracts got before real money flows. Do not deploy from here.
- **`MocksForLab.sol`** — test doubles for the above.
