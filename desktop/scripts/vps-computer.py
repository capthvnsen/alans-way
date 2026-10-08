#!/usr/bin/env python3
"""Read and press a Linux desktop through AT-SPI. Does not move the pointer.

`serve` keeps the D-Bus connection and the last walk of each app alive and
answers one JSON line per request. `once` answers a single request. The
legacy argv commands (apps, snapshot, press, type, click, drag, shot) still work.
"""

import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from collections import OrderedDict

CAP = 180
DEPTH = 12
BUDGET = 5.0
NODE_CAP = 2500
CALL_MS = 1000
MAX_STEPS = 25

ROLE_NUM = {
    'push button': 43, 'toggle button': 62, 'check box': 7, 'radio button': 44, 'text': 61,
    'entry': 79, 'combo box': 11, 'menu item': 35, 'check menu item': 8, 'radio menu item': 45,
    'link': 88, 'slider': 51, 'spin button': 52, 'list item': 32, 'scroll bar': 48,
    'page tab': 37, 'tree item': 91, 'label': 29, 'static': 116, 'password text': 40,
}
INTERACTIVE = {name for name in ROLE_NUM if name not in ('label', 'static', 'password text')}
READABLE = INTERACTIVE | {'label', 'static'}
PASSWORD = {'password text'}
TEXT_ROLES = {'text', 'entry'}
TOGGLES = {'check box', 'radio button', 'toggle button', 'check menu item', 'radio menu item'}
STATE_CHECKED, STATE_ENABLED, STATE_FOCUSED, STATE_SHOWING = 4, 8, 12, 25
WALK_LIMIT, PID_LIMIT = 16, 32

A = 'org.a11y.atspi.Accessible'
REGISTRY = ('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root')
DBUS = ('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus')

POLICY = {'exact': set(), 'contains': []}
PID_CACHE = OrderedDict()
WALKS = OrderedDict()
BUS = None


class Fail(Exception):
    def __init__(self, message, code='failed'):
        super().__init__(message)
        self.code = code


def fail(message, code='failed'):
    raise Fail(message, code)


def remember(store, key, value, limit):
    store[key] = value
    store.move_to_end(key)
    while len(store) > limit:
        store.popitem(last=False)


def stale(message='Unknown ref. Take a fresh snapshot.'):
    fail(message, 'stale_ref')


# ---- pure logic -----------------------------------------------------------

def set_policy(policy):
    POLICY['exact'] = {str(item).lower() for item in policy.get('exact', [])}
    POLICY['contains'] = [str(item).lower() for item in policy.get('contains', [])]


def blocked(app_id):
    app_id = str(app_id or '').lower()
    if not app_id:
        return False
    return app_id in POLICY['exact'] or any(part and part in app_id for part in POLICY['contains'])


