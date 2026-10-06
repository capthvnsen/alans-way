#!/usr/bin/env python3
"""Read and press a Linux desktop through AT-SPI. Does not move the pointer."""

import base64
import json
import os
import subprocess
import sys
import tempfile

INTERACTIVE = {
    'push button', 'toggle button', 'check box', 'radio button', 'text',
    'combo box', 'menu item', 'link', 'slider', 'spin button', 'list item',
    'scroll bar',
}
READABLE = INTERACTIVE | {'label', 'static'}
PASSWORD = {'password text'}


def emit(payload, ok=True):
    json.dump(payload, sys.stdout)
    sys.stdout.write('\n')
    raise SystemExit(0 if ok else 1)


def fail(message):
    emit({'ok': False, 'error': message}, ok=False)


def ensure_display():
    if os.environ.get('DISPLAY'):
        return
    folder = '/tmp/.X11-unix'
    socks = [name[1:] for name in os.listdir(folder) if name.startswith('X')] if os.path.isdir(folder) else []
    if len(socks) == 1:
        os.environ['DISPLAY'] = ':' + socks[0]
        return
    fail('No DISPLAY for the desktop.')


def ensure_session():
    if os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        return
    runtime = os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}'
    bus = os.path.join(runtime, 'bus')
    if not os.path.exists(bus):
        fail('No session bus for the desktop.')
    os.environ['XDG_RUNTIME_DIR'] = runtime
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + bus


def active_pid():
    try:
        out = subprocess.check_output(
            ['xdotool', 'getactivewindow', 'getwindowpid'],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        return int(out)
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


def connect():
    import gi
    from gi.repository import GLib, Gio
    ensure_display()
    ensure_session()
    session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    address = session.call_sync(
        'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress',
        None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 3000, None,
    ).unpack()[0]
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    bus = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)

    def call(dest, path, iface, method, args, reply):
        return bus.call_sync(
            dest, path, iface, method, args,
            GLib.VariantType.new(reply), Gio.DBusCallFlags.NONE, 3000, None,
        )

    return GLib, call


def prop(call, glib, dest, path, key):
    return call(
        dest, path, 'org.freedesktop.DBus.Properties', 'Get',
        glib.Variant('(ss)', ('org.a11y.atspi.Accessible', key)),
        '(v)',
    ).unpack()[0]


def pid_of(call, glib, dest):
    try:
        return int(call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', glib.Variant('(s)', (dest,)), '(u)',
        ).unpack()[0])
    except Exception:
        return None


def apps_of(call, glib):
    children = call(
        'org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root',
        'org.a11y.atspi.Accessible', 'GetChildren', None, '(a(so))',
    ).unpack()[0]
    front = active_pid()
    apps = []
    for dest, path in children:
        pid = pid_of(call, glib, dest)
        frames = []
        try:
            kids = call(dest, path, 'org.a11y.atspi.Accessible', 'GetChildren', None, '(a(so))').unpack()[0]
        except Exception:
            kids = []
        for child_dest, child_path in kids:
            try:
                role = call(child_dest, child_path, 'org.a11y.atspi.Accessible', 'GetRoleName', None, '(s)').unpack()[0]
                name = prop(call, glib, child_dest, child_path, 'Name')
            except Exception:
                continue
            if role == 'frame' and name and name != '-':
                frames.append(name)
        label = frames[0] if frames else prop(call, glib, dest, path, 'Name')
        if not label or label == '-':
            continue
        apps.append({
            'name': label,
            'bundleId': '',
            'pid': pid if isinstance(pid, int) else -1,
            'frontmost': pid is not None and pid == front,
            'dest': dest,
            'path': path,
        })
    return apps


def require_app(apps, pid):
    app = next((item for item in apps if item['pid'] == pid), None)
    if not app:
        fail('App not found.')
    if app['frontmost']:
        fail('That app is the one in front. Leave it there; the pointer stays where it is.')
    if active_pid() is None:
        fail('Could not see which window is in front.')
    return app


