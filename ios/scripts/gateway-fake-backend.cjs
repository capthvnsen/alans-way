#!/usr/bin/env node
'use strict';
// Runs the desktop's fake Hermes backend (sign-in, tickets, the WebSocket gateway) on loopback for the iOS app and its
// integration test. Fake data only: no real Hermes, VM or credentials are involved, and any username/password signs in.
//
//   node ios/scripts/gateway-fake-backend.cjs [--whole] [--delta-ms N] [--port N] [--control-port N]
//
// Prints one JSON line {"url","control"}. The control server is plain HTTP on loopback:
//   GET /drop     close every WebSocket (the app should reconnect and resume)
//   GET /restart  a Hermes restart: new epoch, every runtime session gone
//   GET /stop     shut down
const http = require('node:http');
const path = require('node:path');
const { fakeBackend } = require(path.join(__dirname, '../../desktop/test/hermes-auth-fake-backend.cjs'));

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const whole = process.argv.includes('--whole');
const deltaMs = Number(arg('--delta-ms', 0));

const REPLY = [
  'Here is a small example:',
  '',
  '```python',
  'def greet(name):',
  '    return f"Hello, {name}!"',
  '',
  'print(greet("Alan"))',
  '```',
  '',
  'It uses an **f-string**, and `greet` returns the text.',
].join('\n');
// The reply streams as words so a drop mid-reply has something to resume.
const wordsOf = (text) => text.match(/\S+\s*/g) || [text];

(async () => {
  const be = await fakeBackend({
    tokenTag: 'ios', epoch: 'fake-epoch-1', deltaMs: 0, wholeReply: whole,
    tokens: (text) => wordsOf(/code|example/i.test(text) ? REPLY : `You said: ${text}`),
    sessions: [
      { id: 'sess-1', session_key: 'key-1', title: 'Planning the week', profile: 'default' },
      { id: 'sess-2', session_key: 'key-2', title: 'Release notes', profile: 'default' },
    ],
  });
  // Seed history through the engine itself so row ids and timestamps are real.
  const engine = be.engine;
  const seed = (peer, session, text) => new Promise((resolve) => {
    const done = (frame) => { if (frame.method === 'event' && frame.params.type === 'message.complete' && frame.params.session_id === session) resolve(); };
    peer.send = done;
    engine.handle(peer, { method: 'prompt.submit', params: { session_id: session, text } });
  });
  const peer = engine.connect(() => {});
  engine.handle(peer, { method: 'session.activate', params: { session_id: 'sess-1' } });
  engine.handle(peer, { method: 'session.activate', params: { session_id: 'sess-2' } });
  await seed(peer, 'sess-1', 'What is on for Monday?');
  await seed(peer, 'sess-1', 'Show me an example of a greeting function in code');
  await seed(peer, 'sess-2', 'Draft the release notes headline');
  engine.disconnect(peer);
  be.cfg.deltaMs = deltaMs; // seeded instantly; replies to the app arrive at the requested pace

  const control = http.createServer((req, res) => {
    res.end('ok');
    if (req.url === '/drop') be.dropSockets();
    else if (req.url === '/restart') be.restart();
    else if (req.url === '/stop') be.close().then(() => process.exit(0));
  });
  await new Promise((r) => control.listen(Number(arg('--control-port', 0)), '127.0.0.1', r));
  console.log(JSON.stringify({ url: be.url, control: `http://127.0.0.1:${control.address().port}` }));
  process.on('SIGTERM', () => be.close().then(() => process.exit(0)));
})();
