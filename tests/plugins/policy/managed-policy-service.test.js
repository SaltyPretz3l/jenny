'use strict';

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeededFacade } = require('../../helpers/plugins/memory-fs-facade');
const {
  createManagedPolicyService,
  createManagedInstallValidator,
} = require('../../../services/plugins/policy/managed-policy-service');
const { signedBundle, NOW } = require('../../helpers/plugins/managed-policy-bundle-fixture');

function create(source, facade, now = NOW) {
  return createManagedPolicyService({
    source: { read: async () => source.current },
    facade,
    now: () => now,
    pollIntervalMs: 0,
  });
}

test('missing policy preserves unmanaged local defaults', async () => {
  const facade = await createSeededFacade();
  const source = { current: { status: 'missing' } };
  const service = create(source, facade);
  assert.equal(service.guard().reason, 'managed_policy_loading');
  assert.equal((await service.initialize()).ok, true);
  assert.equal(service.guard().ok, true);
  assert.deepEqual(service.status(), {
    status: 'unmanaged', reason: 'managed_policy_absent', revision: 0,
    source_revision: 0, policy_digest: null, source_kind: null,
    source_fingerprint: null, privileged_execution: 'allow',
    installation: 'allow_inactive', update_ring: 'stable', allowed_source_kinds: [],
    allowed_publishers: [], require_sbom: false, require_build_provenance: false,
    managed_source_fingerprints: [], audit_max_entries: 1000,
    managed: false,
  });
});

test('valid deny advances revision and malformed present policy fails only privilege closed', async () => {
  const facade = await createSeededFacade();
  const source = { current: { status: 'present', bytes: signedBundle(),
    source_kind: 'windows_machine_policy', source_fingerprint: 'c'.repeat(64) } };
  const service = create(source, facade);
  const changes = [];
  service.subscribe((change) => changes.push(change));
  await service.initialize();
  assert.equal(service.status().revision, 1);
  assert.equal(service.guard().reason, 'managed_policy_privileged_denied');
  const token = service.capture();
  source.current = { status: 'invalid', reason: 'managed_policy_source_partial' };
  await service.refresh();
  assert.equal(service.status().status, 'blocked');
  assert.equal(service.guard(token).reason, 'managed_policy_authority_stale');
  assert.equal(changes.length, 2);
});

test('downgrade and equal-revision equivocation remain denied across restart', async () => {
  const facade = await createSeededFacade();
  const source = { current: { status: 'present', bytes: signedBundle({ revision: 5 }),
    source_kind: 'macos_managed_preferences', source_fingerprint: 'd'.repeat(64) } };
  const first = create(source, facade);
  await first.initialize();
  assert.equal(first.status().source_revision, 5);
  source.current = { ...source.current, bytes: signedBundle({ revision: 4 }) };
  const restarted = create(source, facade);
  await restarted.initialize();
  assert.equal(restarted.status().reason, 'managed_policy_downgrade_blocked');
  source.current = { ...source.current, bytes: signedBundle({ revision: 5, update_ring: 'preview' }) };
  await restarted.refresh();
  assert.equal(restarted.status().reason, 'managed_policy_equivocation_blocked');
});

test('removal returns to unmanaged while retaining source high-water', async () => {
  const facade = await createSeededFacade();
  const source = { current: { status: 'present', bytes: signedBundle({ revision: 2, privileged_execution: 'allow' }),
    source_kind: 'linux_root_file', source_fingerprint: 'e'.repeat(64) } };
  const service = create(source, facade);
  await service.initialize();
  const activeRevision = service.status().revision;
  source.current = { status: 'missing' };
  await service.refresh();
  assert.equal(service.status().status, 'unmanaged');
  assert.equal(service.status().source_revision, 2);
  assert.equal(service.status().revision, activeRevision + 1);
  source.current = { status: 'present', bytes: signedBundle({ revision: 1 }),
    source_kind: 'linux_root_file', source_fingerprint: 'e'.repeat(64) };
  await service.refresh();
  assert.equal(service.status().reason, 'managed_policy_downgrade_blocked');
});

