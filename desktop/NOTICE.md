# Desktop source and dependency licensing

Copyright (c) 2026 Alex Hansen.

Alan's Workspace and Alan's CU MCP source in this directory are licensed under the **MIT License**; see [LICENSE](LICENSE). All four Alan's Way products use MIT, including the two agent plugin products in `alans-way-agents`. The optional Python companion CLI and the shared config spec use MIT too.

Third-party software retains its own copyrights and licenses. The MIT license for Alan's Way does not relicense these dependencies:

- `electron-chrome-extensions` 4.9.0, copyright Samuel Maddock, offers GPL and Patron license options. The current app selects **GPL-3.0**. Its GPL text and copyright/license declarations are included in `node_modules/electron-chrome-extensions/` in packaged builds. Distribution with this dependency must continue to satisfy the selected GPL terms, including matching source and notices; declaring Alan's Way source MIT does not make the combined desktop bundle MIT-only. No Patron license entitlement or dependency replacement is introduced by this change.
- `electron-chrome-web-store` 0.13.0, copyright Samuel Maddock, MIT.
- Electron, MIT, with Chromium and other third-party notices in the application bundle; noVNC, MPL-2.0; the MCP TypeScript SDK, MIT; and other dependencies with their notices retained alongside their code.

Build from this directory with `npm ci`, `npm run build:preload`, and `npm run package:mac`. Source, build scripts, tests, and the dependency lockfile are part of this repository. Preserve applicable third-party notices and source obligations in any distributed binary. Installed Web Store extensions are downloaded separately to private app data; their code is not part of this repository or bundled release and retains its authors' terms.
