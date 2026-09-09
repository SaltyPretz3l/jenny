'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DockerLauncher } = require('../../services/execution/docker-launcher');
const { DesktopSandboxService } = require('../../services/execution/desktop-sandbox-service');
async function probe() {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-worker-probe-'));
 const workspace = path.join(directory, 'workspace');
 const profile = path.join(directory, 'profile');
 await fs.mkdir(workspace); await fs.mkdir(profile);
 await fs.writeFile(path.join(workspace, 'source.txt'), 'immutable input');
 const config = new EventEmitter();
 config.getState = () => ({ commandSandbox: { enabled: true }, toolsWorkspaceRoot: workspace });
 const service = new DesktopSandboxService({ userDataPath: profile, sourceRoot: path.resolve(__dirname, '../..'), configService: config, launcherFactory: options => new DockerLauncher(options) });
 service.on('changed', state => console.log(JSON.stringify({ state })));
 console.log(JSON.stringify({ probeDirectory: directory }));
 try {
  await service.start();
  if (service.state !== 'ready') throw new Error(service.reason);
  let sequence = 0;
  const run = async (name, command, timeoutSeconds = 10, signal = null, authorize = async () => ({ approved: true, digest: 'qualification', validate() {} })) => {
   const result = await service.execute({ command, cwd: '.', timeoutSeconds },
    { sessionId: 'qualification', streamId: name, callId: String(++sequence), isLive: () => true, signal }, authorize);
   console.log(JSON.stringify({ case: name, status: result.status, exit_code: result.exit_code,
    cleanup_confirmed: result.cleanup_confirmed, output_bytes: Buffer.byteLength(result.stdout + result.stderr), stdout: result.stdout.slice(0, 2000) }));
   if (!result.cleanup_confirmed) throw new Error(name + ': cleanup unconfirmed');
   return result;
  };
  const assert = require('node:assert/strict');
  const success = await run('isolation', `id; cat source.txt; printf disposable > created.txt; python3 -c 'import os,socket; assert not os.path.exists("/var/run/docker.sock"); assert os.getuid()==10001; assert not os.access("/run/jenny-worker/controller.key",os.R_OK); s=socket.socket(); s.settimeout(1); assert s.connect_ex(("1.1.1.1",443))!=0; print("offline and control inaccessible")'`);
  assert.equal(success.exit_code, 0);
  assert.equal(await fs.stat(path.join(workspace, 'created.txt')).then(() => true, () => false), false);
  if (process.argv.includes('--smoke')) return;
  assert.equal((await run('timeout', 'sleep 30', 0.5)).status, 'timed_out');
  assert.equal((await run('output', `python3 -c 'import os; os.write(1,b"x"*300000)'` )).status, 'output_limit');
  assert.equal((await run('descendants', `python3 -c 'import subprocess; subprocess.Popen(["sleep","90"],start_new_session=True); print("detached")'` )).status, 'completed');
  const controller = new AbortController();
  const cancel = run('cancel', 'sleep 90', 120, controller.signal, async () => {
   setTimeout(() => controller.abort(), 2000);
   return { approved: true, digest: 'qualification', validate() {} };
  });
  assert.equal((await cancel).status, 'cancelled');
  const storage = await run('storage', `python3 -c 'from pathlib import Path; p=Path("/tmp/fill"); f=p.open("wb"); f.write(b"x"*(64*1024*1024)); f.write(b"z"*1024); f.flush()'`, 20);
  assert.notEqual(storage.exit_code, 0);
  const pids = await run('pids', `python3 -c 'import subprocess; children=[];
try:
 while True: children.append(subprocess.Popen(["sleep","90"]))
except OSError: print("pid limit",len(children)); assert len(children)<128'`, 20);
  assert.equal(pids.exit_code, 0);
  const memory = await run('memory', `python3 -c 'a=[];
while True: a.append(bytearray(64*1024*1024))'`, 20);
  assert.notEqual(memory.exit_code, 0);
  await service.close();
  const restarted = new DesktopSandboxService({ userDataPath: profile, sourceRoot: path.resolve(__dirname, '../..'), configService: config });
  try { await restarted.start(); assert.equal(restarted.state, 'ready'); }
  finally { await restarted.close(); }
  console.log(JSON.stringify({ qualification: 'passed', platform: process.platform, probeDirectory: directory }));
 } finally { await service.close(); }
}
async function recoveryChild(directory) {
 const config = new EventEmitter();
 config.getState = () => ({ commandSandbox: { enabled: true }, toolsWorkspaceRoot: path.join(directory, 'workspace') });
 const service = new DesktopSandboxService({ userDataPath: path.join(directory, 'profile'), sourceRoot: path.resolve(__dirname, '../..'), configService: config });
 await service.start();
 if (service.state !== 'ready') throw new Error(service.reason);
 const append = service.receipts.append.bind(service.receipts);
 service.receipts.append = (...args) => {
  append(...args);
  if (args[0] === 'admitted') setTimeout(() => process.send({ admitted: true }), 2000);
 };
 await service.execute({ command: 'sleep 90', timeoutSeconds: 120 },
  { sessionId: 'crash', streamId: 'crash', callId: 'crash' },
  async () => ({ approved: true, digest: 'qualification', validate() {} }));
 throw new Error('crash fixture unexpectedly completed');
}
async function probeRecovery() {
 const assert = require('node:assert/strict');
 for (const journal of ['intact', 'missing', 'torn']) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-worker-recovery-'));
  await fs.mkdir(path.join(directory, 'workspace')); await fs.mkdir(path.join(directory, 'profile'));
  const child = require('node:child_process').fork(__filename, ['--crash-child', directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
   await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('crash fixture timeout')), 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('crash fixture exited early')); });
    child.once('message', () => { clearTimeout(timer); resolve(); });
   });
   const exited = new Promise(resolve => child.once('exit', resolve));
   child.kill(); await exited;
   const file = path.join(directory, 'profile', 'command-sandbox', 'execution.jsonl');
   if (journal === 'missing') await fs.unlink(file);
   if (journal === 'torn') await fs.appendFile(file, '{torn');
   const config = new EventEmitter();
   config.getState = () => ({ commandSandbox: { enabled: true }, toolsWorkspaceRoot: path.join(directory, 'workspace') });
   const successor = new DesktopSandboxService({ userDataPath: path.join(directory, 'profile'), sourceRoot: path.resolve(__dirname, '../..'), configService: config });
   try {
    await successor.start(); assert.equal(successor.state, 'ready', successor.reason);
    assert.equal(successor.receipts.pending().length, 0);
    assert.deepEqual(await successor.launcher.listOwned(), []);
    console.log(JSON.stringify({ recovery: journal, status: 'passed', directory }));
   } finally { await successor.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
 }
}
async function probeWire() {
 const assert = require('node:assert/strict');
 const { randomUUID, randomBytes } = require('node:crypto');
 const { encodeEnvelope } = require('../../services/execution/worker-protocol');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-worker-wire-'));
 const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace);
 const config = new EventEmitter();
 config.getState = () => ({ commandSandbox: { enabled: true }, toolsWorkspaceRoot: workspace });
 const service = new DesktopSandboxService({ userDataPath: path.join(directory, 'profile'), sourceRoot: path.resolve(__dirname, '../..'), configService: config });
 let worker;
 try {
  await service.start(); assert.equal(service.state, 'ready', service.reason);
  const snapshot = await require('../../services/execution/desktop-workspace-snapshot').createWorkspaceSnapshot({ root: workspace, stagingRoot: service.stagingRoot });
  worker = await service._worker(snapshot);
  const status = await worker.transport.request('status');
  const request = { schema_version: 1, request_id: randomUUID(), operation: 'status' };
  for (const wire of [Buffer.from('{}\n'), Buffer.from(encodeEnvelope(request, randomBytes(32))), Buffer.from(encodeEnvelope(request, worker.transport.key) + 'extra\n')]) {
   await assert.rejects(service.launcher.relay(worker.containerId, 'request', wire));
  }
  const inspected = await service.launcher.inspect(worker.containerId);
  console.log(JSON.stringify({ declaredMounts: inspected.HostConfig.Mounts, sourceMounts: inspected.Mounts.filter(m => m.Type === 'bind'), rootReadonly: inspected.HostConfig.ReadonlyRootfs }));
  const binding = { incarnation: status.incarnation, job_id: randomUUID() };
  await worker.transport.request('submit', { ...binding, command: 'echo once >> counter; sleep 3; cat counter', cwd: '.', timeout_seconds: 8 });
  assert.equal((await worker.transport.request('submit', { ...binding, command: 'echo once >> counter; sleep 3; cat counter', cwd: '.', timeout_seconds: 8 })).accepted, true);
  await assert.rejects(worker.transport.request('submit', { ...binding, job_id: randomUUID(), command: 'echo wrong', cwd: '.', timeout_seconds: 8 }));
  const settled = await worker.broker._settled(binding);
  assert.equal(settled.stdout.trim(), 'once');
  await assert.rejects(worker.transport.request('submit', { ...binding, command: 'echo once >> counter; sleep 3; cat counter', cwd: '.', timeout_seconds: 8 }));
  console.log(JSON.stringify({ wireAuthenticationFramingAndDuplicate: 'passed', directory }));
 } finally {
  worker?.transport.dispose(); await service.close();
 }
}
if (require.main === module) {
 const operation = process.argv[2] === '--crash-child' ? recoveryChild(process.argv[3])
  : process.argv[2] === '--recovery' ? probeRecovery()
    : process.argv[2] === '--wire' ? probeWire() : probe();
 operation.catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { probe, probeRecovery };
