'use strict';

function fingerprint(snapshot) {
  const elements = Array.isArray(snapshot && snapshot.elements) ? snapshot.elements : [];
  return JSON.stringify(elements.map((element) => [
    element.ref, element.role, element.name, element.x, element.y, element.width, element.height,
  ]));
}

function createComputerSnapshots() {
  const seen = new Map();
  function observe(pid, snapshot) {
    const next = fingerprint(snapshot);
    const prior = seen.get(pid);
    if (prior && prior.fingerprint === next) return { unchanged: true, generation: prior.generation };
    const generation = (prior ? prior.generation : 0) + 1;
    seen.set(pid, { fingerprint: next, generation });
    return { unchanged: false, generation, elements: Array.isArray(snapshot.elements) ? snapshot.elements : [] };
  }
  function reply(pid, snapshot, since) {
    const observed = observe(pid, snapshot);
    if (observed.unchanged && Number.isInteger(since) && since === observed.generation) {
      return { unchanged: true, generation: observed.generation };
    }
    return { ...snapshot, generation: observed.generation };
  }
  reply.observe = observe;
  return reply;
}

module.exports = { createComputerSnapshots, fingerprint };
