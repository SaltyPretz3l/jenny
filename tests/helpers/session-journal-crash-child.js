'use strict';

// Child process for session-journal-wiring-crash.test.js. Usage: node <this> <sessions.json path>
//
// Opens a real ElectronSessionStore on the profile, appends one message at a
// time, calls flushSession, and ONLY AFTER it returns prints the acknowledged
// message id. After each ack it waits for a "go" line on stdin, so the parent
// knows at most one write (the one after the last ack) can be in flight when it
// kills this process. Journal thresholds are tiny so base replacements,
// compactions and appends all happen inside a few messages.

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');

const SESSION_ID = 'sess_crash';

function messageFor(seq) {
  return {
    id: `m${seq}`,
    role: 'user',
    content: `message ${seq} ${'x'.repeat((seq % 13) * 40)}`,
    timestamp: '2026-10-05T10:00:00.000Z',
  };
}

function lastSequence(session) {
  let highest = 0;
  for (const message of session ? session.messages : []) {
    const match = /^m(\d+)$/.exec(message.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function main() {
  const store = new ElectronSessionStore(process.argv[2], { writeDebounceMs: 0, sessionJournal: true });
  Object.assign(store._backend._journal, { maxJournalBytes: 1500, maxJournalBaseRatio: 0, idleCompactMs: 30 });
  if (!store.getSession(SESSION_ID)) {
    store.createSessionWithId(SESSION_ID, { title: 'Crash' });
    if (store.flushSession(SESSION_ID) !== true) throw new Error('create flush failed');
  }
  let seq = lastSequence(store.getSession(SESSION_ID));

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
    process.stdout.write('ready\n');
    await waitForGo();
    for (;;) {
      seq += 1;
      if (!store.appendMessage(SESSION_ID, messageFor(seq))) throw new Error(`append refused at ${seq}`);
      if (store.flushSession(SESSION_ID) !== true) throw new Error(`flush failed at ${seq}`);
      process.stdout.write(`m${seq}\n`);
      await waitForGo();
    }
  })().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}

main();
