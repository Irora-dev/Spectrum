# Releases — how this repo ships, and what that means for your site

Your site is a **build of a specific version** of this kit. This page is the contract between
this repo and every site built from it: what a release is, how you know it's safe, how you
update, and how you (or we) roll back.

## Every commit on `main` is a release

This repo receives no work-in-progress. Each commit on `main` is one complete, versioned
snapshot that already passed the maintainer gate (typecheck, the full unit suite, the wizard
suite, a production build, and a live smoke against every supported chain) before it was pushed.
Each release is:

- **Versioned** — `version.json` at the repo root (calver, e.g. `2026.07.12`), with a matching
  section in [`CHANGELOG.md`](../CHANGELOG.md).
- **Tagged** — `v<version>`, so any historical version is one command away
  (`git checkout v2026.07.11`), and pinnable.
- **Published** — a GitHub Release carrying the changelog section plus a proof block of what
  was verified.
- **Re-proven publicly** — the `release-proof` workflow re-runs the whole gate in a fresh clone
  on every release commit, including a **builder simulation** (the wizard → a branded build,
  exactly your first hour). The README badge is that check.
- **Watched daily** — the `canary` workflow re-runs the live chain smoke every day, because the
  kit's behavior depends on live state that can move with zero code change (contracts, RPCs,
  the routing API). If it breaks, an issue labelled `canary` opens here — you find out from us,
  not from your users.

## The sacred systems: launch and trading

Two code paths move user money: the **basket launch system** and the **basket swap/trading
system**. They are registered in [`sacred-paths.json`](../sacred-paths.json) and guarded:

- A release touching them must **declare it** — `"sacred": ["launch"]` (and/or `"swap"`) in
  `version.json`, a `Sacred:` line in its changelog section, and an impact of at least `config`.
- CI **re-checks the declaration** on every release commit (`scripts/sacred-diff.mjs`): an
  undeclared sacred change fails the release's checks, visibly.
- Sacred releases pass an extra **live smoke** before shipping (`npm run smoke:sacred` — you can
  run it yourself): on every supported chain, an existing basket's own legs are fed back through
  a full `deployBasket` simulation (read-only), route detection is checked against the on-chain
  convention, the NAV read surfaces and the USD price anchor are verified, and on Robinhood
  Chain the LiFi hub quote must pass the app's own guards.

So: **if a release doesn't say "Sacred", the money paths did not change.**

## What a version tells you

`version.json` fields your site and tools already read:

| Field | Meaning |
|---|---|
| `version` | The release (calver). Your build carries the version it was built from. |
| `impact` | `safe` = pull, rebuild, redeploy — nothing else to do. `config` = a config key, env var, or build step changed — read the changelog first. `breaking` = the update needs manual work — the changelog section walks it. |
| `sacred` | Which money-path systems this release touched (`[]` almost always). |
| `yanked` | Versions **recalled** after shipping. If your built version appears here, your site's `/setup` studio shows an urgent operator notice and `npm run doctor` fails with the reason — update when you see it. |
| `note` | One human line. |

Your deployed site polls the raw copy of this file (operator-only notice in `/setup`;
`npm run doctor` does the same check in the terminal). Older builds simply ignore the newer
fields — nothing breaks.

## Updating your site

One command, same on macOS, Windows, and Linux (it's plain Node — the kit already needs Node):

```sh
node create/update.mjs          # or: cd app && npm run update:site
```

It tells you what's coming (version, impact, sacred flags, whether YOUR version was recalled),
snapshot-commits your identity first, merges with **theirs-wins on your identity files**
(`app/src/brand.config.ts`, `app/src/site.config.json`, `app/metadata/**` — and `.env.local` is
gitignored, untouchable by updates), then installs, runs `npm run doctor`, builds, and prints
your host's exact redeploy command. Your live site changes only when you redeploy. Every failure
path prints its undo (`git merge --abort` mid-merge, `git reset --hard ORIG_HEAD` after).
The manual equivalent stays documented in [`START-HERE.md`](../START-HERE.md) § *Updating*;
zip-installed sites (no git) get their safe path printed by the script itself.

## Rolling back

- **Your checkout**: `git reset --hard ORIG_HEAD` right after a bad merge (see above), or check
  out any tag and rebuild.
- **Your live site**: a deployed site is a *build* — Cloudflare Pages, Netlify and Vercel all
  keep deploy history with one-click rollback; on your own server keep the previous `dist/`
  beside the live one and swap back (SETUP.md shows the layout). Keeping your last
  `npm run package` zip gives you the same insurance anywhere.
- **This repo**: never rewrites history. A bad release is rolled back **forward** — a new
  release reverts it and the bad version lands in `yanked`, which is what flips the urgent
  notice on affected sites.
