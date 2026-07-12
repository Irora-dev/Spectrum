# Spectrum Mini

[![release proof](https://github.com/Irora-dev/Spectrum/actions/workflows/release-proof.yml/badge.svg)](https://github.com/Irora-dev/Spectrum/actions/workflows/release-proof.yml)
[![daily canary](https://github.com/Irora-dev/Spectrum/actions/workflows/canary.yml/badge.svg)](https://github.com/Irora-dev/Spectrum/actions/workflows/canary.yml)

**Stand up your own front end for Spectrum basket tokens — in about 15 minutes, no code required.**

Spectrum Mini is a free, open-source kit. It takes anyone — including non-developers — from
nothing to a live, themed website where people can **launch, discover, and trade basket tokens**,
wired straight to the already-deployed Spectrum contracts. You host it, under your own name, on
your own infrastructure. It's yours to run.

> **Basket tokens**, always — never "index," "fund," or "ETF." A basket is a single on-chain token
> that holds a fixed set of underlying assets at fixed weights, fully collateralised by them.

## Who this is for

- **Non-developers** who want their own launchpad/marketplace site — follow **[`START-HERE.md`](START-HERE.md)**: open an AI coding assistant and paste that file in as your first message. It walks you through it.
- **Developers** who want to fork, theme, and host it themselves — read on, then the deploy guides in **[`docs/deploy/`](docs/deploy/)**.

## Three ways in

1. **Paste one prompt into an AI assistant** — the guided path ([`START-HERE.md`](START-HERE.md)).
2. **Run the setup wizard** — `create/` writes your site's config from a few questions (or use the in-site **`/setup`** studio once the app is running — design in the browser with a live preview; in dev, **Apply** writes your config straight into the project).
3. **Fork the template + deploy** — see [`docs/deploy/`](docs/deploy/) (Cloudflare Pages / Vercel, with a custom domain).

Each path ends the same way: a Vite + React site, themed to your colours, listing **every** basket
on your chain, ready to deploy to free hosting.

> Some packaging conveniences (a one-click deploy button, a standalone template repo) are still
> landing — where a step isn't turnkey yet, the guides say so and give you the manual path.

## Releases you can trust

Every commit on `main` is a complete, versioned, tagged release, re-proven by CI in a fresh clone
(the badges above), with the basket **launch** and **trading** code paths under a declared-and-
checked guard and a daily live-chain canary. What that means for your site — updating, pinning,
rolling back, recall notices — is one page: **[`docs/RELEASES.md`](docs/RELEASES.md)**.

## What you configure

You supply a handful of values (the wizard asks for them in plain language):

- your **site name** (can't contain "Spectrum") and look (colours / style),
- which **pages** to show (launch / discover / trade),
- **your own fee wallet**, and optionally an RPC endpoint,
- and only if you serve your **own** deployment: its factory / router addresses —
  the canonical Spectrum contracts ship as the working default.

## How the fee works (plainly — this is a description, not a pitch)

The Spectrum contracts (not this kit) charge a small fee on basket activity. A fixed share of that
fee is routed to whatever wallet an interface tags — so if you run a site and point it at **your
own wallet**, the contracts pay your wallet that share: roughly **5% of the fee for launches** your
site originates and **5% of the fee for trades** it carries. A fixed **10% of every fee is burned
toward PRISM**. You configure only your **wallet** — the percentages are fixed by the contracts and
are never a setting. Leave the wallet blank and that share simply isn't taken. That's the whole
arrangement, stated so you understand it before you decide to run a site — see
[`DISCLAIMER.md`](DISCLAIMER.md).

## Safety & neutrality (load-bearing — please keep these intact)

- **The canonical Spectrum contracts ship** (in `deployments.json`) so the site works on deploy;
  override any address via config to run on your own deployment. **Verify every contract address
  yourself** against a canonical source before you route any value through it.
- **No default fee recipient**, ever. The fee wallet is *yours*; unset means the share isn't taken —
  it never silently defaults to anyone.
- **Discovery is global.** Every site lists every basket via the factory's on-chain enumeration —
  no per-site allowlist or curation.
- **"Powered by Spectrum Mini"** stays on generated sites, and **no site may be named "Spectrum…"**
  (that's the protocol brand). Your site is your own; it is not official, endorsed, or operated by
  anyone but you.

## Not advice

This is **software**, provided "as is", and it is **not** legal, financial, tax, or investment
advice, nor an offer or solicitation. If you deploy a site with it, **you** operate it and are
responsible for it — including classifying the basket tokens in your jurisdiction, any sanctions
screening / geofencing, and KYC/AML if you ever add a fiat on-ramp (this kit is non-custodial and
ships none). **Please read [`DISCLAIMER.md`](DISCLAIMER.md) before you deploy.**

## Builders

For all builders looking to use the open-source Spectrum kit: email
**[developer@iroracapital.com](mailto:developer@iroracapital.com)** with questions — and to
announce any live sites you launch with it. We'd love to hear what you build. (Announcing a
site doesn't make it official or endorsed — every deployment stays its operator's own.)

## License

Spectrum Mini is free, open-source software — a **tool, not a venue**. Its creators operate,
host, control, and curate none of the sites, baskets, or transactions made with it, and using it
creates no relationship with them.

The kit's original contributions are dedicated to the public domain under
**[CC0 1.0 Universal](LICENSE)** — no rights reserved, no attribution required. Build on it, fork
it, ship it. The kit's third-party npm dependencies keep their own upstream licenses; CC0
covers this kit's original work, not those.
