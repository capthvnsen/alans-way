# Security merge plan and execution receipt

## Execution receipt — 2026-10-31

The ten security PRs below were rebased onto current main and squash-merged
in the planned order after every current-head check passed. This receipt
supersedes the historical canceled-CI handoff below; that snapshot is retained
for provenance. The plan PR #277 is merged last after its own fresh CI passes.

| PR | Squash merge | Validated head | Passing CI |
| --- | --- | --- | --- |
| #243 | [`f0daa21`](https://github.com/capthvnsen/alans-way/commit/f0daa21732c5e84771c802dbfa2a5d69a3acfdba) | `727ee1e` | [tests 41117326067](https://github.com/capthvnsen/alans-way/actions/runs/41117326067) |
| #266 | [`ec6e555`](https://github.com/capthvnsen/alans-way/commit/ec6e555b98263934a0fd8046462219129d72017c) | `1368455` | [tests 41122864222](https://github.com/capthvnsen/alans-way/actions/runs/41122864222) |
| #267 | [`55f4026`](https://github.com/capthvnsen/alans-way/commit/55f40260dccdd1b8d5c11373d84d3e4359e21af7) | `6365f1c` | [tests 41129083648](https://github.com/capthvnsen/alans-way/actions/runs/41129083648) |
| #268 | [`b878fcc`](https://github.com/capthvnsen/alans-way/commit/b878fccd82ac498f562232765eed7226fac21e6d) | `57b3347` | [tests 41132808886](https://github.com/capthvnsen/alans-way/actions/runs/41132808886) |
| #271 | [`10be549`](https://github.com/capthvnsen/alans-way/commit/10be5493a0482bd4a1e3e5f3de3a59ebf3fcbe9b) | `6dd1ce2` | [tests 41135626598](https://github.com/capthvnsen/alans-way/actions/runs/41135626598) |
| #272 | [`acf1b79`](https://github.com/capthvnsen/alans-way/commit/acf1b796fb3a644bda1f8a08c034584b8a7560ce) | `4932b35` | [tests 41138670037](https://github.com/capthvnsen/alans-way/actions/runs/41138670037) |
| #273 | [`f588ced`](https://github.com/capthvnsen/alans-way/commit/f588cedc7d99c085bff8a2c9566777a6bceecd07) | `f875697` | [tests 41154440442](https://github.com/capthvnsen/alans-way/actions/runs/41154440442) |
| #275 | [`f3ecbf8`](https://github.com/capthvnsen/alans-way/commit/f3ecbf8d67c6f1af02de2828d4e10c2ec5fc4049) | `fcd4564` | [tests 41155977514](https://github.com/capthvnsen/alans-way/actions/runs/41155977514) |
| #270 | [`04b13c6`](https://github.com/capthvnsen/alans-way/commit/04b13c613e47c09c62c07b9d2ac6fc2086a998bf) | `5f324ff` | [tests 41157493400](https://github.com/capthvnsen/alans-way/actions/runs/41157493400) |
| #274 | [`b0049a7`](https://github.com/capthvnsen/alans-way/commit/b0049a72bf80451c7dba784d7758b0b64045c608) | `7e7c258` | [tests 41158728678](https://github.com/capthvnsen/alans-way/actions/runs/41158728678) |

