# Pre-release verification

These are actual execution results against synthetic fixtures. They are not a claim that the full shared-conversation product is ready.

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

## Important qualifications

- SSH tests used an already authorized private route and verified host keys. They did not provision keys, start a daemon, change live Hermes config, migrate a gateway or attach a live session.
- A raw MCP success does not certify native Hermes' approval/trust classification. The SDK annotation caveat remains in [compatibility](compatibility.md).
- The Linux test command used an explicit absolute interpreter path. A first invocation through a `../venv/bin/python` spelling was correctly rejected by the no-traversal configuration validator; rerunning with the declared absolute interpreter passed without changing the policy.
- The independent native keeper run observed the server still alive two seconds after EOF; bounded SIGTERM cleanup returned `-15`. An earlier focused run observed natural exit `0`. A green harness is not proof of universally clean EOF shutdown.
- GitHub CI is configured separately. Its current result must be read from the actual workflow run, not inferred from the local or VPS results.
- No authenticated existing-owner multi-client session, actual mobile reply/approval return lane, physical Mac-off/Desktop-return lifecycle, consequential write tool or restart-durable admission was demonstrated.

No private addresses, SSH aliases, usernames, home paths, runtime identifiers, source patches, raw user logs or transcripts are included here.
