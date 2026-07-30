#!/usr/bin/env node
// Regenerate src/data/prism-claim-index.json (lowercased snapshot addresses, sorted)
// from src/data/prism-claims.json. The index exists so the site-wide claim banner can
// answer "is this wallet in the snapshot?" from a ~53KB chunk instead of pulling the
// full 1.1MB proofs file on every connected visit — proofs load only on /claim.
// A unit test pins index == keys(claims), so drift between the two files fails CI.
//
// Source of truth for BOTH files: airdrop/claims.json in the public
// prismv2contracts repo (1203 rows; the merkle root is pinned in
// src/lib/prism/claim.ts and verified against the file by the same test).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data')
const claims = JSON.parse(readFileSync(resolve(DATA, 'prism-claims.json'), 'utf8'))
const index = Object.keys(claims.claims).map((a) => a.toLowerCase()).sort()
writeFileSync(resolve(DATA, 'prism-claim-index.json'), JSON.stringify(index))
console.log(`prism-claim-index: ${index.length} addresses`)
