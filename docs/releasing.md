# Releasing Modus Desktop

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. The
workflow builds every platform, creates (or reuses) a **draft** GitHub release and
uploads the installers and the auto-update metadata to it. A person publishes the
draft by hand; nothing is visible to users before that.

## Channels

| Tag | Example | GitHub release | Update metadata |
| --- | --- | --- | --- |
| `vX.Y.Z` | `v0.3.0` | normal release | `latest.yml`, `latest-mac.yml`, `latest-linux.yml` |
| `vX.Y.Z-beta.N` | `v0.3.0-beta.2` | pre-release | `beta.yml`, `beta-mac.yml`, `beta-linux.yml` |

Any other tag shape (`v0.3.0-rc.1`, `v0.3`, `0.3.0`, …) fails the workflow in its
first job, before anything is built or created.

The channel also ends up inside the app (`resources/app-update.yml`), because
`electron-builder.config.ts` sets `publish.channel` from the `apps/desktop/package.json`
version.

## Cutting a release

1. Bump `version` in `apps/desktop/package.json` to the release version, without the
   `v` (for example `0.3.0` or `0.3.0-beta.2`), and merge that to `main`.
2. Tag the merged commit and push the tag:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

3. Wait for the **Release** workflow. When it is green, open the draft release on
   GitHub, check the assets and notes, and click **Publish release**.

The tag must equal the package.json version. The version is written into the update
metadata, so a mismatch would publish a feed that points at the wrong version; the
workflow refuses to continue when they differ.

## Existing releases

The workflow looks up the release for the tag before building:

- **No release:** creates a draft (marked pre-release for betas) with generated notes.
- **Draft with the right pre-release flag:** reuses it. Re-running the workflow for
  the same tag re-uploads the assets (`--clobber`).
- **Draft with the wrong pre-release flag:** fails. Fix the flag with
  `gh release edit <tag> --prerelease=<true|false>` or delete the draft, then re-run.
- **Published release:** fails. Published releases are never modified; bump the version
  and push a new tag.

## What gets uploaded

| Platform | Assets |
| --- | --- |
| macOS arm64 / x64 | `Modus-<v>-mac-<arch>.dmg` and `.zip`, each with a `.blockmap` |
| Windows x64 | `Modus-<v>-win-x64-setup.exe` and `.exe.blockmap` |
| Linux x64 | `Modus-<v>-linux-x86_64.AppImage`, `Modus-<v>-linux-amd64.deb` |
| Metadata | `<channel>.yml`, `<channel>-mac.yml`, `<channel>-linux.yml` |

The two mac architectures are built in separate jobs, and each job writes its own
`<channel>-mac.yml` listing only its files. The `merge-mac-metadata` job combines them
with `apps/desktop/scripts/release/merge-mac-update-yml.mjs` so the uploaded file lists
both zips (electron-updater picks the entry whose URL contains `arm64` on Apple
Silicon). The script refuses to merge different versions or conflicting entries.

## Unsigned builds

There are no signing certificates yet:

- **Windows:** the installer is not Authenticode-signed, so SmartScreen warns on first
  install ("Windows protected your PC" → *More info* → *Run anyway*).
- **macOS:** builds are not signed with a Developer ID or notarized. Gatekeeper blocks
  the first launch of a downloaded app (right-click → *Open*, or
  `xattr -dr com.apple.quarantine /Applications/Modus.app`). electron-updater's mac
  installer (Squirrel.Mac) rejects apps without a Developer ID, so the app installs mac
  updates with its own installer instead (see [In-app updates](#in-app-updates)).
- Both mac arches are ad-hoc signed (`mac.identity: "-"` in
  `electron-builder.config.ts`); without it electron-builder 26 only ad-hoc signs
  arm64 and leaves x64 unsigned. The release workflow also sets
  `CSC_FOR_PULL_REQUEST=true` on the mac packaging step, because electron-builder
  otherwise skips signing entirely on pull request runs. That is safe only while the
  identity is ad-hoc: revisit it when a real certificate is added.
- Each mac job runs `codesign --verify --deep --strict` on the built `Modus.app` and on
  the copy extracted from the zip, and logs `codesign -dv`. The job fails if the
  signature does not verify, which catches builds that macOS would report as damaged.

## electron-builder version pin

`electron-builder` is pinned to `26.8.1` in `apps/desktop/package.json`. Keep it below
v28: starting with v28 the NSIS updater fails closed on unsigned builds, which would
break Windows auto-update until the installer is signed. Treat any upgrade as a change
to the release pipeline and dry-run it (next section).

`electron-updater` (the in-app updater) is pinned to `6.8.3`, the version released
together with electron-builder 26.8.x (both use `builder-util-runtime` 9.5.1). Upgrade
the two together, and keep them below electron-builder v28.

## In-app updates

The main-process update service (`apps/desktop/src/main/updater/`) reads the stable
channel of this repository's GitHub Releases through electron-updater
(`resources/app-update.yml`). The repository is defined once, in
`apps/desktop/src/shared/release-repo.ts`, for both the electron-builder `publish`
config and the updater's download URL allowlist. It checks 15 s after startup and every 5 minutes, and only
ever moves to a newer `X.Y.Z` release: no downgrades, no pre-releases. It does nothing
in dev (`npm run dev`) or in builds whose version is not a plain `X.Y.Z` (betas).

- Until the first release is published every check fails (no releases, missing
  `latest*.yml`, 404). That is expected: background failures never show up in the UI and
  are logged at most once an hour as `[modus-updater] background update check failed`.
  Set `MODUS_UPDATER_DEBUG=1` to log every check.
- Downloads start only when the user clicks Install. The restart waits until no agent
  turn is running.
- **Windows / AppImage:** electron-updater downloads the installer (sha512 from
  `latest*.yml`) and restarts into it.
- **macOS:** electron-updater only checks. The app downloads the zip for its
  architecture from the release, checks its sha512 and size against `latest-mac.yml`,
  extracts it with `ditto`, checks the bundle id, version and `codesign --verify`, then a
  detached script swaps `/Applications/Modus.app` after the app quits (keeping a backup
  until the new version starts). Apps outside `/Applications`, translocated, on a
  mounted volume, or in a folder the user cannot write get a link to the release instead.
- **Linux deb:** the app cannot replace itself, so it only links to the release page.

## Dry runs on pull requests

A pull request that changes the release workflow, `apps/desktop/scripts/release/**` or
`apps/desktop/electron-builder.config.ts` runs the same workflow as a dry run:

- all builds (mac arm64 + x64, Windows, Linux), the codesign verification and the mac
  metadata merge run exactly as on a tag;
- the channel comes from the `apps/desktop/package.json` version (`-beta.N` → beta,
  otherwise latest), since there is no tag;
- the jobs that create or upload to a GitHub release are skipped, and the run only has
  `contents: read`;
- only the update metadata is kept as Actions artifacts, for 7 days
  (`update-metadata-mac-merged`, `update-metadata-mac-{arm64,x64}`,
  `update-metadata-win-x64`, `update-metadata-linux-x64`), so the real files can be
  inspected. Installers are not uploaded on pull requests.

On tag runs the installers are passed to `publish-assets` as `release-assets-*`
artifacts with a 1-day retention. To redo a release later, re-run the whole workflow
(the existing draft is reused), not just the upload job.

`workflow_dispatch` is not used because it only works once the workflow is on the
default branch.
