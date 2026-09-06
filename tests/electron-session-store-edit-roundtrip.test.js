// CTL-001 acceptance contract: edit-and-resend must never resurrect the
// pre-edit prompt or the deleted answer, across the FULL path — store
// truncation -> (simulated restart) -> terminal hydration payload -> turn-tree
// projection. Uses production persisted event kinds (user_prompt,
// assistant_text_segment, reasoning_phase, tool_result) rather than the
// test-only user_bubble shorthand.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function freshStore() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-edit-roundtrip-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  return { store, storePath };
}

function seedTwoTurnSession(store, sessionId) {
  store.appendMessage(sessionId, {
    id: 'user_stream_1', role: 'user', content: 'first prompt', timestamp: '2026-07-01T10:00:00.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'assistant_stream_1', role: 'assistant', content: 'first reply', timestamp: '2026-07-01T10:00:01.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'user_stream_2', role: 'user', content: 'second prompt', timestamp: '2026-07-01T10:00:02.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'assistant_stream_2', role: 'assistant', content: 'second reply', timestamp: '2026-07-01T10:00:03.000Z',
  });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_1:user_prompt:0', turn_id: 'stream_1', kind: 'user_prompt',
      primary_message_id: 'user_stream_1', source_message_ids: ['user_stream_1'],
      payload: { content: 'first prompt' },
    },
    {
      event_id: 'stream_1:assistant_text_segment:0', turn_id: 'stream_1', kind: 'assistant_text_segment',
      primary_message_id: 'assistant_stream_1', source_message_ids: ['assistant_stream_1'],
      payload: { text: 'first reply', content: 'first reply' },
    },
    {
      event_id: 'stream_2:user_prompt:0', turn_id: 'stream_2', kind: 'user_prompt',
      primary_message_id: 'user_stream_2', source_message_ids: ['user_stream_2'],
      payload: { content: 'second prompt' },
    },
    {
      event_id: 'stream_2:reasoning_phase:0', turn_id: 'stream_2', kind: 'reasoning_phase',
      primary_message_id: 'assistant_stream_2', source_message_ids: ['assistant_stream_2'],
      payload: { entries: [{ id: 'r1', text: 'thinking about the second reply' }] },
    },
    {
      event_id: 'stream_2:tool_result:0', turn_id: 'stream_2', kind: 'tool_result',
      primary_message_id: 'assistant_stream_2', source_message_ids: ['assistant_stream_2'],
      payload: { tool: 'read_file', summary: 'read a file for the second reply' },
    },
    {
      event_id: 'stream_2:assistant_text_segment:0', turn_id: 'stream_2', kind: 'assistant_text_segment',
      primary_message_id: 'assistant_stream_2', source_message_ids: ['assistant_stream_2'],
      payload: { text: 'second reply', content: 'second reply' },
    },
  ]);
}

function projectSession(session) {
  return projectTurnTree({
    messages: normalizeChatMessages(session.messages),
    turn_events: session.turn_events,
    turn_event_log_version: session.turn_event_log_version || 1,
  });
}

function treeDump(result) {
  return JSON.stringify(result.turns);
}

test('editing the last prompt: old assistant/reasoning/tool rows do not project, before and after restart', () => {
  const { store, storePath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Round trip' });
  seedTwoTurnSession(store, sessionId);

  store.truncateAfterMessage(sessionId, 'user_stream_2', {
    replaceMessageContent: 'edited second prompt',
  });

  const assertProjection = (session, label) => {
    const result = projectSession(session);
    const dump = treeDump(result);
    assert.ok(!dump.includes('second reply'), `${label}: the deleted answer must not project`);
    assert.ok(!dump.includes('thinking about the second reply'), `${label}: deleted reasoning must not project`);
    assert.ok(!dump.includes('read a file for the second reply'), `${label}: deleted tool rows must not project`);
    assert.ok(
      !dump.includes('"second prompt"'),
      `${label}: the PRE-EDIT prompt payload must not project anywhere`
    );
    // First turn survives untouched.
    assert.ok(dump.includes('first prompt'), `${label}: prior turn user prompt survives`);
    assert.ok(dump.includes('first reply'), `${label}: prior turn reply survives`);
    // The edited text is the only content available for the edited slot: either
    // projected in the tree or carried by the (unclaimed) canonical message.
    const editedInTree = dump.includes('edited second prompt');
    const editedMessage = session.messages.find((m) => String(m.id) === 'user_stream_2');
    assert.equal(editedMessage.content, 'edited second prompt', `${label}: store carries the edited text`);
    assert.ok(
      editedInTree || !result.byMessageId.user_stream_2,
      `${label}: the edited message is either projected with edited text or left for message-derived rendering — never projected with stale payload`
    );
  };

  assertProjection(store.getSession(sessionId), 'pre-restart');

  // Simulated restart: flush to disk, reload a fresh store instance.
  store.flush();
  const reloaded = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  assertProjection(reloaded.getSession(sessionId), 'post-restart');
});

test('editing the first prompt of a multi-turn session: every later turn disappears from projection', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Round trip first' });
  seedTwoTurnSession(store, sessionId);

  store.truncateAfterMessage(sessionId, 'user_stream_1', {
    replaceMessageContent: 'edited first prompt',
  });

  const session = store.getSession(sessionId);
  assert.deepEqual(session.turn_events, []);
  const result = projectSession(session);
  const dump = treeDump(result);
  assert.ok(!dump.includes('first reply'), 'the deleted first answer must not project');
  assert.ok(!dump.includes('"first prompt"'), 'the pre-edit first prompt payload must not project');
  assert.ok(!dump.includes('second prompt'), 'later turns must disappear entirely');
  assert.ok(!dump.includes('second reply'), 'later turns must disappear entirely');
});

