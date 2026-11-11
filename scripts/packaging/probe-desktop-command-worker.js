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
 const authority = Object.freeze({ project_id: 'probe', root_path: workspace, root_id: 'root', root_revision: 0, device_id: null, inode: null });
 const service = new DesktopSandboxService({ userDataPath: profile, sourceRoot: path.resolve(__dirname, '../..'), configService: config, launcherFactory: options => new DockerLauncher(options),
  getBackend: () => ({ projectAuthority: { captureSession: () => authority, requireCurrent: () => {} } }) });
 service.on('changed', state => console.log(JSON.stringify({ state })));
 console.log(JSON.stringify({ probeDirectory: directory }));
 try {
  await service.start();
  if (service.state !== 'ready') throw new Error(service.reason);
  let sequence = 0;
  const run = async (name, command, timeoutSeconds = 10, signal = null, authorize = async () => ({ approved: true, digest: 'qualification', validate() {} })) => {
   const result = await service.execute({ command, cwd: '.', timeoutSeconds },
    { sessionId: 'qualification', streamId: name, callId: String(++sequence), isLive: () => true, signal, projectAuthority: authority }, authorize);
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
  await worker.transport.request('submit', { ...binding, command: 'echo once >> counter; sleep 3; cat counter', cwd: '.', input_root: '.', timeout_seconds: 8 });
  assert.equal((await worker.transport.request('submit', { ...binding, command: 'echo once >> counter; sleep 3; cat counter', cwd: '.', input_root: '.', timeout_seconds: 8 })).accepted, true);
  await assert.rejects(worker.transport.request('submit', { ...binding, job_id: randomUUID(), command: 'echo wrong', cwd: '.', input_root: '.', timeout_seconds: 8 }));
  const settled = await worker.broker._settled(binding);
  assert.equal(settled.stdout.trim(), 'once');
  await assert.rejects(worker.transport.request('submit', { ...binding, command: 'echo once >> counter; sleep 3; cat counter', cwd: '.', input_root: '.', timeout_seconds: 8 }));
  console.log(JSON.stringify({ wireAuthenticationFramingAndDuplicate: 'passed', directory }));
 } finally {
  worker?.transport.dispose(); await service.close();
 }
}
// Row 106 S5 (`--synced`): Synced workspace round trip on a disposable git workspace (edit/create/delete,
// protected aliases and links refused, a conflict kept, the restore point pinned, delta timing).
async function probeSynced() {
 const assert = require('node:assert/strict');
 const { execFileSync } = require('node:child_process');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-worker-synced-'));
 const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace);
 const git = (...args) => execFileSync('git', ['-C', workspace, '-c', 'user.name=probe', '-c', 'user.email=probe@invalid', ...args], { encoding: 'utf8' });
 await fs.writeFile(path.join(workspace, 'a.txt'), 'one');
 await fs.writeFile(path.join(workspace, 'del.txt'), 'bye');
 git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'probe');
 const gitConfig = await fs.readFile(path.join(workspace, '.git', 'config'));
 const config = new EventEmitter();
 config.getState = () => ({ commandSandbox: { enabled: true, mode: 'synced' }, toolsWorkspaceRoot: workspace });
 // A fixed project authority stands in for the chat's canonical capture (the root never changes here).
 const authority = Object.freeze({ project_id: 'probe', root_path: workspace, root_id: 'root', root_revision: 0, device_id: null, inode: null });
 const projectAuthority = { captureSession: () => authority, requireCurrent: () => {} };
 const service = new DesktopSandboxService({ userDataPath: path.join(directory, 'profile'), sourceRoot: path.resolve(__dirname, '../..'), configService: config,
  getBackend: () => ({ projectAuthority }) });
 const approve = async () => ({ approved: true, digest: 'qualification', validate() {} });
 let sequence = 0;
 const run = async (name, command, authorize = approve) => {
  const started = Date.now();
  const result = await service.execute({ command, cwd: '.', timeoutSeconds: 30 },
   { sessionId: 'qualification', streamId: name, callId: String(++sequence), isLive: () => true, projectAuthority: authority }, authorize);
  const writeBack = result.synced?.write_back || {};
  console.log(JSON.stringify({ case: name, ms: Date.now() - started, status: result.status, exit_code: result.exit_code,
   write_back: writeBack.status, applied: (writeBack.applied || []).map(e => e.path), refused: writeBack.refused, restore_point: result.synced?.restore_point?.ref }));
  assert.equal(result.cleanup_confirmed, true, name);
  return { result, writeBack };
 };
 try {
  await service.start(); assert.equal(service.state, 'ready', service.reason);
  assert.equal(service.getState().mode, 'synced');
  const edit = await run('round_trip', 'printf two > a.txt; printf new > new.txt; rm del.txt; mkdir -p sub && printf y > sub/y.txt');
  assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'two');
  assert.equal(await fs.readFile(path.join(workspace, 'sub', 'y.txt'), 'utf8'), 'y');
  assert.equal(await fs.stat(path.join(workspace, 'del.txt')).then(() => true, () => false), false);
  assert.match(git('show-ref', edit.result.synced.restore_point.ref), /refs\/jenny\/sandbox\//);
  const refused = await run('refusals', "mkdir -p .GIT && printf evil > .GIT/config; ln -s /etc/passwd link; printf x > 'NUL.txt'; mkdir -p node_modules/x && printf x > node_modules/x/i.js");
  assert.deepEqual(await fs.readFile(path.join(workspace, '.git', 'config')), gitConfig);
  for (const name of ['link', 'NUL.txt', 'node_modules']) assert.equal(await fs.lstat(path.join(workspace, name)).then(() => true, () => false), false, name);
  assert.ok(refused.writeBack.refused.length >= 3);
  const conflict = await run('conflict', 'sleep 8; printf sandbox > a.txt', async () => {
   setTimeout(() => { fs.writeFile(path.join(workspace, 'a.txt'), 'host').catch(() => {}); }, 4000);
   return approve();
  });
  assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'host');
  assert.ok(conflict.writeBack.refused.some(e => e.path === 'a.txt' && e.reason === 'conflict'));
  await run('delta_noop', 'true');
  console.log(JSON.stringify({ synced: 'passed', probeDirectory: directory }));
 } finally { await service.close(); }
}
if (require.main === module) {
 const operation = process.argv[2] === '--crash-child' ? recoveryChild(process.argv[3])
  : process.argv[2] === '--recovery' ? probeRecovery()
    : process.argv[2] === '--wire' ? probeWire()
      : process.argv[2] === '--synced' ? probeSynced() : probe();
 operation.catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { probe, probeRecovery, probeSynced };
