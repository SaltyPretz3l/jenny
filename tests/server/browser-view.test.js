'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const view = require('../../renderer/browser/browser-view');
const { BrowserApp } = require('../../renderer/browser/app');
const { BrowserBridgeError } = require('../../renderer/browser/browser-bridge');

function dom() {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  return instance;
}

function state(overrides = {}) {
  return {
    authenticated: true,
    connectionState: 'connected',
    sessions: [{ session_id: 'session_a', title: 'Browser chat', message_count: 2 }],
    selectedSessionId: 'session_a',
    snapshot: {
      session: { session_id: 'session_a', title: 'Browser chat', revision: 'boot:2', plan_mode: false },
      messages: [
        { id: 'user_a', role: 'user', content: 'Show me a safe answer', parent_stream_id: 'stream_a', attachments: [{ id: 'asset_a', kind: 'image', display_name: 'diagram.png', mime_type: 'image/png', size_bytes: 2048 }] },
        { id: 'assistant_a', role: 'assistant', content: '<img src=x onerror=alert(1)>**Done**', streamId: 'stream_a', visible_segments: [{ segment_id: 'seg_a', text: '<img src=x onerror=alert(1)>**Done**' }] },
        { id: 'large_a', role: 'assistant', content: 'Preview', full_message_available: true, streamId: 'stream_a' },
      ],
      pending_approvals: [],
      pending_questions: [],
    },
    liveProjection: null,
    planMode: false,
    draft: '',
    control: { owned: false, ownerClientId: '', generation: 0 },
    attachments: [],
    ...overrides,
  };
}

test('browser view mounts a responsive shell with inventory controls and sanitized projected transcript', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  view.mount(root, state());
  assert.ok(root.querySelector('[data-browser-app]'));
  assert.ok(root.querySelector('[data-action="new-session"]'));
  assert.ok(root.querySelector('[data-action="select-session"]'));
  assert.ok(root.querySelector('[data-transcript]'));
  assert.equal(root.querySelector('[data-transcript] [onerror]'), null);
  assert.match(root.querySelector('[data-transcript]').textContent, /Done/);
  assert.equal(root.querySelector('#composer-prompt').disabled, true);
  assert.match(root.querySelector('[data-composer-wrap]').textContent, /Take control/);
  delete global.window;
  delete global.document;
});

test('browser view exposes exact pending approval and question identities without persistent transcript state', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  view.mount(root, state({
    control: { owned: true, ownerClientId: 'client_a', generation: 3 },
    snapshot: {
      ...state().snapshot,
      pending_approvals: [{ approval_id: 'approval_a', decision_revision: 'revision_a', stream_id: 'stream_a', tool_name: 'workspace.write', summary: 'Write one file' }],
      pending_questions: [{ question_ref: 'question_a', stream_id: 'stream_a', questions: [{ id: 'question_id', prompt: 'Which file?', options: [{ id: 'readme', label: 'README' }] }] }],
    },
  }));
  const approve = root.querySelector('[data-action="approve-tool"]');
  const answer = root.querySelector('[data-action="answer-questions"]');
  assert.equal(approve.dataset.approvalId, 'approval_a');
  assert.equal(approve.dataset.decisionRevision, 'revision_a');
  assert.equal(approve.dataset.streamId, 'stream_a');
  assert.equal(answer.dataset.questionRef, 'question_a');
  assert.equal(root.querySelector('[data-question-id="question_id"]').value, '');
  assert.equal(root.querySelector('[data-action="approve-tool"]').disabled, false);
  assert.equal(root.querySelector('[data-action="deny-tool"]').textContent, 'Deny');
  delete global.window;
  delete global.document;
});

test('browser view renders login without interactive elements outside inventory primitives', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  view.mount(root, { authenticated: false, busy: false, error: '' });
  assert.ok(root.querySelector('[data-browser-login]'));
  assert.ok(root.querySelector('[data-action="login-submit"]'));
  assert.ok(root.querySelector('#login-password'));
  assert.equal(root.querySelector('main [data-browser-app]'), null);
  delete global.window;
  delete global.document;
});

