'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { RuntimeLineageStore } = require('../../services/session-runtime/lineage-store');
const { RootRunBudgetStore } = require('../../services/session-runtime/budgets');
const { createArchive } = require('../../services/data-lifecycle/archive-service');
const { collectDataInventory } = require('../../services/data-lifecycle/data-inventory');
const { promotePendingRestore, stageRestore } = require('../../services/data-lifecycle/restore-service');
const { createOfflineRuntimeArchivePort, collectRuntimeCoordinationPayload, validateRuntimeCoordinationPayload,
  validateRuntimeCoordinationCrosslinks, runtimeCoordinationDestinations,
  isUntouchedRuntimeCoordinationBootstrap } = require('../../services/data-lifecycle/runtime-coordination-archive');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lineage-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const sessions = new ElectronSessionStore(path.join(source, 'sessions.json'));
  t.after(() => sessions.dispose());
  sessions.createSessionWithId('sess_root', { title: 'Parent', projectId: 'project_general' });
  const authority = { project_id: 'project_general', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  const workStore = new RuntimeStore(path.join(source, 'session-runtime'));
  const budgetStore = new RootRunBudgetStore(path.join(source, 'session-runtime-budgets'));
  budgetStore.create({ rootRunId: 'root_1', authorityFingerprint: 'a'.repeat(64), allowedProviderIds: ['ollama'],
    limits: { inference_requests: 2, input_tokens: 100, output_tokens: 100 } });
  const rootWork = workStore.submit({ idempotencyKey: 'start_1', projectId: 'project_general', sessionId: 'sess_root',
    purpose: 'parent', authority, workId: 'work_root', turnId: 'turn_root', input: { schema_version: 1,
      kind: 'root_chat', root_run: { root_run_id: 'root_1', authority_fingerprint: 'a'.repeat(64) } } }).record;
  const lineage = new RuntimeLineageStore(path.join(source, 'session-runtime-lineage'));
  lineage.create({ rootRunId: 'root_1', rootWorkId: rootWork.work_id, rootSessionId: rootWork.session_id,
    rootTurnId: rootWork.turn_id, projectId: 'project_general', providerId: 'ollama', authorityFingerprint: 'a'.repeat(64),
    limits: { descendants: 8, descendant_depth: 2 } });
  const { child } = lineage.beginSpawn({ rootRunId: 'root_1', parentWorkId: rootWork.work_id,
    parentTurnId: rootWork.turn_id, callId: 'spawn_1', argsSha256: 'b'.repeat(64) });
  sessions.flush();
  const port = createOfflineRuntimeArchivePort({ userDataPath: source, sessionStore: sessions });
  function createChild() {
    sessions.createSessionWithId(child.session_id, { title: 'Child', projectId: 'project_general' });
    sessions.flush();
    const incarnation = sessions.getSession(child.session_id).session_incarnation;
    lineage.recordSession({ rootRunId: 'root_1', childWorkId: child.work_id, sessionIncarnation: incarnation });
    const work = workStore.submit({ idempotencyKey: child.work_id, projectId: 'project_general', sessionId: child.session_id,
      purpose: 'child', authority, workId: child.work_id, turnId: child.turn_id, input: { kind: 'child_chat' } }).record;
    lineage.commitSpawn({ rootRunId: 'root_1', childWorkId: child.work_id, sessionIncarnation: incarnation,
      submissionSha256: work.submission_hash });
    return work;
  }
  function context() {
    const records = workStore.listSummaries({ limit: 100 }).items.map(item => workStore.get(item.work_id));
    const ids = ['sess_root', child.session_id];
    return { runtimeLedger: { records }, sessions: new Map(ids.filter(id => sessions.getSession(id))
      .map(id => [id, sessions.getSession(id)])) };
  }
  return { root, source, sessions, workStore, lineage, child, rootWork, port, context, createChild };
}

