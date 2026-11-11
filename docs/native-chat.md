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

## Read-only conversations

Hermes lists conversations from every surface. Only those created over the API
(`source` `api_server`) accept messages here. Others, such as Telegram, can be
read. **Continue here** copies one into a new API conversation and opens it.

## Known limits

- Math (`$…$`) shows as code-styled text, not typeset.
- Images and file attachments are not sent or shown.
- `::preview` shows a card that opens Hermes Desktop; the file itself is not loaded.
- Clarifying questions come from polling the run once a second, because they are
  not sent on the reply stream.
- One reply at a time per conversation; send again after it finishes or after Stop.
- The conversation list shows the 50 most recent conversations.
