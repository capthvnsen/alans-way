#!/usr/bin/env python3
"""Optional disposable public Hermes CLI acceptance fixture; no Hermes imports.

All model replies are deterministic local transport fixtures, not agent intelligence.
Uses only public CLI/config, current workspace stdio router, host HTTP, and headless
Chromium. Scripted PTY input exercises the human UI; independent review is required.
"""
import argparse, errno, fcntl, hashlib, html, json, os, pathlib
import pty, re, select, shutil, socket, struct, subprocess, sys, termios
import threading, time, traceback, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection
from urllib.parse import urlsplit

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--run', action='store_true', required=True, help='Explicitly opt in to the disposable local test')
ap.add_argument('--desktop', type=pathlib.Path, required=True)
ap.add_argument('--plugin', type=pathlib.Path, required=True)
ap.add_argument('--chrome', type=pathlib.Path, required=True)
ap.add_argument('--runtime', type=pathlib.Path, required=True, help='Existing Hermes runtime store; read only')
ap.add_argument('--borrow-default-root', action='store_true', help='Create/delete a new owned home under default root to share installed dependencies')
ap.add_argument('--owned-home', type=pathlib.Path, help='Optional fresh vanilla-approval-<32 hex digits> home under the default root')
ap.add_argument('--interface', choices=('cli','tui'), default='cli')
ap.add_argument('--tui-dir', type=pathlib.Path, help='Documented HERMES_TUI_DIR pointing at already installed prebuilt assets')
ap.add_argument('--tool-search', choices=('auto','off'), default='auto')
ap.add_argument('--out', type=pathlib.Path, required=True)
ap.add_argument('--scenarios', default='approve,decline,cancel,stale,recover,session,repeat,timeout')
a = ap.parse_args()
a.desktop, a.plugin, a.chrome, a.out = [p.resolve() for p in (a.desktop,a.plugin,a.chrome,a.out)]
hermes = shutil.which('hermes'); node=shutil.which('node')
router=a.plugin/'alans-way/scripts/workspace-router.cjs'
connector=a.desktop/'scripts/browser-mcp.cjs'
host_script=a.desktop/'scripts/vps-browser-host.cjs'
if sys.platform!='darwin' or not pathlib.Path('/usr/bin/sandbox-exec').is_file():
    ap.error('This fixture requires macOS Seatbelt; no unconfined fallback is provided.')
if not a.borrow_default_root:
    ap.error('Pass --borrow-default-root to use a new owned home beneath the default Hermes root.')
if a.owned_home and (a.owned_home.resolve().parent != (pathlib.Path.home()/'.hermes').resolve()
        or not re.fullmatch(r'vanilla-approval-[0-9a-f]{32}', a.owned_home.name)
        or a.owned_home.exists() or a.owned_home.is_symlink()):
    ap.error('--owned-home must be a new exclusively owned vanilla-approval-<32 hex digits> home under the default root.')
if not hermes or not node or not a.chrome.is_file() or not a.runtime.is_dir():
    ap.error('Provide an installed public hermes CLI, Node, Chromium executable, and existing runtime store.')
for p in (router,connector,host_script):
    if not p.is_file(): ap.error('Missing candidate file: '+str(p))
if a.interface=='tui' and not a.tui_dir:
    ap.error('--interface tui requires --tui-dir pointing at existing prebuilt assets; this fixture never builds.')
if a.tui_dir and not ((a.tui_dir/'dist/entry.js').is_file() and (a.tui_dir/'node_modules').is_dir()):
    ap.error('--tui-dir must contain existing dist/entry.js and node_modules.')
if a.out.is_relative_to(a.desktop) or a.out.is_relative_to(a.plugin):
    ap.error('--out must be outside the read-only candidate source directories.')
if a.out.is_relative_to((pathlib.Path.home()/'.hermes').resolve()):
    ap.error('--out must be outside the existing Hermes root.')
allowed_scenarios={'approve','decline','cancel','stale','recover','session','repeat','timeout',
                   'queue','queuedecline','queuetimeout','queuestale'}
if not a.scenarios or any(s not in allowed_scenarios for s in a.scenarios.split(',')):
    ap.error('Unknown or empty scenario; use only the normal flows listed in --help.')
if any(s.startswith('queue') for s in a.scenarios.split(',')) and (a.tool_search!='off' or a.interface!='tui'):
    ap.error('Queue scenarios require --interface tui --tool-search off for two directly advertised tools.')
assert not a.out.exists(), 'Use a new output directory; evidence is never overwritten.'
a.out.mkdir(parents=True, mode=0o700)
profile = (a.owned_home.resolve() if a.owned_home else (pathlib.Path.home()/'.hermes'/('vanilla-approval-'+uuid.uuid4().hex))
           if a.borrow_default_root else a.out/'hermes-home')
assert not profile.exists()
work = a.out/'work'; work.mkdir()
runtime = a.out/'host'; runtime.mkdir(mode=0o700)
env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','SHELL')}
env.update(HERMES_HOME=str(profile), TERM='xterm-256color', NO_PROXY='127.0.0.1,localhost',
           HERMES_WORKSPACE_ALLOW_LOOPBACK='1', PYTHONDONTWRITEBYTECODE='1',
           ALANS_WAY_AGENTS=str(a.plugin),
           HERMES_RUNTIME_DIR=str(a.runtime.resolve()))
if a.tui_dir:
    env['HERMES_TUI_DIR']=str(a.tui_dir.resolve())
policy = a.out/'loopback-only.sb'
root=(pathlib.Path.home()/'.hermes').resolve()
# Read installed selection facts, never import Hermes or ask it to prepare anything.
# This fixture supports the existing default-root source installation only.
installed_source=(root/'hermes-agent').resolve()
install=root/'installs'/hashlib.sha256(str(installed_source).encode()).hexdigest()[:16]
facts=install/'facts.json'; selected=install/'pm-runtime/selected.json'
generation=pathlib.Path(json.loads(facts.read_text())['packages']['venv']['environment']).parent
pm_generation=install/'pm-runtime'/json.loads(selected.read_text())['generation']
for p,parent in ((generation,install/'environments'),(pm_generation,install/'pm-runtime/generations')):
    if (p.is_symlink() or p.resolve().parent!=parent.resolve()
            or not re.fullmatch(r'[0-9a-f]{32}',p.name)
            or not (p/'.lease-managed').is_file() or not (p/'.leases').is_dir()):
        raise RuntimeError('Require an existing committed lease-managed generation: '+str(p))
lease_dirs=[p.resolve()/'.leases' for p in (generation,pm_generation)]
mutexes=[install/'.install.lock',install/'pm-runtime/.prepare.lock']
if any(p.is_symlink() or not p.is_file() for p in mutexes):
    raise RuntimeError('Require existing normal launcher mutexes; never bootstrap an install.')
