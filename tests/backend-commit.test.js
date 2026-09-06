const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCommitMessage } = require('../services/backend/backend-commit');

function createMockService(overrides = {}) {
  return {
    currentStatus: { model_loaded: true },
    currentModel: 'mock-v1',
    sidecarClient: {
      request: async () => ({ message: 'feat: add thing' }),
    },
    sidecarManager: {
      getStatus: () => ({ phase: 'ready' }),
    },
    _emitServiceLog: () => {},
    ...overrides,
  };
}

test('returns empty_diff when the diff is blank (before any sidecar guard)', async () => {
  // A blank-after-trim diff short-circuits even when the sidecar is unavailable.
  const service = createMockService({ sidecarClient: null });
  assert.deepEqual(await generateCommitMessage(service, { diff: '\n  \t' }), { ok: false, reason: 'empty_diff' });
});

test('returns sidecar_unavailable when sidecarClient is null', async () => {
  const service = createMockService({ sidecarClient: null });
  assert.equal((await generateCommitMessage(service, { diff: 'x' })).reason, 'sidecar_unavailable');
});

test('returns sidecar_not_ready when the sidecar phase is not ready', async () => {
  const service = createMockService({ sidecarManager: { getStatus: () => ({ phase: 'starting' }) } });
  assert.equal((await generateCommitMessage(service, { diff: 'x' })).reason, 'sidecar_not_ready');
});

test('returns model_not_loaded when no model is loaded', async () => {
  const service = createMockService({ currentStatus: { model_loaded: false }, currentModel: '' });
  assert.equal((await generateCommitMessage(service, { diff: 'x' })).reason, 'model_not_loaded');
});

test('returns the generated message and forwards the diff off-transcript', async () => {
  let captured = null;
  const service = createMockService({
    sidecarClient: {
      request: async (method, params) => { captured = { method, params }; return { message: 'feat: ship it' }; },
    },
  });
  const res = await generateCommitMessage(service, { diff: 'the-diff' });
  assert.deepEqual(res, { ok: true, message: 'feat: ship it' });
  assert.equal(captured.method, 'commit.generate_message', 'uses the dedicated off-transcript method');
  assert.equal(captured.params.diff, 'the-diff', 'diff handed straight to the sidecar');
});

test('forwards the diff-truncation summary when the sidecar reports it', async () => {
  const service = createMockService({
    sidecarClient: {
      request: async () => ({
        message: 'chore: sweeping change',
        truncated: true,
        omitted_files: 4,
        total_files: 9,
      }),
    },
  });
  const res = await generateCommitMessage(service, { diff: 'x' });
  assert.deepEqual(res, {
    ok: true,
    message: 'chore: sweeping change',
    truncated: true,
    omittedFiles: 4,
    totalFiles: 9,
  });
});

test('omits truncation fields when the sidecar does not report truncation', async () => {
  const res = await generateCommitMessage(createMockService(), { diff: 'x' });
  assert.deepEqual(res, { ok: true, message: 'feat: add thing' });
});

test('runs even while a chat stream is active (foreground, user-initiated)', async () => {
  // Unlike suggestions, this has no active-streams skip: the user clicked it.
  const service = createMockService({ activeStreams: new Map([['s', {}]]) });
  assert.equal((await generateCommitMessage(service, { diff: 'x' })).ok, true);
});

test('returns empty_message when the model returns nothing usable', async () => {
  const service = createMockService({ sidecarClient: { request: async () => ({ message: '   ' }) } });
  assert.equal((await generateCommitMessage(service, { diff: 'x' })).reason, 'empty_message');
});

test('returns generate_failed (no throw) and logs on a sidecar error', async () => {
  const logs = [];
  const service = createMockService({
    sidecarClient: { request: async () => { throw new Error('sidecar down'); } },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
  });
  const res = await generateCommitMessage(service, { diff: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'generate_failed');
  assert.match(res.message, /sidecar down/);
  assert.equal(logs[0].event, 'commit_message.generate_failed');
});
