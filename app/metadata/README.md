# Site-bundled creator metadata

Drop signed creator-metadata blobs here to make a basket's **thesis, creator profile,
sectors, and launch-post link visible to _every_ visitor** — with no database, no
server, and no external service. The files ship inside the build and are read
in-memory (never fetched), then verified client-side against the basket's on-chain
deployer signature before anything renders.

## How to publish a thesis (no backend)

1. Launch/publish a basket in the app. In the publish step, the creator signs the
   metadata in their own wallet and the app offers a **Download** button.
2. Save the downloaded `<basket>.json` to this folder at the exact convention path:

   ```
   app/metadata/<chainId>/<basket-address-lowercased>.json
   ```

   e.g. `app/metadata/8453/0xabc…def.json` (Base = chain id `8453`).
3. Commit it and redeploy. Done — the thesis is now visible to all visitors.

## Rules

- Path is **case-sensitive on the address**: use the lowercased address (the app
  looks it up lowercased). Chain id is the numeric id, not the name.
- Put files **here (`app/metadata/`), not in `app/public/`** — this folder is bundled
  and read in-memory; `public/` files would have to be fetched per basket.
- The signature is the only source of trust: a file whose signature does not recover
  to the basket's on-chain deployer is ignored (falls back to plain address
  attribution). You cannot forge attribution by editing a file here.
- Prefer this for baskets you deploy yourself. For a large, open, multi-creator site
  where creators publish without you committing files, configure an external metadata
  host instead (`VITE_METADATA_BASE_URL` / `VITE_METADATA_WRITE_URL`) — see
  `OPERATORS.md`. The site-bundled rung takes precedence over the host for the same
  basket.
