const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
  normalizeSession,
} = require('../services/backend/electron-session-store');
const { migrateStorePayload } = require('../services/backend/session-store-migrations');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('electron session store persists, reloads, and edit-replaces skill invocation metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skill-invocation-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const first = { id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled', command: 'humanize' };
  const second = { id: 'bundled/meeting_notes', name: 'Meeting Notes', scope: 'bundled', command: 'meeting-notes' };
  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const { id: sessionId } = store.createSession({ title: 'Skill metadata' });
  store.appendMessage(sessionId, { id: 'user_skill', role: 'user', content: 'Draft', skill_invocation: first });
  store.truncateAfterMessage(sessionId, 'user_skill', {
    replaceMessageContent: 'Edited', replaceMessageSkillInvocation: second,
  });
  store.flush();
  store.dispose();

  const reloaded = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  assert.deepEqual(reloaded.getSession(sessionId).messages[0].skill_invocation, second);
  reloaded.dispose();
});

test('electron session store drops malformed skill invocation metadata', () => {
  const normalized = normalizeSession('skill-malformed', {
    messages: [{ role: 'user', content: 'x', skill_invocation: { id: 'bundled/x' } }],
  });
  assert.equal(normalized.messages[0].skill_invocation, null);
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

// Per-session split layout helpers. With the v9->v10 layout change the store
// no longer keeps a single sessions.json file; instead the userDataPath
// contains sessions/_index.json plus one sessions/<id>.json file per session,
// and the original sessions.json (when seeded by a test) is renamed to
// sessions.json.migrated-<timestamp> after a successful migration.
function sessionsDir(userDataPath) {
  return path.join(userDataPath, 'sessions');
}

function indexFilePath(userDataPath) {
  return path.join(sessionsDir(userDataPath), '_index.json');
}

function sessionFilePath(userDataPath, sessionId) {
  return path.join(sessionsDir(userDataPath), `${sessionId}.json`);
}

function readIndexOnDisk(userDataPath) {
  return JSON.parse(fs.readFileSync(indexFilePath(userDataPath), 'utf8'));
}

function readSessionOnDisk(userDataPath, sessionId) {
  return JSON.parse(fs.readFileSync(sessionFilePath(userDataPath, sessionId), 'utf8'));
}

test('electron session store logs write failures without updating the cache', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-write-fail-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(storePath, { logger: logs.logger });
  const writeError = new Error('disk full');
  writeError.code = 'ENOSPC';

  // `store.store` is the backend's index FileJsonStore. Overriding its
  // `write` simulates a failure on the index update half of an upsert; the
  // per-session file write succeeds first, then the index write throws, and
  // the backend must roll back the in-memory cache so `listSessions()` does
  // not surface a session that isn't in the index.
  store.store.write = () => {
    throw writeError;
  };
  store.createSession({ title: 'Write Failure' });

  const entry = logs.entries.find((item) => item.event === 'session_store.write_failed');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.filePath, indexFilePath(userDataPath));
  assert.equal(entry.details.errorCode, 'ENOSPC');
  assert.equal(entry.details.errorMessage, 'disk full');
  assert.deepEqual(store.listSessions(), []);
});

test('electron session store forwards corrupted read diagnostics to the logger', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-corrupt-log-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, '{bad json', 'utf8');
  const logs = createLogCollector();

  new ElectronSessionStore(storePath, { logger: logs.logger });

  const entry = logs.entries.find((item) => item.event === 'store.corrupted');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.filePath, storePath);
  assert.equal(entry.details.errorCode, null);
  assert.match(entry.details.errorMessage, /JSON|position|Expected/i);
});

