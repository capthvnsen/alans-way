# Alan's Workspace for iOS: beta tester guide

Alan's Workspace is an iPhone and iPad companion for a Hermes agent you already run. It shows your private Telegram bot chats, starts voice calls with your agent, and opens your agent computer's desktop viewer.

## What you need before installing

- An iPhone or iPad on iOS 17 or newer.
- A Telegram account you can sign into with your phone number.
- Your own Hermes gateway with a Telegram bot you already chat with.
- For voice calls: the [mobile voice plugin](../mobile/README.md) installed on that gateway, with an HTTPS Mini App address and speech providers set up. Without it, chat still works but **Call** does not.
- Optional: an HTTPS noVNC address for your agent's computer (for example a Tailscale address). For a private tailnet address, connect Tailscale on the phone first.

The app does not create Hermes agents, Telegram bots or Telegram accounts.

## Install through TestFlight

1. Install Apple's **TestFlight** app from the App Store.
2. Open the invite email or public link you were sent, and tap **Accept** or **View in TestFlight**.
3. In TestFlight, tap **Install** next to Alan's Workspace.
4. Open the app, then sign into Telegram with your phone number, the code Telegram sends you, and your two-step password if you set one.
5. Your bot chats appear under **Your agents**. If a bot is missing, tap **Open another bot** and enter its @username.

If the app asks for a Telegram API ID and API hash, this build was made without them. Get them from [my.telegram.org/apps](https://my.telegram.org/apps) or ask whoever invited you.

TestFlight builds expire after 90 days. TestFlight tells you when a newer build is ready.

## Known limitations

- Only private bot chats. No groups, topics, editing or forwarding, and it is not a full Telegram client.
- Calls are foreground only. Locking the phone or switching apps ends the call's audio. Your agent keeps working and answers in the chat.
- Voice is turn by turn (speak, pause, hear the reply), not continuous realtime voice.
- Calls use your conversation's normal model, not a separate voice model.
- Some bot keyboard button types are not supported; the app shows an error when you tap one.
- The computer viewer uses whatever login your viewer already has. The app adds no extra takeover control.
- Avatars are set per bot on this device only. They do not change the bot's Telegram photo.

## Send feedback

- **Screenshot feedback:** take a screenshot while using the app, tap the thumbnail, then **Share Beta Feedback**. Or open TestFlight, choose Alan's Workspace and tap **Send Beta Feedback**.
- **Crashes:** when the app crashes, iOS may ask whether to share the crash with the developer through TestFlight. Tap **Share**.
- **Crash and hang reports from the app:** iOS delivers reports about earlier crashes and freezes to the app, usually a day later. Open **Your agents**, tap the settings button (top right), then **Share crash and hang reports**. Send the file by email or AirDrop to whoever invited you. The reports stay on your device until you do this. **Delete reports** removes them.

Please include what you were doing, which bot, and whether it was a call, chat or the computer viewer. Never send your Telegram login code, two-step password, bot token or API hash.

## Privacy

See the [iOS privacy policy](privacy-policy-ios.md).
