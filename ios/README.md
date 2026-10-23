# Alan's Workspace for iOS

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

## TestFlight internal testing

The upload script uses Apple's **TestFlight Internal Only** setting. Builds uploaded through this script cannot be distributed through external TestFlight or submitted for public App Store release. See [Apple's distribution documentation](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

Sign into the developer account in **Xcode > Settings > Accounts**. Register `com.openalan.workspace` for the selected developer team and create its iOS app record in App Store Connect. Suggested record values are **Alan's Workspace**, primary language **English (U.S.)**, and SKU **alans-workspace-ios**. Check for an existing matching app before creating another record. Set the ignored Telegram application credentials before uploading a build intended for testers who should only need to sign into Telegram.

```sh
APPLE_TEAM_ID=YOURTEAMID ./ios/scripts/testflight.sh
```

The script regenerates the project, creates a signed archive, then uploads it. A signing/archive failure stops the upload. It uses Xcode's authenticated account and automatic provisioning; it does not store Apple passwords or API keys. Team-specific export settings, the archive, and upload artifacts stay under ignored `.build/TestFlight/`.

After processing completes, verify the version/build and internal-only indicator in App Store Connect's TestFlight tab, then assign the build to the intended internal test group. This workflow does not submit an App Store version or create a public testing link. Apple may require [export-compliance information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds/); the project leaves that declaration unset rather than assuming TDLib's encryption is exempt.

The bundled privacy manifest declares app-local preferences, file metadata for the app's storage and document picker, and disk-space checks for local database/file storage. It is a required-reason API declaration, separate from any App Store privacy questionnaire.

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
