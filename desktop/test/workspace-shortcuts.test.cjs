const test = require('node:test');
const assert = require('node:assert/strict');
const { shortcutReference, matchesShortcut } = require('../src/workspace-shortcuts.cjs');
const find = (query, platform = 'darwin') => shortcutReference(platform).groups.flatMap(group =>
  group.rows.filter(row => matchesShortcut(row, query)).map(row => row.id));

test('ordinary action searches match complete words in any order across each action', () => {
  assert.deepEqual(find('new tab'), ['new-tab']);
  assert.deepEqual(find('close tab'), ['close-tab', 'tab-close']);
  assert.deepEqual(find('focus address'), ['address']);
  assert.deepEqual(find('switch tabs'), ['tab-move']);
  assert.deepEqual(find('tab new'), ['new-tab']);
});
test('modifier names, separators and adjacent key glyphs describe the same chord', () => {
  for (const query of ['cmd+t', 'Command+T', '⌘T', 'command t']) assert.deepEqual(find(query), ['new-tab'], query);
  for (const query of ['cmd+,', 'command comma', '⌘,']) assert.deepEqual(find(query), ['settings'], query);
  assert.deepEqual(find('ctrl+t', 'win32'), ['new-tab']);
  assert.deepEqual(find('Control+T', 'linux'), ['new-tab']);
  assert.deepEqual(find('cmd+t', 'win32'), []);
  assert.deepEqual(find('ctrl+t', 'darwin'), []);
});
test('DOM arrow names, spoken directions and glyphs have equivalent matches', () => {
  for (const query of ['ArrowDown', 'down arrow', 'arrow down', '↓']) assert.deepEqual(find(query), ['agent-move', 'search-result'], query);
  for (const query of ['shift tab', 'Shift+Tab', '⇧⇥']) assert.deepEqual(find(query), ['dialog-tab'], query);
  assert.deepEqual(find('ArrowRight'), ['tab-move']);
  assert.deepEqual(find('return to opener'), ['dialog-close']);
});
test('shared scope notes and word substrings do not invent matches', () => {
  assert.deepEqual(find('comma'), ['settings']);
  assert.deepEqual(find('settings'), ['settings']);
  for (const query of ['com', 'command+q', 'command+shift+t', 'nonesuch-zqv']) assert.deepEqual(find(query), [], query);
  assert.equal(find('').length, 15);
});

test('modifier glyphs and names retain platform meaning instead of falling out of a query', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const command = platform === 'darwin';
    for (const query of ['⌘T', 'Command+T', 'cmd t', 'Meta+T'])
      assert.deepEqual(find(query, platform), command ? ['new-tab'] : [], `${platform}: ${query}`);
    for (const query of ['⌃T', '^T', 'Control+T', 'ctrl t'])
      assert.deepEqual(find(query, platform), command ? [] : ['new-tab'], `${platform}: ${query}`);
    for (const query of ['⌃,', '^,', 'Ctrl+Comma'])
      assert.deepEqual(find(query, platform), command ? [] : ['settings'], `${platform}: ${query}`);
    for (const query of ['⌘,', 'Command+,', 'cmd comma'])
      assert.deepEqual(find(query, platform), command ? ['settings'] : [], `${platform}: ${query}`);
    for (const query of ['⌥T', 'Alt+T', 'Option T', '⌘⌥T', '⌃⌥T', '⌘⌃T', '⌘⇧T', 'Ctrl+Shift+T', 'Fn+T', '⌘🌐T'])
      assert.deepEqual(find(query, platform), [], `${platform}: ${query}`);
  }
});

