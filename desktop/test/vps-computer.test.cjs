const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '../scripts/vps-computer.py');

test('the Linux desktop helper compiles', () => {
  const result = spawnSync('python3', ['-m', 'py_compile', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the Linux desktop helper passes its pure-logic selftest without a display', () => {
  const result = spawnSync('python3', [script, 'selftest'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true);
  assert.ok(reply.checks >= 15);
});

test('once answers a bad request with a coded failure', () => {
  const result = spawnSync('python3', [script, 'once'], { encoding: 'utf8', input: '{"id":3,"cmd":"bogus"}\n' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'unknown command bogus', code: 'bad_request', id: 3 });
  const junk = spawnSync('python3', [script, 'once'], { encoding: 'utf8', input: 'nope\n' });
  assert.equal(JSON.parse(junk.stdout).code, 'bad_request');
});

test('serve answers each line in order and exits on EOF', async () => {
  const child = spawn('python3', [script, 'serve'], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stdin.write('{"id":1,"cmd":"init","policy":{"exact":["keepassxc"],"contains":["1password"]}}\n');
  child.stdin.write('garbage\n');
  child.stdin.write('{"id":"a","cmd":"selftest"}\n');
  child.stdin.write('{"id":2,"cmd":"act","pid":0,"steps":[{"action":"press","ref":"c1"}]}\n');
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const lines = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], { ok: true, protocol: 2, id: 1 });
  assert.equal(lines[1].code, 'bad_request');
  assert.equal(lines[2].ok, true);
  assert.equal(lines[2].id, 'a');
  assert.equal(lines[3].id, 2);
  assert.equal(lines[3].code, 'not_found');
});

// Screenshots must work on a minimal X11 box: no ImageMagick, only whichever
// of scrot, xwd+netpbm, Pillow or ffmpeg the image ships. Stub tools sit on a
// restricted PATH so the choice of tool is hermetic on every test host.
const python = spawnSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const driver = `
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location('vc', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    data, size = m.capture(sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4]))
    print(json.dumps({'ok': True, 'size': list(size), 'head': data[:2].hex()}))
except Exception as exc:
    print(json.dumps({'ok': False, 'error': str(exc), 'code': getattr(exc, 'code', 'crash')}))
`;
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_STUB = Buffer.concat([Buffer.from('ffd8ffc000110800100020', 'hex'), Buffer.alloc(13)]);

function toolDir(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-tools-'));
  fs.writeFileSync(path.join(dir, 'canned.png'), Buffer.from(PNG_1PX, 'base64'));
  fs.writeFileSync(path.join(dir, 'canned.jpg'), JPEG_STUB);
  fs.writeFileSync(path.join(dir, 'canned.xwd'), Buffer.from('not a real xwd file'));
  fs.writeFileSync(path.join(dir, 'canned.pnm'), Buffer.concat([Buffer.from('P6\n2000 10\n255\n'), Buffer.alloc(60000, 128)]));
  for (const [name, source] of Object.entries(tools)) {
    fs.writeFileSync(path.join(dir, name), `#!${python}\nimport os, sys\nopen(os.environ['STUB_MARKER'], 'a').write('${name} ' + ' '.join(sys.argv[1:]) + '\\n')\n${source}\n`, { mode: 0o755 });
  }
  return { dir, env: { PATH: dir, DIR: dir, STUB_MARKER: path.join(dir, 'marker'), HOME: os.tmpdir() } };
}
function runCapture(dir, env) {
  const result = spawnSync(python, ['-c', driver, script, '42', '960', '{"X":"10","Y":"20","WIDTH":"640","HEIGHT":"400"}'], { encoding: 'utf8', env });
  return { result, reply: JSON.parse(result.stdout.trim().split('\n').pop()) };
}
const readStub = (name) => `sys.stdout.buffer.write(open(os.path.join(os.environ['DIR'], ${JSON.stringify(name)}), 'rb').read())`;
const writeToArg = 'open(sys.argv[-1], "wb").write(open(os.environ["CANNED"], "rb").read())';

test('capture falls back to scrot when ImageMagick is absent', () => {
  const { dir, env } = toolDir({
    scrot: writeToArg,
    ffmpeg: readStub('canned.jpg'),
  });
  env.CANNED = path.join(dir, 'canned.png');
  const { result, reply } = runCapture(dir, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.head, 'ffd8', 'the reply is a JPEG either way the stub PNG was converted');
  assert.ok(reply.size[0] > 0 && reply.size[1] > 0, 'jpeg dimensions are reported');
  const marker = fs.readFileSync(path.join(dir, 'marker'), 'utf8');
  assert.match(marker, /scrot -a 10,20,640,400/, `the window rectangle went to scrot: ${marker}`);
  assert.doesNotMatch(marker, /import/, 'ImageMagick is never invoked when absent');
});

test('capture falls back to xwd plus netpbm, scaling wide windows', () => {
  const { dir, env } = toolDir({
    xwd: readStub('canned.xwd'),
    xwdtopnm: readStub('canned.pnm'),
    pnmscale: `data = sys.stdin.buffer.read()\nsys.stdout.buffer.write(data)`,
    pnmtojpeg: readStub('canned.jpg'),
  });
  const { result, reply } = runCapture(dir, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.head, 'ffd8');
  assert.deepEqual(reply.size, [32, 16], 'the netpbm stub jpeg reports its own size');
  const marker = fs.readFileSync(path.join(dir, 'marker'), 'utf8');
  assert.match(marker, /xwd -silent -id 42/, `the window id went to xwd: ${marker}`);
  assert.match(marker, /pnmscale -width 960/, 'the 2000px window is scaled to the cap');
});

test('capture reports a coded failure when no capture tool exists', () => {
  const { dir, env } = toolDir({});
  const { reply } = runCapture(dir, env);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Could not capture that window/);
});
