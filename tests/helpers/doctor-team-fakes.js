'use strict';

// Fakes for `jenny doctor --team` (tests/cli/commands.test.js): a bridge child, a clock that
// jumps, the team effects handed through main, and a CLI host at createCliHost's seam.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { CLI_PROFILE_ERROR_CODES } = require('../../services/cli-host/profile-lock');

const FAKE_BRIDGE = path.join('fake-install', 'resources', 'sidecar', 'jenny-team-bridge');

// A bridge child. By default it prints `stdout`, then emits 'exit' and 'close' with `code`;
// `late` sends the data after 'exit' (stdio can outlive it), `hang` never ends, `errors` emits
// that many 'error' events and nothing else.
function fakeChild({ code = 0, stdout = 'jenny-team-bridge protocol 1\n', hang = false, late = false, errors = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.destroyed = 0;
  child.stdout.destroy = () => { child.stdout.destroyed += 1; };
  child.killed = 0;
  child.unrefs = 0;
  child.kill = () => { child.killed += 1; return true; };
  child.unref = () => { child.unrefs += 1; };
  if (hang) return child;
  setImmediate(() => {
    if (errors) { for (let index = 0; index < errors; index += 1) child.emit('error', new Error('spawn EACCES')); return; }
    if (!late && stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('exit', code);
    if (late && stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

// A clock that jumps: a timer whose delay is in `fire` runs at once (logged in `events`), every
// other one never does. Sets and clears are counted.
function fakeTimers(fire = [], events = []) {
  const timers = {
    sets: 0,
    clears: 0,
    setTimeout(fn, ms) {
      timers.sets += 1;
      if (fire.includes(ms)) setImmediate(() => { events.push(`fire:${ms}`); fn(); });
      return { ms };
    },
    clearTimeout() { timers.clears += 1; },
  };
  return timers;
}

// The effects runTeamDoctor takes, all fake; `seen` records what each was asked.
function teamFakes(overrides = {}) {
  const seen = { resolved: [], spawned: [], statfs: [], probes: 0, stops: 0, children: [], events: [] };
  const deps = {
    resolveBinary: (where) => { seen.resolved.push(where); return overrides.noBinary ? null : FAKE_BRIDGE; },
    spawnChild: (file, args, options) => {
      seen.spawned.push({ file, args, options });
      const made = fakeChild(overrides.child);
      seen.children.push(made);
      return made;
    },
    timers: fakeTimers(overrides.fire, seen.events),
    statfs: (target) => {
      seen.statfs.push(target);
      if (overrides.statfsThrows) throw new Error('EPERM: statfs');
      return { bavail: overrides.freeBlocks ?? 50 * 262_144, bsize: 4096 };
    },
    startModelProbe: () => {
      seen.probes += 1;
      const result = overrides.probeHangs ? new Promise(() => {}) : Promise.resolve(overrides.models ?? 2);
      return { result, stop: async () => { seen.stops += 1; seen.events.push('stop'); return { exited: true }; } };
    },
  };
  return { deps, seen };
}

// The probe's host seam: createCliHost's port (`start`, `close`) and hostComposition's backend.
// `close` is 'clean' (sidecar exited), 'alive' (the composition's not-exited answer) or 'hang'.
function fakeCliHost({ close = 'clean', models = 2, startFails = false, engineDown = false, busy = false } = {}) {
  const seen = { created: [], closed: 0, released: 0 };
  const port = {
    start: async () => { if (startFails) throw new Error('sidecar did not start'); },
    close: () => {
      seen.closed += 1;
      // A close that never answers still holds the event loop, as the composition's exit poll does.
      if (close === 'hang') return new Promise(() => { setTimeout(() => {}, 1_000); });
      return Promise.resolve(close === 'alive' ? { ok: false, sidecar_exited: false, pid: 4242 } : { ok: true, sidecar_exited: true });
    },
  };
  const host = {
    acquireCliProfile: async () => {
      if (busy) throw Object.assign(new Error('busy'), { code: CLI_PROFILE_ERROR_CODES.BUSY });
      return { release: () => { seen.released += 1; } };
    },
    createCliHost: (options) => { seen.created.push(options); return port; },
    hostComposition: () => ({ backend: { listModelsForEngine: async () => (engineDown ? { available: false, data: [] }
      : { available: true, data: Array.from({ length: models }, (_value, index) => ({ id: `m${index}` })) }) } }),
    closeTimeoutMs: 10,
  };
  return { host, seen };
}

// Every entry under `dir` with a hash of each file's bytes; {} when it does not exist.
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const key = path.relative(dir, full);
      if (entry.isDirectory()) { out[`${key}/`] = 'dir'; walk(full); } else {
        out[key] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

module.exports = { FAKE_BRIDGE, fakeChild, fakeCliHost, fakeTimers, snapshot, teamFakes };