test('electron session store quarantines a corrupt session file and re-seeds a writable session', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-quarantine-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const seedStore = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const { id: sessionId } = seedStore.createSession({ title: 'Corruptible' });
  seedStore.appendMessage(sessionId, {
    id: 'msg_original',
    role: 'user',
    content: 'Original message.',
  });
  seedStore.flush();
  seedStore.dispose();

  const garbage = '{definitely not json';
  fs.writeFileSync(sessionFilePath(userDataPath, sessionId), garbage, 'utf8');

  const logs = createLogCollector();
  const store = new ElectronSessionStore(storePath, {
    logger: logs.logger,
    writeDebounceMs: 0,
  });

  const recovered = store.getSession(sessionId);
  assert.ok(recovered, 'corrupt session must recover as an empty session, not vanish');
  assert.equal(recovered.title, 'Corruptible');
  assert.deepEqual(recovered.messages, []);

  // The unreadable bytes are preserved for recovery, not overwritten.
  const quarantineDir = path.join(sessionsDir(userDataPath), 'corrupt');
  const quarantined = fs.readdirSync(quarantineDir);
  assert.equal(quarantined.length, 1);
  assert.equal(
    fs.readFileSync(path.join(quarantineDir, quarantined[0]), 'utf8'),
    garbage
  );

  const entry = logs.entries.find(
    (item) => item.event === 'session_store.session_file_quarantined'
  );
  assert.ok(entry);
  assert.equal(entry.level, 'ERROR');
  assert.equal(entry.details.sessionId, sessionId);
  assert.equal(entry.details.quarantinePath, path.join(quarantineDir, quarantined[0]));

  // Mutations persist again instead of silently dropping.
  const appended = store.appendMessage(sessionId, {
    id: 'msg_after_recovery',
    role: 'user',
    content: 'Still here.',
  });
  assert.ok(appended, 'appendMessage must not bail null after recovery');
  store.flush();
  store.dispose();

  const reloaded = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const persisted = reloaded.getSession(sessionId);
  assert.equal(persisted.messages.length, 1);
  assert.equal(persisted.messages[0].content, 'Still here.');
  reloaded.dispose();
});

test('electron session store leaves newer schema payloads untouched and logs the mismatch', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-newer-schema-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 99,
    future_field: { keep: true },
    sessions: {
      sess_future_schema: {
        id: 'sess_future_schema',
        title: 'Future',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        messages: [],
      },
    },
  }, null, 2));
  const logs = createLogCollector();

  const store = new ElectronSessionStore(storePath, { logger: logs.logger });
  const rawPayload = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const entry = logs.entries.find((item) => item.event === 'session_store.newer_schema_detected');

  assert.equal(rawPayload.schema_version, 99);
  assert.deepEqual(rawPayload.future_field, { keep: true });
  assert.equal(store.getSession('sess_future_schema').title, 'Future');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.filePath, storePath);
  assert.equal(entry.details.observedVersion, 99);
  assert.equal(entry.details.expectedVersion, STORE_SCHEMA_VERSION);

  const blockedCreate = store.createSession({ title: 'Blocked Downgrade' });
  // A future-schema monolithic file stays in place (no migration runs) so
  // the test can read the original storePath rather than the new layout.
  const afterWriteAttemptPayload = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const blockedEntry = logs.entries.find(
    (item) => item.event === 'session_store.newer_schema_write_blocked'
  );
  assert.deepEqual(afterWriteAttemptPayload, rawPayload);
  assert.ok(blockedEntry);
  assert.equal(blockedEntry.level, 'WARN');
  // A blocked write must report failure, not fabricate a summary for a
  // session that getSession() cannot find.
  assert.equal(blockedCreate, null);
  assert.equal(
    store.createSessionWithId('sess_blocked_explicit', { title: 'Blocked Too' }),
    null
  );
  assert.equal(store.getSession('sess_blocked_explicit'), null);
});

test('split session file names do not collide for malformed imported ids', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-id-collision-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));

  store.createSessionWithId('a/b', { title: 'Slash Id' });
  store.createSessionWithId('a_b', { title: 'Underscore Id' });
  store.flush();

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  assert.equal(reloaded.getSession('a/b').title, 'Slash Id');
  assert.equal(reloaded.getSession('a_b').title, 'Underscore Id');
});