existing_leases=sorted((root/'installs').glob('**/.leases/*'))
lease_before={};lease_snapshot_disappeared=[]
for p in existing_leases:
    try:
        if p.is_symlink() or not p.is_file():
            if not p.exists():raise FileNotFoundError(str(p))
            raise RuntimeError('Unrecognized existing lease entry; refusing to broaden confinement.')
        digest=hashlib.sha256(p.read_bytes()).hexdigest();stat=p.stat()
        lease_before[str(p)]={'sha256':digest,'size':stat.st_size,'mtimeNs':stat.st_mtime_ns}
    except FileNotFoundError:
        # A shared launch may exit during the read-only snapshot. Its observed
        # pathname stays individually denied; disappearance never grants writes.
        lease_snapshot_disappeared.append(str(p))
exceptions=['(subpath '+json.dumps(str(profile))+')']
exceptions+=['(literal '+json.dumps(str(p))+')' for p in mutexes+lease_dirs]
# Only direct UUID lease names may be created. Every snapshot-time lease is
# separately denied, so normal launcher pruning cannot open or unlink it.
# Seatbelt's regex dialect needs explicit repeats rather than Python {32}.
exceptions+=['(regex (string-append "^" (regex-quote '+json.dumps(str(p))+') "/'
    +'[0-9a-f]'*32+'$"))' for p in lease_dirs]
workspace=pathlib.Path(__file__).resolve().parents[2]
policy.write_text('(version 1)(allow default)\n(deny network-outbound)(deny network-inbound)\n'
    '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))\n'
    '(allow network-inbound (local ip "localhost:*") (local unix-socket))\n'
    +'(deny file-write* (require-all (subpath '+json.dumps(str(root))+') '
    +' '.join('(require-not '+e+')' for e in exceptions)+'))\n'
    +''.join('(deny file-write* (subpath '+json.dumps(str(p))+'))\n' for p in existing_leases)
    +''.join('(deny file-write* (subpath '+json.dumps(str(p))+'))\n' for p in
        (pathlib.Path(hermes).resolve(),a.runtime.resolve(),installed_source,a.desktop,a.plugin,a.chrome.parent,
         *((a.tui_dir.resolve(),) if a.tui_dir else ())))
    +'(deny file-write* (require-all (subpath '+json.dumps(str(workspace))+') '
    +'(require-not (subpath '+json.dumps(str(a.out))+'))))\n')
(a.out/'confinement-inputs.json').write_text(json.dumps({'root':str(root),'ownedHome':str(profile),
    'facts':str(facts),'selected':str(selected),'mutexes':[str(p) for p in mutexes],
    'uuidLeaseDirectories':[str(p) for p in lease_dirs],'existingLeases':lease_before,
    'protectedLeasePaths':[str(p) for p in existing_leases],'leasesDisappearedDuringSnapshot':lease_snapshot_disappeared,
    'scope':'Child policy; controller, local HTTP servers and setup/export/audit are outside Seatbelt.'},indent=2)+'\n')
sandbox = ['/usr/bin/sandbox-exec','-f',str(policy)]
profile.mkdir(mode=0o700)
(a.out/'owned-home.json').write_text(json.dumps({'path':str(profile),'previouslyExisted':False,'createdExclusively':True})+'\n')
processes=[]; exits=[]; servers=[]; artifacts=[]; choices=[]; cases=[]; endpoint_ports=[]
events=[]; hits=[]; model_log=[]; tools_seen=[]; current={}; errors=[]; refresh_requested=set(); declaration_checks=[]
lock=threading.RLock(); child=None; master=None
observed_processes={}; last_process_observation=0.0
owned_leases={}
started_at=time.time(); started_monotonic=time.monotonic()
unattributed_processes=[]; process_observation_failed=False

def dump(name, value):
    (a.out/name).write_text(json.dumps(value, indent=2,ensure_ascii=False)+'\n')

def process_table():
    rows={}
    output=subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,stat=,lstart=,command='],text=True)
    for line in output.splitlines():
        fields=line.split(None,9)
        if len(fields)!=10 or not all(s.isdigit() for s in fields[:3]):continue
        rows[int(fields[0])]={'pid':int(fields[0]),'ppid':int(fields[1]),'pgid':int(fields[2]),
            'state':fields[3],'started':' '.join(fields[4:9]),'command':fields[9]}
    return rows

def observe_processes():
    """Read OS metadata only; retain identities across reparenting and PID reuse."""
    global unattributed_processes,process_observation_failed
    try:table=process_table()
    except (OSError,subprocess.SubprocessError) as exc:
        process_observation_failed=True
        errors.append('Process observation failed; owned home must be retained: '+str(exc))
        return []
    ancestors={os.getpid()}; ancestor=os.getppid()
    while ancestor in table and ancestor not in ancestors:
        ancestors.add(ancestor);ancestor=table[ancestor]['ppid']
    selected={p.pid for _,p in processes if p.poll() is None and p.pid in table}
    selected.update(pid for (pid,start) in observed_processes if pid in table and table[pid]['started']==start)
    changed=True
    while changed:
        previous=set(selected);groups={table[pid]['pgid'] for pid in selected}
        selected.update(pid for pid,row in table.items() if pid not in ancestors
            and (row['ppid'] in selected or row['pgid'] in groups))
        changed=previous!=selected
    for pid in selected:
        row=table[pid]
        observed_processes[(pid,row['started'])]={k:v for k,v in row.items() if k!='command'}
    # A new shared-install filename alone never proves ownership. Attribute a
    # lease only through an open handle of a positively observed owned identity.
    if selected:
        try:
            handles=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',','.join(str(p) for p in sorted(selected)),
                '-Fpn'],capture_output=True,text=True,timeout=10)
            if handles.returncode not in (0,1) or handles.stderr:
                raise OSError('Lease handle observation failed: '+handles.stderr)
            after=process_table();owner=None
            for line in handles.stdout.splitlines():
                if line.startswith('p') and line[1:].isdigit():owner=int(line[1:])
                elif line.startswith('n') and owner in selected:
                    path=pathlib.Path(line[1:]);row=after.get(owner)
                    if (path.parent in lease_dirs and str(path) not in lease_before
                            and re.fullmatch(r'[0-9a-f]{32}',path.name)
                            and row and row['started']==table[owner]['started']):
                        owned_leases[str(path)]={'pid':owner,'started':row['started'],
                            'basis':'New lease with open handle of observed owned process identity.'}
            dump('owned-lease-observations.json',owned_leases)
        except (OSError,subprocess.SubprocessError) as exc:
            process_observation_failed=True
            errors.append('Lease ownership observation failed; home retained: '+str(exc))
    # A command marker alone does not confer process ownership. A separate
    # reader may mention the evidence path; retain/fail rather than signal it.
    unattributed_processes=[{k:v for k,v in row.items() if k!='command'} for pid,row in table.items()
        if pid not in ancestors and pid not in selected and 'Z' not in row['state']
        and (str(profile) in row['command'] or str(a.out) in row['command'])]
    live=[];identities=[]
    for (pid,start),record in observed_processes.items():
        row=table.get(pid)
        state='absent' if row is None or row['started']!=start else ('exited-zombie' if 'Z' in row['state'] else 'live')
        identities.append({**record,'observation':state})
        if state=='live':live.append(record)
    dump('observed-process-tree.json',{'identities':identities,'livePids':[r['pid'] for r in live],
        'unattributedCommandMatches':unattributed_processes,
        'basis':'Observed parent/group relationships with start-time identity checks; command matches are separate, not ownership. No claim about unobserved detached processes.'})
    return live

