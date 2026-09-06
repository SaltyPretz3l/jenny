'use strict';

// The Stage-3 disabled-only install operation, over the REAL store (PLUG-D22:
// no simulator). It composes W3/W4's durable core and adds nothing inside it:
// commit-sequence.js's header states the one authority rule -- "only the
// active-pointer flip commits" -- and everything here sits strictly BEFORE or
// AFTER that sequence, never within it.
//
// Ordering rule this file exists to keep true:
//   1. verified bytes land in the content store,
//   2. THEN the candidate generation record references that digest,
//   3. THEN runCommitSequence makes the generation durable and flips the
//      pointer.
// A crash at (1) leaves orphan bytes nothing points at (gc.js reclaims them); a
// crash at (2)/(3) is exactly what crash-injection.test.js's fully-old-or-
// fully-new property covers.
//
// Injected dependencies, never hard-wired (this module must stay compilable and
// testable independently of the package/consent lanes, and the orchestrator
// should not pin its own verifier anyway):
//   verifyPackage   ({bytes, sourcePathDigest, now}) -> an authoritative,
//                   signed package verdict (identity is never caller input)
//   requireConsent  ({operation, publisherId, pluginId, operationId}) -> {ok, ...}
//   newOperationId  () -> operation id string (deterministic in tests)
//   safeMode        the resolved value from safe-mode.js resolvePluginsSafeMode
//
// requireConsent DEFAULTS TO DENY. A caller that forgets to pass one fails
// closed; there is no configuration in which "no consent function" means
// "consent granted".
//
// Operation identity: Jenny mints the authoritative `operation_id` here. A
// caller-supplied one is REJECTED, not quietly overwritten -- the architecture
// is explicit that mutation handlers mint the id and that retry/status paths may
// only reference an existing one. A caller's own correlator is accepted as
// `clientRequestId` and is hashed into the request fingerprint, where it does
// idempotency work without ever becoming authority identity.
//
// This module is also the canonical home of the mutation-path identity helpers
// (fingerprint, id minting, progress emission, the deny-by-default consent
// function). uninstall-operation.js imports them from here rather than growing
// a near-copy that could drift.

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { putContent, sha256Hex, isValidDigest } = require('../store/content-store');
const { writePackageRecord } = require('../store/package-record-store');
const { runCommitSequence, readCommittedState } = require('./commit-sequence');
const { buildOperationResult, wireCodeFor } = require('./operation-result');
const { createProgressLog, buildProgressEvent } = require('./progress-log');
const {
  CONTROL_PLANE_STAGE,
  DISABLED_ONLY_STATE,
  assertStagePermitsState,
  assertNoContributionExecution,
  filterToDisabledOnly,
} = require('./stage-gate');
const { safeModeRefusal } = require('../safe-mode');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('../identity/authority-id');
const { validateDisplayString } = require('../identity/display-strings');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// PluginOperationReceiptV1 / PluginOperationProgressV1 both bound operation_id
// with this pattern. An injected id generator that violates it would otherwise
// fail deep inside contract validation, long after the store was touched.
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// The deny-by-default consent function (see header). Exported so tests can
// assert the DEFAULT denies, not merely that an explicit denier denies.
const DENY_CONSENT = Object.freeze(function denyConsentByDefault() {
  return { ok: false, reason: 'consent_not_configured', code: PLUGIN_ERROR_CODES.CONSENT_REQUIRED };
});

function refuse(stage, reason, wireCode, extra = {}) {
  return { ok: false, stage, reason, wireCode: wireCode || null, result: null, ...extra };
}

// Deterministic request fingerprint. `clientRequestId` participates here and
// ONLY here: two calls that differ only in correlator are different requests
// for idempotency purposes, which is what a correlator is for.
function buildRequestFingerprint({ operation, publisherId, pluginId, contentDigest, clientRequestId, lifecycleEpoch }) {
  return sha256Hex(JSON.stringify({
    operation,
    publisher_id: publisherId,
    plugin_id: pluginId,
    content_digest: contentDigest === undefined ? null : contentDigest,
    client_request_id: clientRequestId === undefined || clientRequestId === null ? null : String(clientRequestId),
    lifecycle_epoch: lifecycleEpoch,
  }));
}

