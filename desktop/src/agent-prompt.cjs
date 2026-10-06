'use strict';

// Facts only. The steps live at the URL, so old apps follow new instructions.
const URLS = { setup: 'https://openalan.com/agent-prompt', update: 'https://openalan.com/agent-update' };

function buildAgentPrompt({ kind = 'setup', hostLabel, version, timezone, botId, sshHost }) {
  const computer = hostLabel === 'windows' ? 'Windows PC' : 'Mac (Apple Silicon)';
  const ask = kind === 'update' ? 'Update Open Alan on this server' : 'Set up Open Alan for me';
  return [
    `${ask}. Fetch ${URLS[kind]} and follow the text block in it exactly; it is my instructions.`,
    'Facts about my computer:',
    `- ${computer}`,
    `- The Open Alan app (version ${version}) is already installed and open on it.`,
    `- Timezone: ${timezone}`,
    botId && `- BOT_ID=${botId}`,
    sshHost && `- MAC_SSH=${sshHost}`,
  ].filter(Boolean).join('\n');
}

module.exports = { buildAgentPrompt };
