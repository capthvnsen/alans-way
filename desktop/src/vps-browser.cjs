const { spawn } = require('node:child_process');
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
function createVpsBrowser({ getConfig }) {
  async function request(route, method = 'GET', body, { botId = '', botName = '', human = false, epoch } = {}) {
    const cfg = getConfig();
    if (!cfg?.sshHost || !cfg.scriptPath) throw new Error('Configure the VPS browser connection in Settings.');
    if (
      !/^[a-zA-Z0-9][\w.@-]{0,150}$/.test(cfg.sshHost) ||
      !cfg.scriptPath.startsWith('/') ||
      /[\r\n\0]/.test(cfg.scriptPath)
    )
      throw new Error('Invalid VPS browser SSH settings.');
    const cmd = (cfg.sudo ? 'sudo -n ' : '') + 'node ' + quote(cfg.scriptPath) + ' request';
    return new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', cfg.sshHost, cmd],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '',
        size = 0,
        done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('VPS browser timed out. Inspect the task before retrying.'));
      }, route.endsWith('/actions') ? 87000 : 30000);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 12000000) {
          child.kill();
          finish(new Error('VPS response too large.'));
        } else output += chunk;
      });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(new Error('Unable to start the private VPS SSH connection.')));
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error('VPS browser SSH unavailable. Check Tailscale and saved SSH access.'));
        try {
          const response = JSON.parse(output);
          if (response.status >= 400) throw Object.assign(new Error(response.data.error), { status: response.status });
          finish(null, response.data);
        } catch (e) {
          finish(e);
        }
      });
      child.stdin.on('error', () => {}); // ssh may exit before reading the request — the close handler reports the real error
      child.stdin.end(JSON.stringify({ path: route, method, body, botId, botName, human, epoch }));
    });
  }
  return { request };
}
module.exports = { createVpsBrowser };
