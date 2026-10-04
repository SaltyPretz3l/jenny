const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(() => cleanupTrackedResources());

function createStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-audit-'));
  trackDirectory(root);
  const store = new SessionShadowStore(path.join(root, 'shadow-sessions.json'));
  t.after(() => store.dispose());
  for (const id of ['sess_delete', 'sess_keep']) {
    store.upsertSession(id, { title: id });
    assert.ok(store.getSession(id));
    assert.equal(store._stalePlanAuditSessionIds.has(id), true);
  }
  return store;
}

for (const scrubLinks of [true, false]) {
  test(`successful deletion clears only its audit key (scrubLinks=${scrubLinks})`, t => {
    const store = createStore(t);
    assert.equal(store.deleteSession('sess_delete', { scrubLinks }), true);
    assert.equal(store.getSession('sess_delete'), null);
    assert.equal(store._stalePlanAuditSessionIds.has('sess_delete'), false, 'deleted session audit key must be cleared');
    assert.equal(store._stalePlanAuditSessionIds.has('sess_keep'), true);
    store.upsertSession('sess_delete', { title: 'Recreated' });
    assert.ok(store.getSession('sess_delete'));
    assert.equal(store._stalePlanAuditSessionIds.has('sess_delete'), true);
  });
}

test('failed deletion preserves its session and audit key', t => {
  const store = createStore(t);
  const sessionStore = store._backend._sessionStores.get('sess_delete');
  const deleteImpl = sessionStore.delete;
  sessionStore.delete = () => { throw new Error('injected file delete failure'); };
  try {
    assert.equal(store.deleteSession('sess_delete'), false);
    assert.equal(store._stalePlanAuditSessionIds.has('sess_delete'), true);
    assert.ok(store.getSession('sess_delete'));
  } finally {
    sessionStore.delete = deleteImpl;
  }
});
