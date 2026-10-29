# Contributing

Alan's Way has [four products](docs/products.md). Community and setup help: [Discord](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com). Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Choose the product and repository

| Product | Where to contribute | Label |
| --- | --- | --- |
| Alan's Workspace (Mac, iOS, VM handoff; existing Windows/Linux builds) | This repo: `desktop/`, `ios/`, supporting `mobile/` and install scripts | `product:workspace` |
| Alan's CU MCP (`workspace-mcp`, Node) | This repo: `desktop/scripts/browser-mcp.cjs`, supporting `desktop/src/` and VM hosts/tests | `product:cu-mcp` |
| Alan's Plugin for Hermes (Python) | [alans-way-agents](https://github.com/capthvnsen/alans-way-agents): `alans-way/`, `alans-way-computer/`, setup/router adapters | `product:hermes-plugin` |
| Alan's Plugin for Grok Bot (skill + settings) | [alans-way-agents](https://github.com/capthvnsen/alans-way-agents): dedicated package path **TODO** | `product:grok-plugin` |

Both plugins read one shared persona/voice/proactivity/identity config spec owned in `alans-way-agents`; its canonical path is still a [publication TODO](docs/products.md#shared-config-contract). Propose shared-spec changes there and name both plugin products. Grok Bot cannot load Hermes plugins. Keep the CU MCP server at its existing path; the product name does not require moving code or creating a new package.

For cross-product work, identify every affected product and link companion issues/PRs across repos. Workspace and CU MCP share `desktop/`, so a shared-server change can affect every agent client. Check callers, tool contracts, fixtures, install paths and docs before changing them.

## Issues, labels, and pull requests

Use the issue forms to select the product(s), including **Shared config / multiple products** when needed. Plugin implementation issues belong in the agents repo; questions about integration here are welcome with a linked upstream issue.

The label inventory is [`.github/labels.yml`](.github/labels.yml). It is documentation for maintainers and label-management tools, not an automatic workflow: maintainers create/update these names in GitHub's **Issues → Labels**, then apply all matching product labels during triage. Issue dropdowns and PR checkboxes do not apply labels automatically. Use both plugin labels for shared config changes; use Workspace and CU MCP labels for shared app/server changes. No label-sync action is installed.

Open a focused PR with the product checkboxes filled in, a behavior/doc summary, and checks actually run. List unresolved packaging, config, or license choices under **Decisions for Alex**, using a TODO in the relevant docs. Do not silently pick a license. Follow [license coverage](docs/licensing.md); contributions use the existing license of the files touched. Maintainers handle merging, releases and deployment separately.

## Development setup

```sh
git clone https://github.com/capthvnsen/alans-way && cd alans-way
```

## Workspace desktop and CU MCP (`desktop/`)

You need macOS on Apple Silicon and Node 24 (matching the Node major embedded in Electron 44).

```sh
cd desktop && npm ci
npm test          # syntax checks + unit tests; what CI runs
npm start         # launch the app from source
```

The macOS `desktop-electron` CI job runs the integration scripts listed in `.github/workflows/tests.yml` with disposable profiles and step deadlines. Additional workspace suites, their live requirements, and temporary evidence paths are documented in [desktop/README.md](desktop/README.md#build-and-test). `test:extensions` needs a display, `test:web-store` needs the network, and `test:cross-host` needs a real VPS (see `desktop/test/cross-host-electron.cjs`); report which you ran.

CU MCP shares this dependency tree and test suite. For server changes, check generic MCP clients as well as Hermes/Grok integrations; use [integration](desktop/docs/integration.md) and [remote-agent setup](desktop/docs/remote-agents.md) for protocol and approval boundaries. The server's source entry point remains `desktop/scripts/browser-mcp.cjs`.

### Releasing the desktop app

`desktop/package.json` `version` is the only place the app version lives; the label in the app, `/v1/status` and source builds all read it. The project is pre-1.0: bump the patch (0.3.0 to 0.3.1) for fixes and the minor (0.3.1 to 0.4.0) for features.

1. In `desktop/`, run `npm version <x.y.z> --no-git-tag-version`, then commit `package.json` and `package-lock.json`.
2. Merge to `main`, then tag that commit `v<x.y.z>` and push the tag. The release workflow fails if the tag differs from `package.json`.
3. For a trial build, tag `v<x.y.z>-rc.<n>` instead. It uses the same base version, stays a draft, and is never offered to users.

### macOS signing

Tag builds are Developer ID signed, notarized and stapled when the signing secrets are set on the repo; without them the workflow still builds the same ad-hoc dmg, so forks and pull requests work unchanged. The maintainer sets this up once on a Mac that has the "Developer ID Application" certificate in the login keychain and `gh` logged in:

```sh
desktop/scripts/setup-signing-secrets.sh
```

The script exports the identity, reads the Team ID from the certificate, asks for the Apple ID and an app-specific password, and stores the five secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) on capthvnsen/alans-way. It prints only the secret names. Signed installs update through electron-updater; unsigned ones keep the in-app dmg swap, so both paths must keep working.

## Workspace iOS and mobile voice support

Follow [ios/README.md](ios/README.md) for Xcode/XcodeGen setup, simulator/device builds, and tests. The native app lives in `ios/AlanWorkspace/`, with unit/UI tests in `ios/AlanWorkspaceTests/` and `ios/AlanWorkspaceUITests/`. Keep local Telegram application credentials and signing configuration in the ignored files described there.

The [mobile voice bridge](mobile/README.md) supports Workspace iOS from `mobile/miniapp/` and `mobile/voice/`. It is not the main Hermes plugin product. Run the checks documented there for mobile changes; name any device, gateway, microphone, or network checks you could not run.

## Optional Python companion CLI

Use Python 3.11+ and a fresh virtual environment. Install `-e '.[mcp]'`, run `python -m unittest discover -s tests -v`, and build the distribution with `python -m build`.

For every PR, stage the intended files and run `python3 scripts/check_publication.py` before committing. For docs-only changes, also run `git diff --check` and verify changed relative links and YAML templates; app/runtime tests are unnecessary unless behavior changed. Report skipped checks in the PR.

Plugin tests and installation belong to [alans-way-agents](https://github.com/capthvnsen/alans-way-agents), following that repo's CONTRIBUTING.md. Installing a plugin or running its setup against a real gateway is not required for a docs-only PR here.

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
