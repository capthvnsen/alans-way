# License coverage across the four products

This is an inventory of the checked-in notices, not a license change. Checked 2026-10-29. The root MIT license is not a blanket description of all Alan's Way products.

| Product / source | Existing license evidence | Coverage and gaps |
| --- | --- | --- |
| Alan's Workspace desktop, `desktop/` | [GPL text](../desktop/LICENSE), [distribution notice](../desktop/NOTICE.md), `desktop/package.json`: `GPL-3.0-or-later` | Desktop code/bundle uses GPL-3.0-or-later. [LICENSE-MIT](../desktop/LICENSE-MIT) retains the earlier original-code notice; it does not make the current bundle MIT. Third-party notices still apply. |
| Alan's Workspace iOS, `ios/` | [GPL text](../ios/LICENSE), [notice](../ios/NOTICE.md) | GPL-3.0-or-later, including reused artwork. Bundled TDLib dependencies carry their own notices. The source tree does not establish App Store distribution readiness. |
| Workspace mobile voice support, `mobile/` | [GPL text](../mobile/LICENSE), [notice](../mobile/NOTICE.md) | Mini App, Python voice bridge, and reused artwork are GPL-3.0-or-later. This Hermes voice bridge is distinct from the main MIT Hermes plugin in the agents repo. |
| Alan's CU MCP, `desktop/scripts/browser-mcp.cjs` and supporting `desktop/` code | The enclosing [desktop notice](../desktop/NOTICE.md) and GPL package metadata | Covered by the existing desktop GPL-3.0-or-later scope; no separate `workspace-mcp` license or exception was found. **TODO:** confirm that scope is the intended license for the separately named product. Do not infer MIT from the MCP SDK's own license. |
| Alan's Plugin for Hermes, agents repo | [Root MIT license at inspected revision](https://github.com/capthvnsen/alans-way-agents/blob/e749fc0f677f22ecb4ad2da649d7da2ff8e4cf04/LICENSE); root README declares MIT | Existing `alans-way/`, `alans-way-computer/`, and router/setup source are in that MIT repo. Imported or distributed dependencies retain their own terms. |
| Alan's Plugin for Grok Bot, agents repo | Same agents root MIT license; no dedicated package identified at inspected revision | **TODO:** identify the shipped skill/settings directory and confirm its notices, third-party material, and intended coverage. An absent package cannot be audited as a complete distribution. |
| Shared persona/voice/proactivity/identity spec, agents repo | No canonical spec identified at inspected revision | **TODO:** publish/identify the spec and confirm coverage under the agents license or add an explicit notice there. Do not choose a new license in this docs PR. |
| Optional Python companion CLI, `src/hermes_companion/` | [Root MIT license](../LICENSE), `pyproject.toml`: `MIT` | MIT; this is not the Node CU MCP server or the agents repo's Hermes plugin. |
| Root docs and support scripts without a more specific notice | [Root MIT license](../LICENSE) | Keep directory-specific licenses and third-party notices when redistributing a mixed tree. |

The agents repository inspection is pinned to [`e749fc0f677f22ecb4ad2da649d7da2ff8e4cf04`](https://github.com/capthvnsen/alans-way-agents/tree/e749fc0f677f22ecb4ad2da649d7da2ff8e4cf04), not an audit of unpublished packages or every transitive dependency. No LICENSE/NOTICE text or package metadata is changed by this work.

## Decisions for Alex

- **CU MCP:** confirm GPL-3.0-or-later under `desktop/` is the intended public license boundary. If a different license is desired, review the shared code/dependencies and rights first; this PR makes no alternative grant.
- **Grok Bot package:** publish its path and confirm license/notice coverage for skill text, settings, and any bundled assets or third-party material.
- **Shared config spec:** publish its path and confirm its license alongside both plugin readers in `alans-way-agents`.

Contribute under the existing license of the files you touch. Route licensing questions through [Discord](https://discord.gg/jBQCPUsVE) or an issue with the relevant product label; report vulnerabilities using [SECURITY.md](../SECURITY.md).
