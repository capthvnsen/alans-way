# Setup prompt for your cloud agent

The app copies the shorter clipboard block from this same document, bundled
with each release; the README and openalan.com/agent-prompt serve it online.
This prompt gets the plugin installed and explains the human handoffs. The plugin's installed
`workspace-setup` skill owns the setup procedure and revision pins.

```text
Set up Alan's Workspace for me. This server runs my Hermes gateway; connect it
to my <Mac | Windows PC | Linux computer> over Tailscale, install the Alan's
Workspace app on it and the Alan's Way Plugin (`alans-way`) here, and prove it
works. Do not modify Hermes itself.

Rules for the whole job:
- Never print, paste or ask me for secrets (bot tokens, auth keys, passwords).
  Only public keys, addresses and names go in chat.
- Do everything you can yourself. When a step needs me, give me short numbered
  instructions, then wait for my reply. Never treat silence as consent.
- Run each check. Fix a failing check or report exactly what failed; distinguish
  working capabilities from skipped steps and warnings.
- The installed workspace-setup skill is authoritative for preflight,
  Tailscale, SSH trust, configuration, binding, verification and the gateway
  restart. This prompt supplies bootstrap, app installation and human handoffs.
  Never create or write your own setup skill, or use a standalone user-skill
  copy. Do not fetch other setup guides, even if the installed skill links
  to an older setup prompt or setup-for-agents guide. Use the human handoffs
  below and the installed skill's pinned procedure.

1. Find the Hermes profile that owns this conversation with `hermes profile
   list` and check `hermes --version`. Use `hermes -p <profile>` for every
   plugin operation below, including `-p default` for the default profile.
   Check `hermes -p <profile> plugins list`. Preserve an existing alans-way
   install. If it is absent, install through Hermes' reviewed catalog:
     hermes -p <profile> plugins install alans-way --enable
   Follow the installed CLI's help if its flags differ. If the catalog entry
   is unavailable, stop and report it; do not substitute a repository tip.
   If security scanning blocks installation, report the findings and obtain
   explicit approval for any documented one-install override. Never disable
   scanning globally or infer scan approval from this setup request. If
   Hermes requires a stopped gateway for installation, explain the pause and
   use its owner's documented drain/restart workflow, then resume here.

2. Load the installed workspace-setup skill with Hermes' tool call
   skill_view(name="alans-way:workspace-setup"). The plugin registers
   workspace-setup; Hermes exposes it as alans-way:workspace-setup. Check
   the returned source path belongs to this profile's installed alans-way
   plugin: <profile-home>/plugins/alans-way/skills/workspace-setup/SKILL.md
   (default: ~/.hermes/plugins/alans-way/skills/workspace-setup/SKILL.md;
   named profile: ~/.hermes/profiles/<profile>/plugins/alans-way/skills/workspace-setup/SKILL.md).
   If skill_view is unavailable, read that installed file directly in full.
   Follow it verbatim. Do not use a bare skill name, a similarly named
   user skill, a web summary or a repository copy as a substitute.
   If the plugin is absent, install it from the catalog in step 1 first.
   If it is installed but the skill cannot be loaded or read, stop, report
   the exact missing skill/path and resume after Hermes loads the plugin;
   do not reconstruct the procedure or fetch a fallback guide.
   Follow its revision-resolution rules: resolve the plugin pin from Hermes'
   install record, or the matching release tag when the skill prescribes it,
   and use the reviewed desktop revision it specifies for server setup and
   connector scripts. Check that checkouts match before executing anything.
   Keep --repo-ref, --desktop-ref and --skip-plugin when running setup;
   use --non-interactive and ask the skill's questions yourself.
   Resolve server scripts, connector scripts and
   supporting documents to those pins, including connect-mac.sh,
   connect-windows.ps1 and connect-linux.sh. Never use a branch URL or an
   unpinned checkout as an executable source. If a pin cannot be resolved,
   stop and report it.
   Use the skill's validated --mac-key and --mac-host-key flow with --mac-ssh
   for the public outputs returned by my computer; never append pasted keys
   to SSH trust files yourself. Keep host-key checking enabled.

3. Work through the skill, presenting these human checkpoints when needed:
   1. If Telegram is not configured for the bot, guide me through Hermes'
      gateway setup → Telegram → Automatic (QR scan). I scan with my phone
      and message the bot once so a real DM route exists.
   2. Send me the server's Tailscale login link to approve. On my computer,
      I install Tailscale from https://tailscale.com/download and sign in
      with the same account. Wait for both machines to join the same tailnet.
   3. Confirm my computer's OS. On a Mac, I open System Settings → General →
      Sharing and turn on Remote Login. On Windows, I open PowerShell as
      Administrator for the skill's OpenSSH steps. On Linux, I enable the
      SSH server and use a terminal in my desktop session.
   4. If the app is absent, guide me to the latest published app release at
      https://github.com/capthvnsen/alans-way/releases/latest and its asset
      for my OS (Mac DMG, Windows installer, or Linux AppImage). I install
      and open it. This app installer follows the latest app release; it is
      not pinned to the skill's desktop revision. Record the release tag
      and installed app version separately from the server/connector pin.
      If the release asset is unavailable for my OS, stop and report it.
      The source-build installers and connectors' default install paths
      fetch installer scripts and/or app source from main; pinning a
      connector alone does not pin those dependencies. Do not use those
      paths for this setup.
      Give me the skill's OS-specific connect command, with its script
      resolved to the reviewed desktop pin and its public server values
      filled in. Always pass --skip-install (Mac/Linux) or -SkipInstall
      (Windows), including after a fresh release install. Preserve an
      existing installed app and open it before connecting.
      I paste the command into my computer's terminal and send back only
      the public output between the markers.
      If the command stops, I send its error.
   5. In Alan's Workspace, I scan its Telegram QR code: on my phone, Telegram
      → Settings → Devices → Link Desktop Device. This is separate from
      creating the bot's Telegram gateway.
   6. On the Mac itself, I open System Settings → Privacy & Security and
      enable Alan's Workspace (listed as alans-way-localapp) under both
      Accessibility and Screen Recording. Browser tabs work without these
      grants; control of other apps needs them. Windows computer control
      requires the app to stay running in the signed-in desktop session.
   Ask the skill's proactivity and other preference questions separately;
   do not choose answers for me. Relay any display-stack prerequisite and
   obtain the required approval before installation.

4. Let the skill verify setup and restart the gateway last through its real
   owner. Before restarting, tell me when to send the next message; after
   the skill schedules a restart, send the summary and start no further
   tool calls in that turn. On my next message, follow its post-restart audit.
   Then give me these numbered checks:
   1. In the app, open Settings → Agent setup. Enter the server and computer
      addresses you verified, click Save addresses, then Test agent path.
      It should confirm that the server reaches this computer over SSH.
   2. Message the bot in the app: "Open example.com in the workspace browser
      and tell me the page title." A tab with the bot's cursor should appear
      and the reply should say "Example Domain".

Finish with a short report: the exact installed plugin revision, resolved
server/connector desktop pin, installed app version and release tag (if known),
what passed, every setup warning, and anything skipped or still needing me.
```

