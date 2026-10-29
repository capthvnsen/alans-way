# Release channels

Alan’s Workspace defaults to **Stable** on desktop and iOS. **Nightly** is an explicit opt-in and is less tested: it follows a daily snapshot of `main`. The selected channel and installed version are visible in workspace settings. Existing preferences and sign-ins are retained.

## Desktop

Open **Settings → Updates & help → Updates** and choose Stable or Nightly. Quit and reopen the app to apply the choice. Changing channel saves a preference; it does not install a build immediately. Pending downloads from the previous channel cannot install on quit or through Restart to update after the choice changes. Channel changes are rejected while an app/server update operation is running.

Stable reads GitHub’s latest published non-prerelease `vX.Y.Z` release. Nightly reads published prereleases tagged `nightly-YYYYMMDD`; its release title is the installer’s exact SemVer, for example `0.21.14-nightly.20261028`. Drafts and release candidates are excluded. Missing releases, failed checks and unpublished nightly builds leave the current app installed. Signed macOS builds install only through the explicit restart action, because Squirrel cannot unstage a build once it has fetched it. The nightly lookup considers the newest 100 GitHub releases.

Both paths only offer a strictly newer SemVer. `0.21.13` can update to `0.21.14-nightly.20261028`; returning to Stable waits for `0.21.14` or newer. It never silently installs `0.21.13` over a newer nightly. Switching channel does not roll back your data or reset preferences. To recover from a broken nightly, select Stable and wait for a newer stable release; any manual recovery to an older app is a separate, deliberate action.

Windows and signed macOS builds reuse electron-updater with a feed pinned to the selected release’s existing metadata and installers. The channel setter can enable downgrades, so the app explicitly disables them after setting the feed, and checks the resolved installer version before downloading. Unsigned macOS builds keep the existing checksum-verified DMG swap. Linux shows release status and uses manual installation, as before. The agent’s browser host, Hermes and plugins keep their existing update policies; opting into a nightly desktop build never sends a nightly app tag to the browser host.

## Nightly CI

`.github/workflows/nightly.yml` runs daily at 08:17 UTC and can be dispatched manually after merge. It pins a snapshot of `main`, calculates the UTC date and next patch prerelease version, then calls the existing `.github/workflows/release.yml` pipeline. A main package version of `0.21.13` produces tag `nightly-20261028` and installer version `0.21.14-nightly.20261028`. Source version files are stamped only in the runner; no version bump is committed.

The reused workflow stages a draft, builds macOS/Windows and optional Linux installers, uploads the existing checksums/blockmaps and update manifests, and only then publishes the nightly as a **prerelease**, with `latest=false`. Stable tags retain the existing publication behavior; RC tags remain drafts. Build jobs retain read-only repository tokens, while draft/upload/publish jobs have write permission. The existing signing/notarization path and secret names are reused; no credentials are created or changed.

A published date tag is immutable: another run that day skips it. A failed draft can be retried from the same main commit/version; if main has moved, the workflow refuses to mix builds from different commits and leaves that draft intact. Wait for the next day’s nightly rather than moving a tag or overwriting a published installer. Partial builds stay drafts and cannot reach either updater stream. The nightly workflow is serialized. No iOS archive/upload is added to this CI job.

## iOS / TestFlight — TODO for Alex

**Settings → Release channel** saves the preferred channel in UserDefaults and shows the installed build’s actual channel, version and build number. It does not enroll the tester, change a TestFlight group, download code or install/downgrade a build. The screen says so explicitly. Stable is the default build label; `WorkspaceReleaseChannel` in Info.plist comes from the `WORKSPACE_RELEASE_CHANNEL` build setting. For a future nightly archive, pass `WORKSPACE_RELEASE_CHANNEL=nightly`; leave it `stable` for tagged stable archives. Keep Apple’s build number increasing across both channels.

Alex must complete the distribution setup before the preference can correspond to delivered iOS builds:

- Create or choose separate **Stable** and **Nightly** internal TestFlight groups in App Store Connect and assign testers/builds intentionally.
- Archive Stable from tagged releases and Nightly from the chosen main commit, stamping `WORKSPACE_RELEASE_CHANNEL` and an increasing `CURRENT_PROJECT_VERSION`; verify those values in the built bundle and TestFlight.
- Decide and document the approved enrollment/support process, then provide its real destination in-app when available. There is no enrollment URL or automatic group mapping in this change.
- On a return to Stable, assign a newer stable build and have the tester install it explicitly through TestFlight. Do not silently move them to an older build.

Use the existing [iOS TestFlight instructions](../ios/README.md#testflight-internal-testing). That upload path is internal-only and remains manual. This change does not modify Apple accounts, signing secrets, App Store Connect credentials, TestFlight groups or any live release.

## Verification

Run `npm run check --prefix desktop` for channel isolation, SemVer safety, update planning, build provenance and existing desktop regressions. Run `npm run test:settings-navigation --prefix desktop` for actual Settings control/persistence checks. Validate workflow structure with `actionlint .github/workflows/release.yml .github/workflows/nightly.yml`.

Generate the iOS project with XcodeGen and run `AlanWorkspaceTests/WorkspaceSettingsTests` on a simulator for default, persistence and invalid-value handling. Before production rollout, exercise a packaged stable → nightly → stable upgrade on macOS/Windows; a downloaded build followed by channel switching; offline checks; and Alex’s manually configured TestFlight assignments. Publishing and signed installer installation are intentionally outside local verification.
