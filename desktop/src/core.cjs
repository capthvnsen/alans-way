const crypto = require('node:crypto');

function normalizeUrl(value) {
  const input = String(value || '').trim();
  if (!input) return 'about:blank';
  if (input === 'about:blank') return input;
  let url;
  if (/^https?:\/\//i.test(input)) url = new URL(input);
  else if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input) && (input.includes('.') || /^localhost(?::|$)/.test(input))) {
    url = new URL(`http${/^localhost(?::|$)|^127\./.test(input) ? '' : 's'}://${input}`);
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) throw new Error('Only http and https pages are supported.');
    url = new URL(`https://www.google.com/search?q=${encodeURIComponent(input)}`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid browser URL.');
  return url.href;
}

function parseRemoteUrl(value) {
  if (!value) return '';
  const url = new URL(String(value));
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an http(s) noVNC URL or ws(s) desktop connection.');
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const remotePath = url.searchParams.get('path') || 'websockify';
    const prefix = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    url.pathname = remotePath.startsWith('/') ? remotePath : `${prefix}${remotePath}`;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
  }
  url.hash = '';
  return url.href;
}

function requireActor(tab, botId, epoch, mutate = false) {
  if (!botId || typeof botId !== 'string' || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
  if (tab.botId !== botId && !(tab.allowedBots || []).includes(botId)) {
    throw Object.assign(new Error('This tab belongs to a different bot.'), { status: 403 });
  }
  if (mutate && tab.controller !== 'agent') throw Object.assign(new Error('human_has_control'), { status: 409 });
  if (mutate && epoch !== tab.epoch) throw Object.assign(new Error('stale_control_epoch: read the tab state and retry after a fresh snapshot.'), { status: 409 });
}

function isAuthorized(header, token) {
  const input = Buffer.from(String(header || '').replace(/^Bearer /, ''));
  const expected = Buffer.from(token);
  return input.length === expected.length && crypto.timingSafeEqual(input, expected);
}

function sanitizeBots(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((bot) => bot && /^\d{1,20}$/.test(String(bot.id)) && bot.isBot === true).slice(0, 1000).map((bot) => ({
    id: String(bot.id), isBot: true,
    name: String(bot.name || 'Telegram bot').slice(0, 100),
    username: String(bot.username || '').replace(/[^\w]/g, '').slice(0, 40),
    preview: String(bot.preview || '').slice(0, 120),
    unread: Math.max(0, Math.min(9999, Number(bot.unread) || 0)),
    avatar: typeof bot.avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(bot.avatar) && bot.avatar.length < 150000 ? bot.avatar : '',
  }));
}

module.exports = { normalizeUrl, parseRemoteUrl, requireActor, isAuthorized, sanitizeBots };
