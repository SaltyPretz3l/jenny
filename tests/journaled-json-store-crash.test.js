'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const { buildState } = require('./helpers/journaled-store-crash-child');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackProcess,
} = require('./helpers/resource-cleanup');

const CHILD = path.join(__dirname, 'helpers', 'journaled-store-crash-child.js');
const ROUNDS = 28;

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

function openStore(filePath) {
  return new JournaledJsonStore(filePath, {
    payloadKey: 'session',
    journalId: 's1',
    writeDebounceMs: 0,
    compact: true,
    idleCompactMs: 0,
    maxJournalBytes: 600,
    maxJournalBaseRatio: 0,
  });
}

// Runs one child until `targetAcks` acknowledgements arrived, then SIGKILLs it
// by its own handle. `sendGo` lets the child start the next write first, so the
// kill can land while that write is in flight.
function runRound(filePath, { targetAcks, sendGo, killDelayMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, filePath], { stdio: ['pipe', 'pipe', 'inherit'] });
    trackProcess(child);
    const acks = [];
    let buffered = '';
    let killed = false;
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => {
      if (!killed) reject(new Error(`child exited early: code=${code} signal=${signal}`));
      else resolve({ acks, inFlight: sendGo });
    });
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        if (killed) return;
        acks.push(Number(line));
        if (acks.length < targetAcks) {
          child.stdin.write('go\n');
          continue;
        }
        killed = true;
        if (sendGo) child.stdin.write('go\n');
        setTimeout(() => child.kill('SIGKILL'), killDelayMs);
      }
    });
  });
}

test('acknowledged writes survive SIGKILL across many crash rounds', { timeout: 60000 }, async () => {
  const dir = createTrackedTempDir('jenny-jjs-crash-');
  const filePath = path.join(dir, 's1.json');
  const rng = createRng(20261005);
  let startSeq = 0;

  for (let round = 0; round < ROUNDS; round += 1) {
    const targetAcks = 1 + rng(30);
    const sendGo = rng(3) !== 0;
    const { acks } = await runRound(filePath, { targetAcks, sendGo, killDelayMs: rng(6) });
    assert.equal(acks.length, targetAcks);
    assert.deepEqual(acks, Array.from({ length: targetAcks }, (_, index) => startSeq + 1 + index));
    const lastAck = acks[acks.length - 1];

    const reader = openStore(filePath);
    const result = reader.readWithStatus(undefined);
    assert.equal(result.corrupted, false, `round ${round}: base corrupted`);
    assert.equal(result.missing, false, `round ${round}: store missing after acks`);
    const seq = result.value.session.seq;
    assert.ok(
      seq === lastAck || (sendGo && seq === lastAck + 1),
      `round ${round}: read seq ${seq}, last ack ${lastAck}, go sent ${sendGo}`
    );
    assert.deepEqual(result.value, buildState(seq), `round ${round}: value is not the state of seq ${seq}`);

    const next = buildState(seq + 1);
    reader.writeImmediate(next);
    assert.deepEqual(openStore(filePath).read(undefined), next, `round ${round}: post-crash write lost`);
    startSeq = seq + 1;
  }

  const journals = fs.readdirSync(dir).filter((name) => name.endsWith('.journal'));
  assert.ok(journals.length <= 3, `stale journals left: ${journals}`);
  assert.ok(startSeq > ROUNDS, 'the child made progress every round');
});
