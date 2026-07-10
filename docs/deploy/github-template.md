# Use this template (get your own repo first)

If you'd rather own the code in your GitHub account before connecting a host — or a deploy
button gave you trouble — this is the path. It's still click-only; GitHub does the copying.

> **Template repo:** `https://github.com/Irora-dev/Spectrum` — the kit's public home.

---

## 1. Make your copy

1. Open the template repo: **`https://github.com/Irora-dev/Spectrum`**.
2. Click the green **Use this template** → **Create a new repository**.
3. Name it (e.g. `my-spectrum-site`), choose Public or Private, **Create repository**.

You now have your own independent copy — not a fork, just your files. Nothing links back to the
template.

> Don't see **Use this template**? The source repo hasn't been marked as a template yet — see
> the maintainer note at the bottom. In the meantime you can **Fork** it; the deploy steps are
> identical.

## 2. (Optional) personalize without a terminal

You can edit any file right in GitHub's web editor (press `.` in your repo to open the web
editor, or click a file → pencil icon). Common edits:

- `index.html` — the browser tab title.
- Your site's name, colors, and pages come from the brand config the onboarding wrote — you can
  hand-edit it here too if you know what you're changing.

None of this is required. You can deploy as-is and set the addresses/colors via env vars + the
config file.

## 3. Connect a host and deploy

Pick one and follow its guide from **step 2** onward (you've already done step 1 here):

- **[Cloudflare Pages](cloudflare-pages.md)**
- **[Vercel](vercel.md)**

Each walks you through build settings, the [environment variables](README.md), and the custom
domain.

## 4. Updating later

When the template gets improvements you want, the simplest non-dev route is to re-create from
the template into a fresh repo and re-enter your env vars — your live values live in the host
dashboard, not the code, so nothing important is lost. (Developers can instead pull the
template as a remote and merge.)

---

## Maintainer note — mark the repo as a template

So the green **Use this template** button appears:

1. Open the source repo → **Settings**.
2. Under **General**, tick **Template repository**.

Then make sure the repo's own `README.md` carries the [deploy buttons](deploy-button.md) and a
short **Configuration** section listing the [env vars](README.md) — that anchor is what the
Vercel button's `envLink` points at.

---

← Back to [README.md](README.md) · One-click instead: [deploy buttons](deploy-button.md)