for (const state of ['preparing', 'committed']) {
  test(`portable archive preserves ${state} lineage and restart never dispatches it`, async t => {
    const h = fixture(t);
    if (state === 'committed') h.createChild();
    const before = h.lineage.exportPortableSnapshot();
    const inventory = collectDataInventory({ userDataPath: h.source, sessionStore: h.sessions, runtimeArchivePort: h.port });
    const archive = await createArchive({ destinationRoot: path.join(h.root, 'archives'),
      archiveName: 'Lineage.jenny-archive', encrypted: false, entries: inventory.entries });
    const destination = path.join(h.root, 'restored');
    await stageRestore({ archivePath: archive.archivePath, userDataPath: destination });
    assert.equal((await promotePendingRestore({ userDataPath: destination })).status, 'promoted');
    const recoveredLineage = new RuntimeLineageStore(path.join(destination, 'session-runtime-lineage'));
    const recovered = recoveredLineage.exportPortableSnapshot();
    assert.equal(recovered.records[0].document.restored, true);
    assert.equal(recovered.records[0].document.revision, before.records[0].document.revision + 1);
    assert.equal(recovered.records[0].document.children[0].submission_sha256,
      before.records[0].document.children[0].submission_sha256);
    assert.throws(() => recoveredLineage.beginSpawn({ rootRunId: 'root_1', parentWorkId: 'work_root',
      parentTurnId: 'turn_root', callId: 'spawn_2', argsSha256: 'b'.repeat(64) }),
    { code: 'lineage_restored_authority_required' });
    const recoveredWork = new RuntimeStore(path.join(destination, 'session-runtime'));
    assert.equal(recoveredWork.get('work_root').status, 'paused');
    assert.equal(recoveredWork.listReadyCandidates().length, 0);
    if (state === 'committed') {
      assert.equal(recoveredWork.get(h.child.work_id).status, 'paused');
      assert.equal(recovered.records[0].document.children[0].restored_submission_sha256,
        recoveredWork.get(h.child.work_id).submission_hash);
    }
    const sessionsAgain = new ElectronSessionStore(path.join(destination, 'sessions.json'));
    t.after(() => sessionsAgain.dispose());
    const portAgain = createOfflineRuntimeArchivePort({ userDataPath: destination, sessionStore: sessionsAgain });
    const archiveAgain = await createArchive({ destinationRoot: path.join(h.root, 'archives'),
      archiveName: 'Lineage-again.jenny-archive', encrypted: false,
      entries: collectDataInventory({ userDataPath: destination, sessionStore: sessionsAgain,
        runtimeArchivePort: portAgain }).entries });
    const secondDestination = path.join(h.root, 'restored-again');
    await stageRestore({ archivePath: archiveAgain.archivePath, userDataPath: secondDestination });
    assert.equal((await promotePendingRestore({ userDataPath: secondDestination })).status, 'promoted');
    const secondLineage = new RuntimeLineageStore(path.join(secondDestination, 'session-runtime-lineage'));
    assert.equal(secondLineage.get('root_1').children[0].submission_sha256,
      before.records[0].document.children[0].submission_sha256);
    assert.equal(secondLineage.get('root_1').restored, true);
  });
}

test('schema1 archives explicitly upgrade to an empty lineage; schema2 requires it', t => {
  const h = fixture(t);
  const current = collectRuntimeCoordinationPayload(h.port);
  const { lineage: _lineage, ...legacy } = current;
  legacy.schema_version = 1;
  assert.deepEqual(validateRuntimeCoordinationPayload(legacy).lineage, { schema_version: 1, records: [] });
  assert.equal(validateRuntimeCoordinationPayload(legacy).schema_version, 2);
  assert.throws(() => validateRuntimeCoordinationPayload({ ...legacy, schema_version: 2 }),
    { reason: 'runtime_coordination_payload_invalid' });
  assert.throws(() => validateRuntimeCoordinationPayload({ ...current, schema_version: 3 }),
    { reason: 'unsupported_runtime_coordination_version' });
  assert.throws(() => validateRuntimeCoordinationPayload({ ...legacy, lineage: current.lineage }),
    { reason: 'runtime_coordination_payload_invalid' });
});

