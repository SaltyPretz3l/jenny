'use strict';

// Row 94 P2 (owner pick F1): the fork source reader, the linked fork creator and the branching seams they
// use (a reserved branch id honored by forkSessionWithArtifacts, internal session fields on the branch).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { forkSessionWithArtifacts } = require('../services/backend/session-branching');
const { forkingEnabled, lastBranchableMessageId, readForkSource } = require('../services/backend/session-fork-source');
const { createLinkedForkSession } = require('../services/backend/linked-fork-session');

const CHILD = 'sess_1730000000000_abcdef012345';
const INC = `inc_${'1'.repeat(32)}`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linked-fork-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const parentId = store.createSession({ title: 'Jenny', sessionRole: 'primary' }).id;
  const sourceId = store.createSession({ title: 'Parser work', projectId: 'project_two', preferences: { lockdown: true } }).id;
  store.appendMessage(sourceId, { id: 'msg_u1', role: 'user', content: 'Split it.' });
  store.appendMessage(sourceId, { id: 'msg_a1', role: 'assistant', content: 'Plan.' });
  store.appendMessage(sourceId, { id: 'msg_t1', role: 'assistant', kind: 'tool_use', content: '' });
  return { store, parentId, sourceId };
}

function spec(env, extra = {}) {
  return {
    childSessionId: CHILD, childIncarnation: INC, title: 'Try the lexer', projectId: 'project_two', forkOfSessionId: env.sourceId,
    spawnedFrom: {
      schema_version: 1, parent_session_id: env.parentId, parent_session_incarnation: 'inc_parent', proposal_id: `proposal_${'a'.repeat(64)}`,
      created_at: '2026-11-02T10:00:00.000Z', child_creation_hash: 'b'.repeat(64), reporting_consent_id: '11111111-1111-4111-8111-111111111111',
    },
    preferences: { preferred_model: 'm2', reasoning_effort: 'low', run_mode: 'plan' },
    lockdown: false,
    ...extra,
  };
}

test('lastBranchableMessageId and readForkSource: newest user or assistant row; primary, unknown and empty refused', (t) => {
  const env = setup(t);
  assert.equal(lastBranchableMessageId([{ id: 'a', role: 'user' }, { id: 'b', role: 'assistant', kind: 'tool_use' }, { id: 'c', role: 'context' }]), 'a');
  assert.equal(lastBranchableMessageId(null), null);
  const source = readForkSource(env.store, env.sourceId);
  assert.equal(source.ok, true);
  assert.equal(source.message_id, 'msg_a1');
  assert.equal(source.project_id, 'project_two');
  assert.equal(source.title, 'Parser work');
  assert.equal(readForkSource(env.store, env.parentId).reason, 'fork_primary');
  assert.equal(readForkSource(env.store, 'sess_nope').reason, 'unknown_fork');
  assert.equal(readForkSource(env.store, '').reason, 'unknown_fork');
  const empty = env.store.createSession({ title: 'empty' }).id;
  assert.equal(readForkSource(env.store, empty).reason, 'fork_empty');
  assert.equal(readForkSource({ peekSession() { throw new Error('x'); } }, 'a').reason, 'unknown_fork');
  assert.equal(forkingEnabled(undefined), true);
  assert.equal(forkingEnabled({ primary_chat_placement: false }), false);
});

