'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackCloseable,
  trackProcess,
} = require('./helpers/resource-cleanup');

const CHILD = path.join(__dirname, 'helpers', 'session-journal-crash-child.js');
const SESSION_ID = 'sess_crash';
const ROUNDS = 16;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createRng(seed) {
  let current = seed >>> 0;
  return (limit) => {
    current = (current + 0x6d2b79f5) >>> 0;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit);
  };
}

// Runs one child until `targetAcks` message acknowledgements arrived, then
// SIGKILLs it by its own handle. Each "go" is delayed by a random time so idle
// compaction (30 ms in the child) sometimes runs between writes.
function runRound(storePath, { targetAcks, sendFinalGo, delayMs, killDelayMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, storePath], { stdio: ['pipe', 'pipe', 'inherit'] });
    trackProcess(child);
    const acks = [];
    let buffered = '';
    let killed = false;
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => {
      if (!killed) reject(new Error(`child exited early: code=${code} signal=${signal}`));
      else resolve(acks);
    });
    const go = (extraDelay = 0) => setTimeout(() => child.stdin.write('go\n'), extraDelay);
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        if (killed) return;
        if (line === 'ready') {
          go();
          continue;
        }
        acks.push(line);
        if (acks.length < targetAcks) {
          go(delayMs());
          continue;
        }
        killed = true;
        if (sendFinalGo) child.stdin.write('go\n');
        setTimeout(() => child.kill('SIGKILL'), killDelayMs);
      }
    });
  });
}

test('acknowledged chat writes survive SIGKILL across many crash rounds', { timeout: 85000 }, async () => {
  const dir = createTrackedTempDir('jenny-session-journal-crash-');
  const storePath = path.join(dir, 'sessions.json');
  const sessionsDir = path.join(dir, 'sessions');
  const rng = createRng(20261005);
  const expected = [];
  let sawJournal = false;

  for (let round = 0; round < ROUNDS; round += 1) {
    const targetAcks = 1 + rng(12);
    const acks = await runRound(storePath, {
      targetAcks,
      sendFinalGo: rng(3) !== 0,
      delayMs: () => (rng(3) === 0 ? rng(60) : 0),
      killDelayMs: rng(8),
    });
    assert.equal(acks.length, targetAcks, `round ${round}: every ack was read`);
    expected.push(...acks);
    if (fs.readdirSync(sessionsDir).some((name) => name.endsWith('.journal'))) sawJournal = true;

    const reader = trackCloseable(new ElectronSessionStore(storePath, { writeDebounceMs: 0 }));
    const session = reader.getSession(SESSION_ID);
    assert.ok(session, `round ${round}: the chat exists`);
    const ids = session.messages.map((message) => message.id);
    assert.equal(new Set(ids).size, ids.length, `round ${round}: no duplicate message ids`);
    for (const id of expected) assert.ok(ids.includes(id), `round ${round}: acknowledged ${id} is missing`);
    assert.equal(
      fs.existsSync(path.join(sessionsDir, 'corrupt')),
      false,
      `round ${round}: nothing was quarantined`
    );

    const probeId = `p${round}`;
    assert.ok(reader.appendMessage(SESSION_ID, {
      id: probeId, role: 'user', content: 'probe', timestamp: '2026-10-05T10:00:00.000Z',
    }), `round ${round}: the store accepts a write after the crash`);
    assert.equal(reader.flushSession(SESSION_ID), true);
    expected.push(probeId);
    // Even rounds close cleanly, odd rounds are abandoned like a second crash.
    if (round % 2 === 0) reader.dispose();
  }

  const finalStore = trackCloseable(new ElectronSessionStore(storePath, { writeDebounceMs: 0 }));
  const finalIds = finalStore.getSession(SESSION_ID).messages.map((message) => message.id);
  for (const id of expected) assert.ok(finalIds.includes(id), `final: ${id} is missing`);
  assert.ok(expected.length > ROUNDS, 'the child made progress');
  assert.ok(sawJournal, 'the crashed profiles held journals');
});
