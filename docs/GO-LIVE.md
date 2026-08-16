# Go-live gates

The checks that decide whether a build is fit to serve, in one place: what runs,
when it runs, what it proves, and the risks we are knowingly accepting at launch.
Written 2026-08-07 as the go-live hardening pass; keep it current as gates change.

## The two tiers

**Per-push (CI, `.github/workflows/branch-gate.yml`)** — runs on every push to a
non-`main` branch, for every worker's lane. This is the floor: nothing merges
toward release without it green.

| Gate | What it proves | Hard-fail on |
|---|---|---|
| `npm run typecheck` (`tsc -b`) | types are sound — **not** bare `tsc --noEmit`, which checks nothing here (the root tsconfig is a `files: []` stub) | any type error |
| `npx vitest run` | the ~1650 unit tests, logic + the source-scan guards | any failing test |
| `npx eslint src --max-warnings=0` | lint + rules-of-hooks | any warning |
| `npm run build` | the production bundle actually builds | build error |
| `npm run budget` | shipped JS has not grown past its ceiling | total > 2200 KB gz, or entry > 700 KB gz |
| `npm audit --audit-level=critical` | no critical advisory | any **critical** (0 today) |
| `npm run smoke:console` | every route mounts in a real browser with no console error, and the a11y floor holds | a route throws / errors / renders nothing / has a nameless control or alt-less image |

**Pre-release (run by hand before cutting a release)** — slower or judgement-bearing:

| Check | Command | Why not per-push |
|---|---|---|
| Mutation testing | `npm run test:mutation` | ~3 min; measures whether the money-module suites are load-bearing. Baseline 81.2%; `break: 79` in `stryker.config.json`. This is the one check that answers "would a test notice if the code were wrong" — the audit series' recurring failure was green suites over live bugs. |
| Full dependency review | `npm audit` | High/moderate are reported in CI but not gated (see accepted risks); a human reads the full list before release and decides. |
| Release proof | push to `main` → `release-proof.yml` | "every commit on `main` is a release"; runs the wizard simulation + sacred-diff. Deliberately separate from branch-gate. |

## What the suites cannot see, and what covers it instead

The unit suite runs in `environment: 'node'`, so it mounts **no components**. Two
source-scanning tests fill that gap without a DOM dependency, the same mechanism
`_redirects` coverage already uses:

- `deployer-strings.guard.test.ts` — fails if a basket's deployer-set name or
  ticker is rendered without `safe-copy` (`showSymbol`/`showName`). This is the
  bidi-override / overlong-string / impersonation class; four live instances of
  it were found in the 2026-08-07 audit, none caught by any existing test.
- `dev-fixture.test.ts` / `redirects-coverage.test.ts` — the demo book's identity
  uniqueness, and an asset rewrite for every nested route.

The console smoke renders the real routes but **cannot** exercise deployer-string
surfaces: fixtures are `import.meta.env.DEV`-only (we do not ship fake baskets),
and the smoke serves a production build. That is why the deployer-string
guarantee is the source guard above, not a smoke assertion.

## Dependency advisories — DONE (was the largest accepted risk)

Both major upgrades were taken (the owner, 2026-08-07), clearing **every high**:
**8 high / 24 moderate → 0 high / 2 moderate, 0 critical.**
- **react-router 7 → 8** — cleared the open-redirect + XSS. The DOM bindings
  merged into the `react-router` package in v8, so `react-router-dom` is gone
  and 68 import sites were rewritten. Verified across all 34 routes.
- **wagmi 2 → 3** (+ `@wagmi/core` 3, `@wagmi/connectors` 8) — cleared the
  `ws`/`viem` chain, and as a bonus slimmed the connector tree AppKit had
  bloated: **shipped JS fell 1947 → 1379 KB gzipped, the web3 chunk 607 → 142
  KB.** The connect dialog was verified to still enumerate every connector
  (Coinbase / Brave / WalletConnect / injected) under wagmi 3.
- **Remaining, accepted:** 2 moderate (`qs` server-side-stringify DoS,
  `typed-rest-client`) — deep transitives, dev/non-client-exploitable, and
  `npm audit fix` cannot clear them without `--force` breaking changes. Not
  go-live blockers.

## Accepted risks at launch (decisions, not oversights)
- **The security stack lives on `spectrum/allocator`, not the release line —
  and reaching it is a measured 62-commit merge, not a transplant.** The CSP,
  credential gate, dependency-integrity gate, P8 displayed-vs-signed gate,
  go-live interlock and 0x-key proxy are all on the allocator lane. This is the
  single biggest go-live gap and no gate here substitutes for it. Measured
  2026-08-07: the lane is 62 commits ahead of `test/rh-deploy`, a full merge
  conflicts in 31 files (the money + string surfaces both lanes rewrote), and
  the security commits CANNOT be cherry-picked in isolation (their files have
  earlier origins — proven). So the absorption is one merge into `test/rh-deploy`
  (the staging line; no release is cut from it), sequenced AFTER (1) the
  adversarial pass over the allocator money commits lands and (2) the
  react-router-dom→react-router sweep runs on the allocator lane. Full map +
  procedure: `the ops repo workspace/spectrum-release/allocator-absorption-plan.md`.
  (The CSP's `/embed` carve-out is already handled on the allocator lane by an
  edge function — commit `325cb55`.)
- **The portfolio engine is `SIMULATED` and no batcher is seated.** Real
  execution is Phase 3; several findings are latent-not-live because of it.
  That is a product state, not a gate failure — but it means the swap/deploy
  paths, not the portfolio, are what a launch actually exposes.

## The dashboard steps no gate can check (operator, before go-live)

- Origin-restrict the **Alchemy** key (it ships in the bundle by design; the
  restriction is the whole protection, and it is metered/billable).
- Set `VITE_WALLETCONNECT_PROJECT_ID` in the **Netlify** build env and add the
  live origins to the **Reown** dashboard allowlist, then redeploy.
