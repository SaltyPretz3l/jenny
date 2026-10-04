'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');

const BOOT = 'boot_delete_test';

function createFixture(routerOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-router-delete-'));
  const backend = Object.assign(new EventEmitter(), {
    sessionStore: new ElectronSessionStore(path.join(root, 'sessions.json')),
    deleteCalls: 0,
    deleteOutcome: (sessionId) => ({ object: 'session', id: sessionId, deleted: true,
      cleanup_status: 'complete', cleanup_errors: [] }),
    async listSessions() { return { data: this.sessionStore.listSessions() }; },
    async createSession({ title }) { return { data: this.sessionStore.createSession({ title }) }; },
    async deleteSession(sessionId) {
      this.deleteCalls += 1;
      const outcome = this.deleteOutcome(sessionId);
      if (outcome && outcome.deleted !== false) this.sessionStore.deleteSession(sessionId);
      return outcome;
    },
  });
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const eventStream = { publish() {} };
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT,
    eventStream, ...routerOptions });
  const auth = clients.register('device-a');
  const context = { deviceId: 'device-a', clientToken: auth.client_token, isAuthenticated: () => true };
  let sequence = 0;
  const command = (operation, params = {}, extra = {}) => ({ api_version: 1, operation,
    request_id: `delete_request_${++sequence}`, client_id: auth.client_id, boot_epoch: BOOT, params, ...extra });
  return {
    backend, router, context, command,
    async seedSession() {
      const sessionId = backend.sessionStore.createSession({ title: 'Doomed' }).id;
      const acquired = await router.dispatch(command('control.acquire', {}, { session_id: sessionId }), context);
      assert.equal(acquired.ok, true);
      return { sessionId, lease: acquired.lease };
    },
    deleteCommand(sessionId, lease) {
      return command('sessions.delete', {}, { session_id: sessionId, control_generation: lease.generation,
        expected_revision: router.snapshot(sessionId).session.revision });
    },
    async close() { router.dispose(); backend.sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('deletion carries a bounded cleanup outcome and an exact retry returns it without deleting again', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const { sessionId, lease } = await f.seedSession();
  f.backend.deleteOutcome = (id) => ({ object: 'session', id, deleted: true, cleanup_status: 'degraded',
    cleanup_errors: [{ step: 'artifacts', code: 'cleanup_failed', secret: 'x' }, 'junk', null] });
  const request = f.deleteCommand(sessionId, lease);
  const result = await f.router.dispatch(request, f.context);
  assert.deepEqual(result, { ok: true, session_id: sessionId, deleted: true, cleanup_status: 'degraded',
    cleanup_errors: [{ step: 'artifacts', code: 'cleanup_failed' }] });
  assert.deepEqual(await f.router.dispatch(request, f.context), result);
  assert.equal(f.backend.deleteCalls, 1);
  const receipt = await f.router.dispatch(f.command('requests.status', { request_id: request.request_id }), f.context);
  assert.deepEqual(receipt.result, result);
});

test('cleanup errors are capped, field-by-field strings sliced to 32 characters', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const { sessionId, lease } = await f.seedSession();
  f.backend.deleteOutcome = (id) => ({ id, deleted: true, cleanup_status: 'degraded',
    cleanup_errors: Array.from({ length: 20 }, (_unused, index) => ({
      step: `${index}`.padEnd(100, 's'), code: 'c'.repeat(100), path: 'C:/private' })) });
  const result = await f.router.dispatch(f.deleteCommand(sessionId, lease), f.context);
  assert.equal(result.cleanup_errors.length, 16);
  for (const entry of result.cleanup_errors) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'step']);
    assert.equal(entry.step.length, 32);
    assert.equal(entry.code.length, 32);
  }
});

test('a bare true from the backend reports complete cleanup', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const { sessionId, lease } = await f.seedSession();
  f.backend.deleteOutcome = () => true;
  const result = await f.router.dispatch(f.deleteCommand(sessionId, lease), f.context);
  assert.deepEqual(result, { ok: true, session_id: sessionId, deleted: true,
    cleanup_status: 'complete', cleanup_errors: [] });
});

test('deletion stays available under the growth disk reserve while creation is refused', async (t) => {
  const f = createFixture({ canAdmit: () => false, canAdmitDeletion: () => true }); t.after(() => f.close());
  const { sessionId, lease } = await f.seedSession();
  const created = await f.router.dispatch(f.command('sessions.create', { title: 'New' }), f.context);
  assert.equal(created.ok, false);
  assert.equal(created.error.reason, 'disk_pressure');
  const deleted = await f.router.dispatch(f.deleteCommand(sessionId, lease), f.context);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted, true);
});

test('deletion is refused when even the deletion reserve is unavailable', async (t) => {
  const f = createFixture({ canAdmit: () => true, canAdmitDeletion: () => false }); t.after(() => f.close());
  const { sessionId, lease } = await f.seedSession();
  const refused = await f.router.dispatch(f.deleteCommand(sessionId, lease), f.context);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'disk_pressure');
  assert.equal(f.backend.deleteCalls, 0);
});
