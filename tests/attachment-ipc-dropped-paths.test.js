const test = require('node:test');
const assert = require('node:assert/strict');

const { createAttachmentIpcHandlers } = require('../services/main/attachment-ipc-handlers');

function createHandlers({ workspaceRoot = 'C:/workspace', projectAuthority = null } = {}) {
  const preparedCalls = [];
  const handlers = createAttachmentIpcHandlers({
    backendService: projectAuthority ? { projectAuthority } : {},
    shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
    dialog: {},
    getMainWindow: () => null,
    prepareAttachmentEntries: (paths, options) => {
      preparedCalls.push({ paths, options });
      return { accepted: paths.map((p) => ({ kind: 'text', path: p, displayName: p })), rejected: [] };
    },
    attachmentAssetStore: null,
    processRef: { cwd: () => 'C:/cwd' },
    isChildPath: (root, candidate) => Boolean(root) && String(candidate || '').startsWith(`${root}/`),
    log: () => null,
  });
  return { handlers, preparedCalls };
}

test('prepareDroppedPaths treats user-dropped files like a picker selection', async () => {
  const { handlers, preparedCalls } = createHandlers();
  const result = await handlers['attachments.prepareDroppedPaths']({}, ['D:/outside/notes.txt', '', 42, null], { session_id: 's1' });

  assert.deepEqual(preparedCalls.map((call) => call.paths), [['D:/outside/notes.txt']]);
  // The picker's rules: no textRoot containment, the process cwd.
  assert.equal(preparedCalls[0].options.textRoot, undefined);
  assert.equal(preparedCalls[0].options.cwd, 'C:/cwd');
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

test('the page-facing prepare keeps rejecting the same out-of-root text', async () => {
  const { handlers, preparedCalls } = createHandlers();
  const result = await handlers['attachments.prepare']({}, ['D:/outside/notes.txt']);

  assert.deepEqual(preparedCalls.map((call) => call.paths), [[]]);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0].reason, /outside the tools workspace root/i);
});

test('prepareDroppedPaths tolerates a missing path list', async () => {
  const { handlers, preparedCalls } = createHandlers();
  const result = await handlers['attachments.prepareDroppedPaths']({}, undefined);
  assert.deepEqual(preparedCalls.map((call) => call.paths), [[]]);
  assert.deepEqual(result.accepted, []);
});
