'use strict';

// installPackage over the REAL store (PLUG-D22). The properties pinned here are
// the ones that decide whether Stage 3 is actually a disabled-only control
// plane: safe mode costs nothing, consent defaults to deny, Jenny owns the
// operation id, bytes land before the record that references them, and a
// refused commit moves no authority.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { hasContent, sha256Hex } = require('../../../services/plugins/store/content-store');
const { readActivePointer } = require('../../../services/plugins/store/active-pointer');
const { listGenerationIds } = require('../../../services/plugins/store/generation-store');
const { acquireLease } = require('../../../services/plugins/store/mutation-lease');
const { getReceipt } = require('../../../services/plugins/store/operation-receipts');
const { readPackageRecord } = require('../../../services/plugins/store/package-record-store');
const { readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { installPackage, DENY_CONSENT, buildRequestFingerprint } = require('../../../services/plugins/lifecycle/install-operation');
const { resolvePluginsSafeMode, SAFE_MODE_SWITCH } = require('../../../services/plugins/safe-mode');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const {
  createVerifiedPackageVerifier,
  verifiedPackageVerdict,
} = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';
const NOW = '2026-07-31T00:00:00Z';
const POLICY_GRANT_REF = Object.freeze({
  policy_snapshot_digest: 'b'.repeat(64),
  policy_revision: 1,
  grant_set_digest: 'c'.repeat(64),
});
const DATA_SCHEMA_REFS = Object.freeze([{ domain: 'alpha_state', schema_version: 1 }]);

const consentOk = async () => ({ ok: true });

function idGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

function installArgs(overrides = {}) {
  const packageBytes = overrides.packageBytes || 'alpha-package-bytes';
  const publisherId = overrides.publisherId || 'acme';
  const pluginId = overrides.pluginId || 'alpha';
  return {
    packageBytes,
    verifyPackage: overrides.verifyPackage || createVerifiedPackageVerifier({
      publisherId,
      pluginId,
      descriptor: overrides.descriptor,
      now: overrides.now || NOW,
    }),
    requireConsent: consentOk,
    newOperationId: idGenerator('op-install'),
    now: NOW,
    lifecycleEpoch: 1,
    generationId: 'gen-1',
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: DATA_SCHEMA_REFS,
    ...overrides,
  };
}

function mutatingWrites(facade) {
  const counts = facade.callCounts;
  return counts.writeFile + counts.renameFile + counts.mkdir + counts.remove + counts.fsyncFile;
}

function corruptReceiptAfterPointerFlip(facade, operationId) {
  const renameFile = facade.renameFile.bind(facade);
  facade.renameFile = async (oldPath, newPath) => {
    await renameFile(oldPath, newPath);
    if (newPath === `${BASE_DIR}/active-generation.json`) {
      await facade.writeFile(`${BASE_DIR}/operations/${operationId}.json`, '{corrupt');
    }
  };
}

test('a verified install commits exactly one installed_disabled plugin', async () => {
  const facade = createMemoryFsFacade();
  const outcome = await installPackage(facade, BASE_DIR, installArgs());

  assert.equal(outcome.ok, true, `install failed: ${outcome.reason || ''}`);
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.authority_state_before, 'absent');
  assert.equal(outcome.result.authority_state_after, 'installed_disabled');
  assert.equal(outcome.result.cleanup_status, 'not_required');
  assert.deepEqual(outcome.result.cleanup_target, { kind: 'installed_disabled' });
  assert.equal(outcome.result.operation_id, 'op-install-1');

  const state = await readCommittedState(facade, BASE_DIR);
  assert.equal(state.pointer.generation_id, 'gen-1');
  assert.equal(state.generation.plugins.length, 1);
  assert.equal(state.generation.plugins[0].effective_state, 'installed_disabled');
  assert.equal(state.generation.plugins[0].artifact_digest, sha256Hex('alpha-package-bytes'));

  // Ordering rule: the bytes the generation references are actually present.
  assert.equal(await hasContent(facade, BASE_DIR, outcome.contentDigest), true);
});