def run(args):
    r=subprocess.run(sandbox+args,env=env,cwd=work,capture_output=True,text=True,timeout=50)
    with (a.out/'commands.txt').open('a') as f:
        f.write('$ '+repr(args)+'\n'+r.stdout+r.stderr+'\nexit='+str(r.returncode)+'\n')
    assert r.returncode==0, (args,r.stdout,r.stderr)
    return r.stdout

def spawn(args,name,extra=None):
    f=(a.out/(name+'.log')).open('wb'); artifacts.append(f)
    p=subprocess.Popen(sandbox+args,cwd=work,env={**env,**(extra or {})},stdout=f,stderr=f,start_new_session=True)
    processes.append((name,p)); dump('owned-processes.json',[{'name':n,'pid':c.pid} for n,c in processes]); observe_processes(); return p

def http(port,path,method='GET',body=None,headers=None):
    c=HTTPConnection('127.0.0.1',port,timeout=5)
    c.request(method,path,body=None if body is None else json.dumps(body),headers=headers or {})
    r=c.getresponse(); data=r.read(); c.close()
    return r.status,json.loads(data)

def free_port():
    s=socket.socket(); s.bind(('127.0.0.1',0)); p=s.getsockname()[1]; s.close(); return p

def until(fn, seconds=30):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            v=fn()
            if v: return v
        except (OSError,ValueError): pass
        time.sleep(.1)
    raise TimeoutError('condition did not become true')

def body_object(content):
    # Hermes preserves MCP text blocks. Decode that public tool result only.
    if isinstance(content,list):
        text='\n'.join(str(x.get('text','')) for x in content if isinstance(x,dict))
    else: text=str(content)
    for i,ch in enumerate(text):
        if ch=='{':
            try:
                value=json.JSONDecoder().raw_decode(text[i:])[0]
                if isinstance(value,dict) and isinstance(value.get('result'),str):
                    try:return json.loads(value['result'])
                    except ValueError:pass
                return value
            except ValueError: pass
    return {'text':text}

