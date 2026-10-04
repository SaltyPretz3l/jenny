'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const view = require('../../renderer/browser/browser-view');
const { BrowserApp } = require('../../renderer/browser/app');

function dom() {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  return instance;
}

function cleanup() {
  delete global.window;
  delete global.document;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function snapshotFor(sessionId, extra = {}) {
  return {
    session: { session_id: sessionId, title: sessionId, revision: 'r1', plan_mode: false },
    messages: [], pending_approvals: [], pending_questions: [], control: null, active_turn: null, live_projection: null,
    ...extra,
  };
}

function viewState(overrides = {}) {
  return {
    authenticated: true,
    connectionState: 'connected',
    sessions: [{ session_id: 'session_a', title: 'A' }],
    selectedSessionId: 'session_a',
    snapshot: snapshotFor('session_a'),
    draft: '',
    control: { owned: true, ownerClientId: 'client_a', generation: 1 },
    attachments: [],
    pendingDecisionKey: '',
    planMode: false,
    activeStreamId: '',
    liveProjection: null,
    controlBusy: false,
    composerMode: 'send',
    ...overrides,
  };
}

const questionSnapshot = (ref) => snapshotFor('session_a', {
  pending_questions: [{ question_ref: ref, stream_id: 'stream_a', questions: [{ id: 'q1', prompt: 'Why?', options: [] }] }],
});

test('routine re-render keeps the composer node, focus and selection', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  view.mount(root, viewState());
  const area = root.querySelector('#composer-prompt');
  area.focus();
  area.value = 'hello world';
  area.setSelectionRange(2, 5);
  // The input handler keeps the draft state-backed.
  view.mount(root, viewState({ draft: 'hello world', mutationPending: false }));
  view.mount(root, viewState({ draft: 'hello world', activeStreamId: 'stream_x' }));
  assert.equal(root.querySelector('#composer-prompt'), area);
  assert.equal(instance.window.document.activeElement, area);
  assert.equal(area.selectionStart, 2);
  assert.equal(area.selectionEnd, 5);
  assert.ok(root.querySelector('[data-action="cancel-chat"]'), 'non-editable controls still update');
  view.mount(root, viewState({ draft: 'hello world', control: { owned: false, ownerClientId: 'other', generation: 2 } }));
  assert.equal(root.querySelector('#composer-prompt'), area);
  assert.equal(area.disabled, true);
  assert.match(root.querySelector('[data-composer-wrap]').textContent, /Take control/);
  view.mount(root, viewState({ draft: '' }));
  assert.equal(area.value, '', 'a cleared draft still clears the field');
  cleanup();
});

test('pending free-text answer survives a routine render and resets on a new decision key', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  view.mount(root, viewState({ snapshot: questionSnapshot('question_a') }));
  const input = root.querySelector('[data-question-id="q1"]');
  input.value = 'typed answer';
  view.mount(root, viewState({ snapshot: questionSnapshot('question_a'), mutationPending: true }));
  assert.equal(root.querySelector('[data-question-id="q1"]'), input);
  assert.equal(input.value, 'typed answer');
  assert.equal(input.disabled, true, 'disabled state still syncs in place');
  view.mount(root, viewState({ snapshot: questionSnapshot('question_b') }));
  const next = root.querySelector('[data-question-id="q1"]');
  assert.notEqual(next, input);
  assert.equal(next.value, '');
  cleanup();
});

test('a stalled heartbeat for one conversation does not suppress another conversation', async () => {
  const stalled = deferred();
  const calls = [];
  const bridge = {
    clientId: 'client_a',
    dispose() {},
    logout: async () => {},
    connectEvents: async () => ({ close() {} }),
    command: async (operation, options) => {
      calls.push({ operation, sessionId: options?.sessionId });
      if (operation === 'control.heartbeat' && options.sessionId === 'session_a') return stalled.promise;
      if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshotFor(options.sessionId) };
      if (operation === 'control.heartbeat') return { ok: true, lease: { generation: 5, expires_at: 999999 } };
      return { ok: true };
    },
  };
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: viewState({
      sessions: [{ session_id: 'session_a', title: 'A' }, { session_id: 'session_b', title: 'B' }],
      control: { owned: true, ownerClientId: 'client_a', generation: 1, expiresAt: 999999 },
    }),
    view,
    reconnect: { start() {}, stop() {} },
  });
  try {
    const first = app.conversation.heartbeat();
    await new Promise((resolve) => setImmediate(resolve));
    await app.selectSession('session_b');
    app.state.control = { owned: true, ownerClientId: 'client_a', generation: 4, expiresAt: 999999 };
    await app.conversation.heartbeat();
    assert.ok(calls.some((entry) => entry.operation === 'control.heartbeat' && entry.sessionId === 'session_b'));
    stalled.resolve({ ok: true, lease: { generation: 1, expires_at: 1 } });
    await first;
  } finally {
    app.dispose();
    cleanup();
  }
});

test('attachment names: 240 accepted, 241 rejected with a preflight error, extension preserved', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const app = new BrowserApp({ root, bridge: {}, state: viewState(), view });
  const File = instance.window.File;
  const ok = new File(['x'], `${'a'.repeat(236)}.txt`, { type: 'text/plain', lastModified: 1 });
  const bad = new File(['x'], `${'a'.repeat(237)}.txt`, { type: 'text/plain', lastModified: 2 });
  const wide = new File(['x'], `${'\u{1F600}'.repeat(121)}.txt`, { type: 'text/plain', lastModified: 3 });
  assert.equal(app._attachmentLimit(ok, 0, 0, 0), '');
  assert.match(app._attachmentLimit(bad, 0, 0, 0), /file name is longer than the 240/u);
  // The host counts UTF-16 units: 121 astral characters + ".txt" = 246 units.
  assert.match(app._attachmentLimit(wide, 0, 0, 0), /file name is longer/u);
  assert.equal(app._attachmentFileName(ok).endsWith('.txt'), true);
  assert.equal(app._attachmentFileName(bad).length, 241);
  app.dispose();
  cleanup();
});

test('artifacts offer Preview only for supported MIME types', () => {
  const rows = view.renderArtifactList([
    { artifact_id: 'bin', file_name: 'blob.bin', mime_type: 'application/octet-stream' },
    { artifact_id: 'md', file_name: 'notes.md', mime_type: 'text/markdown' },
    // DKR-012: text-artifact producers omit mime_type.
    { artifact_id: 'bare', file_name: 'notes.md', language: 'markdown' },
    { artifact_id: 'bare-bin', file_name: 'x.md.exe' },
  ]);
  const holder = new JSDOM(`<div>${rows}</div>`).window.document;
  assert.equal(holder.querySelector('[data-artifact-id="bin"] [data-action="preview-artifact"]'), null);
  assert.ok(holder.querySelector('[data-artifact-id="bin"] [data-action="download-artifact"]'));
  assert.ok(holder.querySelector('[data-artifact-id="md"] [data-action="preview-artifact"]'));
  assert.ok(holder.querySelector('[data-artifact-id="bare"] [data-action="preview-artifact"]'));
  assert.equal(holder.querySelector('[data-artifact-id="bare-bin"] [data-action="preview-artifact"]'), null);
  assert.equal(view.artifactMimeType('text/markdown'), 'markdown');
  assert.equal(view.artifactMimeType('application/x-nope'), 'octet-stream');
});
