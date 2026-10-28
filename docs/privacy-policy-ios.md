# Alan's Workspace for iOS: privacy policy

This describes what the iOS app (bundle `com.openalan.workspace`) stores and sends, based on its source in [`ios/`](../ios). The app has no analytics, advertising or tracking SDK, no account with us, and no server operated by the developer. Nothing is sent to the developer unless you choose to share it.

## What the app stores on your device

| Data | Where | Why |
|---|---|---|
| Telegram application API ID and API hash, if you typed them in | Keychain, this device only | Identifies the app to Telegram |
| Encryption key for the local Telegram database | Keychain, this device only | Encrypts the database below |
| Telegram session, chat list, messages and downloaded files | App storage (`Application Support/Telegram`), encrypted by TDLib, excluded from iCloud and device backups | Shows your chats without reloading everything |
| Copies of files you choose to send | Same folder, `outbox` | Kept while Telegram uploads them |
| Desktop viewer address and avatar choice per bot, and which voice page hosts you allowed per account and bot | App preferences | Remembers your settings |
| Cookies and site data of the voice call page and desktop viewer | The system web view store | Lets those pages keep their own logins |
| Crash and hang reports from Apple's MetricKit (at most 20) | App storage (`Application Support/Diagnostics`) | Lets you share them for troubleshooting |

Signing out ends this device's Telegram session. Deleting the app removes its stored data; its Keychain items can remain until iOS clears them.

## What the app sends, and to whom

- **Telegram.** Your phone number, login code and two-step password go to Telegram to sign in. Messages and files you send, and the chats you open, go to and come from Telegram. Telegram also receives the app version, device model (for example "iPhone"), iOS version and language code that TDLib reports for every client. Telegram's [privacy policy](https://telegram.org/privacy) applies.
- **Your bot's voice call page.** When you tap **Call**, the app sends `/call` to your bot and opens the HTTPS page your own Hermes gateway returns. That page receives Telegram's signed launch data (your Telegram user ID and profile basics such as name, username and language, as Telegram provides to any Mini App) and, while a call is active, your microphone audio. The app grants the microphone only to that page's own address and never grants the camera. The gateway operator (normally you) controls where that audio goes, including any speech provider set up on the gateway.
- **Your desktop viewer.** If you set a viewer address, the app opens that HTTPS page and sends only what the page itself asks for.
- **Crash and hang reports.** These leave your device only when you tap **Share crash and hang reports** and pick a destination. They use Apple's MetricKit format: app version and build, iOS version, device type, the crash or hang reason, and call stacks of app and system code. They contain no message content or account details. If you install through TestFlight and agree to share crashes, Apple also passes crash logs and your feedback to the developer under Apple's [TestFlight terms](https://www.apple.com/legal/privacy/data/en/testflight/).

The app does not access contacts, location, photos, the clipboard or the camera. Microphone access is used only during a call you start.

## Contact

Report issues at [github.com/capthvnsen/alans-way](https://github.com/capthvnsen/alans-way/issues).