test('the final authority wrapper encloses the pointer commit and may deny it', async () => {
  const facade = createMemoryFsFacade();
  let entered = 0;
  const denied = await installPackage(facade, BASE_DIR, installArgs({
    commitAuthority: async () => {
      entered += 1;
      return { ok: false, reason: 'managed_policy_authority_stale' };
    },
  }));
  assert.equal(entered, 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.commitReason, 'managed_policy_authority_stale');
  assert.equal((await readActivePointer(facade, BASE_DIR)).status, 'missing');
});

test('cancellation after verification remains side-effect free', async () => {
  const facade = createMemoryFsFacade();
  let canceled = false;
  const outcome = await installPackage(facade, BASE_DIR, installArgs({
    verifyPackage: async ({ bytes }) => {
      canceled = true;
      return verifiedPackageVerdict({ packageBytes: bytes });
    },
    isCanceled: () => canceled,
  }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'operation_canceled');
  assert.equal(mutatingWrites(facade), 0);
});

test('verdict metadata must agree with its immutable package record before persistence', async () => {
  const facade = createMemoryFsFacade();
  const outcome = await installPackage(facade, BASE_DIR, installArgs({
    verifyPackage: async ({ bytes }) => {
      const verdict = verifiedPackageVerdict({ packageBytes: bytes });
      verdict.package_record.signature_bundle_state.signing_key_id = 'f'.repeat(64);
      return verdict;
    },
  }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'verified_package_metadata_invalid');
  assert.equal(mutatingWrites(facade), 0);
});

test('a post-pointer receipt failure reports committed authority as indeterminate', async () => {
  const facade = createMemoryFsFacade();
  corruptReceiptAfterPointerFlip(facade, 'op-install-1');
  const outcome = await installPackage(facade, BASE_DIR, installArgs());

  assert.equal(outcome.ok, false);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.wireCode, PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE);
  assert.equal(outcome.result.status, 'indeterminate');
  assert.equal(outcome.result.authority_state_before, 'absent');
  assert.equal(outcome.result.authority_state_after, 'installed_disabled');
  assert.equal((await readCommittedState(facade, BASE_DIR)).generation.plugins.length, 1);
});

test('reinstalling identical bytes later preserves first-acquisition package evidence', async () => {
  const facade = createMemoryFsFacade();
  const bytes = 'alpha-package-bytes';
  const first = await installPackage(facade, BASE_DIR, installArgs({ packageBytes: bytes }));
  assert.equal(first.ok, true);

  const later = '2026-08-03T00:00:00Z';
  const second = await installPackage(facade, BASE_DIR, installArgs({
    packageBytes: bytes,
    now: later,
    generationId: 'gen-2',
    newOperationId: () => 'op-reinstall',
    verifyPackage: async () => {
      const verdict = verifiedPackageVerdict({ packageBytes: bytes, now: later });
      verdict.package_record.source_identity.package_path_digest = 'f'.repeat(64);
      return verdict;
    },
  }));
  assert.equal(second.ok, true, second.reason || 'reinstall failed');

  const record = await readPackageRecord(facade, BASE_DIR, sha256Hex(bytes));
  assert.equal(record.ok, true);
  assert.equal(record.record.created_at, NOW);
  assert.equal(record.record.source_identity.package_path_digest, 'a'.repeat(64));
});

test('safe mode refuses before ANY store write', async () => {
  const facade = createMemoryFsFacade();
  const safeMode = resolvePluginsSafeMode({ argv: [SAFE_MODE_SWITCH] });
  const outcome = await installPackage(facade, BASE_DIR, installArgs({ safeMode }));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'safe_mode_active');
  assert.equal(outcome.wireCode, PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE);
  assert.equal(mutatingWrites(facade), 0, 'safe mode must touch nothing');
  assert.equal(facade.callCounts.readFile, 0, 'safe mode must not even read');
  assert.equal((await readActivePointer(facade, BASE_DIR)).status, 'missing');
});

test('the DEFAULT consent function denies, and denial writes nothing', async () => {
  const facade = createMemoryFsFacade();
  const args = installArgs();
  delete args.requireConsent;
  const outcome = await installPackage(facade, BASE_DIR, args);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'consent_not_configured');
  assert.equal(outcome.wireCode, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(mutatingWrites(facade), 0, 'a denied install must not write');
  // And the exported default is the same denying function.
  assert.deepEqual(DENY_CONSENT(), {
    ok: false,
    reason: 'consent_not_configured',
    code: PLUGIN_ERROR_CODES.CONSENT_REQUIRED,
  });
});