Every listed test workflow passed all eight checks. #270 also passed the
[ninth kernel-filter check](https://github.com/capthvnsen/alans-way/actions/runs/41157493290)
in a disposable Linux network namespace. Main push workflows were confirmed
to start after each merge. The paused-viewer and broker persistence Electron
scenarios, Linux cross-UID credential checks and cleanup fixture checks passed.

Integration preserved atomic environment writes, tailnet transport options,
legacy desktop leases, credential-generation consent and VPS list redaction.
Small fixture fixes covered Telegram atomic writes, bot connection isolation,
cleanup module dependencies and both Python legacy/strict expectations.
Unrelated timing failures received one targeted failed-job retry each; no
security assertion or runtime policy was weakened. Windows
`hermes-update-ps1.test.cjs` synthetic update-budget timing remains an observed
flake: main run 41138320078 passed its single retry without a code change.

No strict flag was enabled on an installation, provisioning was not run, and
no live machine, SSH key, firewall or Tailscale ACL was changed. Legacy remains
the default. Live architecture qualification and rollout gates below remain.

## Pre-merge review — 2026-10-30

Reviewed 2026-10-30 against main `7cb8a4d4e3bbb5f7d399154c06c01d2b0c541425`.
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
| [#266](https://github.com/capthvnsen/alans-way/pull/266) | Blocked: coordinator canceled CI; source ready after rebase | Failed/unreadable/truncated env inputs no longer replace installed settings. A remote Python transaction preserves unrelated values, validates identity/content, serializes writes, and atomically replaces or exclusively creates. Missing profile directories on bare installs remain supported; inventory errors stop credential changes. No automatic state migration. |
| [#267](https://github.com/capthvnsen/alans-way/pull/267) | Needs change made | Existing SSH aliases, config-selected keys, Hermes URLs and viewers retain a logged legacy transport. `HERMES_WORKSPACE_REQUIRE_TAILNET=1` explicitly selects literal tailnet destinations and proxy/config suppression after provisioning. Strict errors never fall back. Denied viewers remain saved and visible for repair, but are not dialed. Cookie transfer retains its independent tailnet/consent restrictions. |
| [#268](https://github.com/capthvnsen/alans-way/pull/268) | Needs change made | Existing broker connection files keep working with a `Legacy broker credential` warning. Strict connectors opt in with an isolated export and `HERMES_WORKSPACE_REQUIRE_BOT_CREDENTIALS=1`. A mismatched bound identity always refuses; strict clients reject unbound files. New credential-bound desktop consent never inherits a legacy trust-list grant and requires reapproval after rotation. Existing legacy sudo transport remains until a separate broker is selected. |
| [#271](https://github.com/capthvnsen/alans-way/pull/271) | Needs change made | No launch-time cleanup, scheduler, credential rotation or deletion. Default is a plan only; apply requires root, trusted paths and a stopped broker. Rotated credentials invalidate desktop Allow, including Always allow. Apply requires installed log redaction (#246, now on main) first and reviewed restart/re-export instructions. Backups and provider/SSH credentials are outside this tool. |
| [#272](https://github.com/capthvnsen/alans-way/pull/272) | Needs change made | Broker receives computer routes and the shared lease. Identity-bound/strict clients never invoke an in-process helper if the endpoint is missing. An older VM host remains usable only through the labeled, unbound legacy connector until its broker is upgraded. The route extraction preserves credential-generation validation and pending-prompt revocation. Update broker before strict client cutover. |
| [#273](https://github.com/capthvnsen/alans-way/pull/273) | Needs change made | An empty new broker field preserves the existing shared login, with a log/UI explanation. Agent settings and environment writes remain on the agent account. After provisioning, save the separate broker login and set `HERMES_WORKSPACE_REQUIRE_BROKER_SSH=1`; that opt-in also prevents clearing the field from restoring legacy transport. An invalid/unreachable selected broker never falls back. |
| [#275](https://github.com/capthvnsen/alans-way/pull/275) | Needs change made | Installed connections and authorized keys are not automatically removed. New setup requires an explicit separately provisioned broker account; the unsafe combined wizard refuses before network/file mutations. Platform scripts name broad maintenance keys as administration keys, not runtime credentials. Review old keys manually and provision a separate restricted runtime key. Main's current four-product README/licensing is preserved. |
| [#270](https://github.com/capthvnsen/alans-way/pull/270) | Blocked: coordinator canceled CI; historical timing retry is unverified | Installer is inert unless explicitly run with `--apply`. It creates no user, service or firewall during app upgrade. Requires distinct browser/broker UIDs, correct CDP ports, public DNS and browser service ordering; failed rules/service setup must prevent browser startup. Do not apply the UID rule to integrated Electron's shared browser/broker identity. |
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
Do not squash a child's parent history into main twice. #241, #269, #246 and
#249 are now on the pinned main, together with #264. Their architecture, CI
deduplication, log redaction and VPS metadata redaction were preserved during
the final rebase. The installed release still needs qualification before
claiming all #250 findings are closed.

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
- Preserve main's `.map(redactTabForBot)` projection when combining broker
  refresh changes with #249; no branch may restore unredacted VPS lists.
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

| Tree / scope | Exact command | Final result on current main |
| --- | --- | --- |
| #266 | `node --test desktop/test/env-write.test.cjs desktop/test/cloud-migration-flow.test.cjs` | 31 pass, 0 fail. |
| #267 | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 node --test desktop/test/tailnet.test.cjs desktop/test/core.test.cjs desktop/test/hermes-remote.test.cjs desktop/test/vps-browser.test.cjs desktop/test/server-setup.test.cjs desktop/test/ssh-user-tools.test.cjs` | 140 pass, 0 fail. |
| #268 | `node --test desktop/test/bot-auth.test.cjs desktop/test/browser-mcp.test.cjs desktop/test/desktop-approval.test.cjs desktop/test/desktop-lease.test.cjs desktop/test/vps-browser.test.cjs desktop/test/vps-host.test.cjs desktop/test/main-log.test.cjs` | 260 pass, 0 fail, 1 skip. |
| #271 | `node --test desktop/test/cleanup-workspace-logs.test.cjs desktop/test/bot-auth.test.cjs` | 6 pass, 0 fail, 2 skip. |
| #272 | `node --test desktop/test/browser-mcp.test.cjs desktop/test/desktop-approval.test.cjs desktop/test/desktop-lease.test.cjs desktop/test/vps-host.test.cjs` | 233 pass, 0 fail. |
| #273 | `node --test desktop/test/vps-browser.test.cjs desktop/test/cloud-connect-flow.test.cjs desktop/test/vm-update.test.cjs desktop/test/ssh-user-tools.test.cjs desktop/test/vps-host.test.cjs` | 182 pass, 0 fail. |
| #275 | `node --test desktop/test/ssh-trust.test.cjs desktop/test/cloud-connect-flow.test.cjs desktop/test/vps-browser.test.cjs` and `PYTHONPATH=src python3 -m unittest tests.test_connect_scripts -q` | 46 JS and 25 Python pass, 0 fail. |
| #270 | `PYTHONPATH=src python3 -m unittest tests.test_browser_egress -q` | 2 pass, 0 fail. Historical Linux `kernel-filter` CI passed on the previous `f70f382` head; the current-head job is unverified after coordinator cancellation. |
| #274 | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 PYTHONPATH=src python3 -m unittest discover -s tests -q` | 156 pass, 0 fail, 23 skip. |
| Combined Python | `HERMES_WORKSPACE_REQUIRE_TAILNET=1 PYTHONPATH=src python3 -m unittest discover -s tests -q` | 155 pass, 0 fail, 23 skip. |
| Combined full desktop | `cd desktop && HERMES_WORKSPACE_REQUIRE_TAILNET=1 npm run check` | 1,680 pass, 0 fail, 39 skip. |
| Every pushed branch and combined tree | `python3 scripts/check_publication.py` | Passed before each push; combined publication passed for 533 tracked files. The checker explicitly is not a complete secret audit. |

The first combined run on the previous baseline found three fixture integration
failures; fixes landed in #267/#275 and the focused rerun passed 386 tests with
2 skips. A syntax preflight also caught unresolved markers in the private
verification tree; they were resolved before successful full runs. The final
full run above rechecked the combined changes plus main's newly landed fixes.

Combined verification commit: `3db6b60fcde9d5476e075e007b849a46c257af25`
on the retained local `reconcile-combined` branch, based on the pinned main.
It is a scoped-diff simulation, not a published merge or a claim that GitHub
will resolve the independent drafts automatically. Local Node was 26.7.0;
GitHub's matrix uses Node 24. `npm ci` installed the pinned existing dependency
set; no dependency version was changed. Local GUI fixtures were not launched
against installed app state; the new paused-viewer Electron assertion awaits CI.


Final CI handoff: **2026-10-30 17:44 UTC; canceled by the coordinator and unverified**.
The coordinator canceled queued security-stack and merge-plan workflows to
reserve runners for an urgent production hotfix, instructed this worker to
stop, and owns reruns. No workflow was rerun after that instruction. The
report-only final commit uses `[skip ci]` to avoid re-queuing work.

Before handoff, current-head checks were read with
`gh pr view <n> --json headRefOid,statusCheckRollup` and watched with
`gh pr checks <n> --watch --interval 30` for every target. The last API snapshot
below still showed queued/in-progress states as cancellation was propagating;
these are not passing suites.

| PR | Current head | Final disposition and last observed API state |
| --- | --- | --- |
| [#243 checks](https://github.com/capthvnsen/alans-way/pull/243/checks) | `470be5d` | Unchanged; 8 checks passed |
| [#266 checks](https://github.com/capthvnsen/alans-way/pull/266/checks) | `620fd9d` | Coordinator canceled; unverified (8 queued) |
| [#267 checks](https://github.com/capthvnsen/alans-way/pull/267/checks) | `9d8d28d` | Coordinator canceled; unverified (1 success, 7 queued) |
| [#268 checks](https://github.com/capthvnsen/alans-way/pull/268/checks) | `347e375` | Coordinator canceled; unverified (2 in_progress, 4 queued, 2 success) |
| [#270 checks](https://github.com/capthvnsen/alans-way/pull/270/checks) | `67b3717` | Coordinator canceled; unverified (9 queued) |
| [#271 checks](https://github.com/capthvnsen/alans-way/pull/271/checks) | `86cd4d6` | Coordinator canceled; unverified (8 queued) |
| [#272 checks](https://github.com/capthvnsen/alans-way/pull/272/checks) | `cd2f601` | Coordinator canceled; unverified (8 queued) |
| [#273 checks](https://github.com/capthvnsen/alans-way/pull/273/checks) | `daa9178` | Coordinator canceled; unverified (8 queued) |
| [#274 checks](https://github.com/capthvnsen/alans-way/pull/274/checks) | `1a88fc4` | Coordinator canceled; unverified (8 queued) |
| [#275 checks](https://github.com/capthvnsen/alans-way/pull/275/checks) | `7528457` | Coordinator canceled; unverified (8 queued) |
On the previous #270 head `f70f382`, macOS desktop failed an unchanged
[parallel-restore wall-clock assertion](https://github.com/capthvnsen/alans-way/actions/runs/41097213978/job/124205893772):
four nominal five-second waits took 19.365 seconds under CI load. The same
local focused/full runs passed. The initial targeted rerun was refused while
that workflow still had queued jobs. After it settled,
`gh run rerun 41097213978 --job 124205893772` succeeded in requesting attempt 2,
which was still queued at handoff and is unverified. That historical retry
is not counted as current-head CI;
rebasing #270 onto current main also triggered a fresh full workflow.

The worker first canceled only superseded-head workflows to reduce backlog.
The coordinator later canceled current-head CI for the urgent hotfix and ended
the monitoring window. Local watchers were stopped. **Merge remains blocked
until the coordinator reruns all current-head jobs successfully, the new
paused-viewer Electron assertion passes, and the integration resolutions are
verified.** Reconciliation and the report are delivered; the original all-green
CI acceptance condition is explicitly not satisfied at handoff.

The verification boundary excludes live provisioning, installed Hermes/Grok
smoke tests, SSH forced-command qualification, Tailscale ACL verification,
physical sleep/wake, network namespace execution on this macOS host and a
production latency/availability measurement. No private app state or credentials
were inspected. Existing dependency-audit findings were not changed as part of
this scoped stack reconciliation.
