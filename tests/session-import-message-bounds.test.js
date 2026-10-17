'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  SESSION_IMPORT_ERROR_CODES,
  exportSession,
  importSession,
} = require('../services/backend/session-export-import');

const FIXTURES_ROOT = path.join(__dirname, 'release-compat', 'fixtures');
const V24_SESSIONS_DIR = path.join(FIXTURES_ROOT, 'userdata-v24-current', 'sessions');

// Loaded per test so a missing module fails only the tests that use it.
function loadBounds() {
  return require('../services/backend/session-import-message-bounds');
}

function createMockSessionStore(sessions = {}) {
  const store = {
    _sessions: { ...sessions },
    getSession(sessionId) {
      return store._sessions[sessionId] || null;
    },
    _read() {
      return { schema_version: 3, sessions: { ...store._sessions } };
    },
    _write(payload) {
      store._sessions = { ...(payload.sessions || {}) };
    },
    _toSummary(session) {
      return { id: session.id, title: session.title, message_count: (session.messages || []).length };
    },
  };
  return store;
}

function payloadWithMessages(messages) {
  return JSON.stringify({
    format: 'jenny-session-export',
    format_version: 1,
    session: { title: 'Bounds import', messages },
  });
}

function assertFormatMismatchNaming(fn, { fieldPath, limit }) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'SessionImportError');
    assert.equal(error.code, SESSION_IMPORT_ERROR_CODES.FORMAT_MISMATCH);
    assert.equal(error.reason, 'format_mismatch');
    assert.ok(error.message.includes(fieldPath), `message names ${fieldPath}: ${error.message}`);
    assert.ok(error.message.includes(String(limit)), `message names ${limit}: ${error.message}`);
    return true;
  });
}

function toolResultMessage(note) {
  return {
    id: 'msg_tool', role: 'tool', kind: 'tool_result', content: 'done',
    tool_result: { call_id: 'call_1', tool_name: 'read_file', output_text: 'ok', metadata: { note } },
  };
}

function readFixtureSessions(directory) {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).session)
    .filter((session) => session && Array.isArray(session.messages));
}

function collectFixtureMessages(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFixtureMessages(fullPath, out);
    } else if (entry.name.endsWith('.json')) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch { continue; }
      const holders = [parsed, parsed?.session, ...Object.values(parsed?.sessions || {})];
      for (const holder of holders) {
        for (const message of Array.isArray(holder?.messages) ? holder.messages : []) {
          out.push({ file: fullPath, message });
        }
      }
    } else if (entry.name.endsWith('.journal')) {
      for (const line of fs.readFileSync(fullPath, 'utf8').split('\n')) {
        const start = line.indexOf('{');
        if (start < 0) continue;
        let record;
        try { record = JSON.parse(line.slice(start)); } catch { continue; }
        for (const op of Array.isArray(record.ops) ? record.ops : []) {
          if (op?.o === 'm' && op.v && typeof op.v === 'object') out.push({ file: fullPath, message: op.v });
        }
      }
    }
  }
  return out;
}

function roundTrip(session) {
  const source = createMockSessionStore({ [session.id]: session });
  const exported = exportSession(source, session.id);
  const target = createMockSessionStore();
  const summary = importSession(target, exported, null, {
    trustedArchive: true,
    restoredSessionId: 'sess_round_trip',
  });
  return target._sessions[summary.id];
}

