# Changelog

Newest first. Every release bumps `version.json` (the machine-read update manifest —
deployed sites compare their built-in version against the raw copy of that file) and adds
a section here. The two must always carry the same version string; the app reads its own
version FROM `version.json`, so bumping the json is the whole code-side release step.

## 2026.07.11

- New canonical Spectrum contracts on Base and Ethereum (fresh factories + routers).
- Robinhood Chain (4663) ships live as a third chain: wallet connect + chain toggle,
  launch (Dutch auction), USDG-direct buy/sell and referral through the canonical
  router, contract verification, and the config/doctor/chain-smoke checks. USDG
  (Global Dollar) is the settlement asset there; labels follow the chain.

## 2026.07.10

- First public release: the complete operator front end (React 19, zero backend), the
  in-site `/setup` studio, the agent-run setup flow (`START-HERE.md`), five design styles
  with per-style structure and fonts, the canonical Spectrum contracts wired by default
  on Base and Ethereum, `/verify` contract verification, zip-drop + VPS hosting paths,
  and the `doctor` / chain-smoke self-checks.
