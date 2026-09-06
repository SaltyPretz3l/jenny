const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { KnowledgeService } = require('../services/knowledge-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeTempDirs(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-data-`));
  const rootsHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-roots-`));
  trackDirectory(userDataPath);
  trackDirectory(rootsHome);
  return { userDataPath, rootsHome };
}

function makeService(userDataPath, { enabled = true, ...overrides } = {}) {
  return new KnowledgeService({
    userDataPath,
    featureFlagProvider: () => ({ knowledge_layer: enabled === true }),
    ...overrides,
  });
}

function knowledgePath(userDataPath) {
  return path.join(userDataPath, 'knowledge.json');
}

test('addFolder persists a root and a new instance reflects it', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-roundtrip');
  const folder = path.join(rootsHome, 'project-x');
  fs.mkdirSync(folder, { recursive: true });

  const service = makeService(userDataPath);
  const result = service.addFolder({ path: folder, label: 'Project X docs' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.root.id, /^kbroot_/);
  assert.equal(result.root.label, 'Project X docs');
  assert.ok(fs.existsSync(knowledgePath(userDataPath)), 'knowledge.json must be written on first add');

  const persisted = JSON.parse(fs.readFileSync(knowledgePath(userDataPath), 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.roots.length, 1);
  assert.equal(fs.realpathSync(persisted.roots[0].path), fs.realpathSync(folder));

  const reloaded = makeService(userDataPath);
  const snapshot = reloaded.getStateSnapshot();
  assert.equal(snapshot.roots.length, 1);
  assert.equal(snapshot.roots[0].label, 'Project X docs');
  assert.equal(snapshot.enabled, true);
});

test('addFolder rejects a sensitive path with a structured reason', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-sensitive');
  const sshDir = path.join(rootsHome, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });

  const service = makeService(userDataPath);
  const result = service.addFolder({ path: sshDir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sensitive_path');
  assert.equal(fs.existsSync(knowledgePath(userDataPath)), false, 'a rejected add must not create knowledge.json');
});

test('addFolder rejects a non-directory, a nonexistent path, and a duplicate', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-invalid');
  const filePath = path.join(rootsHome, 'a-file.txt');
  fs.writeFileSync(filePath, 'not a dir', 'utf8');
  const missing = path.join(rootsHome, 'does-not-exist');
  const good = path.join(rootsHome, 'good');
  fs.mkdirSync(good, { recursive: true });

  const service = makeService(userDataPath);
  assert.equal(service.addFolder({ path: filePath }).reason, 'not_a_directory');
  assert.equal(service.addFolder({ path: missing }).reason, 'not_found');
  assert.equal(service.addFolder({ path: '' }).reason, 'invalid_path');
  assert.equal(service.addFolder({ path: 'relative/path' }).reason, 'invalid_path');

  assert.equal(service.addFolder({ path: good }).ok, true);
  const dup = service.addFolder({ path: good });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate');
});

test('addFolder enforces the MAX_ROOTS cap with a structured reason', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-cap');
  const service = makeService(userDataPath, { maxRoots: 3 });
  for (let index = 0; index < 3; index += 1) {
    const folder = path.join(rootsHome, `r${index}`);
    fs.mkdirSync(folder, { recursive: true });
    assert.equal(service.addFolder({ path: folder }).ok, true);
  }
  const overflow = path.join(rootsHome, 'overflow');
  fs.mkdirSync(overflow, { recursive: true });
  const result = service.addFolder({ path: overflow });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'limit_reached');
});

test('removeFolder removes by id and reports not_found for an unknown id', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-remove');
  const folder = path.join(rootsHome, 'removable');
  fs.mkdirSync(folder, { recursive: true });
  const service = makeService(userDataPath);
  const added = service.addFolder({ path: folder });
  assert.equal(added.ok, true);

  assert.equal(service.removeFolder({ id: 'kbroot_unknown' }).ok, false);
  assert.equal(service.removeFolder({ id: 'kbroot_unknown' }).reason, 'not_found');

  const removed = service.removeFolder({ id: added.root.id });
  assert.equal(removed.ok, true);
  assert.equal(service.getStateSnapshot().roots.length, 0);
});

test('unknown future schemaVersion loads empty without crashing', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-future');
  fs.writeFileSync(
    knowledgePath(userDataPath),
    JSON.stringify({ schemaVersion: 999, roots: [{ id: 'kbroot_x', path: rootsHome }] }),
    'utf8'
  );
  const warnings = [];
  const service = makeService(userDataPath, {
    logger: (level, event) => warnings.push([level, event]),
  });
  assert.equal(service.getStateSnapshot().roots.length, 0);
  assert.ok(warnings.some(([level]) => level === 'WARN'), 'a structured warning must be emitted');
});

test('future schema stays read-only and preserves the original bytes', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-future-read-only');
  const folder = path.join(rootsHome, 'new-root');
  fs.mkdirSync(folder, { recursive: true });
  const original = Buffer.from(
    `{\n  "schemaVersion": 999,\n  "futureField": true,\n  "roots": []\n}\n`,
    'utf8'
  );
  fs.writeFileSync(knowledgePath(userDataPath), original);
  const service = makeService(userDataPath);

  assert.deepEqual(service.addFolder({ path: folder }), { ok: false, reason: 'schema_too_new' });
  assert.deepEqual(service.removeFolder({ id: 'kbroot_future' }), { ok: false, reason: 'schema_too_new' });
  assert.deepEqual(fs.readFileSync(knowledgePath(userDataPath)), original);
});

test('persisted roots are validated independently and capped before publication', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-loaded-validation');
  const first = path.join(rootsHome, 'first');
  const second = path.join(rootsHome, 'second');
  const overflow = path.join(rootsHome, 'overflow');
  const sensitive = path.join(rootsHome, '.ssh');
  const filePath = path.join(rootsHome, 'file.txt');
  for (const folder of [first, second, overflow, sensitive]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  fs.writeFileSync(filePath, 'not a directory', 'utf8');
  fs.writeFileSync(knowledgePath(userDataPath), JSON.stringify({
    schemaVersion: 1,
    roots: [
      { id: 'relative', path: 'relative/path' },
      { id: 'first', path: path.join(first, '.') },
      { id: 'file', path: filePath },
      { id: 'second', path: second },
      { id: 'duplicate', path: first },
      { id: 'sensitive', path: sensitive },
      { id: 'overflow', path: overflow },
    ],
  }), 'utf8');
  const warnings = [];
  const service = makeService(userDataPath, {
    maxRoots: 2,
    logger: (level, event, details) => warnings.push({ level, event, details }),
  });

  assert.deepEqual(
    service.getStateSnapshot().roots.map((root) => ({ id: root.id, path: root.path })),
    [
      { id: 'first', path: fs.realpathSync(first) },
      { id: 'second', path: fs.realpathSync(second) },
    ]
  );
  assert.deepEqual(
    warnings.map((entry) => [entry.level, entry.event, entry.details.reason]),
    [
      ['WARN', 'knowledge.persisted_root_rejected', 'invalid_path'],
      ['WARN', 'knowledge.persisted_root_rejected', 'not_a_directory'],
      ['WARN', 'knowledge.persisted_root_rejected', 'duplicate'],
      ['WARN', 'knowledge.persisted_root_rejected', 'sensitive_path'],
      ['WARN', 'knowledge.persisted_root_rejected', 'limit_reached'],
    ]
  );
  assert.deepEqual(service.getSidecarConfig().knowledge_roots, [
    fs.realpathSync(first),
    fs.realpathSync(second),
  ]);
});

test('a persisted root whose path is currently missing is kept, not pruned', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-offline-root');
  const present = path.join(rootsHome, 'present');
  fs.mkdirSync(present, { recursive: true });
  const offline = path.join(rootsHome, 'unplugged-drive');
  fs.writeFileSync(knowledgePath(userDataPath), JSON.stringify({
    schemaVersion: 1,
    roots: [{ id: 'offline', path: offline }, { id: 'present', path: present }],
  }), 'utf8');
  const service = makeService(userDataPath);

  assert.deepEqual(service.getStateSnapshot().roots.map((root) => root.id), ['offline', 'present']);
  assert.equal(service.removeFolder({ id: 'present' }).ok, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(knowledgePath(userDataPath), 'utf8')).roots.map((root) => root.id),
    ['offline']
  );
});

test('failed persistence retains the prior roots and emits no change', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-persist-failure');
  const first = path.join(rootsHome, 'first');
  const second = path.join(rootsHome, 'second');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  let rejectWrites = false;
  const fsImpl = {
    ...fs,
    writeFileSync(...args) {
      if (rejectWrites) {
        throw new Error('disk full');
      }
      return fs.writeFileSync(...args);
    },
  };
  const service = makeService(userDataPath, { fsImpl });
  const events = [];
  service.on('changed', (snapshot) => events.push(snapshot));
  const added = service.addFolder({ path: first });
  rejectWrites = true;

  assert.throws(() => service.addFolder({ path: second }), /disk full/);
  assert.deepEqual(service.getStateSnapshot().roots.map((root) => root.id), [added.root.id]);
  assert.throws(() => service.removeFolder({ id: added.root.id }), /disk full/);
  assert.deepEqual(service.getStateSnapshot().roots.map((root) => root.id), [added.root.id]);
  assert.equal(events.length, 1);
});

test('corrupt JSON loads empty without crashing', () => {
  const { userDataPath } = makeTempDirs('jenny-knowledge-corrupt');
  fs.writeFileSync(knowledgePath(userDataPath), '{ this is : not valid json', 'utf8');
  const service = makeService(userDataPath);
  assert.equal(service.getStateSnapshot().roots.length, 0);
});

test('getSidecarConfig: flag on with roots publishes realpaths and enabled=true', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-sidecar-on');
  const folder = path.join(rootsHome, 'docs');
  fs.mkdirSync(folder, { recursive: true });
  const service = makeService(userDataPath, { enabled: true });
  service.addFolder({ path: folder });

  const config = service.getSidecarConfig();
  assert.equal(config.tools_knowledge_enabled, true);
  assert.equal(config.knowledge_roots.length, 1);
  assert.equal(fs.realpathSync(config.knowledge_roots[0]), fs.realpathSync(folder));
});

test('getSidecarConfig: flag on with no roots is false and empty', () => {
  const { userDataPath } = makeTempDirs('jenny-knowledge-sidecar-empty');
  const service = makeService(userDataPath, { enabled: true });
  const config = service.getSidecarConfig();
  assert.equal(config.tools_knowledge_enabled, false);
  assert.deepEqual(config.knowledge_roots, []);
});

test('flag off: the service is inert and never writes knowledge.json', () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-off');
  const folder = path.join(rootsHome, 'docs');
  fs.mkdirSync(folder, { recursive: true });
  const service = makeService(userDataPath, { enabled: false });

  const add = service.addFolder({ path: folder });
  assert.equal(add.ok, false);
  assert.equal(add.reason, 'feature_disabled');
  assert.equal(service.removeFolder({ id: 'kbroot_x' }).reason, 'feature_disabled');

  const snapshot = service.getStateSnapshot();
  assert.deepEqual(snapshot.roots, []);
  assert.equal(snapshot.enabled, false);

  const config = service.getSidecarConfig();
  assert.equal(config.tools_knowledge_enabled, false);
  assert.deepEqual(config.knowledge_roots, []);

  assert.equal(fs.existsSync(knowledgePath(userDataPath)), false, 'flag-off must never create knowledge.json');
});

test("emits 'changed' with a snapshot and reason after add/remove", () => {
  const { userDataPath, rootsHome } = makeTempDirs('jenny-knowledge-events');
  const folder = path.join(rootsHome, 'docs');
  fs.mkdirSync(folder, { recursive: true });
  const service = makeService(userDataPath);
  const events = [];
  service.on('changed', (snapshot, context) => events.push({ snapshot, context }));

  const added = service.addFolder({ path: folder });
  assert.equal(events.length, 1);
  assert.equal(events[0].context.reason, 'knowledge_root_added');
  assert.equal(events[0].snapshot.roots.length, 1);

  service.removeFolder({ id: added.root.id });
  assert.equal(events.length, 2);
  assert.equal(events[1].context.reason, 'knowledge_root_removed');
  assert.equal(events[1].snapshot.roots.length, 0);
});
