'use strict';

// Child process for session-store-faults.test.js. Config: JSON in the SESSION_FAULT_CONFIG environment variable
//
// Opens a real ElectronSessionStore on `config.profile` and kills itself with
// SIGKILL (TerminateProcess on Windows) at a marked step: before or after the
// Nth `fs.renameSync` whose destination basename matches `config.pattern`,
// counted from the moment the hook is armed. The wrapper exists only in this
// process. Acknowledgements are `ack <id>` lines written with a synchronous
// write AFTER the store call returned, so a line the parent reads is a write
// the store reported complete. Exit codes: 2 = the child failed on its own,
// 4 = the kill did not take effect, 0 = the script ran to its end (the hook
// never fired).
//
// Config: { profile, mode, journal, pattern, when: 'before'|'after', nth,
//           killAtMessage, killAtStep: 'append'|'flush', total }
// Modes:
//   append  create chat `sess_crash`, then append m1..m<total>, flushing each;
//           the hook is armed right before step `killAtStep` of m<killAtMessage>.
//   migrate open the store, arm the hook, await runPendingMigrations().
//   open    arm the hook, then open the store (a monolithic migration runs in
//           the constructor).

const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(process.env.SESSION_FAULT_CONFIG);
const CHAT_ID = 'sess_crash';

const hook = { armed: false, seen: 0 };
const realRename = fs.renameSync;

function die() {
  process.kill(process.pid, 'SIGKILL');
  // Bounded wait for the kill to land; reaching the exit below is a harness failure.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  process.exit(4);
}

fs.renameSync = function renameSyncWithKill(from, to, ...rest) {
  if (!hook.armed || !new RegExp(config.pattern).test(path.basename(String(to)))) {
    return realRename.call(fs, from, to, ...rest);
  }
  hook.seen += 1;
  if (hook.seen !== (config.nth || 1)) return realRename.call(fs, from, to, ...rest);
  if (config.when === 'before') die();
  const result = realRename.call(fs, from, to, ...rest);
  die();
  return result;
};

function ack(text) {
  fs.writeSync(1, `${text}\n`);
}

// The store calls `fs.renameSync` through the module object, so require order does not matter.
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');

function openStore() {
  return new ElectronSessionStore(path.join(config.profile, 'sessions.json'), {
    writeDebounceMs: 0,
    sessionJournal: config.journal === true,
  });
}

function messageFor(seq) {
  return { id: `m${seq}`, role: seq % 2 ? 'user' : 'assistant', content: `message ${seq}` };
}

async function main() {
  if (config.mode === 'open') {
    hook.armed = true;
    openStore();
    ack('opened');
    return;
  }
  const store = openStore();
  if (config.mode === 'migrate') {
    ack('opened');
    hook.armed = true;
    const result = await store.runPendingMigrations();
    ack(`migrated ${result.success}`);
    return;
  }
  if (config.mode !== 'append') throw new Error(`unknown mode ${config.mode}`);
  store.createSessionWithId(CHAT_ID, { title: 'Crash' });
  if (store.flushSession(CHAT_ID) !== true) throw new Error('create flush failed');
  ack('created');
  for (let seq = 1; seq <= config.total; seq += 1) {
    const kill = seq === config.killAtMessage;
    if (kill && config.killAtStep === 'append') hook.armed = true;
    if (!store.appendMessage(CHAT_ID, messageFor(seq))) throw new Error(`append refused at ${seq}`);
    if (kill && config.killAtStep === 'flush') hook.armed = true;
    if (store.flushSession(CHAT_ID) !== true) throw new Error(`flush failed at ${seq}`);
    ack(`ack ${messageFor(seq).id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
