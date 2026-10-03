---
name: workspace-operations
description: Use for Hermes Workspace browser tasks, Mac/VPS execution handoff, human takeover, or explicitly sharing a tab with another bot.
---

# Workspace operations

## Choose the execution host

Identify the user's intended host and task before acting. The existing VPS
Hermes gateway owns the Telegram conversation. Workspace displays that real
conversation; it supplies Mac browser tools and a viewer of the VPS desktop.

For a task in a Workspace Mac tab, use the `workspace_browser` MCP tools. Begin
with status and assigned tabs. Confirm the reported host and tab ownership.
For VPS desktop work, use the configured VPS computer tools and verify the
desktop identity. A connection failure means that host is unavailable; report
it or continue only work already authorized on another host.

## Operate a browser tab

1. Find the assigned tab, or open a task-specific tab in the background. Tabs
   exposed to your connector belong to your configured bot ID or an explicit
   grant. Shared cookies within the Mac browser do not grant another tab's
   control or access.
2. Read a fresh snapshot or screenshot. Use its refs and current control epoch
   for the next action, then inspect the result. Completion requires observed
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

Moving execution to a new VPS browser is a different operation. Record the
task, source host/tab, URL, verified last action, outstanding step and needed
login. Use the installed Companion handoff capability only when it advertises
support for that operation. Otherwise reopen on the destination and verify the
page and login before proceeding. Report which state was carried over and
which was recreated. Keep Chromium profile directories with their running
browser; copying live profiles is not a login synchronization mechanism.

The current VPS viewer is one shared desktop. Watch/Control enables viewer
input; it does not pause an agent or establish exclusive control. Coordinate
with other work before taking over. Separate VPS desktops and automatic
Mac/VPS login propagation require capabilities beyond this first connector.

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