test('electron session store normalizes branch origin lineage metadata', () => {
  const session = normalizeSession('sess_branch', {
    title: 'Branch',
    branch_origin: {
      source_session_id: ' sess_parent ',
      source_message_id: ' msg_parent ',
      source_title: ' Parent Chat ',
      created_at: '2026-05-12T12:00:00.000Z',
    },
    messages: [],
  });

  assert.deepEqual(session.branch_origin, {
    source_session_id: 'sess_parent',
    source_message_id: 'msg_parent',
    source_title: 'Parent Chat',
    created_at: '2026-05-12T12:00:00.000Z',
  });

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-branch-summary-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const summary = store._toSummary(session);
  assert.deepEqual(summary.branch_origin, session.branch_origin);

  assert.equal(normalizeSession('sess_bad', {
    branch_origin: {
      source_session_id: '',
      source_message_id: 'msg_parent',
      source_title: 'Parent',
      created_at: 'not-a-date',
    },
  }).branch_origin, null);

  assert.deepEqual(normalizeSession('sess_camel', {
    branchOrigin: {
      sourceSessionId: 'sess_parent',
      sourceMessageId: 'msg_parent',
      sourceTitle: 'Parent Chat',
      createdAt: '2026-05-12T07:00:00-05:00',
    },
  }).branch_origin, {
    source_session_id: 'sess_parent',
    source_message_id: 'msg_parent',
    source_title: 'Parent Chat',
    created_at: '2026-05-12T12:00:00.000Z',
  });
});

test('electron session summaries expose bounded compaction context without content or boundary ids', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-compaction-summary-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const session = normalizeSession('sess_compacted', {
    title: 'Compacted',
    messages: [
      { id: 'u1', role: 'user', content: 'secret prompt' },
      { id: 'a1', role: 'assistant', content: 'secret response' },
    ],
    compaction_snapshot: {
      version: 1,
      created_at: '2026-08-14T12:00:00.000Z',
      strategy: 'full',
      tokens_before: 4200,
      tokens_after: 900,
      boundary_message_id: 'a1',
      boundary_message_count: 2,
      messages: [{ role: 'system', content: 'private compacted summary' }],
    },
  });

  const summary = store._toSummary(session);
  assert.deepEqual(summary.compaction_context, {
    version: 2,
    origin: 'manual',
    created_at: '2026-08-14T12:00:00.000Z',
    strategy: 'full',
    tokens_before: 4200,
    tokens_after: 900,
    // Derived from the replacement messages by normalizeCompactionSnapshot (P2 Wave 1).
    replacement_tokens: 11,
    boundary_message_count: 2,
  });
  assert.equal(Object.hasOwn(summary.compaction_context, 'boundary_message_id'), false);
  assert.equal(Object.hasOwn(summary.compaction_context, 'messages'), false);
  assert.equal(JSON.stringify(summary).includes('private compacted summary'), false);
});

test('electron session store normalizes and persists message reactions', () => {
  const session = normalizeSession('sess_reactions', {
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

  assert.deepEqual(session.messages[0].message_reactions, {
    thumbs_up: {
      selected: true,
      updated_at: '2026-05-12T17:00:00.000Z',
    },
    note: {
      selected: true,
      updated_at: '',
    },
  });

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-message-reactions-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const created = store.createSession({ title: 'Reactions' });

  store.appendMessage(created.id, {
    id: 'msg_react',
    role: 'assistant',
    content: 'React to this',
  });
  const updated = store.updateMessage(created.id, 'msg_react', {
    message_reactions: {
      saved: { selected: true, updated_at: '2026-05-12T18:00:00.000Z' },
      thumbs_up: { selected: false, updated_at: '2026-05-12T18:01:00.000Z' },
    },
  });

  assert.ok(updated);
  assert.deepEqual(store.getSessionMessages(created.id)[0].message_reactions, {
    saved: {
      selected: true,
      updated_at: '2026-05-12T18:00:00.000Z',
    },
  });

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  assert.deepEqual(reloaded.getSessionMessages(created.id)[0].message_reactions, {
    saved: {
      selected: true,
      updated_at: '2026-05-12T18:00:00.000Z',
    },
  });
});

test('electron session store v12 reaction repair does not resurrect malformed messages', () => {
  const migrated = migrateStorePayload({
    schema_version: 11,
    sessions: {
      sess_malformed_reactions: {
        id: 'sess_malformed_reactions',
        messages: [
          null,
          {
            id: 'msg_valid',
            role: 'assistant',
            content: 'Still here',
            messageReactions: {
              saved: { selected: true, updated_at: '2026-05-12T18:00:00.000Z' },
            },
          },
        ],
      },
    },
  });

  const normalized = normalizeSession(
    'sess_malformed_reactions',
    migrated.sessions.sess_malformed_reactions
  );
  assert.equal(normalized.messages.length, 1);
  assert.equal(normalized.messages[0].id, 'msg_valid');
  assert.deepEqual(normalized.messages[0].message_reactions, {
    saved: {
      selected: true,
      updated_at: '2026-05-12T18:00:00.000Z',
    },
  });
});

test('electron session store logs dropped duplicate turn events', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-dedupe-log-'));
  trackDirectory(userDataPath);
  const logs = createLogCollector();
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    logger: logs.logger,
  });
  const { id: sessionId } = store.createSession({ title: 'Dedupe Log' });
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

  store.appendTurnEvents(sessionId, [firstEvent]);
  store.appendTurnEvents(sessionId, [duplicateEvent]);

  const entry = logs.entries.find((item) => item.event === 'turn_event.dedupe_dropped');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.store, 'electron_session_store');
  assert.equal(entry.details.sessionId, sessionId);
  assert.equal(entry.details.eventId, 'turn_dedupe:user_prompt:0');
  assert.equal(entry.details.turnId, 'turn_dedupe');
  assert.equal(entry.details.kind, 'user_prompt');
  assert.equal(entry.details.retainedEventSeq, 0);
  assert.equal(entry.details.payloadChanged, true);
});

