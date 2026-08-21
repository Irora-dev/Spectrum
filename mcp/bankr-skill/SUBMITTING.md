# Submitting Spectrum Baskets to the Bankr skills registry

These three files (`SKILL.md`, `catalog.json`, `logo.svg`) are the complete Bankr skill for Spectrum baskets, authored against the registry's v1 contract (`BankrBot/skills`: each skill is a folder with a `SKILL.md` and `catalog.json`, the `slug` must equal the folder name, and entries land by pull request). The v1 `catalog.json` contract is minimal on purpose (`schemaVersion`, `slug`, `provider`, `providerUrl`, `logo`, `demo`, `setup`, `install`); a folder whose catalog fails validation is silently skipped from discovery, so do not add fields the contract does not name.

They are staged here in the kit, versioned next to the MCP server they point at. The actual registry entry lives in `BankrBot/skills`, an external repository. Opening that PR publishes Spectrum into a third-party marketplace, so it is the owner's call. When ready:

1. Fork `github.com/BankrBot/skills`.
2. Copy these files into a new top-level folder named `spectrum-baskets/` (the folder name must match `catalog.json`'s `"slug"`). Do not include this `SUBMITTING.md`.
3. Confirm `install.command` still matches how the kit builds the server (`npm run mcp:build`), that `providerUrl` and `homepage` are the URLs you want public, and that `SKILL.md`'s `metadata.version` matches the kit's root `version.json`. Then prove the pointed-at server actually installs: run `bash mcp/run.sh --check` from a fresh clone and keep the PASS lines for the PR.
4. Validate the JSON (`python3 -c "import json; json.load(open('spectrum-baskets/catalog.json'))"`). Skills without a valid `catalog.json` are excluded from discovery.
5. Open the PR, and put a short demo GIF or screenshot in the PR body: a read followed by a composed buy with its REVIEW sentences is the whole story in one capture. Reviewers and users skim visuals first, and the compose-review-sign loop shown on screen carries the safety model better than prose. The `--check` PASS lines make a good second image.

Keep the staged files and the submitted ones in sync: if the MCP's tools, build command, safety model, or kit version change, update here first, then re-PR.

The registry is public. Everything in `SKILL.md` and `catalog.json` ships to a third-party marketplace, so the kit's public-safe rule applies: only the public product, its public repository, and its public site. Security contact is the public repo's issue tracker (https://github.com/Irora-dev/Spectrum/issues), never a personal address.
