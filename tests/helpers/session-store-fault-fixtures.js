'use strict';

// Shared fixtures for the chat (session) store fault tests (session-store-faults.test.js,
// session-store-corrupt-faults.test.js). Profiles are tracked temp dirs; chats are written
// through the store API.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { createTrackedTempDir } = require('./resource-cleanup');

function newProfile() {
  const dir = createTrackedTempDir('jenny-session-faults-');
  const sessionsDir = path.join(dir, 'sessions');
  return {
    dir,
    storePath: path.join(dir, 'sessions.json'),
    sessionsDir,
    indexPath: path.join(sessionsDir, '_index.json'),
    chatPath: (id) => path.join(sessionsDir, `${id}.json`),
  };
}

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
    events(name) {
      return entries.filter((entry) => entry.event === name);
    },
  };
}

function openStore(profile, options = {}) {
  return new ElectronSessionStore(profile.storePath, { writeDebounceMs: 0, sessionJournal: false, ...options });
}

function messageSpec(id, n) {
  return { id: `${id}_m${n}`, role: n % 2 ? 'user' : 'assistant', content: `${id} content ${n}` };
}

// The part of a chat the user cannot recreate: its title and its messages.
function chatContent(session) {
  return {
    title: session.title,
    messages: session.messages.map(({ id, role, content }) => ({ id, role, content })),
  };
}

// Chats written through the store API, then flushed and disposed. Returns { id: content }.
function seedChats(profile, ids, { journal = false, messages = 3 } = {}) {
  const store = openStore(profile, { sessionJournal: journal });
  const expected = {};
  ids.forEach((id, index) => {
    store.createSessionWithId(id, { title: `Title ${id}` });
    for (let n = 1; n <= messages + index; n += 1) {
      assert.ok(store.appendMessage(id, messageSpec(id, n)), `seed append ${id} ${n}`);
    }
    assert.equal(store.flushSession(id), true);
    expected[id] = chatContent(store.getSession(id));
  });
  store.flush();
  store.dispose();
  return expected;
}

function listFiles(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, next));
    else out.push(next);
  }
  return out.sort();
}

function readTree(root) {
  return new Map(listFiles(root).map((rel) => [rel, fs.readFileSync(path.join(root, rel))]));
}

function assertTreesIdentical(before, after, message) {
  assert.deepEqual([...after.keys()], [...before.keys()], `${message}: file set changed`);
  for (const [rel, bytes] of before) {
    assert.ok(bytes.equals(after.get(rel)), `${message}: ${rel} bytes changed`);
  }
}

function isTemp(rel) {
  return rel.endsWith('.tmp');
}

function restampSchema(filePath, version) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  value.schema_version = version;
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function rewriteJson(filePath, mutate) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  mutate(value);
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function messageIds(session) {
  return session.messages.map((message) => message.id);
}


function assertAllChatsListed(store, expected) {
  assert.deepEqual(store.listSessions().map((summary) => summary.id).sort(), Object.keys(expected).sort());
  for (const [id, content] of Object.entries(expected)) assert.deepEqual(chatContent(store.getSession(id)), content, id);
}

module.exports = {
  newProfile,
  createLogCollector,
  openStore,
  chatContent,
  seedChats,
  listFiles,
  readTree,
  assertTreesIdentical,
  isTemp,
  restampSchema,
  rewriteJson,
  messageIds,
  assertAllChatsListed,
};
