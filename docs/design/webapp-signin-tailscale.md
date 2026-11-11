# Webapp sign-in over Tailscale

Status: design only, 2026-11-11. No code, config or gateway change comes with this doc.
It answers open questions 1 and 2 of the Hermes Webapp embed plan (PR #284,
`docs/design/hermes-webapp-embed.md` on `agent/lane4-webapp-embed`) and gives the
rollout steps that need Alex.

Hermes facts were read from the local Hermes checkout at `v0.23.1` (`3b421578588`,
2026-11-09). Tailscale facts come from Tailscale's docs. Nothing in this doc was run
against a real tailnet, gateway or VM. Anything marked **UNVERIFIED** has to be checked
during rollout.

## Problem

The Workspace can show the Hermes Webapp in the chat pane (PR #284). The Webapp runs on
the Hermes host, which today is Alan's VM: a Hetzner machine with a **public IP**. A
signed-in Webapp user can run any command as the Hermes OS account, read and write its
`.env`, and drive the agent's tools (Hermes `desktop.md`, "Treat Webapp access like
access to Hermes on the host"). So the sign-in protects a root-equivalent shell.

The requirements:

1. Only Alex can sign in. A stranger on the internet gets nothing, and a device on the
   tailnet that isn't Alex's should get nothing either.
2. HTTPS. The Webapp turns off the mic, clipboard read, notifications and the bot screen
   on plain HTTP.
3. Sign-in survives Workspace restarts. One sign-in, then about 30 days with no prompt.
4. No password or token stored by the Workspace, and no long-lived Hermes credential
   copied off the host.
5. Nothing reachable from the public internet. No Funnel, no public port.
6. Keep the account split from #273/#275: other OS users on the VM (the browser broker
   login) must not gain the Hermes account's authority through this.

## How Hermes decides whether to ask for sign-in

From `website/docs/user-guide/configuration.md` (Webapp section):

- `webapp.host` loopback with no `public_url`: **private mode**. No sign-in, only a
  one-use 60-second link, and the token lives in `sessionStorage`. It does not survive a
  restart (requirement 3 fails).
- `webapp.public_url` set, or `host` set to `0.0.0.0`/`::`: **gated mode**. A dashboard
  auth provider is required, or the gateway serves native clients only. Sign-in sets
  HttpOnly `__Host-` cookies, with a 30-day refresh token (`_RT_MAX_AGE` in
  `hermes_cli/dashboard_auth/cookies.py`).
- The Webapp accepts `X-Forwarded-*` only from loopback and `dashboard.trusted_proxies`.
  A proxy on the same host connects from loopback, so it is trusted with no extra config.

Providers bundled with Hermes (`plugins/dashboard_auth/`):

| Provider | What it is | Fit here |
|---|---|---|
| `basic` | One username and an scrypt password hash. HMAC-signed sessions. No MFA. Throttled to 10 tries a minute per client IP (`routes.py`). | Good behind a tailnet ACL. |
| `self_hosted` | Generic OIDC with PKCE. Needs an HTTPS issuer. **Accepts any `sub` the issuer signs.** There is no user allowlist on the Hermes side. | Only safe if the issuer itself limits who can log in. |
| `nous` | Nous Portal OAuth. | Ties a private tool to an outside account. Not needed on a tailnet. |
| `session_token` | Bearer token for native clients. No cookies, no login page. | Not a browser sign-in. |

## Threat model

Assets: a shell as the Hermes OS user on the VM, the secrets in its `.env`, and agent
sessions that can drive Alex's Mac and browser through the Workspace.

