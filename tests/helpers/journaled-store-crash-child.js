'use strict';

// Child process for journaled-json-store-crash.test.js. Usage: node <this> <store path>
//
// Starts from whatever the store holds, then loops: apply the next step, call
// writeImmediate, and ONLY AFTER it returns print the acknowledged sequence
// number. After each ack it waits for a "go" line on stdin, so the parent knows
// at most one write (the one after the last ack) can be in flight when it kills
// this process. Every value is a pure function of its sequence number.

const { JournaledJsonStore } = require('../../services/backend/journaled-json-store');

function applyStep(messages, seq) {
  messages.push({
    id: `m${seq}`,
    role: seq % 2 ? 'user' : 'assistant',
    text: `message ${seq} ${'x'.repeat((seq % 13) * 3)}`,
  });
  if (seq % 7 === 0) {
    const index = seq % messages.length;
    messages[index] = { ...messages[index], text: `edited at ${seq}` };
  }
  if (seq % 11 === 0 && messages.length > 3) messages.length -= 2;
}

function stateFor(seq, messages) {
  return {
    schema_version: 1,
    session: {
      id: 's1',
      title: `title ${Math.floor(seq / 10)}`,
      seq,
      messages,
      turn_events: [],
    },
  };
}

function buildState(seq) {
  const messages = [];
  for (let step = 1; step <= seq; step += 1) applyStep(messages, step);
  return stateFor(seq, messages);
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

function main() {
  const store = openStore(process.argv[2]);
  let seq = store.read(undefined)?.session?.seq || 0;
  // The live array is mutated in place between writes, like a session cache.
  const messages = buildState(seq).session.messages;

  let goCount = 0;
  let wake = null;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    goCount += chunk.split('\n').length - 1;
    if (wake) wake();
  });
  process.stdin.on('end', () => process.exit(0));

  async function waitForGo() {
    while (goCount === 0) await new Promise((resolve) => { wake = resolve; });
    goCount -= 1;
  }

  (async () => {
    for (;;) {
      seq += 1;
      applyStep(messages, seq);
      store.writeImmediate(stateFor(seq, messages));
      process.stdout.write(`${seq}\n`);
      await waitForGo();
    }
  })().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { buildState };