test('browser question controls preserve multi-select arrays and the optional other answer', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const initial = state({
    control: { owned: true, ownerClientId: 'client_a', generation: 3 },
    snapshot: {
      ...state().snapshot,
      pending_approvals: [],
      pending_questions: [{
        question_ref: 'question_multi',
        stream_id: 'stream_a',
        questions: [{
          id: 'question_id',
          prompt: 'Pick files',
          multi_select: true,
          allow_other: true,
          options: [{ id: 'readme', label: 'README' }, { id: 'notes', label: 'Notes' }],
        }],
      }],
    },
  });
  const app = new BrowserApp({ root, bridge: {}, state: initial, view });
  root.querySelector('[data-question-option-id="readme"]').checked = true;
  root.querySelector('[data-question-option-id="notes"]').checked = true;
  root.querySelector('[data-question-other-for="question_id"]').value = 'Plan';
  assert.deepEqual(app._questionAnswers(), [{ question_id: 'question_id', answer: ['readme', 'notes'], other: 'Plan' }]);
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser app releases an owned lease when the retained acquire-control action is clicked', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const operations = [];
  const bridge = {
    clientId: 'client_a',
    command: async (operation) => {
      operations.push(operation);
      return { ok: true };
    },
  };
  const app = new BrowserApp({
    root,
    bridge,
    state: state({ control: { owned: true, ownerClientId: 'client_a', generation: 3 } }),
    view,
  });
  assert.equal(root.querySelector('[data-action="release-control"]')?.textContent, 'Release control');
  await app._handleClick({
    target: {
      closest: () => ({ dataset: { action: 'acquire-control', takeover: 'false' } }),
    },
  });
  assert.deepEqual(operations, ['control.release']);
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser view renders attachment metadata and explicit full message loading controls', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const snapshot = state().snapshot;
  snapshot.messages[0].content = 'Show me a safe answer';
  snapshot.messages.push({ id: 'large_only', role: 'assistant', content: 'Preview', full_message_available: true, streamId: 'stream_b' });
  view.mount(root, state({ snapshot }));
  assert.equal(root.querySelector('[data-action="open-attachment"]').dataset.attachmentId, 'asset_a');
  assert.equal(root.querySelector('[data-action="load-full-message"]').dataset.messageId, 'large_a');
  assert.match(root.querySelector('[data-attachment-list]').textContent, /diagram\.png/);
  delete global.window;
  delete global.document;
});

test('browser view exposes canonical generated artifact actions and owner device management', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const artifactMarkup = view.renderRow({ kind: 'tool_result', row_id: 'row_artifact', payload: {
    tool_name: 'workspace.write', generated_artifacts: [{ artifact_id: 'artifact_a', file_name: 'résumé.html', mime_type: 'text/html' }],
  }});
  root.innerHTML = artifactMarkup;
  assert.equal(root.querySelector('[data-action="preview-artifact"]').dataset.artifactId, 'artifact_a');
  assert.equal(root.querySelector('[data-action="download-artifact"]').dataset.artifactId, 'artifact_a');
  root.innerHTML = '';
  view.mount(root, state({ authSessionsOpen: true, authSessions: [{ id: 'device_a', current: true, last_seen_at: 'now' }, { id: 'device_b', current: false, last_seen_at: 'earlier' }] }));
  assert.ok(root.querySelector('[data-action="manage-auth-sessions"]'));
  assert.equal(root.querySelectorAll('[data-action="revoke-auth-session"]').length, 2);
  assert.match(root.querySelector('[data-auth-sessions]').textContent, /This device/u);
  delete global.window;
  delete global.document;
});