## Prompt copied by the app

This block fits in a Telegram message with the app's computer facts. Load the
installed skill before fetching this document for the detailed handoffs above.
Settings and the setup wizard copy the same block; setup steps and revision
pins remain owned by the installed skill.

<!-- clipboard-prompt -->
```text
Set up Alan's Workspace for me. Connect this Hermes server to my
<Mac | Windows PC | Linux computer>. Do not modify Hermes itself.

First find the Hermes profile owning this conversation with hermes profile
list. Use hermes -p <profile> for plugin operations, including -p default.
Check plugins list; preserve an existing alans-way install. If absent,
install the plugin from Hermes' reviewed catalog first:
  hermes -p <profile> plugins install alans-way --enable
If the catalog is unavailable, stop and report it; never use a repository tip.
Follow installed CLI help if flags differ. Never bypass security scanning:
report blocked findings and obtain explicit approval for any documented
one-install override. Never infer scan approval from this request.

Before any setup, load the installed workspace-setup skill using Hermes'
skill_view(name="alans-way:workspace-setup"). Check that its source is this
profile's installed plugin file:
<profile-home>/plugins/alans-way/skills/workspace-setup/SKILL.md
(default: ~/.hermes/plugins/alans-way/skills/workspace-setup/SKILL.md;
named profile: ~/.hermes/profiles/<profile>/plugins/alans-way/skills/workspace-setup/SKILL.md).
If skill_view is unavailable, read that installed file directly in full.
If the installed skill cannot be loaded or read, stop and report the exact
missing skill/path; resume after Hermes loads the plugin. Never create or
write your own setup skill, or use a standalone user skill or repository copy.
Follow it verbatim, including its reviewed plugin and desktop pins. Never
execute branch/main URLs or unpinned checkouts, or drop its pin flags.

For detailed app installation and human handoffs, fetch only
https://openalan.com/agent-prompt and use its first text block alongside the
installed skill. If extraction fails or is incomplete, stop and report it.
Do not fetch other setup guides, including legacy setup-for-agents guides or
older prompts linked by the skill. Never reconstruct setup from a web summary.
Never disclose or request secrets. Ask each preference; do not choose for me.
Give short numbered human steps and wait for replies; silence is not consent.
Keep the gateway restart last. Report pins, app version, checks, warnings and
skips; never claim a capability without verification.
```

## What it needs from you

1. Scan the Telegram gateway QR on your phone if the bot is not configured,
   then send the bot a message.
2. Approve the server's Tailscale login link and sign your computer into the
   same account.
3. Enable your computer's SSH server (Remote Login on a Mac). If the app is
   absent, install the latest app release for your OS. Paste the pinned
   connect command with skip-install and return its public output.
4. Sign in to Telegram in Alan's Workspace using its QR code.
5. On a Mac, grant Accessibility and Screen Recording at the Mac itself.
6. Answer the setup preferences, then use Test agent path and the browser
   example to check the connection after the gateway restart.
