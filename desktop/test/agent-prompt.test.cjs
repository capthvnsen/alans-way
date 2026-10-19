const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildAgentPrompt } = require('../src/agent-prompt.cjs');
const { createConfig } = require('../electron-builder.cjs');

const base = { hostLabel: 'mac', version: '0.3.0', timezone: 'America/Chicago' };
const canonical = fs.readFileSync(path.join(__dirname, '../../docs/setup-prompt.md'), 'utf8').match(/<!-- clipboard-prompt -->\s*```text\n([\s\S]*?)\n```/)[1];

test('setup prompt copies the canonical skill handoff and computer facts before web extraction', () => {
  const text = buildAgentPrompt(base);
  assert.ok(text.startsWith(canonical.replace('<Mac | Windows PC | Linux computer>', 'Mac (Apple Silicon)')));
  assert.match(text, /skill_view\(name="alans-way:workspace-setup"\)/);
  assert.match(text, /alans-way\/skills\/workspace-setup\/SKILL\.md/);
  assert.match(text, /Mac \(Apple Silicon\)/);
  assert.match(text, /version 0\.3\.0/);
  assert.match(text, /America\/Chicago/);
  assert.doesNotMatch(text, /BOT_ID|MAC_SSH/);
});
test('setup prompt and computer facts fit in one Telegram message', () => {
  const text = buildAgentPrompt({ ...base, hostLabel: 'linux', botId: '1234567890', sshHost: 'macuser@computer.tailnet-example.ts.net' });
  assert.ok(text.length <= 4096, `setup prompt is ${text.length} characters`);
});
test('copied setup prompt requires the bot to run setup and stop on guide gaps', () => {
  const text = buildAgentPrompt(base).replace(/\s+/g, ' ');
  for (const instruction of [
    "Run the skill's pinned server setup command yourself through your terminal tool",
    'gateway restart is detached and delayed by design',
    'running setup from inside this gateway is supported',
    'Do not hand the server setup command to me or ask me to run it in an SSH shell',
    'Before running the command that schedules the restart',
    'back in about a minute',
    'start no further tool calls in that turn',
    'On my next message, follow its post-restart audit',
    'If web extraction of a guide fails, has gaps or is incomplete, stop and report it',
    'Do not continue setup or fill in missing instructions',
  ]) assert.ok(text.includes(instruction), `missing instruction: ${instruction}`);
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
test('update prompt continues to delegate to its live document', () => {
  const text = buildAgentPrompt({ ...base, kind: 'update', botId: '1', sshHost: 'a@b' });
  assert.doesNotMatch(text, /\s--[a-z]|step \d|\/Applications|AppData/i);
});
test('packaged setup prompt uses the same published source outside the checkout', () => {
  const resource = createConfig({}).extraResources.find((item) => item.to === 'setup-prompt.md');
  assert.ok(resource, 'the canonical setup document must ship in every app package');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-prompt-'));
  try {
    const resources = path.join(tmp, 'resources');
    const source = path.join(resources, 'app', 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '..', resource.from), path.join(resources, resource.to));
    fs.copyFileSync(path.join(__dirname, '../src/agent-prompt.cjs'), path.join(source, 'agent-prompt.cjs'));
    const output = execFileSync(process.execPath, ['-e',
      `process.resourcesPath = ${JSON.stringify(resources)}; process.stdout.write(require(${JSON.stringify(path.join(source, 'agent-prompt.cjs'))}).buildAgentPrompt(${JSON.stringify(base)}));`,
    ], { cwd: tmp, encoding: 'utf8' });
    assert.equal(output, buildAgentPrompt(base));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('Settings and the wizard request the same main-process setup prompt', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const wizard = renderer.slice(renderer.indexOf("} else if (onboardingStep === 2)"), renderer.indexOf('Finish the connection'));
  assert.match(wizard, /command\('agent-prompt', \{ botId: state.selectedBotId, copy: false \}\)/);
  assert.match(wizard, /command\('agent-prompt', \{ botId: state.selectedBotId \}\)/);
  const settings = renderer.slice(renderer.indexOf('function showSettings('));
  assert.match(settings, /let reviewedBotId = state\.selectedBotId \|\|/);
  assert.match(settings, /const id = reviewedBotId[\s\S]*?return api\.command\(name, \{ botId: id, \.\.\.\(kind \? \{ kind \} : \{\}\) \}\);/);
  assert.match(settings, /prompt\.onclick = \(\) => copy\(prompt, promptStatus, 'agent-prompt'\);/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const handler = main.slice(main.indexOf("case 'agent-prompt':"), main.indexOf("case 'test-agent-path':"));
  assert.match(handler, /const text = buildAgentPrompt\(/);
  assert.match(handler, /if \(value\?\.copy !== false\) clipboard.writeText\(text\);\s*return text;/);
});
