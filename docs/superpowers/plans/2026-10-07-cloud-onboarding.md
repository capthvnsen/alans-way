# Cloud onboarding in the desktop app Implementation Plan

> **For agentic workers:** Implement task by task, test first. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A customer who paid on openalan.com clicks "Open Alan's Way". The app claims their cloud computer, pairs it over Tailscale, optionally migrates their old Hermes, sets the model login, and sets up Telegram, all in the onboarding wizard. DIY users get the same steps through "Use my own server".

**Architecture:**
- New logic goes in small CommonJS modules under `desktop/src/`. Each one is unit-testable with node, in the style of `desktop/test/*.test.cjs`.
- They're wired into `main.cjs`, which handles the protocol, IPC and SSH, and into `renderer.js`'s `renderOnboarding`.
- Gating is extended in `onboarding.cjs`.

**Tech Stack:** Electron (existing), node tests run by `npm test` (`npm run check`), plus Electron tests for the embedded-Telegram flow.

## Backend contract (implemented elsewhere, treat as fixed)
Base is `https://openalan.com`. `ALANSWAY_API_BASE` overrides it for tests.
- `POST /api/claim` with `{token, install_id}` returns `{session, expires_at}`. It returns 409 if the token was already claimed by another install, and 404 if it's unknown.
- `GET /api/computer` with `Authorization: Bearer <session>` returns `{state, step, error, tailscale_url, computer_name}`.
  - `state` is one of `new|client_created|computer_created|bootstrapping|ready|failed`.
  - When `ready`, the step is `waiting_for_pairing` or `paired`.
- The Discord link is `https://openalan.com/api/discord/start?session=<session>`.
- The computer's Tailscale hostname is `computer_name`, the same as `alan-<id>`. Use it as the SSH host once paired. The user is `root` unless SSH says otherwise.

## Global Constraints
- **No new runtime dependencies.** Use Node `fetch`, `safeStorage` for the session token, and `app.setAsDefaultProtocolClient('alansway')`.
- **Don't regress the existing 3-step onboarding** or the update flow. `npm test` must pass, as must the existing Electron suites you touch.
- **Never write `ANTHROPIC_BASE_URL`.** Don't write `ANTHROPIC_API_KEY` when the user chose a Claude subscription login.
- **Never log the session token, claim token or bot token.**
- **UI copy:** no em-dashes. Keep the existing tone and style tokens.
- Commit messages follow the repo style (plain sentence describing behavior) and end with `Co-Authored-By: Devin SWE-2 <noreply@cognition.ai>`.
- Never use `git stash`, never push.

## Review Focus
1. **The app isn't running when the deep link is clicked** (cold start). On macOS the token arrives via `open-url` before the window exists. On Windows it arrives in `argv` / `second-instance`. Either way it must not be lost.
2. **The claim link is clicked twice, or the app restarts mid-onboarding.** It resumes at the right step using the stored session, and does not re-claim.
3. **BotFather replies "Sorry, this username is already taken"** or rate-limits. The app retries with a suffixed username up to 3 times, then falls back to paste-token.
4. **The computer `state` goes to `failed`.** The wizard shows "We're on it" plus the support Discord button, and does not spin forever.
5. **A migrated profile already has a `TELEGRAM_BOT_TOKEN`.** The Telegram step is skipped for it, and no new bot is created.

---

### Task 1: `cloud-claim.cjs` (deep link, claim, session storage)
- `parseClaimUrl(url) → token|null` accepts only `alansway://claim?token=<base64url>`.
- `claim(apiBase, token, installId, fetchImpl) → {session, expiresAt}` maps 409 and 404 to typed errors.
- `installId` is a random id persisted in prefs.
- `main.cjs`:
  - Register the protocol.
  - Handle `open-url`, `second-instance` and the cold-start argv. Queue the token until the window is ready.
  - Store the session with `safeStorage` in prefs `cloud.sessionEnc`.

**Tests:** cover the parser accepting and rejecting inputs, the claim error mapping, and queuing before window-ready (pure function on the queue).

