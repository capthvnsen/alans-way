// Fixture site for cross-host-electron.cjs. Serve it on an address both the
// Mac and the VPS can reach, then pass that origin as HERMES_CROSS_HOST_FIXTURE:
//   node test/cross-host-fixture.cjs 100.64.0.1 8044
const http = require('node:http');
const [host = '127.0.0.1', port = '8044'] = process.argv.slice(2);
const escape = (value) => String(value).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const page = (title, cookies) => `<!doctype html><title>${title}</title>
<label>Task draft <input id="draft" aria-label="Task draft"></label>
<input id="password" type="password" aria-label="Password">
<button>Confirm once</button>
<p>cookies: ${escape(cookies || '')}</p>
<script>window.fixtureMemory = Math.random();</script>`;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const cookies = req.headers.cookie || '';
  if (url.pathname === '/set-cookie') {
    res.setHeader('Set-Cookie', `shared_fixture=${encodeURIComponent(url.searchParams.get('value') || '')}; Path=/`);
    return res.end(page('Cookie set', cookies));
  }
  if (url.pathname === '/needs-login' && !/(^|;\s*)mac_ready=1/.test(cookies)) {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page(url.pathname === '/login' ? 'Login' : 'Cross-host fixture', cookies));
}).listen(Number(port), host, () => console.log(`cross-host fixture on http://${host}:${port}`));
