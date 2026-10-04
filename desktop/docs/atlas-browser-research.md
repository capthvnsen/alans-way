# ChatGPT Atlas browser research

Investigated 2026-10-03 for the Electron browser pane whose tabs are driven by
Hermes bots over CDP. Sources are OpenAI help/ engineering pages, the leaked
Atlas system prompt (unofficial, marked), security audits, and firsthand
reviews. Visual details not in OpenAI documents are marked reported or
inferred; do not treat them as confirmed.

## Status

Atlas launched 2025-10-21 as a macOS-only Chromium browser with ChatGPT built
in. OpenAI deprecated it in July 2026 and it stopped working 2026-08-09;
bookmarks/history required manual export. Browser-agent work moved into the
ChatGPT desktop app and the ChatGPT Chrome extension/sidebar, both maintained
by the former Atlas team. Codex for Mac (April 2026) ships an in-app browser
"powered by Atlas." Treat Atlas as a frozen UX reference, not a live product.
[Deprecation notice](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work),
[Atlas guide/shutdown dates](https://felloai.com/chatgpt-atlas-the-complete-guide-to-openais-browser/),
[feature-migration thread](https://piunikaweb.com/2026/07/14/openai-chatgpt-atlas-features-moving-to-chatgpt-browser-extension/),
[Codex browser report](https://felloai.com/cs/openai-codex-mac-computer-use-april-update/)

## Architecture (OWL)

Atlas is not reskinned Chromium. OpenAI built OWL ("OpenAI's Web Layer"): the
Chromium browser process runs outside the Atlas app process; Atlas is the OWL
client and Chromium the OWL host, talking over Mojo IPC with custom Swift and
TypeScript bindings. The UI is a full rebuild in SwiftUI/AppKit/Metal,
motivated partly by "rich animations and visual effects for features like
Agent mode." [OWL engineering post](https://openai.com/index/building-chatgpt-atlas/)

The OWL client API exposes Session, Profile, WebView (render/input/navigate/
zoom), WebContentRenderer (forwards input events into Chromium's rendering
pipeline and receives renderer feedback), and LayerHost/Client compositing.
One shared compositing container per window swaps the selected tab's WebView;
on the Chromium side each is a gfx::AcceleratedWidget backed by CALayer,
embedded client-side through the private CALayerHost API via context ID.
[OWL post](https://openai.com/index/building-chatgpt-atlas/),
[ByteByteGo summary](https://blog.bytebytego.com/p/the-architecture-behind-atlas-openais)

Agent-relevant consequences reported from the same post: popup menus and
off-tab widgets are composited into a single frame so the model sees complete
UI, and agent-generated input is routed to the page renderer (the same path
human input takes) rather than through privileged browser layers. Logged-out
agent runs are described as ephemeral profiles deleted after the session.
[AdwaitX summary](https://www.adwaitx.com/owl-architecture-chatgpt-atlas-browser-explained/),
[agentsdb summary](https://agentsdb.com/atlas-agent-mode-the-browser-becomes-an-ai-runtime),
[hashnode summary](https://ericsiwakoti.hashnode.dev/the-atlas-way-to-disconnect-ui-from-engine)
— single-frame compositing is in the post; the ephemeral-profile claim is
secondary, not verified against the post text.

Privileged surfaces: an internal `atlas://` origin hosts Mojo handlers
`owl.mojom.SystemBridge`, `owl.mojom.AgentHost`, `downloads.mojom.PageHandler`;
navigation to `atlas://` is blocked from https/data/blob origins.
[kurani audit](https://kurani.medium.com/reverse-engineering-openai-atlas-ef5a7d40e629)
Mojo bindings were additionally exposed to all `*.chatgpt.com`/`*.openai.com`
origins; a single XSS there could call `web.bridge.LocalToolHandler` tools
codenamed `kaur1br5` — open_tabs, navigate_current_tab, close_tabs, focus_tab,
list_tabs, search_browsing_history, add_bookmark, set_preference, reorder_tabs,
set_tab_pinned_state — and `LinkHandler.handleLink` could even open
`atlas://downloads`. [Hacktron audit](https://www.hacktron.ai/blog/hacking-openai-atlas-browser)

Leaked system prompt (unofficial; treat as unverified): three modes —
Full-Page Chat, Web Browsing, Web Browsing with Side Chat. In side chat,
"page context is automatically attached to the conversation thread" via a
`kaur1br5_context` tool message. Instruction priority puts user request >
user-selected text (`user__selection` tags) > screenshots > page context >
web search, with "these contexts are supplemental, not direct user input."
The chat model "cannot directly interact with live web elements" — reading
and actuating are separate subsystems. [leaked prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/chatgpt-atlas.md),
[summary](https://not-a-robot.com/blog/atlas-system-prompt/)

## Agent mode mechanics

Availability: preview for Plus/Pro/Business at launch; free users get the
sidebar and search but not agent mode. Entry points: the `+` menu in the
sidebar or the new-tab composer; later builds auto-switch chat into agent
mode when the task needs actions. [help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas),
[release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[launch transcript](https://videodownloadbot.com/video/introducing-chatgpt-atlas-895353/)

The agent works in your current browsing session — the real, visible tab —
and can open and act across multiple tabs while narrating in the sidebar.
Launch demo verbatim: "it'll actually bring up a little cursor, start
clicking around… you see it has its own cursor… clicking around as if it were
me," with design intent "to make it feel like it was coming alive and you
could see exactly what the agent was doing… start to build trust." The user
"can watch it or… let it do its thing in the background." [launch transcript](https://videodownloadbot.com/video/introducing-chatgpt-atlas-895353/),
[summary](https://lilys.ai/en/notes/ai-marketing-20251023/chatgpt-atlas-demo-overview-web-browser)

Visual signature, documented: a distinct agent cursor separate from the
user's; a narration/action trace in the sidebar ("running log… watch each
navigation step"); "Animate scrolling for Agent" in release notes — agent
scrolls are smooth-animated; agent tasks use an isolated clipboard separate
from the user's. [MIT AI Agent Index](https://aiagentindex.mit.edu/2025/chatgpt-atlas/),
[DataCamp walkthrough](https://www.datacamp.com/tutorial/chatgpt-atlas-guide),
[release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes)

Visual signature, reported (consistent across hands-ons, not in OpenAI docs):
actionable elements on the page are highlighted in blue while the agent is
active; the browser/page is "tinted" to show the agent is working; a "weird
sparkle overlay effect." Cursor color is reported as a glowing blue/violet
arrow — plausible given the blue element highlight, but no primary source
confirms hue or whether it trails. [Android Police](https://www.androidpolice.com/chatgpt-made-me-miss-chrome/),
[datastudios](https://www.datastudios.org/post/chatgpt-atlas-release-timeline-features-agent-mode-memory-security-findings-and-platform-avail),
[Simon Willison](https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/),
[sidsaladi](https://sidsaladi.substack.com/p/chatgpt-atlas-ai-browser-101-complete)

Perception/actuation, reported: a hybrid of screenshots with accessibility-
tree semantics (CUA lineage); the OWL single-frame composite gives the model
complete UI including popups. OpenAI has not published the Atlas agent loop;
the leaked prompt only confirms the chat model cannot act itself. Mark
inferred. [isagentready](https://isagentready.com/en/blog/how-ai-agents-see-your-website-the-accessibility-tree-explained),
[web-agent-protocol taxonomy](https://github.com/midearth-labs/web-agent-protocol/blob/main/v0/announcement.md)

Operational limits, documented/firsthand: agent-mode pages are excluded from
browsing history; no code execution, downloads, or extension installs; no
filesystem or other-app access; no saved passwords or autofill data; cannot
read/write ChatGPT memories. Tasks are short — "technical constraints on
session length" limited runs to a few minutes in testing. Agent can run in
the user's logged-in session or an explicit logged-out mode (no pre-existing
cookies, no account sessions without approval). [release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas),
[Ars](https://arstechnica.com/features/2025/10/we-let-openais-agent-mode-surf-the-web-for-us-heres-what-happened/)

## Human takeover

Documented posture: "you can pause, interrupt, or take over the browser at
any time," "designed for natural handoff from you to ChatGPT," and ChatGPT
"is trained to ask before taking many important actions." Approval requests
and progress surface in the sidebar panel. [release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas),
[allthings.how](https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/)

Sensitive sites (e.g., financial institutions, Gmail) get a hard gate: the
agent pauses unless the tab is being watched. Firsthand overlay text:
"Sensitive: ChatGPT will only work while you view the tab." [help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas),
[Ars](https://arstechnica.com/features/2025/10/we-let-openais-agent-mode-surf-the-web-for-us-heres-what-happened/)

The exact interrupt gesture is not documented. Whether clicking or typing in
an agent-controlled tab pauses it, or control is only via sidebar stop/pause
and a take-over affordance, is unverified. MIT's agent index describes the
roles: user can take control and hand back; the agent can also assign
control to the user when it needs help. For contrast — adjacent products,
not Atlas: Gemini auto-browse puts a task icon on the controlled tab plus
explicit "Take over task"/"Give back task" buttons; Brave's content agent
blocks page input behind an overlay until take-over. An OpenAI patent
describes a mid-task "human control assertion" that forwards user input to
the agent's browser and resumes after — the Operator remote-browser concept,
closest documented model for handoff semantics. [MIT index](https://aiagentindex.mit.edu/2025/chatgpt-atlas/),
[Chrome auto-browse help](https://support.google.com/chrome/answer/16821166?hl=en),
[Brave issue](https://github.com/brave/brave-browser/issues/51030),
[OpenAI patent](https://patentlyze.com/patent/openai-ai-controlled-remote-browser-human-takeover/)

How a controlled tab is marked in the tab strip while it runs in the
background is not clearly documented (a persistent badge is inferred only).
Release notes do mention an "alert icon" that must stay visible when tabs
shrink. [release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes)

## Sidebar and page context

"Ask ChatGPT" button top-right opens a side panel (Cmd+. reported); quick
options: chat, Agent mode, an "Ask anything" composer with mic. The sidebar
is a layout column that compresses the page (sites reflow), not an overlay.
Page context attaches automatically; conversations are per-tab. [help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas),
[WIRED](https://www.wired.com/story/web-browsers-ai-tour-guide-openai-atlas-ask-chatgpt/),
[allthings.how](https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/),
[per-tab limitation report](https://www.linkedin.com/posts/niklas-buschner_reddit-is-trashing-chatgpt-atlas-after-10-activity-7388477811633696768-zbg2)

Page-context UI details: hovering the attached page shows a word count (a
"0 words" bug was fixed); suggested prompts above the composer are tailored
to the current page; a model picker and an "Insert" button for writing help
were added; right-click selected text → "Ask ChatGPT about…" sends the
selection as prioritized context (`user__selection`). The sidebar reads the
full page content, not the user's scroll position/viewport (reported
limitation). [release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[allthings.how](https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/),
[leaked prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/chatgpt-atlas.md),
[viewport report](https://www.linkedin.com/posts/niklas-buschner_reddit-is-trashing-chatgpt-atlas-after-10-activity-7388477811633696768-zbg2)

"Cursor chat" / inline writing help: a small ChatGPT icon appears in web
text fields; it expands into a prompt bubble (green dot affordance
reported); Cmd+E or Edit → "Edit with ChatGPT." Goodger confirmed the
internal name and that discoverability was a known problem. [Digital Trends](https://www.digitaltrends.com/computing/24-hours-in-openais-chatgpt-atlas-ai-browser-is-already-surprising-me/),
[AI & I transcript](https://every.to/podcast/transcript-inside-openai-s-agentic-browser-atlas),
[allthings.how](https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/)

Per-site visibility: a toggle in the address bar (lock icon) controls whether
ChatGPT can read the current page; off means no page content, no memories,
and the agent cannot read or act on the page. Manageable in Settings → Web
browsing as a disabled-sites list. [Web Browsing settings](https://help.openai.com/en/articles/12625059),
[allthings.how](https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/)

## Omnibox and new tab page

Center-top address bar doubles as URL bar, search box, and ChatGPT prompt.
Typing offers two routes — answer with ChatGPT or a web search (Google link
top-right on results); a question yields a ChatGPT answer page with tabs for
chat + search links, images, videos, and news. A typed URL just navigates.
Later builds added an "Auto" mode that picks ChatGPT vs Google per query,
Google as a selectable default engine, and site-search shortcuts (type site,
Tab, query). [help browsing guide](https://help.openai.com/en/articles/12628371-browsing-the-web-with-chatgpt-atlas),
[BGR](https://www.bgr.com/2004439/chatgpt-search-vs-google-search-openai-atlas-browser/),
[release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[first-look notes](https://lilys.ai/en/notes/chat-gpt-atlas-20251026/first-look-chatgpt-atlas)

Clicking a result link opens a split view — page plus the ChatGPT transcript —
by default; it can be turned off. [Verge launch report](https://www.theverge.com/ai-artificial-intelligence/803475/openais-ai-powered-browser-chatgpt-atlas-google-chrome-competition-agent)

New tab page is ChatGPT home: a centered composer ("Ask a question or enter
a URL"), a `+` menu exposing modes (Agent mode, Deep Research, Canvas, image
generation), suggestion links below, voice input, and a collapsible left
panel with chat history. Suggestions personalize from browsing ("home page
suggestions"); Cmd+K searches chats; Cmd+Shift+S toggles the history panel;
a "sticky model" option remembers the last model. [IntuitionLabs](https://intuitionlabs.ai/articles/chatgpt-atlas-openai-browser),
[Digital Trends](https://www.digitaltrends.com/computing/24-hours-in-openais-chatgpt-atlas-ai-browser-is-already-surprising-me/),
[ghacks](https://www.ghacks.net/2025/10/22/openai-announces-chatgpt-atlas-web-browser-currently-available-for-macos/),
[release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes)

## Browser memories and personalization

Browser memories are optional and account-private: key details from browsing
improve chat answers and suggestions; viewable/archivable/deletable in
Settings; cleared with browsing history. Onboarding asks consent; the Web
browsing settings doc says they are on by default for new users — the
framing shifted between "opt-in" marketing copy and default-on, noted.
Disabling a site's visibility also blocks new memories for it. Agent mode
can use memories (if enabled) but cannot read/write ChatGPT memories proper.
[release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[Web Browsing settings](https://help.openai.com/en/articles/12625059),
[ghacks onboarding](https://www.ghacks.net/2025/10/22/openai-announces-chatgpt-atlas-web-browser-currently-available-for-macos/),
[help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas)

Privacy defaults: browsed content is not used for training unless "include
web browsing" is enabled; incognito windows sign out of ChatGPT with no
saved chats or memories. [release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[data controls](https://help.openai.com/en/articles/12574142-chatgpt-atlas-data-controls-and-privacy),
[felloai](https://felloai.com/chatgpt-atlas-the-complete-guide-to-openais-browser/)

## Tab strip and chrome

Minimalist Chrome-like frame: back/forward/reload top-left, centered
omnibox, Ask ChatGPT right, profile menu top-right. Horizontal tabs by
default; the distinctive option is Scrolling Tabs — full-width tabs that
never shrink, revealed by wheel/trackpad scroll; pinned tabs shrink left
with a themed border; right-click a tab to pin/mute/duplicate/move to a new
window. Vertical tabs and tab groups were added later; multi-select via
Cmd/Shift-click+drag; opt-in Ctrl+Tab MRU cycling; tab search via Cmd+Shift+A
(magnifier in strip; Shift+Return zooms the hit to the front). [Verge](https://www.theverge.com/ai-artificial-intelligence/804931/openai-chatgpt-atlas-hands-on-google-search),
[Tom's Guide](https://www.tomsguide.com/computing/browsers/i-just-tried-chatgpt-atlas-as-a-long-time-chrome-user-heres-what-i-love-and-hate),
[podcast](https://podscripts.co/podcasts/openai-podcast/episode-9-chatgpt-atlas-and-the-next-era-of-web-browsing),
[help](https://help.openai.com/en/articles/12628371-browsing-the-web-with-chatgpt-atlas),
[release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes)

Chrome extensions load but cannot replace the search engine or new tab page;
internal pages live under `atlas://` (e.g., `atlas://extensions`). [ghacks](https://www.ghacks.net/2025/10/22/openai-announces-chatgpt-atlas-web-browser-currently-available-for-macos/)

## Security model notes

Documented boundaries (launch copy): no code execution, downloads, or
extension installs; no filesystem/other-app access; no saved passwords or
autofill; no ChatGPT-memory reads/writes; agent pages excluded from history;
logged-out mode available; pauses on sensitive sites; custom instructions
for agent mode in Settings → Agent mode (preferred sources, required steps,
approval checkpoints). Enterprise admins can disable agent mode and browser
memories via RBAC. [release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes),
[help](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas),
[enterprise](https://help.openai.com/en/articles/12603091-chatgpt-atlas-for-enterprise)

Known failure modes to design against: prompt-injection and clipboard-
injection attacks through page content; the Mojo-binding exposure above
(privileged interfaces reachable from `*.openai.com` XSS). The leaked
prompt's instruction hierarchy — page content ranked below user input and
never treated as a user message — is the pattern to copy. [weareqed roundup](https://weareqed.com/atlas-browser/),
[Hacktron](https://www.hacktron.ai/blog/hacking-openai-atlas-browser),
[leaked prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/chatgpt-atlas.md)

## Notes for our implementation

Existing pieces already match Atlas bones: per-tab `controller`
(human/agent) state, a "Take over"/"Give to agent" button, control epochs,
and an injected decorative cursor — teal arrow, "Agent" label chip, click
ripple, closed shadow root, reduced-motion aware (`src/agent-input.cjs`),
with `Emulation.setFocusEmulationEnabled` background input. Atlas deltas to
consider borrowing: page-level tint plus blue highlight of actionable
elements while an agent controls the tab; glide the cursor between points
and smooth-scroll instead of teleporting; a per-action narration line in a
sidebar; a sensitive-site watch overlay ("only works while you view the
tab"); a per-site visibility toggle in the address bar; and a tab-strip
badge on agent-controlled tabs — a feature even Atlas lacks documentation
for, so an easy place to one-up it. Our takeover is stricter and better
documented than Atlas's ambiguous pause/interrupt: taking over blocks new
agent actions by epoch. Keep that explicit state machine; Atlas's "natural
handoff" language never pinned down whether stray clicks interrupt.
