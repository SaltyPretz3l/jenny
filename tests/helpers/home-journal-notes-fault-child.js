'use strict';

// Child process for home-journal-notes-faults.test.js (rows J1 and N1).
// Usage: node <this> <journal|notes> <profile dir> <kill-before|kill-after> <K>
//
// Performs sequential saves against the Home AI journal store or the project
// notes store. A test-only wrapper around fs.renameSync SIGKILLs this process on
// the Kth rename whose destination basename matches the store file: before the
// real rename (kill-before) or right after it returned (kill-after). A
// synchronous ack line is written after each save returned, so every acked save
// was durable before the kill. If the loop ends without the kill firing, the
// child exits 0 and the test fails on that.

const fs = require('node:fs');
const path = require('node:path');

const { HomeAiJournalStore } = require('../../services/home-ai-journal-store');
const { ProjectNotesStore } = require('../../services/project-notes-store');

const FIXED_NOW = new Date('2026-10-26T00:00:00.000Z');
const PROJECT_ID = 'project_alpha';
const JOURNAL_FILE = 'home-ai-journal.json';
const NOTE_FILE = `${PROJECT_ID}.json`;

function journalEntryFor(seq) {
  return {
    id: `jnl_${seq}`,
    at: FIXED_NOW.toISOString(),
    entity: 'reminder',
    entityId: `rem_${seq}`,
    op: 'create',
    label: `reminder ${seq}`,
    sessionId: 'session_1',
    inverse: { kind: 'delete', payload: null },
    postHash: `hash-${seq}`,
    undoneAt: '',
    supersededAt: '',
  };
}

function noteTextFor(seq) {
  return `note revision ${seq}`;
}

function openJournal(userDataPath, logger = () => {}) {
  return new HomeAiJournalStore({ userDataPath, logger });
}

function openNotes(userDataPath, logger = () => {}) {
  return new ProjectNotesStore({ userDataPath, logger, now: () => FIXED_NOW });
}

function installRenameKill(targetName, mode, killAt) {
  const realRename = fs.renameSync;
  let matched = 0;
  fs.renameSync = function renameWithKill(from, to, ...rest) {
    if (path.basename(String(to)) !== targetName) return realRename.call(this, from, to, ...rest);
    matched += 1;
    if (matched !== killAt) return realRename.call(this, from, to, ...rest);
    if (mode === 'kill-before') process.kill(process.pid, 'SIGKILL');
    const result = realRename.call(this, from, to, ...rest);
    process.kill(process.pid, 'SIGKILL');
    return result;
  };
}

function main() {
  const [kind, profileDir, mode, killAtText] = process.argv.slice(2);
  const killAt = Number(killAtText);
  if (!['journal', 'notes'].includes(kind) || !profileDir
    || !['kill-before', 'kill-after'].includes(mode) || !Number.isInteger(killAt) || killAt < 1) {
    console.error('usage: home-journal-notes-fault-child <journal|notes> <profile dir> <kill-before|kill-after> <K>');
    process.exit(2);
  }
  const step = kind === 'journal'
    ? ((store) => (seq) => store.append(journalEntryFor(seq), FIXED_NOW))(openJournal(profileDir))
    : ((store) => (seq) => store.write(PROJECT_ID, { text: noteTextFor(seq), updatedBy: 'assistant' }))(openNotes(profileDir));
  installRenameKill(kind === 'journal' ? JOURNAL_FILE : NOTE_FILE, mode, killAt);
  for (let seq = 1; seq <= killAt + 3; seq += 1) {
    step(seq);
    fs.writeSync(1, `${seq}\n`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  FIXED_NOW,
  JOURNAL_FILE,
  NOTE_FILE,
  PROJECT_ID,
  journalEntryFor,
  noteTextFor,
  openJournal,
  openNotes,
};