class Web(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        hits.append({'at':time.time(),'method':'GET','path':self.path})
        path=self.path.split('?')[0]
        if path=='/refresh-state':
            key=self.path.partition('?scenario=')[2] or 'stale'
            reload=key in refresh_requested
            refresh_requested.discard(key)
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
            self.wfile.write(json.dumps({'reload':reload}).encode());return
        if path.startswith('/pay/'):
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            self.wfile.write(b'<!doctype html><title>Local test complete</title><h1>Local test complete</h1>'); return
        scenario=path.removeprefix('/review/')
        page=f'''<!doctype html><meta charset="utf-8"><title>Local approval review: {scenario}</title>
<h1>Local approval review: {scenario}</h1><p>Inert local fixture. TEST 0. No account, payment, or message.</p>
<p>Destination: /pay/{scenario}</p><a id="buy" href="/pay/{scenario}">Buy local test item</a>
<script>for(const type of ['pointerdown','mousedown','click','keydown','input','submit'])document.addEventListener(type,e=>{{fetch('/event',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{scenario:{json.dumps(scenario)},type,target:e.target.id,isTrusted:e.isTrusted}})}})}},true);
if({json.dumps(scenario)}==='stale'||{json.dumps(scenario)}==='queuestalea'){{const timer=setInterval(async()=>{{if((await fetch('/refresh-state?scenario={scenario}').then(r=>r.json())).reload){{clearInterval(timer);location.reload()}}}},100)}};</script>'''
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(page.encode())
    def do_POST(self):
        n=int(self.headers.get('Content-Length','0')); value=json.loads(self.rfile.read(n) or '{}')
        events.append({'at':time.time(),**value}); self.send_response(200); self.end_headers(); self.wfile.write(b'{}')

class Model(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def queue_plan(self,scenario,tool_msgs):
        """Offer two public calls together; observe, never force, concurrency."""
        step=len(tool_msgs)
        if step==0:
            current[scenario]={'targets':[]}
            return [('cua_alans_way_status',{})]
        c=current[scenario]
        if step in (1,3):
            if step==3:c['targets'][0]['snapshot']=body_object(tool_msgs[-1]['content'])
            return [('cua_alans_way_open',{'url':f'http://127.0.0.1:{web.server_port}/review/{scenario}'+('a' if step==1 else 'b')})]
        if step in (2,4):
            opened=body_object(tool_msgs[-1]['content']);tab=opened.get('tab',opened)
            tabid=tab.get('id') or tab.get('tabId') or opened.get('tabId')
            if not tabid:raise ValueError('No public queue tab id: '+repr(opened))
            c['targets'].append({'tabId':tabid,'epoch':tab.get('epoch',opened.get('epoch')),'opened':opened})
            return [('cua_alans_way_snapshot',{'tabId':tabid,'maxChars':4000})]
        if step==5:
            c['targets'][1]['snapshot']=body_object(tool_msgs[-1]['content'])
            if len({t['tabId'] for t in c['targets']})!=2:raise ValueError('Queue needs two distinct public tabs.')
            plan=[]
            for index,target in enumerate(c['targets']):
                found=[e for e in target['snapshot'].get('elements',[]) if e.get('name')=='Buy local test item']
                if len(found)!=1:raise ValueError('Queue target needs one reviewed buy control.')
                target['label']=scenario+('a' if index==0 else 'b')
                target['callId']=f'fixture_{scenario}_5_{index}'
                target['action']={'tabId':target['tabId'],'epoch':target['snapshot'].get('epoch',target['epoch']),
                    'action':'click','ref':found[0]['ref'],'commit':{'kind':'purchase',
                    'summary':f'Local {target["label"]} test item; no real purchase',
                    'amount':'0','currency':'TEST','counterparty':'Inert local fixture'}}
                plan.append(('cua_alans_way_action',target['action']))
            dump('public-observations.json',current)
            return plan
        if step!=7:raise ValueError('Queue results incomplete or repeated: '+str(step))
        by_id={m['tool_call_id']:body_object(m['content']) for m in tool_msgs[-2:]}
        c['results']=[by_id[t['callId']] for t in c['targets']]
        dump('public-observations.json',current)
        return []
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'object':'list','data':[{'id':'fixture-inert','object':'model','owned_by':'local-model-fixture','context_length':65536}]}).encode())
    def do_POST(self):
        try:
            req=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
            with lock:
                model_log.append({'at':time.time(),'path':self.path,'request':req})
                dump('model-fixture-transport.json',model_log)
                msgs=req.get('messages',[])
                user_index=max(i for i,m in enumerate(msgs) if m['role']=='user')
                match=re.search(r'FIXTURE ([a-z]+)',str(msgs[user_index].get('content','')))
                # The observed public session-title request quotes the opening
                # FIXTURE message without tools. Keep that explicit ancillary
                # branch separate from a malformed scenario declaration.
                title_request=(not req.get('tools') and [m.get('role') for m in msgs]==['system','user']
                    and str(msgs[0].get('content','')).startswith('You name chat sessions.'))
                if not match or title_request:
                    # Public ancillary title/summary request; no tool selection.
                    value={'id':'local-fixture-aux','object':'chat.completion','created':int(time.time()),'model':'fixture-inert',
                        'choices':[{'index':0,'message':{'role':'assistant','content':'Nothing to save.' if req.get('tools') else 'Local approval fixture'},'finish_reason':'stop'}],
                        'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}
                    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                    self.wfile.write(json.dumps(value).encode());return
                scenario=match.group(1)
                tool_msgs=[m for m in msgs[user_index+1:] if m['role']=='tool']
                step=len(tool_msgs)
                definitions=req.get('tools',[])
                if not isinstance(definitions,list) or not definitions:
                    raise ValueError('Scenario request is missing its current tool declarations.')
                names=[t['function']['name'] for t in definitions]
                if a.tool_search=='off' and (any(n in names for n in ('tool_search','tool_describe','tool_call'))
                        or not any(n.startswith('mcp__workspace_browser__') for n in names)):
                    raise ValueError('Requested eager tools, but actual declarations do not expose direct workspace MCP tools.')
                declaration_checks.append({'at':time.time(),'requestIndex':len(model_log)-1,'scenario':scenario,
                    'step':step,'advertisedNames':names,'valid':True})
                dump('declaration-validation.json',declaration_checks)
                if names and not tools_seen:
                    tools_seen.extend(names); dump('discovered-tools.json',definitions)
                    dump('effective-discovery.json',{'requested':a.tool_search,'advertisedNames':names,
                        'directWorkspaceTools':any(n.startswith('mcp__workspace_browser__') for n in names)})
                catalog=sorted(set(re.findall(r'mcp__workspace_browser__[A-Za-z_]+',json.dumps(definitions))))
                wanted=[n for n in catalog if n.endswith(('cua_alans_way_status','cua_alans_way_tabs','cua_alans_way_open','cua_alans_way_snapshot','cua_alans_way_action'))]
                tool=None; args={}; queued_calls=None
                mainstep=step-(2 if a.tool_search=='auto' else 0)
                if scenario.startswith('queue'):queued_calls=self.queue_plan(scenario,tool_msgs)
                elif a.tool_search=='auto' and step==0: tool='tool_search'; args={'queries':['cua_alans_way_status','cua_alans_way_tabs','cua_alans_way_open','cua_alans_way_snapshot','cua_alans_way_action']}
                elif a.tool_search=='auto' and step==1: tool='tool_describe'; args={'names':wanted}
                elif mainstep==0: tool='cua_alans_way_status'
                elif mainstep==1:
                    if scenario=='recover' and 'stale' in current:tool='cua_alans_way_tabs'
                    else:tool='cua_alans_way_open'; args={'url':f'http://127.0.0.1:{web.server_port}/review/{scenario}'}
                elif mainstep==2:
                    opened=body_object(tool_msgs[-1]['content'])
                    if scenario=='recover' and 'stale' in current:
                        opened=next(t for t in opened['tabs'] if t['id']==current['stale']['tabId'])
                    current[scenario]={'opened':opened}
                    tab=opened.get('tab',opened); tabid=tab.get('id') or tab.get('tabId') or opened.get('tabId')
                    if not tabid: raise ValueError('No public tab id in '+repr(opened))
                    current[scenario].update(tabId=tabid,epoch=tab.get('epoch',opened.get('epoch')))
                    tool='cua_alans_way_snapshot'; args={'tabId':tabid,'maxChars':4000}
                elif mainstep==3:
                    snap=body_object(tool_msgs[-1]['content']); current[scenario]['snapshot']=snap
                    found=[e for e in snap.get('elements',[]) if e.get('name')=='Buy local test item']
                    if len(found)!=1: raise ValueError('No unique reviewed buy target: '+repr(snap))
                    c=current[scenario]
                    tool='cua_alans_way_action'; args={'tabId':c['tabId'],'epoch':snap.get('epoch',c['epoch']),
                        'action':'click','ref':found[0]['ref'],
                        'commit':{'kind':'purchase','summary':f'Local {scenario} test item; no real purchase',
                        'amount':'0','currency':'TEST','counterparty':'Inert local fixture'}}
                    current[scenario]['action']=args
                    dump('public-observations.json',current)
                if tool or queued_calls:
                    calls=[]
                    for index,(selected_tool,selected_args) in enumerate(queued_calls or [(tool,args)]):
                        matches=[n for n in names if n.endswith(selected_tool)]
                        if not matches and selected_tool.startswith('cua_') and queued_calls is None:
                            deferred=[n for n in wanted if n.endswith(selected_tool)]
                            if len(deferred)==1 and 'tool_call' in names:
                                selected_args={'calls':[{'name':deferred[0],'arguments':selected_args}]}; matches=['tool_call']
                        if len(matches)!=1: raise ValueError(f'Missing or ambiguous public tool {selected_tool}: {names}')
                        calls.append({'id':f'fixture_{scenario}_{step}'+(f'_{index}' if len(queued_calls or [])==2 else ''),
                            'type':'function','function':{'name':matches[0],'arguments':json.dumps(selected_args)}})
                    message={'role':'assistant','content':None,'tool_calls':calls}
                    finish='tool_calls'
                else:
                    result=current[scenario]['results'] if queued_calls is not None else body_object(tool_msgs[-1]['content'])
                    current[scenario]['result']=result; dump('public-observations.json',current)
                    message={'role':'assistant','content':'MODEL_FIXTURE_DONE '+scenario+' '+json.dumps(result,ensure_ascii=False)}
                    finish='stop'
                payload={'id':f'local-fixture-{len(model_log)}','object':'chat.completion','created':int(time.time()),
                    'model':'fixture-inert','choices':[{'index':0,'message':message,'finish_reason':finish}],
                    'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}
                model_log[-1]['response']=payload;dump('model-fixture-transport.json',model_log)
                if req.get('stream'):
                    self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
                    delta=json.loads(json.dumps(message))
                    for index,call in enumerate(delta.get('tool_calls',[])):call['index']=index
                    self.wfile.write(('data: '+json.dumps({'id':payload['id'],'object':'chat.completion.chunk','created':payload['created'],
                        'model':payload['model'],'choices':[{'index':0,'delta':delta,'finish_reason':None}]})+'\n\n'
                        +'data: '+json.dumps({'id':payload['id'],'object':'chat.completion.chunk','created':payload['created'],
                        'model':payload['model'],'choices':[{'index':0,'delta':{},'finish_reason':finish}]})+'\n\ndata: [DONE]\n\n').encode())
                else:
                    self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(payload).encode())
        except Exception as e:
            errors.append(traceback.format_exc()); dump('fixture-errors.json',errors)
            self.send_response(500); self.end_headers(); self.wfile.write(json.dumps({'error':str(e)}).encode())

ansi=re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[=>])')
raw=bytearray()
def plain(start=0): return ansi.sub('',raw[start:].decode('utf-8','replace')).replace('\r','')
def pump(seconds=.2):
    global last_process_observation
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],max(0,end-time.monotonic()))[0]:
            try: b=os.read(master,65536)
            except OSError as e:
                if e.errno==errno.EIO: return
                raise
            if not b: return
            raw.extend(b)
            with (a.out/'transcript.ansi').open('ab') as f:f.write(b)
    if time.monotonic()-last_process_observation>=1:
        observe_processes();last_process_observation=time.monotonic()

