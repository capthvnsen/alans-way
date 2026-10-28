# iOS QA after the TestFlight prep merge

[Claude] 2026-10-28, main at 5d10e81 (#230). Covers onboarding, Telegram setup, chat sync with other Telegram clients, offline and reconnect, accessibility and small screens.

## How it was tested

- iPhone 17 and iPhone SE (3rd generation) simulators on iOS 27.0 (Xcode 27), created for this run.
- Baseline on main: 19 unit tests passed, 3 UI tests passed, 1 skipped (the opt-in live call).
- Screens were checked with the `--interface-preview` sample data and the first-run sign-in screen. Text size was checked at Large and at Accessibility XXXL with `simctl ui content_size`.
- **Not verified:** live Telegram sign-in, a real bot conversation, a real loss of network, or a physical iPhone. Findings 1 to 3 come from reading the code against TDLib's documented behaviour, and their tests cover the logic, not a live session.

## Bugs found

| # | Area | Severity | Status |
|---|------|----------|--------|
| 1 | Chat sync | High | Fixed: branch `capthvnsen/ios-history-sync` |
| 2 | Chat sync | High | Fixed: branch `capthvnsen/ios-cache-unload` |
| 3 | Offline and reconnect | Medium | Fixed: branch `capthvnsen/ios-reconnect` |
| 4 | Accessibility | Medium | Partly fixed: branch `capthvnsen/ios-dynamic-type` |
| 5 | Onboarding | Medium | Not fixed (overlaps #235) |
| 6 | Onboarding | High | Fixed in open PR #235 |
| 7 | Onboarding | Low | Not fixed (noted in #235) |
| 8 | Chat rendering | Low | Not fixed |
| 9 | Chat list | Low | Not fixed |
| 10 | Chat sync | Low | Not fixed |
| 11 | Build | Low | Not fixed |

### 1. A chat opens without its history once any update has reached it

`selectChat` loaded history only when `messagesByChat[chatID] == nil`. A new message or `updateChatLastMessage` arriving while the chat is closed creates that entry first. Examples are a bot reply, or text sent from Telegram on the desktop. Separately, TDLib often answers the first `getChatHistory` with only the cached last message, and any page under 50 messages hid **Earlier messages** permanently.

Repro:
1. Sign in and stay on the agent list.
2. Send the bot a message from Telegram on the desktop, or wait for the bot to reply.
3. Open the chat in the app.
4. Only the newest messages show, and there is no **Earlier messages** button.

Fix: the store tracks which chats had their history loaded. Only a page that adds nothing marks history complete. The first open fetches up to three pages. Unit test: `testShortHistoryPageStillOffersEarlierMessages`.

### 2. Conversations empty out after TDLib unloads them from memory

TDLib sends `updateDeleteMessages` with `fromCache = true` when it drops a closed chat's messages from memory. The store removed them as if they had been deleted in Telegram.

Repro:
1. Open a chat, go back to the agent list and wait a few minutes.
2. Reopen the chat. It can be empty or partial, and nothing reloads it.

Fix: ignore cache-only deletions (one-line guard).

### 3. No sign of being offline, and slow reconnect

The store ignored `updateConnectionState`. Offline, a sent message appeared at once and looked delivered while TDLib held it. The app also never called `setNetworkType`, which TDLib says must be called on every network change. Without it, a phone coming back online waits out TDLib's retry backoff.

Repro:
1. Sign in and turn on Airplane Mode.
2. Send a message. Nothing says it is waiting.
3. Turn Airplane Mode off. The reply can take noticeably long to arrive.

Fix: a "Waiting for network… / Connecting… / Updating…" banner on the agent list and in conversations, and an `NWPathMonitor` that reports each change to TDLib. Tests: two unit tests, plus UI test `testOfflineConnectionIsShownOnAgentsAndConversation`. That test uses a new DEBUG-only `--preview-offline` launch argument for the preview data.

### 4. Text ignores Dynamic Type everywhere

Every font is a fixed `.system(size:)`. At Accessibility XXXL only SF Symbols grow.

Repro:
1. Set **Settings > Accessibility > Display & Text Size > Larger Text** to the maximum.
2. Open the app. No text changes size.

Fixed for the conversation: message text, sender name and time, bot buttons and the composer, using `@ScaledMetric`, so the default look is unchanged. UI test `testConversationTextFollowsDynamicType` failed before the fix (message height 18 pt at both sizes) and passes after. **Still fixed-size:** agent list, sign-in, workspace and agent settings, computer viewer and call screens.

### 5. A mistyped phone number is a dead end

On the code step there is no way back to the phone step and no **Resend code**. Settings, including sign-out, are only reachable once signed in. TDLib accepts `setAuthenticationPhoneNumber` again in `waitCode`, and offers `resendAuthenticationCode`.

Repro:
1. Enter a wrong but valid-looking phone number.
2. The app moves to "Check your Telegram" and no code arrives. The only way out is deleting the app.

Not fixed here, because #235 rewrites these sign-in screens. That PR resets only the app credentials, at the phone step. Suggest adding **Use a different number** and **Resend code** there.

### 6. Sign out, then sign in again, crashes

`startClient()` created a new `TDLibClientManager` each time. Two receive loops make TDLib abort (SIGABRT in `TdReceiver::receive`).

Repro: sign in, open **Workspace settings > Sign out of this device**, then tap **Sign in again**.

Already fixed in open PR #235 (one manager kept for the app's lifetime). Not reproduced here, because it needs a signed-in session.

### 7. The credential form flashes during startup and sign-out

Any TDLib state the app does not model maps to `.configuring`. That includes the startup wait, `LoggingOut` and `Closing`. In that state the sign-in screen shows the "CONNECT THIS BUILD" API ID and hash fields, even in builds with bundled credentials. On an iPhone SE the 255 pt hero image also pushes those fields and the button below the fold, though the screen scrolls. #235 notes the flash.

### 8. Bot text is parsed as SwiftUI Markdown, and Telegram formatting is dropped

`Text(LocalizedStringKey(message.text))` treats bot text as a localization key with Markdown. Telegram's own entities (bold, code, links) are discarded, so `parse_mode` formatting is lost. Bare URLs from entities are not tappable, and stray `*` in text (for example `2*3*4`) turns into italics.

Repro: have the bot send `Compute 2*3*4` or a message with a bold entity. Compare it with Telegram.

### 9. Chats load twice at sign-in

`authorizationStateReady` starts `loadChats()`, and `AgentListView.task` starts another (again every time the list reappears). The first one to finish clears `isLoadingChats` while the other is still running. The effect is mostly wasted work and a spinner that can disappear early.

### 10. Long offline gaps can leave holes in an open chat

After a long time offline, TDLib may skip individual `updateNewMessage` events ("updates too long") and only report the new last message. A chat whose history was already loaded then shows old messages, a gap, and the newest message. Fixing it needs a refresh of the newest page on resume that replaces non-overlapping cache. It was not changed here, and needs a live account to confirm.

### 11. Every project regeneration rewrites `project.pbxproj`

XcodeGen 2.46.0 writes new random `TEMP_…` IDs for `Configuration.xcconfig` on each `xcodegen generate`. `build.sh` runs it on every build, so `project.pbxproj` changes every time and parallel iOS PRs conflict on it.

Repro: run `./ios/scripts/build.sh simulator` twice. `git diff ios/AlanWorkspace.xcodeproj/project.pbxproj` shows only `TEMP_` ID changes.

## Checked with no bug found

- First-run screen on iPhone SE and iPhone 17: everything is reachable by scrolling, and the Continue button stays disabled until the inputs are valid.
- The agent list fits the 375 pt SE width with the offline banner shown (screenshot). The conversation on SE was not screenshotted; UI tests ran on iPhone 17.
- In code, the toolbar, attach, send, avatar picker and call close buttons have accessibility labels, and agent rows read as one element. Not walked with VoiceOver.
