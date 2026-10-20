// Only existing workspace bindings belong here. Region keys are deliberately
// separate from application menu accelerators; they never install global hooks.
(() => {
const ACCELERATORS = Object.freeze({ settings: 'CmdOrCtrl+,', 'open-file': 'CmdOrCtrl+O', 'new-tab': 'CmdOrCtrl+T', 'close-tab': 'CmdOrCtrl+W', reload: 'CmdOrCtrl+R' });
function shortcutReference(platform) {
  const mac = platform === 'darwin', mod = mac ? '⌘' : 'Ctrl';
  const chord = key => [[mod, key]];
  return {
    platform: mac ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux',
    groups: [
      { title: 'App shortcuts', note: 'Use the app menu from anywhere in the workspace. Close a dialog before opening Settings.', rows: [
        { id: 'settings', title: 'Settings', description: 'Open workspace settings.', keys: chord(','), search: 'preferences' },
        { id: 'new-tab', title: 'New browser tab', description: 'Open a local browser tab.', keys: chord('T') },
        { id: 'close-tab', title: 'Close local tab', description: 'Close the active local tab. Home stays available.', keys: chord('W'), requires: 'local-tab' },
        { id: 'reload', title: 'Reload local page', description: 'Reload the active local browser page.', keys: chord('R'), search: 'refresh', requires: 'local-tab' },
        { id: 'open-file', title: 'Open PDF', description: 'Choose a local PDF to open in a browser tab.', keys: chord('O'), search: 'file' },
      ] },
      { title: 'Browser & Telegram', note: 'Only while a local page or Telegram has keyboard focus.', rows: [
        { id: 'address', title: 'Focus browser address', description: 'Move focus to the workspace address field.', keys: chord('L'), search: 'url' },
      ] },
      { title: 'Agent list', note: 'Only while an agent’s Open button has focus. Moving focus does not select an agent.', rows: [
        { id: 'agent-move', title: 'Move between agents', description: 'Focus the previous or next agent; Home and End focus the first or last.', keys: [['↑'], ['↓'], ['Home'], ['End']], search: 'arrow up down' },
        { id: 'agent-open', title: 'Open focused agent', description: 'Select the focused agent and open its Telegram chat.', keys: [[mac ? '↩' : 'Enter'], ['Space']], search: 'return enter' },
        { id: 'agent-hide', title: 'Reach Hide agent', description: 'Tab from Open to Hide for that agent. Press Enter to hide it from the sidebar.', keys: [[mac ? '⇥' : 'Tab']], search: 'remove tab' },
      ] },
      { title: 'Browser tab strip', note: 'Only while a browser tab’s title button has focus.', rows: [
        { id: 'tab-move', title: 'Switch browser tabs', description: 'Activate the previous or next tab; Home and End activate the first or last.', keys: [['←'], ['→'], ['Home'], ['End']], search: 'arrow left right' },
        { id: 'tab-close', title: 'Close focused tab', description: 'Close that tab and move focus to its neighbor.', keys: [[mac ? '⌦' : 'Delete']], search: 'delete forward delete' },
      ] },
      { title: 'Search & dialogs', note: 'These keys belong to the focused search field or the frontmost dialog.', rows: [
        { id: 'search-result', title: 'Reach an agent search result', description: 'From agent search, focus the first matching agent.', keys: [['↓']], search: 'arrow down' },
        { id: 'search-close', title: 'Clear or close agent search', description: 'Clear a search first; press again when empty to close it.', keys: [['Esc']], search: 'escape' },
        { id: 'dialog-tab', title: 'Move within a dialog', description: 'Move forward or backward through available controls, staying inside the dialog.', keys: [[mac ? '⇥' : 'Tab'], [mac ? '⇧' : 'Shift', mac ? '⇥' : 'Tab']], search: 'shift tab focus' },
        { id: 'dialog-close', title: 'Close a dialog', description: 'Return to the opener. A busy update must finish before it can close.', keys: [['Esc']], search: 'escape dismiss' },
      ] },
    ],
  };
}
// Action searches use complete words in any order, without shared scope notes.
// Explicit keys (glyphs, key names, or "key" wording), modifiers and '+' must
// describe ONE displayed binding exactly. Prose and alternatives cannot supply
// keys. Plain "tab" keeps its useful action-noun meaning.
// Unknown query symbols are rejected rather than erased into a broader search.
const KEY_ALIASES = Object.freeze({
  '⌘': ' command ', '⌃': ' control ', '^': ' control ', '⌥': ' alt ',
  '⇧': ' shift ', '⇥': ' tab ', '↩': ' enter ', '↵': ' enter ', '⌦': ' delete ',
  '⎋': ' escape ', '␣': ' space ',
  '↑': ' arrowup ', '↓': ' arrowdown ', '←': ' arrowleft ', '→': ' arrowright ', ',': ' comma ',
});
const KEY_NAMES = new Set(['tab', 'enter', 'home', 'end', 'space', 'delete', 'backspace', 'escape', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
// Search-only wording for existing actions, also applied to catalogs already
// serialized by the preload. This does not add bindings or available commands.
const ACTION_ALIASES = Object.freeze({
  'close-tab': 'close browser tab', reload: 'refresh reload browser tab', 'tab-close': 'close browser tab',
});
function searchText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[⌘⌃^⌥⇧⇥↩↵⌦⎋␣↑↓←→,]/g, key => KEY_ALIASES[key])
    .replace(/\b(up|down|left|right)\s+arrow\b/g, 'arrow$1')
    .replace(/\barrow\s+(up|down|left|right)\b/g, 'arrow$1');
}
function searchTokens(text) {
  const aliases = { cmd: 'command', meta: 'command', ctrl: 'control', option: 'alt', esc: 'escape', return: 'enter', del: 'delete', spacebar: 'space', tabs: 'tab', agents: 'agent' };
  return (text.match(/[\p{L}\p{N}]+/gu) || []).map(token => aliases[token] || token);
}
function matchesShortcut(row, query) {
  if (!String(query || '').trim()) return true;
  const text = searchText(query);
  if (/[^\p{L}\p{N}\s+\-/.\u0027’]/u.test(text)) return false;
  const tokens = searchTokens(text);
  if (!tokens.length) return false;
  const keyWording = tokens.at(-1) === 'key';
  const keyTokens = searchTokens(text.replace(/\bforward\s+delete\b/g, 'delete'));
  const keys = keyWording ? keyTokens.slice(0, -1) : keyTokens;
  // "Delete tab" uses a verb and an object. Explicit markers below still make
  // "Delete+Tab", "Delete ⇥", and "Delete Tab key" binding-only queries.
  const deleteTabAction = /\bdelete\b/.test(text) && tokens.includes('tab');
  const namedKeys = !deleteTabAction && keys.every(key => KEY_NAMES.has(key)) && (keys.length > 1 || keys[0] !== 'tab');
  if (keyWording || namedKeys || /[⇥↩↵⌦⎋␣↑↓←→]/u.test(query) || text.includes('+') || tokens.some(token => ['command', 'control', 'alt', 'shift', 'fn', 'super', 'hyper', 'win'].includes(token))) {
    const chord = keys.slice().sort().join(' ');
    return row.keys.some(binding => searchTokens(searchText(binding.join(' '))).sort().join(' ') === chord);
  }
  const prose = [row.title, row.description, row.search, ACTION_ALIASES[row.id]].join(' ').replace(/,/g, ' ');
  const words = new Set([...searchTokens(searchText(prose)), ...searchTokens(searchText(row.keys.flat().join(' ')))]);
  return tokens.every(token => words.has(token));
}
if (typeof module !== 'undefined' && module.exports) module.exports = { ACCELERATORS, shortcutReference, matchesShortcut };
else window.WorkspaceShortcuts = Object.freeze({ matchesShortcut });
})();
