(function (root) {
  'use strict';

  // Ids are the chat surface names main already uses (usableSurfaces in shell-support.cjs).
  const GATEWAYS = Object.freeze([
    { id: 'telegram', label: 'Telegram' },
    { id: 'hermes-desktop', label: 'Hermes' },
    { id: 'native', label: 'Alan\'s Way' },
  ].map(Object.freeze));
  const labelOf = (id) => GATEWAYS.find((gateway) => gateway.id === id)?.label || id;

  // One row per bot, with the gateways it is connected on in the fixed gateway order. `bots` is already in
  // display order, so the rows keep it. count: bots with any gateway; found: those matching the search.
  function botRows({ bots, gateways = {}, search = '' }) {
    const needle = String(search).trim().toLowerCase();
    const connected = (bot) => GATEWAYS.filter((gateway) => (gateways[bot.id] ?? ['telegram']).includes(gateway.id)).map((gateway) => gateway.id);
    const all = bots.map((bot) => ({ bot, gateways: connected(bot) })).filter((row) => row.gateways.length);
    const rows = all.filter(({ bot }) => !needle || `${bot.name || ''} ${bot.username || ''}`.toLowerCase().includes(needle));
    return { rows, count: all.length, found: rows.length };
  }

  // "Unread in Telegram and Hermes": the text a screen reader gets in place of the stacked chips.
  function unreadLabel(ids) {
    const names = ids.map(labelOf);
    return names.length ? `Unread in ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}` : '';
  }

  // Remembers which gateway of each bot became unread last, so chips can stack oldest first and the most recent
  // paints on top. A gateway that is no longer unread is forgotten; its next unread counts as new.
  function createUnreadOrder() {
    const since = new Map();
    let counter = 0;
    return (botId, unread) => {
      const known = since.get(botId) || new Map(), next = new Map(unread.map((id) => [id, known.get(id) ?? ++counter]));
      if (next.size) since.set(botId, next); else since.delete(botId);
      return [...unread].sort((a, b) => next.get(a) - next.get(b));
    };
  }

  // Which gateway's preview the row shows: unread first (the newest unread leading), then the one on screen, then the rest.
  function previewOrder({ gateways, shown, unread }) {
    return [...new Set([...[...unread].reverse(), shown, ...gateways])].filter((id) => gateways.includes(id));
  }

  const exported = { GATEWAYS, labelOf, botRows, unreadLabel, createUnreadOrder, previewOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.GatewayList = exported;
})(typeof window === 'object' ? window : undefined);
