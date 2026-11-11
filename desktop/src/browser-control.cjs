'use strict';

// The toolbar control names the next handoff. With no page, or no agent to
// receive a shared page, it stays "You" instead of offering an action that
// cannot happen.
function browserControlState({ tab, ownerName = '', recipientName = '', botCount = 0 } = {}) {
  if (!tab || tab.extensionPage || tab.localPdf) return { text: 'You', disabled: true };
  if (tab.controller === 'agent') return { text: 'Take over', disabled: false };
  if (tab.botId === 'shared') {
    if (!botCount) return { text: 'You', disabled: true };
    return { text: `Give to ${recipientName || 'agents'}`, disabled: false };
  }
  if (!ownerName) return { text: 'You', disabled: true };
  return { text: `Give to ${ownerName}`, disabled: false };
}

if (typeof module === 'object' && module.exports) module.exports = { browserControlState };
