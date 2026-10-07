const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentPrompt } = require('../src/agent-prompt.cjs');

const base = { hostLabel: 'mac', version: '0.3.0', timezone: 'America/Chicago' };

test('setup prompt points at the evergreen URL and states facts', () => {
  const text = buildAgentPrompt(base);
  assert.match(text, /https:\/\/openalan\.com\/agent-prompt/);
  assert.match(text, /Mac \(Apple Silicon\)/);
  assert.match(text, /version 0\.3\.0/);
  assert.match(text, /America\/Chicago/);
  assert.doesNotMatch(text, /BOT_ID|MAC_SSH/);
});
test('known values are included only when given', () => {
  const text = buildAgentPrompt({ ...base, hostLabel: 'windows', botId: '123', sshHost: 'me@pc' });
  assert.match(text, /Windows PC/);
  assert.match(text, /BOT_ID=123/);
  assert.match(text, /MAC_SSH=me@pc/);
});
test('a Linux computer is named as one', () => {
  assert.match(buildAgentPrompt({ ...base, hostLabel: 'linux' }), /Linux computer/);
});
test('update prompt points at the update URL', () => {
  assert.match(buildAgentPrompt({ ...base, kind: 'update' }), /https:\/\/openalan\.com\/agent-update/);
});
test('prompts never carry steps, flags or paths', () => {
  for (const kind of ['setup', 'update']) {
    const text = buildAgentPrompt({ ...base, kind, botId: '1', sshHost: 'a@b' });
    assert.doesNotMatch(text, /\s--[a-z]|step \d|\/Applications|AppData/i);
  }
});