def fingerprint(elements):
    rows = []
    for item in elements:
        box = [str(int((item[key] + 0.5) // 1)) if key in item else '' for key in ('x', 'y', 'width', 'height')]
        rows.append('|'.join([item['ref'], item['role'], item['name'], item.get('value', '')] + box))
    return '\n'.join(rows)


def generation_of(text):
    h = 0x811C9DC5
    for byte in text.encode('utf-8'):
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return h & 0x7FFFFFFF


KEYS = {
    'return': 'Return', 'tab': 'Tab', 'space': 'space', 'escape': 'Escape', 'backspace': 'BackSpace',
    'forwarddelete': 'Delete', 'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'home': 'Home', 'end': 'End', 'pageup': 'Prior', 'pagedown': 'Next',
}
KEYS.update({f'f{n}': f'F{n}' for n in range(1, 13)})
PUNCT = {
    '.': 'period', ',': 'comma', '-': 'minus', '/': 'slash', ';': 'semicolon', "'": 'apostrophe',
    '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash', '=': 'equal', '`': 'grave',
}
MODS = {'shift': 'shift', 'control': 'ctrl', 'alt': 'alt', 'meta': 'super'}


def xdotool_key(key, modifiers):
    name = KEYS.get(key) or PUNCT.get(key) or (key if len(key) == 1 else None)
    if not name or any(mod not in MODS for mod in modifiers):
        fail('Unknown key.', 'bad_request')
    return '+'.join([MODS[mod] for mod in modifiers] + [name])


SCROLL_BUTTON = {'up': '4', 'down': '5', 'left': '6', 'right': '7'}
CLICK_BUTTON = {'click': '1', 'double_click': '1', 'right_click': '3'}


def pixel_argv(step):
    """xdotool arguments for a step that gives a screen point (or free text) and no ref; None for any other step."""
    action = step.get('action')
    if step.get('ref') is not None:
        return None
    if action == 'type':
        text = step.get('text')
        if not isinstance(text, str) or len(text) > 2000:
            fail('Text is too long.', 'bad_request')
        return ['type', '--delay', '8', '--', text]
    if action not in ('click', 'double_click', 'right_click', 'drag', 'scroll') or 'x' not in step or 'y' not in step:
        return None
    try:
        x, y = float(step['x']), float(step['y'])
        x2, y2 = (float(step['x2']), float(step['y2'])) if action == 'drag' else (x, y)
        amount = float(step.get('amount', 1))
    except (KeyError, TypeError, ValueError):
        fail(f'{action} needs numeric coordinates.', 'bad_request')
    move = lambda px, py: ['mousemove', '--sync', str(round(px)), str(round(py))]
    if action == 'drag':
        return (move(x, y) + ['mousedown', '1'] + move((x + x2) / 2, (y + y2) / 2) + move(x2, y2) + ['mouseup', '1'])
    if action == 'scroll':
        if step.get('direction') not in SCROLL_BUTTON:
            fail('scroll needs a direction of up, down, left, or right.', 'bad_request')
        return move(x, y) + ['click', '--repeat', str(min(40, max(1, round(amount * 4)))), SCROLL_BUTTON[step['direction']]]
    repeat = ['--repeat', '2', '--delay', '60'] if action == 'double_click' else []
    return move(x, y) + ['click'] + repeat + [CLICK_BUTTON[action]]


def menu_norm(title):
    text = str(title).replace('&', '').replace('_', '').strip().lower()
    for tail in ('…', '...'):
        if text.endswith(tail):
            text = text[:-len(tail)].rstrip()
    return text


def jpeg_size(data):
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
        elif marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
        elif 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack('>HH', data[i + 5:i + 9])
            return width, height
        else:
            i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
    return None


def role_rule():
    words = [0, 0, 0, 0]
    for number in ROLE_NUM.values():
        words[number // 32] |= 1 << (number % 32)
    return [word - (1 << 32) if word >= 1 << 31 else word for word in words]


def fair_take(lists, cap):
    take, left, moved = [0] * len(lists), cap, True
    while left and moved:
        moved = False
        for i, items in enumerate(lists):
            if left and take[i] < len(items):
                take[i] += 1
                left -= 1
                moved = True
    return [items[:n] for items, n in zip(lists, take)]


# ---- environment and D-Bus -------------------------------------------------

def ensure_display():
    if os.environ.get('DISPLAY'):
        return
    folder = '/tmp/.X11-unix'
    socks = [name[1:] for name in os.listdir(folder) if name.startswith('X')] if os.path.isdir(folder) else []
    if len(socks) == 1:
        os.environ['DISPLAY'] = ':' + socks[0]
        return
    fail('No DISPLAY for the desktop.')


def atspi_address(text):
    """The bus address in `xprop -root AT_SPI_BUS` output, or None."""
    match = re.search(r'"(unix:[^"]+)"', text)
    return match.group(1) if match else None


def ensure_session():
    if os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        return
    runtime = os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}'
    bus = os.path.join(runtime, 'bus')
    if not os.path.exists(bus):
        fail('No session bus for the desktop.')
    os.environ['XDG_RUNTIME_DIR'] = runtime
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + bus


class Bus:
    def __init__(self):
        from gi.repository import GLib, Gio
        self.GLib, self.Gio = GLib, Gio
        ensure_display()
        flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
        # An agent VM has no session bus; the X root property still names the accessibility bus.
        self.conn = None
        try:
            address = atspi_address(subprocess.check_output(
                ['xprop', '-root', 'AT_SPI_BUS'], text=True, stderr=subprocess.DEVNULL, timeout=3))
            if address:
                self.conn = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)
        except (subprocess.SubprocessError, OSError, GLib.Error):
            pass
        if self.conn is None:
            ensure_session()
            session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            address = session.call_sync(
                'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress',
                None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 3000, None,
            ).unpack()[0]
            self.conn = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)

    def v(self, signature, values):
        return self.GLib.Variant(signature, values)

    def call(self, dest, path, iface, method, args, reply):
        return self.conn.call_sync(
            dest, path, iface, method, args, self.GLib.VariantType.new(reply),
            self.Gio.DBusCallFlags.NONE, CALL_MS, None,
        ).unpack()

    def many(self, calls):
        """Fire every call at once and wait for them all; failures come back as Exception items."""
        results = [None] * len(calls)
        pending = [len(calls)]

        def done(source, res, index):
            try:
                results[index] = source.call_finish(res).unpack()
            except Exception as exc:
                results[index] = exc
            pending[0] -= 1

        for index, (dest, path, iface, method, args, reply) in enumerate(calls):
            self.conn.call(
                dest, path, iface, method, args, self.GLib.VariantType.new(reply),
                self.Gio.DBusCallFlags.NONE, CALL_MS, None, done, index,
            )
        context = self.GLib.MainContext.default()
        deadline = time.time() + CALL_MS / 1000 + 2
        while pending[0] and time.time() < deadline:
            context.iteration(False)
            if pending[0]:
                time.sleep(0.0005)
        for index, item in enumerate(results):
            if item is None:
                results[index] = TimeoutError('D-Bus call timed out')
        return results

    def prop(self, dest, path, key, iface=A):
        return self.call(dest, path, 'org.freedesktop.DBus.Properties', 'Get', self.v('(ss)', (iface, key)), '(v)')[0]

    def prop_call(self, dest, path, key, iface=A):
        return (dest, path, 'org.freedesktop.DBus.Properties', 'Get', self.v('(ss)', (iface, key)), '(v)')

    def acc(self, dest, path, method, args=None, reply='(s)', iface=A):
        return self.call(dest, path, iface, method, args, reply)


def get_bus():
    global BUS
    if BUS is None:
        try:
            import gi  # noqa: F401
        except ImportError:
            fail('Desktop accessibility needs python3-gi.')
        try:
            BUS = Bus()
        except Fail:
            raise
        except Exception as exc:
            fail(f'Desktop accessibility is unavailable ({exc}).')
    return BUS


def proc_name(pid):
    try:
        return os.path.basename(os.readlink(f'/proc/{pid}/exe')).replace(' (deleted)', '').lower()
    except OSError:
        pass
    try:
        with open(f'/proc/{pid}/comm') as handle:
            return handle.read().strip().lower()
    except OSError:
        return ''


def active_pid():
    # no cache: a stale answer could let a key or click land in the window the user just focused
    try:
        return int(subprocess.check_output(
            ['xdotool', 'getactivewindow', 'getwindowpid'],
            text=True, stderr=subprocess.DEVNULL, timeout=3,
        ).strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def registry_apps(bus):
    kids = bus.call(*REGISTRY, A, 'GetChildren', None, '(a(so))')[0]
    pids = bus.many([(*DBUS, 'GetConnectionUnixProcessID', bus.v('(s)', (dest,)), '(u)') for dest, _ in kids])
    PID_CACHE.clear()
    out = []
    for (dest, path), pid in zip(kids, pids):
        pid = -1 if isinstance(pid, Exception) else int(pid[0])
        out.append((dest, path, pid))
        if pid not in PID_CACHE:
            remember(PID_CACHE, pid, (dest, path), PID_LIMIT)
    alive = {pid for _, _, pid in out}
    for pid in [pid for pid in WALKS if pid not in alive]:
        WALKS.pop(pid)
    return out


def resolve_app(pid):
    bus = get_bus()
    hit = PID_CACHE.get(pid)
    if hit:
        try:
            bus.acc(hit[0], hit[1], 'GetRoleName')
            return hit
        except Exception:
            PID_CACHE.pop(pid, None)
    return next(((dest, path) for dest, path, found in registry_apps(bus) if found == pid), None)


def agent_desktop():
    return os.environ.get('ALANS_WAY_AGENT_DESKTOP') == '1'


def check_app(pid):
    """The app's AT-SPI handle. On the agent's own desktop it is None for pid 0 (the whole screen) and for apps AT-SPI cannot see."""
    agent = agent_desktop()
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < (0 if agent else 1):
        fail('App not found.', 'not_found')
    if pid == 0:
        return None
    try:
        app = resolve_app(pid)
    except Fail:
        if not agent:
            raise
        app = None
    if not app and not agent:
        fail('App not found.', 'not_found')
    if blocked(proc_name(pid)):
        fail('That app is off limits.', 'off_limits')
    if agent:
        return app
    front = active_pid()
    if front is None:
        fail('Could not see which window is in front.')
    if front == pid:
        fail('That app is the one in front. Leave it there; the pointer stays where it is.', 'in_front')
    return app


# ---- walking ---------------------------------------------------------------

def children_of(bus, handle):
    try:
        return [tuple(item) for item in bus.acc(handle[0], handle[1], 'GetChildren', None, '(a(so))')[0]]
    except Exception:
        fail('That app is not responding.', 'unresponsive')


def match_windows(bus, roots):
    """Collection.GetMatches per window; None when the toolkit does not answer it."""
    rule = ([1 << STATE_SHOWING, 0], 1, {}, 1, role_rule(), 2, [], 1, False)
    args = bus.v('((aiia{ss}iaiiasib)uib)', (rule, 1, CAP + 1, True))
    calls = [(d, p, 'org.a11y.atspi.Collection', 'GetMatches', args, '(a(so))') for d, p in roots]
    results = bus.many(calls)
    if any(isinstance(item, Exception) for item in results):
        return None
    lists = [[tuple(ref) for ref in item[0]] for item in results]
    return lists if any(lists) else None


def bfs_windows(bus, roots, deadline):
    """Level-synchronous breadth-first walk of every window, one round trip per level."""
    nodes = {}
    frontier = list(roots)
    found = 0
    depth = 0
    lossy = False
    while frontier and depth <= DEPTH and time.time() < deadline and len(nodes) < NODE_CAP and found <= CAP:
        calls = []
        for dest, path in frontier:
            calls.append((dest, path, A, 'GetRoleName', None, '(s)'))
            calls.append((dest, path, A, 'GetChildren', None, '(a(so))'))
        results = bus.many(calls)
        if depth == 0 and all(isinstance(item, Exception) for item in results):
            fail('That app is not responding.', 'unresponsive')
        nxt = []
        for index, node in enumerate(frontier):
            role, kids = results[2 * index], results[2 * index + 1]
            lossy = lossy or isinstance(role, Exception) or isinstance(kids, Exception)
            role = '' if isinstance(role, Exception) else role[0]
            kids = [] if isinstance(kids, Exception) else [tuple(ref) for ref in kids[0]]
            nodes[node] = (role, kids)
            if role in READABLE or role in PASSWORD:
                found += 1
            nxt.extend(kid for kid in kids if kid not in nodes)
        frontier = nxt
        depth += 1
    lists = []
    for root in roots:
        order, stack = [], [root]
        while stack and len(order) <= CAP:
            node = stack.pop()
            role, kids = nodes.get(node, ('', []))
            if role in READABLE or role in PASSWORD:
                order.append(node)
            stack.extend(reversed(kids))
        lists.append(order)
    return lists, bool(frontier) or lossy


def empty_walk():
    return {'generation': generation_of(''), 'elements': [], 'handles': {}, 'truncated': False, 'focused': set()}


def walk_app(pid, app, menubar=False, store=True):
    if app is None:
        return empty_walk()
    bus = get_bus()
    deadline = time.time() + BUDGET
    roots = children_of(bus, app)
    truncated = False
    lists = match_windows(bus, roots)
    if lists is None:
        lists, cut = bfs_windows(bus, roots, deadline)
        truncated = cut
    if sum(len(items) for items in lists) > CAP:
        truncated = True
    forced = [kid for bar in menu_bars(bus, app) for kid in children_of(bus, bar)] if menubar else []
    cands = forced + [ref for items in fair_take(lists, CAP) for ref in items if ref not in forced]
    results = bus.many([call for d, p in cands for call in (
        (d, p, A, 'GetRoleName', None, '(s)'),
        bus.prop_call(d, p, 'Name'),
        (d, p, A, 'GetState', None, '(au)'),
        (d, p, 'org.a11y.atspi.Component', 'GetExtents', bus.v('(u)', (0,)), '((iiii))'),
    )])
    nodes = []
    if cands and all(isinstance(results[4 * index], Exception) for index in range(len(cands))):
        fail('That app is not responding.', 'unresponsive')
    for index, (d, p) in enumerate(cands):
        role, name, state, box = results[4 * index:4 * index + 4]
        if isinstance(role, Exception):
            truncated = True
        if isinstance(role, Exception) or (role[0] not in READABLE | PASSWORD and (d, p) not in forced):
            continue
        if not isinstance(box, Exception) and box[0][0] == -2147483648:
            continue
        nodes.append({
            'handle': (d, p), 'role': role[0], 'name': '' if isinstance(name, Exception) else (name[0] or ''),
            'state': None if isinstance(state, Exception) else state[0],
            'box': None if isinstance(box, Exception) else box[0],
        })
    extra = []
    for node in nodes:
        d, p = node['handle']
        if node['role'] in ('scroll bar', 'slider'):
            extra.append((node, 'number', (d, p, 'org.freedesktop.DBus.Properties', 'Get',
                                           bus.v('(ss)', ('org.a11y.atspi.Value', 'CurrentValue')), '(v)')))
        elif node['role'] in TEXT_ROLES:
            extra.append((node, 'value', (d, p, 'org.a11y.atspi.Text', 'GetText', bus.v('(ii)', (0, 200)), '(s)')))
    for (node, key, _), got in zip(extra, bus.many([item[2] for item in extra])):
        if not isinstance(got, Exception):
            node[key] = got[0]
    elements, handles, focused = [], {}, set()
    for node in nodes:
        role, name = node['role'], node['name']
        if role in ('scroll bar', 'slider') and 'number' in node:
            number = str(round(float(node['number'])))
            name = f'{name} {number}' if name else (f'{role} {number}' if role == 'scroll bar' else number)
        elif role == 'scroll bar' and not name:
            name = 'scroll bar'
        if node['state']:
            bits = int(node['state'][0]) if node['state'] else 0
            checked, enabled = bits & (1 << STATE_CHECKED), bits & (1 << STATE_ENABLED)
            if role in TOGGLES:
                name = f'{name} on' if checked else f'{name} off'
            if (role in INTERACTIVE or role in PASSWORD) and not enabled:
                name = f'{name} disabled'.strip()
        element = {'ref': f'c{len(elements) + 1}', 'role': role, 'name': name[:120]}
        if node.get('value') and role not in PASSWORD:
            element['value'] = node['value'][:200]
        if node['box'] and node['box'][2] > 0 and node['box'][3] > 0:
            element.update(zip(('x', 'y', 'width', 'height'), node['box']))
        elements.append(element)
        handles[element['ref']] = node['handle']
        if node['state'] and int(node['state'][0]) & (1 << STATE_FOCUSED):
            focused.add(element['ref'])
    walk = {'generation': generation_of(fingerprint(elements)), 'elements': elements, 'handles': handles,
            'truncated': truncated, 'focused': focused}
    if store:
        remember(WALKS, pid, walk, WALK_LIMIT)
    return walk


def walk_reply(walk):
    reply = {'generation': walk['generation'], 'elements': walk['elements']}
    if walk['truncated']:
        reply['truncated'] = True
    return reply


# ---- steps -----------------------------------------------------------------

def hit_test(elements, x, y):
    hits = [
        item for item in elements
        if 'width' in item and (item['role'] in INTERACTIVE or item['role'] in PASSWORD)
        and item['x'] <= x <= item['x'] + item['width'] and item['y'] <= y <= item['y'] + item['height']
    ]
    return min(hits, key=lambda item: item['width'] * item['height']) if hits else None


def do_action(bus, handle, index=0):
    try:
        return bool(bus.call(handle[0], handle[1], 'org.a11y.atspi.Action', 'DoAction', bus.v('(i)', (index,)), '(b)')[0])
    except Exception:
        return False


def action_names(bus, handle):
    try:
        return [item[0].lower() for item in bus.call(handle[0], handle[1], 'org.a11y.atspi.Action', 'GetActions', None, '(a(sss))')[0]]
    except Exception:
        return []


def parent_of(bus, handle):
    try:
        dest, path = bus.prop(handle[0], handle[1], 'Parent')
    except Exception:
        return None
    return None if path.endswith('/null') or path == REGISTRY[1] else (dest, path)


def select_in_parent(bus, handle):
    parent = parent_of(bus, handle)
    if not parent:
        return False
    try:
        index = bus.acc(handle[0], handle[1], 'GetIndexInParent', None, '(i)')[0]
        return bool(bus.call(parent[0], parent[1], 'org.a11y.atspi.Selection', 'SelectChild', bus.v('(i)', (index,)), '(b)')[0])
    except Exception:
        return False


class Target:
    def __init__(self, pid, app, gen):
        self.pid, self.app, self.gen = pid, app, gen
        self.walk = WALKS.get(pid)

    def ensure(self):
        if self.walk is None:
            self.walk = walk_app(self.pid, self.app)
        return self.walk

    def element(self, step):
        walk = self.ensure()
        if step.get('ref') is not None:
            ref = str(step['ref'])
            item = next((e for e in walk['elements'] if e['ref'] == ref), None)
            if not item:
                stale()
            handle = walk['handles'][ref]
            try:
                get_bus().acc(handle[0], handle[1], 'GetRoleName')
            except Exception:
                stale('stale_ref: That element is gone. Take a fresh snapshot.')
            return item, handle
        if 'x' in step and 'y' in step:
            item = hit_test(walk['elements'], float(step['x']), float(step['y']))
            if not item:
                fail('No control at that point. Press a ref instead.', 'not_found')
            return item, walk['handles'][item['ref']]
        fail('That action needs a ref or x and y.', 'bad_request')


def refuse_password_focus(bus, target):
    """Keys and pointer events land on the focused control, so a focused password field blocks them.
    With no accessibility tree for the target, every app on the bus is asked."""
    anywhere = target.app is None
    try:
        if anywhere:
            bus = get_bus()
            apps = [(dest, path) for dest, path, _ in registry_apps(bus)]
        else:
            apps = [target.app]
        roots = [root for app in apps for root in children_of(bus, app)]
    except Exception:
        if anywhere:
            return
        raise
    rule = ([1 << STATE_FOCUSED, 0], 1, {}, 1, [0, 0, 0, 0], 1, [], 1, False)
    args = bus.v('((aiia{ss}iaiiasib)uib)', (rule, 1, 8, True))
    got = bus.many([(d, p, 'org.a11y.atspi.Collection', 'GetMatches', args, '(a(so))') for d, p in roots])
    if any(isinstance(item, Exception) for item in got):
        if anywhere:
            return
        walk = walk_app(target.pid, target.app, store=False)
        hit = any(e['role'] in PASSWORD and e['ref'] in walk['focused'] for e in walk['elements'])
    else:
        refs = [tuple(ref) for item in got for ref in item[0]]
        hit = any(not isinstance(role, Exception) and role[0] in PASSWORD
                  for role in bus.many([(d, p, A, 'GetRoleName', None, '(s)') for d, p in refs]))
    if hit:
        fail('Password fields are off limits.', 'off_limits')


def no_password(item):
    if item['role'] in PASSWORD:
        fail('Password fields are off limits.', 'off_limits')


def step_press(bus, target, step):
    item, handle = target.element(step)
    no_password(item)
    if item['role'] not in INTERACTIVE:
        fail('That control has no press action. Take a fresh snapshot.')
    if do_action(bus, handle):
        return {'ok': True, 'cursorMoved': False, 'via': 'ax'}
    if item['role'] == 'list item' and select_in_parent(bus, handle):
        return {'ok': True, 'cursorMoved': False, 'via': 'select'}
    cursor = handle
    for _ in range(4):
        cursor = parent_of(bus, cursor)
        if not cursor:
            break
        if do_action(bus, cursor):
            return {'ok': True, 'cursorMoved': False, 'via': 'ancestor'}
    fail('Press failed.')


def step_type(bus, target, step):
    text = step.get('text')
    if not isinstance(text, str) or len(text) > 2000:
        fail('Text is too long.', 'bad_request')
    item, handle = target.element(step)
    no_password(item)
    try:
        done = bus.call(handle[0], handle[1], 'org.a11y.atspi.EditableText', 'SetTextContents', bus.v('(s)', (text,)), '(b)')[0]
    except Exception:
        done = False
    if not done:
        fail('That control does not take text.')
    return {'ok': True, 'cursorMoved': False}


def step_named_action(bus, target, step, wanted, label):
    if step.get('ref') is None:
        refuse_password_focus(bus, target)
    item, handle = target.element(step)
    no_password(item)
    names = action_names(bus, handle)
    for index, name in enumerate(names):
        if wanted(name):
            if do_action(bus, handle, index):
                return {'ok': True, 'cursorMoved': False}
            fail(f'{label} failed.')
    fail(f'{label} is not available on Linux for that control.', 'unsupported_action')


def step_drag(bus, target, step):
    try:
        x2, y2 = float(step['x2']), float(step['y2'])
    except (KeyError, TypeError, ValueError):
        fail('drag needs x2 y2', 'bad_request')
    item, handle = target.element(step)
    no_password(item)
    try:
        low = float(bus.prop(handle[0], handle[1], 'MinimumValue', 'org.a11y.atspi.Value'))
        high = float(bus.prop(handle[0], handle[1], 'MaximumValue', 'org.a11y.atspi.Value'))
    except Exception:
        fail('That control cannot be dragged. Press a ref instead.')
    horizontal = item['width'] >= item['height']
    span = item['width'] if horizontal else item['height']
    origin = item['x'] if horizontal else item['y']
    end = x2 if horizontal else y2
    fraction = 0 if span <= 0 else min(1, max(0, (end - origin) / span))
    try:
        done = bus.call(handle[0], handle[1], 'org.a11y.atspi.Value', 'SetCurrentValue', bus.v('(d)', (low + fraction * (high - low),)), '(b)')[0]
    except Exception:
        done = False
    if not done:
        fail('That control cannot be dragged. Press a ref instead.')
    return {'ok': True, 'cursorMoved': False}


def near(box, item, slack=40):
    return (item['x'] - slack <= box['x'] + box['width'] and box['x'] - slack <= item['x'] + item['width']
            and item['y'] - slack <= box['y'] + box['height'] and box['y'] - slack <= item['y'] + item['height'])


def step_scroll(bus, target, step):
    direction = step.get('direction')
    if direction not in ('up', 'down', 'left', 'right'):
        fail('scroll needs a direction of up, down, left, or right.', 'bad_request')
    try:
        amount = float(step.get('amount', 1))
    except (TypeError, ValueError):
        fail('scroll amount must be a number.', 'bad_request')
    walk = target.ensure()
    vertical = direction in ('up', 'down')
    anchor = None
    if step.get('ref') is not None or 'x' in step:
        anchor = target.element(step)[0]
    bars = [e for e in walk['elements'] if e['role'] == 'scroll bar' and 'width' in e
            and (e['height'] > e['width']) == vertical]
    if anchor and anchor['role'] == 'scroll bar':
        bars = [anchor]
    elif anchor and 'width' in anchor:
        bars = [e for e in bars if near(anchor, e)]
    if not bars:
        fail('No scroll bar found for that area.', 'unsupported_action')
    bar = max(bars, key=lambda e: e['width'] * e['height'])
    handle = walk['handles'][bar['ref']]
    try:
        low = float(bus.prop(handle[0], handle[1], 'MinimumValue', 'org.a11y.atspi.Value'))
        high = float(bus.prop(handle[0], handle[1], 'MaximumValue', 'org.a11y.atspi.Value'))
        now = float(bus.prop(handle[0], handle[1], 'CurrentValue', 'org.a11y.atspi.Value'))
    except Exception:
        fail('That scroll bar cannot be read.', 'unsupported_action')
    length = bar['height'] if vertical else bar['width']
    # ponytail: value units are pixels in GTK; elsewhere treat a page as a quarter of the range
    page = 0.9 * length if high - low > length else 0.25 * (high - low)
    sign = 1 if direction in ('down', 'right') else -1
    goal = min(high, max(low, now + sign * amount * page))
    if goal == now:
        return {'ok': True, 'cursorMoved': False, 'scrolled': False}
    try:
        done = bus.call(handle[0], handle[1], 'org.a11y.atspi.Value', 'SetCurrentValue', bus.v('(d)', (goal,)), '(b)')[0]
    except Exception:
        done = False
    if not done:
        fail('That scroll bar did not move.', 'unsupported_action')
    return {'ok': True, 'cursorMoved': False, 'scrolled': True}


def xdotool(*args):
    try:
        return subprocess.check_output(['xdotool', *args], text=True, stderr=subprocess.DEVNULL, timeout=5)
    except FileNotFoundError:
        fail('xdotool is not installed.', 'unsupported_action')
    except (subprocess.SubprocessError, OSError):
        return ''


def xdotool_partial(args):
    """(stdout, succeeded): a chained command that fails midway still reports what it printed before."""
    try:
        done = subprocess.run(['xdotool', *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5)
    except FileNotFoundError:
        fail('xdotool is not installed.', 'unsupported_action')
    except (subprocess.SubprocessError, OSError):
        return '', False
    return done.stdout, done.returncode == 0


def window_geometry(pid):
    """Visible windows of pid as [(wid, {X,Y,WIDTH,HEIGHT})]; two xdotool spawns however many windows."""
    ids = xdotool('search', '--onlyvisible', '--pid', str(pid)).split()[:20]
    if not ids:
        return []
    chain = [part for wid in ids for part in ('getwindowgeometry', '--shell', wid)]
    found, current = [], None
    for line in xdotool(*chain).splitlines():
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key == 'WINDOW':
            current = {}
            found.append((value, current))
        elif current is not None:
            current[key] = value
    return found


def best_window(pid):
    best, area = None, 0
    for wid, geo in window_geometry(pid):
        try:
            width, height = int(geo.get('WIDTH', '0')), int(geo.get('HEIGHT', '0'))
        except ValueError:
            continue
        if width * height > area and width >= 8 and height >= 8:
            best, area = (wid, geo), width * height
    return best


def send_xdotool(args):
    try:
        subprocess.check_call(['xdotool', *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except FileNotFoundError:
        fail('xdotool is not installed.', 'unsupported_action')
    except (subprocess.SubprocessError, OSError):
        fail('Could not send that input.')


def activate(pid):
    """Raise the app's window and confirm it has focus, so real input cannot land elsewhere. The screen (pid 0) has no window to raise, so whatever is focused must be allowed."""
    if pid <= 0:
        front = active_pid()
        if front and blocked(proc_name(front)):
            fail('That app is off limits.', 'off_limits')
        return
    window = best_window(pid)
    if not window:
        fail('That app has no window to send input to.', 'no_window')
    if xdotool('getactivewindow').strip() != window[0]:
        xdotool('windowactivate', '--sync', window[0])
        if xdotool('getactivewindow').strip() != window[0]:
            fail('Could not raise that window.')


def step_pixel(bus, target, argv):
    if argv[0] == 'type':
        refuse_password_focus(bus, target)
    activate(target.pid)
    try:
        send_xdotool(argv)
    except Fail:
        if 'mousedown' in argv:
            try:
                send_xdotool(['mouseup', '1'])
            except Fail:
                pass
        raise
    return {'ok': True, 'cursorMoved': argv[0] != 'type'}


def step_key(bus, target, step):
    key, modifiers = step.get('key'), step.get('modifiers') or []
    if not isinstance(key, str) or not key:
        fail('key needs a key.', 'bad_request')
    combo = xdotool_key(key, modifiers)
    refuse_password_focus(bus, target)
    if agent_desktop():
        activate(target.pid)
        send_xdotool(['key', combo])
        return {'ok': True, 'cursorMoved': False}
    window = best_window(target.pid)
    if not window:
        fail('That app has no window to send keys to.', 'no_window')
    try:
        subprocess.check_call(['xdotool', 'key', '--window', window[0], combo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except FileNotFoundError:
        fail('xdotool is not installed.', 'unsupported_action')
    except (subprocess.SubprocessError, OSError):
        fail('Could not send that key.')
    # ponytail: XSendEvent has no ack; GTK3 drops it unless its window is active, so callers must verify
    return {'ok': True, 'cursorMoved': False, 'delivered': 'unconfirmed'}


def menu_bars(bus, app):
    queue = [(handle, 0) for handle in children_of(bus, app)]
    found = []
    while queue and len(found) < 4:
        batch, queue = queue, []
        roles = bus.many([(d, p, A, 'GetRoleName', None, '(s)') for (d, p), _ in batch])
        for ((handle, depth), role) in zip(batch, roles):
            if isinstance(role, Exception):
                continue
            if role[0] == 'menu bar':
                found.append(handle)
            elif depth < 5:
                try:
                    queue.extend((kid, depth + 1) for kid in children_of(bus, handle))
                except Exception:
                    pass
    return found


def menu_items(bus, parent):
    """Entries of a menu or menu bar. GTK names the bar's entries 'menu'; Qt wraps submenus in unnamed 'menu' nodes."""
    kids = children_of(bus, parent)
    heads = bus.many([call for d, p in kids for call in ((d, p, A, 'GetRoleName', None, '(s)'), bus.prop_call(d, p, 'Name'))])
    items = []
    for index, kid in enumerate(kids):
        role, name = heads[2 * index], heads[2 * index + 1]
        if isinstance(role, Exception) or isinstance(name, Exception):
            continue
        if role[0] in ('menu', 'popup menu') and not name[0]:
            items.extend(children_of(bus, kid))
        else:
            items.append(kid)
    calls = []
    for d, p in items:
        calls += [bus.prop_call(d, p, 'Name'), (d, p, A, 'GetState', None, '(au)'),
                  (d, p, 'org.a11y.atspi.Action', 'GetActions', None, '(a(sss))'), bus.prop_call(d, p, 'ChildCount')]
    got = bus.many(calls)
    out = []
    for index, handle in enumerate(items):
        name, state, actions, count = got[4 * index:4 * index + 4]
        if isinstance(name, Exception) or not name[0]:
            continue
        shortcut = ''
        if not isinstance(actions, Exception) and actions[0]:
            shortcut = next((part for part in actions[0][0][2].split(';')[1:] + actions[0][0][2].split(';')[:1] if part), '')
        bits = 0 if isinstance(state, Exception) or not state[0] else int(state[0][0])
        out.append({
            'handle': handle, 'title': name[0], 'enabled': bool(bits & (1 << STATE_ENABLED)),
            'shortcut': shortcut, 'submenu': not isinstance(count, Exception) and int(count[0]) > 0,
        })
    return out


def menu_path(bus, app, path, descend=True):
    """Walk menu titles from the menu bar; returns (last matched item or None, items below it)."""
    if app is None:
        fail('That app has no menu bar.', 'unsupported_action')
    bars = menu_bars(bus, app)
    if not bars:
        fail('That app has no menu bar.', 'unsupported_action')
    items = [item for bar in bars for item in menu_items(bus, bar)]
    found = None
    for depth, title in enumerate(path):
        found = next((item for item in items if menu_norm(item['title']) == menu_norm(title)), None)
        if not found:
            fail('No such menu item.', 'not_found')
        if descend or depth < len(path) - 1:
            items = menu_items(bus, found['handle'])
    return found, items


def step_menu(bus, target, step):
    path = step.get('path')
    if not isinstance(path, list) or not path or not all(isinstance(part, str) for part in path):
        fail('menu needs a path of titles.', 'bad_request')
    found = menu_path(bus, target.app, path, descend=False)[0]
    if not found['enabled']:
        fail('That menu item is disabled.')
    if not do_action(bus, found['handle']):
        fail('Press failed.')
    return {'ok': True, 'cursorMoved': False}


STEPS = {
    'press': step_press,
    'type': step_type,
    'click': step_press,
    'drag': step_drag,
    'scroll': step_scroll,
    'key': step_key,
    'menu': step_menu,
    'double_click': lambda bus, target, step: step_named_action(
        bus, target, step, lambda name: name in ('open', 'double-click', 'doubleclick', 'activate'), 'Double click'),
    'right_click': lambda bus, target, step: step_named_action(
        bus, target, step, lambda name: 'menu' in name or 'popup' in name, 'Right click'),
}


# ---- commands --------------------------------------------------------------

X_CHROME = {'xfwm4', 'xfce4-panel', 'xfdesktop', 'wrapper-2.0', 'panel-6-systray'}


def x_apps(listed, pids, name_of):
    """Apps with a visible window that AT-SPI did not list, plus the whole screen as pid 0."""
    found, seen = [], set(listed)
    for pid in pids:
        name = name_of(pid) if pid > 0 and pid not in seen else ''
        if name and name not in X_CHROME:
            found.append({'name': name, 'bundleId': name, 'pid': pid, 'frontmost': False})
        seen.add(pid)
    return found + [{'name': 'Screen', 'bundleId': 'screen', 'pid': 0, 'frontmost': False}]


def x_window_pids():
    ids = xdotool('search', '--onlyvisible', '--name', '.').split()[:60]
    pids = []
    while ids:
        out, done = xdotool_partial([part for wid in ids for part in ('getwindowpid', wid)])
        got = [int(line) for line in out.split() if line.isdigit()]
        pids += got
        if done:
            break
        ids = ids[len(got) + 1:]  # the chain stops at a window with no pid; carry on after it
    return pids


def cmd_apps(req):
    if not agent_desktop():
        return {'ok': True, 'apps': atspi_apps()}
    global BUS
    try:
        apps = atspi_apps()
    except Exception:
        BUS, apps = None, []
    try:
        ensure_display()
        pids = x_window_pids()
    except Fail:
        pids = []
    return {'ok': True, 'apps': apps + x_apps([item['pid'] for item in apps], pids, proc_name)}


def atspi_apps():
    bus = get_bus()
    entries = registry_apps(bus)
    roots = [(dest, path) for dest, path, _ in entries]
    kids = bus.many([(d, p, A, 'GetChildren', None, '(a(so))') for d, p in roots])
    names = bus.many([bus.prop_call(d, p, 'Name') for d, p in roots])
    probes, owners = [], []
    for index, got in enumerate(kids):
        if isinstance(got, Exception):
            continue
        for child in got[0]:
            probes += [(child[0], child[1], A, 'GetRoleName', None, '(s)'), bus.prop_call(child[0], child[1], 'Name')]
            owners.append(index)
    answers = bus.many(probes)
    frames = {}
    for slot, owner in enumerate(owners):
        role, name = answers[2 * slot], answers[2 * slot + 1]
        if isinstance(role, Exception) or isinstance(name, Exception):
            continue
        if role[0] == 'frame' and name[0] and name[0] != '-':
            frames.setdefault(owner, name[0])
    front = active_pid()
    apps = []
    for index, (dest, path, pid) in enumerate(entries):
        own = '' if isinstance(names[index], Exception) else names[index][0]
        label = frames.get(index) or own
        if not label or label == '-':
            continue
        apps.append({
            'name': label, 'bundleId': proc_name(pid) if pid > 0 else '', 'pid': pid,
            'frontmost': pid > 0 and pid == front,
        })
    return apps


def cmd_snapshot(req):
    pid = req.get('pid')
    app = check_app(pid)
    reply = walk_reply(walk_app(pid, app, bool(req.get('menubar'))))
    return {'ok': True, **reply}


def cmd_act(req):
    pid, steps = req.get('pid'), req.get('steps')
    app = check_app(pid)
    if not isinstance(steps, list) or not steps or len(steps) > MAX_STEPS or not all(isinstance(s, dict) for s in steps):
        fail(f'steps must be 1 to {MAX_STEPS} objects.', 'bad_request')
    if agent_desktop():
        ensure_display()
    bus = get_bus() if app else None
    target = Target(pid, app, req.get('generation'))
    if target.gen is not None and any(s.get('ref') is not None for s in steps):
        target.walk = walk_app(pid, app, bool(req.get('menubar')))
        if target.walk['generation'] != target.gen:
            fail('stale_ref: The app changed since your snapshot. Take a fresh snapshot.', 'stale_ref')
    results = []
    for step in steps:
        run = STEPS.get(step.get('action'))
        try:
            if not run:
                fail(f"Unsupported action {step.get('action')}.", 'unsupported_action')
            argv = pixel_argv(step) if agent_desktop() else None
            results.append(step_pixel(bus, target, argv) if argv else run(bus, target, step))
        except Fail as exc:
            results.append({'ok': False, 'error': str(exc), 'code': exc.code})
            break
    response = {'ok': True, 'results': results}
    if req.get('snapshot', True) and any(item['ok'] for item in results):
        time.sleep(min(max(int(req.get('settleMs', 60)), 0), 2000) / 1000)
        response.update(walk_reply(walk_app(pid, app, bool(req.get('menubar')))))
    return response


def cmd_menu(req):
    app = check_app(req.get('pid'))
    bus = get_bus() if app else None
    path = req.get('path') or []
    if not isinstance(path, list) or not all(isinstance(part, str) for part in path):
        fail('path must be a list of titles.', 'bad_request')
    items = menu_path(bus, app, path)[1]
    out = []
    for item in items:
        entry = {'title': item['title'], 'enabled': item['enabled']}
        if item['shortcut']:
            entry['shortcut'] = item['shortcut']
        if item['submenu']:
            entry['submenu'] = True
        out.append(entry)
    return {'ok': True, 'items': out}


def pnm_size(data):
    """(width, height) of a PBM/PGM/PPM stream, or None."""
    tokens, i = [], 0
    while len(tokens) < 4 and i < len(data):
        if data[i:i + 1].isspace():
            i += 1
        elif data[i:i + 1] == b'#':
            i = data.find(b'\n', i)
            if i < 0:
                return None
        else:
            end = i
            while end < len(data) and not data[end:end + 1].isspace():
                end += 1
            tokens.append(data[i:end])
            i = end
    if len(tokens) == 4 and tokens[0] in (b'P5', b'P6'):
        try:
            return int(tokens[1]), int(tokens[2])
        except ValueError:
            pass
    return None


def to_jpeg(raw, kind, cap):
    """Capture bytes to a capped JPEG via Pillow, netpbm, or ffmpeg; None when none can."""
    try:
        import io
        from PIL import Image
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        if image.width > cap:
            image = image.resize((cap, max(1, round(image.height * cap / image.width))))
        out = io.BytesIO()
        image.save(out, 'JPEG', quality=55)
        return out.getvalue()
    except Exception:
        pass
    decoder = {'png': 'pngtopnm', 'xwd': 'xwdtopnm'}.get(kind)
    if decoder:
        try:
            pnm = subprocess.run([decoder], input=raw, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=10, check=True).stdout
            size = pnm_size(pnm)
            if size and size[0] > cap:
                try:
                    pnm = subprocess.run(['pnmscale', '-width', str(cap)], input=pnm,
                                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout
                except (subprocess.SubprocessError, OSError):
                    pass
            data = subprocess.run(['pnmtojpeg', '-quality=55'], input=pnm,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout
            if jpeg_size(data):
                return data
        except (subprocess.SubprocessError, OSError):
            pass
    if kind == 'png':
        try:
            done = subprocess.run(
                ['ffmpeg', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0',
                 '-frames:v', '1', '-vf', f"scale='min(iw,{cap})':-2", '-f', 'mjpeg', 'pipe:1'],
                input=raw, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
            if done.returncode == 0 and jpeg_size(done.stdout):
                return done.stdout
        except (subprocess.SubprocessError, OSError):
            pass
    return None


def magick_capture(wid, cap):
    try:
        return subprocess.check_output(
            ['import', '-window', wid, '-resize', f'{cap}x>', '-quality', '55', 'jpeg:-'],
            stderr=subprocess.DEVNULL, timeout=10)
    except FileNotFoundError:
        return None
    except (subprocess.SubprocessError, OSError):
        try:
            png = subprocess.check_output(['import', '-window', wid, 'png:-'], stderr=subprocess.DEVNULL, timeout=10)
            return subprocess.run(['convert', 'png:-', '-resize', f'{cap}x>', '-quality', '55', 'jpeg:-'],
                                  input=png, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout
        except (subprocess.SubprocessError, OSError):
            return None


def xwd_capture(wid, cap):
    """xwd reads the window by id, so it still works on an offscreen window."""
    try:
        raw = subprocess.check_output(['xwd', '-silent', '-id', str(wid)], stderr=subprocess.DEVNULL, timeout=10)
    except (subprocess.SubprocessError, OSError):
        return None
    return to_jpeg(raw, 'xwd', cap)


def screen_box(geo):
    """The window's on-screen rectangle for grab tools that cannot read a window id."""
    try:
        x, y, w, h = (int(float(geo[key])) for key in ('X', 'Y', 'WIDTH', 'HEIGHT'))
    except (KeyError, TypeError, ValueError):
        return None
    if x < 0:
        w, x = w + x, 0
    if y < 0:
        h, y = h + y, 0
    return (x, y, w, h) if w > 0 and h > 0 else None


def display_size():
    """(width, height) of the X display, or None when it cannot be asked."""
    try:
        parts = subprocess.check_output(['xdotool', 'getdisplaygeometry'],
                                        text=True, stderr=subprocess.DEVNULL, timeout=5).split()
        width, height = int(parts[0]), int(parts[1])
        return (width, height) if width > 0 and height > 0 else None
    except (subprocess.SubprocessError, OSError, ValueError, IndexError):
        return None


def scrot_capture(box, cap):
    """Grab the window's screen rectangle; an occluded window returns whatever is painted over it."""
    fd, tmp = tempfile.mkstemp(suffix='.png')
    try:
        os.close(fd)
        try:
            subprocess.run(['scrot', '-a', ','.join(map(str, box)), '-o', tmp],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)
            with open(tmp, 'rb') as handle:
                raw = handle.read()
        except (subprocess.SubprocessError, OSError):
            return None
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return to_jpeg(raw, 'png', cap)


def ffmpeg_capture(box, cap):
    """x11grab the window's screen rectangle when scrot is absent too."""
    display = os.environ.get('DISPLAY', '')
    host, sep, num = display.rpartition(':')
    if not sep or not num:
        return None
    if '.' not in num:
        num += '.0'
    x, y, w, h = box
    try:
        done = subprocess.run(
            ['ffmpeg', '-loglevel', 'error', '-f', 'x11grab', '-video_size', f'{w}x{h}',
             '-i', f'{host}:{num}+{x},{y}', '-frames:v', '1', '-vf', f"scale='min(iw,{cap})':-2",
             '-f', 'mjpeg', 'pipe:1'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
        return done.stdout if done.returncode == 0 else None
    except (subprocess.SubprocessError, OSError):
        return None


def capture(wid, cap, geo):
    data = magick_capture(wid, cap)
    if not jpeg_size(data or b''):
        data = xwd_capture(wid, cap)
    if not jpeg_size(data or b''):
        box = screen_box(geo or {})
        # Region tools grab the screen, not the window: pull the box inside the
        # display so a window hanging off an edge still captures. ffmpeg refuses
        # an out-of-bounds rectangle outright; scrot clips on its own.
        bounds = display_size()
        if box and bounds:
            x, y, w, h = box
            w, h = min(w, bounds[0] - x), min(h, bounds[1] - y)
            box = (x, y, w, h) if w > 0 and h > 0 else None
        if box:
            data = scrot_capture(box, cap) or ffmpeg_capture(box, cap)
    size = jpeg_size(data or b'')
    if not size:
        if not any(shutil.which(tool) for tool in ('import', 'xwd', 'scrot', 'ffmpeg')):
            fail('No screenshot tool is installed (looked for import, xwd, scrot, and ffmpeg).',
                 'unsupported_action')
        fail('Could not capture that window.')
    return data, size


def clamp_box(geo, screen):
    """(x, y, width, height) of a window geometry cut to the screen; width or height 0 when it is entirely off it."""
    left, top = int(geo.get('X', '0')), int(geo.get('Y', '0'))
    right, bottom = left + int(geo.get('WIDTH', '0')), top + int(geo.get('HEIGHT', '0'))
    left, top = max(left, 0), max(top, 0)
    return left, top, max(min(right, screen[0]) - left, 0), max(min(bottom, screen[1]) - top, 0)


def grab(box, cap):
    """JPEG of a screen rectangle through Pillow, or None when Pillow or the grab fails."""
    try:
        import io
        from PIL import ImageGrab
        x, y, width, height = box
        image = ImageGrab.grab(bbox=(x, y, x + width, y + height), xdisplay=os.environ['DISPLAY']).convert('RGB')
        if width > cap:
            image = image.resize((cap, max(1, round(height * cap / width))))
        out = io.BytesIO()
        image.save(out, 'JPEG', quality=55)
        return out.getvalue()
    except Exception:
        return None


def screen_size():
    try:
        width, height = (int(part) for part in xdotool('getdisplaygeometry').split())
    except ValueError:
        fail('Could not read the screen size.')
    return width, height


def cmd_shot(req):
    pid = req.get('pid')
    check_app(pid)
    try:
        cap = min(max(int(req.get('maxWidth', 960)), 320), 1280)
    except (TypeError, ValueError):
        cap = 960
    if agent_desktop():
        return agent_shot(pid, cap)
    window = best_window(pid)
    if not window:
        fail('That app has no window to capture.', 'no_window')
    wid, geo = window
    data, (width, height) = capture(wid, cap, geo)
    return shot_reply(data, width, height, float(geo.get('X', '0')), float(geo.get('Y', '0')),
                      float(geo.get('WIDTH', '0')), float(geo.get('HEIGHT', '0')))


def agent_shot(pid, cap):
    """Pillow reads the X screen directly, so a window hidden behind another still shows what is on screen."""
    ensure_display()
    screen = screen_size()
    wid, geo = 'root', {'X': '0', 'Y': '0', 'WIDTH': str(screen[0]), 'HEIGHT': str(screen[1])}
    box = full = (0, 0, *screen)
    if pid:
        window = best_window(pid)
        if not window:
            fail('That app has no window to capture.', 'no_window')
        wid, geo = window
        box = clamp_box(geo, screen)
        full = tuple(int(window[1].get(key, '0')) for key in ('X', 'Y', 'WIDTH', 'HEIGHT'))
        if not (box[2] and box[3]):
            fail('That app has no window on the screen.', 'no_window')
    data = grab(box, cap)
    if data and jpeg_size(data):
        width, height = jpeg_size(data)
    else:
        # the fallback grabs the whole window, so its geometry is the unclamped one
        data, (width, height) = capture(wid, cap, geo)
        box = full
    return shot_reply(data, width, height, *box)


def shot_reply(data, width, height, x, y, window_width, window_height):
    return {
        'ok': True, 'image': base64.b64encode(data).decode('ascii'), 'imageWidth': width, 'imageHeight': height,
        'windowX': x, 'windowY': y, 'windowWidth': window_width, 'windowHeight': window_height,
    }


def cmd_selftest(req):
    checks = 0

    def check(condition, label):
        nonlocal checks
        if not condition:
            fail(f'selftest failed: {label}')
        checks += 1

    check(generation_of('abc') == 440920331, 'fnv abc')
    check(generation_of('') == 18652613, 'fnv empty')
    elements = [
        {'ref': 'c1', 'role': 'AXButton', 'name': 'Save', 'x': 10, 'y': 20, 'width': 30, 'height': 40},
        {'ref': 'c2', 'role': 'AXTextField', 'name': 'Name', 'value': 'héllo', 'x': 0, 'y': 0, 'width': 5, 'height': 6},
    ]
    check(fingerprint(elements) == 'c1|AXButton|Save||10|20|30|40\nc2|AXTextField|Name|héllo|0|0|5|6', 'fingerprint')
    check(generation_of(fingerprint(elements)) == 1574858671, 'generation vector')
    check(fingerprint([{'ref': 'c1', 'role': 'r', 'name': 'n', 'x': 1.5, 'y': -0.5, 'width': 2.4, 'height': 0}])
          == 'c1|r|n||2|0|2|0', 'rounding')
    saved = dict(POLICY)
    set_policy({'exact': ['Keepassxc'], 'contains': ['1Password']})
    check(blocked('keepassxc') and blocked('com.1password.x') and not blocked('gedit') and not blocked(''), 'policy')
    POLICY.update(saved)
    check(xdotool_key('n', ['control', 'shift']) == 'ctrl+shift+n' and xdotool_key('pagedown', []) == 'Next', 'keys')
    check(menu_norm('&Save As…') == 'save as' and menu_norm('Open...') == 'open', 'menu titles')
    check(jpeg_size(b'\xff\xd8\xff\xc0\x00\x11\x08\x00\x10\x00\x20' + b'\x00' * 12) == (32, 16), 'jpeg size')
    check(pnm_size(b'P6\n4 2\n255\n') == (4, 2) and pnm_size(b'P6\n4 2\n255\n#comment\n') == (4, 2)
          and pnm_size(b'junk') is None, 'pnm size')
    check(fair_take([[1, 2, 3], [4], [5, 6]], 5) == [[1, 2], [4], [5, 6]], 'fair take')
    check(len(role_rule()) == 4, 'role rule')
    check(atspi_address('AT_SPI_BUS(STRING) = "unix:path=/run/user/0/at-spi/bus_99,guid=ab12"\n')
          == 'unix:path=/run/user/0/at-spi/bus_99,guid=ab12', 'atspi address')
    check(atspi_address('AT_SPI_BUS:  not found.\n') is None and atspi_address('') is None, 'atspi address missing')
    store = OrderedDict()
    for number in range(5):
        remember(store, number, number, 3)
    remember(store, 2, 'again', 3)
    remember(store, 9, 9, 3)
    check(list(store) == [4, 2, 9], 'lru')
    check(empty_walk() == {'generation': generation_of(''), 'elements': [], 'handles': {}, 'truncated': False, 'focused': set()}
          and empty_walk()['elements'] is not empty_walk()['elements'], 'empty walk')
    check(walk_app(5, None) == empty_walk() and refuse_password_focus(None, Target(5, None, None)) is None, 'no app, no tree')
    shown = x_apps([7], [7, 5712, 5712, 627, 628, 9, 0], lambda pid: {5712: 'chrome', 627: 'xfwm4', 628: 'xfce4-panel', 9: ''}.get(pid, 'other'))
    check(shown == [{'name': 'chrome', 'bundleId': 'chrome', 'pid': 5712, 'frontmost': False},
                    {'name': 'Screen', 'bundleId': 'screen', 'pid': 0, 'frontmost': False}], 'x apps')
    check(x_apps([], [], str) == [{'name': 'Screen', 'bundleId': 'screen', 'pid': 0, 'frontmost': False}], 'x apps always has the screen')
    point = {'x': 10.4, 'y': 20.6}
    check(pixel_argv({'action': 'click', **point}) == ['mousemove', '--sync', '10', '21', 'click', '1'], 'pixel click')
    check(pixel_argv({'action': 'double_click', **point}) == ['mousemove', '--sync', '10', '21', 'click', '--repeat', '2', '--delay', '60', '1'], 'pixel double click')
    check(pixel_argv({'action': 'right_click', **point}) == ['mousemove', '--sync', '10', '21', 'click', '3'], 'pixel right click')
    check(pixel_argv({'action': 'drag', 'x': 0, 'y': 0, 'x2': 100, 'y2': 40})
          == ['mousemove', '--sync', '0', '0', 'mousedown', '1', 'mousemove', '--sync', '50', '20',
              'mousemove', '--sync', '100', '40', 'mouseup', '1'], 'pixel drag')
    check(pixel_argv({'action': 'scroll', **point, 'direction': 'down'}) == ['mousemove', '--sync', '10', '21', 'click', '--repeat', '4', '5'], 'pixel scroll')
    check(pixel_argv({'action': 'scroll', **point, 'direction': 'left', 'amount': 0.1})[-3:] == ['--repeat', '1', '6'], 'pixel scroll minimum')
    check(pixel_argv({'action': 'scroll', **point, 'direction': 'right', 'amount': 2})[-3:] == ['--repeat', '8', '7'], 'pixel scroll right')
    check(pixel_argv({'action': 'type', 'text': '-a b'}) == ['type', '--delay', '8', '--', '-a b'], 'pixel type')
    check(all(pixel_argv(step) is None for step in (
        {'action': 'click', 'ref': 'c1', **point}, {'action': 'type', 'ref': 'c1', 'text': 'a'}, {'action': 'click'},
        {'action': 'scroll', 'direction': 'up'}, {'action': 'press', **point}, {'action': 'key', 'key': 'a'})), 'ref steps stay on AT-SPI')
    for step in ({'action': 'drag', **point}, {'action': 'scroll', **point, 'direction': 'sideways'}, {'action': 'type', 'text': 5},
                 {'action': 'click', 'x': 'a', 'y': 1}):
        try:
            pixel_argv(step)
            refused = None
        except Fail as exc:
            refused = exc.code
        check(refused == 'bad_request', f'pixel_argv rejects {step}')
    sent, displays = [], []
    state = {'active': '7', 'raise': True}

    def fake_x(*args):
        sent.append(list(args))
        if args[0] == 'getactivewindow':
            return state['active'] + '\n'
        if args[0] == 'windowactivate' and state['raise']:
            state['active'] = args[2]
        return '1920 1080\n' if args[0] == 'getdisplaygeometry' else ''

    def stubbed(agent, **fns):
        saved_fns = {name: globals()[name] for name in fns}
        globals().update(fns)
        if agent:
            os.environ['ALANS_WAY_AGENT_DESKTOP'] = '1'
        else:
            os.environ.pop('ALANS_WAY_AGENT_DESKTOP', None)

        def restore():
            os.environ.pop('ALANS_WAY_AGENT_DESKTOP', None)
            globals().update(saved_fns)
            POLICY.update(saved)
        return restore

    def codes(reply):
        return [item.get('code', 'ok') for item in reply['results']]

    io = dict(send_xdotool=sent.append, best_window=lambda pid: ('42', {}), xdotool=fake_x, resolve_app=lambda pid: None,
              active_pid=lambda: None, proc_name=lambda pid: 'gedit', ensure_display=lambda: displays.append(1))
    restore = stubbed(True, **io)
    try:
        steps = [{'action': 'click', 'x': 5, 'y': 6}, {'action': 'type', 'text': 'hi'},
                 {'action': 'key', 'key': 'a', 'modifiers': ['control']}]
        reply = cmd_act({'pid': 0, 'steps': steps, 'settleMs': 0})
        check(codes(reply) == ['ok', 'ok', 'ok'] and reply['elements'] == [], 'agent screen steps')
        check(sent == [['mousemove', '--sync', '5', '6', 'click', '1'], ['type', '--delay', '8', '--', 'hi'], ['key', 'ctrl+a']],
              'agent screen input needs no activation')
        check(displays, 'agent act finds the display')
        del sent[:]
        check(codes(cmd_act({'pid': 9, 'steps': steps[:1], 'settleMs': 0})) == ['ok'], 'agent app click')
        check(sent[:2] == [['getactivewindow'], ['windowactivate', '--sync', '42']], 'agent app is activated first')
        del sent[:]
        state['active'] = '7'
        state['raise'] = False
        reply = cmd_act({'pid': 9, 'steps': steps[:2], 'settleMs': 0})
        check(codes(reply) == ['failed'] and reply['results'][0]['error'] == 'Could not raise that window.'
              and not [a for a in sent if a[0] in ('mousemove', 'type')], 'a window that will not raise gets no input')
        state['raise'] = True
        del sent[:]
        globals()['active_pid'], globals()['proc_name'] = (lambda: 5), (lambda pid: 'keepassxc')
        set_policy({'exact': ['keepassxc'], 'contains': []})
        check(codes(cmd_act({'pid': 0, 'steps': steps, 'settleMs': 0})) == ['off_limits'] and not sent, 'the screen is off limits while a blocked app has focus')
        POLICY.update(saved)
        globals().update(active_pid=io['active_pid'], proc_name=io['proc_name'])
        del sent[:]

        def drag_fails(args):
            sent.append(args)
            if 'mousedown' in args:
                fail('Could not send that input.')
        globals()['send_xdotool'] = drag_fails
        reply = cmd_act({'pid': 0, 'steps': [{'action': 'drag', 'x': 1, 'y': 2, 'x2': 3, 'y2': 4}], 'settleMs': 0})
        check(codes(reply) == ['failed'] and sent[-1] == ['mouseup', '1'], 'a drag that fails lets go of the button')
        globals()['send_xdotool'] = sent.append
        check(pixel_argv({'action': 'scroll', 'x': 1, 'y': 1, 'direction': 'down', 'amount': 500})[-2] == '40', 'scroll repeat is capped')
        reply = cmd_act({'pid': 0, 'steps': [{'action': 'menu', 'path': ['File']}], 'settleMs': 0})
        check(codes(reply) == ['unsupported_action'], 'menu step on the screen')
        try:
            cmd_menu({'pid': 0, 'path': []})
            refused = None
        except Fail as exc:
            refused = (exc.code, str(exc))
        check(refused == ('unsupported_action', 'That app has no menu bar.'), 'menu listing on the screen')
    finally:
        restore()
    del sent[:], displays[:]
    restore = stubbed(False, get_bus=lambda: None, walk_app=lambda pid, app, menubar=False, store=True: empty_walk(),
                      **{**io, 'resolve_app': lambda pid: ('d', '/p'), 'active_pid': lambda: 6})
    try:
        reply = cmd_act({'pid': 9, 'steps': [{'action': 'click', 'x': 5, 'y': 6}], 'settleMs': 0})
        check(codes(reply) == ['not_found'] and not sent and not displays, 'a user desktop never calls xdotool for a point')
    finally:
        restore()
    class Pw:
        def v(self, signature, values):
            return values

        def many(self, calls):
            return [([('d', '/f')],) if call[3] == 'GetMatches' else (self.role,) for call in calls]
    pw = Pw()
    restore = stubbed(True, get_bus=lambda: pw, registry_apps=lambda bus: [('d', '/app', 1)], children_of=lambda bus, handle: [('d', '/w')])
    try:
        pw.role = 'password text'
        try:
            refuse_password_focus(None, Target(0, None, None))
            refused = None
        except Fail as exc:
            refused = exc.code
        check(refused == 'off_limits', 'a focused password field anywhere blocks ref-less typing')
        pw.role = 'entry'
        check(refuse_password_focus(None, Target(0, None, None)) is None, 'a focused entry does not')
    finally:
        restore()
    restore = stubbed(True, atspi_apps=lambda: [{'name': 'a', 'bundleId': 'a', 'pid': 3, 'frontmost': False}],
                      xdotool=lambda *args: fail('xdotool is not installed.', 'unsupported_action'), ensure_display=lambda: None)
    try:
        check([item['pid'] for item in cmd_apps({})['apps']] == [3, 0], 'apps survive a missing xdotool')
    finally:
        restore()
    calls = []

    def partial(args):
        calls.append(list(args))
        return ('10\n', False) if len(calls) == 1 else ('30\n', True)
    restore = stubbed(True, xdotool=lambda *args: '1 2 3', xdotool_partial=partial)
    try:
        check(x_window_pids() == [10, 30] and calls[1] == ['getwindowpid', '3'], 'a window without a pid is skipped')
    finally:
        restore()
    screen = (1920, 1080)
    check(clamp_box({'X': '-10', 'Y': '5', 'WIDTH': '100', 'HEIGHT': '2000'}, screen) == (0, 5, 90, 1075), 'clamp box')
    check(clamp_box({'X': '100', 'Y': '50', 'WIDTH': '640', 'HEIGHT': '480'}, screen) == (100, 50, 640, 480), 'clamp keeps a window that fits')
    check(clamp_box({'X': '1900', 'Y': '0', 'WIDTH': '50', 'HEIGHT': '10'}, screen) == (1900, 0, 20, 10)
          and clamp_box({'X': '3000', 'Y': '0', 'WIDTH': '50', 'HEIGHT': '10'}, screen)[2] == 0, 'clamp off-screen')
    fake_jpeg = b'\xff\xd8\xff\xc0\x00\x11\x08\x00\x10\x00\x20' + b'\x00' * 12
    grabbed = []
    del displays[:]
    restore = stubbed(True, grab=lambda box, cap: grabbed.append((box, cap)) or fake_jpeg,
                      best_window=lambda pid: ('42', {'X': '-5', 'Y': '10', 'WIDTH': '800', 'HEIGHT': '600'}),
                      xdotool=lambda *args: '1920 1080\n', resolve_app=lambda pid: None, ensure_display=lambda: displays.append(1),
                      capture=lambda wid, cap, geo: (fake_jpeg, (32, 16)))
    try:
        whole = cmd_shot({'pid': 0, 'maxWidth': 640})
        check(grabbed[-1] == ((0, 0, 1920, 1080), 640) and (whole['windowX'], whole['windowY'], whole['windowWidth'], whole['windowHeight'])
              == (0, 0, 1920, 1080) and (whole['imageWidth'], whole['imageHeight']) == (32, 16), 'agent screen shot')
        part = cmd_shot({'pid': 9})
        check(grabbed[-1][0] == (0, 10, 795, 600) and (part['windowX'], part['windowWidth']) == (0, 795), 'agent window shot is clamped')
        check(len(displays) == 2, 'agent shot finds the display')
        globals()['grab'] = lambda box, cap: None
        part = cmd_shot({'pid': 9})
        check((part['windowX'], part['windowY'], part['windowWidth'], part['windowHeight']) == (-5, 10, 800, 600),
              'the fallback reports the geometry it captured')
    finally:
        restore()
    names = ('resolve_app', 'active_pid', 'proc_name')
    saved_fns = {name: globals()[name] for name in names}
    globals().update(resolve_app=lambda pid: ('d', '/p'), proc_name=lambda pid: 'gedit', active_pid=lambda: None)
    try:
        for front, code in ((None, 'failed'), (5, 'in_front')):
            globals()['active_pid'] = lambda front=front: front
            try:
                check_app(5)
                refused = None
            except Fail as exc:
                refused = exc.code
            check(refused == code, f'check_app {front}')
        globals()['active_pid'] = lambda: 6
        check(check_app(5) == ('d', '/p'), 'check_app allows a background app')
        try:
            check_app(0)
            refused = None
        except Fail as exc:
            refused = exc.code
        check(refused == 'not_found', 'check_app refuses pid 0 on a user desktop')
        os.environ['ALANS_WAY_AGENT_DESKTOP'] = '1'
        try:
            globals()['active_pid'] = lambda: 5
            check(check_app(5) == ('d', '/p'), 'agent desktop allows the front app')
            globals()['active_pid'] = lambda: None
            check(check_app(5) == ('d', '/p'), 'agent desktop needs no front window')
            check(check_app(0) is None, 'agent desktop allows the whole screen')
            globals()['resolve_app'] = lambda pid: None
            check(check_app(5) is None, 'agent desktop allows an app with no accessibility tree')
            globals()['resolve_app'] = lambda pid: fail('No bus.')
            check(check_app(5) is None, 'agent desktop allows a missing bus')
            set_policy({'exact': ['gedit'], 'contains': []})
            try:
                check_app(5)
                refused = None
            except Fail as exc:
                refused = exc.code
            check(refused == 'off_limits', 'agent desktop keeps the policy')
        finally:
            del os.environ['ALANS_WAY_AGENT_DESKTOP']
            POLICY.update(saved)
    finally:
        globals().update(saved_fns)
    return {'ok': True, 'checks': checks}


COMMANDS = {
    'init': lambda req: {'ok': True, 'protocol': 2},
    'apps': cmd_apps, 'snapshot': cmd_snapshot, 'act': cmd_act, 'menu': cmd_menu, 'shot': cmd_shot,
    'selftest': cmd_selftest,
}


def handle(req):
    global BUS
    reply_id = req.get('id') if isinstance(req, dict) else None
    try:
        if not isinstance(req, dict):
            fail('Request must be a JSON object.', 'bad_request')
        if isinstance(req.get('policy'), dict):
            set_policy(req['policy'])
        run = COMMANDS.get(req.get('cmd'))
        if not run:
            fail(f"unknown command {req.get('cmd')}", 'bad_request')
        response = run(req)
    except Fail as exc:
        response = {'ok': False, 'error': str(exc), 'code': exc.code}
    except Exception as exc:
        BUS = None
        PID_CACHE.clear()
        WALKS.clear()
        response = {'ok': False, 'error': f'Desktop helper failed ({exc}).', 'code': 'failed'}
    if reply_id is not None:
        response['id'] = reply_id
    return response


def write(response):
    sys.stdout.write(json.dumps(response, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def parse_line(line):
    try:
        return json.loads(line)
    except ValueError:
        return None


def legacy_request(argv):
    command, rest = argv[0], argv[1:]
    try:
        pid = int(rest[0]) if rest else None
        if command == 'apps':
            return {'cmd': 'apps'}
        if command == 'snapshot':
            return {'cmd': 'snapshot', 'pid': pid}
        if command == 'shot':
            return {'cmd': 'shot', 'pid': pid, 'maxWidth': int(rest[1]) if len(rest) > 1 else 960}
        steps = {
            'press': lambda: {'action': 'press', 'ref': rest[1]},
            'type': lambda: {'action': 'type', 'ref': rest[1], 'text': rest[2]},
            'click': lambda: {'action': 'click', 'x': float(rest[1]), 'y': float(rest[2])},
            'drag': lambda: {'action': 'drag', 'x': float(rest[1]), 'y': float(rest[2]), 'x2': float(rest[3]), 'y2': float(rest[4])},
        }
        if command in steps:
            return {'cmd': 'act', 'pid': pid, 'steps': [steps[command]()], 'snapshot': False}
    except (ValueError, IndexError):
        pass
    return {'cmd': command, 'pid': None}


def flatten(request, response):
    if request.get('cmd') != 'act' or not response.get('ok'):
        return response
    first = response['results'][0]
    return first if first.get('ok') else {'ok': False, 'error': first.get('error'), 'code': first.get('code')}


def main():
    argv = sys.argv[1:]
    mode = argv[0] if argv else ''
    if mode == 'serve':
        for line in sys.stdin:
            if line.strip():
                request = parse_line(line)
                write(handle(request if request is not None else []))
        return 0
    if mode == 'once':
        request = parse_line(sys.stdin.readline())
        response = handle(request if request is not None else [])
    elif mode == 'selftest':
        request = {'cmd': 'selftest'}
        response = handle(request)
    elif mode:
        request = legacy_request(argv)
        response = flatten(request, handle(request))
    else:
        response = {'ok': False, 'error': 'missing command', 'code': 'bad_request'}
    write(response)
    return 0 if response.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
