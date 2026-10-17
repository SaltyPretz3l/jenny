'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ElectronSessionStore, createSessionId } = require('../services/backend/electron-session-store');
const { buildCreatedSession } = require('../services/backend/session-store-create-record');
const { buildSessionSummary } = require('../services/backend/session-summary-projection');
const { createSession, createLinkedChildSession } = require('../services/backend/backend-sessions');

function fixture(t) {
  const scratch = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'linked-child-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {}, writeDebounceMs: 60000 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const spec = {
    childSessionId: createSessionId(), childIncarnation: `inc_${'c'.repeat(32)}`, title: 'New Chat',
    projectId: 'project_destination', preferences: { preferred_model: 'model', reasoning_effort: 'high', run_mode: 'plan' },
    lockdown: true,
    spawnedFrom: {
      schema_version: 1, parent_session_id: 'sess_parent', parent_session_incarnation: `inc_${'a'.repeat(32)}`,
      proposal_id: `proposal_${'b'.repeat(64)}`, created_at: '2026-10-15T10:00:00.000Z',
      child_creation_hash: 'd'.repeat(64), reporting_consent_id: '11111111-1111-4111-8111-111111111111',
    },
  };
  return { store, spec, service: { sessionStore: store, projectAuthority: { captureProject: (id) => ({ project_id: id }) } } };
}

test('linked-child creation flushes, projects bounded provenance and survives empty-session sweeping', (t) => {
  const { store, spec, service } = fixture(t);
  const created = createLinkedChildSession(service, spec);
  assert.equal(created.ok, true);
  assert.equal(store.hasPendingWrites(), false);
  const child = store.getSession(spec.childSessionId);
  assert.equal(child.session_incarnation, spec.childIncarnation);
  assert.deepEqual(child.spawned_from, spec.spawnedFrom);
  assert.equal(child.session_mail.reporting_enabled, true);
  assert.equal(child.lockdown, true);
  const summary = store.listSessions()[0];
  assert.deepEqual(summary.spawned_from, {
    parent_session_id: spec.spawnedFrom.parent_session_id, proposal_id: spec.spawnedFrom.proposal_id,
    created_at: spec.spawnedFrom.created_at,
  });
  assert.equal(summary.session_incarnation, spec.childIncarnation);
  assert.equal(summary.children_expanded, null);
  assert.equal(summary.coordination_revision, 0);
  store.createSession({ title: 'New Chat' });
  assert.equal(store.sweepEmptySessions().deleted, 1);
  assert.ok(store.getSession(spec.childSessionId));
  assert.deepEqual(createLinkedChildSession(service, spec), { ok: true, session_id: spec.childSessionId, existed: true });
  assert.deepEqual(createLinkedChildSession(service, { ...spec, spawnedFrom: {
    ...spec.spawnedFrom, child_creation_hash: 'e'.repeat(64),
  } }), { ok: false, code: 'proof_mismatch' });
  assert.equal(store.listSessions().length, 1);
});

test('child flush failure rolls back the reserved child before publishing success', (t) => {
  const { store, spec, service } = fixture(t);
  store.flushSession = () => false;
  assert.deepEqual(createLinkedChildSession(service, spec), { ok: false, code: 'flush_failed' });
  assert.equal(store.getSession(spec.childSessionId), null);
  assert.equal(store.listSessions().length, 0);
});

test('creation rejects malformed incarnation or provenance before inserting a record', (t) => {
  const { store, spec } = fixture(t);
  for (const sessionIncarnation of [null, '', 'inc_bad', `inc_${'A'.repeat(32)}`]) {
    assert.throws(() => store.createSessionWithId(spec.childSessionId, { sessionIncarnation }), /session_incarnation_invalid/);
  }
  for (const spawnedFrom of [null, {}, { ...spec.spawnedFrom, extra: true }, { schema_version: 2 }]) {
    assert.throws(() => store.createSessionWithId(spec.childSessionId, { spawnedFrom }), /spawned_from_invalid/);
  }
  assert.equal(store.listSessions().length, 0);
  assert.equal(buildCreatedSession('session', {}, { normalizeSession: (id, record) => ({ id, ...record }), clipTitle: () => 'Title' }).title, 'Title');
});

test('plain create cannot inject linked-child identity or provenance', async (t) => {
  const { store, spec, service } = fixture(t);
  const result = await createSession(service, {
    title: 'Plain', projectId: 'project_general', sessionIncarnation: spec.childIncarnation, spawnedFrom: spec.spawnedFrom,
    preferences: { spawned_from: spec.spawnedFrom, session_incarnation: spec.childIncarnation },
  });
  const plain = store.getSession(result.data.id);
  assert.equal(plain.spawned_from, null);
  assert.notEqual(plain.session_incarnation, spec.childIncarnation);
  assert.equal(plain.session_mail.reporting_enabled, false);
});

test('summary handles absent, invalid and future provenance without exposing its private fields', () => {
  const blank = buildSessionSummary({});
  assert.equal(blank.spawned_from, null);
  assert.equal(blank.coordination_revision, null);
  assert.equal(blank.children_expanded, null);
  assert.equal(blank.session_incarnation, null);
  const future = buildSessionSummary({ spawned_from: { schema_version: 2, secret: 'hidden' },
    coordination_revision: 7, workspace_view: { children_expanded: false }, session_incarnation: 'inc_legacy' });
  assert.equal(future.spawned_from, null);
  assert.equal(future.coordination_revision, 7);
  assert.equal(future.children_expanded, false);
  assert.equal(future.session_incarnation, 'inc_legacy');
});