def walk(call, glib, app):
    elements = []
    index = 0
    queue = [(app['dest'], app['path'], 0)]
    while queue and len(elements) < 180:
        dest, path, depth = queue.pop(0)
        if depth > 12:
            continue
        try:
            role = call(dest, path, 'org.a11y.atspi.Accessible', 'GetRoleName', None, '(s)').unpack()[0]
            name = prop(call, glib, dest, path, 'Name') or ''
            if role == 'scroll bar' and not name:
                name = 'scroll bar'
                try:
                    name = f'scroll bar {round(float(value_of(call, glib, dest, path, "CurrentValue")))}'
                except Exception:
                    pass
            if role == 'text' and not name:
                try:
                    name = call(dest, path, 'org.a11y.atspi.Text', 'GetText', glib.Variant('(ii)', (0, 200)), '(s)').unpack()[0]
                except Exception:
                    name = ''
            if role in ('check box', 'radio button', 'toggle button'):
                try:
                    words = call(dest, path, 'org.a11y.atspi.Accessible', 'GetState', None, '(au)').unpack()[0]
                    checked = bool(words) and bool(int(words[0]) & (1 << 4))
                    name = f'{name} on' if checked else f'{name} off'
                except Exception:
                    pass
            kids = call(dest, path, 'org.a11y.atspi.Accessible', 'GetChildren', None, '(a(so))').unpack()[0]
        except Exception:
            continue
        if role in READABLE or role in PASSWORD:
            index += 1
            element = {'ref': f'c{index}', 'role': role, 'name': name[:120], 'dest': dest, 'path': path}
            element.update(box_of(call, glib, dest, path))
            elements.append(element)
        for child_dest, child_path in kids:
            queue.append((child_dest, child_path, depth + 1))
    return elements


def box_of(call, glib, dest, path):
    try:
        x, y, width, height = call(
            dest, path, 'org.a11y.atspi.Component', 'GetExtents',
            glib.Variant('(u)', (0,)), '((iiii))',
        ).unpack()[0]
    except Exception:
        return {}
    if width <= 0 or height <= 0:
        return {}
    return {'x': x, 'y': y, 'width': width, 'height': height}


def public_element(element):
    shown = {'ref': element['ref'], 'role': element['role'], 'name': element['name']}
    for key in ('x', 'y', 'width', 'height'):
        if key in element:
            shown[key] = element[key]
    return shown


def type_text(call, glib, app, ref, text):
    if len(text) > 2000:
        fail('Text is too long.')
    element = next((item for item in walk(call, glib, app) if item['ref'] == ref), None)
    if not element:
        fail('Unknown ref. Take a fresh snapshot.')
    if element['role'] in PASSWORD:
        fail('Password fields are off limits.')
    try:
        done = call(
            element['dest'], element['path'], 'org.a11y.atspi.EditableText', 'SetTextContents',
            glib.Variant('(s)', (text,)), '(b)',
        ).unpack()[0]
    except Exception:
        done = False
    if not done:
        fail('That control does not take text.')
    return {'ok': True, 'cursorMoved': False}


def click_at(call, glib, app, x, y):
    hits = []
    for element in walk(call, glib, app):
        if 'width' not in element or element['role'] not in INTERACTIVE:
            continue
        if element['x'] <= x <= element['x'] + element['width'] and element['y'] <= y <= element['y'] + element['height']:
            hits.append(element)
    if not hits:
        fail('No control at that point. Press a ref instead.')
    target = min(hits, key=lambda element: element['width'] * element['height'])
    if target['role'] in PASSWORD:
        fail('Password fields are off limits.')
    try:
        done = call(target['dest'], target['path'], 'org.a11y.atspi.Action', 'DoAction', glib.Variant('(i)', (0,)), '(b)').unpack()[0]
    except Exception:
        done = False
    if not done:
        fail('Press failed.')
    return {'ok': True, 'cursorMoved': False}


def value_of(call, glib, dest, path, key):
    return call(
        dest, path, 'org.freedesktop.DBus.Properties', 'Get',
        glib.Variant('(ss)', ('org.a11y.atspi.Value', key)), '(v)',
    ).unpack()[0]


def drag_to(call, glib, app, x, y, x2, y2):
    hits = []
    for element in walk(call, glib, app):
        if 'width' not in element or element['role'] not in INTERACTIVE:
            continue
        if element['x'] <= x <= element['x'] + element['width'] and element['y'] <= y <= element['y'] + element['height']:
            hits.append(element)
    if not hits:
        fail('No control at that point. Press a ref instead.')
    target = min(hits, key=lambda element: element['width'] * element['height'])
    if target['role'] in PASSWORD:
        fail('Password fields are off limits.')
    try:
        low = float(value_of(call, glib, target['dest'], target['path'], 'MinimumValue'))
        high = float(value_of(call, glib, target['dest'], target['path'], 'MaximumValue'))
    except Exception:
        fail('That control cannot be dragged. Press a ref instead.')
    span = target['width'] if target['width'] >= target['height'] else target['height']
    origin = target['x'] if target['width'] >= target['height'] else target['y']
    end = x2 if target['width'] >= target['height'] else y2
    fraction = 0 if span <= 0 else min(1, max(0, (end - origin) / span))
    try:
        done = call(
            target['dest'], target['path'], 'org.a11y.atspi.Value', 'SetCurrentValue',
            glib.Variant('(d)', (low + fraction * (high - low),)), '(b)',
        ).unpack()[0]
    except Exception:
        done = False
    if not done:
        fail('That control cannot be dragged. Press a ref instead.')
    return {'ok': True, 'cursorMoved': False}


