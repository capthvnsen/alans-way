"""Run only as root inside `unshare --net`; never changes the host firewall."""
import os
import json
from pathlib import Path
import socket
import socketserver
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
from browser_egress import rules

BROWSER = 60001
BOT = 60002


def run(*args, **options):
    return subprocess.run(args, check=True, **options)


def drop_user(uid):
    os.setgroups([])
    os.setgid(uid)
    os.setuid(uid)


def serve(address, port, uid):
    drop_user(uid)

    class Echo(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                self.request.recv(1024)
                self.request.sendall(b'ok')
            except OSError:
                pass

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True
        address_family = socket.AF_INET6 if ':' in address else socket.AF_INET

    with Server((address, port), Echo) as server:
        print('ready', flush=True)
        server.serve_forever()


def connect(address, port, uid):
    drop_user(uid)
    try:
        # Models a hostname that resolved to loopback; kernel policy sees the IP.
        if address == 'rebound.example':
            address = '127.0.0.1'
        with socket.create_connection((address, port), timeout=1) as client:
            client.sendall(b'GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n')
            return client.recv(2) == b'ok'
    except OSError:
        return False


def main():
    assert os.geteuid() == 0
    # Fail rather than accidentally applying to a non-isolated runner network.
    interfaces = [item['ifname'] for item in json.loads(subprocess.check_output(['ip', '-json', 'link', 'show']))]
    assert interfaces == ['lo'], interfaces
    run('ip', 'link', 'set', 'lo', 'up')
    tailnet = '.'.join(map(str, [100, 64, 0, 1]))
    for address in ['198.51.100.1/32', '10.10.0.1/32', '169.254.254.1/32', tailnet + '/32', 'fd00::1/128', '2001:db8::1/128']:
        run('ip', 'addr', 'add', address, 'dev', 'lo')
    servers = []
    existing = None
    try:
        for address, port, uid in [('0.0.0.0', 18080, 0), ('::', 18081, 0), ('127.0.0.1', 9222, BROWSER)]:
            child = subprocess.Popen([sys.executable, __file__, '--serve', address, str(port), str(uid)], stdout=subprocess.PIPE, text=True)
            servers.append(child)
            assert child.stdout.readline().strip() == 'ready'
        # A connection that predates installation must not escape the rules.
        os.seteuid(BROWSER)
        try:
            existing = socket.create_connection(('127.0.0.1', 18080), timeout=1)
        finally:
            os.seteuid(0)
        for _ in range(2):
            run('nft', '-f', '-', input=rules(BROWSER, 0), text=True)
        try:
            existing.sendall(b'old private socket')
            assert existing.recv(2) != b'ok', 'pre-existing private connection escaped'
        except OSError:
            pass
        finally:
            existing.close()
            existing = None
        cases = [(BROWSER, address, port, False) for address, port in [
            ('127.0.0.1', 18080), ('10.10.0.1', 18080), ('169.254.254.1', 18080),
            (tailnet, 18080), ('::1', 18081), ('fd00::1', 18081), ('rebound.example', 18080),
        ]]
        cases += [(BROWSER, '198.51.100.1', 18080, True), (BROWSER, '2001:db8::1', 18081, True),
                  (BOT, '127.0.0.1', 9222, False), (0, '127.0.0.1', 9222, True)]
        for uid, address, port, expected in cases:
            result = subprocess.run([sys.executable, __file__, '--connect', address, str(port), str(uid)])
            assert (result.returncode == 0) == expected, (uid, address, port, expected)
        print('PASS: kernel blocks private IPv4/IPv6, rebinding, WebSocket transport, old sockets and bot CDP; public traffic and broker CDP work.')
    finally:
        if existing:
            existing.close()
        for child in servers:
            child.terminate()
        for child in servers:
            child.wait(timeout=5)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--serve']:
        serve(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    elif sys.argv[1:2] == ['--connect']:
        sys.exit(0 if connect(sys.argv[2], int(sys.argv[3]), int(sys.argv[4])) else 1)
    else:
        main()
