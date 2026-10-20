// Test-only trusted-router receipt construction from actual observed state.
// It never installs APPROVED or refreshes an already bound/replayed receipt.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { approvalActionKey, INPUT_ACTIONS } = require('../src/agent-input.cjs');
const prepared = new WeakSet();
function harnessApproval(tab, epoch = tab.epoch) {
  const receipt = { nonce: crypto.randomUUID(), kind: 'submit', summary: 'test harness script', issuedAt: Date.now(), tabId: typeof tab === 'string' ? tab : tab.id, epoch };
  prepared.add(receipt);
  return receipt;
}
function bindApproval(body, snapshot) {
  if (body.approval.binding) return body;
  assert.equal(snapshot.approvalContext?.version, 1, 'fixture must observe an enforcing host document');
  const norm = name => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const find = target => {
    const matches = snapshot.elements.filter(el => target.ref ? el.ref === target.ref : target.name && norm(el.name) === norm(target.name)
      && (!target.role || el.role === norm(target.role)) && (!target.row || norm(el.row).includes(norm(target.row))));
    assert.equal(matches.length, 1, 'fixture input must name one actually observed ref/control');
    const el = matches[0]; assert.match(el.approvalTarget, /^[a-f0-9]{32}$/);
    return { ref: el.ref, token: el.approvalTarget };
  };
  const steps = body.action === 'batch' ? body.steps : [body];
  body.approval.binding = { ...snapshot.approvalContext, key: approvalActionKey(body), steps: steps.map(step => ({
    key: approvalActionKey(step),
    targets: INPUT_ACTIONS.has(step.action) && step.action !== 'scroll' ? [find(step), ...(step.action === 'drag' ? [find({ ref: step.toRef })] : [])] : [],
  })) };
  return body;
}
async function bindHarnessApproval(body, readSnapshot) {
  if (body?.approval && prepared.has(body.approval) && !body.approval.binding) bindApproval(body, await readSnapshot());
  return body;
}
module.exports = { harnessApproval, bindApproval, bindHarnessApproval };