def wait_text(text,start=0,seconds=60,required=None,settled_marker=None):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        pump(.2)
        if errors:raise RuntimeError('Local model-fixture failure: '+errors[-1])
        segment=plain(start);compact=''.join(segment.split())
        if text=='Allow once' and settled_marker and ''.join(settled_marker.split()) in compact:
            raise RuntimeError('Public action settled before a usable approval panel was observed: '+json.dumps(current))
        markers=(required,) if isinstance(required,str) else (required or ())
        if ''.join(text.split()) in compact and (not markers or any(''.join(marker.split()) in compact for marker in markers)): return
        if child.poll() is not None: raise RuntimeError('Hermes exited '+str(child.returncode)+'; tail='+plain()[-3000:])
    raise TimeoutError('Missing '+repr(text)+'; tail='+plain()[-4000:])

def send(data,label):
    choices.append({'at':time.time(),'label':label,'bytes':repr(data)})
    dump('pty-inputs.json',choices); os.write(master,data)

def preserve():
    dump('local-page-events.json',events); dump('local-http-hits.json',hits)
    dump('cases.json',cases); dump('process-exits.json',exits)
    (a.out/'transcript.txt').write_text(plain())
    (a.out/'transcript.html').write_text('<!doctype html><meta charset="utf-8"><title>Real Hermes PTY transcript</title>'
        '<h1>Real Hermes PTY transcript</h1><p>Text view of actual ANSI output. Scripted PTY choices; not a GUI screenshot. '
        'Local deterministic model-fixture transport; no remote model or account.</p><pre>'+html.escape(plain())+'</pre>')

# Test-only byte-preserving MCP stdio observation. Neither requests, receipts,
# decisions nor ordering are manufactured. The matching stock router is child.
MCP_OBSERVER=r'''const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {Transform}=require('node:stream');
const {StringDecoder}=require('node:string_decoder');
const [log,command,...args]=process.argv.slice(2);
let seq=0;
function tap(direction){let tail='';const decoder=new StringDecoder('utf8');return new Transform({transform(chunk,encoding,callback){
  tail+=decoder.write(chunk);let end;
  while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end);tail=tail.slice(end+1);
    fs.appendFileSync(log,JSON.stringify({seq:++seq,at:Date.now()/1000,direction,line})+'\n');}
  callback(null,chunk);
}});}
const child=spawn(command,args,{stdio:['pipe','pipe','inherit'],env:process.env});
process.stdin.pipe(tap('client-to-router')).pipe(child.stdin);
child.stdout.pipe(tap('router-to-client')).pipe(process.stdout);
child.on('error',e=>{console.error(e);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.stdin.destroy();process.exitCode=code??1;});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill(sig));
'''

def mcp_trace():
    path=a.out/'mcp-wire.jsonl'
    if not path.exists():return []
    rows=[]
    for line in path.read_text().splitlines():
        try:
            row=json.loads(line);row['message']=json.loads(row['line']);rows.append(row)
        except ValueError:continue  # Concurrent final partial line; original bytes remain authoritative.
    return rows

def queue_evidence(scenario,since):
    rows=[r for r in mcp_trace() if r['at']>=since]
    summaries={f'Local {scenario}{suffix} test item; no real purchase' for suffix in ('a','b')}
    requests=[r for r in rows if r['direction']=='router-to-client' and r['message'].get('method')=='elicitation/create'
              and any(s in r['message'].get('params',{}).get('message','') for s in summaries)]
    answers=[r for r in rows if r['direction']=='client-to-router' and 'method' not in r['message']
             and r['message'].get('id') in {q['message']['id'] for q in requests}]
    answered={r['message']['id'] for r in answers}
    calls=[r for r in rows if r['direction']=='client-to-router' and r['message'].get('method')=='tools/call'
           and r['message'].get('params',{}).get('name')=='cua_alans_way_action'
           and r['message'].get('params',{}).get('arguments',{}).get('commit',{}).get('summary') in summaries]
    results=[r for r in rows if r['direction']=='router-to-client' and 'method' not in r['message']
             and r['message'].get('id') in {c['message']['id'] for c in calls}]
    binding=[]
    for request in requests:
        matches=[c for c in calls if c['seq']<request['seq']
                 and c['message']['params']['arguments']['commit']['summary'] in request['message']['params']['message']]
        if len(matches)!=1:raise ValueError('Missing or ambiguous public elicitation/action binding.')
        call=matches[0]
        result=next((r for r in results if call and r['message']['id']==call['message']['id']),None)
        answer=next((r for r in answers if r['message']['id']==request['message']['id']),None)
        binding.append({'toolCallId':call['message']['id'] if call else None,
            'elicitationId':request['message']['id'],'requestedAtSeq':request['seq'],
            'answerAtSeq':answer['seq'] if answer else None,'completedAtSeq':result['seq'] if result else None})
    return {'elicitations':requests,'answers':answers,'actionCalls':calls,'actionResults':results,'binding':binding,
            'pendingIds':[r['elicitationId'] for r in binding if r['elicitationId'] not in answered and r['completedAtSeq'] is None]}

