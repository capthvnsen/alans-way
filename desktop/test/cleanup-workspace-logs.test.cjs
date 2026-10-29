const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { cleanup, confirmedOffline } = require('../scripts/cleanup-workspace-logs.cjs');

test('cleanup is dry-run, reads no raw log contents and limits deletion to known logs', { skip: !process.getuid }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'old-logs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({ url: 'http://127.0.0.1:9465', token: 'synthetic-broker-secret' }), { mode: 0o600 });
  for (const name of ['main.log', 'main.log.old', 'keep.txt']) fs.writeFileSync(path.join(root, name), 'synthetic-raw-secret');
  const result = await cleanup({ root });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.actions.filter(action => action.operation === 'delete-old-log').map(action => path.basename(action.file)), ['main.log', 'main.log.old']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
  for (const name of ['connection.json', 'main.log', 'main.log.old', 'keep.txt']) assert.equal(fs.existsSync(path.join(root, name)), true);
  fs.unlinkSync(path.join(root, 'main.log')); fs.symlinkSync(path.join(root, 'keep.txt'), path.join(root, 'main.log'));
  await assert.rejects(cleanup({ root }), /Unsafe cleanup target/);
});

test('only confirmed connection refusal counts as offline; a live unauthorized broker is active', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(confirmedOffline(url), /Stop the broker/);
  await new Promise(resolve => server.close(resolve));
  await confirmedOffline(url);
  assert.throws(() => confirmedOffline('http://203.0.113.1'), /loopback/);
});


test('root apply rotates synthetic bot credentials and removes only known logs and broker tokens', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, async t => {
  const { provision } = require('../scripts/bot-credential.cjs');
  const { authorizeBot } = require('../src/bot-auth.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-apply-'));fs.chmodSync(base,0o711);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'broker'),exports=path.join(base,'exports'),uid=60000;
  fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(exports,{mode:0o711});fs.chownSync(root,uid,uid);
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;await new Promise(resolve=>server.close(resolve));
  const write=(name,value)=>{const file=path.join(root,name);fs.writeFileSync(file,value,{mode:0o600});fs.chownSync(file,uid,uid);};
  write('connection.json',JSON.stringify({url,token:'synthetic-broker'}));
  write('app-token.json',JSON.stringify({token:'synthetic-human'}));
  write('main.log','synthetic-old-log');write('main.log.old','synthetic-old-log');write('keep.txt','retained');
  const args={root,brokerUid:uid,botId:'a',uid:60001,output:path.join(exports,'a.json')};
  provision({...args,apply:true});const old=JSON.parse(fs.readFileSync(args.output)).token;
  const result=await cleanup({root,brokerUid:uid,apply:true});
  assert.equal(result.dryRun,false);
  for(const name of ['connection.json','app-token.json','main.log','main.log.old'])assert.equal(fs.existsSync(path.join(root,name)),false,name);
  assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'retained');
  assert.equal(fs.statSync(args.output).uid,60001);assert.equal(fs.statSync(args.output).mode&0o777,0o600);
  const registry=path.join(root,'bot-credentials.json');
  // Registry owner is the synthetic broker, so verify revocation in that UID.
  const probe=`const {authorizeBot}=require(process.argv[1]);process.exit(authorizeBot(process.argv[2],require('node:fs').readFileSync(0,'utf8'),'a')?0:1);`;
  const {spawnSync}=require('node:child_process');
  const check=token=>spawnSync(process.execPath,['-e',probe,require.resolve('../src/bot-auth.cjs'),registry],{uid,gid:uid,input:'Bearer '+token});
  assert.equal(check(old).status,1);
  const current=JSON.parse(fs.readFileSync(args.output)).token;assert.ok(current!==old,'bot credential rotated');assert.equal(check(current).status,0);
  assert.doesNotMatch(JSON.stringify(result),/synthetic/);
});
