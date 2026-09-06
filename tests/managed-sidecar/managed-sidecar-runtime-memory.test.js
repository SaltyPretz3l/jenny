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

test('managed sidecar runtime suggests and saves approved memories through JSON-RPC', async () => {
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

  const suggestions = await service.suggestMemoriesForSession(stream.sessionId);
  assert.equal(suggestions.suggestions.length, 1);
  assert.equal(suggestions.suggestions[0].lesson_kind, 'preference');

  const firstSave = await service.saveMemoryForSession(stream.sessionId, suggestions.suggestions[0]);
  const secondSave = await service.saveMemoryForSession(stream.sessionId, suggestions.suggestions[0]);

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

test('managed sidecar runtime suggests response-style memories and recalls them on later sends', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-style-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const created = await service.createSession({
    title: 'Memory Style Session',
  });
  const firstCompleted = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  const firstStream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please be concise when you answer.',
  });
  await firstCompleted;

  const suggestions = await service.suggestMemoriesForSession(firstStream.sessionId);
  assert.equal(suggestions.suggestions.length, 1);
  assert.equal(suggestions.suggestions[0].lesson_kind, 'response_style');

  const saveResult = await service.saveMemoryForSession(firstStream.sessionId, suggestions.suggestions[0]);
  assert.equal(saveResult.created, true);

  const recallCompleted = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete' && event.sessionId === firstStream.sessionId
  );
  await service.startChatStream({
    sessionId: firstStream.sessionId,
    prompt: 'Should I have that this afternoon?',
  });
  const recalled = await recallCompleted;
  assert.match(recalled.content, /learning context/i);

  await service.stop();
});

test('managed sidecar runtime suggests tool-strategy memories and recalls them on later sends', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-tool-strategy-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const created = await service.createSession({
      title: 'Memory Tool Strategy Session',
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_tool_strategy_1',
      role: 'user',
      content: 'Prefer apply_patch for small edits.',
      timestamp: new Date().toISOString(),
      client_message_id: 'user_memory_tool_strategy_1',
    });

    const suggestions = await service.suggestMemoriesForSession(created.data.id);
    assert.equal(suggestions.suggestions.length, 1);
    assert.equal(suggestions.suggestions[0].lesson_kind, 'tool_strategy');

    const saveResult = await service.saveMemoryForSession(created.data.id, suggestions.suggestions[0]);
    assert.equal(saveResult.created, true);

    const recalled = await service.recallApprovedMemories('apply_patch small edits', 3);
    assert.equal(recalled.memories.length, 1);
    assert.equal(recalled.memories[0].lesson_kind, 'tool_strategy');
  } finally {
    await service.stop();
  }
});

test('managed sidecar runtime suggests working-preference memories and recalls them on later sends', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-working-preference-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const created = await service.createSession({
      title: 'Memory Working Preference Session',
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_working_preference_1',
      role: 'user',
      content: 'Please diagnose the root cause before proposing fixes.',
      timestamp: new Date().toISOString(),
    });

    const suggestions = await service.suggestMemoriesForSession(created.data.id);
    assert.equal(suggestions.suggestions.length, 1);
    assert.equal(suggestions.suggestions[0].lesson_kind, 'working_preference');

    const saveResult = await service.saveMemoryForSession(created.data.id, suggestions.suggestions[0]);
    assert.equal(saveResult.created, true);

    const recalled = await service.recallApprovedMemories('debug this issue and find the root cause', 3);
    assert.equal(recalled.memories.length, 1);
    assert.equal(recalled.memories[0].lesson_kind, 'working_preference');
  } finally {
    await service.stop();
  }
});

test('managed sidecar runtime suggests project-context memories and recalls them on later sends', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-project-context-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const created = await service.createSession({
      title: 'Memory Project Context Session',
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_project_context_1',
      role: 'user',
      content: 'This workspace has no .git metadata.',
      timestamp: new Date().toISOString(),
    });

    const suggestions = await service.suggestMemoriesForSession(created.data.id);
    assert.equal(suggestions.suggestions.length, 1);
    assert.equal(suggestions.suggestions[0].lesson_kind, 'project_context');

    const saveResult = await service.saveMemoryForSession(created.data.id, suggestions.suggestions[0]);
    assert.equal(saveResult.created, true);

    const recalled = await service.recallApprovedMemories('what branch am I on in git?', 3);
    assert.equal(recalled.memories.length, 1);
    assert.equal(recalled.memories[0].lesson_kind, 'project_context');
  } finally {
    await service.stop();
  }
});

test('managed sidecar fake sidecar ranks the best memory suggestion across multiple user messages', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-ranking-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const created = await service.createSession({
      title: 'Memory Ranking Session',
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_rank_1',
      role: 'user',
      content: 'I love jazz.',
      timestamp: new Date().toISOString(),
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_rank_2',
      role: 'user',
      content: 'Please be direct when you answer.',
      timestamp: new Date().toISOString(),
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_rank_3',
      role: 'user',
      content: 'Keep diffs small.',
      timestamp: new Date().toISOString(),
    });

    const suggestions = await service.suggestMemoriesForSession(created.data.id);

    assert.equal(suggestions.suggestions.length, 1);
    assert.equal(suggestions.suggestions[0].lesson_kind, 'response_style');
    assert.equal(suggestions.suggestions[0].title, 'Response style: direct');
  } finally {
    await service.stop();
  }
});

test('managed sidecar fake sidecar does not recall generic tool-strategy overlap', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-memory-tool-gating-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const created = await service.createSession({
      title: 'Memory Tool Gating Session',
    });
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_tool_gating_1',
      role: 'user',
      content: 'Plan before implementation.',
      timestamp: new Date().toISOString(),
    });

    const suggestions = await service.suggestMemoriesForSession(created.data.id);
    assert.equal(suggestions.suggestions.length, 1);

    await service.saveMemoryForSession(created.data.id, suggestions.suggestions[0]);

    const genericRecall = await service.recallApprovedMemories('plan the release work', 3);
    const relevantRecall = await service.recallApprovedMemories(
      'How should we plan the implementation for this feature?',
      3
    );

    assert.equal(genericRecall.memories.length, 0);
    assert.equal(relevantRecall.memories.length, 1);
    assert.equal(relevantRecall.memories[0].lesson_kind, 'tool_strategy');
  } finally {
    await service.stop();
  }
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
    service.sessionStore.appendMessage(created.data.id, {
      id: 'user_memory_management_1',
      role: 'user',
      content: 'I prefer tea over coffee.',
      timestamp: new Date().toISOString(),
    });

    const suggestions = await service.suggestMemoriesForSession(created.data.id);
    const saved = await service.saveMemoryForSession(created.data.id, suggestions.suggestions[0]);
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

test('memory save forwards only allowlisted candidate fields and bounds their serialized bytes', async () => {
  const requests = [];
  const service = {
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