def effect_counts(label):
    return {'events':[e for e in events if e.get('scenario')==label],
            'destinationRequests':len([h for h in hits if h['path']=='/pay/'+label])}

def run_queue(scenario,start,since):
    first,second=current[scenario]['targets']
    pump(.5)
    observed=queue_evidence(scenario,since)
    assert observed['elicitations'], 'Missing public MCP elicitation evidence'
    assert observed['pendingIds'], 'Public approval settled before the first scripted answer'
    # Actual wire order is the expected UI queue order; never impose model order.
    ordered=[]
    for request in observed['elicitations']:
        label=next(t['label'] for t in (first,second) if ('Local '+t['label']+' test item') in json.dumps(request))
        ordered.append(label)
    initial={'at':time.time(),'stage':'before-first-answer','wire':observed,
             'effects':{t['label']:effect_counts(t['label']) for t in (first,second)}}
    assert all(not v['events'] and v['destinationRequests']==0 for v in initial['effects'].values()),initial
    checkpoints=[initial]
    dump(scenario+'-queue-checkpoints.json',checkpoints)
    if scenario=='queuetimeout':
        wait_text('MODEL_FIXTURE_DONE '+scenario,start,60)
    else:
        assert ordered[0]==first['label'], ('Unexpected first public queue target',ordered)
        next_start=len(raw)
        if scenario=='queuestale':
            refresh_requested.add(first['label'])
            until(lambda:len([h for h in hits if h['path']=='/review/'+first['label']])==2)
            pump(.3)
            send(b'\r','Allow once '+first['label']+' after ordinary self-refresh')
        elif scenario=='queuedecline':send(b'4','Deny '+first['label'])
        else:send(b'2','Select visible session option for '+first['label'])
        wait_text('Allow once',next_start,30,required=('Local '+second['label']+' test item','/review/'+second['label']),
                  settled_marker='MODEL_FIXTURE_DONE '+scenario)
        pump(.5)
        (a.out/(scenario+'-second-pending.txt')).write_text(plain(next_start))
        checkpoint={'at':time.time(),'stage':'before-second-answer','wire':queue_evidence(scenario,since),
                    'effects':{t['label']:effect_counts(t['label']) for t in (first,second)}}
        checkpoints.append(checkpoint);dump(scenario+'-queue-checkpoints.json',checkpoints)
        assert checkpoint['wire']['pendingIds'], 'Public approval settled before the second scripted answer'
        assert not checkpoint['effects'][second['label']]['events'] and checkpoint['effects'][second['label']]['destinationRequests']==0,checkpoint
        send(b'4' if scenario=='queue' else b'\r',('Deny ' if scenario=='queue' else 'Allow once ')+second['label'])
        wait_text('MODEL_FIXTURE_DONE '+scenario,start,60)
    pump(1)
    final=queue_evidence(scenario,since)
    assert len(final['elicitations'])==2 and len({r['message']['id'] for r in final['elicitations']})==2,final
    assert len(final['actionCalls'])==2 and len(final['actionResults'])==2,final
    assert [r['message']['params']['arguments']['tabId'] for r in final['actionCalls']]==[first['tabId'],second['tabId']],final
    assert {r['toolCallId'] for r in final['binding']}=={r['message']['id'] for r in final['actionCalls']},final
    assert all(r['completedAtSeq'] is not None for r in final['binding']) and not final['pendingIds'],final
    scheduling=('serialized' if final['actionResults'][0]['seq']<final['actionCalls'][1]['seq'] else 'overlapping')
    expected=('approved','declined') if scenario=='queue' else ('declined','approved') if scenario=='queuedecline' else ('page_changed','approved') if scenario=='queuestale' else ('approval_timeout','approval_timeout')
    effects={t['label']:effect_counts(t['label']) for t in (first,second)}
    for target,decision,result in zip((first,second),expected,current[scenario]['results']):
        effect=effects[target['label']];clicks=[e for e in effect['events'] if e.get('type')=='click']
        if decision=='approved':
            assert len(clicks)==1 and clicks[0]['isTrusted'] is True and effect['destinationRequests']==1,(target,effect,result)
        else:
            assert not effect['events'] and effect['destinationRequests']==0,(target,effect,result)
            assert (re.search(r'approval_invalid|page_changed',json.dumps(result)) if decision=='page_changed' else decision in json.dumps(result)),result
    row={'scenario':scenario,'simultaneouslyPending':len(initial['wire']['pendingIds'])==2,
         'scheduling':scheduling,'publicOrder':[next(t['label'] for t in (first,second) if ('Local '+t['label']+' test item') in json.dumps(r)) for r in final['elicitations']],
         'expectedDecisions':expected,'wire':final,'effects':effects,
         'toolResults':current[scenario]['results'],'promptObserved':True,'checkpoints':checkpoints}
    cases.append(row);preserve();print('FINISHED',scenario,json.dumps(row),flush=True)

