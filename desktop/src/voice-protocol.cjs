// The voice view runs on a privileged voice-app:// origin. A real secure
// scheme gives it getUserMedia, fetch, AudioWorklet and the Cache API — none of
// which file:// can reliably do — and COOP+COEP turn on crossOriginIsolated so
// onnxruntime-web can run multi-threaded WASM.
const fs = require('node:fs');
const path = require('node:path');

const SCHEME = 'voice-app';
const VOICE_PARTITION = 'persist:voice';
const ORIGIN = `${SCHEME}://app`;

function registerVoiceScheme() {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false } },
  ]);
}

const ROOT = path.join(__dirname, 'voice');
const NM = path.join(__dirname, '..', 'node_modules');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.map': 'application/json', '.css': 'text/css' };

// Real files only — model weights come from Hugging Face over HTTPS (the voice
// session's CSP allows exactly that one host) and land in the Cache API.
const ROUTES = new Map([
  ['/', () => path.join(ROOT, 'index.html')],
  ['/voice.js', () => path.join(ROOT, 'voice-page.bundle.js')],
  ['/worker.js', () => path.join(ROOT, 'voice-worker.bundle.js')],
]);
const PREFIX_DIRS = [
  ['/ort/', path.join(NM, 'onnxruntime-web', 'dist')],
  ['/ort-vad/', path.join(NM, '@ricky0123', 'vad-web', 'node_modules', 'onnxruntime-web', 'dist')],
  ['/vad/', path.join(NM, '@ricky0123', 'vad-web', 'dist')],
];

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: https://huggingface.co https://*.huggingface.co https://*.hf.co; media-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
};

function fileFor(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  const exact = ROUTES.get(pathname);
  if (exact) return exact();
  for (const [prefix, dir] of PREFIX_DIRS) {
    if (!pathname.startsWith(prefix)) continue;
    const name = pathname.slice(prefix.length);
    // Asset names are fixed package files — never a path.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
    return path.join(dir, name);
  }
  return null;
}

function installVoiceProtocol() {
  const { session } = require('electron');
  const voiceSession = session.fromPartition(VOICE_PARTITION);
  voiceSession.protocol.handle(SCHEME, async (request) => {
    if (new URL(request.url).host !== 'app') return new Response('not found', { status: 404 });
    const file = fileFor(request.url);
    if (!file) return new Response('not found', { status: 404 });
    let body;
    try { body = await fs.promises.readFile(file); } catch { return new Response('not found', { status: 404 }); }
    return new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  });
  // The app itself requests the mic — grant audio capture to the voice origin
  // and nothing else. Everything else on this session is denied.
  voiceSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'media' && details.requestingUrl.startsWith(`${ORIGIN}/`) &&
      (!Array.isArray(details.mediaTypes) || details.mediaTypes.every(type => type === 'audio')));
  });
  voiceSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    permission === 'media' && requestingOrigin === ORIGIN &&
    (!Array.isArray(details?.mediaTypes) || details.mediaTypes.every(type => type === 'audio')));
  return voiceSession;
}

module.exports = { registerVoiceScheme, installVoiceProtocol, VOICE_PARTITION, VOICE_URL: `${ORIGIN}/` };