test('editing a prompt with attachments leaves no stale attachment events behind', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Attachments' });
  store.appendMessage(sessionId, {
    id: 'user_stream_att', role: 'user', content: 'look at this image',
    attachments: [{ kind: 'image', displayName: 'old-shot.png', assetPath: 'C:/assets/old-shot.png' }],
    timestamp: '2026-07-01T10:00:00.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'assistant_stream_att', role: 'assistant', content: 'nice image', timestamp: '2026-07-01T10:00:01.000Z',
  });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_att:user_prompt:0', turn_id: 'stream_att', kind: 'user_prompt',
      primary_message_id: 'user_stream_att', source_message_ids: ['user_stream_att'],
      payload: { content: 'look at this image' },
    },
    {
      event_id: 'stream_att:attachment_cluster:0', turn_id: 'stream_att', kind: 'attachment_cluster',
      primary_message_id: 'user_stream_att', source_message_ids: ['user_stream_att'],
      payload: { attachments: [{ kind: 'image', name: 'old-shot.png' }] },
    },
    {
      event_id: 'stream_att:assistant_text_segment:0', turn_id: 'stream_att', kind: 'assistant_text_segment',
      primary_message_id: 'assistant_stream_att', source_message_ids: ['assistant_stream_att'],
      payload: { text: 'nice image', content: 'nice image' },
    },
  ]);

  store.truncateAfterMessage(sessionId, 'user_stream_att', {
    replaceMessageContent: 'look at this new image',
    replaceMessageAttachments: [
      { kind: 'image', displayName: 'new-shot.png', assetPath: 'C:/assets/new-shot.png' },
    ],
  });

  const session = store.getSession(sessionId);
  assert.deepEqual(session.turn_events, [], 'stale attachment/user/assistant events are gone');
  const attachments = session.messages[0].attachments || [];
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].displayName, 'new-shot.png', 'only the replayable replacement attachment survives');
});

test('after resend re-anchors the edited message, the prompt projects exactly once with no unclaimed leftover', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Resend end-state' });
  seedTwoTurnSession(store, sessionId);

  store.truncateAfterMessage(sessionId, 'user_stream_2', {
    replaceMessageContent: 'edited second prompt',
  });

  // What the managed runtime writes for the resend turn under anchor reuse
  // (chat-stream-managed-runtime persistUserMessage): NO new user message —
  // the edited message is the anchor — plus a fresh turn event history.
  store.appendMessage(sessionId, {
    id: 'assistant_stream_3', role: 'assistant', content: 'fresh reply', timestamp: '2026-07-01T10:05:00.000Z',
  });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_3:user_prompt:0', turn_id: 'stream_3', kind: 'user_prompt',
      primary_message_id: 'user_stream_2', source_message_ids: ['user_stream_2'],
      payload: { content: 'edited second prompt' },
    },
    {
      event_id: 'stream_3:assistant_text_segment:0', turn_id: 'stream_3', kind: 'assistant_text_segment',
      primary_message_id: 'assistant_stream_3', source_message_ids: ['assistant_stream_3'],
      payload: { text: 'fresh reply', content: 'fresh reply' },
    },
  ]);

  const session = store.getSession(sessionId);
  const result = projectSession(session);
  const dump = treeDump(result);

  assert.ok(!dump.includes('"second prompt"'), 'the pre-edit prompt payload must not project');
  assert.ok(!dump.includes('second reply'), 'the deleted answer must not project');
  assert.ok(dump.includes('fresh reply'), 'the resend answer projects');
  const editedOccurrences = dump.split('edited second prompt').length - 1;
  assert.equal(editedOccurrences, 1, 'the edited prompt projects exactly once');
  assert.equal(
    result.byMessageId.user_stream_2,
    'stream_3',
    'the edited message is claimed by the resend turn — no unclaimed leftover for legacy fallback'
  );
});