test('a chord is one complete displayed binding, never a union with prose or another binding', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const modifier = platform === 'darwin' ? 'command' : 'control';
    for (const key of ['Home', 'End', 'Tab', 'Enter', 'Space', 'Delete', 'ArrowDown'])
      for (const separator of [' ', '+'])
        assert.deepEqual(find(`${modifier}${separator}${key}`, platform), [], `${platform}: ${modifier}${separator}${key}`);
    for (const query of ['Shift+Tab', 'tab shift', '⇧⇥', 'Shift ⇥'])
      assert.deepEqual(find(query, platform), ['dialog-tab'], query);
    for (const query of ['Shift+Enter', '⇧↩', 'Shift+Home', 'Home+End', '↑+↓', 'Tab+Enter', 'command new tab', 'command+t+tab'])
      assert.deepEqual(find(query, platform), [], query);
  }
  const split = { title: 'Example Home tab', description: 'Control T', keys: [['⌘', 'T'], ['⇧', '⇥']] };
  assert.equal(matchesShortcut(split, 'command shift tab'), false);
  assert.equal(matchesShortcut(split, 'control t'), false);
  assert.equal(matchesShortcut(split, 'command home'), false);
  // The API can match genuine multi-modifier bindings; rejecting the reported
  // Option cases must follow the catalog, not a blanket ban on the modifier.
  const combined = { keys: [['⌃', '⌥', 'T'], ['Command', 'Shift', 'O']] };
  for (const query of ['⌃⌥T', 'Control+Option+T', 'alt ctrl t']) assert.equal(matchesShortcut(combined, query), true, query);
  for (const query of ['⇧⌘O', 'Command+Shift+O', 'shift meta o']) assert.equal(matchesShortcut(combined, query), true, query);
  for (const query of ['⌃T', '⌥T', '⌘⌥T', '⌃⌥⇧T', 'Control+Option+O']) assert.equal(matchesShortcut(combined, query), false, query);
});

test('all app accelerator keys use the displayed platform modifier without accepting extra modifiers', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const mac = platform === 'darwin';
    for (const [key, id] of [[',', 'settings'], ['T', 'new-tab'], ['W', 'close-tab'], ['R', 'reload'], ['O', 'open-file'], ['L', 'address']]) {
      for (const modifier of mac ? ['⌘', 'Command+', 'cmd '] : ['⌃', '^', 'Control+', 'ctrl '])
        for (const query of [modifier + key, `${modifier}${key} key`])
          assert.deepEqual(find(query, platform), [id], `${platform}: ${query}`);
      for (const modifier of mac ? ['⌃', '⌥', 'Control+', 'Alt+', '⌘⌥', '⌘⇧'] : ['⌘', '⌥', 'Command+', 'Option+', '⌃⌥', '⌃⇧'])
        for (const query of [modifier + key, `${modifier}${key} key`])
          assert.deepEqual(find(query, platform), [], `${platform}: ${query}`);
    }
  }
});

test('key spellings search actual keys and useful action wording retains whole-word order independence', () => {
  for (const query of ['reload tab', 'tab reload', 'refresh browser tab']) assert.deepEqual(find(query), ['reload'], query);
  for (const query of ['close browser tab', 'browser tab close']) assert.deepEqual(find(query), ['close-tab', 'tab-close'], query);
  for (const query of ['pdf open', 'open file', 'tab new', 'address focus'])
    assert.deepEqual(find(query), query.includes('pdf') || query.includes('file') ? ['open-file'] : query.includes('new') ? ['new-tab'] : ['address'], query);
  for (const query of ['Esc', 'Escape', '⎋']) assert.deepEqual(find(query), ['search-close', 'dialog-close'], query);
  for (const query of ['Delete', 'Del', '⌦', 'forward delete']) assert.deepEqual(find(query), ['tab-close'], query);
  for (const query of ['Space', 'Spacebar', '␣']) assert.deepEqual(find(query), ['agent-open'], query);
  for (const query of ['ArrowUp', 'up arrow', '↑']) assert.deepEqual(find(query), ['agent-move'], query);
  for (const query of ['ArrowLeft', 'left arrow', '←', 'ArrowRight', 'right arrow', '→']) assert.deepEqual(find(query), ['tab-move'], query);
  for (const query of ['com', 'wrongtab', 'agentlist', 'reopen tab', 'command+q']) assert.deepEqual(find(query), [], query);
});

test('nonempty punctuation and unknown symbols never become an empty all-actions query', () => {
  for (const query of ['!!', '???', '+', '---', '/', '⌥', '⌃', '^', '🌐', '⌫', '⌥!!', 'T🌐', 'Command+T!', '⌘T⌫', '⌘+'])
    assert.deepEqual(find(query), [], query);
  for (const query of ['', ' ', '\t\n']) assert.equal(find(query).length, 15, JSON.stringify(query));
});