test('electron session store coerces invalid message roles and drops unsafe external payload paths', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-normalize-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const created = store.createSession({ title: 'Normalize' });

  store.appendMessage(created.id, {
    id: 'msg_bad_role',
    role: 'Admin',
    content: 'hello',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'read_file',
      external_payloads: {
        traversal: {
          path: '..\\..\\secrets.json',
          bytes: 10,
          encoding: 'utf-8',
          format: 'json',
        },
        bounded: {
          path: '.jenny/tool-results/call_1/output.json',
          root_kind: 'tool_result',
          bytes: 10,
          encoding: 'utf-8',
          format: 'json',
        },
      },
    },
  });

  const [message] = store.getSessionMessages(created.id);
  assert.equal(message.role, 'assistant');
  assert.equal(message.tool_result.external_payloads.traversal, undefined);
  assert.deepEqual(message.tool_result.external_payloads.bounded, {
    path: '.jenny/tool-results/call_1/output.json',
    root_kind: 'tool_result',
    bytes: 10,
    encoding: 'utf-8',
    format: 'json',
  });
});

test('electron session store round-trips validated subagent report metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-subagent-report-roundtrip-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath);
  const created = store.createSession({ title: 'Subagent report' });
  store.appendMessage(created.id, {
    id: 'tool_result_subagent', role: 'tool', content: '',
    tool_result: {
      call_id: 'call-1', tool_name: 'subagent_run', output_text: '{}',
      metadata: { subagent_report: {
        task_id: 'child-1', label: 'Inspect persistence', status: 'completed', summary: 'Done.',
        evidence: [], tools_used: [], uncertainties: [], budget: { elapsed_ms: 900 },
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        raw_usage: { prompt: 'drop this' },
      } },
    },
  });

  const reloaded = new ElectronSessionStore(storePath);
  const report = reloaded.getSessionMessages(created.id)[0].tool_result.metadata.subagent_report;
  assert.equal(report.label, 'Inspect persistence');
  assert.equal(report.usage.total_tokens, 25);
  assert.equal(Object.hasOwn(report, 'raw_usage'), false);
});

