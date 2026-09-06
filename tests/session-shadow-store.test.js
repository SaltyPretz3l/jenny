const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
  };
}

// Per-session split layout helpers: paralleling the canonical store, the
// shadow store now writes shadow-sessions/_index.json + per-session files.
// `shadowSessionsDir` is the directory derived from the monolithic file path
// (e.g. shadow-sessions.json -> shadow-sessions/).
function shadowSessionsDir(storePath) {
  return path.join(
    path.dirname(storePath),
    path.basename(storePath, path.extname(storePath))
  );
}

function shadowIndexFilePath(storePath) {
  return path.join(shadowSessionsDir(storePath), '_index.json');
}

function shadowSessionFilePath(storePath, sessionId) {
  return path.join(shadowSessionsDir(storePath), `${sessionId}.json`);
}

test('session shadow store logs write failures without updating the cache', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-store-write-fail-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  const logs = createLogCollector();
  const store = new SessionShadowStore(storePath, { logger: logs.logger });
  const writeError = new Error('disk full');
  writeError.code = 'ENOSPC';

  // `store.store` is the backend's index FileJsonStore in the split layout;
  // overriding its `write` makes the index half of an upsert fail. The
  // per-session file write succeeds first, then the index write throws, and
  // the backend rolls back the in-memory cache so the would-be session never
  // becomes visible through `getSession()`.
  store.store.write = () => {
    throw writeError;
  };
  store.upsertSession('sess_write_failed', { title: 'Write Failure' });

  const entry = logs.entries.find((item) => item.event === 'session_shadow_store.write_failed');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.filePath, shadowIndexFilePath(storePath));
  assert.equal(entry.details.errorCode, 'ENOSPC');
  assert.equal(entry.details.errorMessage, 'disk full');
  assert.equal(store.getSession('sess_write_failed'), null);
});

test('session shadow store forwards corrupted read diagnostics to the logger', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-store-corrupt-log-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  fs.writeFileSync(storePath, '{bad json', 'utf8');
  const logs = createLogCollector();

  new SessionShadowStore(storePath, { logger: logs.logger });

  const entry = logs.entries.find((item) => item.event === 'store.corrupted');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.filePath, storePath);
  assert.equal(entry.details.errorCode, null);
  assert.match(entry.details.errorMessage, /JSON|position|Expected/i);
});

test('session shadow store leaves newer schema payloads untouched and logs the mismatch', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-store-newer-schema-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 99,
    future_field: { keep: true },
    sessions: {
      sess_future_schema: {
        title: 'Future',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        message_count: 0,
        messages: [],
      },
    },
  }, null, 2));
  const logs = createLogCollector();

  const store = new SessionShadowStore(storePath, { logger: logs.logger });
  const rawPayload = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const entry = logs.entries.find((item) => item.event === 'session_shadow_store.newer_schema_detected');

  assert.equal(rawPayload.schema_version, 99);
  assert.deepEqual(rawPayload.future_field, { keep: true });
  assert.equal(store.getSession('sess_future_schema').title, 'Future');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.filePath, storePath);
  assert.equal(entry.details.observedVersion, 99);
  assert.equal(entry.details.expectedVersion, 8);

  store.upsertSession('sess_blocked', { title: 'Blocked Downgrade' });
  // A future-schema monolithic file stays in place (no migration runs) so
  // the original storePath is still readable.
  const afterWriteAttemptPayload = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const blockedEntry = logs.entries.find(
    (item) => item.event === 'session_shadow_store.newer_schema_write_blocked'
  );
  assert.deepEqual(afterWriteAttemptPayload, rawPayload);
  assert.ok(blockedEntry);
  assert.equal(blockedEntry.level, 'WARN');
});

test('session shadow store includes normalized branch origin in summaries', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-branch-origin-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_branch', {
    title: 'Branch',
    branch_origin: {
      source_session_id: ' sess_parent ',
      source_message_id: ' msg_parent ',
      source_title: ' Parent Chat ',
      created_at: '2026-05-12T12:00:00.000Z',
    },
  });

  const session = store.getSession('sess_branch');
  assert.deepEqual(session.branch_origin, {
    source_session_id: 'sess_parent',
    source_message_id: 'msg_parent',
    source_title: 'Parent Chat',
    created_at: '2026-05-12T12:00:00.000Z',
  });
  assert.deepEqual(store.summarize().sess_branch.branch_origin, session.branch_origin);
});

