# Security QA — qa-security

Reviewed 2026-10-28 from `5d10e81`, in the dedicated `qa-security` worktree. This was a scoped source review of agent/workspace auth, bot identities, network exposure, credential/log handling and tool-to-shell boundaries, with synthetic local tests. No credentials, live accounts or deployments were inspected or changed; no public listeners were started.

## Bugs found

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| S1 | Low | An authenticated computer API request without `X-Hermes-Bot` skips the desktop approval prompt. | Fixed in draft [#243](https://github.com/capthvnsen/alans-way/pull/243), commit `faf5c2c`. |
| S2 | Low | Main-process errors and update details reach disk and stderr before credential redaction. | Fixed in draft [#246](https://github.com/capthvnsen/alans-way/pull/246), commit `5958359`. |
| S3 | Medium | VPS metadata reveals the full URL/title of a human-held tab to its bot or an overseer, also through the desktop cache. | Fixed in draft [#249](https://github.com/capthvnsen/alans-way/pull/249), commit `6a8fb28`. |
| S4 | Low | Onboarding treats a failed remote env read as an empty file and can overwrite existing credentials/configuration on a subsequent successful write. | Draft fix [#266](https://github.com/capthvnsen/alans-way/pull/266); fail-closed remote transaction. |

### S1 — absent identity bypasses desktop consent

Sources: `desktop/src/main.cjs:3076`, `desktop/src/desktop-approval.cjs:19`. The API derives the bot ID from an optional header, while the approval helper treats an empty ID as human input. The launch/action routes therefore reached the driver without prompting. This requires the workspace bearer token and local/SSH access; it is not an unauthenticated remote exploit. At the time of this review, known bot IDs were assertions under a shared credential. Alex subsequently required identity-bound credentials; see the decisions below.

Repro: use `computerRoutes` from `desktop/test/computer-routes-fixture.cjs`, supply a real `createDesktopApproval` with a recording/denying `ask`, then request `/v1/computer/7/action` or `/v1/computer/launch` with an empty bot ID. Before the fix, the fake driver runs and no prompt occurs. The PR's `desktop-approval.test.cjs` now verifies 400 responses before approval/driver access, including reads and oversized IDs.

### S2 — credentials persist in raw logs

Sources: `desktop/src/main.cjs:94`, `desktop/src/main-log.cjs:11`. `logError` prints the raw exception stack and the logger appends raw detail; only later support-report generation applied `redactReport`. A credential-bearing URL, authorization header or env diagnostic in an exception could survive in `main.log`, its rotated copy or captured stderr. This is a local/log-reader disclosure, conditional on such a diagnostic occurring.

Repro: create a temporary `createLog`, call `write('error', 'Authorization: Bearer synthetic-value')`, and read its file; before the fix the synthetic value remains. Similarly invoke the extracted real `logError` with a synthetic credential URL and a captured console. Added tests check both sinks and rotation. The fix reuses the existing redactor and creates new logs with mode 0600. Redaction recognizes known shapes, not every confidential string. One-time historical cleanup and workspace credential rotation tooling is in #271; no live logs were inspected or removed.

### S3 — human-held VPS metadata leaks

Sources: `desktop/scripts/vps-browser-host.cjs:969,1005,1105`, `desktop/src/main.cjs:3037,3138`. Page reads correctly return 409 while a human holds a tab, but broker metadata serializes its full URL/title and the desktop lists its human-facing VPS cache without projection. URLs can carry private document paths or query credentials. Bot metadata must use the same origin-only projection as local tabs.

Repro: in the stub-CDP broker fixture, open `https://privacy.example/private/document?access=synthetic`, release it to the human, then list/get as its owner or overseer. Before the fix the full URL and title remain, including in the release reply. The PR tests real broker list/get/control replies and the actual desktop list/proxy blocks, including an older broker's unredacted direct/nested tab replies. Human-facing metadata remains complete; agent-held tabs retain their full metadata.

### S4 — failed reads can clobber an env file

Sources: `desktop/src/main.cjs:1453-1462` (`cloudWriteEnv`, reached by `cloudFinishTelegram`) and `desktop/src/main.cjs:2413-2416` (API-key onboarding). Both pass `current.code === 0 ? current.out : ''` to `setEnvValue` and then rewrite the whole remote file. An SSH/read failure followed by a successful write drops unrelated existing credentials; the write also truncates in place. No attacker is required; a transient connection failure is sufficient. This is credential integrity/data-loss risk, not demonstrated credential exfiltration.

Repro without credentials or SSH: extract the real `cloudWriteEnv` into a VM with mocked `sshRun`/`sshWrite`; return a successful profile inventory, then `{code:255,out:''}` for the env read, then let writes succeed. Observe that `sshWrite` receives a file containing only the newly supplied synthetic key and the function reports success. This behavior was reproduced with fakes only.

Alex chose fail-closed reads, confirmed-missing-only creation and preserving existing content. Draft #266 performs the read/validate/update on the remote machine, avoiding partial local stdout and SSH read failures. It uses exclusive creation for a missing file and a private atomic replacement for an existing file after identity/content checks.

## Alex's decisions and draft implementation

[Decision comment on #250](https://github.com/capthvnsen/alans-way/pull/250#issuecomment-6500459912):

| Required boundary | Draft implementation | Remaining deployment or compatibility condition |
| --- | --- | --- |
| Per-bot credentials bound to identity; broker/human credentials under a separate OS user | [#268](https://github.com/capthvnsen/alans-way/pull/268) provides private per-UID exports and immediate registry revocation; [#272](https://github.com/capthvnsen/alans-way/pull/272) moves native computer tools into the authenticated broker | Separate accounts, trusted code and inaccessible desktop/session sockets must be provisioned by an administrator. Old shared broker files are refused by bot connectors. |
| Separate broker SSH helper from agent configuration | [#273](https://github.com/capthvnsen/alans-way/pull/273) adds an explicit broker login while preserving the agent login for Hermes setup and environment writes | Migrate existing settings; generic sudo is refused. [#275](https://github.com/capthvnsen/alans-way/pull/275) removes automatic agent-key trust in the human account and retires the combined setup wizard. Review existing authorized keys manually; native computer access requires an isolated desktop/session. |
| Tailnet-only SSH, noVNC and Hermes backend destinations everywhere in the app | [#267](https://github.com/capthvnsen/alans-way/pull/267) validates literals at configuration and use; SSH ignores configuration/proxy aliases | [#274](https://github.com/capthvnsen/alans-way/pull/274) enforces the same rule in Companion-generated SSH commands. Existing DNS/SSH aliases and copied MCP configs need migration. No tailnet ACL or deployment was changed. |
| OS/network egress filtering for the browser, including DNS and WebSocket paths | [#270](https://github.com/capthvnsen/alans-way/pull/270) supplies a Linux nftables installer and disposable kernel-network tests | Requires a dedicated browser UID and service ordering. Local integrated Electron still shares its browser and broker OS identity; equivalent local isolation remains open. |
| One-time old-log cleanup and credential rotation; no 30-day retention job | [#271](https://github.com/capthvnsen/alans-way/pull/271), dry-run by default, known logs only, stop broker before apply | No live cleanup/rotation is authorized by these drafts. Copies in backups/exported diagnostics need separate inventory. Provider credentials are outside this tooling. |
| Failed env loading must preserve existing files | [#266](https://github.com/capthvnsen/alans-way/pull/266) | Remote Python 3 and a trusted account/home directory are required. |

These replace the earlier cooperative-token and application-only egress assumptions. The drafts must be integrated together before treating an installation as hardened. Source checks and synthetic fixtures are not evidence that accounts, services, ACLs or firewall rules are installed on a live machine.

## Checks and scope limits

- PR #243: `node --test desktop/test/desktop-approval.test.cjs` — 8 passed, using the real computer route table with fake drivers.
- PR #246: `node --test desktop/test/main-log.test.cjs desktop/test/setup-check.test.cjs` — 39 passed; main-process syntax check passed.
- PR #249: `node --test desktop/test/vps-host.test.cjs desktop/test/vps-metadata.test.cjs desktop/test/core.test.cjs` — 94 passed, with loopback-only stub CDP.
- Existing auth/input/network checks: core, VPS browser, shell support, server setup, cloud connect and cloud model suites — 129 passed. Python connect-script, config and Mac executor suites — 29 + 5 + 20 passed. Counts overlap between commands and are not a unique-test total.
- Checked shared-token comparison, host/origin guards, token-file permissions/rotation, human-token separation, remote-shell quoting, script-path allowlists, JSON-over-stdin tool transport, page-expression quoting, read-only Companion path traversal controls and mobile call HMAC/ticket/token binding. No additional reachable shell-injection path was established. `eval`/CDP page JavaScript and driving Terminal are intentional authenticated capabilities.
- Rejected candidate: `setEnvValue` replacement strings interpret `$&` and related substitutions, but its current Telegram/API-key callers reject those characters. No reachable onboarding injection was established; no speculative patch was made.
- Offline credential-pattern screening of tracked text found synthetic fixture/documentation examples; no supported real credential exposure was established and no value was contacted or validated. This was not a complete secret scan, independent multi-agent audit, native-app run, full-repository audit or deployment/Tailscale ACL verification. The external agents/plugin repository and live Apple/Telegram/signing material were outside this worktree's review.

All fixes remain draft PRs; some are stacked on the credential boundary; none was merged, deployed, tagged or released.
