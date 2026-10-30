# One-time historical log cleanup and credential rotation

First apply log redaction (#246) and identity-bound credentials (#268), and
establish separate broker/bot OS users. Do not run this against an old shared
bot account. Stop the broker/desktop app before apply; dry-run does not contact
the broker or alter files:

```sh
# Set BROKER_HOME to the isolated broker account’s home directory.
sudo node /opt/alans-way/desktop/scripts/cleanup-workspace-logs.cjs \
  --root "$BROKER_HOME/.local/share/hermes-alans-way/browser" --log-dir /var/lib/alan-broker/logs
```

Review the path/action-only plan, then add `--apply`. The utility rotates every
registered bot credential into its existing identity-owned export, removes
`main.log`, `main.log.old`, `stderr.log` and `stderr.log.old` in the explicit log
directory, and removes broker/human connection files so startup mints new
credentials. It never reads raw log contents or prints tokens. Unknown files,
symlinks, changed files and uncertain service state refuse the operation.
Configuration/credential files must be private and broker-owned.

Rotation also invalidates credential-bound desktop Allow, including Always allow;
review and approve each principal again on its next desktop input.
Start the broker manually afterwards. If the loopback port changed, re-run the
credential provisioner to update exported URLs. If a run fails after some bot
rotations, already rotated credentials remain valid and the old logs remain
until deletion succeeds; the operation can be rerun. Restore service only after
reviewing the successful completion receipt.

This does not inspect or rotate Apple, Telegram, signing, Stripe, model-provider,
SSH or unrelated credentials. Credentials of those types require a separately
authorized provider-specific response if there is evidence they appeared in old
logs. Copies in support exports, backups or an external stderr collector are
outside the known local log filenames; identify those locations separately.
No 30-day retention policy or automatic maintenance job is installed.
