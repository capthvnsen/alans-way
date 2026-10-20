#!/usr/bin/env node
// Local-only evidence viewer. Private screenshots and reports stay in evidence/.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'evidence/quality');
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host?.toLowerCase())) {
    res.writeHead(403); res.end('Use the local progress address'); return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file;
    if (pathname === '/') file = path.join(root, 'docs/quality/progress.html');
    else if (pathname === '/data.json') file = path.join(evidence, 'progress.json');
    else if (pathname.startsWith('/evidence/')) {
      file = await fs.realpath(path.join(evidence, pathname.slice('/evidence/'.length)));
      const realEvidence = await fs.realpath(evidence);
      if (!file.startsWith(realEvidence + path.sep)) throw new Error('outside evidence');
    } else { res.writeHead(404); res.end('Not found'); return; }
    const type = types[path.extname(file)];
    if (!type) { res.writeHead(404); res.end('Not found'); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404); res.end('Evidence not available yet');
  }
});
server.listen(Number(process.env.QUALITY_PORT || 5057), '127.0.0.1', () => {
  console.log(`Alan's Way progress: http://127.0.0.1:${server.address().port}`);
});
