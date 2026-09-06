const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeMessageFields } = require('../services/backend/message-normalization');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { exportSession } = require('../services/backend/session-export-import');
const { normalizeChatMessage } = require('../renderer/chat/chat-message-utils');
const {
  RESUMABLE_STOP_KINDS,
  buildResumeAffordanceMarkup,
} = require('../renderer/chat/renderer-resume-turn-affordance');

const ROOT = path.join(__dirname, '..');

function readSidecarStopKinds() {
  const source = fs.readFileSync(path.join(ROOT, 'sidecar/protocol.py'), 'utf8');
  const contract = source.match(
    /# ``chat\.done\.params\.resumable_stop``[\s\S]*?# this is not a new notification method[^\r\n]*/
  );
  assert.ok(contract, 'sidecar protocol must retain the scoped resumable_stop contract comment');
  return [...contract[0].matchAll(/``([a-z_]+)``/g)].map((match) => match[1]);
}

function loadElectronStopDetail() {
  const filePath = path.join(ROOT, 'services/backend/chat-stream-stop-detail.js');
  let stopKinds = null;
  class CapturingSet extends Set {
    constructor(values) {
      super(values);
      stopKinds = [...values];
    }
  }
  const moduleRecord = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), {
    module: moduleRecord,
    exports: moduleRecord.exports,
    Set: CapturingSet,
  }, { filename: filePath });
  return {
    stopKinds,
    normalizeResumableStop: moduleRecord.exports.normalizeResumableStop,
  };
}

function assertSameSet(leftValues, rightValues) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  assert.deepEqual([...left].filter((value) => !right.has(value)).sort(), []);
  assert.deepEqual([...right].filter((value) => !left.has(value)).sort(), []);
}

function buildMarkup(kind) {
  return buildResumeAffordanceMarkup({
    kind,
    messageId: 'assistant-crosslayer',
    sessionId: 'session-crosslayer',
  });
}

test('sidecar, Electron, and renderer resumable-stop allowlists have set parity', () => {
  // Node cannot import the Python protocol module; only that layer uses a scoped text assertion.
  const sidecarKinds = readSidecarStopKinds();
  const electron = loadElectronStopDetail();
  assertSameSet(sidecarKinds, electron.stopKinds);
  assertSameSet(electron.stopKinds, RESUMABLE_STOP_KINDS);
  for (const kind of electron.stopKinds) {
    assert.equal(electron.normalizeResumableStop(kind), kind);
  }
});

test('a durable resumable stop survives both normalizers and renders a Resume button', () => {
  const persistedMessage = {
    id: 'assistant-crosslayer',
    role: 'assistant',
    content: 'A partial answer',
    resumable_stop: 'tool_cap',
  };

  const electronMessage = normalizeMessageFields(persistedMessage);
  const rendererMessage = normalizeChatMessage(electronMessage);
  assert.equal(electronMessage.resumable_stop, 'tool_cap');
  assert.equal(rendererMessage.resumable_stop, 'tool_cap');
  assert.match(buildMarkup(rendererMessage.resumable_stop), /<button\b/);
});

test('resumable_stop survives an ElectronSessionStore disk round trip', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-resumable-stop-'));
  const storePath = path.join(tempDir, 'sessions.json');
  let store = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  let reloaded = null;
  t.after(() => {
    if (store) store.dispose();
    if (reloaded) reloaded.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { id: sessionId } = store.createSession({ title: 'Resumable stop' });
  store.appendMessage(sessionId, {
    id: 'assistant-disk',
    role: 'assistant',
    content: 'A partial answer',
    resumable_stop: 'diminishing_returns',
  });
  store.flush();
  store.dispose();
  store = null;

  reloaded = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const message = reloaded.getSessionMessages(sessionId)
    .find((entry) => entry.id === 'assistant-disk');
  assert.equal(message.resumable_stop, 'diminishing_returns');
});

test('session export preserves resumable_stop while copying messages', () => {
  const json = exportSession({
    getSession(sessionId) {
      assert.equal(sessionId, 'session-export');
      return {
        title: 'Exported session',
        messages: [{
          id: 'assistant-export',
          role: 'assistant',
          content: 'A partial answer',
          resumable_stop: 'max_iterations',
        }],
      };
    },
  }, 'session-export');

  assert.equal(JSON.parse(json).session.messages[0].resumable_stop, 'max_iterations');
});

test('context_budget is normalized and rendered as resumable', () => {
  const { normalizeResumableStop } = loadElectronStopDetail();
  assert.equal(normalizeResumableStop('context_budget'), 'context_budget');
  assert.equal(RESUMABLE_STOP_KINDS.includes('context_budget'), true);
  assert.match(buildMarkup('context_budget'), /<button\b/);
});