describe('session import message bounds', () => {
  it('imports a message carrying a huge unknown field and persists it without that field', () => {
    const store = createMockSessionStore();
    const summary = importSession(store, payloadWithMessages([
      { id: 'msg_1', role: 'user', content: 'hello', foo: 'A'.repeat(14_000_000) },
    ]));
    const persisted = store._sessions[summary.id].messages;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].content, 'hello');
    assert.equal(Object.prototype.hasOwnProperty.call(persisted[0], 'foo'), false);
  });

  it('strips unknown keys into a shallow copy and lists them sorted', () => {
    const { stripUnknownImportedMessageKeys } = loadBounds();
    const source = { id: 'm', role: 'user', content: 'x', zeta: 1, alpha: { nested: true } };
    const { message, strippedKeys } = stripUnknownImportedMessageKeys(source);
    assert.deepEqual(message, { id: 'm', role: 'user', content: 'x' });
    assert.deepEqual(strippedKeys, ['alpha', 'zeta']);
    assert.equal(source.zeta, 1, 'input is not mutated');
  });

  it('rejects content over the text limit and names the path', () => {
    const { MAX_IMPORTED_MESSAGE_TEXT_CHARS } = loadBounds();
    assert.equal(MAX_IMPORTED_MESSAGE_TEXT_CHARS, 2_000_000);
    const store = createMockSessionStore();
    assertFormatMismatchNaming(
      () => importSession(store, payloadWithMessages([
        { id: 'msg_1', role: 'assistant', content: 'B'.repeat(2_000_001) },
      ])),
      { fieldPath: 'content', limit: 2_000_000 }
    );
    assert.deepEqual(Object.keys(store._sessions), []);
  });

  it('applies the same bounds to a trusted archive restore', () => {
    const store = createMockSessionStore();
    assertFormatMismatchNaming(
      () => importSession(store, payloadWithMessages([
        { id: 'msg_1', role: 'assistant', content: 'C'.repeat(2_000_001) },
      ]), null, { trustedArchive: true, restoredSessionId: 'sess_restored' }),
      { fieldPath: 'content', limit: 2_000_000 }
    );
    assert.equal(store.getSession('sess_restored'), null);
  });

  it('rejects a 70,000-char nested metadata string and admits a 60,000-char one', () => {
    const { MAX_IMPORTED_MESSAGE_FIELD_CHARS } = loadBounds();
    assert.equal(MAX_IMPORTED_MESSAGE_FIELD_CHARS, 65_536);
    assertFormatMismatchNaming(
      () => importSession(createMockSessionStore(), payloadWithMessages([toolResultMessage('n'.repeat(70_000))])),
      { fieldPath: 'tool_result.metadata.note', limit: 65_536 }
    );
    const store = createMockSessionStore();
    const summary = importSession(store, payloadWithMessages([toolResultMessage('n'.repeat(60_000))]));
    const [persisted] = store._sessions[summary.id].messages;
    assert.equal(persisted.tool_result.metadata.note.length, 60_000);
  });

  it('exempts exported attachment data from the string walk but bounds other attachment fields', () => {
    const { findOversizedImportedMessageString } = loadBounds();
    const message = {
      id: 'msg_1', role: 'user', content: 'see image',
      attachments: [{ kind: 'image', displayName: 'a.png', _exportedData: 'A'.repeat(1_000_000), _exportedMime: 'image/png' }],
    };
    assert.equal(findOversizedImportedMessageString(message), null);
    message.attachments[0].displayName = 'd'.repeat(70_000);
    assert.deepEqual(findOversizedImportedMessageString(message), {
      path: 'attachments[0].displayName', length: 70_000, limit: 65_536,
    });
  });

  it('reports the first violation depth-first with a bracketed path', () => {
    const { findOversizedImportedMessageString } = loadBounds();
    const result = findOversizedImportedMessageString({
      id: 'msg_1', role: 'assistant', content: 'ok',
      phases: [{ phase_id: 'p1', phase_kind: 'reasoning', thinking_id: 't'.repeat(70_000) }],
      tool_call: { call_id: 'c', tool_name: 'x', summary: 's'.repeat(80_000) },
    });
    assert.deepEqual(result, { path: 'phases[0].thinking_id', length: 70_000, limit: 65_536 });
  });

  it('admits a long assistant answer whose transcript segments mirror the content', () => {
    const longText = 'L'.repeat(100_000);
    const store = createMockSessionStore();
    const summary = importSession(store, payloadWithMessages([{
      id: 'msg_1', role: 'assistant', content: longText,
      visible_segments: [{ segment_id: 'seg_1', phase_id: 'p1', text: longText }],
      phases: [{ phase_id: 'p1', phase_kind: 'reasoning', entries: [{ id: 'r1', text: longText }] }],
      reasoning: { source: 'provider', entries: [{ id: 'r1', text: longText }] },
    }]));
    const [persisted] = store._sessions[summary.id].messages;
    assert.equal(persisted.content.length, 100_000);
    assert.equal(persisted.visible_segments[0].text.length, 100_000);
  });

  it('round-trips every v24 fixture message through export and import without dropping a key', () => {
    const sessions = readFixtureSessions(V24_SESSIONS_DIR);
    assert.ok(sessions.length > 0);
    for (const session of sessions) {
      const restored = roundTrip(session);
      assert.equal(restored.messages.length, session.messages.length);
      session.messages.forEach((message, index) => {
        const restoredKeys = new Set(Object.keys(restored.messages[index]));
        const missing = Object.keys(message).filter((key) => !restoredKeys.has(key));
        assert.deepEqual(missing, [], `${session.id}/${message.id} lost keys`);
      });
    }
  });

  it('round-trips a full-featured message carrying every key live writers persist', () => {
    const [fixtureSession] = readFixtureSessions(V24_SESSIONS_DIR);
    const base = fixtureSession.messages.find((message) => message.role === 'assistant');
    const fullFeatured = {
      ...base,
      turn_id: 'turn_1',
      terminal_status: 'runtime_error',
      stream_error: 'Chat stream failed.',
      error_code: 'CMP-CHAT-0001',
      retryable: true,
      category: 'interrupted',
      recovery_class: 'runtime',
      next_action: 'retry_turn',
      next_action_label: 'Retry',
      recovery_title: 'Turn failed',
      recovery_hint: 'Retry the turn.',
      recovery_actions: [{ id: 'retry_turn', label: 'Retry' }],
      resumable_stop: { reason: 'length' },
      reasoning_phases: [{ phaseId: 'p1', phaseKind: 'reasoning' }],
      plan_document: { plan_id: 'plan_1', state: 'proposed', title: 'Plan' },
      context_compactions: [],
      discarded_drafts: { count: 1, latest_reason: 'retry' },
    };
    const restored = roundTrip({ ...fixtureSession, messages: [fullFeatured] });
    const restoredKeys = new Set(Object.keys(restored.messages[0]));
    const missing = Object.keys(fullFeatured).filter((key) => !restoredKeys.has(key));
    assert.deepEqual(missing, []);
    assert.deepEqual(restored.messages[0].plan_document, fullFeatured.plan_document);
  });

  it('admits every message key found across the release-compat fixtures', () => {
    const { IMPORTED_MESSAGE_KEY_ALLOWLIST, stripUnknownImportedMessageKeys } = loadBounds();
    assert.ok(Object.isFrozen(IMPORTED_MESSAGE_KEY_ALLOWLIST));
    const entries = collectFixtureMessages(FIXTURES_ROOT);
    assert.ok(entries.length > 20);
    for (const { file, message } of entries) {
      const { strippedKeys } = stripUnknownImportedMessageKeys(message);
      assert.deepEqual(strippedKeys, [], `${path.relative(FIXTURES_ROOT, file)} ${message.id}`);
    }
  });
});

