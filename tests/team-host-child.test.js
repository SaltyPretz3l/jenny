'use strict';

// Slice 1f-2 integration: the desktop host controller starts a REAL team host
// as a child process over the `process.send` carrier, with the real bridge
// binary (loopback only: tests/helpers/team-host-child-entry.js), a config the
// desktop wrote itself and the key sent on the channel. The owner's own Jenny
// then joins its host through the real member bridge (self-dial on loopback).
// Stop is `stop`, `stopped`, exit, and no process is left. A stray child is
// ended only through the handle this test holds.
//
// Skipped, with the reason printed, when jenny-team-bridge is not built in this
// checkout, or on a platform other than Windows and Linux. The host has no
// model endpoint and starts no sidecar (owner decision E19).

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createHostController } = require('../services/team/host/host-controller');
const { createTeamService } = require('../services/team/team-service');
const { spawnBridgeChild } = require('../server/team/transport/control-channel');
const { findTeamBridgeBinary, forceLoopbackOnly } = require('./server/helpers/team-bridge-binary');
const { createMemorySecureStore, readTree, tempProfile, waitUntil } = require('./helpers/team-client-host');

const ENTRY = path.join(__dirname, 'helpers', 'team-host-child-entry.js');

function skipReason() {
  if (process.platform !== 'win32' && process.platform !== 'linux') return `team host runs on Windows and Linux only (${process.platform})`;
  const binary = findTeamBridgeBinary();
  if (!binary) return 'jenny-team-bridge is not built (build/sidecar or native/jenny-team-bridge/target)';
  const probe = childProcess.spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (probe.status !== 0 || !/protocol 1/.test(probe.stdout || '')) return 'jenny-team-bridge does not report "protocol 1"';
  if (process.platform === 'linux' && !fs.existsSync(path.join(__dirname, '..', '.venv', 'bin', 'python'))) {
    return 'no .venv in this checkout (the Linux profile lock needs Python)';
  }
  return null;
}

const SKIP = skipReason();
if (SKIP) process.stdout.write(`# team-host-child: skipped: ${SKIP}\n`);

// child_process.fork shaped like utilityProcess.fork: postMessage, kill, pid, spawn/message/exit.
function nodeFork(children) {
  return (modulePath, args, options) => {
    const child = childProcess.fork(modulePath, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true, serialization: 'json' });
    const handle = new EventEmitter();
    children.push(child);
    child.stdout.on('data', (chunk) => { handle.output = (handle.output || '') + chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { handle.output = (handle.output || '') + chunk.toString('utf8'); });
    child.on('spawn', () => handle.emit('spawn'));
    child.on('message', (message) => handle.emit('message', message));
    child.on('exit', (code) => handle.emit('exit', code ?? 1));
    child.on('error', () => {});
    handle.postMessage = (message) => { if (child.connected) child.send(message, () => {}); };
    handle.kill = () => child.kill();
    Object.defineProperty(handle, 'pid', { get: () => (child.exitCode === null && child.signalCode === null ? child.pid : undefined) });
    return handle;
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The PIDs of `pid`'s direct children whose image name contains `name` (read-only OS queries).
function childPids(pid, name) {
  if (process.platform === 'win32') {
    const query = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
    const out = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).stdout || '';
    return out.split(/\r?\n/u).map((line) => line.trim().split(' ')).filter(([id, image]) => id && image?.includes(name)).map(([id]) => Number(id));
  }
  return fs.readdirSync('/proc').filter((entry) => /^\d+$/u.test(entry)).filter((entry) => {
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(fields[1]) === pid && stat.includes(name.slice(0, 15));
    } catch { return false; }
  }).map(Number);
}

