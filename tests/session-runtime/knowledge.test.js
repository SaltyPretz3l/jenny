'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { FileJsonStore } = require('../../services/backend/file-json-store');
const {
  GENERAL_PROJECT_ID,
} = require('../../services/projects/project-schema');
const {
  KnowledgeService,
} = require('../../services/knowledge-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makePaths(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-data-`));
  const rootsHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-roots-`));
  trackDirectory(userDataPath);
  trackDirectory(rootsHome);
  return { userDataPath, rootsHome, registryPath: path.join(userDataPath, 'knowledge.json') };
}

function makeFolder(rootsHome, name) {
  const folder = path.join(rootsHome, name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function makeService(userDataPath, overrides = {}) {
  return new KnowledgeService({
    userDataPath,
    featureFlagProvider: () => ({ knowledge_layer: true }),
    ...overrides,
  });
}

function writeRegistry(registryPath, value) {
  fs.writeFileSync(registryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('project scopes interleave on one monotonic registry revision', () => {
  const { userDataPath, rootsHome } = makePaths('knowledge-scopes');
  const alphaPath = makeFolder(rootsHome, 'alpha');
  const betaPath = makeFolder(rootsHome, 'beta');
  const generalPath = makeFolder(rootsHome, 'general');
  const ids = ['kbroot_alpha', 'kbroot_beta', 'kbroot_general'];
  const service = makeService(userDataPath, { idFactory: () => ids.shift() });

  const alpha = service.addFolder({
    path: alphaPath,
    projectId: 'project_alpha',
    expectedRevision: 0,
  });
  const beta = service.addFolder({
    path: betaPath,
    projectId: 'project_beta',
    expectedRevision: 1,
  });
  service.addFolder({ path: generalPath, expectedRevision: 2 });

  assert.equal(alpha.ok, true);
  assert.equal(beta.ok, true);
  assert.deepEqual(
    service.getStateSnapshot({ projectId: 'project_alpha' }).roots.map((root) => root.id),
    ['kbroot_alpha']
  );
  assert.deepEqual(
    service.getStateSnapshot({ projectId: 'project_beta' }).roots.map((root) => root.id),
    ['kbroot_beta']
  );
  assert.deepEqual(service.getStateSnapshot().roots.map((root) => root.id), ['kbroot_general']);
  assert.equal(service.getStateSnapshot({ projectId: 'project_alpha' }).revision, 3);

  assert.deepEqual(
    service.removeFolder({
      id: alpha.root.id,
      projectId: 'project_beta',
      expectedRevision: 3,
    }),
    { ok: false, reason: 'not_found' }
  );
  assert.equal(service.getStateSnapshot({ projectId: 'project_beta' }).revision, 3);
  assert.deepEqual(
    service.removeFolder({
      id: beta.root.id,
      projectId: 'project_beta',
      expectedRevision: 3,
    }),
    { ok: true }
  );
  assert.equal(service.getStateSnapshot({ projectId: 'project_alpha' }).revision, 4);
});

test('one physical folder can be registered independently in two projects', () => {
  const { userDataPath, rootsHome } = makePaths('knowledge-shared');
  const shared = makeFolder(rootsHome, 'shared');
  const ids = ['kbroot_alpha', 'kbroot_beta'];
  const service = makeService(userDataPath, { idFactory: () => ids.shift() });

  const alpha = service.addFolder({ path: shared, projectId: 'project_alpha' });
  const beta = service.addFolder({ path: shared, projectId: 'project_beta' });
  assert.equal(alpha.ok, true);
  assert.equal(beta.ok, true);
  assert.notEqual(alpha.root.id, beta.root.id);
  assert.equal(
    service.addFolder({ path: shared, projectId: 'project_alpha' }).reason,
    'duplicate'
  );
  assert.deepEqual(
    service.getSidecarConfig({ projectId: 'project_alpha' }).knowledge_roots,
    [fs.realpathSync(shared)]
  );
  assert.deepEqual(
    service.getSidecarConfig({ projectId: 'project_beta' }).knowledge_roots,
    [fs.realpathSync(shared)]
  );

  const snapshot = service.getStateSnapshot({ projectId: 'project_alpha' });
  alpha.root.label = 'mutated result';
  snapshot.roots[0].path = 'mutated';
  assert.equal(
    service.getStateSnapshot({ projectId: 'project_alpha' }).roots[0].label,
    ''
  );
  assert.equal(
    service.getStateSnapshot({ projectId: 'project_alpha' }).roots[0].path,
    fs.realpathSync(shared)
  );
});

test('schema 1 migrates legacy registrations to General once and preserves metadata', () => {
  const { userDataPath, rootsHome, registryPath } = makePaths('knowledge-migrate');
  const present = makeFolder(rootsHome, 'present');
  const disconnected = path.join(rootsHome, 'disconnected');
  const legacy = {
    schemaVersion: 1,
    roots: [
      {
        id: 'legacy_present',
        path: present,
        label: 'Project notes',
        addedAt: '2025-02-03T04:05:06.000Z',
      },
      {
        id: 'legacy_disconnected',
        path: disconnected,
        label: 'Offline drive',
        addedAt: '2024-01-02T03:04:05.000Z',
      },
    ],
  };
  writeRegistry(registryPath, legacy);

  const first = makeService(userDataPath);
  const snapshot = first.getStateSnapshot();
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.roots, [
    { ...legacy.roots[0], path: fs.realpathSync(present), project_id: GENERAL_PROJECT_ID },
    { ...legacy.roots[1], project_id: GENERAL_PROJECT_ID },
  ]);
  assert.deepEqual(first.getStateSnapshot({ projectId: 'project_alpha' }).roots, []);

  const migratedBytes = fs.readFileSync(registryPath);
  const persisted = JSON.parse(migratedBytes.toString('utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.revision, 1);
  assert.deepEqual(persisted.roots, snapshot.roots);

  const restarted = makeService(userDataPath);
  assert.deepEqual(restarted.getStateSnapshot().roots, snapshot.roots);
  assert.equal(restarted.getStateSnapshot().revision, 1);
  assert.deepEqual(fs.readFileSync(registryPath), migratedBytes);
});

test('malformed, future, incompatible current, and oversized registries are preserved read-only', async (t) => {
  const cases = [
    { name: 'malformed', bytes: Buffer.from('{ broken json'), reason: 'malformed_json' },
    {
      name: 'future',
      bytes: Buffer.from('{"schemaVersion":99,"roots":[],"future":true}'),
      reason: 'schema_too_new',
    },
    {
      name: 'unknown-current-field',
      bytes: Buffer.from('{"schemaVersion":2,"revision":4,"roots":[],"unknown":true}'),
      reason: 'invalid_schema',
    },
    {
      name: 'oversized',
      bytes: Buffer.from('x'.repeat(257)),
      reason: 'file_too_large',
      maxFileBytes: 256,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const { userDataPath, rootsHome, registryPath } = makePaths(`knowledge-${entry.name}`);
      const candidate = makeFolder(rootsHome, 'candidate');
      fs.writeFileSync(registryPath, entry.bytes);
      const service = makeService(userDataPath, { maxFileBytes: entry.maxFileBytes });
      const snapshot = service.getStateSnapshot({ projectId: 'project_alpha' });
      assert.equal(snapshot.readOnly, true);
      assert.equal(snapshot.reason, entry.reason);
      assert.deepEqual(snapshot.roots, []);
      assert.deepEqual(service.getSidecarConfig({ projectId: 'project_alpha' }), {
        tools_knowledge_enabled: false,
        knowledge_roots: [],
      });
      assert.deepEqual(
        service.addFolder({ path: candidate, projectId: 'project_alpha' }),
        { ok: false, reason: entry.reason }
      );
      assert.deepEqual(fs.readFileSync(registryPath), entry.bytes);
    });
  }
});

test('failed atomic writes do not publish mutations or emit change events', () => {
  const { userDataPath, rootsHome, registryPath } = makePaths('knowledge-write-failure');
  const firstPath = makeFolder(rootsHome, 'first');
  const secondPath = makeFolder(rootsHome, 'second');
  const diskStore = new FileJsonStore(registryPath);
  let rejectWrites = false;
  const store = {
    write(value) {
      if (rejectWrites) throw new Error('disk full');
      return diskStore.write(value);
    },
  };
  const ids = ['kbroot_first', 'kbroot_second'];
  const service = makeService(userDataPath, { store, idFactory: () => ids.shift() });
  const events = [];
  service.on('changed', (snapshot) => events.push(snapshot));
  assert.equal(service.addFolder({ path: firstPath }).ok, true);
  const durableBytes = fs.readFileSync(registryPath);
  rejectWrites = true;

  assert.throws(() => service.addFolder({ path: secondPath, expectedRevision: 1 }), /disk full/);
  assert.equal(service.getStateSnapshot().revision, 1);
  assert.deepEqual(service.getStateSnapshot().roots.map((root) => root.id), ['kbroot_first']);
  assert.deepEqual(fs.readFileSync(registryPath), durableBytes);
  assert.throws(() => service.removeFolder({ id: 'kbroot_first', expectedRevision: 1 }), /disk full/);
  assert.equal(service.getStateSnapshot().revision, 1);
  assert.equal(events.length, 1);
});

test('failed schema migration preserves legacy bytes and disables authorization', () => {
  const { userDataPath, rootsHome, registryPath } = makePaths('knowledge-migrate-failure');
  const folder = makeFolder(rootsHome, 'legacy');
  const legacyBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    roots: [{
      id: 'legacy', path: folder, label: 'Legacy', addedAt: '2025-01-01T00:00:00.000Z',
    }],
  }));
  fs.writeFileSync(registryPath, legacyBytes);
  const service = makeService(userDataPath, {
    store: { write() { throw new Error('rename failed'); } },
  });

  const snapshot = service.getStateSnapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.reason, 'migration_write_failed');
  assert.equal(snapshot.revision, 0);
  assert.deepEqual(service.getSidecarConfig(), {
    tools_knowledge_enabled: false,
    knowledge_roots: [],
  });
  assert.deepEqual(fs.readFileSync(registryPath), legacyBytes);
});

test('aggregate root and serialized byte bounds fail before publication', () => {
  const { userDataPath, rootsHome, registryPath } = makePaths('knowledge-bounds');
  const service = makeService(userDataPath, {
    maxRoots: 2,
    idFactory: (() => {
      const ids = ['kbroot_one', 'kbroot_two', 'kbroot_three'];
      return () => ids.shift();
    })(),
  });
  assert.equal(service.addFolder({ path: makeFolder(rootsHome, 'one'), projectId: 'project_a' }).ok, true);
  assert.equal(service.addFolder({ path: makeFolder(rootsHome, 'two'), projectId: 'project_b' }).ok, true);
  assert.equal(
    service.addFolder({ path: makeFolder(rootsHome, 'three'), projectId: 'project_c' }).reason,
    'limit_reached'
  );
  assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8')).roots.length, 2);

  const bounded = makePaths('knowledge-write-bound');
  const boundedService = makeService(bounded.userDataPath, { maxFileBytes: 256 });
  assert.equal(
    boundedService.addFolder({ path: makeFolder(bounded.rootsHome, 'root'), label: 'x'.repeat(512) }).reason,
    'file_too_large'
  );
  assert.equal(boundedService.getStateSnapshot().revision, 0);
  assert.equal(fs.existsSync(bounded.registryPath), false);

  const capped = makePaths('knowledge-hard-cap');
  const cappedService = makeService(capped.userDataPath, { maxRoots: 999 });
  for (let index = 0; index < 32; index += 1) {
    assert.equal(
      cappedService.addFolder({ path: makeFolder(capped.rootsHome, `root-${index}`) }).ok,
      true
    );
  }
  assert.equal(
    cappedService.addFolder({ path: makeFolder(capped.rootsHome, 'overflow') }).reason,
    'limit_reached'
  );
});

test('project IDs, global IDs, and revision CAS fail closed', () => {
  const { userDataPath, rootsHome, registryPath } = makePaths('knowledge-validation');
  const firstPath = makeFolder(rootsHome, 'first');
  const secondPath = makeFolder(rootsHome, 'second');
  const service = makeService(userDataPath, { idFactory: () => 'kbroot_fixed' });

  for (const projectId of ['', null, 'alpha', 'project_bad space', 42]) {
    assert.deepEqual(
      service.addFolder({ path: firstPath, projectId }),
      { ok: false, reason: 'invalid_project_id' }
    );
  }
  assert.equal(service.getStateSnapshot({ projectId: 'alpha' }).reason, 'invalid_project_id');
  assert.deepEqual(service.getSidecarConfig({ projectId: 'alpha' }), {
    tools_knowledge_enabled: false,
    knowledge_roots: [],
  });
  assert.equal(fs.existsSync(registryPath), false);

  for (const expectedRevision of ['0', 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      service.addFolder({ path: firstPath, expectedRevision }).reason,
      'invalid_expected_revision'
    );
  }
  const added = service.addFolder({ path: firstPath, expectedRevision: 0 });
  assert.equal(added.ok, true);
  const durableBytes = fs.readFileSync(registryPath);
  assert.deepEqual(
    service.addFolder({ path: secondPath, projectId: 'project_beta', expectedRevision: 0 }),
    { ok: false, reason: 'stale_revision', current_revision: 1 }
  );
  assert.deepEqual(fs.readFileSync(registryPath), durableBytes);
  assert.deepEqual(
    service.addFolder({ path: secondPath, projectId: 'project_beta', expectedRevision: 1 }),
    { ok: false, reason: 'id_conflict' }
  );
  assert.deepEqual(
    service.removeFolder({ id: added.root.id, expectedRevision: '1' }),
    { ok: false, reason: 'invalid_expected_revision' }
  );
});

test('feature-off construction and API calls perform no registry filesystem IO', () => {
  const { userDataPath } = makePaths('knowledge-feature-off');
  const touched = [];
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (['statSync', 'readFileSync', 'mkdirSync', 'writeFileSync', 'renameSync'].includes(property)) {
        return () => {
          touched.push(property);
          throw new Error(`unexpected ${property}`);
        };
      }
      return target[property];
    },
  });
  const service = new KnowledgeService({
    userDataPath,
    fsImpl,
    featureFlagProvider: () => ({ knowledge_layer: false }),
  });

  assert.equal(service.getStateSnapshot().enabled, false);
  assert.deepEqual(service.getSidecarConfig(), {
    tools_knowledge_enabled: false,
    knowledge_roots: [],
  });
  assert.equal(service.addFolder({ path: userDataPath }).reason, 'feature_disabled');
  assert.equal(service.removeFolder({ id: 'kbroot_any' }).reason, 'feature_disabled');
  assert.deepEqual(touched, []);
});
