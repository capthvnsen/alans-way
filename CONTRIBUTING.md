# Contributing

Use Python 3.11+ and a fresh virtual environment. Install `-e '.[mcp]'`, run `python -m unittest discover -s tests -v`, and build the distribution with `python -m build`.

## Rules

- Keep Hermes authoritative. Use documented public interfaces and MCP; no forks, runtime monkey-patches, direct session/database writes or private Hermes imports.
- Preserve one conversation owner. A second independent local process is not a failover for a shared cloud conversation.
- Write a failing regression test before new behavior, then implement the smallest fix.
- Test real protocol exchanges as well as mocked unit behavior. Do not label mock/synthetic responses as authenticated cloud execution.
- Linux failures must not fall back to Mac behavior or vice versa.
- Keep host keys checked, timeouts bounded, unsupported operations absent, and privacy boundaries explicit.
- Never commit personal paths, machine IPs, credentials, histories, research evidence or unredacted logs. Examples use generic placeholders.
- Do not advertise full continuity, durable delivery or approval routing until the corresponding acceptance gates pass.
- No automatic production deployment, SSH key provisioning, gateway changes or background service installation.

Changes to experimental keeper behavior need an explicit approval/clarification withdrawal review. Changes to public contracts need compatibility and upgrade tests. Report limitations plainly.