### Task 2: `cloud-status.cjs` and the wizard's wait step
- `pollComputer(apiBase, session, {fetchImpl, intervalMs, onUpdate, signal})`.
- `onboarding.cjs` gains a cloud branch with steps `cloud-wait`, `connect`, `migrate`, `model`, `telegram`, `support` and `done`. Progress persists in prefs, so restarts resume (Review Focus 2).
- Show `failed` per Review Focus 4.
- Add a paste-claim-code field on the first onboarding screen.

**Tests:** cover step resolution from persisted prefs, the failed-state rendering decision, and polling stopping on `ready`.

### Task 3: Connect step (Tailscale)
- Detect the Tailscale CLI: macOS `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, Windows `tailscale.exe` on PATH.
- If it's missing, show the download link and a "check again" button.
- Open `tailscale_url` with `shell.openExternal`.
- Poll `tailscale status --json` for a peer whose HostName equals `computer_name` and is online.
- Then set `prefs.vpsBrowser.sshHost` to that peer's tailnet IP. It must pass the existing Tailscale-only check.
- Run the existing SSH reachability and `AGENT_PATH_OK` checks from `main.cjs:858-872` (reuse, don't copy).
- On the remote, run `/usr/bin/env bash -lc 'curl -fsSL https://openalan.com/bootstrap | bash -s -- --wait-paired'` is NOT needed. Instead, read `/var/lib/alan/state.json` over SSH to confirm.
- **DIY "Use my own server"** enters this step with a host field instead of claim data.

**Tests:** cover peer matching from a `tailscale status --json` fixture, and missing-CLI detection per platform.

### Task 4: Migrate step
- Two choices: "Bring my existing Hermes" or "Start fresh".
- **Bring:** show the copyable command `curl -fsSL https://openalan.com/migrate | bash -s -- --to <sshHost>`, with a note to run it on the old machine. If the old machine is this Mac, add a button that runs it locally in a hidden pty and streams the output.
- Detect completion by polling over SSH for `~/.hermes.pre-migrate-*` or a `~/.hermes/.migrated` marker. Coordinate on the marker name: use `~/.hermes/.migrated` and note it in the PR for the agents repo.
- After a migration, list the profiles that already have `TELEGRAM_BOT_TOKEN`. Do it over SSH with grep, without printing values.

**Tests:** cover command building with shell-safe quoting of the host, and parsing the profile list.

### Task 5: Model step
- Two choices.
- **"Use my Claude subscription":** run `hermes auth login` (or the equivalent you find in Hermes docs on `ssh orgo`, read-only) over SSH in an embedded terminal view, and let the user complete the browser login.
- **"Paste an API key":** write `ANTHROPIC_API_KEY=<key>` to the chosen profile's `.env`, shell-quoted, replacing any existing line. Then restart the gateway via `supervisorctl restart all`. Read the program name from the server.

**Tests:** cover the `.env` line replacement keeping other lines byte-identical, and the shell quoting.

### Task 6: Telegram step (BotFather automation in embedded Telegram Web)
- Skip profiles that already have a token (Review Focus 5).
- Otherwise, in the embedded Telegram webview (see `telegram-preload.cjs` / `telegram-contract.cjs` for how the app already drives it):
  1. Open `@BotFather`, send `/newbot`, then a name ("<First name>'s Alan"), then the username `<first>_alan_<4 random>_bot`.
  2. Parse the token with `/\d{6,}:[A-Za-z0-9_-]{30,}/`.
  3. Validate it with `https://api.telegram.org/bot<token>/getMe`.
  4. Write `TELEGRAM_BOT_TOKEN` to `.env` over SSH and restart the gateway.
  5. Open `t.me/<username>` in the embedded Telegram and send `/start`.
- Retry and fallback follow Review Focus 3.
- **Paste-token fallback:** numbered steps plus one field, validated by `getMe`.

**Tests:**
- Unit tests for the reply parser (success, username taken, rate limit "Too many attempts", unknown) and the username generator.
- An Electron test with a fake Telegram page in the style of the existing Electron suites. It covers the success path and the taken-then-success path.

### Task 7: Support and done
- The support step shows a "Join support Discord" button with the URL from the contract, plus "Skip".
- Add a permanent "Get help" menu item when `cloud.sessionEnc` exists.
- The done step opens the bot chat.
- Run the full `npm test` and the Electron suites for onboarding and Telegram. Fix any regressions.
