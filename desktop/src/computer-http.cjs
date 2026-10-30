'use strict';
const { calls, context, READ_BUDGET_MS } = require('./call-budget.cjs');

function createComputerRoutes({ hostComputer, desktopLease, desktopApproval, nameForBot, readJson, intParam, identityFor }) {
  return async (req, res, url, botId, send) => {
    const computerMatch = /^\/v1\/computer\/(apps|launch|\d{1,10})(?:\/(snapshot|screenshot|action|menu))?$/.exec(url.pathname);
    if (!computerMatch) return false;
    if (!botId || botId.length > 100) { send(400, { error: 'X-Hermes-Bot is required and must be at most 100 characters.' }); return true; }
    const identity = identityFor?.(req, botId);
    let agentName = nameForBot(botId);
    if (!agentName) try { agentName = decodeURIComponent(String(req.headers['x-hermes-bot-name'] || '')).replace(/\p{C}/gu, '').slice(0, 80); } catch { /* the bot ID names it instead */ }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    await calls.run(context(req.headers['x-alans-way-remaining-ms'] === undefined ? undefined : Number(req.headers['x-alans-way-remaining-ms']), controller.signal, req.method === 'GET' ? READ_BUDGET_MS : Infinity), async () => {
      if (!hostComputer) return send(400, { error: 'Computer use is not available on this host.' });
      if (computerMatch[1] === 'apps') {
        if (computerMatch[2] || req.method !== 'GET') return send(405, { error: 'Use GET /v1/computer/apps.' });
        return send(200, { apps: await hostComputer.apps() });
      }
      if (computerMatch[1] === 'launch') {
        if (computerMatch[2] || req.method !== 'POST') return send(405, { error: 'Use POST /v1/computer/launch.' });
        if (!hostComputer.launch) return send(400, { error: 'Opening an app by name is only supported on Mac.' });
        const body = await readJson(req);
        const refused = await desktopApproval?.check(botId, agentName, identity);
        if (refused) return send(403, refused);
        const busy = desktopLease?.take(botId, agentName);
        if (busy) return send(409, busy);
        try { return send(200, await hostComputer.launch(body.app, body.path)); }
        finally { desktopLease?.release(botId); }
      }
      const pid = Number(computerMatch[1]);
      if (!Number.isInteger(pid) || pid < 0) return send(400, { error: 'App pid must be a non-negative integer.' });
      if (req.method === 'GET' && computerMatch[2] === 'snapshot')
        return send(200, await hostComputer.snapshot(botId, pid, { since: intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER), delta: url.searchParams.get('delta') === '1', menubar: url.searchParams.get('menubar') === '1', windowId: intParam(url, 'windowId', 1, 0xffffffff) }));
      if (req.method === 'GET' && computerMatch[2] === 'screenshot')
        return send(200, await hostComputer.screenshot(pid, intParam(url, 'maxWidth', 1, 10000), { windowId: intParam(url, 'windowId', 1, 0xffffffff), bot: botId }));
      if (req.method === 'GET' && computerMatch[2] === 'menu') {
        let menuPath; try { menuPath = JSON.parse(url.searchParams.get('path') || '[]'); } catch { throw Object.assign(new Error('path must be a JSON array of menu titles.'), { status: 400 }); }
        const busy = desktopLease?.take(botId, agentName);
        if (busy) return send(409, busy);
        try { return send(200, await hostComputer.menu(pid, menuPath)); }
        finally { desktopLease?.release(botId); }
      }
      if (req.method === 'POST' && computerMatch[2] === 'action') {
        const body = await readJson(req);
        const refused = await desktopApproval?.check(botId, agentName, identity);
        if (refused) return send(403, refused);
        const busy = desktopLease?.take(botId, agentName);
        if (busy) return send(409, busy);
        try { return send(200, await hostComputer.action(botId, pid, body)); }
        finally { desktopLease?.release(botId); }
      }
      return send(405, { error: 'Method not supported.' });
    });
    return true;
  };
}
module.exports = { createComputerRoutes };
