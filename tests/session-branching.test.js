const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { forkSession } = require('../services/backend/session-branching');
const E = require('../services/backend/session-message-envelope');
const F = require('./helpers/session-mail-fixtures');
// forkSessionWithArtifacts and the artifact rewrite/strip helpers are covered
// in tests/session-branching-fork-artifacts.test.js (split to respect the
// test-file size gate).

function createGeneratedArtifactEntry(sessionId, artifactId) {
  return {
    artifact_id: artifactId,
    artifact_kind: 'document',
    title: 'Scratch Plan',
    file_name: 'scratch-plan.md',
    display_path: `.jenny/artifacts/${sessionId}/scratch-plan.md`,
    absolute_path: `/ws/.jenny/artifacts/${sessionId}/scratch-plan.md`,
    language: 'markdown',
    status: 'available',
  };
}

function createArtifactBearingToolResultMessage(sessionId) {
  return {
    id: 'msg_2',
    role: 'assistant',
    kind: 'tool_result',
    content: '',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'write_file',
      output_text: 'wrote 6 bytes',
      summary: 'Wrote scratch-plan.md',
      is_error: false,
      generated_artifacts: [createGeneratedArtifactEntry(sessionId, 'artifact_plan_1')],
      metadata: { path: 'scratch-plan.md' },
    },
  };
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
      return {
        id: session.id,
        title: session.title,
        message_count: (session.messages || []).length,
        linked_session_ids: session.linked_session_ids || [],
        branch_origin: session.branch_origin || null,
      };
    },
  };
  return store;
}

function createMockShadowStore(sessions = {}) {
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
  };
  return store;
}

