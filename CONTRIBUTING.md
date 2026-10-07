# Contributing

```sh
git clone https://github.com/capthvnsen/alans-way && cd alans-way
```

## Desktop app (`desktop/`)

You need macOS on Apple Silicon and Node 20+ (CI uses 22).

```sh
cd desktop && npm ci
npm test          # syntax checks + unit tests; what CI runs
npm start         # launch the app from source
```

The Electron integration tests (`npm run test:desktop`, `test:agent-input`, `test:permissions`, `test:extensions`, `test:newtab`) need a Mac with a display and use a temporary profile; run the ones that cover your change. `test:web-store` needs the network, and `test:cross-host` needs a real VPS (see `desktop/test/cross-host-electron.cjs`). CI does not run these, so say in your pull request which ones you ran.

### Releasing the desktop app

`desktop/package.json` `version` is the only place the app version lives; the label in the app, `/v1/status` and source builds all read it. The project is pre-1.0: bump the patch (0.3.0 to 0.3.1) for fixes and the minor (0.3.1 to 0.4.0) for features.

1. In `desktop/`, run `npm version <x.y.z> --no-git-tag-version`, then commit `package.json` and `package-lock.json`.
2. Merge to `main`, then tag that commit `v<x.y.z>` and push the tag. The release workflow fails if the tag differs from `package.json`.
3. For a trial build, tag `v<x.y.z>-rc.<n>` instead. It uses the same base version, stays a draft, and is never offered to users.

## Companion CLI (`src/hermes_companion/`)

Use Python 3.11+ and a fresh virtual environment. Install `-e '.[mcp]'`, run `python -m unittest discover -s tests -v`, and build the distribution with `python -m build`.

Before any pull request, run `python3 scripts/check_publication.py`.

The VPS-side plugin and `setup.sh` live in [alans-way-agents](https://github.com/capthvnsen/alans-way-agents).

The desktop app is GPL-3.0-or-later and the Companion CLI is MIT; see `desktop/NOTICE.md`. Contributions are accepted under the license of the directory they touch.

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
