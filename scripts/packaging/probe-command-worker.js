"use strict";
// Runs as the trusted app UID in a disposable Compose project, never in a user
// deployment. The parent owns resource creation/removal; this probe owns only
// its named workspace fixtures and temporary admission receipt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ExecutionBroker } = require('/app/services/host/execution-broker');
const { requestWorker } = require('/app/services/host/worker-transport');
const { setTimeout: delay } = require('node:timers/promises');
const root = '/workspaces/default';
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const python = (code) => 'python3 -c ' + quote(code);
const broker = new ExecutionBroker({ userDataPath: '/tmp/worker-proof' });
let jobs = 0;
async function command(code, { status = 'completed', timeoutSeconds = 10 } = {}) {
  const before = await requestWorker('status');
  const result = await broker.execute({ command: python(code), timeoutSeconds }, { streamId: 'proof' });
  const after = await requestWorker('status');
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.cleanup_confirmed, true);
  assert.notEqual(before.incarnation, after.incarnation);
  assert.equal(after.phase, 'ready');
  assert.equal(after.job_id, null);
  assert.equal(after.previous_result.job_id, result.job_id);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 256 * 1024);
  jobs++;
  process.stdout.write('worker proof: ' + jobs + ' ' + status + '\n');
  return result;
}
async function main() {
  await broker.prepare();
  fs.writeFileSync(root + '/worker-proof.txt', 'durable-input', { mode: 0o600 });
  try {
    const identity = await command(`import os,json,socket,resource
assert os.getresuid()==(10001,10001,10001)
assert os.getresgid()==(10001,10001,10001)
assert os.getgroups()==[]
fields=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
assert all(int(fields[k].strip(),16)==0 for k in ['CapEff','CapPrm','CapInh','CapAmb'])
assert fields['NoNewPrivs'].strip()=='1'
assert set(os.environ)<=set(['PATH','HOME','LANG','LC_ALL','PWD'])
for item in os.listdir('/proc/self/fd'):
 try: target=os.readlink('/proc/self/fd/'+item)
 except FileNotFoundError: continue
 assert not any(x in target for x in ['jenny-worker','controller.key','/data','jenny-secrets'])
for path in ['/run/jenny-worker/controller.key','/run/jenny-worker/control.sock','/proc/1/environ','/data/auth.json','/run/jenny-secrets/model-api-key','/var/run/docker.sock']:
 try: fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK)
 except OSError: pass
 else: os.close(fd); raise AssertionError(path)
try: os.setuid(0)
except PermissionError: pass
else: raise AssertionError('regained root')
assert [name for _,name in socket.if_nameindex()]==['lo']
s=socket.socket(); s.settimeout(1); assert s.connect_ex(('1.1.1.1',443))!=0
assert open('worker-proof.txt').read()=='durable-input'
open('worker-proof.txt','w').write('discarded')
try: open('/inputs/worker-proof.txt','w').write('forbidden')
except OSError: pass
else: raise AssertionError('inputs writable')
assert resource.getrlimit(resource.RLIMIT_NOFILE)==(256,256)
assert resource.getrlimit(resource.RLIMIT_FSIZE)==(67108864,67108864)
print('identity, capabilities, environment, FDs, protected paths, network and read-only inputs passed')`);
    assert.match(identity.stdout, /protected paths/);
    assert.equal(fs.readFileSync(root + '/worker-proof.txt', 'utf8'), 'durable-input');
    await command(`import os
assert open('worker-proof.txt').read()=='durable-input'
# Detached descendants must not survive this command's terminal receipt.
pid=os.fork()
if pid==0:
 os.setsid()
 if os.fork()>0: os._exit(0)
 import time; time.sleep(115); os._exit(0)
print('detached descendant created',flush=True)`);
    const timeout = await command('import time; time.sleep(115)', { timeoutSeconds: 0.5, status: 'timed_out' });
    assert.notEqual(timeout.exit_code, 0);
    const before = await requestWorker('status');
    const controller = new AbortController();
    const start = Date.now();
    const pending = broker.execute({ command: 'sleep 115', timeoutSeconds: 120 }, { signal: controller.signal, streamId: 'cancel' });
    for (let i = 0; i < 50; i++) {
      if ((await requestWorker('status')).phase === 'running') break;
      await delay(50);
    }
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled');
    assert.notEqual((await requestWorker('status')).incarnation, before.incarnation);
    assert.ok(Date.now() - start < 25000, 'cancellation ignored until original timeout');
    process.stdout.write('worker proof: cancellation and recycled namespace passed\n');
    const output = await command("import os; os.write(1,b'\\xff'*400000)", { status: 'output_limit' });
    assert.equal(output.output_truncated, true);
    await command(`import os,errno
# Per-file limit, total tmpfs bytes and inode bounds are real filesystem limits.
try:
 with open('too-large','wb') as f: f.truncate(67108865)
except OSError as e: assert e.errno==errno.EFBIG
else: raise AssertionError('file limit absent')
os.unlink('too-large')
count=0
try:
 while count<12:
  with open('fill-'+str(count),'wb') as f:
   for _ in range(8): f.write(b'x'*8388608)
  count+=1
except OSError as e: assert e.errno==errno.ENOSPC
else: raise AssertionError('byte limit absent')
for item in os.listdir('.'):
 if item.startswith('fill-'): os.unlink(item)
count=0
try:
 while count<17000:
  with open('inode-'+str(count),'wb'): pass
  count+=1
except OSError as e: assert e.errno==errno.ENOSPC
else: raise AssertionError('inode limit absent')
print('tmpfs byte and inode limits enforced',count)`, { timeoutSeconds: 30 });
    await command(`import subprocess,errno
children=[]
try:
 while len(children)<140: children.append(subprocess.Popen(['sleep','115']))
except OSError as e: assert e.errno==errno.EAGAIN
else: raise AssertionError('PID limit absent')
print('PID limit enforced',len(children),flush=True)`, { timeoutSeconds: 10 });
    fs.symlinkSync('/etc/passwd', root + '/worker-proof-link');
    const rejected = await command("print('must-not-run')", { status: 'failed' });
    assert.doesNotMatch(rejected.stdout, /must-not-run/);
    fs.unlinkSync(root + '/worker-proof-link');
    await broker.close();
    process.stdout.write('Real offline command worker proof passed.\n');
  } finally {
    for (const name of ['worker-proof.txt','worker-proof-link']) {
      try { fs.unlinkSync(root + '/' + name); } catch (error) { if (error.code !== 'ENOENT') { console.error('fixture_cleanup_failed'); process.exitCode = 1; } }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
