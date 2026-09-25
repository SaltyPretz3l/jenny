'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { evaluatePolicy } = require('../../services/tools/tool-policy-evaluator');
const {
  createEmptyPermissionDocument,
  sanitizePermissionDocumentForImport,
  TOOL_PERMISSION_SCHEMA_VERSION,
  validatePermissionDocument,
} = require('../../services/tools/tool-permission-migrations');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

const AUTHORITY_A = Object.freeze({
  project_id: 'project_alpha',
  root_path: 'G:\\workspaces\\shared',
  root_id: 'root_shared',
  root_revision: 4,
  device_id: '11',
  inode: '101',
});
const AUTHORITY_B = Object.freeze({ ...AUTHORITY_A, project_id: 'project_beta' });
const UNBOUND_AUTHORITY = Object.freeze({
  project_id: 'project_general',
  root_path: null,
  root_id: null,
  root_revision: 0,
  device_id: null,
  inode: null,
});
const WRITE_DESCRIPTOR = Object.freeze({
  name: 'write_file',
  read_only: false,
  side_effecting: true,
  tool_family: 'filesystem',
  source_kind: 'builtin',
});

function tempStorePath(prefix = 'jenny-permission-runtime-') {
  return path.join(createTrackedTempDir(prefix), 'tool-permissions.json');
}

function decision(store, authority, target = 'docs/a.md') {
  return evaluatePolicy({
    descriptor: WRITE_DESCRIPTOR,
    args: { path: target },
    snapshot: store.getSnapshot(authority),
  });
}

