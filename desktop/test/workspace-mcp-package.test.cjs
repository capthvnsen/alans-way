const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.join(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const desktop = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
const entry = manifest.bin['workspace-mcp'];

// execFile rejects on a nonzero exit, and health must report through its exit code.
const run = (script, args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code : 0, stdout, stderr }));
});

function standaloneCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-mcp-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['package.json', ...manifest.files]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.symlinkSync(path.join(root, 'desktop/node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

test('the manifest names the binary, pins the app SDK and refuses accidental publishing', () => {
  assert.equal(manifest.name, 'alans-way-workspace-mcp');
  assert.equal(entry, 'desktop/scripts/browser-mcp.cjs');
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], desktop.dependencies['@modelcontextprotocol/sdk']);
  assert.ok(fs.readFileSync(path.join(root, entry), 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('every module the server can load is shipped, and nothing from the app', () => {
  const pending = [entry];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    // String paths catch browser-mcp's per-OS `localDriver`, which require() takes as a variable.
    for (const [, target] of source.matchAll(/['"](\.\.?\/[\w./-]+\.cjs)['"]/g)) {
      const resolved = path.posix.join(path.posix.dirname(file), target);
      if (fs.existsSync(path.join(root, resolved))) pending.push(resolved);
    }
  }
  assert.deepEqual([...seen].filter((file) => !manifest.files.includes(file)), []);
  for (const helper of ['desktop/scripts/mac-computer.swift', 'desktop/scripts/vps-computer.py'])
    assert.ok(manifest.files.includes(helper), helper);
  for (const file of manifest.files) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
    assert.doesNotMatch(file, /main\.cjs|renderer|preload|\/test\//);
  }
});

test('--version prints the manifest version without a bot id or connection', async (t) => {
  const result = await run(path.join(standaloneCopy(t), entry), ['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `workspace-mcp ${manifest.version}\n`);
});

test('the shipped files alone serve the tools and report the same version', async (t) => {
  const client = new Client({ name: 'package-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(standaloneCopy(t), entry), '--bot-id', 'package-test'],
    stderr: 'ignore',
  }));
  t.after(() => client.close());
  assert.deepEqual(client.getServerVersion(), { name: 'hermes-cua-alans-way', version: manifest.version });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['cua_alans_way_status', 'workspace_computer_snapshot']) assert.ok(names.includes(name), name);
});

test('--health exits 0 and omits the token when the host answers', async (t) => {
  const token = 'synthetic-connection-token';
  const seen = [];
  const host = http.createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization, bot: request.headers['x-hermes-bot'] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ capabilities: ['computer'], secretField: token }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  t.after(() => host.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-mcp-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const connection = path.join(dir, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token, botId: 'health-test' }));

  const result = await run(path.join(root, entry), ['--bot-id', 'health-test', '--connection', connection, '--health']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, version: manifest.version, node: process.version, capabilities: ['computer'] });
  assert.ok(!(result.stdout + result.stderr).includes(token));
  assert.deepEqual(seen, [{ url: '/v1/status', auth: `Bearer ${token}`, bot: 'health-test' }]);
});

test('--health exits 1 with a reason when no host is available', async () => {
  const result = await run(path.join(root, entry), ['--bot-id', 'health-test', '--health'], {
    HERMES_WORKSPACE_CONNECTION: path.join(os.tmpdir(), 'workspace-mcp-no-such-connection.json'),
  });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.version, manifest.version);
  assert.match(report.error, /start its app or browser host/);
});

test('--health keeps the bot id requirement the server has', async () => {
  const result = await run(path.join(root, entry), ['--health']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--bot-id/);
});

test('the docs carry the install command and a snippet for each client', () => {
  const docs = fs.readFileSync(path.join(root, 'docs/cu-mcp.md'), 'utf8');
  for (const text of ['npm install -g github:capthvnsen/alans-way', 'mcp_servers:', 'mcpServers', 'claude mcp add', 'workspace-mcp --version', '--health'])
    assert.ok(docs.includes(text), text);
});