test('lineage-only state is collected and requires its owning work, budget and session', t => {
  const h = fixture(t);
  const current = collectRuntimeCoordinationPayload(h.port);
  const isolated = { ...current, root_run_budgets: { schema_version: 1, records: [] } };
  const captured = collectRuntimeCoordinationPayload({ capturePortableState: () => isolated });
  assert.equal(captured.lineage.records.length, 1);
  assert.throws(() => validateRuntimeCoordinationCrosslinks(captured, h.context()),
    { reason: 'runtime_lineage_root_crosslink_invalid' });
  assert.equal(validateRuntimeCoordinationCrosslinks(current, h.context()).lineage.records.length, 1);
  assert.throws(() => validateRuntimeCoordinationCrosslinks(current, { ...h.context(), sessions: new Map() }),
    { reason: 'runtime_lineage_root_crosslink_invalid' });
});

test('committed child work identity and submission hash must match the durable spawn', t => {
  const h = fixture(t);
  h.createChild();
  const current = collectRuntimeCoordinationPayload(h.port);
  for (const patch of [{ session_id: 'foreign' }, { project_id: 'foreign' }, { turn_id: 'foreign' },
    { submission_hash: 'd'.repeat(64) }]) {
    const context = h.context();
    const work = context.runtimeLedger.records.find(item => item.work_id === h.child.work_id);
    Object.assign(work, patch);
    assert.throws(() => validateRuntimeCoordinationCrosslinks(current, context));
  }
  const context = h.context();
  context.runtimeLedger.records = [h.rootWork];
  assert.throws(() => validateRuntimeCoordinationCrosslinks(current, context),
    { reason: 'runtime_lineage_work_proof_invalid' });
});

test('a child work published before its committed marker is preserved without adoption', t => {
  const h = fixture(t);
  h.createChild();
  const current = collectRuntimeCoordinationPayload(h.port);
  const child = current.lineage.records[0].document.children[0];
  child.state = 'session_created';
  child.submission_sha256 = null;
  assert.equal(validateRuntimeCoordinationCrosslinks(current, h.context()).lineage.records[0]
    .document.children[0].state, 'session_created');
});

test('restore failure preserves destination lineage and destination enumeration includes it', async t => {
  const h = fixture(t);
  const destination = path.join(h.root, 'restored');
  fs.mkdirSync(destination);
  const lineageRoot = path.join(destination, 'session-runtime-lineage');
  fs.mkdirSync(lineageRoot);
  fs.writeFileSync(path.join(lineageRoot, 'owner-evidence'), 'keep');
  assert.equal(runtimeCoordinationDestinations(destination).includes(lineageRoot), true);
  assert.equal(isUntouchedRuntimeCoordinationBootstrap(destination), false);
  const entries = collectDataInventory({ userDataPath: h.source, sessionStore: h.sessions,
    runtimeArchivePort: h.port }).entries.filter(entry => entry.logicalPath === 'runtime/runtime-coordination.json');
  const archive = await createArchive({ destinationRoot: path.join(h.root, 'archives'),
    archiveName: 'Missing-owner.jenny-archive', encrypted: false, entries });
  await assert.rejects(stageRestore({ archivePath: archive.archivePath, userDataPath: destination }),
    { reason: 'profile_not_fresh' });
  assert.equal(fs.readFileSync(path.join(lineageRoot, 'owner-evidence'), 'utf8'), 'keep');
});


test('retained lineage protects parent and child deletion, including unreadable evidence', async t => {
  const h = fixture(t);
  const runtime = new SessionRuntimeService({ store: h.workStore, scheduler: {}, lineageStore: h.lineage,
    chatAdapter: { prepareImmediate() {} } });
  for (const sessionId of ['sess_root', h.child.session_id]) {
    assert.equal(runtime.hasSessionWork(sessionId), true);
    assert.deepEqual(await runtime.cancelSessionAndWait(sessionId, { deletionHandle: {} }),
      { ok: false, reason: 'runtime_lineage_retained' });
  }
  h.lineage.exportPortableSnapshot = () => { throw new Error('unreadable'); };
  assert.equal(runtime.hasSessionWork('unknown_session'), true);
  assert.equal((await runtime.cancelSessionAndWait('unknown_session', { deletionHandle: {} })).ok, false);
});