test('createLinkedForkSession: the reserved child is a fork with the proof, preferences and the source lockdown kept', async (t) => {
  const env = setup(t);
  const created = await createLinkedForkSession({ sessionStore: env.store }, spec(env));
  assert.deepEqual(created, { ok: true, session_id: CHILD });
  const child = env.store.getSession(CHILD);
  assert.equal(child.title, 'Try the lexer');
  assert.equal(child.session_incarnation, INC);
  assert.equal(child.spawned_from.parent_session_id, env.parentId);
  assert.equal(child.branch_origin.source_session_id, env.sourceId);
  assert.equal(child.branch_origin.source_message_id, 'msg_a1');
  assert.equal(child.messages.length, 2, 'up to the newest branchable message');
  assert.equal(child.preferred_model, 'm2');
  assert.equal(child.reasoning_effort, 'low');
  assert.equal(child.run_mode, 'plan');
  assert.equal(child.plan_mode, true);
  assert.equal(child.lockdown, true, 'never less locked down than its source');
  assert.equal(child.session_mail.reporting_enabled, true);

  assert.deepEqual(await createLinkedForkSession({ sessionStore: env.store }, spec(env)), { ok: true, session_id: CHILD, existed: true });
  const other = spec(env);
  other.spawnedFrom = { ...other.spawnedFrom, child_creation_hash: 'c'.repeat(64) };
  assert.deepEqual(await createLinkedForkSession({ sessionStore: env.store }, other), { ok: false, code: 'proof_mismatch' });
});

test('createLinkedForkSession refuses a malformed spec, a gone or moved source, and rolls back an unflushed fork', async (t) => {
  const env = setup(t);
  const service = { sessionStore: env.store };
  for (const bad of [{ childSessionId: 'bad' }, { childIncarnation: 'inc_x' }, { spawnedFrom: null }, { forkOfSessionId: '' }]) {
    assert.deepEqual(await createLinkedForkSession(service, spec(env, bad)), { ok: false, code: 'invalid_request' }, JSON.stringify(bad));
  }
  assert.equal((await createLinkedForkSession(service, spec(env, { forkOfSessionId: 'sess_gone' }))).code, 'fork_source_unavailable');
  assert.equal((await createLinkedForkSession(service, spec(env, { forkOfSessionId: env.parentId }))).code, 'fork_source_unavailable');
  assert.equal((await createLinkedForkSession(service, spec(env, { projectId: 'project_one' }))).code, 'fork_project_changed');
  assert.equal(env.store.getSession(CHILD), null);

  const flushFails = Object.create(env.store, { flushSession: { value: () => false } });
  assert.deepEqual(await createLinkedForkSession({ sessionStore: flushFails }, spec(env)), { ok: false, code: 'flush_failed' });
  assert.equal(env.store.getSession(CHILD), null, 'the unflushed fork is removed');
  assert.equal((env.store.getSession(env.sourceId).linked_session_ids || []).includes(CHILD), false, 'and its link scrubbed');
});

test('forkSessionWithArtifacts honors a reserved branch id and refuses a taken one before copying artifacts', async (t) => {
  const env = setup(t);
  const calls = [];
  const artifactService = {
    async cloneSessionArtifactsForBranch(...args) { calls.push(['clone', ...args]); return { cloned: false }; },
    async deleteSessionArtifacts(id) { calls.push(['delete', id]); },
  };
  env.store.appendMessage(env.sourceId, {
    id: 'msg_r1', role: 'assistant', content: 'made it',
    tool_result: { call_id: 'c', tool_name: 'write_file', output_text: '', generated_artifacts: [{ artifact_id: 'a1', artifact_kind: 'document', title: 'T', file_name: 'a.md', display_path: `.jenny/artifacts/${env.sourceId}/a.md`, absolute_path: `/ws/.jenny/artifacts/${env.sourceId}/a.md`, language: 'markdown', status: 'available' }] },
  });
  const taken = await forkSessionWithArtifacts(env.store, env.sourceId, 'msg_r1', { branchSessionId: env.parentId, artifactService });
  assert.equal(taken, null);
  assert.deepEqual(calls, [], 'nothing copied or deleted under a taken id');
  const made = await forkSessionWithArtifacts(env.store, env.sourceId, 'msg_r1', { branchSessionId: CHILD, artifactService });
  assert.equal(made.id, CHILD);
  assert.equal(calls[0][2], CHILD, 'artifacts are copied under the reserved id');
});
