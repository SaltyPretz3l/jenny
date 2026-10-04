'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectRunningJenny } = require('../services/data-lifecycle/profile-in-use');

const NOT_IN_USE = { inUse: false, evidence: '' };

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

function recordingFs({ openSync, readlinkSync } = {}) {
  const calls = [];
  return {
    calls,
    openSync: (...args) => { calls.push(['open', ...args]); return openSync(...args); },
    closeSync: (...args) => { calls.push(['close', ...args]); },
    readlinkSync: (...args) => { calls.push(['readlink', ...args]); return readlinkSync(...args); },
    writeFileSync: () => { throw new Error('the detector must never write'); },
    unlinkSync: () => { throw new Error('the detector must never delete'); },
  };
}

describe('detectRunningJenny on Windows', () => {
  const userData = 'C:\\Users\\A\\AppData\\Roaming\\jenny';
  const lockfile = 'C:\\Users\\A\\AppData\\Roaming\\jenny\\lockfile';

  it('reports not in use when the Chromium lockfile is absent', () => {
    const fsImpl = recordingFs({ openSync: () => { throw fsError('ENOENT'); } });
    assert.deepEqual(detectRunningJenny(userData, { platform: 'win32', fsImpl }), NOT_IN_USE);
    assert.deepEqual(fsImpl.calls, [['open', lockfile, 'r+']]);
  });

  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    it(`reports in use when opening the lockfile fails with ${code}`, () => {
      const fsImpl = recordingFs({ openSync: () => { throw fsError(code); } });
      assert.deepEqual(
        detectRunningJenny(userData, { platform: 'win32', fsImpl }),
        { inUse: true, evidence: 'lockfile' }
      );
    });
  }

  it('closes the probe handle at once and reports not in use when the open succeeds', () => {
    const fsImpl = recordingFs({ openSync: () => 42 });
    assert.deepEqual(detectRunningJenny(userData, { platform: 'win32', fsImpl }), NOT_IN_USE);
    assert.deepEqual(fsImpl.calls, [['open', lockfile, 'r+'], ['close', 42]]);
  });

  it('does not treat an unrelated open failure as a running instance', () => {
    const fsImpl = recordingFs({ openSync: () => { throw fsError('EIO'); } });
    assert.deepEqual(detectRunningJenny(userData, { platform: 'win32', fsImpl }), NOT_IN_USE);
  });

  it('leaves a real, unlocked lockfile untouched', (t) => {
    if (process.platform !== 'win32') {
      t.skip('lockfile semantics are Windows-only');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-profile-in-use-'));
    try {
      const lockPath = path.join(root, 'lockfile');
      fs.writeFileSync(lockPath, 'stale');
      assert.deepEqual(detectRunningJenny(root, { platform: 'win32' }), NOT_IN_USE);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), 'stale');
      assert.deepEqual(detectRunningJenny(path.join(root, 'missing'), { platform: 'win32' }), NOT_IN_USE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('detectRunningJenny off Windows', () => {
  const userData = '/home/a/.config/jenny';

  for (const platform of ['linux', 'darwin']) {
    it(`reports in use for a live same-host pid on ${platform}`, () => {
      const alive = [];
      const fsImpl = recordingFs({ readlinkSync: () => 'my-box-1234' });
      const result = detectRunningJenny(userData, {
        platform,
        fsImpl,
        hostname: 'my-box',
        isProcessAlive: (pid) => { alive.push(pid); return true; },
      });
      assert.deepEqual(result, { inUse: true, evidence: 'singleton-lock' });
      assert.deepEqual(alive, [1234]);
      assert.deepEqual(fsImpl.calls, [['readlink', '/home/a/.config/jenny/SingletonLock']]);
    });
  }

  it('reports not in use for a dead same-host pid, even with a dash in the hostname', () => {
    const result = detectRunningJenny(userData, {
      platform: 'linux',
      fsImpl: recordingFs({ readlinkSync: () => 'my-dev-box-77' }),
      hostname: 'my-dev-box',
      isProcessAlive: (pid) => { assert.equal(pid, 77); return false; },
    });
    assert.deepEqual(result, NOT_IN_USE);
  });

  it('reports in use for a lock written by a different host, without probing the pid', () => {
    const result = detectRunningJenny(userData, {
      platform: 'linux',
      fsImpl: recordingFs({ readlinkSync: () => 'other-host-9' }),
      hostname: 'my-box',
      isProcessAlive: () => { throw new Error('a foreign pid must not be probed'); },
    });
    assert.equal(result.inUse, true);
  });

  it('reports not in use when the lock is absent or unreadable', () => {
    for (const code of ['ENOENT', 'EINVAL', 'EACCES']) {
      const result = detectRunningJenny(userData, {
        platform: 'linux',
        fsImpl: recordingFs({ readlinkSync: () => { throw fsError(code); } }),
        hostname: 'my-box',
        isProcessAlive: () => true,
      });
      assert.deepEqual(result, NOT_IN_USE);
    }
  });

  it('uses the real process table by default and counts EPERM as alive', () => {
    const ownPid = process.pid;
    const live = detectRunningJenny(userData, {
      platform: 'linux',
      fsImpl: recordingFs({ readlinkSync: () => `my-box-${ownPid}` }),
      hostname: 'my-box',
    });
    assert.equal(live.inUse, true);

    const originalKill = process.kill;
    try {
      process.kill = () => { throw fsError('EPERM'); };
      const denied = detectRunningJenny(userData, {
        platform: 'linux',
        fsImpl: recordingFs({ readlinkSync: () => 'my-box-4321' }),
        hostname: 'my-box',
      });
      assert.equal(denied.inUse, true);
      process.kill = () => { throw fsError('ESRCH'); };
      const gone = detectRunningJenny(userData, {
        platform: 'linux',
        fsImpl: recordingFs({ readlinkSync: () => 'my-box-4321' }),
        hostname: 'my-box',
      });
      assert.deepEqual(gone, NOT_IN_USE);
    } finally {
      process.kill = originalKill;
    }
  });
});