// Mints through the injected generator and validates the result before anything
// durable happens.
function mintOperationId(newOperationId) {
  if (typeof newOperationId !== 'function') {
    return { ok: false, reason: 'operation_id_generator_missing' };
  }
  const candidate = newOperationId();
  if (typeof candidate !== 'string' || !OPERATION_ID_PATTERN.test(candidate)) {
    return { ok: false, reason: 'operation_id_malformed', detail: { candidate: String(candidate).slice(0, 32) } };
  }
  return { ok: true, operationId: candidate };
}

// Rejects (never ignores silently) a caller-supplied operation id.
function rejectCallerOperationId(options) {
  const supplied = Object.prototype.hasOwnProperty.call(options, 'operationId')
    || Object.prototype.hasOwnProperty.call(options, 'operation_id');
  return supplied
    ? { ok: false, reason: 'caller_supplied_operation_id' }
    : { ok: true };
}

// A bounded progress emitter bound to one operation. Terminal fencing is NOT
// reimplemented here: progress-log.js already fences everything after a
// terminal event, so this only counts sequences and records rejections.
function createEmitter({ operationId, lifecycleEpoch, binding, log }) {
  const progressLog = log || createProgressLog(operationId);
  const state = { sequence: 0, rejections: [] };
  function emit(recordedAt, event) {
    const candidate = buildProgressEvent({
      operationId,
      sequence: state.sequence,
      lifecycleEpoch,
      expectedGeneration: binding,
      observedGeneration: binding,
      recordedAt,
      event,
    });
    state.sequence += 1;
    const accepted = progressLog.accept(candidate);
    if (!accepted.ok) state.rejections.push(accepted.reason);
    return accepted;
  }
  return {
    log: progressLog,
    rejections: state.rejections,
    phase: (recordedAt, phase) => emit(recordedAt, { kind: 'phase', phase }),
    terminal: (recordedAt, status, retryable, digest) => emit(recordedAt, {
      kind: 'terminal',
      status,
      retryable,
      ...(digest ? { terminal_result_digest: digest } : {}),
    }),
  };
}

// Reads the externally observable authority state plus the per-plugin state of
// one subject, without inventing anything the store does not say.
async function readAuthoritySnapshot(facade, baseDir, { publisherId, pluginId }) {
  const state = await readCommittedState(facade, baseDir);
  if (state.pointerStatus === 'corrupted') {
    return { ok: false, reason: 'active_pointer_corrupted' };
  }
  const plugins = state.generation ? state.generation.plugins : [];
  const entry = plugins.find((item) => item.publisher_id === publisherId && item.plugin_id === pluginId) || null;
  return {
    ok: true,
    pointer: state.pointer,
    generation: state.generation,
    plugins,
    entry,
    authorityState: entry ? entry.effective_state : 'absent',
    commitEpoch: state.pointer ? state.pointer.commit_epoch : 0,
  };
}

function cleanupTargetFor(authorityState) {
  return authorityState === 'absent' ? { kind: 'absent' } : { kind: DISABLED_ONLY_STATE };
}

function cancellationRequested(isCanceled) {
  if (typeof isCanceled !== 'function') return false;
  try {
    return isCanceled() === true;
  } catch (_error) {
    return true;
  }
}

function packageRecordMatchesVerdict(record, {
  publisherId,
  pluginId,
  resolvedVersion,
  publisherKeyId,
  contentDigest,
  sourcePathDigest,
}) {
  return Boolean(
    record
    && record.publisher_id === publisherId
    && record.plugin_id === pluginId
    && record.content_digest === contentDigest
    && record.version_axes?.package_semver === resolvedVersion
    && record.source_identity?.kind === 'local_package'
    && (sourcePathDigest === undefined || record.source_identity.package_path_digest === sourcePathDigest)
    && record.signature_bundle_state?.state === 'verified'
    && record.signature_bundle_state.publisher_id === publisherId
    && record.signature_bundle_state.signing_key_id === publisherKeyId
    && record.signature_bundle_state.signature_algorithm === 'ed25519'
  );
}

// Wraps buildOperationResult so a schema failure surfaces as a bounded refusal
// rather than a thrown string (the operation contract: never a bare boolean,
// never a thrown string).
function settle(stage, ok, args, extra = {}) {
  const built = buildOperationResult(args);
  if (!built.ok) {
    return { ok: false, stage, reason: built.reason, detail: built.detail || null, result: null, ...extra };
  }
  return { ok, stage, result: built.result, ...extra };
}

