(function (root) {
  'use strict';

  // Ids are the chat surface names main already uses (usableSurfaces in shell-support.cjs).
  const GATEWAYS = Object.freeze([
    { id: 'telegram', label: 'Telegram' },
    { id: 'hermes-desktop', label: 'Hermes' },
    { id: 'native', label: 'Alan\'s Way' },
  ].map(Object.freeze));

  // One row per bot per connected gateway. `bots` is already in display order, so each section keeps it.
  // count: distinct bots in the list; found: distinct bots matching the search.
  function gatewaySections({ bots, gateways = {}, search = '' }) {
    const needle = String(search).trim().toLowerCase();
    const connected = (bot, gateway) => (gateways[bot.id] ?? ['telegram']).includes(gateway.id);
    const matches = (bot) => !needle || `${bot.name || ''} ${bot.username || ''}`.toLowerCase().includes(needle);
    const sections = GATEWAYS
      .map((gateway) => ({ ...gateway, rows: bots.filter((bot) => connected(bot, gateway) && matches(bot)).map((bot) => ({ bot, gateway: gateway.id })) }))
      .filter((section) => section.rows.length);
    const distinct = (list) => new Set(list.map((bot) => bot.id)).size;
    return { sections, count: distinct(bots.filter((bot) => GATEWAYS.some((gateway) => connected(bot, gateway)))), found: distinct(sections.flatMap((section) => section.rows.map((row) => row.bot))) };
  }

  const exported = { GATEWAYS, gatewaySections };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.GatewayList = exported;
})(typeof window === 'object' ? window : undefined);
