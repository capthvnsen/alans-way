'use strict';
const { shellQuote } = require('./cloud-migrate.cjs');

// Read and edit on the remote machine: stdout caps and interrupted SSH reads
// must never turn a partial .env into the replacement file.
const command = 'python3 -c ' + shellQuote(String.raw`
import fcntl, json, os, re, stat, sys, tempfile
try:
    data = json.load(sys.stdin)
    key, value = data['key'], data['value']
    if key not in ('ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN') or not isinstance(value, str) or any(c in value for c in '\r\n\0'):
        raise ValueError()
    path = os.path.expanduser(data['path'])
    parent = os.path.dirname(path)
    lock = os.open(path + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'r+') as held:
        if not stat.S_ISREG(os.fstat(held.fileno()).st_mode):
            raise ValueError()
        fcntl.flock(held, fcntl.LOCK_EX)
        original = None
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            if os.path.lexists(path):
                raise ValueError()
        else:
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 1048576:
                    raise ValueError()
                original = source.read(1048577)
                if len(original) > 1048576:
                    raise ValueError()
        text = (original or b'').decode('utf-8')
        pattern = re.compile(r'^(?:export[ \t]+)?' + key + r'=.*$', re.M)
        if len(pattern.findall(text)) > 1:
            raise ValueError()
        line = key + "='" + value.replace("'", "'\\''") + "'"
        updated = pattern.sub(lambda _: line, text, count=1) if pattern.search(text) else text + ('' if not text or text.endswith('\n') else '\n') + line + '\n'
        temp_fd, temp = tempfile.mkstemp(prefix='.env-', dir=parent)
        try:
            with os.fdopen(temp_fd, 'wb') as target:
                target.write(updated.encode('utf-8'))
                target.flush()
                os.fsync(target.fileno())
            if original is None:
                os.link(temp, path) # exclusive creation: never replace a file that appeared meanwhile
            else:
                with open(path, 'rb') as current:
                    now = os.fstat(current.fileno())
                    if (now.st_dev, now.st_ino) != (info.st_dev, info.st_ino) or current.read(1048577) != original:
                        raise ValueError()
                if os.path.islink(path):
                    raise ValueError()
                os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
except Exception:
    sys.stderr.write('Env update refused; existing configuration preserved.\n')
    sys.exit(1)
`);

// Listing the parent distinguishes absent profiles from an unreadable inventory.
const profileInventoryCommand = 'python3 -c ' + shellQuote(String.raw`
import os, sys
try:
    root = os.path.expanduser('~/.hermes')
    entries = os.listdir(root)
    if 'profiles' in entries:
        for name in os.listdir(os.path.join(root, 'profiles')):
            print(name)
except Exception:
    sys.stderr.write('Profile inventory unavailable.\n')
    sys.exit(1)
`);

module.exports = { command, profileInventoryCommand };