describe('forkSession', () => {
  it('returns null for nonexistent session', () => {
    const store = createMockSessionStore();
    assert.equal(forkSession(store, 'nonexistent', 'msg_1'), null);
  });

  it('returns null for nonexistent message', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original',
        messages: [{ id: 'msg_1', role: 'user', content: 'Hello' }],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    });
    assert.equal(forkSession(store, 'sess_1', 'msg_999'), null);
  });

  it('returns null for non-branchable special assistant messages', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello' },
          { id: 'msg_2', role: 'assistant', kind: 'question_batch', content: 'Pick one' },
        ],
        linked_session_ids: [],
      },
    });

    assert.equal(forkSession(store, 'sess_1', 'msg_2'), null);
    assert.deepEqual(store.getSession('sess_1').linked_session_ids, []);
  });

  it('returns null and leaves parent links unchanged when persistence is blocked', () => {
    const sourceSession = {
      id: 'sess_1',
      title: 'Original',
      messages: [{ id: 'msg_1', role: 'user', content: 'Hello' }],
      linked_session_ids: [],
      last_model_used: '',
      preferred_model: '',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      context_preferences: {},
    };
    const store = {
      getSession(sessionId) {
        return sessionId === 'sess_1' ? sourceSession : null;
      },
      _read() {
        return { schema_version: 11, sessions: { sess_1: sourceSession } };
      },
      _write() {
        // Simulates the future-schema write-blocked path: no branch persists.
      },
      _toSummary(session) {
        return { id: session.id, title: session.title, message_count: session.messages.length };
      },
    };

    assert.equal(forkSession(store, 'sess_1', 'msg_1'), null);
    assert.deepEqual(sourceSession.linked_session_ids, []);
  });

  it('forks session at message and links to parent', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'First' },
          { id: 'msg_2', role: 'assistant', content: 'Response 1' },
          { id: 'msg_3', role: 'user', content: 'Second' },
          { id: 'msg_4', role: 'assistant', content: 'Response 2' },
        ],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
        lockdown: true,
      },
    });

    const branch = forkSession(store, 'sess_1', 'msg_2');
    assert.ok(branch);
    assert.equal(store.getSession(branch.id).lockdown, true, 'a locked session forks locked');
    assert.ok(branch.id !== 'sess_1');
    assert.ok(branch.title.includes('branch'));
    assert.equal(branch.message_count, 2);
    assert.ok(branch.linked_session_ids.includes('sess_1'));
    assert.deepEqual(branch.branch_origin, {
      source_session_id: 'sess_1',
      source_message_id: 'msg_2',
      source_title: 'Original Chat',
      created_at: branch.branch_origin.created_at,
    });
    assert.match(branch.branch_origin.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(store.getSession('sess_1').linked_session_ids.includes(branch.id));
  });

  it('keeps the branch message sequence counter ahead of copied event_seq values', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'First', event_seq: 7 },
          { id: 'msg_2', role: 'assistant', content: 'Response 1', event_seq: 9 },
        ],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    });

    const branch = forkSession(store, 'sess_1', 'msg_2');
    const branchSession = store.getSession(branch.id);

    assert.equal(branchSession.message_seq_counter, 10);
  });

  it('mirrors forked sessions into the shadow store', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'First' },
          { id: 'msg_2', role: 'assistant', content: 'Response 1' },
        ],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    });
    const shadowStore = createMockShadowStore();

    const branch = forkSession(store, 'sess_1', 'msg_2', { shadowStore });

    assert.ok(branch);
    const shadowSession = shadowStore.getSession(branch.id);
    assert.ok(shadowSession);
    assert.equal(shadowSession.id, branch.id);
    assert.equal(shadowSession.messages.length, 2);
    assert.ok(shadowSession.linked_session_ids.includes('sess_1'));
    assert.deepEqual(shadowSession.branch_origin, branch.branch_origin);
  });

  it('does not carry generated artifact references into the branch', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Write a plan' },
          createArtifactBearingToolResultMessage('sess_1'),
          { id: 'msg_3', role: 'assistant', content: 'Done' },
        ],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    });

    const branch = forkSession(store, 'sess_1', 'msg_3');
    assert.ok(branch);
    const branchSession = store.getSession(branch.id);
    const branchedToolResult = branchSession.messages[1].tool_result;

    // Artifacts live in the source session's scratch dir; the branch must not
    // advertise ids it can never resolve. normalizeToolResultMetadata always
    // re-emits the key, so "not carried" reads as an empty list here.
    assert.deepEqual(branchedToolResult.generated_artifacts, []);
    // The metadata bag is the copy that survives tool_result normalization.
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, true);
    // Unrelated tool_result fields still copy across untouched.
    assert.equal(branchedToolResult.tool_name, 'write_file');
    assert.equal(branchedToolResult.metadata.path, 'scratch-plan.md');
  });

  it('leaves the source session message untouched when stripping branch artifacts', () => {
    const sourceMessage = createArtifactBearingToolResultMessage('sess_1');
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Write a plan' },
          sourceMessage,
          { id: 'msg_3', role: 'assistant', content: 'Done' },
        ],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    });

    assert.ok(forkSession(store, 'sess_1', 'msg_3'));

    // The fork copy is a shallow spread, so tool_result is shared by reference
    // with this very object: stripping must never mutate it in place.
    assert.equal(sourceMessage.tool_result.generated_artifacts.length, 1);
    assert.equal(
      sourceMessage.tool_result.generated_artifacts[0].artifact_id,
      'artifact_plan_1'
    );
    assert.equal(sourceMessage.tool_result.artifacts_not_carried, undefined);
    assert.equal(sourceMessage.tool_result.metadata.artifacts_not_carried, undefined);
  });

  it('leaves artifact-free tool results unmarked in the branch', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Original Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'List files' },
          {
            id: 'msg_2',
            role: 'assistant',
            kind: 'tool_result',
            content: '',
            tool_result: {
              call_id: 'call_1',
              tool_name: 'list_dir',
              output_text: 'a.txt',
              summary: 'Listed 1 entry',
              is_error: false,
            },
          },
          { id: 'msg_3', role: 'assistant', content: 'Done' },
        ],
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    });

    const branch = forkSession(store, 'sess_1', 'msg_3');
    assert.ok(branch);
    const branchedToolResult = store.getSession(branch.id).messages[1].tool_result;

    assert.deepEqual(branchedToolResult.generated_artifacts, []);
    assert.equal(branchedToolResult.artifacts_not_carried, undefined);
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, undefined);
  });
});

