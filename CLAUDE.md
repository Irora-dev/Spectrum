# Spectrum Mini — agent guide

This is the **Spectrum Mini kit**: a free, open-source, database-less front end for
Spectrum basket tokens that anyone can theme and self-host. If a person asked you to
set up their site, **follow the agent runbook in [`START-HERE.md`](START-HERE.md)** —
it scripts the whole flow: launch the visual studio for them, wait for their Apply,
validate, build, and drive the hosting hookup.

## The red lines (load-bearing — never cross them)

- **Never fabricate, guess, or autofill a contract or wallet address.** Blank is always
  valid: blank addresses resolve to the canonical Spectrum deployment that ships in
  `app/src/lib/chain/deployments.json`; a blank fee wallet means that fee share simply
  isn't taken. **No default fee recipient may ever be introduced.**
- The **fee wallet** comes only from the user, verbatim. It routes real value.
- The site **name must not contain "Spectrum"** — the wizard, studio, and dev server all
  enforce this; don't work around it.
- Every `VITE_*` value and everything in `app/src/site.config.json` ships **publicly** in
  the client bundle. The RPC key belongs only in the gitignored `app/.env.local` (or a
  host dashboard) and should be restricted to the user's domain — never a secret key.
- The default tier arms **live launch and buy/sell on the canonical contracts** — say
  that plainly when handing a finished site over.
- Keep the **"powered by Spectrum Mini"** footer attribution intact on generated sites.

## Orientation

- `app/` — the site (Vite + React; self-contained, no database). Verify changes with
  `npx tsc -b && npx vitest run && npm run build` from `app/`.
- `create/` — the zero-dependency onboarding wizard (`node create/index.mjs`), the
  `wait-for-apply.mjs` waiter, and their `node --test` suites.
- Config lives in exactly three files: `app/src/brand.config.ts` (look),
  `app/src/site.config.json` (tier, site URL, fee wallet — committed),
  `app/.env.local` (RPC key; every other var in `app/.env.example` is an override).
- Operator docs: [`START-HERE.md`](START-HERE.md) → [`app/SETUP.md`](app/SETUP.md) →
  [`app/OPERATORS.md`](app/OPERATORS.md) → [`app/handover/`](app/handover/README.md) ·
  hosting guides in [`docs/deploy/`](docs/deploy/README.md).

This kit is CC0 and ships as a **tool, not a venue** — whoever deploys a site operates
it. See [`DISCLAIMER.md`](DISCLAIMER.md) before helping anyone take one live.