// The Linux profile lock's interpreter: this checkout's .venv (Windows needs none).
function lockPython() {
  const local = path.join(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return fs.existsSync(local) ? local : null;
}

// The supervisor's stop bound is 8 s inside the app's 15 s shutdown budget; a real stop must fit well inside it.
const STOP_BOUND_MS = 6_000;

test('a real team host child: Deploy, ready, the owner joins over loopback, stop, stopped, exit, nothing left',
  { skip: SKIP || false, timeout: 120_000 }, async (t) => {
    const binary = findTeamBridgeBinary();
    const userDataPath = tempProfile(t, 'jenny-host-child-');
    const secureStore = createMemorySecureStore();
    const logs = [];
    const children = [];
    const memberSpawn = (mode) => forceLoopbackOnly(spawnBridgeChild(mode, { binaryPath: binary }));
    const service = createTeamService({ userDataPath, getSecureStore: () => secureStore, spawnChild: memberSpawn,
      appVersion: '1.6.1', log: (level, event, fields) => logs.push({ level, event, fields }), requestTimeoutMs: 15_000 });
    const controller = createHostController({
      userDataPath, getSecureStore: () => secureStore, getTeamService: () => service, platform: process.platform,
      isPackaged: () => false, fork: nodeFork(children), entryPath: ENTRY,
      environment: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), JENNY_TEST_TEAM_BRIDGE: binary },
      lockPython,
      log: (level, event, fields) => logs.push({ level, event, fields }),
    });
    t.after(async () => {
      await service.stopAll().catch(() => {});
      await controller.stop().catch(() => {});
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    });

    let captured = null;
    const ownerJoin = service.ownerJoin;
    service.ownerJoin = (payload) => { captured = payload.invite; return ownerJoin(payload); };
    const deployBegun = Date.now();
    const deployed = await controller.handle('hostDeploy', { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
    t.diagnostic(`Deploy (host start, ready, owner join) took ${Date.now() - deployBegun} ms`);
    const output = () => children.map((child) => child.spawnargs.join(' ')).join('\n');
    assert.equal(deployed.ok, true, `${JSON.stringify(deployed)}\n${output()}`);
    assert.equal(deployed.host.state, 'running');
    assert.equal(deployed.owner.state, 'joined', JSON.stringify(deployed.owner));
    const teamId = deployed.owner.team_id;
    assert.equal(deployed.host.team_id, teamId);
    assert.ok(await waitUntil(() => service.snapshot().teams.some((team) => team.team_id === teamId && team.state === 'online'),
      { attempts: 300, interval: 50 }), JSON.stringify(service.snapshot()));
    assert.equal(service.snapshot().teams[0].role, 'owner');
    const pid = children[0].pid;
    assert.equal(alive(pid), true);

    const stopBegun = Date.now();
    const stopped = await controller.handle('hostStop', {});
    const stopMs = Date.now() - stopBegun;
    t.diagnostic(`team host stop took ${stopMs} ms`);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.host.state, 'stopped');
    assert.equal(stopped.host.reason, null, 'stopped in time, not ended by the handle');
    assert.ok(stopMs < STOP_BOUND_MS, `the stop took ${stopMs} ms`);
    assert.ok(await waitUntil(() => !alive(pid), { attempts: 100, interval: 50 }), 'the host process is gone');
    assert.notEqual(children[0].exitCode, null);
    assert.deepEqual(controller.resources(), { child: false, timers: 0, childListeners: 0 });

    // A host that dies without a stop takes its bridge with it: the bridge's stdin closes.
    const again = await controller.handle('hostDeploy', { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
    assert.equal(again.ok, true, JSON.stringify(again));
    const hostPid = children[1].pid;
    const bridges = childPids(hostPid, 'jenny-team-bridge');
    assert.equal(bridges.length, 1, `one bridge child of the host: ${JSON.stringify(bridges)}`);
    process.kill(hostPid);
    assert.ok(await waitUntil(() => !alive(hostPid), { attempts: 100, interval: 50 }), 'the host is gone');
    const bridgeBegun = Date.now();
    assert.ok(await waitUntil(() => !alive(bridges[0]), { attempts: 200, interval: 50 }), 'the bridge exits with its parent');
    t.diagnostic(`the bridge exited ${Date.now() - bridgeBegun} ms after its host was killed`);
    assert.ok(await waitUntil(() => controller.snapshot().state === 'failed', { attempts: 100, interval: 50 }));
    assert.equal(controller.snapshot().reason, 'team_host_exited');

    // The key never reached a file, an argument or the environment; the invite never reached a file.
    const key = secureStore.values.get('team_host_key');
    assert.equal(children[0].spawnargs.join(' ').includes(key), false);
    for (const file of readTree(userDataPath)) assert.equal(file.text.includes(key), false, file.path);
    assert.equal(typeof captured, 'string');
    for (const file of readTree(userDataPath)) assert.equal(file.text.includes(captured), false, `${file.path} holds the invite`);
    assert.equal(JSON.stringify(logs).includes(key), false);
    assert.equal(JSON.stringify(logs).includes(captured), false);
  });

// The production entry (services/team/host/host-entry.js) as a real child over the Node carrier:
// its argument parsing, server/main.js, the parent channel and its own exit. The stop is sent
// before the key: the channel keeps their order, so the start is cancelled before the bridge is
// spawned and no binary or socket is needed. (A stop sent after the key raced the start: on
// Windows the child can read it ~200 ms later, once a bridge spawn has already failed.)
test('host-entry.js: a real child takes --config, the key on the channel, stops on stop and exits by itself',
  { skip: process.platform === 'win32' || process.platform === 'linux' ? false : 'Windows and Linux only', timeout: 60_000 },
  async (t) => {
    const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('../services/team/host/host-layout');
    const { HOST_ENTRY, hostEnvironment } = require('../services/team/host/host-launch');
    const userDataPath = tempProfile(t, 'jenny-host-entry-');
    const layout = prepareHostLayout(userDataPath);
    const python = path.join(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (process.platform === 'linux' && !fs.existsSync(python)) { t.skip('no .venv (the Linux profile lock needs Python)'); return; }
    writeHostConfig(layout, buildHostConfig({ layout, name: 'Studio', directPort: null,
      lockPython: process.platform === 'linux' ? python : null }));
    const key = require('node:crypto').randomBytes(32).toString('base64url');
    const child = childProcess.fork(HOST_ENTRY, ['--config', layout.configPath], { env: hostEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    const messages = [];
    child.on('message', (message) => messages.push(message));
    const exited = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); });
    await new Promise((resolve) => { child.once('spawn', resolve); });
    child.send({ type: 'stop' });
    child.send({ type: 'start', host_key: key });
    let timer;
    const code = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 30_000); })]);
    clearTimeout(timer);
    assert.notEqual(code, 'timeout', `the child did not exit by itself
${output}`);
    assert.deepEqual(messages, [{ type: 'stopped' }], output);
    assert.equal(alive(child.pid), false);
    assert.equal(output.includes(key), false, 'the key is in no log line');
    assert.equal(child.spawnargs.join(' ').includes(key), false);
  });
