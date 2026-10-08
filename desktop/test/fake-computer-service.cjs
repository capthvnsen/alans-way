// Preloaded with `node -r` so the connector's in-process computer driver is a marker, never a real helper.
const path = require('node:path');
for (const name of ['computer.cjs', 'vps-computer.cjs']) {
  const filename = path.join(__dirname, '..', 'src', name);
  const service = {
    apps: async () => [{ pid: 1, name: 'in-process-marker', agentDesktop: process.env.ALANS_WAY_AGENT_DESKTOP || '' }],
    snapshot: async () => ({ marker: 'in-process-marker' }),
    screenshot: async () => ({ image: '', marker: 'in-process-marker' }),
    menu: async () => ({ marker: 'in-process-marker' }),
    action: async () => ({ marker: 'in-process-marker' }),
  };
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { service, close() {} } };
}
