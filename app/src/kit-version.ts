// Kit release marker + update-check endpoint.
//
// KIT_VERSION reads the repo-root `version.json` — the SAME file the public repo serves
// as its update manifest — so a release is one bump: edit version.json (+ CHANGELOG.md)
// and every build carries it. Never restate the version string here.
//
// KIT_UPDATE_MANIFEST_URL also lives in version.json (`updateManifestUrl`) so the doctor
// script shares it. It points at the raw copy of the kit's OWN version.json
// (https://raw.githubusercontent.com/Irora-dev/Spectrum/main/version.json) — the one
// endpoint that is legitimately first-party (same standing as the canonical contract
// book); it must never point anywhere else. Empty would make the whole update check
// dormant (no request is ever made).
import manifest from '../../version.json'

// The published manifest's full shape (docs/RELEASES.md). Older manifests carry only
// version/note/updateManifestUrl; every newer field is optional so builds and the
// published manifest can move independently in either order.
export interface KitUpdateManifest {
  version?: string
  note?: string
  /** 'safe' = pull+rebuild, nothing else · 'config' = read the changelog first · 'breaking' = manual work. */
  impact?: string
  /** Money-path systems the release touched ('launch' / 'swap'); [] almost always. */
  sacred?: string[]
  /** Recalled versions. A build whose KIT_VERSION appears here should update now. */
  yanked?: string[]
  updateManifestUrl?: string
}

export const KIT_VERSION: string = manifest.version
export const KIT_UPDATE_MANIFEST_URL: string = manifest.updateManifestUrl ?? ''
