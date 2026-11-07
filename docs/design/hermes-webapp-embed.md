# Hermes Webapp in the Workspace chat pane

Status: spike, 2026-11-06. The opt-in prototype is the **Chat surface** setting. Nothing
changes for anyone who does not configure it.
Hermes facts below were read from the `v0.23.0` tag and exercised against commit
`355a4175` (`v0.23.0-10`), whose version string still reports `0.22.7`.

## Recommendation

Load the Webapp in a dedicated `WebContentsView`, reached through Tailscale Serve,
with dashboard password sign-in kept in its own persistent partition. The agent's
browser and computer-use tools need no change: they never travel through the chat
surface.

Users pick the surface in Settings, under **Chat surface**: Telegram or Hermes Desktop
(the UI's name for the embedded Webapp). Keep Telegram and the native Hermes
pane until phase 2 settles whether the Webapp
can replace the native pane.

## What was tried

| Check | Result | How |
|---|---|---|
| Real sign-in form in the pane, over HTTPS with a `.ts.net` name | Works | Real Workspace and real gateway, through a local stand-in for Tailscale Serve |
| Backend connects after sign-in | Works; the page reports the backend version and moves on to provider setup | Same |
| Sign-in survives a Workspace restart | Works; a second launch with the same profile skipped the form | Same, two processes |
| Agent `POST /v1/tabs` foregrounds a tab while the Webapp shows | Works; chat target stays `webapp` | Same, and in the Electron test |
| Chat surface choice survives a restart and reopens signed in | Works | Real gateway, stand-in Serve, two launches |
| No choice saved, address reachable | Opens Hermes Desktop | Real gateway, third launch |
| No choice saved, gateway down | Stays on Telegram; no view created | Real gateway stopped, fourth launch |
| Both surfaces keep their page state across switches | Works; no reload | Electron test, with fixture pages |
| Bare loopback URL | Fails by design; shows "Run hermes webapp on this computer" | Same |
| Real `tailscale serve` | **Not run** | Would have changed the tailnet |
| Live VM, Hermes `0.23.0`, no sign-in, SSH tunnel to `127.0.0.1:9120` (2026-11-07) | Pane loads after pasting a one-use link; "Backend ready" | Branch app on the real Workspace profile |
| Real chat turn on that VM | Works; reply arrived from the VM's model | Same |
| Agent browser tool from a Hermes Desktop chat | Works; `example.com` opened in the right-hand pane after 26 s, chat stayed on Hermes Desktop | Same; VM agent via `workspace-router` over SSH to this Mac |
| Switch to Telegram and back on the real profile | Same views, page state and transcript kept, still signed in | Same |
| Agent computer-use tools | **Not run** | They drive the Mac's desktop, not the pane, and would send a screenshot of the real screen to the model |
| Full workspace layout at chat-pane width with live sessions | **Not assessed** | Only sign-in and setup screens were seen, at 488 px wide |

## Which embedding primitive

| Option | Verdict |
|---|---|
| `iframe` | Impossible. Webapp pages send `frame-ancestors 'none'` (`hermes_cli/webapp_page_policy.py`; confirmed on a live response). |
| `<webview>` | Refused by `lockDown()` in `main.cjs` on the bridge-bearing pages. Reversing that widens the shell page's attack surface for no gain. |
| `BrowserView` | Deprecated by Electron. |
| **`WebContentsView`** | Chosen. Telegram already works this way, so bounds, hiding under overlays and teardown are all existing code. |

The view has no preload and uses partition `persist:hermes-webapp`. This matters:
Hermes warns that a signed-in Webapp user can run arbitrary commands as the Hermes
OS account. So the view must not hold the Workspace bridge, must not share cookies
with the Browser pane, and browser-pane pages must not be able to read its cookies.

## Authentication over Tailscale

Hermes has two sign-in modes, and which one you get depends only on the address.

| | Private mode | Gated mode |
|---|---|---|
| When | Loopback bind with no non-loopback `public_url` | `host: 0.0.0.0`, or a non-loopback `public_url` |
| Credential | One-use link, 60 seconds, exchanged for a token in **`sessionStorage`** | HttpOnly `__Host-` cookies; refresh token lasts 30 days |
| Survives app restart | No, needs a fresh link every launch | Yes (verified) |
| Secure context | Yes, loopback counts | Yes over HTTPS |

The Hermes configuration docs say `public_url` turns on sign-in "even on a loopback
host". On the tested commit a *loopback* `public_url` did not: the gateway stayed in
private mode and issued a one-use link. A `.ts.net` `public_url` engaged the gate.

### Chosen: Tailscale Serve plus password sign-in

On the Hermes host, as the Hermes OS user:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:9120
hermes config set webapp.enabled true
hermes config set webapp.public_url https://<machine>.<tailnet>.ts.net
hermes config set dashboard.basic_auth.username <name>
hermes config set dashboard.basic_auth.password_hash '<hash>'
hermes webapp --build-only
hermes gateway restart
```

`webapp.host` stays `127.0.0.1`, so nothing listens on the machine's other
interfaces. Do not use `tailscale funnel`. Generate the hash with
`python -c "from plugins.dashboard_auth.basic import hash_password; print(hash_password('PW'))"`.
That form puts the password in shell history, so setup should prompt for it instead.

The user signs in once inside the pane. The Workspace stores no password.

The native pane's sign-in cannot be reused. Hermes keeps the two apart on purpose
(`hermes_cli/webapp_sign_in.py`): native tokens are bearer tokens, and browser
logins are cookies bound to the browser credential. `hermes webapp --sign-out`
ends the browser login only.

### Rejected

- **`host: 0.0.0.0` on a tailnet IP.** `webapp.host` accepts only loopback or
  wildcard values, so a wildcard bind also listens on a VM's public interface. It
  is plain HTTP too, which turns off the microphone, clipboard read, notifications
  and the bot screen.
- **SSH tunnel plus one-use link as the main path.** It needs no dashboard password,
  but needs a fresh link every launch. On Linux the link is also only redeemable over a
  connection owned by the Hermes OS user. That held on the live VM only because both the
  gateway and the tunnel run as root, and recent commits deliberately moved the
  Workspace's own SSH logins off the Hermes account. It is supported (paste the link),
  but not recommended.
- **Reading `webapp/session-token`.** It is a long-lived credential for every tab.
  Moving it to another machine defeats the one-use link design.

### Conflict with tailnet enforcement

`tailnet.cjs` otherwise demands literal `100.x` addresses to rule out DNS rebinding,
and `hermes-remote.cjs` refuses `*.ts.net` under `HERMES_WORKSPACE_REQUIRE_TAILNET`.
The new `hermesWebappUrl()` is a deliberate, narrow exception: HTTPS `.ts.net` names, or
plain HTTP on `127.0.0.1` / `localhost` (this machine, or an SSH tunnel). The certificate binds the name, and the view holds no bridge, so a
rebind gains nothing. The check does not prove the name is on *your* tailnet, so the
dashboard password is still what guards access.

**Decision needed:** whether that exception is acceptable. The stricter alternative
is resolving the name in main and requiring a `100.64.0.0/10` answer before loading.
It is more code and does not stop a later re-resolve.

## How agent tools keep driving the right-hand pane

They already do, because the two paths share nothing:

```text
Webapp view ── WebSocket ──> gateway ── agent turn
                                          │ MCP tool call
                                          v
                           workspace-mcp (browser-mcp.cjs --bot-id <id>)
                                          │ HTTP + X-Hermes-Bot
                                          v
                           Workspace API ──> Browser pane tabs
```

The approval dialogs, takeover and blocked-address rules live in the main process
and do not depend on which chat is showing.

Links get the same treatment. `window.open` and off-origin navigations from the
Webapp open as human tabs in the Browser pane, using the code path Telegram links
already use. URL previews inside the Webapp are subframes and are left alone.

Three real gaps remain:

1. **Bot mapping.** Tabs are filtered by `selectedBotId`, and the Webapp can switch
   profile without the Workspace knowing. An agent on another profile opens a tab
   the user cannot see. Phase 1 fixes this by storing a Hermes profile
   on each bot and loading `/?profile=<name>`, which the Webapp already supports,
   with one view per profile. The view has no bridge, so it cannot report a switch
   made inside the Webapp. The Browser pane may need to follow the most recent agent
   tab in this mode.
2. **Two browsers for one agent.** Hermes has its own preview Browser and bot screen
   beside the Workspace pane. Which one the agent uses is decided by toolsets and
   skills, not by the chat surface, so this is unchanged. Users will still see two
   places a page can appear. Phase 2 should hide or document the preview rail.
3. **Telegram-only assumptions.** `selectAgent`, `workspace:bot-activity` and
   `alans-way` proactivity all assume Telegram. Proactive check-ins still go to the
   bound Telegram chat. Whether a Webapp turn counts as `desktop` for the texting
   voice was not checked.

## The Chat surface setting

This is the prototype. It lives in Settings, under General, as a two-way choice and an
address field.

**Choosing a surface.**

| Saved choice | Webapp state | Pane shows |
|---|---|---|
| None (default) | Not configured, unreachable, or still checking | Telegram, as today |
| None | Configured and answering | Hermes Desktop |
| Telegram | Anything | Telegram |
| Hermes Desktop | Anything | Hermes Desktop, or the inline help |

Saved values are `chatSurface` (`''`, `telegram` or `hermes-desktop`) and
`hermesWebappUrl` in `preferences.json`. Picking an option always saves an explicit
choice, so a host going down never moves someone off a surface they picked. Someone who
never chose can land on Telegram when the host is down and on Hermes Desktop when it is
up; that is the requested default and is worth a second look (open question 5).

**Reachability** is one `GET api/status` at startup, when the address changes, and on
**Try again**, with a 5-second limit. It counts only a 200 with a string `version`, so
another service at that address does not pass. The endpoint stays public in gated mode.

**Inline help** appears in the pane and in Settings:

| Status | What the user sees | Cause on a real gateway |
|---|---|---|
| `unconfigured` | Add an address in Settings | No address saved |
| `checking` | Checking the address | Probe running |
| `unreachable` | Can't reach it; run `hermes webapp --status`. **Try again**, **Open Settings** | `webapp.enabled` off, no sign-in provider, or gateway down (all refuse the connection, observed), or gateway still starting (503, observed), or Serve not set up |
| `needs-link` | Paste box for the link from `hermes webapp --no-open` | `/api/status` reports `auth_required: false` (loopback, no sign-in) |
| `sign-in` | The Hermes sign-in form, in the pane | No valid cookie yet |
| `ready` | Hermes Desktop | Signed in |

The Workspace cannot tell those `unreachable` causes apart from outside, so it hands off
to `hermes webapp --status`, which names the exact one. A missing bundle is different: the
address answers, sign-in appears, and the Webapp page itself reports it. That last step
was read from the docs; only the 200 and the redirect to sign-in were observed.

**Switching keeps state.** Neither view is destroyed or reloaded when you switch. They are
only hidden, the same way the native Hermes pane already hides Telegram. The only thing that
replaces the Webapp view is changing the address. Sign-in cookies stay in the partition even then.

**Bots.** Selecting a bot now keeps the chosen surface instead of forcing Telegram. It still
updates the hidden Telegram chat, and picks which bot's tabs the Browser pane shows. With
Hermes Desktop chosen, sidebar rows move between the two for the current session without
changing the saved choice.

Code: `resolveChatSurface()` in `src/shell-support.cjs`, `hermesWebappUrl()` in
`src/tailnet.cjs`, `syncWebapp()` and `checkWebapp()` in `src/main.cjs`,
`mountChatSurface()` and `renderWebappHelp()` in `src/renderer.js`. Tests:
`npm run test:webapp-embed`, plus unit tests in `test/shell-support.test.cjs` and
`test/tailnet.test.cjs`.

Known limits, also marked in the code:

- Webapp **New Window** and session pop-outs do nothing.
- **Nous sign-in does not work**, because leaving the origin is refused. Password
  sign-in only.
- A no-sign-in Hermes (loopback, or through an SSH tunnel) needs a pasted one-use link
  after every Workspace restart, because Hermes keeps that sign-in in the view's
  `sessionStorage`. Switching surfaces keeps it.
- A gateway that stops *after* the view has loaded shows the Webapp's own offline state,
  not this help. Reachability is not re-checked on a timer.
- Onboarding still assumes Telegram. A new user sees it before this setting matters.
- The chat pane maxes out at 680 px, and this UI was built for a full window.

## Plan

**Phase 1: usable for one person.**
Per-bot profile mapping and one view per profile. Same-origin child windows. Run the real `tailscale serve` path and a real turn with a tool call.

**Phase 2: decide on the native pane.**
Use it daily and compare it with `hermes-view.js`, `hermes-hub.cjs` and friends. The
Webapp brings Capabilities, Artifacts, scheduled jobs, files, Git review and the
terminal. If it wins, delete the native pane and its tests rather than maintain both.
That is the real payoff of this work. Consider letting the chat pane widen, or a
focus mode that hides the Browser pane.

**Phase 3: first-run setup.**
Have the `workspace-setup` skill run the host steps above, prompting for the password
without echoing it. Raise `requires_hermes` to `>=0.23.0`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Webapp access equals shell access on the host | High | No bridge, own partition, HTTPS only, sign-in required, Funnel never used. A strong password is the last line, because anyone on the tailnet can reach the form. The password provider has no MFA. |
| Tailscale Serve headers differ from the stand-in | Medium: sign-in fails | The stand-in sends `X-Forwarded-Proto: https` and keeps `Host`. Sign-in depends on both. Test the real thing first in phase 1. |
| Upstream auth or CSP changes | Medium | Hermes moves fast, with several releases this month. Pin a minimum version and keep the Electron test. The contract is plain HTTP and cookies, not private APIs. |
| `hermes update` fails to rebuild the bundle | Medium: pane shows "unavailable" | Hermes reports it and `hermes webapp` rebuilds it. Surface it in the connection check. |
| Gateway restart ends terminals and running work | Low | Applies to every Hermes surface. Hermes refuses to restart during a running chat in Web Access; the plain command path was not checked. |
| Workspace shortcuts do not fire with focus in the view | Low | The tab-level `before-input-event` handler is not attached here, and Hermes has its own keybinds. Decide which shortcuts must win in phase 1. |
| Narrow-pane layout may be poor with live sessions | Medium | Not assessed. Phase 2 decides. |
| Build takes minutes and needs Node on the host | Low | `--build-only` during setup, and `hermes update` keeps it current. |

## What should become Desktop plugins

The SDK's rules decide most of this. A plugin is **not sandboxed**: it runs with full
app authority in the renderer. The docs say not to treat the pipeline as a trust
boundary and never to mount a raw `<webview>`. `SandboxedFrame` has an opaque origin,
so it holds no sign-ins. In the Webapp, plugins come from the **gateway host's**
folder, so they run wherever Hermes runs, not on the user's Mac.

So a plugin cannot own anything that is a security boundary or needs Electron views.
It also cannot call the Workspace API directly: that API rejects any request with an
`Origin` header and its token must stay out of renderers.

Ship these as one unified package, adding `desktop/plugin.js` to `alans-way`. The host
copies the desktop half itself, including on headless hosts, which suits a VM gateway.

| Feature | Plugin? | Surface | Notes |
|---|---|---|---|
| Proactivity settings: idle time, active hours, pause, bound chat | **Yes, first** | `ctx.registerSettingsPage`, `plugin_api.py` | Already agent-side, and today means editing JSON or using commands. Best first plugin: valuable, no Workspace dependency. |
| Texting voice and shared persona | **Yes** | Same settings page | Replaces `/tone` and `~/.config/alans-way/config.json` editing. |
| "Agent is using your browser" indicator | **Yes** | `ctx.onEvent` on `tool.start` / `tool.progress` / `tool.complete`, `STATUSBAR_AREAS` | Needs only gateway events. Match on the Alan's Way MCP tool names. |
| Cross-bot asks | **Later** | Session row decorations or a transcript directive | Useful once several bots are in daily use in the Webapp. |
| Doctor and setup status | **Later** | Settings sub-page, `plugin_api.py` | Reports what the host can see. It cannot see the Mac's Workspace. |
| Recordings list | **Later, if at all** | Pane | Data lives in the Workspace, so it would go through the MCP tool. Recording itself stays in the Workspace. |
| Browser pane, tabs, extensions, downloads, site permissions | **No** | | Needs Electron views and sign-ins. |
| Agent control, takeover, approvals, address barriers | **No** | | Security boundaries belong in the main process. |
| Computer-use helper, Mac permissions | **No** | | Native, on the user's machine. The gateway host may be elsewhere. |
| Telegram pane, cloud onboarding, updater, VM viewer | **No** | | Workspace shell concerns. The first needs its preload. |
| iOS app, voice broker | **No** | | Different clients. |

`ctx.preview.executeJavaScript` looks tempting as a route to the right-hand pane, but
it targets Hermes's own preview tab, not the Workspace's. `ctx.socket` is a no-op on
OAuth remotes, so plugins need a polling fallback.

## Open questions

1. Is the `.ts.net` exception to literal-address enforcement acceptable?
2. Is a dashboard password acceptable, given it has no MFA and any tailnet device can
   reach the form? The alternative is OAuth/OIDC, which needs the origin allowlist the
   prototype lacks.
3. Is the goal to replace the native Hermes pane, or to offer the Webapp beside it?
   This decides how much phase 1 is worth.
4. Should bot selection stay primary in this mode, or should Hermes profiles replace
   the bot list when the Webapp is showing?
5. Should the default change surfaces by itself? As specified, someone with an address and
   no saved choice gets Hermes Desktop when the host answers and Telegram when it does not,
   decided at launch. Saving a choice when the address is first entered would remove that
   flip, at the cost of one more decision.