def window_id(pid):
    ids = subprocess.check_output(
        ['xdotool', 'search', '--onlyvisible', '--pid', str(pid)],
        text=True, stderr=subprocess.DEVNULL,
    ).split()
    best, area = None, 0
    for wid in ids:
        geo = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', wid], text=True)
        values = dict(line.split('=', 1) for line in geo.splitlines() if '=' in line)
        width, height = int(values.get('WIDTH', '0')), int(values.get('HEIGHT', '0'))
        if width * height > area and width >= 8 and height >= 8:
            best, area = (wid, values), width * height
    if not best:
        fail('That app has no window to capture.')
    return best


def screenshot(pid, max_width):
    wid, geo = window_id(pid)
    cap = min(max(max_width, 320), 1280)
    folder = tempfile.mkdtemp(prefix='alans-way-')
    raw, jpg = os.path.join(folder, 'window.png'), os.path.join(folder, 'window.jpg')
    try:
        subprocess.check_call(['import', '-window', wid, raw], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.check_call(['convert', raw, '-resize', f'{cap}x>', '-quality', '55', jpg], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = subprocess.check_output(['identify', '-format', '%w %h', jpg], text=True).split()
        data = base64.b64encode(open(jpg, 'rb').read()).decode('ascii')
    except (subprocess.CalledProcessError, FileNotFoundError):
        fail('Could not capture that window.')
    finally:
        for path in (raw, jpg):
            try:
                os.remove(path)
            except OSError:
                pass
        os.rmdir(folder)
    return {
        'ok': True,
        'image': data,
        'imageWidth': int(info[0]),
        'imageHeight': int(info[1]),
        'windowX': float(geo.get('X', '0')),
        'windowY': float(geo.get('Y', '0')),
        'windowWidth': float(geo.get('WIDTH', '0')),
        'windowHeight': float(geo.get('HEIGHT', '0')),
    }


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        glib, call = connect()
    except SystemExit:
        raise
    except Exception as exc:
        fail(f'Desktop accessibility is unavailable ({exc}).')
    listed = apps_of(call, glib)
    if command == 'apps':
        emit({'ok': True, 'apps': [{k: app[k] for k in ('name', 'bundleId', 'pid', 'frontmost')} for app in listed]})
    if command == 'snapshot':
        pid = int(sys.argv[2])
        app = require_app(listed, pid)
        emit({'ok': True, 'elements': [public_element(item) for item in walk(call, glib, app)]})
    if command == 'press':
        pid = int(sys.argv[2])
        ref = sys.argv[3]
        app = require_app(listed, pid)
        element = next((item for item in walk(call, glib, app) if item['ref'] == ref), None)
        if not element:
            fail('Unknown ref. Take a fresh snapshot.')
        if element['role'] in PASSWORD:
            fail('Password fields are off limits.')
        if element['role'] not in INTERACTIVE:
            fail('That control has no press action. Take a fresh snapshot.')
        try:
            done = call(element['dest'], element['path'], 'org.a11y.atspi.Action', 'DoAction', glib.Variant('(i)', (0,)), '(b)').unpack()[0]
        except Exception:
            done = False
        if not done:
            fail('Press failed.')
        emit({'ok': True, 'cursorMoved': False})
    if command == 'click':
        pid = int(sys.argv[2])
        app = require_app(listed, pid)
        emit(click_at(call, glib, app, float(sys.argv[3]), float(sys.argv[4])))
    if command == 'type':
        pid = int(sys.argv[2])
        app = require_app(listed, pid)
        emit(type_text(call, glib, app, sys.argv[3], sys.argv[4]))
    if command == 'drag':
        pid = int(sys.argv[2])
        app = require_app(listed, pid)
        emit(drag_to(call, glib, app, float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])))
    if command == 'shot':
        pid = int(sys.argv[2])
        cap = int(sys.argv[3]) if len(sys.argv) > 3 else 960
        app = require_app(listed, pid)
        emit(screenshot(pid, cap))
    fail(f'unknown command {command}')


if __name__ == '__main__':
    main()
