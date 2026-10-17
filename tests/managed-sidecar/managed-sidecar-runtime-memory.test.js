const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  createManagedService,
} = require('../helpers/managed-sidecar-runtime-helpers');
const { saveMemoryForSession } = require('../../services/backend/backend-memory');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const TEA_PREFERENCE = Object.freeze({
  title: 'Preference: tea over coffee',
  lesson_text: 'The user prefers tea over coffee.',
  lesson_kind: 'preference',
  confidence: 0.95,
  source_excerpt: 'I prefer tea over coffee',
  content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
});

test('managed sidecar runtime saves approved memories through JSON-RPC and recalls them on later sends', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const created = await service.createSession({
    title: 'Memory Session',
  });
  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'I prefer tea over coffee.',
  });
  await completed;

  const firstSave = await service.saveMemoryForSession(stream.sessionId, TEA_PREFERENCE);
  const secondSave = await service.saveMemoryForSession(stream.sessionId, TEA_PREFERENCE);

  assert.equal(firstSave.created, true);
  assert.equal(secondSave.created, false);
  assert.equal(firstSave.memory.id, secondSave.memory.id);

  const recallCompleted = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete' && event.sessionId === stream.sessionId
  );
  await service.startChatStream({
    sessionId: stream.sessionId,
    prompt: 'Should I have that this afternoon?',
  });
  const recalled = await recallCompleted;
  assert.match(recalled.content, /learning context/i);

  await service.stop();
});

test('managed sidecar runtime lists, updates, and deletes approved memories', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-management-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const created = await service.createSession({
      title: 'Memory Management Session',
    });
    const saved = await service.saveMemoryForSession(created.data.id, TEA_PREFERENCE);
    const listed = await service.listApprovedMemories();
    const updated = await service.updateApprovedMemory(saved.memory.id, {
      title: 'Preference: green tea',
      lesson_text: 'The user prefers green tea over coffee.',
    });
    const deleted = await service.deleteApprovedMemory(saved.memory.id);
    const listedAfterDelete = await service.listApprovedMemories();

    assert.equal(listed.memories.length, 1);
    assert.equal(updated.updated, true);
    assert.equal(updated.memory.title, 'Preference: green tea');
    assert.equal(deleted.deleted, true);
    assert.equal(listedAfterDelete.memories.length, 0);
  } finally {
    await service.stop();
  }
});

test('managed sidecar runtime serves the v9 ledger: revisions, conflicts, delete tombstones and undo', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-ledger-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();
    const created = await service.createSession({ title: 'Memory Ledger Session' });
    const saved = await service.saveMemoryForSession(created.data.id, TEA_PREFERENCE);
    assert.equal(saved.memory.revision, 1);
    assert.equal(saved.memory.status, 'active');
    assert.equal(saved.memory.project_id, 'project_general');
    assert.equal(saved.undoable, true);

    const patch = { title: 'Preference: green tea', lesson_text: 'The user prefers green tea.' };
    const stale = await service.updateApprovedMemory(saved.memory.id, patch, undefined, { expectedRevision: 5 });
    assert.equal(stale.updated, false);
    assert.equal(stale.status, 'conflict');
    assert.equal(stale.reason, 'stale_revision');
    assert.equal(stale.memory.revision, 1);

    const updated = await service.updateApprovedMemory(saved.memory.id, patch, undefined, { expectedRevision: 1 });
    assert.equal(updated.updated, true);
    assert.equal(updated.memory.revision, 2);

    const conflict = await service.deleteApprovedMemory(saved.memory.id, undefined, { expectedRevision: 1 });
    assert.equal(conflict.deleted, false);
    assert.equal(conflict.status, 'conflict');
    assert.equal((await service.listApprovedMemories()).memories.length, 1);

    const deleted = await service.deleteApprovedMemory(saved.memory.id, undefined, { expectedRevision: 2 });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.undoable, true);
    assert.equal(deleted.memory.status, 'archived');
    assert.equal((await service.listApprovedMemories()).memories.length, 0);

    // Undo is a compare-and-set on the revision an operation produced: the
    // delete moved the row on, so undoing the earlier edit is a conflict.
    const staleUndo = await service.undoApprovedMemoryChange(updated.operation_id, 'project_general');
    assert.equal(staleUndo.status, 'conflict');

    const wrongProject = await service.undoApprovedMemoryChange(deleted.operation_id, 'project_other');
    assert.equal(wrongProject.status, 'refused');
    assert.equal(wrongProject.reason, 'not_found');
    const undone = await service.undoApprovedMemoryChange(deleted.operation_id, 'project_general');
    assert.equal(undone.status, 'saved');
    const relisted = (await service.listApprovedMemories()).memories;
    assert.equal(relisted.length, 1);
    assert.equal(relisted[0].id, saved.memory.id);
    assert.equal(relisted[0].revision, 4);

    // A well-formed digest that is not queued (production rejects a malformed one as invalid params).
    const accepted = await service.acceptPendingMemory(created.data.id, `sha256:${'0'.repeat(64)}`);
    assert.equal(accepted.accepted, false);
    assert.equal(accepted.status, 'refused');
    assert.equal(accepted.reason, 'not_found');
  } finally {
    await service.stop();
  }
});

test('memory save forwards only allowlisted candidate fields and bounds their serialized bytes', async () => {
  const requests = [];
  const service = {
    projectAuthority: { captureSession: (id) => {
      assert.equal(id, 'session-1');
      return { project_id: 'project_alpha' };
    } },
    sidecarClient: {
      async request(method, params) {
        requests.push({ method, params });
        return { created: false, memory: null };
      },
    },
    _emitServiceLog() {},
  };
  const candidate = {
    title: 'Title',
    lesson_text: 'Lesson',
    lesson_kind: 'preference',
    confidence: 0.75,
    source_excerpt: 'Excerpt',
    content_fingerprint: 'digest',
    extra: 'x'.repeat(1_000_000),
  };

  await saveMemoryForSession(service, 'session-1', candidate);

  assert.equal(requests[0].method, 'memory.save');
  assert.equal(requests[0].params.project_id, 'project_alpha');
  assert.deepEqual(requests[0].params.candidate, {
    title: 'Title',
    lesson_text: 'Lesson',
    lesson_kind: 'preference',
    confidence: 0.75,
    source_excerpt: 'Excerpt',
    content_fingerprint: 'digest',
  });
  await assert.rejects(
    saveMemoryForSession(service, 'session-1', {
      ...candidate,
      lesson_text: '🙂'.repeat(13_000),
    }),
    /payload exceeds limit/
  );
  assert.equal(requests.length, 1);
});
