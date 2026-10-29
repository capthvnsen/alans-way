# MIT licensing across the four products

Alex's decision: all four Alan's Way products use the **[MIT License](../LICENSE)**, **Copyright (c) 2026 Alex Hansen**. This includes the shared persona/voice/proactivity/identity config spec and supporting code. There is no pending product-license choice.

| Product / source | License | Notice location |
| --- | --- | --- |
| Alan's Workspace desktop, `desktop/` | MIT | [LICENSE](../desktop/LICENSE), [dependency notices](../desktop/NOTICE.md); `desktop/package.json` and the root lockfile entry declare MIT |
| Alan's Workspace iOS, `ios/` | MIT | [LICENSE](../ios/LICENSE), [notice](../ios/NOTICE.md), and the bundled `ThirdPartyNotices.txt` |
| Workspace mobile voice support, `mobile/` | MIT | [LICENSE](../mobile/LICENSE), [notice](../mobile/NOTICE.md), and Mini App package metadata |
| Alan's CU MCP, `desktop/scripts/browser-mcp.cjs` and supporting `desktop/` code | MIT | [Desktop LICENSE](../desktop/LICENSE); server location and runtime behavior are unchanged |
| Alan's Plugin for Hermes, `capthvnsen/alans-way-agents` | MIT | The agents repository maintains the plugin license files and notices |
| Alan's Plugin for Grok Bot, `capthvnsen/alans-way-agents` | MIT | Include the same standard MIT text and Alex Hansen copyright in the skill/settings package |
| Shared config spec, `capthvnsen/alans-way-agents` | MIT | Use the same license for the spec and both plugin readers; package/spec paths are tracked separately in [products](products.md#shared-config-contract) |
| Optional Python companion CLI, root docs and support scripts | MIT | [Root LICENSE](../LICENSE); `pyproject.toml` declares MIT |

The plugin and website source trees are maintained in their own repositories; this repo's license files do not modify those repositories. The missing Grok package/shared spec publication paths are packaging work, not undecided licensing.

## Third-party licenses and desktop distribution

MIT applies to Alan's Way's own source. Third-party dependencies retain their copyrights, licenses, and distribution requirements. Preserve their notices rather than replacing them with Alex's copyright.

The pinned [`electron-chrome-extensions` 4.9.0 package](https://registry.npmjs.org/electron-chrome-extensions/4.9.0) offers GPL and Patron license options; its tarball contains `LICENSE-GPL` and `LICENSE-PATRON.md`. The current app explicitly selects `GPL-3.0` for that dependency. Its notices and applicable GPL source/distribution obligations remain in effect for a desktop bundle containing it. The MIT product-source decision does not grant a Patron license or make that combined bundle MIT-only. Dependency selection/runtime changes are outside this licensing update.

The desktop also includes Electron/Chromium notices, noVNC (MPL-2.0), the MCP SDK (MIT), and other dependencies. iOS retains TDLibKit/TDLibFramework MIT notices and TDLib's Boost Software License 1.0 text. The mobile broker retains aiohttp's Apache-2.0 and dependency notices. See the component NOTICE files above; this is not a full transitive-dependency audit.

Contributions to Alan's Way source use MIT. Community: [Discord](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com). Report vulnerabilities using [SECURITY.md](../SECURITY.md).
