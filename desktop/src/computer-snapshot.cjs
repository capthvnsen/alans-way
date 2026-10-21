'use strict';

const MAX_TRACKED = 500;
// A reply lists only what changed when that is clearly smaller than
// the whole tree; refs that all shift at once (the Linux helper numbers them
// in tree order) make a delta as big as the tree, so those replies stay whole.
const DELTA_SHARE = 0.6;

const canonical = (element) => JSON.stringify(Object.keys(element).sort().map((key) => [key, element[key]]));

// Generation is a hash of the tree, so it is the same for every bot. What is
// per bot is the last tree that bot was sent: a reply is "unchanged" only
// relative to what that bot has already seen, and a delta only when the caller
// also says it holds that tree (it passed its generation), so a lost reply or
// a second session on the same bot id gets the whole tree.
function createComputerSnapshots() {
  const sent = new Map();
  const remember = (bot, pid, tree) => {
    const key = `${bot}\u0000${pid}`;
    const before = sent.get(key);
    sent.delete(key);
    sent.set(key, { windowId: tree.windowId, generation: tree.generation, elements: new Map(tree.elements.map((element) => [element.ref, canonical(element)])) });
    if (sent.size > MAX_TRACKED) sent.delete(sent.keys().next().value);
    return before;
  };
  function snapshot(bot, pid, tree, since) {
    return action(bot, pid, tree, since);
  }
  function action(bot, pid, result, held) {
    if (!Number.isInteger(result.generation) || !Array.isArray(result.elements)) return result;
    const before = remember(bot, pid, result);
    if (!before || held !== before.generation || before.windowId !== result.windowId) return result;
    const { elements, ...rest } = result;
    if (before.generation === result.generation) return { ...rest, unchanged: true };
    const changed = elements.filter((element) => before.elements.get(element.ref) !== canonical(element));
    const now = new Set(elements.map((element) => element.ref));
    const removed = [...before.elements.keys()].filter((ref) => !now.has(ref));
    if (JSON.stringify(changed).length + JSON.stringify(removed).length >= DELTA_SHARE * JSON.stringify(elements).length) return result;
    return { ...rest, changed, removed };
  }
  return { snapshot, action, windowId: (bot, pid) => sent.get(`${bot}\u0000${pid}`)?.windowId };
}

module.exports = { createComputerSnapshots };