test('a persistence failure fences previously allowed privilege immediately', async () => {
  const facade = await createSeededFacade();
  const source = { current: { status: 'missing' } };
  const service = create(source, facade);
  await service.initialize();
  assert.equal(service.guard().ok, true);
  facade.renameFile = async () => { throw new Error('disk unavailable'); };
  source.current = { status: 'present', bytes: signedBundle({
    revision: 1, privileged_execution: 'allow',
  }), source_kind: 'windows_machine_policy', source_fingerprint: 'f'.repeat(64) };
  const refreshed = await service.refresh();
  assert.equal(refreshed.reason, 'managed_policy_state_write_failed');
  assert.equal(service.status().status, 'blocked');
  assert.equal(service.guard().reason, 'managed_policy_state_write_failed');
});

test('policy refresh cannot interleave with an authoritative commit fence', async () => {
  const facade = await createSeededFacade();
  const source = { current: { status: 'missing' } };
  const service = create(source, facade);
  await service.initialize();
  const token = service.capture();
  let releaseCommit;
  let commitEntered;
  const entered = new Promise((resolve) => { commitEntered = resolve; });
  const held = new Promise((resolve) => { releaseCommit = resolve; });
  const commit = service.withCurrentPolicy(token, async () => {
    commitEntered();
    await held;
    return { ok: true, committed: true };
  });
  await entered;
  source.current = { status: 'present', bytes: signedBundle({
    revision: 1, privileged_execution: 'allow',
  }), source_kind: 'windows_machine_policy', source_fingerprint: 'a'.repeat(64) };
  let refreshed = false;
  const refresh = service.refresh().then((result) => { refreshed = true; return result; });
  await Promise.resolve();
  assert.equal(refreshed, false);
  releaseCommit();
  assert.deepEqual(await commit, { ok: true, committed: true });
  assert.equal((await refresh).ok, true);
  assert.equal((await service.withCurrentPolicy(token, () => ({ ok: true }))).reason,
    'managed_policy_authority_stale');
});

test('a delayed policy refresh cannot publish or persist after disposal', async () => {
  const facade = await createSeededFacade();
  let releaseRead;
  let enterRead;
  const entered = new Promise((resolve) => { enterRead = resolve; });
  const source = { read: () => {
    enterRead();
    return new Promise((resolve) => { releaseRead = resolve; });
  } };
  const service = createManagedPolicyService({ facade, source, pollIntervalMs: 0 });
  const pending = service.refresh();
  await entered;
  const before = service.status();
  let writes = 0;
  const writeFile = facade.writeFile.bind(facade);
  facade.writeFile = async (...args) => { writes += 1; return writeFile(...args); };
  service.dispose();
  releaseRead({ status: 'missing' });

  assert.deepEqual(await pending, { ok: false, reason: 'managed_policy_disposed' });
  assert.deepEqual(service.status(), before);
  assert.equal(writes, 0);
});

test('direct package admission enforces actual source, publisher, fingerprint, and procurement', () => {
  const sourceIdentity = { kind: 'local_package', package_path_digest: 'a'.repeat(64) };
  const status = { status: 'active', installation: 'allow_inactive',
    allowed_source_kinds: ['local_package'], allowed_publishers: ['trusted'],
    managed_source_fingerprints: [crypto.createHash('sha256')
      .update(JSON.stringify(sourceIdentity), 'utf8').digest('hex')],
    require_sbom: true, require_build_provenance: true };
  const managed = { capture: () => ({ revision: 1, policy_digest: 'b'.repeat(64) }),
    isCurrent: () => true, status: () => status };
  const validate = createManagedInstallValidator(managed, 'local_package');
  const verdict = { publisher_id: 'trusted', package_record: { source_identity: sourceIdentity },
    package_metadata: { sbom_present: true, build_provenance_present: true } };
  assert.equal(validate(verdict).ok, true);
  assert.equal(validate({ ...verdict, package_record: { source_identity: {
    kind: 'signed_catalog', catalog_id: 'stable', tuf_target_path: 'trusted/widget',
  } } }).reason, 'managed_policy_source_denied');
  assert.equal(validate({ ...verdict, publisher_id: 'other' }).reason,
    'managed_policy_publisher_denied');
  assert.equal(validate({ ...verdict, package_metadata: {
    sbom_present: false, build_provenance_present: true,
  } }).reason, 'managed_policy_sbom_required');
});
