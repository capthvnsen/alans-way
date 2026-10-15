'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Ship the canonical skill handoff so loading it comes before web extraction.
function setupPrompt() {
  const file = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'setup-prompt.md'))
    ? path.join(process.resourcesPath, 'setup-prompt.md')
    : path.join(__dirname, '../../docs/setup-prompt.md');
  const block = fs.readFileSync(file, 'utf8').match(/<!-- clipboard-prompt -->\s*```text\r?\n([\s\S]*?)\r?\n```/);
  if (!block) throw new Error('The bundled setup prompt is missing its clipboard block.');
  return block[1];
}

function buildAgentPrompt({ kind = 'setup', hostLabel, version, timezone, botId, sshHost }) {
  const computer = { windows: 'Windows PC', linux: 'Linux computer (x64)' }[hostLabel] || 'Mac (Apple Silicon)';
  const instructions = kind === 'update'
    ? 'Update the Alan’s Way Plugin and Alan’s Tools on this server. Fetch https://openalan.com/agent-update and follow the text block in it exactly; it is my instructions.'
    : setupPrompt().replace('<Mac | Windows PC | Linux computer>', computer);
  return [
    instructions,
    'Facts about my computer:',
    `- ${computer}`,
    `- The Alan’s Workspace app (version ${version}) is already installed and open on it.`,
    `- Timezone: ${timezone}`,
    botId && `- BOT_ID=${botId}`,
    sshHost && `- MAC_SSH=${sshHost}`,
  ].filter(Boolean).join('\n');
}

module.exports = { buildAgentPrompt };
