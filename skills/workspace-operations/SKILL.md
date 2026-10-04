---
name: workspace-operations
description: Use for Hermes- Alan's way browser tasks, VPS desktop control, Mac/VPS browser handoff, human takeover, or sharing a tab with another bot.
---

# Workspace operations

## Choose the execution host

Identify the user's intended host and task before acting. The existing VPS
Hermes gateway owns the Telegram conversation. Workspace displays that real
conversation; it supplies Mac/VPS browser tools and a viewer of the VPS desktop.

For a task in a Workspace Mac tab, use the `workspace_browser` MCP tools. Begin
with status and assigned tabs. Confirm the reported host and tab ownership.
For a VPS browser task, use `workspace_vps_browser`. Verify status reports
`host: vps`, then find your assigned tab or open one. The Mac connector can
also route an explicit `host: vps` open, but the native VPS connector works
while the Mac app is offline. Use configured VPS computer tools for desktop
applications outside the managed browser. A connection failure means that
host is unavailable; report it or continue only work already authorized on
another host.

For VPS window input, incomplete accessibility trees, or screenshots returned
as `MEDIA:` paths, read [VPS desktop operations](references/vps-desktop.md).

## Operate a browser tab

1. Find the assigned tab, or open a task-specific tab in the background. Tabs
   exposed to your connector belong to your configured bot ID or an explicit
   grant. Sign-ins are shared live within each host's browser profile. Tabs,
   control, and task ownership remain separate. Mac and VPS profiles have
   independent authentication.
2. Read a fresh snapshot or screenshot. Use its refs and current control epoch
   for the next action, then inspect the result. The browser tools target that
   tab directly in the background and leave the real mouse alone. Completion requires observed
   page state, rather than the absence of a tool error.
3. On `human_has_control`, wait for the user to give control back. On a stale
   epoch, inspect the current state before deciding on another action. Treat a
   timed-out submission as uncertain and check its effects before resubmitting.
4. To collaborate on another bot's tab, obtain the user's explicit grant through
   Workspace's tab access dialog. Keep normal work in your own tabs.

## Hand a task between computers

Control handoff of a Mac tab keeps that same live tab, login and page state on
the Mac. The VPS agent can drive it through the private connector while the
Mac is available; the human can take over in Workspace.

The app supplies local Mac tabs and a single VPS desktop viewer. Cross-host
handoff controls are not exposed in its UI. Use an installed Companion handoff
capability only when it advertises support. Backend checkpoints may contain a
task note, source/destination IDs, verification and draft counts. Read that
context, wait for authorized agent control, and verify the destination page
and login before continuing. `review_required` means the page needs human
review. Passwords, cookies, uploads and in-memory state stay on the source
host. Keep Chromium profiles with their running browser.

The viewer is one shared desktop. **Take control** enables the human's mouse
and keyboard; **Stop control** returns to Watch. These viewer controls do not
pause browser or desktop agents. Coordinate work in the same window with the
human. Mac **Take over / Give to agent** enforces local tab control separately.
For a VPS tab reporting `human_has_control`, wait for an authorized broker
controller to release it rather than treating the viewer switch as permission.
Separate desktop streams and automatic Mac/VPS login propagation remain
additional work.

## Preserve vanilla Hermes

Keep integration in supported profile configuration, optional plugins, hooks
and skills. Use Hermes' native conversation, model, approval and delegation
interfaces. Discover currently available profiles before delegating; retire
roster entries with their profiles. New bots receive distinct connector IDs.
After a Hermes code update, use the installed CLI's gateway restart workflow,
wait for Telegram to connect, and verify a full model turn with a delivered
reply. For profile retirement, inventory live work, preserve a private full
snapshot, then use native lifecycle commands. Keep settings and recovery
archives outside the shared repository.