try:
    # Prove the boundary BEFORE even public --version/help. Open-only probes
    # never create, truncate, write, or read existing profile/config contents.
    probe_paths=[root/n for n in ('config.yaml','.env','auth.json','state.db','state.db-wal','state.db-shm')]
    probe_paths += [root/'tools/facts.json',installed_source/'cli.py',facts,selected,
        generation/'workspace/uv.lock',pathlib.Path(hermes).resolve(),router,connector,host_script,*existing_leases]
    probe='''import os,socket,json
r={}
for p in %r:
 try:
  fd=os.open(p,os.O_WRONLY);os.close(fd);r[p]={'errno':None,'blocked':False}
 except OSError as e:r[p]={'errno':e.errno,'blocked':e.errno==1}
s=socket.socket();s.settimeout(1)
try:s.connect(('192.0.2.1',443));r['external']={'errno':None,'blocked':False}
except OSError as e:r['external']={'errno':e.errno,'blocked':e.errno==1}
finally:s.close()
print(json.dumps(r))
''' % ([str(p) for p in probe_paths],)
    proof=json.loads(run([sys.executable,'-c',probe]))
    dump('confinement-proof.json',{'results':proof,'beforeAnyHermesCommand':True,
        'safety':'O_WRONLY only; no create/truncate/write and no existing config/profile contents read.'})
    assert all(v['blocked'] and v['errno']==errno.EPERM for v in proof.values()),proof
    # Public capability evidence comes before configuration or chat.
    for cmd in (['--version'],['--help'],['chat','--help'],['config','--help'],['config','set','--help'],['mcp','add','--help']): run([hermes]+cmd)
    assert str(profile) in run([hermes,'config','path'])
    web=ThreadingHTTPServer(('127.0.0.1',0),Web); model=ThreadingHTTPServer(('127.0.0.1',0),Model)
    for s in (web,model): servers.append(s); threading.Thread(target=s.serve_forever,daemon=True).start()
    cdp_port=free_port(); host_port=free_port()
    endpoint_ports=[web.server_port,model.server_port,cdp_port,host_port]
    dump('owned-endpoints.json',{'loopbackPorts':endpoint_ports})
    dump('host/config.json',{'cdpUrl':f'http://127.0.0.1:{cdp_port}','port':host_port})
    browser=spawn([str(a.chrome),'--headless','--no-sandbox',f'--remote-debugging-port={cdp_port}',
        '--remote-debugging-address=127.0.0.1',f'--user-data-dir={a.out/"chromium-profile"}',
        '--window-size=1280,900','--no-first-run','--no-default-browser-check','--disable-background-networking',
        '--disable-component-update','--disable-sync','--metrics-recording-only','--disable-crashpad-for-testing',
        '--use-mock-keychain','about:blank'],'chromium')
    until(lambda:http(cdp_port,'/json/version')[0]==200)
    host=spawn([node,str(host_script),'serve'],'host',{'HERMES_VPS_BROWSER_DATA':str(runtime)})
    until(lambda:(runtime/'connection.json').exists())
    connection=json.loads((runtime/'connection.json').read_text())
    headers={'Authorization':'Bearer '+connection['token'],'X-Hermes-Bot':'vanilla-local-fixture','Content-Type':'application/json'}
    dump('host-status.json',http(host_port,'/v1/status',headers=headers))
    observer=a.out/'mcp-observer.cjs';observer.write_text(MCP_OBSERVER)
    settings={
        'model':{'default':'fixture-inert','provider':'custom:local-fixture','context_length':65536},
        'providers.local-fixture':{'api':f'http://127.0.0.1:{model.server_port}/v1','api_key':'local-fixture-placeholder',
            'transport':'chat_completions','default_model':'fixture-inert','context_length':65536,'discover_models':False},
        'toolsets':[], 'memory.memory_enabled':False,'memory.user_profile_enabled':False,
        'tools.tool_search.enabled':a.tool_search,
        'approvals.timeout':20,'display.bell_on_prompt':False,'display.bell_on_complete':False,
        'mcp_servers.workspace_browser':{'command':node,'args':[str(observer),str(a.out/'mcp-wire.jsonl'),node,str(router),'--bot-id','vanilla-local-fixture',
            '--bot-name','Local fixture','--vps-script',str(connector),'--vps-connection',str(runtime/'connection.json'),
            '--mac-state-file',str(runtime/'mac-state.json')],
            'env':{'HERMES_ROUTER_APPROVAL_MS':'15000','ALANS_WAY_AGENTS':str(a.plugin)},'timeout':45,'connect_timeout':20,
            'elicitation':{'enabled':True,'timeout':20}}}
    for key,value in settings.items(): run([hermes,'config','set',key,value if isinstance(value,str) else json.dumps(value)])
    shutil.copyfile(profile/'config.yaml',a.out/'effective-config.yaml')
    dump('runtime.json',{'hermes':hermes,'node':node,'chrome':str(a.chrome),'desktop':str(a.desktop),
        'plugin':str(a.plugin),'profile':str(profile),'webPort':web.server_port,'modelPort':model.server_port,
        'hostPort':host_port,'cdpPort':cdp_port,'modelLabel':'deterministic inert model-fixture transport',
        'interface':a.interface,'toolSearch':a.tool_search,'fixtureArgv':sys.argv,
        'sourceHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
            (pathlib.Path(__file__).resolve(),router,connector,host_script)}})
    master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',48,170,0,0))
    def session():
        os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
    argv=sandbox+[hermes,'chat','--'+a.interface]+(['--native'] if a.interface=='tui' else [])+['--ignore-rules','--max-turns','8']
    child=subprocess.Popen(argv,cwd=work,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=session)
    os.close(slave); processes.append(('hermes-cli',child)); dump('owned-processes.json',[{'name':n,'pid':c.pid} for n,c in processes])
    wait_text('No thanks',seconds=60); pump(.5)
    send(b'\r','Confirm default No thanks on first-run metrics consent')
    wait_text('ready' if a.interface=='tui' else 'fixture-inert',seconds=60); pump(2)
    print('CLI STARTED; transcript:',a.out/'transcript.txt',flush=True)
    for scenario in a.scenarios.split(','):
        start=len(raw); before=len(events); hbefore=len(hits);since=time.time()
        send(('FIXTURE '+scenario).encode(),'type '+scenario)
        pump(.2); send(b'\r','submit '+scenario)
        wait_text('Allow once',start,60,required='Local '+scenario+('a' if scenario.startswith('queue') else '')+' test item',settled_marker='MODEL_FIXTURE_DONE '+scenario)
        # Keep the real prompt visible before answering, then save the actual text.
        pump(.5); (a.out/(scenario+'-pending.txt')).write_text(plain(start))
        print('PENDING',scenario,plain()[-1800:],flush=True)
        if scenario.startswith('queue'):
            run_queue(scenario,start,since)
            continue
        if scenario=='timeout':
            pass
        elif scenario=='cancel': send(b'\x1b','Escape pending approval')
        elif scenario=='decline':
            send(b'4' if a.interface=='tui' else b'3','Select visible Deny using documented numeric quick-pick')
        elif scenario=='stale':
            # The inert page performs an ordinary self-refresh while consent is pending.
            # No trusted host action, input, receipt, or MCP wire is altered.
            refresh_requested.add('stale')
            until(lambda:len([h for h in hits if h['path']=='/review/stale'])==2)
            pump(.3)
            dump('stale-ordinary-reload.json',{'pageSelfRefresh':True,'reviewGets':len([h for h in hits if h['path']=='/review/stale'])})
            send(b'\r','Allow once after ordinary reload')
        elif scenario=='session': send(b'2','Select visible session option using documented numeric quick-pick')
        else: send(b'\r','Allow once pending approval')
        wait_text('MODEL_FIXTURE_DONE '+scenario,start,60); pump(1)
        row={'scenario':scenario,'events':events[before:],'httpHits':hits[hbefore:],
            'toolResult':current.get(scenario,{}).get('result'),'promptObserved':True}
        cases.append(row); preserve(); print('FINISHED',scenario,json.dumps(row),flush=True)
        clicks=[e for e in row['events'] if e.get('type')=='click']
        target=next(e['href'] for e in current[scenario]['snapshot']['elements'] if e.get('name')=='Buy local test item')
        payments=[h for h in row['httpHits'] if h.get('path')==urlsplit(target).path]
        if scenario in ('approve','recover','session','repeat'):
            assert len(clicks)==1 and clicks[0]['isTrusted'] is True, row
            assert len(payments)==1, row
        else:
            assert not row['events'] and not payments, row
        if scenario=='stale': assert re.search(r'approval_invalid|page_changed',json.dumps(row['toolResult'])),row
        if scenario=='timeout': assert 'approval_timeout' in json.dumps(row['toolResult']),row
    dump('final-tabs.json',http(host_port,'/v1/tabs',headers=headers))
    send(b'/exit','type exit command'); pump(.2); send(b'\r','exit interactive CLI')
    until(lambda:(pump(.2),child.poll() is not None)[1],20)
    assert child.returncode==0, child.returncode
