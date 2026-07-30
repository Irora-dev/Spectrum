# Spectrum Mini — project rules

You are working in the **Spectrum Mini kit**: a free, open-source, database-less front
end for Spectrum basket tokens that anyone can theme and self-host. This repo is a
**deployable site**, not a library. If someone has just opened it, they almost certainly
want *their own branded site running and deployed* — that is the job.

## Your first move

**Read [`START-HERE.md`](../../START-HERE.md) and follow its 🤖 AGENT RUNBOOK.** It is the
canonical, maintained sequence (welcome → launch the visual studio → wait for their Apply
→ validate → build → drive the hosting hookup). Do not improvise an onboarding flow, and
do not re-derive it from these rules — this file is a pointer plus the rules that must
hold even before you have opened anything.

Deeper references, when you need them: [`CLAUDE.md`](../../CLAUDE.md) (the same guide in
full), [`app/SETUP.md`](../../app/SETUP.md) (configure → validate → build → deploy),
[`app/OPERATORS.md`](../../app/OPERATORS.md) (every config knob, the product toggles, and
what ships publicly).

## The shape of the job

```sh
cd app && npm install        # Node 20+ required (22 LTS or newer recommended)
npm run dev                  # then open /setup — the user designs their site visually
                             # and presses "Apply to this project" (dev writes the files)
npm run check:config         # validates; also runs automatically before every build
npm run build                # needs a site URL set; `npm run package` zips a drop-ready dist/
```

The headless alternative, when there is no browser or the user prefers questions:
`node create/index.mjs --yes --name "…" --style … [flags]` (`--help` lists them all).
Either path writes the same three files: `app/src/brand.config.ts` (look + which pages
ship), `app/src/site.config.json` (site URL + fee wallet, public by construction), and
`app/.env.local` (the RPC key — gitignored, never committed).

Verify any code change you make from `app/`:
`npx tsc -b && npx vitest run && VITE_SITE_URL=https://example.com npm run build`.

## Red lines — never cross these

- **Never fabricate, guess or autofill a contract or wallet address.** Blank is always
  valid: blank resolves to the canonical Spectrum deployment shipped in
  `app/src/lib/chain/deployments.json`, and a blank fee wallet simply means that fee
  share is not taken. **Never introduce a default fee recipient.**
- The **fee wallet comes only from the user, verbatim.** It routes real value.
- **Every `VITE_*` value and all of `app/src/site.config.json` ships publicly** in the
  client bundle. The RPC key belongs only in the gitignored `app/.env.local` (or the
  host's dashboard) and should be domain-restricted. Never put a secret key anywhere.
- The site **name is the user's own wordmark** (≤32 chars, text only, no logo).
  "Spectrum" is allowed and is the shipped default — take whatever name they give you.
- **The default tier arms live launch and buy/sell on the canonical contracts.** Say that
  plainly when you hand a finished site over; do not let someone deploy believing it is a
  demo.
- Keep the **"powered by Spectrum Mini"** footer attribution intact.
- This kit is **database-less on purpose.** Do not add a backend, a database or a
  server-side service to make a feature work.

## House habits

- Money paths (launch, buy/sell, fee cranks) are the sacred surfaces. Do not loosen a
  guard, a slippage floor or a minimum to make something pass — if a quote or a floor
  looks wrong, say so rather than widening it.
- Never present a failed read as a real zero. "Could not read" and "is zero" are
  different states, and the UI distinguishes them deliberately throughout.
- Do not claim a number is something it is not: a windowed count is not a total, a
  partial sum is not a total, and an estimate is not a guarantee. Match the caption to
  the derivation.
- End every message to the user with exactly one clear next action.
