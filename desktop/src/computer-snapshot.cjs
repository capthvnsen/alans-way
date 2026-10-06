'use strict';

function fingerprint(snapshot) {
  const elements = Array.isArray(snapshot && snapshot.elements) ? snapshot.elements : [];
  return JSON.stringify(elements.map((element) => [
    element.ref, element.role, element.name, element.x, element.y, element.width, element.height,
  ]));
}

function createComputerSnapshots() {
  const seen = new Map();
  return function reply(pid, snapshot, since) {
    const next = fingerprint(snapshot);
    const prior = seen.get(pid);
    if (prior && prior.fingerprint === next) {
      if (Number.isInteger(since) && since === prior.generation) {
        return { unchanged: true, generation: prior.generation };
      }
      return { ...snapshot, generation: prior.generation };
    }
    const generation = (prior ? prior.generation : 0) + 1;
    seen.set(pid, { fingerprint: next, generation });
    return { ...snapshot, generation };
  };
}

module.exports = { createComputerSnapshots, fingerprint };