describe('import bounds hold on the normalized message too', () => {
  it('rejects a message whose visible segments join into content over the text limit', () => {
    const segment = 'A'.repeat(60_000);
    const message = {
      id: 'm-joined',
      role: 'assistant',
      content: 'ok',
      visible_segments: Array.from({ length: 40 }, () => ({ kind: 'text', text: segment })),
    };
    const store = createMockSessionStore();
    assert.throws(
      () => importSession(store, payloadWithMessages([message]), null),
      (error) => error.reason === 'format_mismatch' && /after normalization/.test(error.message)
    );
    assert.deepEqual(Object.keys(store._sessions), [], 'nothing is persisted');
  });

  it('reports the stripped unknown keys on the returned summary', () => {
    const store = createMockSessionStore();
    const summary = importSession(store, payloadWithMessages([
      { id: 'm1', role: 'user', content: 'hi', foo: 1, bar: 2 },
      { id: 'm2', role: 'user', content: 'yo', foo: 3 },
    ]), null);
    assert.deepEqual(summary.stripped_message_keys, ['bar', 'foo']);
    const clean = importSession(createMockSessionStore(), payloadWithMessages([{ id: 'm3', role: 'user', content: 'hi' }]), null);
    assert.equal('stripped_message_keys' in clean, false);
  });
});

describe('addressed session message keys on import', () => {
  it('admits session_message and disposition, nothing else new', () => {
    const { IMPORTED_MESSAGE_KEY_ALLOWLIST, stripUnknownImportedMessageKeys } = loadBounds();
    assert.ok(IMPORTED_MESSAGE_KEY_ALLOWLIST.has('session_message'));
    assert.ok(IMPORTED_MESSAGE_KEY_ALLOWLIST.has('disposition'));
    const { message, strippedKeys } = stripUnknownImportedMessageKeys({
      id: 'ctx_x', role: 'context', content: 'c', session_message: {}, disposition: 'discarded', authority: 'x',
    });
    assert.deepEqual(strippedKeys, ['authority']);
    assert.deepEqual(Object.keys(message).sort(), ['content', 'disposition', 'id', 'role', 'session_message']);
  });

  it('bounds an oversized envelope string like any other message field', () => {
    const store = createMockSessionStore();
    const huge = { id: 'ctx_h', role: 'context', kind: 'session_message', content: 'c', session_message: { body: 'B'.repeat(70_000) } };
    assert.throws(
      () => importSession(store, payloadWithMessages([huge]), null),
      (error) => error.reason === 'format_mismatch' && /session_message\.body/.test(error.message)
    );
    assert.deepEqual(Object.keys(store._sessions), []);
  });
});