test('browser app keeps inert artifact previews bounded and fences stale binary loads', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const snapshot = { session: { session_id: 'session_a', title: 'Artifacts', revision: 'r1' }, messages: [{ id: 'tool_a', tool_result: { generated_artifacts: [{ artifact_id: 'artifact_a', file_name: 'résumé.html', mime_type: 'text/html' }] } }] };
  const created = [];
  const priorUrl = global.URL;
  global.URL = { createObjectURL: (blob) => { created.push(blob); return `blob:artifact-${created.length}`; }, revokeObjectURL: () => {} };
  const bridge = { downloadArtifact: async () => ({ artifactMimeType: 'html', contentDisposition: "filename*=UTF-8''r%C3%A9sum%C3%A9.html", blob: new Blob(['<script>window.bad=1</script><p>safe</p>'], { type: 'application/octet-stream' }) }) };
  const app = new BrowserApp({ root, bridge, state: state({ snapshot, control: { owned: true, ownerClientId: 'client_a', generation: 1 } }), view });
  await app._downloadArtifact('artifact_a', { preview: true });
  const frame = root.querySelector('[data-artifact-previews] iframe');
  assert.equal(frame.getAttribute('sandbox'), '');
  assert.equal(frame.hasAttribute('allow'), false);
  assert.match(await created[0].text(), /Content-Security-Policy/u);
  assert.match(await created[0].text(), /default-src &#39;none&#39;|default-src 'none'/u);
  app.dispose();
  global.URL = priorUrl;
  delete global.window;
  delete global.document;
});

test('browser app does not publish a late artifact preview after session change', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  let resolveDownload;
  let signal;
  const snapshot = { session: { session_id: 'session_a', title: 'Artifacts', revision: 'r1' }, messages: [{ id: 'tool_a', tool_result: { generated_artifacts: [{ artifact_id: 'artifact_a', file_name: 'code.txt', mime_type: 'text/plain' }] } }] };
  const bridge = { downloadArtifact: async (_session, _id, options) => { signal = options.signal; return new Promise((resolve) => { resolveDownload = resolve; }); }, command: async () => ({ ok: true, snapshot: null }) };
  const app = new BrowserApp({ root, bridge, state: state({ snapshot, control: { owned: true, ownerClientId: 'client_a', generation: 1 } }), view });
  const pending = app._downloadArtifact('artifact_a', { preview: true });
  await new Promise((resolve) => setImmediate(resolve));
  await app.selectSession('session_b');
  assert.equal(signal.aborted, true);
  resolveDownload({ artifactMimeType: 'text/plain', blob: new Blob(['late']) });
  await pending;
  assert.equal(root.querySelector('[data-artifact-previews]').textContent, '');
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser app enforces four images while retaining the exact one million byte text limit', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const bridge = { uploadAttachment: async (file) => ({ ok: true, attachment: { id: file.name, display_name: file.name, mime_type: file.type, size_bytes: file.size } }) };
  const app = new BrowserApp({ root, bridge, state: state({ control: { owned: true, ownerClientId: 'client_a', generation: 1 } }), view });
  const images = [1, 2, 3, 4].map((n) => new instance.window.File(['x'], `image-${n}.png`, { type: 'image/png', lastModified: n }));
  await app._queueFiles(images);
  assert.equal(app.state.attachments.length, 4);
  await app._queueFiles([new instance.window.File(['x'], 'fifth.png', { type: 'image/png', lastModified: 5 })]);
  assert.equal(app.state.attachments.length, 4);
  const tooLarge = new instance.window.File(['x'.repeat(1_000_001)], 'too-large.txt', { type: 'text/plain' });
  assert.match(app._attachmentLimit(tooLarge, 0, 0, 0), /larger/u);
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser app uploads each selected attachment once, sends canonical ids, and clears the queue only after acceptance', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const calls = [];
  const bridge = {
    uploadAttachment: async (file) => {
      calls.push(file);
      return { ok: true, attachment: { id: 'asset_a', kind: 'image', display_name: file.name, mime_type: file.type, size_bytes: file.size } };
    },
    command: async (operation, options) => {
      calls.push({ operation, options });
      return { ok: true, accepted: true, stream_id: 'stream_a' };
    },
  };
  const app = new BrowserApp({ root, bridge, state: state({ control: { owned: true, ownerClientId: 'client_a', generation: 1 }, draft: 'Describe this image' }), view });
  const file = new instance.window.File(['abc'], 'diagram.png', { type: 'image/png', lastModified: 12 });
  await app._queueFiles([file, file]);
  assert.equal(calls.filter((entry) => entry instanceof instance.window.File).length, 1);
  assert.deepEqual(app.state.attachments.map((item) => item.attachment.id), ['asset_a']);
  assert.match(root.querySelector('[data-attachment-queue]').textContent, /Image staged; checked when sent/u);
  await app.send();
  const send = calls.find((entry) => entry?.operation === 'chat.send');
  assert.deepEqual(send.options.params.attachment_ids, ['asset_a']);
  assert.equal(app.state.attachments.length, 0);
  assert.equal(app.state.draft, '');
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser app keeps draft and failed attachment queue entries for explicit retry or removal', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  let commandCalls = 0;
  const bridge = {
    uploadAttachment: async () => { throw new BrowserBridgeError('bad_upload', { code: 'invalid_server_response' }); },
    command: async () => { commandCalls += 1; return { ok: true }; },
  };
  const app = new BrowserApp({ root, bridge, state: state({ control: { owned: true, ownerClientId: 'client_a', generation: 1 }, draft: 'Keep me' }), view });
  const file = new instance.window.File(['abc'], 'notes.txt', { type: 'text/plain', lastModified: 13 });
  await app._queueFiles([file]);
  assert.equal(app.state.attachments[0].status, 'error');
  await app.send();
  assert.equal(commandCalls, 0);
  assert.equal(app.state.draft, 'Keep me');
  assert.equal(app.state.attachments.length, 1);
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser app preserves draft and uploaded attachment ids when chat admission fails', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  const bridge = {
    uploadAttachment: async (file) => ({ ok: true, attachment: { id: 'asset_b', kind: 'text', display_name: file.name, mime_type: file.type, size_bytes: file.size } }),
    command: async () => ({ ok: false, error: { reason: 'foreground_busy' } }),
  };
  const app = new BrowserApp({ root, bridge, state: state({ control: { owned: true, ownerClientId: 'client_a', generation: 1 }, draft: 'Keep this draft' }), view });
  await app._queueFiles([new instance.window.File(['abc'], 'notes.txt', { type: 'text/plain', lastModified: 14 })]);
  await app.send();
  assert.equal(app.state.draft, 'Keep this draft');
  assert.deepEqual(app.state.attachments.map((item) => item.attachment.id), ['asset_b']);
  app.dispose();
  delete global.window;
  delete global.document;
});

