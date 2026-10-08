'use strict';

/* Hosted suggested changes (row 35 Plan Plus): the browser API reads a
 * session's suggestions, records decisions under the control lease, applies an
 * accept for the revision the client names, and enters Propose through
 * sessions.preferences. The service and session store are the real ones. */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SuggestedChangesService } = require('../../services/backend/suggested-changes-service');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');

const BOOT = 'boot_test';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-suggested-hosted-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'));
  const applyCalls = [];
  const backend = Object.assign(new EventEmitter(), {
    sessionStore,
    activeStreams: new Map(),
    pendingToolApprovals: new Map(),
    pendingUserQuestions: new Map(),
    listSessions: async () => ({ object: 'list', data: sessionStore.listSessions() }),
    createSession: async ({ title }) => ({ object: 'session', data: sessionStore.createSession({ title }) }),
    setSessionPreferences: async (id, preferences) => ({ object: 'session', data: sessionStore.setSessionPreferences(id, preferences) }),
  });
  backend.suggestedChanges = new SuggestedChangesService({
    getStore: () => sessionStore,
    projectAuthority: { captureSession: () => ({ root_path: '/workspace', device_id: '1', inode: '2' }) },
    applyRequest: async (request) => {
      applyCalls.push(request);
      return {
        schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: 'cs_1' },
        items: request.items.map((item) => ({ suggestion_id: item.suggestion_id, outcome: 'applied', after_hash: HASH_B })),
      };
    },
  });
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const eventStream = { events: [], publish(type, payload) { this.events.push({ type, payload }); } };
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT, eventStream });
  const a = clients.register('device-a');
  const contextA = { deviceId: 'device-a', clientToken: a.client_token, isAuthenticated: () => true };
  return {
    backend, router, a, contextA, applyCalls, eventStream,
    close() { router.dispose(); sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

let sequence = 0;
function command(auth, operation, params = {}, extra = {}) {
  return { api_version: 1, operation, request_id: `request_${++sequence}`, client_id: auth.client_id, boot_epoch: BOOT, params, ...extra };
}

async function setup(f) {
  const created = await f.router.dispatch(command(f.a, 'sessions.create', { title: 'Hosted propose' }), f.contextA);
  const sessionId = created.session.session_id;
  const acquired = await f.router.dispatch(command(f.a, 'control.acquire', { takeover: false }, { session_id: sessionId }), f.contextA);
  const leased = (operation, params) => command(f.a, operation, params, {
    session_id: sessionId,
    control_generation: acquired.lease.generation,
    expected_revision: f.router.snapshot(sessionId).session.revision,
  });
  return { sessionId, leased };
}

function propose(f, sessionId, callId, extra = {}) {
  return f.backend.suggestedChanges.recordToolOutcome({
    toolName: 'propose_change', sessionId, callId, turnId: 'turn_1',
    result: {
      metadata: {
        suggested_change: {
          schema_version: 1, path: `src/${callId}.js`, kind: 'replace', old_string: 'one', new_string: 'two',
          title: callId, what: 'w', why: 'y', base_hash: HASH_A, ...extra,
        },
      },
    },
  });
}

test('hosted: sessions.preferences enters Propose and validates the run mode', async (t) => {
  const f = createFixture();
  t.after(() => f.close());
  const { sessionId, leased } = await setup(f);
  const entered = await f.router.dispatch(leased('sessions.preferences', { run_mode: 'propose' }), f.contextA);
  assert.equal(entered.ok, true);
  assert.equal(f.backend.sessionStore.getSession(sessionId).run_mode, 'propose');
  assert.equal((await f.router.dispatch(leased('sessions.preferences', { run_mode: 'yolo' }), f.contextA)).error.reason, 'invalid_command_parameters');
  assert.equal((await f.router.dispatch(leased('sessions.preferences', {}), f.contextA)).error.reason, 'invalid_command_parameters');
  assert.equal((await f.router.dispatch(leased('sessions.preferences', { plan_mode: false }), f.contextA)).ok, true);
});

test('hosted: list, leased decisions and an accept for the named revision', async (t) => {
  const f = createFixture();
  t.after(() => f.close());
  const { sessionId, leased } = await setup(f);
  const first = propose(f, sessionId, 'a');
  const second = propose(f, sessionId, 'b');

  const listOptions = [];
  const list = f.backend.suggestedChanges.list.bind(f.backend.suggestedChanges);
  f.backend.suggestedChanges.list = (id, options) => { listOptions.push(options); return list(id, options); };
  const listed = await f.router.dispatch(command(f.a, 'suggestedChanges.list', {}, { session_id: sessionId }), f.contextA);
  assert.equal(listed.ok, true);
  assert.equal(listed.suggested_changes.pending_count, 2);
  assert.deepEqual(listOptions, [{ persist: false }], 'a read without the lease saves nothing');

  const unleased = await f.router.dispatch(command(f.a, 'suggestedChanges.decide', { id: second.id, decision: 'later' }, { session_id: sessionId }), f.contextA);
  assert.equal(unleased.ok, false, 'decisions need the control lease');

  const later = await f.router.dispatch(leased('suggestedChanges.decide', { id: second.id, decision: 'later' }), f.contextA);
  assert.equal(later.ok, true);
  assert.equal(later.entry.status, 'later');
  assert.equal(f.eventStream.events.at(-1).payload.reason, 'suggested_changes');

  const noRevision = await f.router.dispatch(leased('suggestedChanges.accept', { id: first.id }), f.contextA);
  assert.equal(noRevision.error.reason, 'invalid_command_parameters', 'consent names a revision');
  const stale = await f.router.dispatch(leased('suggestedChanges.accept', { id: first.id, revision: 2 }), f.contextA);
  assert.equal(stale.error.reason, 'suggestion_revision_changed');

  const acceptCommand = leased('suggestedChanges.accept', { id: first.id, revision: 1 });
  const accepted = await f.router.dispatch(acceptCommand, f.contextA);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.applied, true);
  assert.deepEqual(accepted.applied_ids, [first.id]);
  assert.equal(f.applyCalls.length, 1);
  assert.equal(f.applyCalls[0].authority.root_path, '/workspace');
  assert.deepEqual(await f.router.dispatch(acceptCommand, f.contextA), accepted, 'a retried request returns its receipt');
  assert.equal(f.applyCalls.length, 1, 'and applies nothing twice');
});

test('hosted: comments go out as one digest and a failed send can be put back', async (t) => {
  const f = createFixture();
  t.after(() => f.close());
  const { sessionId, leased } = await setup(f);
  const entry = propose(f, sessionId, 'a');
  assert.equal((await f.router.dispatch(leased('suggestedChanges.comment', { id: entry.id, text: 'Use three' }), f.contextA)).ok, true);
  const sent = await f.router.dispatch(leased('suggestedChanges.sendComments', {}), f.contextA);
  assert.equal(sent.ok, true);
  assert.match(sent.message, /Comment: Use three/);
  const undone = await f.router.dispatch(leased('suggestedChanges.sendComments', { undo: { ids: sent.ids, sent_at: sent.sent_at } }), f.contextA);
  assert.deepEqual(undone.ids, [entry.id]);
  const empty = await f.router.dispatch(leased('suggestedChanges.comment', { id: entry.id, text: '' }), f.contextA);
  assert.equal(empty.error.reason, 'invalid_command_parameters');
  const discarded = await f.router.dispatch(leased('suggestedChanges.discardPending', {}), f.contextA);
  assert.equal(discarded.discarded, 1);
});
