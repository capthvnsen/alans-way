# Moving browser work between this computer and the VM

Two paths move a bot's page to the VM browser. Both rebuild the page there.
Neither moves a running Chromium session.

| | Lid close (automatic) | Move / Move back (button) |
| --- | --- | --- |
| Trigger | The plugin router finds this computer unreachable and calls `POST /v1/restore {bot}` on the VM | The person presses Move to VM, or Move back on the retired local copy |
| Which tabs | Every agent-controlled web tab of that bot, from the last mirror (up to 20) | The selected tab |
| Who drives the destination | The bot keeps going (`agent`) | The person reviews first (`human`), then hands it back |
| On wake | The app asks `GET /v1/mirror/continued` and retires each local copy it finds | Not applicable |

## What transfers

| State | Moves? |
| --- | --- |
| URL, title, scroll position | Yes |
| Text drafts in uniquely named fields (max 30 fields, 20,000 characters) | Yes. Password, card, OTP and token fields never do |
| Sign-in cookies for the page's own URL, including HttpOnly, Secure and session cookies (max 100 out, 150 back) | Only with **Settings › General › Carry sign-ins** on (the default) **and** a VM that SSH reaches over Tailscale |
| Cookies for other sites | No. Move back drops any cookie the page's URL would not send |
| Partitioned (CHIPS) cookies, localStorage, sessionStorage, IndexedDB, service workers | No. Sites that keep sign-in there will ask you to log in on the VM |
| Page memory, open dialogs, uploads, downloads, back/forward history | No. The destination is a fresh page load |
| Conversation and pending approvals | No. An approval must be given again in the new tab |

The Move toast says how many sign-in cookies went, or that the page went without
sign-ins. Moving back it counts cookies this computer accepted; moving to the VM
it counts cookies sent (the VM retries a rejected cookie singly and skips it).

## Tailscale-only transfer

Cookies leave this computer only over the existing SSH link to the VM, and only
when the host ssh actually dials (`ssh -G <host>`, so `~/.ssh/config` aliases
work) is a Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) or a
MagicDNS name (`*.ts.net`). A VM reached by a public IP still gets URL, scroll
and drafts, without sign-ins. So does a bare MagicDNS short name (`my-vm`): use
the full `my-vm.<tailnet>.ts.net` or the 100.x address. The same rule applies to
the background mirror.

On the VM the mirror is `mirror.json` (mode 0600, plain JSON, kept up to 24
hours and refreshed hourly while unchanged). Only the app token can write or
list it. The agent token can trigger a restore for its own bot but never read
cookies, and `POST /v1/tabs` ignores cookies unless the app token sent them.

## One live copy

A local tab the VM resumed becomes a retired source (`handoff.phase:
'handed_off'`, `automatic: true`). An agent that tries to use the old id is told
`handoff_source: this task moved to the vps tab <id>. Continue there`. The person
sees "A task continued on the VM while this computer was away" and a Move back
button. Moving back is a manual step: the bot may be mid-action on the VM.

The check runs before the app pushes its mirror again after waking or
reconnecting, so a stale local page cannot overwrite the VM's newer state on the
next lid close. When the lid closes the app also pushes the mirror at once, best
effort, since sleep may not wait for it.

## Tests

- `test/vps-host.test.cjs`: host loss mid-task against the real broker (mirror,
  restore with cookies and drafts, wake check, Move back checkpoint); Move to VM
  cookie open.
- `test/browser-persistence.test.cjs`: `handoffTab` round trip carrying cookies
  each way, no cookies without consent or tailnet, rollback when the VM side
  never opened.
- `test/vps-browser.test.cjs`, `test/core.test.cjs`: the Tailscale check, page
  scoped cookie filter, hourly mirror refresh, retire record.
- `test/cross-host-electron.cjs` exercises a real VM and needs
  `HERMES_CROSS_HOST_*` settings. Its mirror cookie check now also needs that VM
  on the tailnet.
