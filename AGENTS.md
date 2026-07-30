# AGENTS.md — Spectrum Mini

You are in the **Spectrum Mini kit**: a free, open-source, database-less front end for
Spectrum basket tokens that anyone can theme and self-host. This repo is a **deployable
site**, not a library. Whoever just opened it almost certainly wants *their own branded
site running and deployed*.

**Do this first: read [`START-HERE.md`](START-HERE.md) and follow its 🤖 AGENT RUNBOOK.**
It is the canonical, maintained sequence — welcome the user, launch the visual `/setup`
studio so they design it themselves, wait for their Apply, validate, build, then drive the
hosting hookup. Do not improvise your own onboarding flow.

The full guide, including every red line, is [`CLAUDE.md`](CLAUDE.md) — it is
agent-agnostic despite the filename, and it is the same content whichever tool you are.
Per-tool entry points, all pointing here: `.trae/rules/project_rules.md` (Trae),
`CLAUDE.md` (Claude Code), this file (Codex and other agents that read `AGENTS.md`).

At a glance — `cd app && npm install` (Node 20+) → `npm run dev` and open **`/setup`** →
`npm run check:config` → `npm run build`. Headless alternative:
`node create/index.mjs --help`. Verify code changes from `app/` with
`npx tsc -b && npx vitest run && VITE_SITE_URL=https://example.com npm run build`.

**The red lines, in short — never cross these** (full text in `CLAUDE.md`): never
fabricate or autofill any contract or wallet address, and never introduce a default fee
recipient; the fee wallet comes only from the user, verbatim; every `VITE_*` value and all
of `app/src/site.config.json` ships publicly, so the RPC key lives only in the gitignored
`app/.env.local`; the default tier arms **live** launch and buy/sell on the canonical
contracts, so say so plainly at handover; keep the "powered by Spectrum Mini" attribution;
and never add a database or backend — this kit is DB-less on purpose.