test('session shadow store normalizes and persists message reactions', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-reactions-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  const store = new SessionShadowStore(storePath);

  store.upsertSession('sess_reactions', {
    messages: [
      {
        id: 'msg_react',
        role: 'assistant',
        content: 'React to this',
        messageReactions: {
          thumbs_up: { selected: true, updatedAt: '2026-05-12T12:00:00-05:00' },
          saved: { selected: false, updated_at: '2026-05-12T12:01:00.000Z' },
          unknown: { selected: true, updated_at: '2026-05-12T12:02:00.000Z' },
          note: { selected: true, updated_at: 'not-a-date' },
        },
      },
    ],
  });

  assert.deepEqual(store.getMessages('sess_reactions')[0].message_reactions, {
    thumbs_up: {
      selected: true,
      updated_at: '2026-05-12T17:00:00.000Z',
    },
    note: {
      selected: true,
      updated_at: '',
    },
  });

  const updated = store.updateMessage('sess_reactions', 'msg_react', {
    message_reactions: {
      saved: { selected: true, updated_at: '2026-05-12T18:00:00.000Z' },
      thumbs_up: { selected: false, updated_at: '2026-05-12T18:01:00.000Z' },
    },
  });

  assert.deepEqual(updated.messages[0].message_reactions, {
    saved: {
      selected: true,
      updated_at: '2026-05-12T18:00:00.000Z',
    },
  });

  const reloaded = new SessionShadowStore(storePath);
  assert.deepEqual(reloaded.getMessages('sess_reactions')[0].message_reactions, {
    saved: {
      selected: true,
      updated_at: '2026-05-12T18:00:00.000Z',
    },
  });
});

test('session shadow store logs dropped duplicate turn events', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-store-dedupe-log-'));
  trackDirectory(userDataPath);
  const logs = createLogCollector();
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'), {
    logger: logs.logger,
  });
  const firstEvent = {
    event_id: 'turn_dedupe:user_prompt:0',
    turn_id: 'turn_dedupe',
    kind: 'user_prompt',
    primary_message_id: 'user_dedupe',
    source_message_ids: ['user_dedupe'],
    payload: { content: 'first' },
  };
  const duplicateEvent = {
    ...firstEvent,
    payload: { content: 'second' },
  };

  store.upsertSession('sess_dedupe', { title: 'Dedupe test' });
  store.appendTurnEvents('sess_dedupe', [firstEvent]);
  store.appendTurnEvents('sess_dedupe', [duplicateEvent]);

  const entry = logs.entries.find((item) => item.event === 'turn_event.dedupe_dropped');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.store, 'session_shadow_store');
  assert.equal(entry.details.sessionId, 'sess_dedupe');
  assert.equal(entry.details.eventId, 'turn_dedupe:user_prompt:0');
  assert.equal(entry.details.turnId, 'turn_dedupe');
  assert.equal(entry.details.kind, 'user_prompt');
  assert.equal(entry.details.retainedEventSeq, 0);
  assert.equal(entry.details.payloadChanged, true);
});

test('session shadow store appendTurnEvents does not mutate sessions with a future turn_event_log_version', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-store-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  const store = new SessionShadowStore(storePath);

  store.upsertSession('sess_future', {
    turn_event_log_version: 99,
    turn_event_seq_counter: 3,
    turn_events: [{
      event_id: 'turn_future:user_prompt:0',
      event_seq: 2,
      turn_id: 'turn_future',
      kind: 'user_prompt',
      primary_message_id: 'user_future',
      source_message_ids: ['user_future'],
      payload: { content: 'hello', attachments: [] },
    }],
  });

  store.appendTurnEvents('sess_future', [{
    event_id: 'turn_future:assistant_text_segment:0',
    turn_id: 'turn_future',
    kind: 'assistant_text_segment',
    primary_message_id: 'assistant_future',
    source_message_ids: ['assistant_future'],
    payload: { text: 'should not append' },
  }]);

  const session = store.getSession('sess_future');
  assert.equal(session.turn_event_log_version, 99);
  assert.equal(session.turn_event_seq_counter, 3);
  assert.equal(session.turn_events.length, 1);
  assert.equal(session.turn_events[0].event_id, 'turn_future:user_prompt:0');
});

