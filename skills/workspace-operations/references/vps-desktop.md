# VPS desktop operations

For managed Chromium tabs, use `workspace_vps_browser` snapshots and tab-specific
input. That path enforces tab ownership/control epochs and works independently
of the desktop driver's accessibility support. These instructions apply to
other VPS desktop applications and unmanaged windows.

1. Verify the configured computer tool's host, display, window ID and PID.
   Target the user's intended window explicitly. Discover the installed tool's
   schema before selecting window/desktop modality or delivery parameters.
2. Read a fresh window state. Use its semantic handles when actionable elements
   exist. A partial tree containing only the window still permits screenshot
   grounding: inspect the image, then use that screenshot's pixel coordinates
   with the matching window target. Use reported image dimensions; a scaled
   capture and desktop screenshot have different coordinate spaces.
3. Stock Hermes may return MCP images as cached `MEDIA:<path>` references.
   Use an available authorized image reader such as `vision_analyze` on that
   window's screenshot. If the image cannot be inspected, stop instead of
   guessing coordinates. A cached file path alone does not verify page content.
4. Prefer supported window input with background delivery. In the tested X11
   driver, a direct window click reached the test page while the real VPS
   pointer stayed unchanged. A later bot-dispatched click had no confirmed
   effect, so this does not establish reliable autonomous window control.
   Explicit desktop-scoped actions can move the real pointer.
   Separate cursors do not isolate application state, fields, or browser logins.
5. Check the resulting application state after input. The generic VPS computer
   viewer enables human input without pausing these desktop tools. Coordinate
   work in the same window with the human. Managed browser tabs have a separate
   enforced control boundary through the browser broker.

The tested Cua Driver 0.28.2 returned `tool_output_invalid` from the optional
`get_agent_cursor_state` getter because its window cursor position was null
while the advertised schema required coordinates. This also occurred after a
window move. Report that introspection as unavailable; verify actual input
with fresh window state and, when needed, real `get_cursor_position` readings.
An introspection error does not establish that another input failed. Inspect
an uncertain click's effect before retrying it. Recheck this limitation after
updating the external driver; keep Hermes core unchanged.