except BaseException:
    errors.append(traceback.format_exc()); dump('fixture-errors.json',errors)
    print(errors[-1],file=sys.stderr,flush=True)
finally:
    observe_processes()
    if master is not None:
        pump(.2);os.close(master);master=None
    for name,p in reversed(processes):
        if p.poll() is None:
            try: p.terminate()
            except ProcessLookupError: pass
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:p.kill()
                except ProcessLookupError:pass
                try: p.wait(timeout=30)
                except subprocess.TimeoutExpired: errors.append('Owned process has not exited: '+name+' '+str(p.pid))
        exits.append({'name':name,'pid':p.pid,'exitCode':p.returncode})
    for s in servers:s.shutdown();s.server_close()
    for f in artifacts:f.close()
    # Direct-parent exit alone is insufficient: MCP/TUI/browser descendants may
    # outlive it. Check every observed identity before deleting the owned home.
    live=observe_processes()
    for sig in (15,9):
        if not live:break
        for row in live:
            current_table=process_table();current_row=current_table.get(row['pid'])
            if current_row and current_row['started']==row['started']:
                try:os.kill(row['pid'],sig)
                except ProcessLookupError:pass
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            live=observe_processes()
            if not live:break
            time.sleep(.1)
    direct_exited=all(x['exitCode'] is not None for x in exits)
    if live:errors.append('Observed owned descendants remain; home retained: '+str([x['pid'] for x in live]))
    if unattributed_processes:errors.append('Unattributed profile/output command matches remain; home retained.')
    # Require positive handle and endpoint readback as well as observed exits.
    try:
        handles=subprocess.run(['/usr/sbin/lsof','-nP','-Fpcfn','+D',str(profile)],capture_output=True,text=True,timeout=15)
        handles_closed=handles.returncode==1 and not handles.stdout and not handles.stderr
        dump('owned-home-handles.json',{'exitCode':handles.returncode,'stdout':handles.stdout,
            'stderr':handles.stderr,'noOpenHandles':handles_closed})
    except (OSError,subprocess.SubprocessError) as exc:
        handles_closed=False;dump('owned-home-handles.json',{'error':str(exc),'noOpenHandles':False})
    endpoints=[]
    for port in endpoint_ports:
        with socket.socket() as sock:
            sock.settimeout(1)
            try:code=sock.connect_ex(('127.0.0.1',port))
            except OSError as exc:code=exc.errno
        endpoints.append({'port':port,'errno':code,'closed':code==errno.ECONNREFUSED})
    endpoints_closed=all(row['closed'] for row in endpoints)
    dump('endpoint-cleanup.json',{'endpoints':endpoints,'allClosed':endpoints_closed})
    if not handles_closed:errors.append('Owned-home handle absence is unproven; home retained.')
    if not endpoints_closed:errors.append('Owned endpoints have not positively closed; home retained.')
    try:
        leases_after={};lease_readback_disappeared=[]
        for p in sorted((root/'installs').glob('**/.leases/*')):
            try:
                digest=hashlib.sha256(p.read_bytes()).hexdigest();stat=p.stat()
                leases_after[str(p)]={'sha256':digest,'size':stat.st_size,'mtimeNs':stat.st_mtime_ns}
            except FileNotFoundError:lease_readback_disappeared.append(str(p))
    except OSError as exc:
        leases_after={'readbackError':str(exc)}
    lease_readback_ok='readbackError' not in leases_after
    owned_leases_remaining=[p for p in owned_leases if pathlib.Path(p).exists()]
    owned_leases_closed=lease_readback_ok and not owned_leases_remaining
    dump('lease-cleanup.json',{'before':lease_before,'after':leases_after,'unchanged':leases_after==lease_before,
        'positivelyOwnedLeases':owned_leases,'ownedLeasesRemaining':owned_leases_remaining,
        'ownedLeasesClosed':owned_leases_closed,
        'leasesDisappearedDuringReadback':lease_readback_disappeared,
        'unattributedNewLeases':sorted(set(leases_after)-set(lease_before)-set(owned_leases)) if lease_readback_ok else [],
        'existingLeaseChanges':{p:{'before':v,'after':leases_after.get(p)} for p,v in lease_before.items() if leases_after.get(p)!=v},
        'scope':'Snapshot-time leases are write-protected. Shared-install changes without positive ownership are reported with attribution unknown; never signaled or deleted, and do not require global quiescence.'})
    if not owned_leases_closed:errors.append('Owned lease exit/readback is unproven; home retained for review.')
    if a.borrow_default_root and direct_exited and not live and not unattributed_processes and not process_observation_failed and handles_closed and endpoints_closed and owned_leases_closed:
        shutil.copytree(profile,a.out/'hermes-home')
        shutil.rmtree(profile)
        dump('owned-home-cleanup.json',{'path':str(profile),'existsAfterCleanup':profile.exists(),
            'exportedTo':'hermes-home','directProcessesExited':direct_exited,'observedDescendantsExited':not live,
            'unattributedCommandMatches':unattributed_processes,'observationFailed':process_observation_failed,
            'noOpenHandles':handles_closed,'endpointsClosed':endpoints_closed,'ownedLeasesClosed':owned_leases_closed})
    elif a.borrow_default_root:
        errors.append('Owned home retained because cleanup proof is incomplete: '+str(profile))
    preserve()
    dump('outcome.json',{'success':not errors,'errors':errors,'cases':len(cases),
        'performance':{'startedAt':started_at,'finishedAt':time.time(),'wallSeconds':time.monotonic()-started_monotonic,
                       'modelRequests':len(model_log),'ptyBytes':len(raw)},
        'directProcessesExited':direct_exited,'observedDescendantsExited':not live,
        'unattributedCommandMatches':unattributed_processes,'processObservationFailed':process_observation_failed,
        'noOpenHandles':handles_closed,'endpointsClosed':endpoints_closed,'ownedLeasesClosed':owned_leases_closed})
sys.exit(1 if errors else 0)
