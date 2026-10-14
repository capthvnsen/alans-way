# Update prompt for your cloud agent

The app's **Copy agent update prompt** button points here through
https://openalan.com/agent-update. Hermes updates the plugin through its
recorded installation source; the newly installed `workspace-setup` skill
owns the matching server and connector refresh.

```text
Update the Alan's Way Plugin and Alan's Tools on this server. This server runs
my Hermes gateway with the alans-way plugin; bring the plugin and its server
tools up to date and prove they still work. Do not modify Hermes itself.

Rules for the whole job:
- Never print, paste or ask me for secrets (bot tokens, auth keys, passwords).
- Run each check. Fix a failing check or report exactly what failed; distinguish
  working capabilities from skipped steps and warnings.
- Preserve this profile's existing addresses, bot identity, timezone, binding
  and preferences. Ask about conflicts or missing values before changing them.

1. Find the profile owning this conversation with `hermes profile list`.
   Check `hermes -p <profile> plugins list`, using `-p default` for the default
   profile. If alans-way is absent, stop and ask me to send the app's setup
   prompt (Settings → Agent setup → Copy setup prompt).
   Record the installed plugin version and exact revision through Hermes'
   install record; a separate source checkout is not proof of what is running.

2. Inspect Hermes' recorded installation source first. If the install is
   from a local file or developer source and has no reviewed update target,
   stop and ask for an explicit release tag or full commit. Do not silently
   switch sources or advance a checkout to a branch tip. For a catalog
   install, use Hermes' catalog update:
     hermes -p <profile> plugins update alans-way
   Follow the installed CLI's help and report any security-scan findings;
   obtain explicit approval before any documented one-install override.
   Never disable scanning globally. If Hermes requires a stopped gateway,
   explain the pause and use its owner's documented drain/restart workflow.
   Confirm the newly installed version and exact revision before proceeding.

3. Load the newly installed workspace-setup skill from this profile's
   alans-way plugin, not a standalone user-skill copy or online branch.
   The installed workspace-setup skill is authoritative for revision
   resolution, server tools, connector refresh, verification and restart.
   If the old skill is still loaded, report that and resume after Hermes
   loads the update. If the skill links to an older setup prompt, use it
   only for human handoff context, not a second installation recipe.
   Resolve its plugin pin from the install record or matching release tag
   as prescribed, and its desktop pin from the newly installed skill.
   Verify checkouts match. Every script and supporting document must resolve
   to those revisions. Keep --repo-ref, --desktop-ref and --skip-plugin for
   the refresh, with --non-interactive and this profile's existing values.
   Do not pass --bind or --proactive or overwrite previously answered setup
   choices. Never execute a branch URL or unpinned checkout. If a pin or
   saved value cannot be resolved, stop and report it. If trust needs repair,
   use the skill's validated --mac-key and --mac-host-key flow; never append
   pasted keys to SSH trust files yourself. Keep host-key checking enabled.

4. Follow the skill's checks and gateway restart through its real owner,
   with the restart last. Relay any display-stack prerequisite for approval
   before installation. Before restarting, tell me when to send the next
   message; once a restart is scheduled, send the summary and start no
   further tool calls in that turn. On my next message, follow the skill's
   post-restart audit and give me these numbered human checks:
   1. Keep Alan's Workspace running, signed into Telegram, and Tailscale
      signed into the same account as the server. If Telegram needs a new
      login, scan its QR on my phone via Settings → Devices → Link Desktop
      Device. If Tailscale needs login, open its login link myself.
   2. On a Mac, confirm Remote Login under System Settings → General →
      Sharing. Updates can switch off app grants: if computer control fails,
      at the Mac itself turn Alan's Workspace (listed as alans-way-localapp)
      off and on under Privacy & Security → Accessibility and Screen
      Recording. Browser tabs work without those grants.
   3. In the app, open Settings → Agent setup → Test agent path. Then message
      the bot: "Open example.com in the workspace browser and tell me the
      page title." Confirm a workspace tab appears and the reply says
      "Example Domain".

Finish with a short report: old → new installed plugin revisions (or "already
up to date"), the resolved desktop revision, what passed, every setup warning,
and anything skipped or still needing me. Do not claim a gateway reload or
computer connection until its check has passed.
```
