'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAttachmentIpcHandlers } = require('../../services/main/attachment-ipc-handlers');
const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
const { prepareAttachmentEntries } = require('../../services/attachment-service');
const { validateImageAttachmentsForManagedSend } = require('../../services/backend/managed-sidecar-attachments');
const { PROJECT_ERROR_CODES } = require('../../services/backend/error-codes');

function registerWithAttachmentDeps({ workspaceRoot, preparedCalls, backendService }) {
  const handlers = createAttachmentIpcHandlers({ backendService,
    shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
    processRef: { cwd: () => process.cwd() },
    isChildPath: (root, candidate) => Boolean(root) && String(candidate).startsWith(`${root}/`),
    prepareAttachmentEntries(paths) {
      preparedCalls.push(paths);
      return { accepted: paths.map(path => ({ path })), rejected: [] };
    },
  });
  return new Map([['attachments:prepare', handlers['attachments.prepare']]]);
}
test('attachments:prepare uses the originating session project instead of the UI workspace', async () => {
  const preparedCalls = [];
  const captured = [];
  const handlers = registerWithAttachmentDeps({ workspaceRoot: 'C:/ui-other', preparedCalls,
    backendService: { projectAuthority: {
      captureSession(id) { captured.push(id); return { project_id: 'project_a', root_path: 'C:/project-a' }; },
      requireCurrent() {},
    } } });
  const result = await handlers.get('attachments:prepare')({},
    ['C:/project-a/notes.md', 'C:/ui-other/notes.md'], { session_id: 'session-a' });
  assert.deepEqual(captured, ['session-a']);
  assert.deepEqual(preparedCalls, [['C:/project-a/notes.md']]);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /session.*project folder/);
});

test('unavailable project filesystem denies text without blocking explicit image imports', async () => {
  const preparedCalls = [];
  const handlers = registerWithAttachmentDeps({ workspaceRoot: 'C:/ui-other', preparedCalls,
    backendService: { projectAuthority: { captureSession() { throw Object.assign(new Error('root_unavailable'), { code: PROJECT_ERROR_CODES.UNAVAILABLE, reason: 'root_unavailable' }); } } } });
  const result = await handlers.get('attachments:prepare')({},
    ['C:/imports/photo.png', 'C:/ui-other/notes.md'], { session_id: 'session-a' });
  assert.deepEqual(preparedCalls, [['C:/imports/photo.png']]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
});

function importFixture(t, dialog = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attachment-intake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = new Map(['session-a', 'session-b'].map(id => [id,
    { id, project_id: `project_${id}`, created_at: '2026-09-09T12:00:00.000Z', messages: [] }]));
  const assetStore = new AttachmentAssetStore({ rootDir: root, nativeImage: null });
  const backend = { hostMode: 'desktop', attachmentAssetStore: assetStore,
    sessionStore: { peekSession: id => records.get(id), getSession: id => records.get(id),
      getSessionSummary: id => records.get(id) },
    projectAuthority: { captureSession() { throw Object.assign(new Error('project folder unavailable'), { code: PROJECT_ERROR_CODES.UNAVAILABLE, reason: 'root_unavailable' }); } } };
  const handlers = createAttachmentIpcHandlers({ backendService: backend,
    attachmentAssetStore: assetStore, prepareAttachmentEntries, dialog, getMainWindow: () => null,
    shellConfigService: { getState: () => ({ toolsWorkspaceRoot: 'other-root' }) },
    processRef: { cwd: () => root }, isChildPath: () => false });
  return { root, records, assetStore, backend, handlers };
}

test('image import receipt allows only its originating session even with an unavailable project folder', t => {
  const h = importFixture(t);
  const image = h.handlers['attachments.saveImageAsset']({}, {
    bytes: Buffer.from('image data'), mimeType: 'image/png', displayName: 'capture.png',
  }, { session_id: 'session-a' });
  assert.doesNotThrow(() => validateImageAttachmentsForManagedSend(h.backend, [image], {
    requestedSessionId: 'session-a', resolvedSessionId: 'session-a',
  }));
  assert.throws(() => validateImageAttachmentsForManagedSend(h.backend, [image], {
    requestedSessionId: 'session-b', resolvedSessionId: 'session-b',
  }));
});

test('picker scope is captured before its wait and a recreated session cannot receive its imports', async t => {
  let finish;
  const h = importFixture(t, { showOpenDialog: () => new Promise(resolve => { finish = resolve; }) });
  const selected = path.join(h.root, 'picked.png');
  fs.writeFileSync(selected, 'image data');
  const pending = h.handlers['attachments.pick']({}, { session_id: 'session-a' });
  h.records.set('session-a', { ...h.records.get('session-a'), created_at: '2026-09-09T13:00:00.000Z' });
  finish({ canceled: false, filePaths: [selected] });
  await assert.rejects(pending, /session changed/i);
  const images = path.join(h.root, 'images');
  assert.deepEqual(fs.existsSync(images) ? fs.readdirSync(images) : [], []);
  assert.equal(fs.readFileSync(selected, 'utf8'), 'image data');
});
