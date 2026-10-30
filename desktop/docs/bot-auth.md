# Identity-bound bot connections

## Upgrade staging and the architecture principal

A nightly upgrade preserves existing connection files and SSH settings. A
connector using a broker file logs **Legacy broker credential**; that existing
shared-user route has no hostile-agent isolation and receives no new trust.
After provisioning an isolated export, select it with `--connection` and set
`HERMES_WORKSPACE_REQUIRE_BOT_CREDENTIALS=1` in that connector's launcher.
Strict clients refuse broker files and other bot identities without fallback;
malformed, revoked or unreadable registries always deny identity-bound calls.
Legacy sudo transport remains only until a separate broker login is selected.

The operator-assigned immutable `botId` in `bot-credentials.json` **is the
principal** of architecture PR #241, sections 3/6/9 and launch decision 5.
The token is its temporary local bearer credential, not a second identity.
Map the eventual restricted OpenSSH key fingerprint to that same principal;
never derive identity from display names, headers or Tailscale device identity.
Grok Bots share their account principal until separate credential storage is
proved; they never inherit Hermes's principal or Allow.

Desktop Allow for an identity-bound credential is keyed to its principal and
credential fingerprint on this app/device. Legacy trusted-bot lists are not
imported. Rotation requires another owner Allow, including Always allow;
revocation while a prompt is pending refuses input. The registry is reread
on every request. Full signed host grants, canonical revisioned JSON profiles,
active-session revocation and restricted OpenSSH 2222 ingress remain rollout
gates; this preparatory PR does not claim those architecture gates passed.

Before migrating SSH settings, apply companion PR #273: it keeps the agent
maintenance login separate from the browser broker login. Do not replace the
agent account with the broker account in the legacy shared SSH field; that
would direct Hermes configuration and environment writes to the wrong home.

Run the desktop app / VPS broker and its SSH request helper as the human or
broker OS user. Run each mutually untrusted bot as a different OS user, without
sudo, broker groups, shared writable code or access to the broker's home.
Both `connection.json` and `app-token.json` are broker credentials. Never copy
either file to a bot. Settings keep the agent login in `vpsBrowser.sshHost` and the separate broker
login in `vpsBrowser.brokerSshHost`, with explicit different usernames and
`sudo: false`. Existing shared-login settings fail closed until migrated; generic sudo request helpers are refused.

The broker's private `bot-credentials.json` binds each random token to one bot
ID and OS UID. Desktop and VPS APIs verify that binding before routing, grants,
overseer privileges, recordings or desktop approval. Registry read/permission
errors refuse bot requests. Rotation takes effect on the next request.

On POSIX hosts, create a private broker data directory (0700) and a separate
broker-owned export directory that bots can traverse but cannot edit (0711).
Keep their parent directories outside bot-writable locations. Use a root-owned
checkout for the broker and SSH helper. For example, after creating separate
`alan-broker` and `alan-bot-a` OS accounts and starting the isolated broker:

```sh
# Set BROKER_HOME to the isolated broker account’s home directory.
sudo install -d -m 0711 -o alan-broker /var/lib/alan-connections
sudo node /opt/alans-way/desktop/scripts/bot-credential.cjs \
  --root "$BROKER_HOME/.local/share/hermes-alans-way/browser" --broker-uid "$(id -u alan-broker)" \
  --bot-id bot-a --uid "$(id -u alan-bot-a)" \
  --output /var/lib/alan-connections/bot-a.json
```

This prints a plan without credentials. Add `--apply` to provision or rotate.
Apply requires root to assign file ownership. Exports are 0600 and owned by the
specific bot user. Existing exports must already belong to that identity.
Run the connector as that bot user with `--bot-id bot-a --connection
/var/lib/alan-connections/bot-a.json`, or set `HERMES_WORKSPACE_CONNECTION` to
that path. A strict connector refuses a broker file; every connector refuses a different bot's file.

Use the same process for the desktop app's data directory under its human OS
user. Do not run an untrusted shell as that user. A token boundary cannot protect
files from another process with the same OS identity.

Protect Chromium's unauthenticated CDP port from all users except the broker,
and use a separate browser OS user with no credentials. Keep its Xauthority,
session bus and desktop sockets inaccessible to bots; never use `xhost +`.
The VPS broker serves the same authenticated `/v1/computer` routes and shared
desktop lease as the app. Give the broker access to the isolated desktop
session; bot connectors do not receive those sockets or launch helpers.
Update older hosts before using desktop tools: connectors fail closed when
the host lacks a computer endpoint. This replaces the legacy per-connector
file lease with one authoritative broker lease.
The browser egress installer supplies the network rules for a Linux browser
user. This provisioning utility does not configure Windows account ACLs.

No service is restarted, user created, firewall installed, or credential
changed by a dry run. Services and OS separation must be configured before
exporting credentials to bots.


Computer broker upgrades must precede strict connector upgrades. A legacy
connection without `botId` keeps the previous in-process desktop path when an
older VM host has no computer endpoint, under the legacy credential warning.
An identity-bound connection or strict launcher never uses that path, including
after broker failure. Its operator must update the broker first and verify
`computer`/`computer-v2` before enabling strict credentials.

Use the broker account's default data directory for both its service and SSH
helper: Linux `~/.local/share/hermes-alans-way/browser`, macOS
`~/Library/Application Support/hermes-alans-way/browser`. A service-only
`HERMES_VPS_BROWSER_DATA` override does not reach independent SSH sessions;
remove that override before using the normal helper. The helper checkout must
be readable and executable by the broker, and unwritable by bots. Agent update
and setup commands continue to use the agent account; broker service maintenance
must be performed separately by its administrator.


An installed `vpsBrowser.sshHost` remains the labeled legacy browser transport
while `brokerSshHost` is empty. Agent configuration/environment writes continue
to use `sshHost`; selecting the broker never repoints those writes. Only after
separate accounts and broker access are provisioned, enter `brokerSshHost` and
set `HERMES_WORKSPACE_REQUIRE_BROKER_SSH=1` in the app launcher. An invalid or
unreachable selected broker fails closed, without trying the agent login.
The environment opt-in also prevents accidentally clearing the broker field
from re-enabling the legacy route. No account, ACL or existing preference is
automatically rewritten during upgrade.

Automatic agent-key authorization of the human account is disabled. Configure
broker SSH access manually, then check the saved broker path. Review and revoke
previously authorized agent/shared keys separately. The legacy combined SSH
wizard refuses to run; platform installers require an explicitly named broker administration
key. Native control of a broker/human GUI (especially Terminal) conveys that
account's authority: untrusted bots need a separately owned desktop/session.


The platform scripts' `--broker-admin-key` (`-BrokerAdminKey` on Windows)
authorizes a broad **administration shell**, never the architecture runtime
key. Do not export it to bots or use it in a runtime connector. The restricted
OpenSSH 2222 listener and forced-command runtime Mac adapter must be provisioned
separately before strict rollout. New setup stops with instructions when the
separate broker login is missing; installed legacy connectors keep running.