test('browser app fences full message and attachment downloads across session changes and dispose', async () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  let resolveMessage;
  let resolveAttachment;
  let messageSignal;
  let attachmentSignal;
  const bridge = {
    fetchFullMessage: async (_sessionId, _messageId, options) => {
      messageSignal = options.signal;
      return new Promise((resolve) => { resolveMessage = resolve; });
    },
    downloadAttachment: async (_sessionId, _attachmentId, options) => {
      attachmentSignal = options.signal;
      return new Promise((resolve) => { resolveAttachment = resolve; });
    },
  };
  const app = new BrowserApp({ root, bridge, state: state({ control: { owned: true, ownerClientId: 'client_a', generation: 1 }, snapshot: { ...state().snapshot, messages: [{ id: 'large_a', role: 'assistant', content: 'Preview', full_message_available: true }] } }), view });
  const fullLoad = app.loadFullMessage('large_a');
  const attachmentLoad = app._openAttachment('asset_a');
  await new Promise((resolve) => setImmediate(resolve));
  await app.selectSession('session_b');
  assert.equal(messageSignal.aborted, true);
  assert.equal(attachmentSignal.aborted, true);
  resolveMessage({ ok: true, message: { id: 'large_a', content: 'Late full content' } });
  resolveAttachment({ blob: new Blob(['late'], { type: 'text/plain' }) });
  await Promise.all([fullLoad, attachmentLoad]);
  assert.equal(app.state.snapshot, null);
  app.dispose();
  delete global.window;
  delete global.document;
});


test('browser explains disposable command files only when the host advertises execution', () => {
  const instance = dom();
  const root = instance.window.document.getElementById('root');
  try {
    view.mount(root, state({ executionEnabled: true,
      control: { owned: true, ownerClientId: 'client_a', generation: 1 } }));
    assert.match(root.querySelector('.browser-composer-hint').textContent, /command file changes are discarded/);
    view.mount(root, state({ executionEnabled: false,
      control: { owned: true, ownerClientId: 'client_a', generation: 1 } }));
    assert.match(root.querySelector('.browser-composer-hint').textContent, /sandbox is disabled/);
  } finally { delete global.window; delete global.document; instance.window.close(); }
});