describe('forkSession and addressed session messages', () => {
  const sessionWithMail = () => {
    const envelope = F.makeEnvelope(1, { body: 'handoff from another chat' });
    const included = E.buildIncludedRow(envelope, { turn_id: 'turn_1', timestamp: F.iso(1) });
    const receipt = E.buildDiscardReceiptRow(F.makeEnvelope(2, { body: 'dismissed' }), { timestamp: F.iso(2) });
    return {
      sess_mail: {
        id: 'sess_mail',
        title: 'Mail chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'First' },
          { id: 'msg_2', role: 'assistant', content: 'Response 1' },
          receipt,
          included,
          { id: 'msg_3', role: 'user', content: 'Second' },
          { id: 'msg_4', role: 'assistant', content: 'Response 2' },
        ],
        session_mail: {
          schema_version: 1,
          next_receive_sequence: 2,
          inbox: [{
            envelope, receipt_id: F.uuid(3001), receive_sequence: 1, delivered_at: F.iso(), read_at: null,
            source_receipt_confirmed_at: null, source_absent: false,
            context: { state: 'included', turn_id: 'turn_1', snapshot_id: F.uuid(6001), included_at: F.iso(), canonical_message_id: included.id },
          }],
          discarded: [], outbox: [F.makeOutbox(1)], authorizations: [], report_reservations: [], admission_snapshots: [F.makeSnapshot(1)],
          reporting_enabled: false,
        },
        coordination_revision: 7,
        linked_session_ids: [],
        last_model_used: '',
        preferred_model: '',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: {},
      },
    };
  };

  it('copies context rows verbatim as inert history, with their canonical ids', () => {
    const store = createMockSessionStore(sessionWithMail());
    const branch = forkSession(store, 'sess_mail', 'msg_3');
    assert.ok(branch);
    const messages = store.getSession(branch.id).messages;
    assert.deepEqual(messages.map((m) => m.id).filter((id) => /^ctx/.test(id)), [`ctxr_${F.uuid(2)}`, `ctx_${F.uuid(1)}`]);
    const row = messages.find((m) => m.id === `ctx_${F.uuid(1)}`);
    assert.equal(row.role, 'context');
    assert.equal(row.content, 'handoff from another chat');
    assert.equal(row.turn_id, 'turn_1');
    assert.ok(!row.client_message_id, 'a context row is not re-keyed like an ordinary copy');
    assert.equal(messages.find((m) => m.id === `ctxr_${F.uuid(2)}`).disposition, 'discarded');
    assert.deepEqual(messages.filter((m) => m.role !== 'context').map((m) => m.content), ['First', 'Response 1', 'Second']);
  });

  it('never copies the mailbox: no inbox, outbox, snapshots, authorizations or revision', () => {
    const store = createMockSessionStore(sessionWithMail());
    const before = JSON.stringify(store.getSession('sess_mail').session_mail);
    const branch = forkSession(store, 'sess_mail', 'msg_4');
    const forked = store.getSession(branch.id);
    assert.deepEqual(forked.session_mail.inbox, []);
    assert.deepEqual(forked.session_mail.outbox, []);
    assert.deepEqual(forked.session_mail.admission_snapshots, []);
    assert.deepEqual(forked.session_mail.authorizations, []);
    assert.equal(forked.session_mail.next_receive_sequence, 1);
    assert.equal(forked.coordination_revision, 0);
    assert.equal(JSON.stringify(store.getSession('sess_mail').session_mail), before, 'the source mailbox is untouched');
  });

  it('a context row cannot be a fork target', () => {
    const store = createMockSessionStore(sessionWithMail());
    assert.equal(forkSession(store, 'sess_mail', `ctx_${F.uuid(1)}`), null);
    assert.equal(forkSession(store, 'sess_mail', `ctxr_${F.uuid(2)}`), null);
  });
});

it('row 69: the primary Jenny chat cannot be branched', () => {
  const messages = [{ id: 'msg_1', role: 'user', content: 'what was I working on?' }];
  const store = createMockSessionStore({
    primary: { id: 'primary', title: 'Jenny', session_role: 'primary', project_id: 'project_general', messages, linked_session_ids: [] },
    plain: { id: 'plain', title: 'Plan', project_id: 'project_general', messages, linked_session_ids: [] },
  });
  assert.equal(forkSession(store, 'primary', 'msg_1'), null, 'a branch would copy a cross-project transcript into General');
  assert.ok(forkSession(store, 'plain', 'msg_1'), 'ordinary chats still branch');
});
