'use strict';

const MAX_TRACKED = 500;

// Generation is a hash of the tree, so it is the same for every bot. What is
// per bot is the last generation that bot was sent: a reply is "unchanged"
// only relative to what that bot has already seen.
function createComputerSnapshots() {
  const sent = new Map();
  const remember = (bot, pid, generation) => {
    const key = `${bot}\u0000${pid}`;
    const same = sent.get(key) === generation;
    sent.delete(key);
    sent.set(key, generation);
    if (sent.size > MAX_TRACKED) sent.delete(sent.keys().next().value);
    return same;
  };
  function snapshot(bot, pid, tree, since) {
    remember(bot, pid, tree.generation);
    if (Number.isInteger(since) && since === tree.generation) return { unchanged: true, generation: tree.generation };
    return tree;
  }
  function action(bot, pid, result) {
    if (!Number.isInteger(result.generation) || !Array.isArray(result.elements)) return result;
    if (!remember(bot, pid, result.generation)) return result;
    const { elements, truncated, ...rest } = result;
    return { ...rest, unchanged: true, generation: result.generation };
  }
  return { snapshot, action };
}

module.exports = { createComputerSnapshots };