test('an explicitly denied consent refuses with the caller-supplied code', async () => {
  const facade = createMemoryFsFacade();
  const outcome = await installPackage(facade, BASE_DIR, installArgs({
    requireConsent: async () => ({ ok: false, reason: 'user_declined', code: PLUGIN_ERROR_CODES.CONSENT_ORIGIN_INVALID }),
  }));
  assert.equal(outcome.reason, 'user_declined');
  assert.equal(outcome.wireCode, PLUGIN_ERROR_CODES.CONSENT_ORIGIN_INVALID);
  assert.equal(mutatingWrites(facade), 0);
});

test('a caller-supplied operation id is rejected, never adopted', async () => {
  const facade = createMemoryFsFacade();
  for (const key of ['operationId', 'operation_id']) {
    const outcome = await installPackage(facade, BASE_DIR, installArgs({ [key]: 'op-attacker' }));
    assert.equal(outcome.ok, false, `${key} must be rejected`);
    assert.equal(outcome.reason, 'caller_supplied_operation_id');
    assert.equal(mutatingWrites(facade), 0);
  }
  // The minted id is Jenny's, and it is the one that reaches the receipt.
  const clean = await installPackage(facade, BASE_DIR, installArgs());
  assert.equal(clean.result.operation_id, 'op-install-1');
  assert.equal((await getReceipt(facade, BASE_DIR, 'op-attacker')).found, false);
  assert.equal((await getReceipt(facade, BASE_DIR, 'op-install-1')).receipt.status, 'committed');
});

test('a malformed minted id fails closed before any store write', async () => {
  const facade = createMemoryFsFacade();
  const outcome = await installPackage(facade, BASE_DIR, installArgs({ newOperationId: () => 'NOT A VALID ID' }));
  assert.equal(outcome.reason, 'operation_id_malformed');
  assert.equal(mutatingWrites(facade), 0);
});

