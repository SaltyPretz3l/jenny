'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackendService } = require('../../services/backend/backend-service');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { exportSession } = require('../../services/backend/session-export-import');
const { createArchive } = require('../../services/data-lifecycle/archive-service');
const { assertImportComplete, importConversations } = require('../../services/host/maintenance-commands');
const { readJson } = require('../../services/host/durable-json');

class StoppedSidecar extends EventEmitter {
  getStatus() { return { phase: 'stopped' }; }
  async start() { throw new Error('sidecar must not start during import'); }
  async stop() { return { exitConfirmed: true }; }
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-import-durable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createBackend(userDataPath) {
  return new BackendService({
    userDataPath,
    defaultModel: 'replay-test',
    sidecarManager: new StoppedSidecar(),
  });
}

async function createArchiveOfChats(root, titles) {
  const entries = [];
  for (const title of titles) {
    const store = new ElectronSessionStore(path.join(root, `${title}.json`), { writeDebounceMs: 0 });
    const session = store.createSession({ title });
    store.appendMessage(session.id, { role: 'user', content: `Message from ${title}` });
    store.flush();
    entries.push({
      logicalPath: `sessions/${session.id}.json`,
      category: 'chats',
      data: exportSession(store, session.id, null, {}),
      restoreMetadata: { session_id: session.id },
    });
    store.dispose();
  }
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'durable.jenny-archive',
    encrypted: false,
    entries,
  });
  return result.archivePath;
}

test('import CLI accepts policy 2 offline without an execution broker', async (t) => {
  const { runCli } = require('../../server/cli');
  const root = tempRoot(t);
  t.mock.method(os, 'homedir', () => path.join(root, 'home'));
  const archivePath = await createArchiveOfChats(root, ['Offline import']);
  const userDataPath = path.join(root, 'hosted');
  const secretsDir = path.join(root, 'secrets');
  fs.mkdirSync(secretsDir);
  let released = false;
  const result = await runCli(['import-conversations', '--config', path.join(root, 'host.json'),
    '--archive', archivePath], {
    loadHostConfigImpl: () => ({ userDataPath, secretsDir, hostMode: 'server',
      hostExecutionPolicyVersion: 2, workspaceRoot: null,
      modelEndpoint: { engine: 'ollama', model: 'offline', apiUrl: 'http://model:11434' } }),
    acquireProfileImpl: () => ({ release() { released = true; } }),
    readPasswordImpl: async () => '', confirmOutput: { write() {} },
  });
  assert.equal(result.ok, true, 'policy 2 must not require a worker for import');
  assert.equal(released, true);
  const backend = createBackend(userDataPath);
  try {
    assert.equal(backend.sessionStore.listSessions().length, 1);
  } finally { backend.dispose(); }
});

// Makes every stable-storage flush of a canonical session file fail, through
// both the asynchronous and the synchronous real write paths of the stores.
function failSessionFileFlush(t, userDataPath) {
  const realOpen = fs.promises.open;
  const realOpenSync = fs.openSync;
  const realFsyncSync = fs.fsyncSync;
  const realCloseSync = fs.closeSync;
  const sessionsDir = path.join(userDataPath, 'sessions') + path.sep;
  const isSessionTemp = (target) => String(target).startsWith(sessionsDir) && String(target).endsWith('.tmp');
  const failing = new Set();
  const eio = () => Object.assign(new Error('simulated EIO'), { code: 'EIO' });
  fs.promises.open = async (target, ...args) => {
    const handle = await realOpen.call(fs.promises, target, ...args);
    if (isSessionTemp(target)) handle.sync = async () => { throw eio(); };
    return handle;
  };
  fs.openSync = (target, ...args) => {
    const fd = realOpenSync.call(fs, target, ...args);
    if (isSessionTemp(target)) failing.add(fd);
    return fd;
  };
  fs.fsyncSync = (fd) => {
    if (failing.has(fd)) throw eio();
    return realFsyncSync.call(fs, fd);
  };
  fs.closeSync = (fd) => {
    failing.delete(fd);
    return realCloseSync.call(fs, fd);
  };
  const realConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    fs.promises.open = realOpen;
    fs.openSync = realOpenSync;
    fs.fsyncSync = realFsyncSync;
    fs.closeSync = realCloseSync;
    console.error = realConsoleError;
  });
}

test('the completed receipt is not written when an imported chat never became durable', async (t) => {
  const root = tempRoot(t);
  const archivePath = await createArchiveOfChats(root, ['one', 'two']);
  const userDataPath = path.join(root, 'hosted-profile');
  const backend = createBackend(userDataPath);
  t.after(() => { try { backend.dispose(); } catch (_error) { /* test cleanup */ } });
  failSessionFileFlush(t, userDataPath);

  const result = await importConversations({ backend, userDataPath, archivePath });

  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'import_incomplete');
  assert.equal(readJson(path.join(userDataPath, 'host-import.json')).state, 'pending');
  assert.throws(() => assertImportComplete(userDataPath), (error) => error.reason === 'import_pending');
});

test('the completed receipt is written after every imported chat reached disk', async (t) => {
  const root = tempRoot(t);
  const archivePath = await createArchiveOfChats(root, ['one', 'two']);
  const userDataPath = path.join(root, 'hosted-profile');
  const backend = createBackend(userDataPath);
  t.after(() => { try { backend.dispose(); } catch (_error) { /* test cleanup */ } });

  const result = await importConversations({ backend, userDataPath, archivePath });

  assert.equal(result.ok, true);
  assert.equal(result.imported_count, 2);
  assert.equal(readJson(path.join(userDataPath, 'host-import.json')).state, 'completed');
  const sessionsDir = path.join(userDataPath, 'sessions');
  const ids = backend.sessionStore.getSessionIds();
  assert.equal(ids.length, 2);
  for (const id of ids) {
    const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'));
    assert.equal(saved.session.id, id);
  }
});
