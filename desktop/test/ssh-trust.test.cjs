const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { brokerTarget } = require('../src/vps-browser.cjs');
const { isSshTarget } = require('../src/core.cjs');
const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
const funcs = source.slice(source.indexOf('function checkBrokerSetup()'), source.indexOf('async function runSetupCheck'));
const ip = [100, 64, 0, 1].join('.');

test('setup never imports an agent SSH key and probes only a pre-provisioned broker path', async () => {
  const prefs = { vpsBrowser: { sshHost: 'agent@'+ip, brokerSshHost: 'broker@'+ip, scriptPath: '/app/host.cjs' }, macSshHost: 'human@'+ip };
  const sent = [];
  const scope = vm.runInNewContext(funcs+';({checkBrokerSetup,testAgentPath})', {
    TAILNET_SSH_OPTIONS: source.includes('TAILNET_SSH_OPTIONS') ? require('../src/tailnet.cjs').SSH_OPTIONS : [],
    cloudMigrate: require('../src/cloud-migrate.cjs'),
    prefs, brokerTarget, isSshTarget, HOST_LABEL:'mac', seedMacSshHost(){},
    localRun(){throw Error('No local shell/key write is allowed');},
    sshRun(){throw Error('No remote agent key may be fetched');},
    spawn: (file, args) => {
      sent.push({file,args});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
      queueMicrotask(()=>{child.stdout.emit('data','AGENT_PATH_OK');child.emit('close',0);});return child;
    },
  });
  assert.equal(scope.checkBrokerSetup().ok,true);
  assert.equal((await scope.testAgentPath()).ok,true);
  assert.equal(sent[0].file,'ssh');assert.ok(sent[0].args.includes('broker@'+ip));assert.ok(!sent[0].args.includes('agent@'+ip));
  for(const broker of ['', 'agent@'+ip]) {
    prefs.vpsBrowser.brokerSshHost=broker;
    assert.equal(scope.checkBrokerSetup().ok,false);
    assert.equal((await scope.testAgentPath()).ok,false);
  }
  prefs.vpsBrowser.sshHost='root@'+ip;prefs.vpsBrowser.brokerSshHost='broker@'+ip;
  assert.equal(scope.checkBrokerSetup().ok,false,'root agents cannot be isolated from broker credentials');
  assert.equal(sent.length,1,'invalid or shared broker settings never start SSH');
});
