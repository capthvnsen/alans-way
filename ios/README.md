# Alan's Workspace for iOS

The iOS app is part of **Alan's Workspace**, one of [Alan's Way's four products](../README.md#what-to-install). Its source stays in `ios/`; voice support stays in [`mobile/`](../mobile/README.md). Alan's CU MCP is the separate Node server in `desktop/`; the Hermes and Grok Bot plugin products and their shared persona/voice/proactivity/identity spec belong in [alans-way-agents](https://github.com/capthvnsen/alans-way-agents). See [boundaries and publication TODOs](../docs/products.md) and [license coverage](../docs/licensing.md).

**Install:** use an existing [beta invitation](../docs/ios-beta-testers.md) or build with Xcode below. This repo does not provide a public App Store install link. Community: [Discord](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com).

A native SwiftUI companion for existing Hermes bots. Telegram carries the normal chat across devices. The conversation header opens an authenticated Telegram voice Mini App inside the app, with the selected agent's avatar and the same gateway session. The computer button opens the agent's configured HTTPS desktop viewer.

## Build and run

Use Xcode with the iOS 17 or newer SDK and [XcodeGen](https://github.com/yonaskolb/XcodeGen). The project pins TDLibKit and its prebuilt TDLib binary through Swift Package Manager; the first dependency download is substantial.

```sh
brew install xcodegen
./ios/scripts/build.sh simulator
open ios/AlanWorkspace.xcodeproj
```

Select the **AlanWorkspace** scheme and an iPhone simulator, then Run. The simulator build is at `.build/DerivedData/Build/Products/Debug-iphonesimulator/AlanWorkspace.app` inside this directory. Simulator builds use local ad hoc signing so Keychain works; they do not need an Apple signing team. Do not disable simulator code signing, because an unsigned app cannot access its secure session storage.

With macOS 27 and Xcode 27, use a matching iOS 27 simulator for call testing. The iOS 26.2 simulator reproduced WebKit JavaScript compiler crashes during live audio capture, followed by shared-cache launch failures. Apple discusses the latter failure and recommends testing the full 27 toolchain in [Developer Forums](https://developer.apple.com/forums/thread/837945). This simulator issue does not establish a crash on a physical iPhone. A terminated call page now releases capture and shows a native close screen; starting another call obtains a fresh Telegram launch rather than replaying its single-use ticket.

For a device compilation and unsigned archive:

```sh
./ios/scripts/build.sh device
```

The archive is `.build/AlanWorkspace.xcarchive`. It is not a signed IPA or a TestFlight upload. To run on your iPhone, choose your Apple development team in Xcode's Signing & Capabilities, select the phone and Run. Keep the bundle identifier unique to your account if necessary. For distribution, archive with signing enabled in Xcode and use its normal distribution flow.

`project.yml` is authoritative. Regenerate the project after adding source files. A local `DEVELOPMENT_TEAM` override can live in the ignored configuration file described below so regeneration retains it.

## TODO FOR ALEX

These need the Apple account and are not done by any script here.

1. Find your 10-character Team ID at [developer.apple.com/account](https://developer.apple.com/account) under **Membership details**. Pass it as `APPLE_TEAM_ID=YOURTEAMID` when running `testflight.sh`. For Xcode device runs, put `DEVELOPMENT_TEAM = YOURTEAMID` in your ignored `LocalConfiguration.xcconfig`.
2. Register the bundle ID `com.openalan.workspace` under **Certificates, Identifiers & Profiles > Identifiers** (Automatic signing can also create it on the first archive).
3. In App Store Connect, create the iOS app: name **Alan's Workspace**, primary language **English (U.S.)**, bundle ID `com.openalan.workspace`, SKU `alans-workspace-ios`. Check that no matching app already exists.
4. Answer the export-compliance (encryption) question for the first build. TDLib uses encryption for Telegram's protocol and the local database; decide whether the exemption applies. The project deliberately leaves `ITSAppUsesNonExemptEncryption` unset.
5. In the app's TestFlight tab, create an internal group (team members) and an external group (invited testers). External groups also need the **Test Information** page filled in (feedback email, privacy policy URL: link [docs/privacy-policy-ios.md](../docs/privacy-policy-ios.md)) and pass Beta App Review.
6. Upload: `APPLE_TEAM_ID=YOURTEAMID ./ios/scripts/testflight.sh` for internal testers, or add `--external` for a build external groups can receive. Then send testers [docs/ios-beta-testers.md](../docs/ios-beta-testers.md).

## TestFlight testing

By default the upload script uses Apple's **TestFlight Internal Only** setting. Those builds cannot be distributed through external TestFlight or submitted for public App Store release. `./ios/scripts/testflight.sh --external` uploads the same signed archive without that restriction, so the build can go to external tester groups after Beta App Review; it still does not submit an App Store version. See [Apple's distribution documentation](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

`MARKETING_VERSION` in `project.yml` follows the project's shared `0.<Hermes minor>.<patch>` versioning (currently the desktop app's 0.21.13). App Store Connect accepts only numeric versions, so beta status comes from TestFlight rather than a `-beta` suffix. The export lets Xcode assign the build number on upload; `CURRENT_PROJECT_VERSION` stays `1` locally.

Sign into the developer account in **Xcode > Settings > Accounts**. Register `com.openalan.workspace` for the selected developer team and create its iOS app record in App Store Connect. Suggested record values are **Alan's Workspace**, primary language **English (U.S.)**, and SKU **alans-workspace-ios**. Check for an existing matching app before creating another record. Set the ignored Telegram application credentials before uploading a build intended for testers who should only need to sign into Telegram.

```sh
APPLE_TEAM_ID=YOURTEAMID ./ios/scripts/testflight.sh
```

The script regenerates the project, creates a signed archive, then uploads it. A signing/archive failure stops the upload. It uses Xcode's authenticated account and automatic provisioning; it does not store Apple passwords or API keys. Team-specific export settings, the archive, and upload artifacts stay under ignored `.build/TestFlight/`.

After processing completes, verify the version/build and internal-only indicator in App Store Connect's TestFlight tab, then assign the build to the intended internal test group. This workflow does not submit an App Store version or create a public testing link. Apple may require [export-compliance information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds/); the project leaves that declaration unset rather than assuming TDLib's encryption is exempt.

The bundled privacy manifest declares app-local preferences, file metadata for the app's storage and document picker, and disk-space checks for local database/file storage. It is a required-reason API declaration, separate from any App Store privacy questionnaire. What the app stores and sends is in the [iOS privacy policy](../docs/privacy-policy-ios.md).

## Crash and hang diagnostics

The app subscribes to Apple's MetricKit and keeps up to 20 diagnostic payloads (crashes, hangs, CPU and disk-write exceptions) in `Application Support/Diagnostics`. There is no third-party SDK and no automatic upload. **Workspace settings > Diagnostics** shares one JSON file with every retained payload through the share sheet, or deletes them. iOS delivers payloads on a later launch, typically within a day; on a device, Xcode's **Debug > Simulate MetricKit Payloads** produces a sample. Files are named in time order, so pruning reads no file timestamps and the privacy manifest needs no new entry. Since nothing leaves the device unless the person shares it, no collected data type is declared.

## First-run onboarding

A new install walks beta testers through three steps:

1. **Telegram app.** Numbered instructions link to [my.telegram.org/apps](https://my.telegram.org/apps) and collect the App api_id and App api_hash. The form checks their shape (a number and a 32-character hexadecimal code) before saving them to device-only Keychain items. Builds with bundled credentials skip this step. If Telegram later rejects the pair, **Use different app credentials** on the phone-number screen deletes the unauthorized local session and the saved pair so they can be entered again.
2. **Sign in.** Phone number, code, two-step password and email steps as before. Common Telegram errors, such as an invalid code or a rate limit, are shown in plain language.
3. **Hermes bot.** Choose an existing bot chat or open one by @username. An optional screen then checks the voice Mini App address (it reads the plugin's public `/v1/capabilities` readiness on that origin and is not saved) and the desktop viewer address (saved for that bot). Each failure names a likely fix. **Skip for now** and **Skip checks** go straight to the agent list.

The completion flag is the `workspace.onboardingComplete` preference. A tester who signs out later sees the sign-in screens without the welcome. UI tests override the flag with the launch arguments `-workspace.onboardingComplete YES` or `NO`.

TODO (Alex): set the Apple Team ID and create the App Store Connect record before the first TestFlight upload. See [TestFlight testing](#testflight-testing).

## Telegram account setup

Register this client at [my.telegram.org/apps](https://my.telegram.org/apps) to obtain its application API ID and API hash. These identify the Telegram client application; they are different from a Hermes bot token. A release build should supply the application credentials so users only sign into Telegram.

For a private build, enter the application credentials in the first-run setup screen. They are stored in device-only Keychain items. For builds that include the application credentials, copy `LocalConfiguration.xcconfig.example` to the ignored `LocalConfiguration.xcconfig` and fill in the two values before building. Never commit that file. The account's phone number, sign-in code and two-step password are entered through the app's login screens and sent through TDLib.

The app restores its encrypted local Telegram session. It loads private bot chats from the main and archived chat lists, receives message updates, supports text/file sends and downloaded attachments, and maps ordinary bot keyboard buttons. **Open another bot** resolves a verified Telegram bot username without sending it a first message automatically.

The chat interface currently focuses on private bot conversations. Group/topic calling, editing/forwarding messages, Telegram account creation, and Telegram's full general-purpose client feature set are outside this build. Test the exact bot keyboards you use; unsupported button types report an explicit error.

## Voice calls

Install and configure the companion [mobile voice plugin](../mobile/README.md) on the existing Hermes gateway. It must have a stable HTTPS Mini App URL, the profile's configured speech providers and access to the Hermes dashboard's authenticated audio endpoints. This repository includes the web Mini App and the plugin; building the iOS binary does not deploy either to your gateway.

The native Call action sends `/call` to the selected existing bot and waits for a fresh Web App button from that bot in that chat. TDLib then opens the Web App through Telegram and supplies its authentic launch URL. The app remembers Telegram's first-launch disclosure per account and bot. The voice page receives genuine `initData`, and the backend validates it and its single-use session-bound launch ticket. Provider keys and bot tokens stay on the server.

The Mini App captures utterances with silence detection and uses the profile's configured STT and TTS. The normal Hermes conversation answers, with its tools and approvals. Playback can be interrupted without canceling agent work. Current transport uploads an utterance and polls its correlated reply; it is not continuous full-duplex realtime voice. The public plugin injection interface does not expose the auxiliary voice reasoning-model override, so this bridge uses the conversation's normal model. See the mobile README for that upstream limitation and recovery semantics.

Calls are foreground-only. Leaving the app stops media; permission dialogs and transient audio interruptions do not count as leaving. The native call host restricts page navigation, microphone access and bridge messages to the authorized launch origin. It always provides a close button. During a call, **Computer** opens the same configured viewer without switching apps.

## Computer and avatars

Open an agent's settings by tapping its name. Choose one of the bundled avatars and configure its existing noVNC viewer's HTTPS URL. For a private tailnet URL, connect Tailscale on the phone first. The app does not expose the desktop's loopback browser control endpoint, SSH keys, or Chromium debugging port. The viewer retains its own authentication and control policy; this build does not add a service-level human takeover lease.

Avatar choices are local presentation settings, bound to the bot chat. They apply to the native app and its embedded call page; they do not change the bot's Telegram photo or synchronize desktop-local avatar overrides.

## Verification

Local verification on 2026-10-17 used Xcode 27.0 and an iPhone 17 simulator running iOS 26.2. The locally signed simulator build and unsigned arm64 iPhone archive succeeded. All 16 native unit tests, 3 simulator UI tests, 13 backend protocol tests and 12 Mini App tests passed. The repository publication-policy suite also passed all 20 tests, and the voice plugin passed isolated Hermes discovery, import and registration checks. The native suite includes a real Keychain persistence check; these results otherwise use the test boundaries described below.

```sh
xcrun simctl list devices available
./ios/scripts/build.sh test YOUR_SIMULATOR_UUID
python3 -m unittest tests.test_ios_bundle tests.test_ios_testflight -v
node --test mobile/miniapp/test/*.test.js
python3 -m venv .venv
.venv/bin/pip install -r mobile/requirements.txt
.venv/bin/python -m unittest discover -s mobile/tests -v
```

Native tests cover chat mapping, fresh-call launch matching, origin/bridge restrictions and per-account/bot presentation settings. Simulator UI tests exercise first-run setup and chat/avatar/computer navigation using explicit DEBUG fixtures. Python tests use an actual local HTTP server with synthetic Telegram signatures and speech/gateway adapters. These do not certify live Telegram login, provider audio, conversation continuity or a physical iPhone microphone.

The live call recovery gate is opt-in and requires an already signed-in simulator, an existing voice-enabled bot chat, and approved microphone access. It sends `/call` to that bot, starts a genuine authenticated call, checks 25 seconds of audio monitoring, then terminates only that simulator's call WebContent process and verifies native recovery back to chat. It does not establish a successful spoken exchange:

```sh
ALAN_CALL_SMOKE_CHAT_ID=YOUR_BOT_CHAT_ID python3 ios/scripts/test-call-recovery.py YOUR_SIMULATOR_UUID
```

The bundle checks inspect the actual compiled simulator app to verify its version and Telegram application fields. When a private local configuration is supplied, they verify that those values reached the built app without printing them. The explicit `Info.plist` template carries these custom fields; Xcode's generated standard-property settings alone do not preserve arbitrary application keys.

To inspect the interface without signing in, launch a **Debug simulator** build with `--interface-preview`. A persistent **INTERFACE PREVIEW · SAMPLE DATA** banner distinguishes those fixtures from an authenticated Telegram session. Release builds have no fixture factory. Use `--ui-testing` to skip automatic session restoration in an isolated UI test.

Before a release, exercise real Telegram text → call → text continuity, two different bot identities, gateway reset/restart, provider failure, approvals, iPhone microphone/echo, AirPods, network transitions and the configured desktop viewer. Signing, live account setup and TestFlight publication remain separate from local compilation.