test('an unmodified key glyph searches displayed bindings rather than prose', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const query of ['⇥', ' ⇥ ', '⇥ key'])
      assert.deepEqual(find(query, platform), ['agent-hide', 'dialog-tab'], `${platform}: ${query}`);
    for (const query of ['↩', '↵', '↩ key'])
      assert.deepEqual(find(query, platform), ['agent-open'], `${platform}: ${query}`);
  }
});

test('key names and key wording retain single-binding intent across platform aliases', () => {
  const cases = [
    [['Home', 'End'], ['agent-move', 'tab-move']],
    [['Enter', 'Return'], ['agent-open']],
    [['Space', 'Spacebar'], ['agent-open']],
    [['Delete', 'Del', 'forward delete'], ['tab-close']],
    [['Escape', 'Esc'], ['search-close', 'dialog-close']],
    [['ArrowUp', 'up arrow', 'arrow up'], ['agent-move']],
    [['ArrowDown', 'down arrow', 'arrow down'], ['agent-move', 'search-result']],
    [['ArrowLeft', 'left arrow', 'arrow left', 'ArrowRight', 'right arrow', 'arrow right'], ['tab-move']],
    [['Backspace'], []],
  ];
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const [aliases, expected] of cases)
      for (const alias of aliases)
        for (const query of [alias, `${alias} key`])
          assert.deepEqual(find(query, platform), expected, `${platform}: ${query}`);
    assert.deepEqual(find('tab key', platform), ['agent-hide', 'dialog-tab'], platform);
    assert.deepEqual(find('return to opener', platform), ['dialog-close'], platform);
    assert.deepEqual(find('home stays available', platform), ['close-tab'], platform);
    assert.ok(find('tab', platform).includes('new-tab'), 'the useful tab noun remains an action search');
  }
});

test('natural delete-tab verb/object searches keep their action meaning unless explicitly marked as keys', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const query of ['delete tab', 'tab delete', 'delete tabs', 'delete focused tab', 'delete browser tab', 'browser tab delete', 'forward delete tab'])
      assert.deepEqual(find(query, platform), ['tab-close'], `${platform}: ${query}`);
    for (const query of ['Delete+Tab', 'Tab+Delete', 'Delete Tab key', 'delete ⇥', '⌦ tab', 'Del Tab', 'Shift Delete Tab'])
      assert.deepEqual(find(query, platform), [], `${platform}: ${query}`);
  }
});

test('explicit key queries cannot borrow prose or combine alternative bindings', () => {
  const proseOnly = { title: 'Home End Enter Return Tab Escape Space Delete ArrowUp ArrowDown',
    description: 'Move with forward delete or down arrow.', search: 'spacebar esc del', keys: [['F2']] };
  for (const query of ['Home', 'End', 'Enter', 'Return', 'Tab key', 'Escape', 'Space', 'Delete', 'Del', 'forward delete', 'ArrowUp', 'down arrow'])
    assert.equal(matchesShortcut(proseOnly, query), false, query);
  const alternatives = { title: 'Home End Tab Enter ArrowUp ArrowDown',
    keys: [['Home'], ['End'], ['⇥'], ['↩'], ['↑'], ['↓']] };
  const names = ['Home', 'End', 'Enter', 'Tab', 'Space', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', '↑', '↓', '⇥', '↩'];
  const pairs = names.flatMap((first, i) => names.slice(i + 1).map(second => [first, second]));
  const naturalActions = { 'Delete Tab': ['tab-close'], 'Tab Delete': ['tab-close'] };
  for (const [first, second] of pairs)
    for (const separator of [' ', '+'])
      for (const query of [`${first}${separator}${second}`, `${second}${separator}${first}`, `${first}${separator}${second} key`]) {
        assert.equal(matchesShortcut(alternatives, query), false, query);
        for (const platform of ['darwin', 'win32', 'linux']) assert.deepEqual(find(query, platform), naturalActions[query] || [], `${platform}: ${query}`);
      }
  for (const query of ['⇥ Open', '↩ opener', '↓ agent']) assert.deepEqual(find(query), [], query);
  assert.equal(matchesShortcut({ keys: [['F2']] }, 'F2 key'), true);
  assert.equal(matchesShortcut({ keys: [['T']] }, 'T key'), true);
  assert.deepEqual(find('T key'), []);
});