async function installPackage(facade, baseDir, options = {}) {
  const {
    packageBytes,
    sourcePathDigest,
    verifyPackage,
    requireConsent = DENY_CONSENT,
    newOperationId,
    clientRequestId = null,
    safeMode = { active: false, source: 'none' },
    now,
    createdAt = now,
    lifecycleEpoch = 0,
    generationId,
    policyGrantRef,
    dataSchemaRefs = [],
    desiredState = DISABLED_ONLY_STATE,
    progressLog = null,
    leaseDurationMs,
    isCanceled = null,
    validateVerifiedPackage = null,
    commitAuthority = null,
  } = options;

  // (1) Safe mode, before any lease, receipt, or byte. Costs nothing, touches
  // nothing -- see safe-mode.js for why this returns no contract result.
  if (safeMode && safeMode.active) {
    return safeModeRefusal(safeMode);
  }

  // Operation identity is Jenny's. Checked before I/O so a caller that tries to
  // supply one never gets a partially executed operation out of it.
  const callerId = rejectCallerOperationId(options);
  if (!callerId.ok) {
    return refuse('start', callerId.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }

  // (2) Package verification through the INJECTED verifier. Any non-ok verdict
  // stops the operation and its code is propagated unchanged -- this module
  // does not re-classify another lane's verdict.
  if (typeof verifyPackage !== 'function') {
    return refuse('start', 'verifier_missing', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  }
  const verdict = await verifyPackage({ bytes: packageBytes, sourcePathDigest, now });
  if (cancellationRequested(isCanceled)) {
    return refuse('canceled', 'operation_canceled', PLUGIN_ERROR_CODES.FEATURE_DISABLED);
  }
  if (!verdict || verdict.ok !== true) {
    return refuse('verify', (verdict && verdict.reason) || 'package_verification_failed', (verdict && verdict.code) || PLUGIN_ERROR_CODES.INTEGRITY_FAILED, {
      verdict: verdict || null,
    });
  }
  const publisherId = verdict.publisher_id;
  const pluginId = verdict.plugin_id;
  const displayName = verdict.display_name;
  const resolvedVersion = verdict.version;
  const publisherKeyId = verdict.publisher_key_id;
  const contentDigest = sha256Hex(packageBytes);
  if (
    typeof publisherId !== 'string'
    || !PUBLISHER_ID_RE.test(publisherId)
    || typeof pluginId !== 'string'
    || !PLUGIN_ID_RE.test(pluginId)
    || !validateDisplayString(displayName).ok
    || typeof resolvedVersion !== 'string'
    || !SEMVER_RE.test(resolvedVersion)
    || !isValidDigest(publisherKeyId)
    || !packageRecordMatchesVerdict(verdict.package_record, {
      publisherId,
      pluginId,
      resolvedVersion,
      publisherKeyId,
      contentDigest,
      sourcePathDigest,
    })
  ) {
    return refuse('verify', 'verified_package_metadata_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  }
  const admitted = typeof validateVerifiedPackage === 'function'
    ? await validateVerifiedPackage(verdict) : { ok: true };
  if (!admitted?.ok) {
    return refuse('policy', admitted?.reason || 'managed_policy_installation_denied',
      PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }

  const minted = mintOperationId(newOperationId);
  if (!minted.ok) {
    return refuse('start', minted.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED, { detail: minted.detail || null });
  }
  const operationId = minted.operationId;

  // (3) Consent through the INJECTED gate, defaulting to deny.
  const consent = await requireConsent({ operation: 'install', publisherId, pluginId, operationId });
  if (cancellationRequested(isCanceled)) {
    return refuse('canceled', 'operation_canceled', PLUGIN_ERROR_CODES.FEATURE_DISABLED, { operationId });
  }
  if (!consent || consent.ok !== true) {
    return refuse('consent', (consent && consent.reason) || 'consent_denied', (consent && consent.code) || PLUGIN_ERROR_CODES.CONSENT_REQUIRED, { operationId });
  }

  const snapshot = await readAuthoritySnapshot(facade, baseDir, { publisherId, pluginId });
  if (!snapshot.ok) {
    return refuse('read_authority', snapshot.reason, wireCodeFor(snapshot.reason) || null, { operationId });
  }
  const authorityStateBefore = snapshot.authorityState;

  const requestFingerprint = buildRequestFingerprint({
    operation: 'install',
    publisherId,
    pluginId,
    contentDigest,
    clientRequestId,
    lifecycleEpoch,
  });

  const emitter = createEmitter({
    operationId,
    lifecycleEpoch,
    binding: { commit_epoch: snapshot.commitEpoch },
    log: progressLog,
  });
  emitter.phase(now, 'staging');

  // Disposal/cancellation remains side-effect-free until this final fence.
  // Once content persistence starts, the crash-safe commit path owns cleanup
  // and recovery; aborting midway would create a less truthful lifecycle.
  if (cancellationRequested(isCanceled)) {
    emitter.terminal(now, 'failed', false);
    return settle('canceled', false, {
      operationId,
      requestFingerprint,
      status: 'failed',
      authorityStateBefore,
      authorityStateAfter: authorityStateBefore,
      authorityStateCommitted: authorityStateBefore,
      cleanupStatus: 'not_required',
      cleanupTarget: cleanupTargetFor(authorityStateBefore),
      settledAt: now,
    }, {
      reason: 'operation_canceled',
      wireCode: PLUGIN_ERROR_CODES.FEATURE_DISABLED,
      commitReason: 'operation_canceled',
    });
  }

  // (4) Bytes first: content lands in the content store BEFORE any generation
  // record references the digest. The reverse order would let a crash publish a
  // generation pointing at content that does not exist.
  const stored = await putContent(facade, baseDir, packageBytes);
  if (!stored.ok) {
    emitter.terminal(now, 'failed', false);
    return settle('put_content', false, {
      operationId,
      requestFingerprint,
      status: 'failed',
      authorityStateBefore,
      authorityStateAfter: authorityStateBefore,
      authorityStateCommitted: authorityStateBefore,
      cleanupStatus: 'not_required',
      cleanupTarget: cleanupTargetFor(authorityStateBefore),
      settledAt: now,
      failureReason: 'store_write_failed',
    }, { wireCode: PLUGIN_ERROR_CODES.STORE_WRITE_FAILED, contentReason: stored.reason });
  }
  const recorded = await writePackageRecord(facade, baseDir, {
    digest: stored.digest,
    record: verdict.package_record,
  });
  if (!recorded.ok) {
    emitter.terminal(now, 'failed', false);
    return settle('put_content', false, {
      operationId,
      requestFingerprint,
      status: 'failed',
      authorityStateBefore,
      authorityStateAfter: authorityStateBefore,
      authorityStateCommitted: authorityStateBefore,
      cleanupStatus: 'not_required',
      cleanupTarget: cleanupTargetFor(authorityStateBefore),
      settledAt: now,
      failureReason: recorded.reason,
    }, { wireCode: PLUGIN_ERROR_CODES.STORE_WRITE_FAILED, packageRecordReason: recorded.reason });
  }
  emitter.phase(now, 'validating');

  // (5) The stage fence, in the contract's order. The first assert names the
  // state this operation intends to commit; the gate then refuses execution
  // surfaces; the filter normalizes; and a final assert runs over the list we
  // are ACTUALLY about to commit, because asserting only on the pre-filter list
  // would prove something about values we discard.
  assertStagePermitsState(DISABLED_ONLY_STATE, { stage: CONTROL_PLANE_STAGE });
  const execution = assertNoContributionExecution(verdict.descriptor || { contributions: [] }, {
    stage: CONTROL_PLANE_STAGE,
  });
  if (!execution.ok) {
    emitter.terminal(now, 'failed', false);
    return settle('stage_gate', false, {
      operationId,
      requestFingerprint,
      status: 'failed',
      authorityStateBefore,
      authorityStateAfter: authorityStateBefore,
      authorityStateCommitted: authorityStateBefore,
      cleanupStatus: 'not_required',
      cleanupTarget: cleanupTargetFor(authorityStateBefore),
      settledAt: now,
    }, { wireCode: PLUGIN_ERROR_CODES.POLICY_BLOCKED, gateReason: execution.reason, gateDetail: execution.detail });
  }

  const candidateEntry = {
    publisher_id: publisherId,
    plugin_id: pluginId,
    display_name: displayName,
    resolved_version: resolvedVersion,
    publisher_key_id: publisherKeyId,
    artifact_digest: contentDigest,
    desired_state: desiredState,
    effective_state: desiredState,
    depends_on: [],
  };
  if (verdict.manifest?.manifest_schema_version === 2) {
    candidateEntry.contributions = verdict.manifest.contributions.map((contribution) => ({
      contribution_id: contribution.contribution_id,
      kind: contribution.kind,
      content_digest: contribution.content_sha256,
      desired_enabled: contribution.kind !== 'mcp_descriptor',
      effective_enabled: false,
      blocked_reason: contribution.kind === 'mcp_descriptor' ? 'stage_forbidden' : 'master_disabled',
      settings_ref: { kind: 'absent' },
    }));
  }
  const upgradesToV2 = verdict.manifest?.manifest_schema_version === 2
    || snapshot.generation?.generation_schema_version === 2;
  const merged = snapshot.plugins
    .filter((item) => !(item.publisher_id === publisherId && item.plugin_id === pluginId))
    .map((item) => (upgradesToV2 ? { ...item, contributions: item.contributions || [] } : item))
    .concat([candidateEntry]);
  const normalized = filterToDisabledOnly(merged);
  for (const entry of normalized.plugins) {
    assertStagePermitsState(entry.effective_state, { stage: CONTROL_PLANE_STAGE });
  }
  emitter.phase(now, 'committing');

  const currentAdmission = typeof validateVerifiedPackage === 'function'
    ? await validateVerifiedPackage(verdict) : { ok: true };
  if (!currentAdmission?.ok) {
    emitter.terminal(now, 'failed', false);
    return refuse('policy', currentAdmission?.reason || 'managed_policy_authority_stale',
      PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId });
  }

  // (6) THE commit. Not reimplemented -- called.
  const committed = await runCommitSequence(facade, baseDir, {
    operationId,
    requestFingerprint,
    lifecycleEpoch,
    generationId,
    createdAt,
    plugins: normalized.plugins,
    policyGrantRef,
    dataSchemaRefs,
    now,
    auditAction: 'install',
    auditActor: { kind: 'user' },
    commitAuthority,
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
  });

  if (!committed.ok && committed.committed === true) {
    emitter.terminal(now, 'indeterminate', false, committed.pointer.generation_digest);
    return settle('commit', false, {
      operationId,
      requestFingerprint,
      status: 'indeterminate',
      authorityStateBefore,
      authorityStateAfter: DISABLED_ONLY_STATE,
      authorityStateCommitted: DISABLED_ONLY_STATE,
      cleanupStatus: 'not_required',
      cleanupTarget: { kind: DISABLED_ONLY_STATE },
      settledAt: now,
      failureReason: committed.reason,
    }, {
      wireCode: PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
      commitStage: committed.stage,
      commitReason: committed.reason,
      committed: true,
      pointer: committed.pointer,
      contentDigest,
      commitEpoch: committed.commitEpoch,
      revision: committed.revision,
      generationId: committed.generationId,
      progress: emitter.log,
    });
  }

  if (!committed.ok) {
    emitter.terminal(now, 'failed', Boolean(wireCodeFor(committed.reason) === PLUGIN_ERROR_CODES.LEASE_BUSY));
    return settle('commit', false, {
      operationId,
      requestFingerprint,
      status: 'failed',
      authorityStateBefore,
      // Authority did not move: the pointer never flipped.
      authorityStateAfter: authorityStateBefore,
      authorityStateCommitted: authorityStateBefore,
      cleanupStatus: 'not_required',
      cleanupTarget: cleanupTargetFor(authorityStateBefore),
      settledAt: now,
      failureReason: committed.reason,
    }, {
      wireCode: wireCodeFor(committed.reason) || null,
      commitStage: committed.stage,
      commitReason: committed.reason,
      // Content bytes written at step (4) may survive a refused commit. That is
      // orphan content by design, not partial authority: nothing references it
      // and gc.js reclaims it.
      orphanContentDigest: contentDigest,
    });
  }

  emitter.terminal(now, 'committed', false, committed.pointer.generation_digest);
  return settle('commit', true, {
    operationId,
    requestFingerprint,
    status: 'committed',
    authorityStateBefore,
    authorityStateAfter: DISABLED_ONLY_STATE,
    authorityStateCommitted: DISABLED_ONLY_STATE,
    cleanupStatus: 'not_required',
    cleanupTarget: { kind: DISABLED_ONLY_STATE },
    settledAt: now,
  }, {
    operationId,
    publisher_id: publisherId,
    plugin_id: pluginId,
    contentDigest,
    commitEpoch: committed.commitEpoch,
    revision: committed.revision,
    generationId: committed.generationId,
    downgraded: normalized.downgraded,
    progress: emitter.log,
  });
}

module.exports = {
  OPERATION_ID_PATTERN,
  DENY_CONSENT,
  buildRequestFingerprint,
  mintOperationId,
  rejectCallerOperationId,
  createEmitter,
  readAuthoritySnapshot,
  cleanupTargetFor,
  cancellationRequested,
  packageRecordMatchesVerdict,
  settle,
  refuse,
  installPackage,
};
