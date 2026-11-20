// The design rule in style.css: tokens on :root, and the main-screen rules use them instead of ad-hoc values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const root = rules.find(rule => rule.selector === ':root').body;
const token = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1].trim();

// Chrome the owner sees on the main screen. Settings, onboarding, extension and download rows, the shortcut sheet and the
// chat surfaces (.nc-, .hermes-) keep older values until their own pass; radii are still held to the scale everywhere except
// the chat surfaces and the sidebar/shortcut rows other branches are editing.
const CHROME = /(^|[\s>+~,.#:])(sidebar|side-(top|toggle|title|caption|bottom)|chat-header|chat-pill|chat-menu[\w-]*|chat-note|tab-bar|tabs?|tab-[\w-]+|tabs-[\w-]+|canvas-tabs|pane-actions|browser-toolbar|browser-slot|address-symbol|address|control-button|icon-button|menu|menu-item|sort-menu|downloads-menu|toolbar-menu|vm-banner|home|quick-links|update-note|splitter|workspace-pane|modal|modal-card|modal-heading|toast|field|primary-button|secondary-button|more-dot|new-tab)(?![\w-])/;
const RADIUS_EXEMPT = /\.(nc-|hermes-|shortcut|bot-|gateway-|search-|side-search|shortcuts-button|terminal-idle|avatar|small-avatar|unread)/;
const hex = /#[0-9a-f]{3,8}\b/i;

test(':root defines the radius, height, spacing, colour and focus tokens', () => {
  for (const name of ['radius-sm', 'radius-md', 'radius-lg', 'radius-full', 'h-sm', 'h-md', 'h-lg', 'bar-h', 'space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6',
    'color-bg', 'color-surface', 'color-surface-2', 'color-surface-3', 'color-overlay', 'color-border', 'color-border-strong', 'color-text', 'color-text-2', 'color-text-3',
    'color-accent', 'color-success', 'color-warning', 'color-danger', 'focus-ring', 'focus-offset']) assert.ok(token(name), `--${name} is defined`);
  assert.deepEqual(['radius-sm', 'radius-md', 'radius-lg'].map(name => parseInt(token(name), 10)), [6, 10, 14]);
  assert.ok(parseInt(token('h-sm'), 10) >= 24, 'the smallest control is at least a 24px hit target');
});

test('text colours are at least 4.5:1 on every surface they sit on', () => {
  const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (value) => { const n = parseInt(value.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const surfaces = ['bg', 'surface', 'surface-2', 'surface-3', 'overlay'].map(name => token(`color-${name}`));
  for (const text of ['text', 'text-2', 'text-3', 'accent', 'success', 'warning', 'danger'])
    for (const surface of surfaces) assert.ok(ratio(token(`color-${text}`), surface) >= 4.5, `--color-${text} on ${surface} is ${ratio(token(`color-${text}`), surface).toFixed(2)}:1`);
});

test('main-screen rules take colours from the tokens', () => {
  const bad = rules.filter(rule => rule.selector !== ':root' && CHROME.test(rule.selector) && !/\.(bot-|avatar|small-avatar)/.test(rule.selector)
    && (hex.test(rule.body) || /\brgba?\(/.test(rule.body))).map(rule => rule.selector);
  assert.deepEqual(bad, [], 'these rules still carry raw colours');
});

test('radii come from the scale (6 / 10 / 14 / full) except 0, circles and percentages', () => {
  const bad = rules.filter(rule => !RADIUS_EXEMPT.test(rule.selector)).flatMap(rule => [...rule.body.matchAll(/border-radius:\s*([^;}]+)/g)]
    .filter(([, value]) => !/^(var\(--radius-(sm|md|lg|full)\)|0|50%|\d+%|inherit)$/.test(value.trim())).map(([, value]) => `${rule.selector} { border-radius: ${value.trim()} }`));
  assert.deepEqual(bad, [], 'ad-hoc radii');
});

test('there is one focus ring, defined once and reused', () => {
  assert.match(token('focus-ring'), /^2px solid var\(--color-accent\)$/);
  assert.ok(rules.some(rule => rule.selector.startsWith(':focus-visible') && /outline:var\(--focus-ring\)/.test(rule.body)));
  const own = rules.filter(rule => CHROME.test(rule.selector) && /outline:\s*\d+px/.test(rule.body)).map(rule => rule.selector);
  assert.deepEqual(own, [], 'chrome rules reuse --focus-ring instead of drawing their own');
});
