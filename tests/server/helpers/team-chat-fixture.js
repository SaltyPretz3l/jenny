'use strict';

// Shared fixture for the team chat store tests (row 123 slice 2a-1): a real
// temporary profile, an injected clock and random source, and file operations
// that record what a mutation wrote and can fail or "crash" on demand.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const durable = require('../../../services/host/durable-json');
const { TeamChatStore } = require('../../../services/host/team-chat-store');

const ALICE = 'member_alice';
const BOB = 'member_bob';
const ALICE_DEVICE = 'device_alice1';
const BOB_DEVICE = 'device_bob1';
const START = Date.UTC(2026, 10, 10, 9, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function createChatFixture(t, { limits } = {}) {
  const profileDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-chat-')));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const chatDir = path.join(profileDir, 'team-chat');
  let now = START;
  let counter = 0;
  let requestCounter = 0;
  const writes = [];
  // crashAfter: further writes allowed before the next one throws (a process
  // crash between two atomic file writes), null disables it. failWrite and
  // busyOnce take a relative path predicate / path. fixedRandom repeats ids.
  const control = {
    crashAfter: null, failWrite: null, failRemove: false, busyOnce: null, fixedRandom: false, failAfterWrite: null,
  };
  const rel = (filePath) => path.relative(chatDir, filePath).split(path.sep).join('/');

  function beforeWrite(filePath) {
    if (control.failWrite && control.failWrite(rel(filePath))) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    if (control.crashAfter !== null) {
      if (control.crashAfter === 0) throw Object.assign(new Error('simulated crash'), { code: 'ECRASH' });
      control.crashAfter -= 1;
    }
    writes.push(rel(filePath));
  }

  const fileOps = {
    readJson(filePath, options) {
      if (control.busyOnce && rel(filePath) === control.busyOnce) {
        control.busyOnce = null;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return durable.readJson(filePath, options);
    },
    writeJson(filePath, value) { beforeWrite(filePath); durable.writeJson(filePath, value); },
    // failAfterWrite: the file lands, then the call throws once (a failed directory fsync).
    writeText(filePath, text) {
      beforeWrite(filePath);
      durable.writeText(filePath, text);
      if (control.failAfterWrite && control.failAfterWrite(rel(filePath))) {
        control.failAfterWrite = null;
        throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
      }
    },
    removeFile(filePath) {
      if (control.failRemove) throw Object.assign(new Error('simulated crash'), { code: 'ECRASH' });
      fs.unlinkSync(filePath);
    },
  };

  function randomBytes(size) {
    if (!control.fixedRandom) counter += 1;
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(counter >>> 0, size - 4);
    return bytes;
  }

  // A store on this profile; `open()` is not asserted.
  function newStore(options = {}) {
    return new TeamChatStore({ profileDir, clock: () => now, randomBytes, limits, fileOps, ...options });
  }

  function openStore(options = {}) {
    const store = newStore(options);
    const opened = store.open();
    assert.equal(opened.ok, true, `open failed: ${JSON.stringify(opened)}`);
    return store;
  }

  function newRequestId() {
    requestCounter += 1;
    return `req_${requestCounter}`;
  }

  const base = () => ({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: newRequestId() });
  const post = (store, input = {}) => store.post({ ...base(), text: 'hello', ...input });
  const edit = (store, input = {}) => store.edit({ ...base(), ...input });
  const del = (store, input = {}) => store.delete({ ...base(), ...input });

  async function postOk(store, input = {}) {
    const result = await post(store, input);
    assert.equal(result.ok, true, `post failed: ${JSON.stringify(result)}`);
    return result;
  }

  async function createChannel(store, channelId = 'chan_team') {
    const result = await store.createChannel({ channelId });
    assert.equal(result.ok, true, `create failed: ${JSON.stringify(result)}`);
    return result;
  }

  function readDoc(relative) {
    return JSON.parse(fs.readFileSync(path.join(chatDir, ...relative.split('/')), 'utf8'));
  }

  function writeDoc(relative, value) {
    const target = path.join(chatDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  }

  function snapshotTree() {
    const out = {};
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (fs.lstatSync(full).isDirectory()) walk(full);
        else out[rel(full)] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(chatDir);
    return out;
  }

  return {
    profileDir, chatDir, fileOps, writes, control,
    advance(ms) { now += ms; },
    now: () => now,
    newStore, openStore, newRequestId, post, postOk, edit, del, createChannel, readDoc, writeDoc, snapshotTree,
    takeWrites() { return writes.splice(0, writes.length); },
  };
}

// A fixture with an open store and chan_team created; writes so far discarded.
async function seeded(t, limits) {
  const fx = createChatFixture(t, { limits });
  const store = fx.openStore();
  await fx.createChannel(store);
  fx.takeWrites();
  return { fx, store };
}

function failureOf(result) {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  return result.error;
}

function assertFailure(result, code, reason) {
  const error = failureOf(result);
  assert.equal(error.code, code);
  assert.equal(error.reason, reason);
}

module.exports = {
  ALICE, BOB, ALICE_DEVICE, BOB_DEVICE, START, DAY_MS,
  createChatFixture, seeded, failureOf, assertFailure,
};
