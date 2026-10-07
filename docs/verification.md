# Pre-release verification

These are actual execution results. Browser execution migration and independent
native Desktop/Telegram conversation merging remain outside this release.

## Companion 0.1.0a2 and shared desktop repository

| Check | Observed result |
|---|---|
| Final installed-wheel regression on macOS | 160 tests; OK, 2 expected platform/opt-in skips |
| Final source regression on Linux VPS | 160 tests; OK, 8 expected Darwin/opt-in skips |
| Fresh installed-wheel Mac smoke | CLI/config/diagnostics and actual MCP initialize/list/status/read/denials passed |
| Stock Hermes Plugin Doctor and admission validation | Real discovery, import, registration and manifest checks passed; no core override |
| Primary-profile deployment | Existing Telegram route bound; unrelated configuration and enabled plugin entries preserved |
| Real native-model appraisal | One structured completion returned valid silent appraisal; no event injection |
| Existing gateway restart | Same default profile restarted while idle; Telegram connected; check-in schedule resumed with no startup hook |
| Durable pause | Paused state and bound route survived a subsequent gateway restart |
| Actual Telegram command | `/proactivity` in the bound chat replied with the check-in wait and level, active hours and timezone, and the next check-in time |
| Automatic pilot | One admitted test event was claimed and ended silently; no draft or completion was claimed. Test watch cancelled; no pending/uncertain events remained |
| Desktop source check | Six core checks and all JavaScript syntax checks passed |
| Live background-browser MCP | Replacement typing, click, screenshot and Enter passed against a local fixture |
| Mac packaging | Apple Silicon app built from the unified `desktop/` source |
| Publication checks | Repository policy, staged whitespace and Gitleaks scan passed |

The deployment used existing authorized private SSH access and the existing
default Telegram primary. Specialist profiles and stock Hermes source were not
modified. Automatic check-ins stay within 08:00–22:00 in the user's timezone
and never fire mid-task. The first follows two quiet hours; each unanswered
check-in doubles the wait toward roughly weekly, and any reply resets it.
Proactivity preferences and pause persist in Companion's
own state; native Hermes owns execution and approvals.

## Companion 0.1.0a1 baseline

| Check | Observed result |
|---|---|
| Fresh public SDK install | `mcp==2.0.0` installed from the public Python package index in a separate virtual environment |
| Package build | Wheel and source distribution built successfully; no Hermes dependencies replaced |
| Fresh installed-wheel smoke on macOS | CLI, JSON config, diagnostic exit behavior, actual stdio initialize/list/status/read and denials passed |
| Installed-wheel regression on macOS | 85 tests; OK, 2 deliberate platform/opt-in skips |
| Installed-wheel regression on Linux VPS | 85 tests; OK, 8 deliberate Darwin/opt-in skips |
| Installed-wheel smoke on Linux VPS | CLI/config/diagnostics and real non-Darwin server refusal passed |
| Actual Linux VPS → Mac SSH/MCP route | Initialize, exact three-tool set, read-only metadata, Darwin status and explicit synthetic fixture read passed |
| Fixture disclosure behavior | Verification reported 40 bytes of UTF-8, without printing content, file path or private destination |
| Non-Darwin execution guard | Linux serving refused with exit 2; no cloud execution substituted for the Mac |
| Experimental native keeper | Separately opted-in, sandbox-network-denied stock stdio fixture: 20 tests, OK; zero provider turns |
| Stock source preservation | Both inspected Hermes source trees had no tracked or staged changes after the checks |
| Secret scan | Gitleaks 8.30.1 reported no leaks; repository policy scan and staged whitespace check passed |

### Baseline qualifications

- SSH tests used an already authorized private route and verified host keys. They did not provision keys, start a daemon, change live Hermes config, migrate a gateway or attach a live session.
- A raw MCP success does not certify native Hermes' approval/trust classification. The SDK annotation caveat remains in [compatibility](compatibility.md).
- The Linux test command used an explicit absolute interpreter path. A first invocation through a `../venv/bin/python` spelling was correctly rejected by the no-traversal configuration validator; rerunning with the declared absolute interpreter passed without changing the policy.
- The independent native keeper run observed the server still alive two seconds after EOF; bounded SIGTERM cleanup returned `-15`. An earlier focused run observed natural exit `0`. A green harness is not proof of universally clean EOF shutdown.
- GitHub CI is configured separately. Its current result must be read from the actual workflow run, not inferred from the local or VPS results.
- No authenticated existing-owner multi-client session, actual mobile reply/approval return lane, physical Mac-off/Desktop-return lifecycle, consequential write tool or restart-durable admission was demonstrated.

No private addresses, SSH aliases, usernames, home paths, runtime identifiers, source patches, raw user logs or transcripts are included here.