// CTL-010: compaction drops oldest WHOLE turns (never a raw event tail — a
// bisected turn orphans its messages onto the legacy-markup canary path).
// The whole-turn boundary mechanics are pinned in
// tests/electron-session-store-compaction.test.js; this case pins the store
// seam: retention shape, marker metadata, and the structured warning.
test('electron session store round-trips delegate batch metadata and provenance', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-delegate-report-roundtrip-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath);
  const created = store.createSession({ title: 'Delegate report' });
  store.appendMessage(created.id, {
    id: 'tool_result_delegate', role: 'tool', content: '',
    tool_result: {
      call_id: 'call-delegate', tool_name: 'delegate', output_text: '{}',
      metadata: { subagent_batch_report: {
        batch_id: 'delegate:req:call', source_tool: 'delegate', execution: 'parallel',
        status: 'completed', tasks: [{
          task_id: 'delegate:req:call:1', ordinal: 1, label: 'Task 1', status: 'completed',
          summary: 'The test command is npm test.', tools_used: ['read_file'], uncertainties: [],
          evidence_trust: 'tool_observed', budget: { elapsed_ms: 900 },
          evidence: [{
            source_tool: 'read_file', relative_path: 'package.json', line_start: 8,
            line_end: 8, quote: '"test": "npm test"', provenance: 'tool_observed',
          }],
        }],
      } },
    },
  });

  const reloaded = new ElectronSessionStore(storePath);
  const batch = reloaded.getSessionMessages(created.id)[0]
    .tool_result.metadata.subagent_batch_report;
  assert.equal(batch.source_tool, 'delegate');
  assert.equal(batch.execution, 'parallel');
  assert.equal(batch.tasks[0].evidence[0].provenance, 'tool_observed');
  assert.equal(batch.tasks[0].evidence[0].line_start, 8);
});

test('electron session store compacts oversized turn event logs and emits a structured warning', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-compact-'));
  trackDirectory(userDataPath);
  const logs = createLogCollector();
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    logger: logs.logger,
    maxTurnEventsPerSession: 4,
    turnEventCompactionKeep: 3,
  });
  const created = store.createSession({ title: 'Compact' });

  const seedEvent = (turnId, index) => ({
    event_id: `${turnId}:chat_token:${index}`,
    turn_id: turnId,
    kind: 'chat_token',
    primary_message_id: `assistant_${turnId}`,
    payload: { text: `chunk ${index}` },
  });
  store.appendTurnEvents(created.id, [
    seedEvent('turn_old', 0),
    seedEvent('turn_old', 1),
    seedEvent('turn_old', 2),
    seedEvent('turn_new', 3),
    seedEvent('turn_new', 4),
  ]);

  const events = store.getSessionTurnEvents(created.id);
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'turn_events_compacted');
  assert.equal(events[0].payload.compacted_count, 3);
  assert.equal(events[0].payload.compacted_turn_count, 1);
  // The marker must not reuse a real turn id (it would mark the dropped turn
  // event-covered and orphan its messages onto the canary path).
  assert.equal(['turn_old', 'turn_new'].includes(events[0].turn_id), false);
  // The newest turn survives WHOLE; the older turn leaves no events behind.
  assert.deepEqual(events.slice(1).map((event) => event.event_id), [
    'turn_new:chat_token:3',
    'turn_new:chat_token:4',
  ]);
  const entry = logs.entries.find((item) => item.event === 'session_store.turn_events_compacted');
  assert.ok(entry);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.details.sessionId, created.id);
  assert.equal(entry.details.compactedCount, 3);
  assert.equal(entry.details.compactedTurnCount, 1);
});

test('touchActiveTurn updates the in-memory cache without writing to disk (Fix A)', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-touch-cache-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  // writeDebounceMs:0 keeps the underlying FileJsonStore in immediate-write
  // mode so the only "missing on disk" effect under test is Fix A's
  // cache-only contract for touchActiveTurn; Fix B is exercised separately.
  const store = new ElectronSessionStore(storePath);
  const created = store.createSession({ title: 'Touch Cache Session' });
  store.setActiveTurn(created.id, {
    request_id: 'req_touch',
    stream_id: 'stream_touch',
    trace_id: 'trace_touch',
    user_message_id: 'user_touch',
    started_at: '2026-05-11T21:00:00.000Z',
    last_event_at: '2026-05-11T21:00:00.000Z',
    status: 'awaiting_assistant',
  });

  // setActiveTurn is a persisting write, so the active_turn lands on disk
  // in the per-session file. The index doesn't track active_turn (summary
  // only), so the assertion targets the session file directly.
  const onDiskAfterSet = readSessionOnDisk(userDataPath, created.id);
  const setStatusOnDisk = onDiskAfterSet?.session?.active_turn?.status;
  assert.equal(setStatusOnDisk, 'awaiting_assistant');

  store.touchActiveTurn(created.id, {
    request_id: 'req_touch',
    stream_id: 'stream_touch',
  }, {
    status: 'streaming',
    last_event_at: '2026-05-11T21:00:30.000Z',
    agent_stage: 'planning',
    agent_summary: 'Touched in memory only.',
    agent_percent: 42,
  });

  // In-memory state has the touched fields immediately.
  const inMemory = store.getActiveTurn(created.id);
  assert.equal(inMemory.status, 'streaming');
  assert.equal(inMemory.agent_stage, 'planning');
  assert.equal(inMemory.agent_percent, 42);

  // On-disk state has NOT been rewritten; the touch is cache-only. The
  // active_turn snapshot still reflects the values written by setActiveTurn.
  const onDiskAfterTouch = readSessionOnDisk(userDataPath, created.id);
  const touchedOnDisk = onDiskAfterTouch?.session?.active_turn;
  assert.equal(touchedOnDisk.status, 'awaiting_assistant');
  assert.equal(touchedOnDisk.last_event_at, '2026-05-11T21:00:00.000Z');
  assert.notEqual(touchedOnDisk.agent_stage, 'planning');
  assert.notEqual(touchedOnDisk.agent_percent, 42);

  // flush() forcibly persists the latest cache snapshot via writeImmediate.
  const flushed = store.flush();
  assert.equal(flushed, true);
  const onDiskAfterFlush = readSessionOnDisk(userDataPath, created.id);
  const flushedOnDisk = onDiskAfterFlush?.session?.active_turn;
  assert.equal(flushedOnDisk.status, 'streaming');
  assert.equal(flushedOnDisk.agent_stage, 'planning');
  assert.equal(flushedOnDisk.agent_percent, 42);
});