function writeLegacy(filePath, document) {
  const bytes = JSON.stringify(document);
  fs.writeFileSync(filePath, bytes, 'utf8');
  return bytes;
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('inline-v1 migration preserves policy version and is durable and idempotent', () => {
  const filePath = tempStorePath();
  writeLegacy(filePath, {
    schema_version: 1,
    version: 3,
    legacy_policies: { run_command: 'deny', edit_file: 'ask', write_file: 'auto' },
    rules: [
      { id: 'deny-prod', decision: 'deny', reason: 'blocked', match: { path_prefix: 'prod/' } },
      {
        id: 'allow-docs', decision: 'auto', reason: 'old grant',
        match: { tool_id: 'write_file', path_prefix: 'docs/' },
      },
    ],
  });

  const first = new ToolPermissionStore(filePath);
  const migratedBytes = fs.readFileSync(filePath, 'utf8');
  const persisted = JSON.parse(migratedBytes);
  assert.equal(persisted.schema_version, TOOL_PERMISSION_SCHEMA_VERSION);
  assert.equal(persisted.version, 3);
  assert.deepEqual(persisted.legacy_policies, { run_command: 'deny', edit_file: 'ask' });
  assert.deepEqual(persisted.rules.map((rule) => rule.id), ['deny-prod']);
  assert.equal(first.getReviewState().pending_count, 2);
  assert.notEqual(decision(first, AUTHORITY_A).decision, 'auto');

  const reopened = new ToolPermissionStore(filePath);
  assert.equal(fs.readFileSync(filePath, 'utf8'), migratedBytes);
  assert.equal(reopened.getReviewState().pending_count, 2);
});

test('legacy flat-map auto decisions become review records including read-only tools', () => {
  const filePath = tempStorePath();
  writeLegacy(filePath, { read_file: 'auto', write_file: 'auto', run_command: 'deny' });

  const store = new ToolPermissionStore(filePath);
  assert.deepEqual(store.getSnapshot().legacy_policies, { run_command: 'deny' });
  assert.deepEqual(
    store.getReviewState().pending.map((record) => record.tool_name).sort(),
    ['read_file', 'write_file']
  );
  assert.equal(store.getSnapshot().rules.some((rule) => rule.decision === 'auto'), false);
});

test('scoped grants separate projects even when they share one physical root', () => {
  const filePath = tempStorePath();
  const store = new ToolPermissionStore(filePath);
  store.grantAlwaysAllow('write_file', { path: 'docs/' }, AUTHORITY_A);

  assert.equal(decision(store, AUTHORITY_A).decision, 'auto');
  assert.notEqual(decision(store, AUTHORITY_B).decision, 'auto');
  const reopened = new ToolPermissionStore(filePath);
  assert.equal(decision(reopened, AUTHORITY_A).decision, 'auto');
  assert.notEqual(decision(reopened, AUTHORITY_B).decision, 'auto');
});

test('root revision and physical identity changes invalidate scoped grants', () => {
  const store = new ToolPermissionStore(tempStorePath());
  store.grantAlwaysAllow('write_file', { path: 'docs/' }, AUTHORITY_A);
  const changedAuthorities = [
    { ...AUTHORITY_A, root_revision: AUTHORITY_A.root_revision + 1 },
    { ...AUTHORITY_A, root_path: 'G:\\workspaces\\replaced' },
    { ...AUTHORITY_A, root_id: 'root_replaced' },
    { ...AUTHORITY_A, device_id: '12' },
    { ...AUTHORITY_A, inode: '102' },
  ];
  for (const authority of changedAuthorities) {
    assert.notEqual(decision(store, authority).decision, 'auto');
  }
});

test('unbound conversation authority supports scoped whole-tool grants', () => {
  const store = new ToolPermissionStore(tempStorePath());
  store.grantAlwaysAllow('write_file', {}, UNBOUND_AUTHORITY);

  assert.equal(decision(store, UNBOUND_AUTHORITY, 'anywhere.txt').decision, 'auto');
  assert.notEqual(
    decision(store, { ...UNBOUND_AUTHORITY, root_revision: 1 }, 'anywhere.txt').decision,
    'auto'
  );
});

test('bound roots may use path identity when physical identifiers are unavailable', () => {
  const fallbackAuthority = Object.freeze({
    ...AUTHORITY_A,
    device_id: null,
    inode: null,
  });
  const store = new ToolPermissionStore(tempStorePath());
  store.setPolicy('write_file', 'auto', fallbackAuthority);

  assert.equal(decision(store, fallbackAuthority).decision, 'auto');
  assert.notEqual(decision(store, AUTHORITY_A).decision, 'auto');
});

test('malformed explicit authority fails closed instead of omitting scope checks', () => {
  const store = new ToolPermissionStore(tempStorePath());
  store.grantAlwaysAllow('write_file', {}, AUTHORITY_A);
  const snapshot = store.getSnapshot({ ...AUTHORITY_A, inode: null });
  const result = evaluatePolicy({ descriptor: WRITE_DESCRIPTOR, snapshot });

  assert.equal(result.decision, 'deny');
  assert.equal(result.matched_rule_id, 'permission-store-unavailable');
});

test('pending auto review requires scope and repeated resolution is idempotent', () => {
  const filePath = tempStorePath();
  writeLegacy(filePath, { write_file: 'auto' });
  const store = new ToolPermissionStore(filePath);
  const pending = store.getReviewState().pending[0];

  assert.throws(
    () => store.resolvePendingReview(pending.id, { decision: 'auto' }),
    (error) => error.code === 'permission_scope_required'
  );
  assert.equal(store.getReviewState().pending_count, 1);
  const resolved = store.resolvePendingReview(
    pending.id,
    { decision: 'auto', authority: AUTHORITY_A }
  );
  assert.equal(resolved.resolved, true);
  assert.equal(decision(store, AUTHORITY_A).decision, 'auto');
  assert.notEqual(decision(store, AUTHORITY_B).decision, 'auto');

  const repeated = store.resolvePendingReview(
    pending.id,
    { decision: 'auto', authority: AUTHORITY_A }
  );
  assert.equal(repeated.resolved, false);
  assert.equal(repeated.reason, 'already_resolved');
  assert.equal(store.getReviewState().history.length, 1);
});

test('reviewed auto rules preserve every original match constraint', () => {
  const filePath = tempStorePath();
  const originalMatch = {
    tool_id: 'worktree',
    action: 'list',
    tool_family: 'workspace',
    source_kind: 'builtin',
    mode: ['agent'],
    path_prefix: 'roots/two  spaces/',
    mcp_server: 'workspace-server',
  };
  writeLegacy(filePath, {
    schema_version: 1,
    version: 3,
    legacy_policies: {},
    rules: [{ id: 'old-auto', decision: 'auto', reason: 'review me', match: originalMatch }],
  });
  const store = new ToolPermissionStore(filePath);
  const pending = store.getReviewState().pending[0];
  store.resolvePendingReview(pending.id, { decision: 'auto', authority: AUTHORITY_A });

  const storedGrant = store.listStoredDecisions().scoped_grants[0];
  assert.deepEqual(storedGrant.match, originalMatch);
  const evaluate = (overrides = {}) => evaluatePolicy({
    descriptor: {
      name: 'worktree', side_effecting: true, read_only: false,
      tool_family: overrides.tool_family || 'workspace',
      source_kind: overrides.source_kind || 'builtin',
      server_name: overrides.server_name || 'workspace-server',
    },
    args: {
      action: overrides.action || 'list',
      path: overrides.path || 'roots/two  spaces/a',
    },
    mode: overrides.mode || 'agent',
    snapshot: store.getSnapshot(AUTHORITY_A),
  }).decision;
  assert.equal(evaluate(), 'auto');
  for (const mismatch of [
    { action: 'delete' },
    { tool_family: 'filesystem' },
    { source_kind: 'mcp' },
    { server_name: 'other-server' },
    { mode: 'chat' },
    { path: 'roots/two spaces/a' },
  ]) {
    assert.notEqual(evaluate(mismatch), 'auto');
  }
});

test('composite grants and synthetic denials split tool and action for evaluation', () => {
  const store = new ToolPermissionStore(tempStorePath());
  store.setPolicy('lsp:hover', 'deny');
  store.grantAlwaysAllow('lsp:definition', {}, AUTHORITY_A);
  const descriptor = { name: 'lsp', side_effecting: true, read_only: false };

  const hover = evaluatePolicy({
    descriptor, args: { action: 'hover' }, snapshot: store.getSnapshot(AUTHORITY_A),
  });
  const definition = evaluatePolicy({
    descriptor, args: { action: 'definition' }, snapshot: store.getSnapshot(AUTHORITY_A),
  });
  const references = evaluatePolicy({
    descriptor, args: { action: 'references' }, snapshot: store.getSnapshot(AUTHORITY_A),
  });
  assert.equal(hover.decision, 'deny');
  assert.equal(hover.matched_rule_id, 'legacy_deny:lsp:hover');
  assert.equal(definition.decision, 'auto');
  assert.notEqual(references.decision, 'auto');
  assert.notEqual(references.decision, 'deny');
});

test('repeated-space path grants preserve identity across durable roundtrip', () => {
  const filePath = tempStorePath();
  const store = new ToolPermissionStore(filePath);
  store.grantAlwaysAllow('write_file', { path: 'docs/two  spaces/' }, AUTHORITY_A);
  const reopened = new ToolPermissionStore(filePath);

  assert.equal(
    reopened.listStoredDecisions().scoped_grants[0].match.path_prefix,
    'docs/two  spaces/'
  );
  assert.equal(decision(reopened, AUTHORITY_A, 'docs/two  spaces/a.md').decision, 'auto');
  assert.notEqual(decision(reopened, AUTHORITY_A, 'docs/two spaces/a.md').decision, 'auto');
});

test('dismissal records history and never creates an execution grant', () => {
  const filePath = tempStorePath();
  writeLegacy(filePath, { write_file: 'auto' });
  const store = new ToolPermissionStore(filePath);
  const pending = store.getReviewState().pending[0];

  const result = store.resolvePendingReview(pending.id, { decision: 'dismiss' });
  assert.equal(result.resolved, true);
  assert.equal(store.listStoredDecisions().scoped_grants.length, 0);
  assert.notEqual(decision(store, AUTHORITY_A).decision, 'auto');
  assert.equal(store.getReviewState().history[0].decision, 'dismiss');
});

test('deny resolution remains global and outranks a later scoped allow', () => {
  const filePath = tempStorePath();
  writeLegacy(filePath, { write_file: 'auto' });
  const store = new ToolPermissionStore(filePath);
  const pending = store.getReviewState().pending[0];
  store.resolvePendingReview(pending.id, { decision: 'deny' });
  store.grantAlwaysAllow('write_file', {}, AUTHORITY_A);

  assert.equal(decision(store, AUTHORITY_A).decision, 'deny');
  assert.equal(decision(store, AUTHORITY_B).decision, 'deny');
});

test('failed durable write does not publish a scoped grant in memory', () => {
  const filePath = tempStorePath();
  const store = new ToolPermissionStore(filePath);
  const before = fs.readFileSync(filePath, 'utf8');
  store._store.write = () => { throw new Error('disk full'); };

  assert.throws(
    () => store.grantAlwaysAllow('write_file', {}, AUTHORITY_A),
    /disk full/
  );
  assert.equal(store.listStoredDecisions().scoped_grants.length, 0);
  assert.notEqual(decision(store, AUTHORITY_A).decision, 'auto');
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('malformed, unknown-field, and future documents preserve bytes and deny all', () => {
  const cases = [
    { name: 'malformed', document: { version: 3, legacy_policies: {}, rules: 'bad' } },
    {
      name: 'unknown',
      document: { ...createEmptyPermissionDocument(), unexpected: { grant: 'auto' } },
    },
    { name: 'future', document: { schema_version: 99, opaque: { keep: true } } },
  ];
  for (const item of cases) {
    const filePath = tempStorePath(`jenny-permission-${item.name}-`);
    const original = writeLegacy(filePath, item.document);
    const store = new ToolPermissionStore(filePath);
    const result = evaluatePolicy({ descriptor: WRITE_DESCRIPTOR, snapshot: store.getSnapshot() });

    assert.equal(store.getReviewState().read_only, true, item.name);
    assert.equal(result.decision, 'deny', item.name);
    assert.equal(result.matched_rule_id, 'permission-store-unavailable', item.name);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original, item.name);
    assert.throws(
      () => store.setPolicy('write_file', 'ask'),
      (error) => error.code === 'permission_store_read_only'
    );
  }
});

test('over-limit legacy input is frozen without truncating original grants', () => {
  const filePath = tempStorePath();
  const policies = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, index) => [`tool_${index}`, 'auto'])
  );
  const original = writeLegacy(filePath, policies);
  const store = new ToolPermissionStore(filePath);

  assert.equal(store.getReviewState().read_only_reason, 'invalid_legacy_flatmap');
  assert.equal(store.getReviewState().pending_count, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
});

