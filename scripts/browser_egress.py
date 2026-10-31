#!/usr/bin/env python3
"""Install a UID-scoped Linux browser filter; print a plan unless --apply."""
import argparse
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile

RULE_FILE = Path('/etc/nftables.d/alan-browser.nft')
UNIT_FILE = Path('/etc/systemd/system/alan-browser-egress.service')
PRIVATE_V4 = '{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 }'


def rules(browser_uid, broker_uid, cdp_port=9222):
    if any(type(uid) is not int or uid < 0 for uid in (browser_uid, broker_uid)) or not browser_uid or browser_uid == broker_uid:
        raise ValueError('Browser and broker must be different OS users; browser cannot be root.')
    if type(cdp_port) is not int or not 1024 <= cdp_port <= 65535:
        raise ValueError('Invalid CDP port.')
    table = 'inet alan_browser'
    chain = f'{table} output'
    # No established-traffic exemption: installing a filter must also stop an
    # already-open private connection. Only replies to broker CDP are allowed.
    return '\n'.join([
        f'add table {table}',
        f'flush table {table}',
        f'add chain {chain} {{ type filter hook output priority -10; policy accept; }}',
        f'add rule {chain} oifname "lo" tcp dport {cdp_port} meta skuid != {broker_uid} reject',
        f'add rule {chain} meta skuid {browser_uid} ip daddr 127.0.0.1 tcp sport {cdp_port} ct direction reply accept',
        f'add rule {chain} meta skuid {browser_uid} ip6 daddr ::1 tcp sport {cdp_port} ct direction reply accept',
        f'add rule {chain} meta skuid {browser_uid} ip daddr {PRIVATE_V4} reject',
        f'add rule {chain} meta skuid {browser_uid} ip6 daddr != 2000::/3 reject',
        f'add rule {chain} meta skuid {browser_uid} ip6 daddr {{ 2001::/32, 2002::/16 }} reject',
        '',
    ])


def unit():
    return f'''[Unit]
Description=Private-destination filter for the isolated workspace browser
Before=alan-browser.service

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f {RULE_FILE}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
'''


def atomic_write(file, content):
    directory = file.parent
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    info = directory.lstat()
    if directory.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Unsafe system configuration directory.')
    fd, temporary = tempfile.mkstemp(prefix='.alan-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, file)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser-user', required=True)
    parser.add_argument('--broker-user', required=True)
    parser.add_argument('--cdp-port', type=int, default=9222)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    browser = pwd.getpwnam(args.browser_user)
    broker = pwd.getpwnam(args.broker_user)
    content = rules(browser.pw_uid, broker.pw_uid, args.cdp_port)
    print(f'{"APPLY" if args.apply else "DRY RUN"}: browser UID {browser.pw_uid}, broker UID {broker.pw_uid}')
    print(content)
    print(unit())
    if not args.apply:
        return
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Apply requires root on Linux with nftables and systemd.')
    with tempfile.NamedTemporaryFile(mode='w') as check:
        check.write(content)
        check.flush()
        subprocess.run(['/usr/sbin/nft', '--check', '--file', check.name], check=True)
    atomic_write(RULE_FILE, content)
    atomic_write(UNIT_FILE, unit())
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
    subprocess.run(['/usr/bin/systemctl', 'enable', '--now', 'alan-browser-egress.service'], check=True)


if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'Browser filter refused: {error}')