test('a persisting write after touchActiveTurn flushes the touch state to disk', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-touch-flush-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const store = new ElectronSessionStore(storePath);
  const created = store.createSession({ title: 'Touch Flush Session' });
  store.setActiveTurn(created.id, {
    request_id: 'req_flush',
    stream_id: 'stream_flush',
    trace_id: 'trace_flush',
    user_message_id: 'user_flush',
    started_at: '2026-05-11T21:00:00.000Z',
    last_event_at: '2026-05-11T21:00:00.000Z',
    status: 'awaiting_assistant',
  });
  store.touchActiveTurn(created.id, {
    request_id: 'req_flush',
    stream_id: 'stream_flush',
  }, {
    status: 'streaming',
    last_event_at: '2026-05-11T21:00:30.000Z',
    agent_stage: 'planning',
  });

  // The next persisting write (here: appendMessage) carries the latest cache
  // snapshot to disk, including the prior cache-only touch updates. Crash
  // recovery between setActiveTurn and the next persist still loses touch
  // progress but recovers the active_turn bracket by design.
  store.appendMessage(created.id, {
    id: 'user_flush',
    role: 'user',
    content: 'hi',
    timestamp: '2026-05-11T21:00:31.000Z',
  });

  const onDisk = readSessionOnDisk(userDataPath, created.id);
  const onDiskActiveTurn = onDisk?.session?.active_turn;
  assert.equal(onDiskActiveTurn.status, 'streaming');
  assert.equal(onDiskActiveTurn.agent_stage, 'planning');
});

test('writeDebounceMs coalesces burst writes into one flushed disk write', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-debounce-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 50 });
  const created = store.createSession({ title: 'Debounce Session' });
  // createSession scheduled a debounced write; flush so the per-session file
  // exists. In the split layout the title lives in the session record and
  // also in the index summary, so each updateSession touches both files.
  store.flush();

  const sessionPath = sessionFilePath(userDataPath, created.id);
  const baselineMtime = fs.statSync(sessionPath).mtimeMs;

  // Burst of mutations within the debounce window collapse into one
  // pending write per debounced FileJsonStore.
  for (let index = 0; index < 5; index += 1) {
    store.updateSession(created.id, {
      title: `Burst Title ${index}`,
    });
  }

  // Disk has not been rewritten yet; pending writes are still in the debounce
  // queues for both the session file and the index.
  assert.equal(fs.statSync(sessionPath).mtimeMs, baselineMtime);

  store.flush();
  const afterFlush = readSessionOnDisk(userDataPath, created.id);
  const indexAfterFlush = readIndexOnDisk(userDataPath);
  assert.equal(afterFlush?.session?.title, 'Burst Title 4');
  assert.equal(indexAfterFlush?.sessions?.[created.id]?.title, 'Burst Title 4');
});
