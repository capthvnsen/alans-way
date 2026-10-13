#!/bin/sh
# Read-only update evidence. No env dump, config/auth/runtime files or fetches.
# Optional arguments name additional browser-host or plugin clone directories.
exec python3 - "$@" <<'PY'
import json, os, pathlib, re, shutil, subprocess, sys


def scrub(value):
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@', r'\1[redacted]@', value)
        # URL query/fragment values may contain tokens; do not print them.
        return re.sub(r'([a-zA-Z][a-zA-Z0-9+.-]*://[^?#\s]+)[?#][^\s]*', r'\1[redacted]', value)
    return value


def command(args):
    try:
        # Avoid status refreshing the index or invoking a configured fsmonitor.
        env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, timeout=10, env=env)
        return r.stdout.strip() if r.returncode == 0 else '(unavailable)'
    except (OSError, subprocess.TimeoutExpired):
        return '(unavailable)'


home = pathlib.Path(os.environ.get('HERMES_HOME', str(pathlib.Path.home() / '.hermes')))
hermes = shutil.which('hermes')
if not hermes:
    candidate = pathlib.Path.home() / '.local/bin/hermes'
    hermes = str(candidate) if candidate.is_file() else None
banner = command([hermes, '--version']) if hermes else ''
version = re.search(r'Hermes Agent v([0-9A-Za-z.+-]+)', banner)
print('Hermes:', version.group(1) if version else '(version unavailable)')
profiles = [home] + sorted((home / 'profiles').glob('*/'))
clones = set()
for profile in profiles:
    pdir = profile / 'plugins'
    try:
        metadata = json.loads((pdir / '.install-metadata.json').read_text())
    except (OSError, ValueError):
        metadata = {}
    for plugin in sorted(pdir.glob('alans-way*')):
        if not plugin.is_dir():
            continue
        try:
            manifest = (plugin / 'plugin.yaml').read_text()
        except OSError:
            manifest = ''
        match = re.search(r'^version:\s*[\"\']?([^\"\'\s#]+)', manifest, re.M)
        print('Plugin:', plugin, 'version:', match.group(1) if match else '(unavailable)')
        entry = metadata.get(plugin.name, {}) if isinstance(metadata, dict) else {}
        if not isinstance(entry, dict):
            entry = {}
        print('metadata:', json.dumps(scrub({k: entry[k] for k in ('source', 'ref', 'catalog') if k in entry})))
        print('.hermes-catalog.json:', (plugin / '.hermes-catalog.json').is_file())
        clones.add(plugin)
        source = entry.get('source', '')
        if isinstance(source, str) and source.startswith('file://'):
            clones.add(pathlib.Path(source[7:].split('#')[0]))
clones.update(pathlib.Path(p) for p in sys.argv[1:])
clones.update([pathlib.Path('/opt/hermes-alans-way/browser'),
               pathlib.Path.home() / '.local/share/hermes-alans-way/app',
               pathlib.Path.home() / '.local/share/alans-way-agents'])
seen = set()
for clone in sorted(clones):
    if not (clone / '.git').exists() or clone.resolve() in seen:
        continue
    seen.add(clone.resolve())
    print('Git:', clone)
    git = ['git', '-c', 'core.fsmonitor=false', '-C', str(clone)]
    print('remote -v:', scrub(command(git + ['remote', '-v'])))
    print('describe --tags:', scrub(command(git + ['describe', '--tags'])))
    status = command(git + ['status', '--porcelain'])
    print('local changes:', len(status.splitlines()) if status and status != '(unavailable)' else status or 0)
    print('is-shallow-repository:', command(git + ['rev-parse', '--is-shallow-repository']))
PY