test('session shadow store truncateAfterMessage refreshes preview and clears active turn', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-truncate-refresh-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_truncate', {
    messages: [
      { id: 'user_0', role: 'user', content: 'Earlier prompt' },
      { id: 'assistant_0', role: 'assistant', content: 'Earlier reply' },
      { id: 'user_1', role: 'user', content: 'Keep this prompt' },
      { id: 'assistant_1', role: 'assistant', content: 'Drop this reply' },
    ],
    message_count: 4,
    last_message_preview: 'Drop this reply',
    active_turn: {
      request_id: 'req_truncate',
      stream_id: 'stream_truncate',
      status: 'streaming',
    },
    turn_events: [
      {
        event_id: 'turn_prior:user_prompt:0',
        turn_id: 'turn_prior',
        kind: 'user_prompt',
        primary_message_id: 'user_0',
      },
      {
        event_id: 'turn_target:user_prompt:0',
        turn_id: 'turn_target',
        kind: 'user_prompt',
        primary_message_id: 'user_1',
      },
      {
        event_id: 'turn_drop:assistant_text_segment:0',
        turn_id: 'turn_drop',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_1',
      },
    ],
  });

  const updated = store.truncateAfterMessage('sess_truncate', 'user_1');

  assert.ok(updated);
  assert.equal(updated.messages.length, 3);
  assert.equal(updated.last_message_preview, 'Keep this prompt');
  assert.equal(updated.active_turn, null);
  // CTL-001: the edited target's own turn is part of the discarded boundary;
  // only turns strictly before the edit boundary survive.
  assert.deepEqual(updated.turn_events.map((event) => event.event_id), ['turn_prior:user_prompt:0']);
});

test('session shadow store migrates legacy payloads to the current schema without losing transcript fields', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-store-migrate-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 1,
    sessions: {
      sess_legacy: {
        title: 'Legacy',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        active_turn: {
          requestId: 'req_legacy',
          streamId: 'stream_legacy',
          userMessageId: 'user_legacy',
          status: 'streaming',
        },
        messages: [{
          id: 'assistant_legacy',
          role: 'Assistant',
          content: '',
          phases: [{
            phaseId: 'phase_1',
            phaseKind: 'reasoning',
            entries: [{ text: 'thinking' }],
          }],
          visible_segments: [{ segmentId: 'segment_1', text: 'Visible' }],
          tool_steps: [{ callId: 'call_1', toolName: 'read_file' }],
        }],
        turn_events: [{
          eventId: 'turn_legacy:chat_token:0',
          turnId: 'turn_legacy',
          kind: 'chat_token',
          payload: { text: 'Visible' },
        }],
      },
    },
  }, null, 2));

  const store = new SessionShadowStore(storePath);
  const session = store.getSession('sess_legacy');
  // The legacy monolithic file split into shadow-sessions/_index.json plus a
  // per-session record; the index carries the current v8 schema marker.
  const indexPayload = JSON.parse(fs.readFileSync(shadowIndexFilePath(storePath), 'utf8'));

  assert.equal(indexPayload.schema_version, 8);
  assert.equal(session.active_turn.request_id, 'req_legacy');
  assert.equal(session.active_turn.stream_id, 'stream_legacy');
  assert.equal(session.messages[0].role, 'assistant');
  assert.equal(session.messages[0].content, 'Visible');
  assert.equal(session.messages[0].phases[0].phase_id, 'phase_1');
  assert.equal(session.messages[0].tool_steps[0].call_id, 'call_1');
  assert.equal(session.turn_events[0].event_id, 'turn_legacy:chat_token:0');
  assert.equal(session.turn_event_seq_counter, 1);
});