test('aggregate rule capacity rejects a new scoped grant before persistence', () => {
  const filePath = tempStorePath();
  const document = createEmptyPermissionDocument();
  document.legacy_policies.run_command = 'deny';
  document.rules = Array.from({ length: 999 }, (_, index) => ({
    id: `ask-${index}`,
    decision: 'ask',
    reason: 'bounded rule',
    match: { tool_id: `tool_${index}` },
  }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
  const store = new ToolPermissionStore(filePath);
  const before = fs.readFileSync(filePath, 'utf8');

  assert.throws(
    () => store.grantAlwaysAllow('write_file', {}, AUTHORITY_A),
    (error) => error.code === 'permission_capacity_exceeded'
  );
  assert.equal(store.listStoredDecisions().scoped_grants.length, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('over-capacity loaded projection is preserved and evaluated fail closed', () => {
  const filePath = tempStorePath();
  const document = createEmptyPermissionDocument();
  document.legacy_policies.run_command = 'deny';
  document.rules = Array.from({ length: 1_000 }, (_, index) => ({
    id: `ask-${index}`,
    decision: 'ask',
    reason: 'bounded rule',
    match: { tool_id: `tool_${index}` },
  }));
  const original = writeLegacy(filePath, document);
  const store = new ToolPermissionStore(filePath);

  assert.equal(store.getReviewState().read_only_reason, 'aggregate_rule_capacity_exceeded');
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.equal(
    evaluatePolicy({ descriptor: WRITE_DESCRIPTOR, snapshot: store.getSnapshot() }).decision,
    'deny'
  );
});

test('the 1001st global policy is rejected without publication', () => {
  const filePath = tempStorePath();
  const document = createEmptyPermissionDocument();
  document.legacy_policies = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [`tool_${index}`, 'ask'])
  );
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
  const store = new ToolPermissionStore(filePath);
  const before = fs.readFileSync(filePath, 'utf8');

  assert.throws(
    () => store.setPolicy('tool_overflow', 'ask'),
    (error) => error.code === 'permission_capacity_exceeded'
  );
  assert.equal(store.getPolicy('tool_overflow'), undefined);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('oversized serialized input is rejected before JSON parsing and preserved', () => {
  const filePath = tempStorePath();
  const original = `{"padding":"${'x'.repeat(4 * 1024 * 1024)}"}`;
  fs.writeFileSync(filePath, original, 'utf8');
  const store = new ToolPermissionStore(filePath);

  assert.equal(store.getReviewState().read_only_reason, 'document_too_large');
  assert.equal(fs.statSync(filePath).size, Buffer.byteLength(original));
  assert.equal(
    evaluatePolicy({ descriptor: WRITE_DESCRIPTOR, snapshot: store.getSnapshot() }).decision,
    'deny'
  );
});

test('schema validator keeps storage schema independent from evaluator version', () => {
  const document = createEmptyPermissionDocument();
  document.version = 3;
  const validation = validatePermissionDocument(document);
  assert.equal(validation.ok, true);
  assert.equal(validation.document.schema_version, 2);
  assert.equal(validation.document.version, 3);
});

test('mutations preserve compatible migration metadata', () => {
  const filePath = tempStorePath();
  const document = createEmptyPermissionDocument();
  document.version = 3;
  document.migration.owner_note = 'preserve this compatible metadata';
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
  const store = new ToolPermissionStore(filePath);

  store.setPolicy('run_command', 'deny');
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.version, 3);
  assert.equal(persisted.migration.owner_note, 'preserve this compatible metadata');
});

test('import sanitization preserves denials and sends every auto grant to review', () => {
  const legacy = sanitizePermissionDocumentForImport({
    version: 3,
    legacy_policies: { run_command: 'deny', write_file: 'auto' },
    rules: [
      { id: 'allow-docs', decision: 'auto', reason: 'old', match: { path_prefix: 'docs/' } },
      { id: 'deny-prod', decision: 'deny', reason: 'block', match: { path_prefix: 'prod/' } },
    ],
  });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.document.legacy_policies, { run_command: 'deny' });
  assert.deepEqual(legacy.document.rules.map((rule) => rule.id), ['deny-prod']);
  assert.equal(legacy.document.scoped_grants.length, 0);
  assert.equal(legacy.document.pending_review.length, 2);
  assert.ok(legacy.document.pending_review.every((record) => record.source === 'import'));

  const currentPath = tempStorePath();
  const store = new ToolPermissionStore(currentPath);
  store.grantAlwaysAllow('write_file', {}, AUTHORITY_A);
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const sanitized = sanitizePermissionDocumentForImport(current);
  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.document.scoped_grants.length, 0);
  assert.equal(sanitized.document.pending_review.length, 1);
  assert.equal(sanitized.document.pending_review[0].original_kind, 'scoped_grant');
});

test('import sanitization preserves bounded inert review history', () => {
  const sanitized = sanitizePermissionDocumentForImport({
    schema_version: 1,
    version: 3,
    legacy_policies: { browser_open: 'auto' },
    rules: [],
  });
  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.document.review_history.length, 1);
  assert.equal(sanitized.document.review_history[0].decision, 'retired');
  assert.deepEqual(sanitized.document.scoped_grants, []);
});