| # | Attacker | Path they would try | Must stop it |
|---|---|---|---|
| T1 | Anyone on the internet | Public IP of the VM, any port | Nothing listens on a public interface. No Funnel. |
| T2 | Another device or user on the tailnet: a shared node, a guest, a lost phone, Grok Bot's computer (it reaches the VM over Tailscale SSH) | `https://<vm>.<tailnet>.ts.net` | Tailnet policy lets only Alex's own devices reach port 443 on the VM. Password second. |
| T3 | A lost or stolen device of Alex's that is still on the tailnet | Same URL, and maybe a live cookie in the Workspace partition | Remove the device in the Tailscale admin console. That ends its network access at once. Then `hermes webapp --sign-out` and rotate the password. |
| T4 | Another OS user on the VM (the broker login, a compromised service) | `curl 127.0.0.1:<webapp port>` with forged headers | The Webapp must check a credential that a local process can't fake. A password or a signed token does that. A header such as `Tailscale-User-Login` does not (see Rejected B). |
| T5 | Web pages in the Workspace Browser pane | Read Webapp cookies, or frame the Webapp | Separate partition `persist:hermes-webapp`, no preload. The Webapp sends `frame-ancestors 'none'` (PR #284). |
| T6 | DNS rebinding or a look-alike `.ts.net` name typed into Settings | Point the Workspace pane at someone else's host | The TLS certificate binds the name. The pane holds no bridge, so a wrong host gets a login form and no Workspace powers. Pin the expected tailnet suffix (see Workspace side). |
| T7 | Password guessing from an allowed device | Login form | Long random password and the Hermes throttle. Only Alex's devices can reach the form anyway. |
| T8 | Password leaking through setup | Shell history, chat transcripts, the agent's own logs | Alex types it into a prompt on the VM. Only the hash goes into config. No agent ever sees it. |

Out of scope: the Hermes account itself, which already holds this authority. Tailscale's
coordination server, which we trust for device identity. A compromised Mac session of
Alex's, which already holds the cookie.

## Options

### A. Tailscale Serve + tailnet policy + `basic` password (recommended)

Serve terminates HTTPS on `https://<vm>.<tailnet>.ts.net` with a real certificate and
forwards to the loopback Webapp. `webapp.host` stays `127.0.0.1` and `public_url` is the
`.ts.net` address. A tailnet policy rule opens port 443 on the VM to Alex's own devices
only. The Hermes password is the second check.

Two independent locks: a WireGuard device key that is on Alex's list, and a password.
Tailscale's SSO login, with whatever MFA Alex's identity provider enforces, sits in front
of adding any device. It uses only bundled Hermes code and stock Tailscale. Meets
requirements 1 to 6.

Costs: a password to keep in a password manager. Hermes' password provider has no MFA,
which the policy rule makes up for. `dashboard.basic_auth.secret` has to be set to a
stable value, or every gateway restart signs Alex out (Hermes `web-dashboard.md`,
troubleshooting).

### B. Tailscale Serve identity headers + a custom auth provider (rejected)

Serve adds `Tailscale-User-Login` for requests from tailnet users. A small custom Hermes
provider could trust that header and skip the password.

Rejected because of T4. The Webapp listens on loopback, and **any** process on the VM can
connect there and send the header itself. That would hand the Hermes account's authority
to every other OS user on the VM, which undoes the broker/agent account split from #273
and #275. Making it safe needs a Unix socket readable only by Serve, or a check that the
peer is the `tailscaled` process. Hermes supports neither today. It also means keeping a
custom auth plugin working through Hermes' frequent auth changes. Serve also sends no
identity headers for tagged devices (Tailscale Serve docs).

### C. tsidp (Tailscale's OIDC issuer) + Hermes `self_hosted` OIDC (later, if wanted)

`tsidp` runs as its own tailnet node and issues OIDC tokens for the tailnet user who
opens it. Hermes' `self_hosted` provider would accept them. That means no password at all.
Identity is the tailnet login, and the session is still a signed token, so T4 holds.

Not now:

- Hermes accepts any `sub` the issuer signs. Who can log in then depends entirely on the
  tsidp grant (`tailscale.com/cap/tsidp`, `users` field). Whether that grant can limit
  **this client's** `/authorize` to Alex, rather than the whole tailnet, is
  **UNVERIFIED**.
- Hermes' provider is a PKCE public client. tsidp's PKCE and public-client support is
  **UNVERIFIED**.
- It adds a node to run, keep up to date, and keep up.
- The OIDC redirect leaves the Webapp origin. PR #284's pane opens off-origin navigations
  as Browser pane tabs, so the pane needs an allowlist for the issuer's origin. That is
  more Workspace code.

Revisit if Alex wants passwordless sign-in or more than one person signing in.

### D. Wildcard bind on the VM (rejected)

`webapp.host` accepts only loopback or wildcard values. `0.0.0.0` also listens on the
Hetzner public interface (T1), and it's plain HTTP (requirement 2).

### E. SSH tunnel + one-use link (keep as a fallback only)

There's no password, but every launch needs a fresh link (requirement 3). On Linux the
link only works over a connection owned by the Hermes OS user. That would mean Workspace
SSH logging in as the Hermes account, which #273 deliberately moved away from. PR #284
already supports pasting the link, so no work is needed here.

### F. Nous Portal OAuth (rejected for this use)

Built for internet-facing dashboards. Here it adds an outside account and outside
availability to a tailnet-only tool, and does nothing for T2 that the policy rule doesn't
already do.

## Recommendation

Option A: Serve on 443, `webapp.host: 127.0.0.1`, `webapp.public_url` set to the
`.ts.net` address, the `basic` provider with a stable `secret`, and a tailnet policy rule
that opens the VM's 443 only to Alex's devices. Never Funnel.

Answers to PR #284's open questions:

1. **`.ts.net` exception in `tailnet.cjs`: accept it, but narrower.** Allow only
   `https://` and only names that end in the tailnet's own MagicDNS suffix, saved once in
   settings (or read from `tailscale status --json`, field `MagicDNSSuffix`). The
   certificate, the policy rule and the missing bridge cover the rest. Resolving the name
   and requiring an answer in `100.64.0.0/10` adds code and still loses to a later
   re-resolve, so skip it.
2. **A password with no MFA is acceptable only together with the policy rule.** The
   policy rule is what keeps T2 away from the form. Without it, any tailnet device can try
   passwords against a root-equivalent shell. Rollout step 2 is not optional.

### Workspace side (for the implementation lane, not this doc)

Small, and all of it is in PR #284's code:

- `hermesWebappUrl()`: add the suffix pin above, and keep the loopback form for the
  SSH-tunnel fallback.
- The connection check should report "signed out every restart" when `/api/status` lists
  `basic` and cookies keep vanishing. That is the missing-`secret` symptom.
- Settings gets a **Sign out of Hermes Desktop** action that clears the
  `persist:hermes-webapp` partition. That covers T3 on the Mac side.
- No password field anywhere in the Workspace. Sign-in happens in the Webapp's own form.

## Rollout steps that need Alex

Only Alex can do these. They change the tailnet policy, set a secret, and restart the
shared Hermes gateway. Agents must not do any of them. Replace `<vm>` and `<tailnet>` with
the real names from the Tailscale admin console's Machines page.

**1. Choose a password.** Make a new random password of at least 24 characters in the
password manager and label it "Hermes Webapp". Don't paste it into any chat or agent.

**2. Lock port 443 to your devices.** In the Tailscale admin console:
1. Open **Access controls**.
2. Make sure no rule lets everyone reach the VM on every port. Rules with
   `"dst": ["*:*"]` or `"<vm>:*"` for `autogroup:member` or `*` do that.
3. Add a rule that lets only your own login reach the VM on 443:
   `{"action": "accept", "src": ["<your-tailscale-login>"], "dst": ["<vm>:443"]}`
   If you use `grants`, use the same idea: your login as `src`, the VM as `dst`,
   `"ip": ["tcp:443"]`.
4. Keep the existing SSH rules exactly as they are. #274 and #275 depend on them.
5. Click **Save**. It worked if the console saves with no error.

**3. Turn on Serve and the Webapp on the VM.** SSH into the VM yourself, then as the
Hermes OS user:
1. `tailscale serve --bg --https=443 http://127.0.0.1:<webapp port>`
   (the port is in `hermes webapp --status`; PR #284 used `9120`).
2. `hermes config set webapp.enabled true`
3. `hermes config set webapp.public_url https://<vm>.<tailnet>.ts.net`
4. `hermes config set dashboard.basic_auth.username alex`
5. Make the hash. This prompts for the password, so it stays out of shell history:
   `python -c "import getpass; from plugins.dashboard_auth.basic import hash_password; print(hash_password(getpass.getpass()))"`
   Run it from the Hermes checkout so the import resolves. Paste the output into
   `hermes config set dashboard.basic_auth.password_hash '<output>'`.
6. Set a stable signing secret:
   `hermes config set dashboard.basic_auth.secret "$(openssl rand -base64 32)"`
7. `hermes webapp --build-only`
8. When no chat is running, `hermes gateway restart`. This ends running work on **every**
   profile that gateway serves, so pick a quiet moment.
9. Run `tailscale funnel status`. It should say Funnel is off. If it lists anything, run
   `tailscale funnel reset`.

It worked if `hermes webapp --status` reports gated mode with the `basic` provider.

**4. Sign in from the Workspace.** In the Workspace, open Settings → General → Chat
surface, choose **Hermes Desktop**, and enter `https://<vm>.<tailnet>.ts.net`. Sign in
with `alex` and the password. It worked if the Webapp loads. Quit and reopen the
Workspace: it should still be signed in.

**5. Check that strangers are blocked.** These are the checks that prove the threat model:
1. From a device that is **not** on your policy rule (or with Tailscale turned off), open
   the URL. It should time out.
2. From the internet (phone on cellular, Tailscale off), open `http://<VM public IP>:<webapp port>`.
   It should time out.
3. On the VM, run `curl -s http://127.0.0.1:<webapp port>/api/status`. It should report
   that sign-in is required. A local process gets no free pass.
4. Restart the gateway once more at a quiet moment and reopen the Workspace. You should
   still be signed in. If not, the `secret` from step 3.6 didn't take.

**6. If a device is lost:** remove it on the admin console's Machines page, then run
`hermes webapp --sign-out` on the VM. That signs out every browser, whichever provider it
signed in with (`hermes_cli/webapp_sign_in.py`). Then redo step 3.5 with a new password.
Sign in again on your other devices afterwards.

## UNVERIFIED, to settle during rollout

- That Serve's forwarded headers (`X-Forwarded-Proto: https`, the original `Host`) make
  Hermes accept sign-in. PR #284 tested only a local stand-in. Step 4 checks it.
- Whether the throttle sees each tailnet device's IP or just loopback behind Serve. If it
  is loopback, one shared bucket means an allowed device could lock the form for a minute
  at a time. With step 2 in place, only Alex's devices can do that.
- That the VM's Tailscale node is not tagged in a way that changes which policy rules
  apply.
- Option C's two open points listed above.
