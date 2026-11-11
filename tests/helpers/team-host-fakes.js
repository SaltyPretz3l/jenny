'use strict';

// Fakes for the desktop team host tests (slice 1f-2): a `fork` with the shape of
// Electron's `utilityProcess.fork` (postMessage, kill, pid, `spawn`, `message`
// and `exit` events) whose child answers the parent channel from a script, and
// a manual timer set the supervisor can be driven with.

const { EventEmitter } = require('node:events');

const READY_ADDRESSES = Object.freeze(['192.0.2.7:4242']);

// script(child, message) runs for every message the parent posts.
function createFakeFork({ script = () => {}, spawnDelay = 'immediate' } = {}) {
  const calls = [];
  let nextPid = 7000;
  const fork = (modulePath, args, options) => {
    const child = new EventEmitter();
    nextPid += 1;
    child.pid = undefined;
    child.args = [...args];
    child.posted = [];
    child.kills = 0;
    child.exited = false;
    child.exitOnKill = true;
    child.postMessage = (message) => {
      if (child.exited) return;
      const copy = JSON.parse(JSON.stringify(message));
      child.posted.push(copy);
      script(child, copy);
    };
    child.kill = () => {
      if (child.exited) return false;
      child.kills += 1;
      if (child.exitOnKill) setImmediate(() => child.exit(1));
      return true;
    };
    child.reply = (message) => { if (!child.exited) child.emit('message', message); };
    child.exit = (code = 0) => {
      if (child.exited) return;
      child.exited = true;
      child.emit('exit', code);
      child.pid = undefined;
    };
    const pid = nextPid;
    const spawn = () => { child.pid = pid; child.emit('spawn'); };
    if (spawnDelay === 'immediate') setImmediate(spawn); else child.spawnNow = spawn;
    calls.push({ modulePath, args: [...args], options: JSON.parse(JSON.stringify(options || {})), child });
    return child;
  };
  return { fork, calls, last: () => calls[calls.length - 1]?.child ?? null };
}

// A child that behaves like a healthy host: ready on start, stopped and exit on stop.
function healthyHostScript({ teamId, publicKey = 'pk', addresses = READY_ADDRESSES, invite = null } = {}) {
  return (child, message) => {
    if (message.type === 'start') {
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'epoch-1', team_id: teamId, public_key: publicKey,
          addresses: [...addresses] });
        if (invite) setImmediate(() => child.reply({ type: 'owner_invite', invite: typeof invite === 'function' ? invite() : invite }));
      });
    }
    if (message.type === 'stop') {
      setImmediate(() => { child.reply({ type: 'stopped' }); setImmediate(() => child.exit(0)); });
    }
  };
}

const BOUNDS = Object.freeze({ stopMs: 300, killWaitMs: 300, startMs: 3_000, pingMs: 1_000, ownerInviteMs: 300 });
const DIRECT_PORT = 45123;

// A host controller over a fake fork with the test defaults; stopped after the test.
function createTestHostController(t, {
  userDataPath, secureStore, script, fork = null, service = null, platform = 'win32', isPackaged = false,
  lockPython = process.execPath,
  pickDirectPort = async () => DIRECT_PORT, probeDirectPort = async () => true, hostKeys, bounds = BOUNDS,
} = {}) {
  const { createHostController } = require('../../services/team/host/host-controller');
  const fake = fork ? null : createFakeFork({ script });
  const logs = [];
  const pushed = [];
  const controller = createHostController({
    userDataPath, getSecureStore: () => secureStore, getTeamService: () => service, platform,
    isPackaged: () => isPackaged, lockPython: () => lockPython,
    fork: fork || fake.fork, entryPath: 'C:\\app\\host-entry.js', environment: { SystemRoot: 'C:\\Windows' },
    pickDirectPort, probeDirectPort, bounds, ...(hostKeys ? { hostKeys } : {}),
    sendState: (snapshot) => pushed.push(JSON.parse(JSON.stringify(snapshot))),
    log: (level, event, fields) => logs.push({ level, event, fields: fields ?? {} }),
  });
  t.after(() => controller.stop());
  return { controller, fake, logs, pushed };
}

module.exports = { BOUNDS, DIRECT_PORT, READY_ADDRESSES, createFakeFork, createTestHostController, healthyHostScript };
