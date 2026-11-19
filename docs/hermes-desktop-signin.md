# Hermes Desktop sign-in on your own server

Use Hermes Desktop in the Workspace chat pane against your own Hermes server, with a
username and password, over your own tailnet. You need no SSH tunnel, and nothing on the server is
open to the internet. The design and threat model are in
[design/webapp-signin-tailscale.md](design/webapp-signin-tailscale.md).

A Hermes Desktop sign-in can run any command as the Hermes user on the server. Treat the
password like that account's SSH key.

You need:

- A server running Hermes v0.23.1 or later, with Tailscale signed in to **your** tailnet.
- This computer on the same tailnet.
- In the Tailscale admin console under **DNS**: **MagicDNS** and **HTTPS Certificates** on.

## 1. On the server: run the setup script

SSH in as the OS user that runs Hermes, then run:

```sh
curl -fsSLO https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/webapp-signin.sh
sh webapp-signin.sh --user <a username you pick>
```

It asks for your `sudo` password once, for `tailscale serve`. When it finishes it prints the
address, for example `https://myserver.tail1234.ts.net`. It makes a new random password and
writes it to `~/.hermes/webapp-signin.txt`, which only you can read. It never prints the
password.

What it changes: `webapp.enabled`, `webapp.host` (kept at `127.0.0.1`), `webapp.port`,
`webapp.public_url` and `dashboard.basic_auth.username` in Hermes config. It also writes the password
hash and a signing secret to `~/.hermes/.env`, and runs `tailscale serve` on port 443. It
refuses to run if Tailscale Funnel is on. Running it again makes a new password, which
signs every browser out.

## 2. In the Tailscale admin console: allow only your devices on 443

Open **Access controls**. Back up the current policy first. Then add a rule so only your own
devices reach the server's port 443. List devices, not your login. A login matches every
machine signed in as you.

```json
{"action": "accept", "src": ["my-mac"], "dst": ["myserver:443"]}
```

Define `my-mac` and `myserver` under `hosts` with their `100.x` addresses. Before you remove a broader rule, make sure SSH still works without it. Click **Save**.

## 3. On the server: restart the gateway

When no chat is running:

```sh
hermes gateway restart
hermes webapp --status
```

`--status` should say it is serving.

## 4. In the Workspace: sign in

1. From this computer, read the password over your own SSH session:
   `ssh <server> cat ~/.hermes/webapp-signin.txt`.
   You can also show it as a QR code on the server with `qrencode -t ansiutf8 < ~/.hermes/webapp-signin.txt`.
   Never paste it into a chat or give it to an agent.
2. Open **Settings → Chat surface**. Choose **Hermes Desktop** and enter the address, then click **Save address**.
3. Enter the username and password, then click **Save sign-in**.

It worked if Settings says **Connected and signed in as <username>** and the chat pane shows
Hermes. The password is saved encrypted in this computer's keychain, and only for that address. If you
change the address, Workspace forgets it. When a session lapses, Workspace signs in again by itself, once. If the server
refuses the password, Settings says so and the Webapp's own form stays up.

**Sign out of Hermes Desktop** in the same section clears the sign-in cookies and the saved
password on this computer.

## If a device is lost

1. Remove it on the Tailscale admin console's **Machines** page.
2. On the server: `hermes webapp --sign-out`, then run `webapp-signin.sh` again and
   `hermes gateway restart`. Changing the password alone does not end live sessions. The new
   signing secret does.
3. Save the new password in the Workspace on your other devices.

## When something goes wrong

| Workspace says | Do this |
|---|---|
| Can't reach … | Is Tailscale on here? On the server: `hermes webapp --status` and `tailscale serve status`. Workspace retries every 30 seconds. |
| Hermes refused the saved username and password | Copy both again from `webapp-signin.txt`. |
| This Hermes has no password sign-in | Run `webapp-signin.sh`, then `hermes gateway restart`. |
| Signed out after every server restart | The signing secret did not load. Check that `~/.hermes/.env` has `HERMES_DASHBOARD_BASIC_AUTH_SECRET`. |
