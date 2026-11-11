# Alan's native chat

A chat surface in the left pane that talks to Hermes Agent's own Sessions API
(`/api/sessions/*`, `/v1/runs/*`). It is a thin client: Hermes keeps the
conversations; the app keeps a local copy so a thread opens instantly.

- All HTTP runs in the Electron main process (`desktop/src/hermes-api.cjs`,
  `desktop/src/native-chat.cjs`). The renderer (`desktop/src/native-chat.js`)
  only draws the state it is sent and calls an allowlist of commands.
- The API key is stored encrypted with the system keychain (Electron
  `safeStorage`), like the dashboard session token. Without a keychain it is kept
  in memory until the app quits. It never reaches the renderer or the logs.
- Messages are cached per conversation in `native-chat-cache/` in the app data
  folder (private files, capped at 32 MB in total, oldest dropped first).

## Turn it on

On the Hermes host, in the profile's `.env` (`~/.hermes/.env`, or
`~/.hermes/profiles/<profile>/.env`):

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<a random value of at least 16 characters>
```

Restart the gateway (`hermes gateway restart`). The API server listens on
`127.0.0.1:8642`. Keep it on loopback and reach it one of two ways:

- **SSH tunnel:** `ssh -N -L 8642:127.0.0.1:8642 <host>`, then use
  `http://127.0.0.1:8642`.
- **Tailscale Serve:** `tailscale serve --bg --https=8443 http://127.0.0.1:8642`,
  then use `https://<machine>.<tailnet>.ts.net:8443`.

Plain `http://` is accepted only for `127.0.0.1`, `localhost` and `[::1]`; any
other address must be `https://`. A named profile on a multiplexed gateway is
addressed by ending the address with `/p/<profile>`.

The API server rejects any request that carries an `Origin` header (CORS is
off). The app never sends one, because no request comes from a web page.

In the app: Settings, Chat surface. Enter **Native chat address** and **API
key**, choose **Save**, then **Test**. Once it is saved, choose **Alan's native
chat** in "Chat in the left pane with".

## What you can do

- Pick a conversation or start a new one from the switcher at the top of the pane.
- Send messages and watch the reply stream in. While Alan uses a tool, one
  status line says what it is doing. **Stop** ends the reply.
- Answer approval requests (Allow once, Allow for this chat, Always allow, Deny)
  and clarifying questions inline.
- Markdown replies: headings, lists, quotes, links (they open in the Browser
  pane), scrollable tables with Copy as markdown, and code blocks with Copy.
- Cards: a paragraph that is only `::link{title="…" url="…" description="…"}`,
  `::file{name="…" size="…" path="…"}`,
  `::card{title="…" body="…" action="…" action="…"}` (up to three actions; each
  sends its label as your next message) or `::preview{file="…"}` renders as a
  card. A fenced block tagged `html widget` runs in a sandboxed frame with no
  network access.

## Shared and read-only conversations

Hermes lists conversations from every surface. Two kinds accept messages here:

- Conversations made here (`source` `api_server`). Hermes Desktop can open and
  continue them too.
- The profile's **Bot Chat**: the Hermes Desktop or terminal conversation titled
  exactly `Bot Chat`. It is the same conversation in Hermes Desktop, the terminal
  (`hermes chat -c "Bot Chat"`) and here. It is pinned first in the switcher and
  marked **Shared with Hermes Desktop**, even though Hermes Desktop hides Bot Chats
  from its own session list. Hermes queues a message from here behind whatever that chat is
  doing and sends the reply whole, not word by word. If the chat is still busy
  after five minutes, the message stays queued there; refresh later to see the
  reply. No server setting is needed (Hermes Agent 0.23.1).

Every other conversation (other Hermes Desktop chats, Telegram) can be read but not
written from here; Hermes refuses it. **Continue here** copies one into a new
conversation made here and opens it. Details: `docs/polish/same-conversation.md`.

## Surfaces and one inbox

The chat header has a switch with **Telegram**, **Hermes Desktop** and **Native**.
It shows only what is set up: Telegram for a Telegram bot, Hermes Desktop once it
has an address (marked when it can't be reached), Native once it has an address
and key. With one surface it is hidden. Arrow keys, Home and End move along it.

The left list has one row per bot, whatever surface it uses. With no Telegram bots
at all, one built-in row named after the Hermes host (`hermes`) reaches Hermes
Desktop and Native. A row's dot means unread in Telegram or in its native
conversation; an amber ring means it is waiting for you (an open approval or
question in its native conversation, or a browser tab handed back to you). A new
native wait while you are elsewhere sends one notification.

**Shared between surfaces:** Hermes Desktop and Native read the same Hermes
session store, so a conversation started in one is listed in the other.
Telegram-source conversations, and Hermes Desktop ones other than the Bot Chat, can
be read from Native but not written to; Continue here forks them. Switching keeps every surface alive: the Telegram and Hermes
Desktop views stay loaded, and a native reply keeps streaming in the background
(it marks the row unread when it finishes out of view).

**Per bot** (`preferences.json`): `chatSurfaces[botId]` is the surface you last
picked with the switch; a bot without one follows Settings, Chat surface.
`nativeSessions[botId]` is the native conversation last used with that bot. A bot
with none opens, for a Telegram bot, the newest Telegram-source conversation on
this Hermes host (read-only), otherwise the newest conversation made here, or a new
chat. Which Hermes conversation belongs to which Telegram bot is not known; "newest
Telegram-source conversation" is a guess, nothing more. Drafts and scroll position
are kept per conversation while the app runs.

## Known limits

- Math (`$…$`) shows as code-styled text, not typeset.
- Images and file attachments are not sent or shown.
- `::preview` shows a card that opens Hermes Desktop; the file itself is not loaded.
- Clarifying questions come from polling the run once a second, because they are
  not sent on the reply stream.
- One reply at a time per conversation; send again after it finishes or after Stop.
- In the Bot Chat, Stop only stops waiting here: the turn keeps running in Hermes.
  Approvals and questions for a turn sent from here show in Hermes Desktop, not
  here. Both are read from the Hermes source, not tested.
- The conversation list shows the 50 most recent conversations.
