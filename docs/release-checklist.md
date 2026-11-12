# Mac private-beta release checklist

A local, signed, notarized build of Alan's Workspace for Apple Silicon Macs, made with `desktop/scripts/release-mac.sh`. It builds into `desktop/dist` only. It never tags, uploads or publishes. Channels and the update feed are described in [release channels](release-channels.md).

## One-time setup

1. In Keychain Access, confirm the login keychain has a **Developer ID Application** identity. `security find-identity -v -p codesigning` lists it.
2. Make an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords.
3. Store it for notarytool. It prompts for the password, so nothing lands in shell history:

   ```sh
   xcrun notarytool store-credentials "alans-way-notary" --apple-id "<your Apple ID email>" --team-id "<Team ID>"
   ```

   The Team ID is the 10 characters in brackets after the identity name. The script prints the exact command, with the Team ID filled in, when the profile is missing.
4. Leave at least 2 GB of free disk space. The app, zip and dmg each need room, and so does notarization.

## Each release

1. Start from a clean checkout of the commit you mean to ship, with `desktop/package.json` at the release version.
2. Run `desktop/scripts/release-mac.sh`. It:
   - picks the Developer ID identity (set `CSC_NAME` when there are several), or stops with setup instructions if the notary profile is missing;
   - runs `npm ci`, then `npm run package:mac` with the hardened runtime and `assets/entitlements.mac.plist`;
   - notarizes and staples the `.app` (electron-builder), then signs, notarizes and staples `OpenAlan-mac.dmg`;
   - writes `OpenAlan-mac.dmg.sha512`, which the unsigned-to-signed DMG swap checks;
   - runs `codesign --verify --deep --strict`, `spctl --assess` on the app and the dmg, and `stapler validate` on both. Any failure stops the script.
3. Smoke test on a second Mac, or a fresh user account: download the dmg (so it gets the quarantine flag), open it, drag the app to Applications, launch it. There should be no "unidentified developer" prompt. Check **Settings → Updates & help** shows the version and channel.
4. To publish, push the `vX.Y.Z` tag so `.github/workflows/release.yml` makes the release (Stable). Nightlies come from `.github/workflows/nightly.yml`. A local build is for testing and direct sharing. Do not hand-upload it as a GitHub release asset: CI writes the `latest*.yml` feed that auto-update reads.

`--sign-only` skips notarization, for testing signing alone. Gatekeeper rejects that build, so never share it.

## Auto-update

Signed builds update through electron-updater from GitHub Releases. **Stable** follows the latest non-prerelease `vX.Y.Z`. **Nightly** follows `nightly-YYYYMMDD` prereleases. Testers switch in **Settings → Updates & help → Updates**. Updates only go to a strictly newer version.
