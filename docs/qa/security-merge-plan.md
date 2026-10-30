# Security draft merge plan

Reviewed 2026-10-30 against main `851f46377ac1f3d76ccb4784ae3f3f1e66bf46e1`.
No PR was merged and no installed app, live account, SSH server, firewall or
Tailscale ACL was changed. Source in alans-way-agents was read with `git show`
at `296f6f099448f39d12b4a46425fca06bbd67e66c`; that repository was not edited.

**Merge is gated on current-head CI.** These changes stage migration steps 1
and 2; they do not establish that an installation has completed either step's
architecture exit gates. In particular, a passing unit suite is not evidence
of live OS isolation, a provisioned forced-command listener, signed host grants
or a canonical profile service. Existing installs retain an explicitly labeled
legacy route until the operator selects the provisioned replacement.

## Architecture reconciliation

Authority is defined by [architecture PR #241](https://github.com/capthvnsen/alans-way/pull/241),
sections 3, 6 and 9, including launch decision 5. No ADR change was needed.
The QA input was [security report #250](https://github.com/capthvnsen/alans-way/pull/250).
The compatibility descriptions below supersede its pre-reconciliation claims
that every old connection file or SSH alias is immediately refused.

| Value or component | Reconciled meaning |
| --- | --- |
| Operator-assigned registry `botId` | The immutable architecture principal, preserved across credential rotation; never a display name or client-selected authority. |
| Per-bot bearer token | The principal's transitional local credential. Registry authentication binds it to exactly one principal and isolated OS UID before ownership/overseer checks. Invalid, ambiguous, revoked or unsafe registry records deny access. |
| Future OpenSSH key fingerprint | Maps to that same principal; it must not create another identity namespace. The per-bot ingress must ignore client commands and environment overrides. |
| Tailscale identity | Device reachability only. It cannot distinguish Hermes and Grok sharing a computer and does not confer app authority. |
| Hermes versus Grok | Separate principal and credential. Grok Bots share their account principal until live testing establishes distinct credential storage; no inherited Hermes grants. |
| Desktop Allow | New identity-bound calls use principal plus credential fingerprint on the current app/device. Neither temporary Allow nor Always allow carries across rotation; legacy trusted-bot lists are not imported. Revocation during a pending prompt rejects input. |
| Agent SSH login | Maintenance/configuration of Hermes and its environment, kept in `sshHost`. It is never replaced with the broker login. |
| Browser broker login | Trusted browser transport, selected separately in `brokerSshHost` after provisioning. A selected but broken broker never retries the agent login. |
| `--broker-admin-key` / `-BrokerAdminKey` | Broad administration shell credential only. It is not the restricted runtime Mac key and must never be supplied to bots or runtime connectors. |
| Optional Python Companion | Compatible read-only administration/file consumer, not a second principal registry or policy authority. Keep its key separate from runtime control. |

The full VM service/registry/ledger, canonical revisioned JSON profiles,
signed host capabilities and active-session/queued-work revocation remain code
and rollout gates. The current registry rereads credentials per request; it
does not claim to cancel every already admitted browser action or terminate
an SSH session. Desktop credential binding is preparatory local enforcement,
not proof of the complete section 6 policy gate. Do not promote existing local
preferences into an approved VM profile without owner review. Preserve tool
exclusions, desktop restrictions, transaction approvals and existing consent.

## PR verdicts and existing-install behavior

“Needs change made” means the incompatibility was fixed on that draft branch;
it is not permission to bypass its pending CI or live rollout gates.

| PR | Verdict | Existing install / rollout behavior |
| --- | --- | --- |
| [#243](https://github.com/capthvnsen/alans-way/pull/243) | Ready, unchanged | Missing/oversized identity is refused before computer approval, leases or driver access. Normal named Hermes/Grok requests remain compatible. A header under a shared credential is still legacy identity; #268 supplies authenticated principals. Branch history was not rewritten because force-push permission covers `security-*` only. |
| [#266](https://github.com/capthvnsen/alans-way/pull/266) | Blocked: macOS CI queued; source ready after rebase | Failed/unreadable/truncated env inputs no longer replace installed settings. A remote Python transaction preserves unrelated values, validates identity/content, serializes writes, and atomically replaces or exclusively creates. Missing profile directories on bare installs remain supported; inventory errors stop credential changes. No automatic state migration. |
| [#267](https://github.com/capthvnsen/alans-way/pull/267) | Needs change made | Existing SSH aliases, config-selected keys, Hermes URLs and viewers retain a logged legacy transport. `HERMES_WORKSPACE_REQUIRE_TAILNET=1` explicitly selects literal tailnet destinations and proxy/config suppression after provisioning. Strict errors never fall back. Denied viewers remain saved and visible for repair, but are not dialed. Cookie transfer retains its independent tailnet/consent restrictions. |
| [#268](https://github.com/capthvnsen/alans-way/pull/268) | Needs change made | Existing broker connection files keep working with a `Legacy broker credential` warning. Strict connectors opt in with an isolated export and `HERMES_WORKSPACE_REQUIRE_BOT_CREDENTIALS=1`. A mismatched bound identity always refuses; strict clients reject unbound files. New credential-bound desktop consent never inherits a legacy trust-list grant and requires reapproval after rotation. Existing legacy sudo transport remains until a separate broker is selected. |
| [#271](https://github.com/capthvnsen/alans-way/pull/271) | Needs change made | No launch-time cleanup, scheduler, credential rotation or deletion. Default is a plan only; apply requires root, trusted paths and a stopped broker. Rotated credentials invalidate desktop Allow, including Always allow. Apply requires #246 log redaction first and reviewed restart/re-export instructions. Backups and provider/SSH credentials are outside this tool. |
| [#272](https://github.com/capthvnsen/alans-way/pull/272) | Needs change made | Broker receives computer routes and the shared lease. Identity-bound/strict clients never invoke an in-process helper if the endpoint is missing. An older VM host remains usable only through the labeled, unbound legacy connector until its broker is upgraded. The route extraction preserves credential-generation validation and pending-prompt revocation. Update broker before strict client cutover. |
| [#273](https://github.com/capthvnsen/alans-way/pull/273) | Needs change made | An empty new broker field preserves the existing shared login, with a log/UI explanation. Agent settings and environment writes remain on the agent account. After provisioning, save the separate broker login and set `HERMES_WORKSPACE_REQUIRE_BROKER_SSH=1`; that opt-in also prevents clearing the field from restoring legacy transport. An invalid/unreachable selected broker never falls back. |
| [#275](https://github.com/capthvnsen/alans-way/pull/275) | Needs change made | Installed connections and authorized keys are not automatically removed. New setup requires an explicit separately provisioned broker account; the unsafe combined wizard refuses before network/file mutations. Platform scripts name broad maintenance keys as administration keys, not runtime credentials. Review old keys manually and provision a separate restricted runtime key. Main's current four-product README/licensing is preserved. |
| [#270](https://github.com/capthvnsen/alans-way/pull/270) | Blocked: macOS timing assertion failed; kernel CI passed | Installer is inert unless explicitly run with `--apply`. It creates no user, service or firewall during app upgrade. Requires distinct browser/broker UIDs, correct CDP ports, public DNS and browser service ordering; failed rules/service setup must prevent browser startup. Do not apply the UID rule to integrated Electron's shared browser/broker identity. |
| [#274](https://github.com/capthvnsen/alans-way/pull/274) | Needs change made | Copied MCP settings are never rewritten. Default print/verify commands preserve legacy SSH aliases/configuration and print an upgrade warning. `HERMES_WORKSPACE_REQUIRE_TAILNET=1` opts into literal tailnet destinations and SSH config/proxy suppression after key migration. A strict rejection never retries legacy. Read-only workspace scoping and conservative tool trust remain. |

## Exact target merge order

1. #243 — computer identity guard.
2. #266 — preserve environment settings.
3. #267 — staged desktop tailnet policy.
4. #268 — credentials are architecture principals.
5. #271 — inert cleanup/rotation tool, based on #268.
6. #272 — broker computer routes, based on #268.
7. #273 — distinct broker/agent SSH roles, based on #268.
8. #275 — explicit administrative trust, based on #273.
9. #270 — inert Linux browser egress provisioning.
10. #274 — staged read-only Companion transport.

The nine security branches were rebased onto the pinned main directly or via
their stated parent. After a parent merges, retarget its children to main and
retain only their scoped commits; after #273 merges, do the same for #275.
Do not squash a child's parent history into main twice. #241 can land as a
separate documentation decision before these; #246/#249 remain separate QA
fixes, not silently included in this stack. Do not claim all #250 findings are
closed without those fixes and their verification.

A local combined verification branch applies the scoped diffs in exactly that
order; it does not merge any PR. Independent drafts touch the same code, so
normal integration still requires the following reviewed resolutions:

- #267 after #266: retain the remote env transaction/JSON stdin, and add the
  tailnet destination guard and SSH options to that transaction's SSH call.
- #268 after #267: retain both imports and authenticated identity/consent checks.
- #273 after #267/#272: keep tailnet validation and saved-viewer repair, add the
  separate broker settings/context, preserve the computer route extraction and
  both deployment notes. Fixtures must use the tailnet helper and separate
  broker expectation together.
- #275 after #267: retain proxy suppression and quoted nested destinations;
  use broker readiness instead of automatic key authorization. Keep the new
  disabled-wizard tests rather than restoring its old network flow. Its VM
  fixtures must supply both broker and tailnet helpers.
- Keep both the broker-settings persistence fixture and the paused-viewer
  persistence fixture; neither replaces the other.

Re-run publication checks, full desktop/Python checks and the Electron settings
suite on the final merged tree before allowing nightly rollout. A clean PR CI
result alone does not verify these inter-PR resolutions.

## Operator provisioning and upgrade sequence

These are instructions for Alex to review and perform later, not work performed
on a live machine by this reconciliation.

1. Record installed app, plugin, launcher and agent revisions; export settings
   privately and keep previous working binaries. Run the harmless 14-tool read,
   image and input probes for both production agents on the current route.
2. Before strict cutover, finish the missing code gates: supervised VM authority,
   one canonical profile registry, fixed-principal OpenSSH 2222 ingress, a new
   restricted runtime Mac adapter, signed host grants and complete revocation.
   Their absence cannot be repaired merely by changing ACLs or enabling flags.
3. Create the isolated broker, non-root bot and browser accounts. Remove sudo,
   broker-group access and bot-writable service code; protect broker credentials,
   desktop sockets, Xauthority/session buses and unauthenticated CDP. Native GUI
   control conveys the GUI account's authority, so isolate its desktop/session.
4. Give Hermes and Grok distinct principal/key mappings; qualify Grok credential
   persistence across hibernation/recreation before claiming per-Bot isolation.
   Import existing reviewed consent/exclusions into reviewable JSON profiles;
   missing profiles deny access and Grok does not inherit Hermes grants.
5. Provision the restricted OpenSSH listener and pinned host keys over Tailscale;
   keep Tailscale SSH administration on port 22 separate. Install a separate
   runtime Mac key and retain administration/read-only keys separately. Review
   old broad authorized keys by provenance and revoke them manually only after
   replacement clients work. Existing sessions need explicit revocation too.
6. Review and apply least-privilege Tailscale ACLs for those devices/listeners.
   Stage literal pinned tailnet addresses; migrate IdentityFile-only keys into
   explicit default identities or the SSH agent before disabling SSH config.
   Keep old settings for rollback; never select public fallback addresses.
7. On the standalone Linux browser only, review the egress dry run and service
   dependencies. Configure a credential-free browser UID, public DNS, matching
   loopback CDP ports, no new privileges and a service dependency that blocks
   startup if nftables fails. Verify kernel filtering including established
   sockets, IPv4/IPv6, DNS-resolved/private and WebSocket paths. Integrated
   Electron needs a separate process boundary first.
8. Update VM/broker first, verify computer capabilities, then update the Mac and
   clients/plugins. Provision isolated credential exports on the broker's actual
   loopback port, select each connection file, save the broker SSH login and
   enable the three enforcement flags only after those routes pass. Enabling
   strict mode never mints accounts/ACLs and never repairs a failed route.
9. Exercise wrong principal/key, revoked key during Allow, rotation/reapproval,
   broker outage, blocked viewer, missing profile and computer helper denial.
   Also qualify the restricted SSH command/forwarding/environment behavior.
   Preserve reviewed existing cookie/draft consent; do not grant new consent.
10. Only after #246 redaction and isolated-account qualification, stop the broker,
    review #271's dry run, apply the approved cleanup, restart, repair changed
    exported ports and reapprove desktop access. Inventory exported diagnostics,
    backups and any provider credentials separately; the tool handles only its
    known local files. Never run it against an old shared bot account.

A strict route failure pauses that route. Roll back deliberately to the pinned,
labeled legacy launcher only before assigning new fenced tasks; do not replay
unknown actions or silently weaken enforcement. No signed/fenced-task safety
claim is made for the legacy path.

## Validation evidence

Local command results and current-head CI are recorded below. Counts overlap;
they are not a unique-test total. Root/cross-UID and nftables namespace tests
require Linux CI; local skips are not evidence those boundaries passed here.

| Tree / scope | Exact command | Result |
| --- | --- | --- |
| #266 | `node --test desktop/test/env-write.test.cjs desktop/test/cloud-migration-flow.test.cjs desktop/test/speed-replies.test.cjs desktop/test/commit-patterns.test.cjs` | 78 pass, 0 fail, 2 skip. |
| #266 Python | `PYTHONPATH=src python3 -m unittest tests.test_connect_scripts tests.test_config tests.test_verify -q` | 44 pass, 0 fail, 5 skip. |
| #267 | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 node --test desktop/test/tailnet.test.cjs desktop/test/core.test.cjs desktop/test/hermes-remote.test.cjs desktop/test/vps-browser.test.cjs desktop/test/server-setup.test.cjs desktop/test/ssh-user-tools.test.cjs` | 140 pass, 0 fail. Final probe-only rerun: 49 pass; final tailnet/reconnect rerun: 26 pass. |
| #268 focused | `node --test desktop/test/bot-auth.test.cjs desktop/test/browser-mcp.test.cjs desktop/test/desktop-approval.test.cjs desktop/test/desktop-lease.test.cjs desktop/test/vps-browser.test.cjs` | 210 pass, 0 fail, 1 skip. Final auth-only rerun: 4 pass, 1 skip. |
| #268 full | `cd desktop && npm run check` | 1,660 pass, 0 fail, 38 skip. |
| #268 Python | `PYTHONPATH=src python3 -m unittest discover -s tests -q` | 154 pass, 0 fail, 23 skip. |
| #271 | `node --test desktop/test/cleanup-workspace-logs.test.cjs desktop/test/bot-auth.test.cjs` | 6 pass, 0 fail, 2 skip. |
| #272 | `node --test desktop/test/browser-mcp.test.cjs desktop/test/desktop-approval.test.cjs desktop/test/desktop-lease.test.cjs desktop/test/vps-host.test.cjs` | 232 pass, 0 fail. |
| #273 | `node --test desktop/test/vps-browser.test.cjs desktop/test/cloud-connect-flow.test.cjs desktop/test/vm-update.test.cjs desktop/test/ssh-user-tools.test.cjs` | 139 pass, 0 fail; final browser-only rerun: 20 pass. |
| #275 | `node --test desktop/test/ssh-trust.test.cjs desktop/test/cloud-connect-flow.test.cjs desktop/test/vps-browser.test.cjs` and `PYTHONPATH=src python3 -m unittest tests.test_connect_scripts -q` | 46 JS and 25 Python pass, 0 fail. Final setup/trust rerun after fixture integration fixes: 26 pass. |
| #270 | `PYTHONPATH=src python3 -m unittest tests.test_browser_egress -q` | 2 pass, 0 fail. The real Linux `kernel-filter` CI job passed on `f70f382`. |
| #274 | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 PYTHONPATH=src python3 -m unittest discover -s tests -q` | 156 pass, 0 fail, 23 skip. |
| Combined Python | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 PYTHONPATH=src python3 -m unittest discover -s tests -q` | 155 pass, 0 fail, 23 skip. |
| Combined focused JS | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 node --test desktop/test/{tailnet,env-write,bot-auth,cleanup-workspace-logs,browser-mcp,desktop-approval,desktop-lease,vps-browser,vps-host,cloud-connect-flow,ssh-trust,ssh-user-tools,vm-update}.test.cjs` | 386 pass, 0 fail, 2 skip. An earlier combined run found 3 fixture integration failures; those were fixed on #267/#275 and rerun. |
| Combined full | `cd desktop && HERMES_WORKSPACE_REQUIRE_TAILNET=1 npm run check` | 1,675 pass, 0 fail, 39 skip. Syntax preflight initially caught unresolved markers in the local verification branch; they were resolved before this final run. |
| Every pushed branch and combined tree | `python3 scripts/check_publication.py` | Passed before each push; combined publication passed for 531 tracked files. The checker explicitly is not a complete secret audit. |

Combined verification commit: `5f6062de985e9ed8b27786c4e5ce12e78714654d`
on the retained local `reconcile-combined` branch, based on the pinned main.
It is a scoped-diff simulation, not a published merge or a claim that GitHub
will resolve the independent drafts automatically. Local Node was 26.7.0;
GitHub's matrix uses Node 24. `npm ci` installed the pinned existing dependency
set; no dependency version was changed. Local GUI fixtures were not launched
against installed app state; the new paused-viewer Electron assertion awaits CI.


CI snapshot: **2026-10-30 17:24 UTC; not all green**. Actual current-head checks were inspected
with `gh pr view <n> --json headRefOid,statusCheckRollup` and watched with
`gh pr checks <n> --watch --interval 30` for every target. No pending job is
counted as passed.

| PR | Current head | Checks at snapshot |
| --- | --- | --- |
| [#243 checks](https://github.com/capthvnsen/alans-way/pull/243/checks) | `470be5d` | 8 pass |
| [#266 checks](https://github.com/capthvnsen/alans-way/pull/266/checks) | `2a3d0c7` | 5 pass, 4 pending |
| [#267 checks](https://github.com/capthvnsen/alans-way/pull/267/checks) | `a4f1074` | 3 pass, 5 pending |
| [#268 checks](https://github.com/capthvnsen/alans-way/pull/268/checks) | `a4dee2a` | 4 pass, 5 pending |
| [#270 checks](https://github.com/capthvnsen/alans-way/pull/270/checks) | `f70f382` | 4 pass, 1 fail, 5 pending |
| [#271 checks](https://github.com/capthvnsen/alans-way/pull/271/checks) | `612ec2a` | 3 pass, 6 pending |
| [#272 checks](https://github.com/capthvnsen/alans-way/pull/272/checks) | `0d75a94` | 3 pass, 6 pending |
| [#273 checks](https://github.com/capthvnsen/alans-way/pull/273/checks) | `a9c311b` | 3 pass, 6 pending |
| [#274 checks](https://github.com/capthvnsen/alans-way/pull/274/checks) | `991742f` | 4 pass, 5 pending |
| [#275 checks](https://github.com/capthvnsen/alans-way/pull/275/checks) | `45d6352` | 3 pass, 5 pending |

#270 macOS desktop failed its unchanged parallel-restore wall-clock assertion:
[failed job](https://github.com/capthvnsen/alans-way/actions/runs/41097213978/job/124205893772).
Four nominal five-second waits took 19.365 seconds under CI load; its Linux
kernel-filter job and the same local focused/combined tests passed. A targeted
`gh run rerun 41097213978 --job 124205893772` was refused while the workflow
still had queued jobs (`job ... cannot be rerun`); rerun that failed job after
the workflow settles, and investigate if it repeats. Do not weaken its timing
assertion merely to turn the PR green.

Four queued workflows for superseded #267/#275 heads were canceled to reduce
backlog; current-head checks were retained. **Merge remains blocked until all
current-head jobs pass, the new Electron assertion passes, and the final
integration resolutions are verified.**

The verification boundary excludes live provisioning, installed Hermes/Grok
smoke tests, SSH forced-command qualification, Tailscale ACL verification,
physical sleep/wake, network namespace execution on this macOS host and a
production latency/availability measurement. No private app state or credentials
were inspected. Existing dependency-audit findings were not changed as part of
this scoped stack reconciliation.