test('any non-ok verifier verdict stops the install and propagates its code unchanged', async () => {
  const facade = createMemoryFsFacade();
  for (const code of [
    PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
    PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED,
    PLUGIN_ERROR_CODES.ARCHIVE_REJECTED,
  ]) {
    const outcome = await installPackage(facade, BASE_DIR, installArgs({
      verifyPackage: async () => ({ ok: false, code, reason: 'verifier_said_no' }),
    }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.wireCode, code, 'the verifier verdict code must survive unchanged');
    assert.equal(outcome.reason, 'verifier_said_no');
  }
  // A missing verifier is itself fail-closed.
  const noVerifier = await installPackage(facade, BASE_DIR, installArgs({ verifyPackage: null }));
  assert.equal(noVerifier.reason, 'verifier_missing');
  assert.equal(mutatingWrites(facade), 0, 'no verdict path may write');
});

test('a descriptor declaring execution, network, view, or MCP is refused after staging', async () => {
  for (const descriptor of [
    { contributions: [{ kind: 'tool', contribution_id: 'run' }] },
    { contributions: [], network: [{ destination: 'example.test' }] },
    { contributions: [], views: [{ view_id: 'panel' }] },
    { contributions: [], mcp_servers: [{ server_id: 'server' }] },
  ]) {
    const facade = createMemoryFsFacade();
    const outcome = await installPackage(facade, BASE_DIR, installArgs({ descriptor }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.wireCode, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
    assert.equal(outcome.result.authority_state_after, 'absent', 'a refused install moves no authority');
    assert.equal((await readActivePointer(facade, BASE_DIR)).status, 'missing');
  }
});

test('lease contention returns LEASE_BUSY and leaves authority untouched', async () => {
  const facade = createMemoryFsFacade();
  const first = await installPackage(facade, BASE_DIR, installArgs());
  assert.equal(first.ok, true);

  const before = await readCommittedState(facade, BASE_DIR);
  const generationsBefore = await listGenerationIds(facade, BASE_DIR);

  // A different operation is holding the single graph-scoped mutation lease.
  const held = await acquireLease(facade, BASE_DIR, { operationId: 'op-competitor', now: NOW });
  assert.equal(held.ok, true);

  const contended = await installPackage(facade, BASE_DIR, installArgs({
    pluginId: 'beta',
    packageBytes: 'beta-package-bytes',
    generationId: 'gen-2',
    newOperationId: idGenerator('op-second'),
  }));

  assert.equal(contended.ok, false);
  assert.equal(contended.commitReason, 'busy');
  assert.equal(contended.result.status, 'failed');
  assert.equal(contended.result.retryable, true, 'lease contention is retryable');
  assert.equal(contended.result.failure.wire_code, PLUGIN_ERROR_CODES.LEASE_BUSY);

  const after = await readCommittedState(facade, BASE_DIR);
  assert.equal(after.pointer.commit_epoch, before.pointer.commit_epoch, 'epoch must not move');
  assert.equal(after.pointer.generation_id, before.pointer.generation_id);
  assert.deepEqual(await listGenerationIds(facade, BASE_DIR), generationsBefore, 'no candidate generation written');
  assert.equal((await getReceipt(facade, BASE_DIR, 'op-second-1')).found, false, 'no receipt for a refused operation');
  // The staged bytes ARE present and are orphan content by design: nothing
  // references them, and gc.js reclaims them (commit-sequence.js's "orphanable
  // by design"). That is not partial authority.
  assert.equal(await hasContent(facade, BASE_DIR, contended.orphanContentDigest), true);
});

test('clientRequestId is an idempotency correlator, not an identity', async () => {
  const base = { operation: 'install', publisherId: 'acme', pluginId: 'alpha', contentDigest: 'a'.repeat(64), lifecycleEpoch: 1 };
  const withA = buildRequestFingerprint({ ...base, clientRequestId: 'client-a' });
  const withB = buildRequestFingerprint({ ...base, clientRequestId: 'client-b' });
  const without = buildRequestFingerprint(base);
  assert.notEqual(withA, withB, 'a different correlator is a different request');
  assert.notEqual(withA, without);
  assert.ok(/^[0-9a-f]{64}$/.test(withA));

  // It never becomes the operation id.
  const facade = createMemoryFsFacade();
  const outcome = await installPackage(facade, BASE_DIR, installArgs({ clientRequestId: 'client-a' }));
  assert.equal(outcome.result.operation_id, 'op-install-1');
  assert.notEqual(outcome.result.request_fingerprint, 'client-a');
});

test('progress events are emitted in order and the terminal fences everything after it', async () => {
  const facade = createMemoryFsFacade();
  const outcome = await installPackage(facade, BASE_DIR, installArgs());
  const log = outcome.progress;

  assert.deepEqual(
    log.events.map((event) => (event.event.kind === 'phase' ? event.event.phase : event.event.kind)),
    ['staging', 'validating', 'committing', 'terminal']
  );
  assert.equal(log.isSettled, true);
  assert.equal(log.terminalSnapshot().status, 'committed');

  const late = log.accept({
    progress_schema_version: 1,
    operation_id: 'op-install-1',
    sequence: 99,
    lifecycle_epoch: 1,
    expected_generation: { commit_epoch: 0 },
    observed_generation: { commit_epoch: 0 },
    recorded_at: NOW,
    event: { kind: 'heartbeat' },
  });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'fenced_after_terminal');
});

test('a second install merges into the existing generation without activating anything', async () => {
  const facade = createMemoryFsFacade();
  await installPackage(facade, BASE_DIR, installArgs());
  const second = await installPackage(facade, BASE_DIR, installArgs({
    pluginId: 'beta',
    packageBytes: 'beta-package-bytes',
    generationId: 'gen-2',
    newOperationId: idGenerator('op-beta'),
    // Even an explicit request for `active` cannot survive the fence.
    desiredState: 'active',
  }));

  assert.equal(second.ok, true, second.reason || '');
  const state = await readCommittedState(facade, BASE_DIR);
  assert.deepEqual(state.generation.plugins.map((entry) => entry.plugin_id).sort(), ['alpha', 'beta']);
  for (const entry of state.generation.plugins) {
    assert.equal(entry.effective_state, 'installed_disabled');
    assert.notEqual(entry.effective_state, 'active');
  }
  assert.equal(state.generation.plugins.find((entry) => entry.plugin_id === 'beta').desired_state, 'active');
  assert.deepEqual(second.downgraded.map((row) => row.plugin_id), ['beta']);
  assert.equal(state.pointer.commit_epoch, 1, 'the epoch advanced exactly once');
});
