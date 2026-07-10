# One-click deploy buttons

The fastest path: a button that clones the project to your GitHub **and** connects your host in
one flow. This page has (a) the buttons for **you, the deployer**, and (b) the exact config for
**whoever maintains the template repo** to embed them.

> **Template repo:** `Irora-dev/Spectrum` — the kit's public home.

---

## A. For deployers — just click

> **Which one?** For a site that earns fees, **Cloudflare** is the safer free pick — its free
> tier permits commercial use. **Vercel's** free Hobby tier is non-commercial per their terms
> (you may need a paid plan), though its button is the smoothest. Both produce the same site.

### Vercel (smoothest — prompts you for every value)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIrora-dev%2FSpectrum&env=VITE_FACTORY_ADDRESS,VITE_INTERFACE_TAG_ADDRESS,VITE_LAUNCHER_ADDRESS,VITE_ALCHEMY_API_KEY&envDescription=Spectrum%20Mini%20config%3A%20factory%20%2B%20your%20fee%20wallet%20%2B%20RPC&envLink=https%3A%2F%2Fgithub.com%2FIrora-dev%2FSpectrum%23configuration&project-name=my-spectrum-site&repository-name=my-spectrum-site)

What happens: Vercel forks the template into your GitHub, then shows a form with one field per
env var. Fill them from [README.md](README.md) and deploy — that gives you a working info-only
site; arm transactions with the `VITE_ENABLE_*` flags in the dashboard afterward.

### Cloudflare (clones + connects; you add env vars in the dashboard)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Irora-dev/Spectrum)

What happens: Cloudflare copies the template into your GitHub and creates a Pages project with
the Vite build detected. It does **not** always prompt for env vars, so after it builds, set
them in the dashboard and redeploy — exactly the
[Cloudflare Pages steps 4–5](cloudflare-pages.md#4-set-the-environment-variables).

> If a button ever stalls or the build settings look wrong, don't fight it — use
> **[Use this template](github-template.md)** then **[connect your host](cloudflare-pages.md)**.
> Same result, fully spelled out.

---

## B. For the template maintainer — embed the buttons

Put both badges near the top of the **template repo's** `README.md`. Keep them in sync with the
env names in [README.md](README.md) — if an env var is renamed, the Vercel URL must change too.

### Vercel button (Markdown)

```md
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIrora-dev%2FSpectrum&env=VITE_FACTORY_ADDRESS,VITE_INTERFACE_TAG_ADDRESS,VITE_LAUNCHER_ADDRESS,VITE_ALCHEMY_API_KEY&envDescription=Spectrum%20Mini%20config&envLink=https%3A%2F%2Fgithub.com%2FIrora-dev%2FSpectrum%23configuration&project-name=my-spectrum-site&repository-name=my-spectrum-site)
```

The query parameters, decoded:

| Param | Value | Purpose |
|---|---|---|
| `repository-url` | the template repo URL | what Vercel clones |
| `env` | `VITE_ALCHEMY_API_KEY` | the one field Vercel must prompt for (tier/site URL/fee wallet travel committed in `app/src/site.config.json`) |
| `envDescription` | short help text | shown above the form |
| `envLink` | link to the config docs | the "Learn more" link |
| `project-name` / `repository-name` | `my-spectrum-site` | sensible defaults the user can rename |

> These four produce a working **info-only** site (browse/read). Vercel marks them required on
> the form; `VITE_ALCHEMY_API_KEY` can be left as a single space to use a public node. To arm
> transactions (creation / fees / buy-sell) the operator adds the `VITE_ENABLE_*` flags — and
> `VITE_SWAP_ROUTER_ADDRESS` for buy/sell — in the dashboard after the first deploy (they don't
> belong in a one-click form). See [README.md](README.md).

### Cloudflare button (Markdown)

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Irora-dev/Spectrum)
```

The `url` param is just the template repo. Cloudflare detects the Vite build. To pre-fill build
settings (and avoid surprises), the template can include a `wrangler.jsonc`/Pages build config;
env vars are still set in the dashboard the first time. Because of that, **document the
dashboard env step right next to this button** so Cloudflare users aren't left with an empty
site.

### Keep these honest

- **One source of truth for env names:** [README.md](README.md). When it changes, update the
  Vercel `env=` list and the table here in the same PR.
- **No addresses in any button URL.** The buttons carry variable *names* only — never bake a
  factory, router, or fee-wallet address into a link (red line: no baked addresses / no default
  fee recipient).
- **Custom domain is always a post-deploy dashboard step** on both hosts — link users to
  [Cloudflare](cloudflare-pages.md#5-add-your-custom-domain) /
  [Vercel](vercel.md#5-add-your-custom-domain).

---

← Back to [README.md](README.md) · See also [Use this template](github-template.md)
