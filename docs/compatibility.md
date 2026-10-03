# Compatibility and upgrade policy

## Supported alpha boundary

- Python 3.11+ for configuration, diagnostics, and packaging.
- macOS for actual Mac tool execution; Linux hosts configure and verify the remote endpoint but cannot impersonate it.
- A separately installed `mcp==2.0.0` in the companion virtual environment for MCP serving and verification.
- SSH stdio transport with existing, verified host keys.
- Stock Hermes' documented `mcp_servers` configuration surface. No Hermes source or bundled dependency modifications.

The SDK pin is a reproducibility boundary for this alpha, not a promise that all later SDKs work or an indefinite pin of Hermes. Changes need protocol tests before widening it.

## Known Hermes SDK annotation caveat

During pre-release research, a stock Hermes build read camelCase `readOnlyHint` attributes while MCP SDK 2 exposes snake_case `read_only_hint` in its Python model. The canonical wire annotation may be correct while native classification is conservative or mismatched.

No workaround patch is shipped or applied here. Generated configuration remains untrusted. The raw verification command checks wire/tool behavior, **not** native Hermes enforcement. If the installed Hermes blocks a call or unexpectedly requests approval, stop and check official upstream compatibility; do not set full trust to conceal the issue. Confirm native tool filtering and approval behavior in an isolated, non-sensitive session before production use.

## After a Hermes or companion upgrade

1. Run `hermes-companion doctor` on both hosts.
2. Run `verify-mac` from the cloud host with a synthetic approved directory.
3. Verify the exact three-tool allowlist and no extra resources/prompts/sampling.
4. Exercise a permitted read and denied traversal/symlink paths through native Hermes.
5. If using experimental/public session protocols, check capability/identity epochs, event replay, open requests and reconnect behavior independently.
6. Do not retry an uncertain prompt or attach another writer to recover from an unsupported contract.

The current public docs are authoritative for upstream configuration; installed releases may differ. Future releases cannot be certified in advance.

## What test output means

- Unit tests: local policy/parser behavior and public-wire fixtures.
- Real Mac MCP tests: actual subprocess protocol exchange against synthetic local files.
- Real VPS → Mac verification: actual private transport and read-only endpoint, not a provider turn.
- Experimental keeper opt-in: a newly launched isolated stock runtime, not authenticated attachment to a live cloud/Desktop owner.
- CI: a clean checkout and package behavior on the recorded runners, not phone/Desktop integration or native Hermes upgrade certification.
