# Identity-bound bot connections

Run the desktop app / VPS broker and its SSH request helper as the human or
broker OS user. Run each mutually untrusted bot as a different OS user, without
sudo, broker groups, shared writable code or access to the broker's home.
Both `connection.json` and `app-token.json` are broker credentials. Never copy
either file to a bot. The VPS settings must use the broker's SSH login with
`sudo: false`; generic sudo request helpers are refused.

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
sudo install -d -m 0711 -o alan-broker /var/lib/alan-connections
sudo node /opt/alans-way/desktop/scripts/bot-credential.cjs \
  --root /var/lib/alan-broker/browser --broker-uid "$(id -u alan-broker)" \
  --bot-id bot-a --uid "$(id -u alan-bot-a)" \
  --output /var/lib/alan-connections/bot-a.json
```

This prints a plan without credentials. Add `--apply` to provision or rotate.
Apply requires root to assign file ownership. Exports are 0600 and owned by the
specific bot user. Existing exports must already belong to that identity.
Run the connector as that bot user with `--bot-id bot-a --connection
/var/lib/alan-connections/bot-a.json`, or set `HERMES_WORKSPACE_CONNECTION` to
that path. A connector refuses a broker file or a different bot's file.

Use the same process for the desktop app's data directory under its human OS
user. Do not run an untrusted shell as that user. A token boundary cannot protect
files from another process with the same OS identity.

Protect Chromium's unauthenticated CDP port from all users except the broker,
and use a separate browser OS user with no credentials. Keep its Xauthority,
session bus and desktop sockets inaccessible to bots; never use `xhost +`.
The browser egress installer supplies the network rules for a Linux browser
user. This provisioning utility does not configure Windows account ACLs.

No service is restarted, user created, firewall installed, or credential
changed by a dry run. Services and OS separation must be configured before
exporting credentials to bots.
