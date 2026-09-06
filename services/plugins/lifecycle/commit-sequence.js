'use strict';
// The durable generation-commit sequence, composed from W3's real store modules
// (PLUG-D22: the durability packet's system under test is the real Stage 3
// storage subtree, not a simulator). This is the seven-step recipe from
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md "Durable generation commit",
// reduced to the parts Stage 2 has modules for: lease, receipt, immutable
// generation, pointer flip, settlement, evidence.
//
// Stage 3B's lifecycle orchestrator wires IPC, consent, participant
// attestation, and the sidecar apply path ON TOP of this; it does not replace
// it. Nothing here has an activation surface -- no main/renderer/IPC reference
// (check_plugin_stage_boundary.py) -- and every filesystem touch goes through
// the injected facade, so W4's crash-injecting facade can fail between ANY two
// awaits.
//
// The ONE authority rule everything else defends: **only the active-pointer
// flip commits.** Every step before it is reversible or orphanable; every step
// after it is evidence. That is what makes "either the fully-old or the fully-
// new generation, never a mixed graph" provable by crash injection rather than
// asserted by comment.
//
// `stage` in every result names the last step that completed, so a crash-
// injection test can assert the store's post-recovery classification against
// where the crash actually landed instead of guessing.
const {
  acquireLease,
  releaseLease,
  readLease,
  validateLeaseOwnership,
  revalidateAgainstCurrentGeneration,
} = require('../store/mutation-lease');
const { evaluateIdempotency, createPendingReceipt, settleReceipt } = require('../store/operation-receipts');
const { writeGeneration, readGeneration, sha256Hex } = require('../store/generation-store');
const { readActivePointer, commitActivePointer, buildPointer } = require('../store/active-pointer');
const { mintNextEpoch } = require('../store/commit-epoch');
const { appendJournalEntry } = require('../store/journal');
const { appendAuditEvent, buildAuditEvent } = require('./audit-log');
const { CONTROL_PLANE_STAGE, assertStagePermitsState } = require('./stage-gate');
const { gatherEpochEvidence } = require('./recovery');
function fail(stage, reason, detail) {
  // `committed: false` is explicit on every domain failure so a caller can
  // distinguish "nothing landed, safe to retry" from the one failure that can
  // follow a landed pointer flip (see the settleReceipt path in step 6).
  return { ok: false, stage, reason, detail: detail === undefined ? null : detail, committed: false };
}

function cancellationRequested(isCanceled) {
  if (typeof isCanceled !== 'function') return false;
  try {
    return isCanceled() === true;
  } catch (_error) {
    return true;
  }
}

function boundedParticipantReason(value, fallbackReason) {
  const reason = typeof value === 'string' ? value : fallbackReason;
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : fallbackReason;
}

async function invokeParticipantCallback(callback, payload, fallbackReason) {
  if (typeof callback !== 'function') return { ok: true, skipped: true };
  try {
    const result = await callback(payload);
    if (result && result.ok === true) return result;
    return {
      ...(result && typeof result === 'object' ? result : {}),
      ok: false,
      reason: boundedParticipantReason(result?.reason, fallbackReason),
      ambiguous: result?.ambiguous === true,
    };
  } catch (_error) {
    return { ok: false, reason: fallbackReason, ambiguous: true };
  }
}

// A successfully prepared participant must be able to roll back, reconcile AND
// commit: without `commit` the pointer would flip with no participant settlement.
function validatePreparedParticipant(prepared) {
  if (!prepared || prepared.ok !== true || prepared.skipped === true) return { ok: true };
  if (typeof prepared.rollback !== 'function' || typeof prepared.reconcile !== 'function'
    || typeof prepared.commit !== 'function') {
    return { ok: false, reason: 'participant_contract_invalid' };
  }
  return { ok: true };
}

async function settlePrePointerFailure(
  facade,
  baseDir,
  { operationId, ownerToken, now, prepared, reason, detail = null }
) {
  if (!prepared || prepared.skipped === true) {
    await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return fail('generation_written', reason, detail);
  }
  let participantRollback = null;
  let participantReconciliation = null;
  if (prepared?.ok === true && prepared.skipped !== true) {
    participantRollback = await invokeParticipantCallback(
      prepared.rollback,
      { reason },
      'participant_rollback_failed'
    );
    if (!participantRollback.ok && typeof prepared.reconcile === 'function') {
      participantReconciliation = await invokeParticipantCallback(
        prepared.reconcile,
        { reason, authority: 'prior_committed' },
        'participant_reconciliation_failed'
      );
    }
  }
  await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
  await releaseLease(facade, baseDir, { operationId, ownerToken });
  const rollbackFailed = participantRollback && participantRollback.ok !== true;
  return fail(
    'participant_prepared',
    rollbackFailed ? 'participant_rollback_failed' : reason,
    {
      ...(detail && typeof detail === 'object' ? detail : {}),
      participantRollback: participantRollback ? participantRollback.ok === true : null,
      participantReconciled: participantReconciliation ? participantReconciliation.ok === true : null,
      requiresReconciliation: Boolean(
        rollbackFailed && (!participantReconciliation || participantReconciliation.ok !== true)
      ),
    }
  );
}

// `event_id` is bounded at 64 UTF-8 bytes while `operation_id` may itself be 64,
// so the readable `audit-<operationId>` form overflows for any operation id of
// 59 characters or more -- which silently cost the commit its audit record.
// Keep the readable form when it fits and fall back to a collision-resistant
// digest of the same id when it does not.
function buildAuditEventId(operationId) {
  const preferred = `audit-${operationId}`;
  if (Buffer.byteLength(preferred, 'utf8') <= 64) return preferred;
  return `audit-${sha256Hex(String(operationId)).slice(0, 32)}`;
}

// Evidence appends are explicitly non-fatal after the pointer has committed:
// "journal failure after pointer commit is degraded observability, not an
// implicit rollback". Both calls are wrapped so a crash-injecting facade firing
// on the journal write cannot un-commit an operation that already committed.
async function appendEvidence(facade, baseDir, { entry, auditEvent, auditBuildError = null }) {
  const degraded = [];
  try {
    await appendJournalEntry(facade, baseDir, entry);
  } catch (error) {
    degraded.push({ source: 'journal', error: (error && error.message) || String(error) });
  }
  // An audit event that could not even be BUILT is still missing evidence.
  // Reporting it here is what keeps `degradedEvidence: []` an honest claim.
  if (auditBuildError) {
    degraded.push({ source: 'audit', error: auditBuildError });
  } else if (auditEvent) {
    try {
      const appended = await appendAuditEvent(facade, baseDir, auditEvent);
      if (!appended.ok) degraded.push({ source: 'audit', error: appended.reason });
    } catch (error) {
      degraded.push({ source: 'audit', error: (error && error.message) || String(error) });
    }
  }
  return degraded;
}

// Runs the full sequence. Returns {ok, stage, ...} and never throws for a
// domain reason; a facade I/O failure DOES propagate, because that is exactly
// the simulated crash the caller injected and wants to observe.
async function runCommitSequence(facade, baseDir, {
  operationId,
  requestFingerprint,
  lifecycleEpoch,
  generationId,
  createdAt,
  plugins,
  policyGrantRef,
  dataSchemaRefs,
  now,
  auditAction = 'enable',
  auditActor = { kind: 'user' },
  leaseDurationMs,
  participantPrepare = null,
  commitAuthority = null,
  isCanceled = null,
  controlPlaneStage = CONTROL_PLANE_STAGE,
  generationSchemaVersion = null,
  lockDigest = null,
  distributionStateDigest = null,
  adoptPendingReceipt = false,
  expectedGenerationId = undefined,
}) {
  // Step 0: read the pointer we intend to supersede. Everything downstream
  // (epoch, revision, CAS expectation) derives from this one read.
  const beforeRead = await readActivePointer(facade, baseDir);
  if (beforeRead.status === 'corrupted') {
    return fail('start', 'active_pointer_corrupted', beforeRead.error);
  }
  // A MISSING pointer means one of two very different things. On a genuinely
  // fresh store it is the ordinary first-commit case. On a store that LOST its
  // pointer it means the epoch high-water is unreadable, and minting from
  // `null` below would restart at 0 and re-issue epochs already handed out --
  // the exact PLUG-D19 collision commitRecoveredPointer exists to prevent.
  // Durable epoch evidence is what tells the two apart, so a store with any
  // evidence must go through recoverStore before it may commit again.
  if (beforeRead.status === 'missing') {
    const evidence = await gatherEpochEvidence(facade, baseDir);
    const exactBootstrapReceipt = adoptPendingReceipt
      && evidence.sources.receipts === 1 && evidence.sources.journal === 0
      && evidence.sources.priorPointer === 0 && evidence.epochs.length === 1
      && evidence.epochs[0] === 0;
    if (evidence.epochs.length > 0 && !exactBootstrapReceipt) {
      return fail('start', 'recovery_required', {
        observedEpochs: evidence.epochs.length,
        sources: evidence.sources,
      });
    }
  }
  const before = beforeRead.status === 'ok' ? beforeRead.pointer : null;
  if (expectedGenerationId !== undefined
    && (before?.generation_id || null) !== expectedGenerationId) {
    return fail('start', 'expected_generation_conflict', {
      expectedGenerationId, currentGenerationId: before?.generation_id || null,
    });
  }
  const expectedGeneration = before
    ? { commit_epoch: before.commit_epoch, revision: before.revision, generation_id: before.generation_id }
    : null;

  // Step 0.5: the stage fence on the single commit funnel.
  // It runs BEFORE the lease so a forbidden commit takes no lock, writes no
  // receipt, and leaves no bytes to collect: a refusal here is a true no-op.
  // It REFUSES rather than coercing. `filterToDisabledOnly` exists for callers
  // that want normalization, but silently rewriting a caller's requested state
  // at the durability layer would hide the bug that produced it -- and at
  // Stage 4, when `active` becomes legitimate, a silent rewrite would be an
  // outage rather than an error.
  for (const entry of Array.isArray(plugins) ? plugins : []) {
    try {
      assertStagePermitsState(entry && entry.effective_state, { stage: controlPlaneStage });
    } catch (error) {
      return fail('start', 'stage_forbids_state', {
        code: (error && error.code) || 'stage_forbids_state',
        publisherId: (entry && entry.publisher_id) || null,
        pluginId: (entry && entry.plugin_id) || null,
        state: (entry && entry.effective_state) === undefined ? null : String(entry.effective_state),
      });
    }
  }

  // Step 1: the single graph-scoped mutation lease (PLUG-D08).
  const lease = await acquireLease(facade, baseDir, {
    operationId,
    expectedGeneration,
    now,
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
  });
  if (!lease.ok) {
    return fail('start', lease.reason, { heldBy: lease.heldBy || null });
  }
  const ownerToken = lease.lease.owner_token;
  if (expectedGenerationId !== undefined) {
    const afterLeaseRead = await readActivePointer(facade, baseDir);
    const afterLeaseGenerationId = afterLeaseRead.status === 'ok' ? afterLeaseRead.pointer.generation_id : null;
    if (afterLeaseRead.status === 'corrupted' || afterLeaseGenerationId !== expectedGenerationId) {
      await releaseLease(facade, baseDir, { operationId, ownerToken });
      return fail('lease_acquired', 'expected_generation_conflict', {
        expectedGenerationId, currentGenerationId: afterLeaseGenerationId,
      });
    }
  }

  // Step 2: idempotency BEFORE any authority-bearing side effect (PLUG-D15).
  const idempotency = await evaluateIdempotency(facade, baseDir, { operationId, requestFingerprint, now });
  // Only `proceed_new` may execute. `join_pending` means a durable receipt for
  // this id is already staged and its outcome is NOT yet known -- re-running the
  // sequence on top of it re-executes an authority-bearing effect and, when the
  // first attempt had actually committed, walks into `generation_already_exists`
  // and settles the landed operation terminally as `failed`. A pending receipt
  // is reconciled by recoverStore (or read via evaluateStatusQuery); it is never
  // permission to execute again.
  const adopting = adoptPendingReceipt && idempotency.decision === 'join_pending';
  if (idempotency.decision !== 'proceed_new' && !adopting) {
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return fail('lease_acquired', idempotency.decision, { receiptStatus: idempotency.receipt?.status ?? null });
  }

  // The epoch this operation intends to commit is recorded in the pending
  // receipt. Recovery compares it against the pointer to decide, without
  // guessing, whether this operation's commit landed (see recovery.js).
  const nextEpoch = mintNextEpoch(before ? before.commit_epoch : null);
  const nextRevision = before ? before.revision + 1 : 1;

  // Cancellation checkpoint 1: no receipt or candidate bytes exist yet.
  if (cancellationRequested(isCanceled)) {
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return fail('idempotency_evaluated', 'operation_canceled', { checkpoint: 'pre_receipt' });
  }

  // Step 3: durable pending receipt.
  const pending = adopting ? { ok: idempotency.receipt.generation_id === generationId
      && idempotency.receipt.lifecycle_epoch === lifecycleEpoch
      && idempotency.receipt.commit_epoch === nextEpoch,
    reason: 'precreated_receipt_evidence_mismatch' }
    : await createPendingReceipt(facade, baseDir, {
      operationId, requestFingerprint, generationId, lifecycleEpoch, commitEpoch: nextEpoch, now,
    });
  if (!pending.ok) {
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return fail('idempotency_evaluated', pending.reason, pending.detail);
  }

  // Step 4: write the immutable candidate generation. Orphanable by design --
  // a crash here leaves bytes nothing points at, which GC reclaims.
  const written = await writeGeneration(facade, baseDir, {
    generationId,
    createdAt,
    plugins,
    policyGrantRef,
    dataSchemaRefs,
    generationSchemaVersion: generationSchemaVersion
      ?? (plugins.some((entry) => Array.isArray(entry.contributions)) ? 2 : 1),
    lockDigest,
    distributionStateDigest,
  });
  if (!written.ok) {
    await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return fail('receipt_pending', written.reason, written.detail);
  }

  // Cancellation checkpoint 2: the candidate is an immutable orphan, never
  // authority. A failed receipt makes recovery attribution explicit.
  if (cancellationRequested(isCanceled)) {
    await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return fail('generation_written', 'operation_canceled', { checkpoint: 'post_generation_write' });
  }

  // Post-await revalidation (invariant 11): another instance may have reclaimed
  // an expired lease and committed while we were writing bytes.
  const midRead = await readActivePointer(facade, baseDir);
  const midPointer = midRead.status === 'ok' ? midRead.pointer : null;
  if (before !== null) {
    const revalidated = revalidateAgainstCurrentGeneration(lease.lease, midPointer);
    if (!revalidated.ok) {
      await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
      await releaseLease(facade, baseDir, { operationId, ownerToken });
      return fail('generation_written', revalidated.reason, null);
    }
  }


  let prepared = { ok: true, skipped: true };
  if (typeof participantPrepare === 'function') {
    prepared = await invokeParticipantCallback(
      participantPrepare,
      {
        generation: written.record,
        prior_pointer: before,
        next_pointer: buildPointer({
          revision: nextRevision,
          commitEpoch: nextEpoch,
          generationId,
          generationDigest: written.record.graph_hash,
          committedAt: now,
        }),
      },
      'participant_prepare_failed'
    );
    if (!prepared.ok) {
      let reconciliation = null;
      if (prepared.ambiguous && typeof prepared.reconcile === 'function') {
        reconciliation = await invokeParticipantCallback(
          prepared.reconcile,
          { reason: prepared.reason, authority: 'prior_committed' },
          'participant_reconciliation_failed'
        );
      }
      await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
      await releaseLease(facade, baseDir, { operationId, ownerToken });
      return fail('generation_written', prepared.reason, {
        ambiguous: prepared.ambiguous === true,
        participantReconciled: reconciliation ? reconciliation.ok === true : null,
        requiresReconciliation: Boolean(
          prepared.ambiguous && (!reconciliation || reconciliation.ok !== true)
        ),
      });
    }
    const participantContract = validatePreparedParticipant(prepared);
    if (!participantContract.ok) {
      await settleReceipt(facade, baseDir, { operationId, status: 'failed', now });
      await releaseLease(facade, baseDir, { operationId, ownerToken });
      return fail('generation_written', participantContract.reason, {
        requiresReconciliation: true,
      });
    }
  }

  // Cancellation checkpoint 3: a participant may now hold the candidate, so
  // cancellation must restore the prior committed participant snapshot.
  if (cancellationRequested(isCanceled)) {
    return settlePrePointerFailure(facade, baseDir, {
      operationId,
      ownerToken,
      now,
      prepared,
      reason: 'operation_canceled',
      detail: { checkpoint: 'pre_pointer' },
    });
  }

  // Step 5: THE commit. Expected-generation CAS + epoch monotonicity live
  // inside commitActivePointer; a stale expectation fails closed here.
  const commitPointer = () => commitActivePointer(facade, baseDir, {
    expectedCurrent: expectedGeneration,
    // Re-verify lease ownership at the last instant before the authoritative
    // write. Without this, a lease that expired mid-operation lets this
    // operation overwrite a commit that legitimately reclaimed the lease --
    // two generations at one epoch.
    leaseGuard: async () => {
      const current = await readLease(facade, baseDir);
      if (current.status !== 'ok') {
        return { ok: false, reason: 'lease_not_held' };
      }
      return validateLeaseOwnership(current.lease, { operationId, ownerToken, now });
    },
    nextPointer: buildPointer({
      revision: nextRevision,
      commitEpoch: nextEpoch,
      generationId,
      generationDigest: written.record.graph_hash,
      committedAt: now,
    }),
  });
  const committed = typeof commitAuthority === 'function'
    ? await commitAuthority(commitPointer) : await commitPointer();
  if (!committed.ok) {
    return settlePrePointerFailure(facade, baseDir, {
      operationId,
      ownerToken,
      now,
      prepared,
      reason: committed.reason,
      detail: committed.detail,
    });
  }

  const participantCommit = await invokeParticipantCallback(
    prepared.commit,
    { pointer: committed.pointer },
    'participant_commit_settlement_failed'
  );

  // Step 6: settle the receipt. Authority is already committed; a crash
  // between step 5 and here is what recovery's "finish idempotently" path
  // exists for.
  const settled = await settleReceipt(facade, baseDir, {
    operationId,
    status: 'committed',
    terminalResultDigest: written.record.graph_hash,
    now,
  });
  if (!settled.ok) {
    // The pointer flip ALREADY landed, so this is the one failure that must not
    // read as "nothing happened": a caller treating ok:false as safe-to-retry
    // would commit a second generation. Report the commit that did land, and
    // release the lease like every other exit rather than holding the single
    // graph-scoped lease until it expires.
    await releaseLease(facade, baseDir, { operationId, ownerToken });
    return {
      ok: false,
      stage: 'pointer_committed',
      reason: settled.reason,
      detail: settled.detail === undefined ? null : settled.detail,
      committed: true,
      pointer: committed.pointer,
      commitEpoch: nextEpoch,
      revision: nextRevision,
      generationId,
      participantSettlement: participantCommit.ok === true,
    };
  }

  // Step 7: bounded evidence. Never fatal.
  const audit = buildAuditEvent({
    eventId: buildAuditEventId(operationId),
    sequence: nextEpoch,
    recordedAt: now,
    actor: auditActor,
    action: auditAction,
    outcome: 'committed',
    commitEpoch: nextEpoch,
    lifecycleEpoch,
    operationId,
  });
  const degraded = await appendEvidence(facade, baseDir, {
    entry: {
      kind: 'pointer_commit',
      recorded_at: now,
      operation_id: operationId,
      commit_epoch: nextEpoch,
      revision: nextRevision,
      generation_id: generationId,
    },
    auditEvent: audit.ok ? audit.event : null,
    auditBuildError: audit.ok ? null : audit.reason,
  });
  if (!participantCommit.ok) {
    degraded.push({ source: 'participant', error: participantCommit.reason });
  }

  await releaseLease(facade, baseDir, { operationId, ownerToken });

  if (!participantCommit.ok) {
    return {
      ok: false,
      stage: 'lease_released',
      reason: participantCommit.reason,
      committed: true,
      requiresReconciliation: true,
      pointer: committed.pointer,
      receipt: settled.receipt,
      commitEpoch: nextEpoch,
      revision: nextRevision,
      generationId,
      degradedEvidence: degraded,
      participantSettlement: false,
    };
  }

  return {
    ok: true,
    stage: 'lease_released',
    pointer: committed.pointer,
    receipt: settled.receipt,
    commitEpoch: nextEpoch,
    revision: nextRevision,
    generationId,
    degradedEvidence: degraded,
    participant: prepared.skipped === true ? null : (prepared.attestation || null),
  };
}

// Reads back the store's externally observable authority state. Used by every
// crash-injection assertion: after a crash + recovery, this must describe
// exactly one complete generation, never a mix.
async function readCommittedState(facade, baseDir) {
  const pointerRead = await readActivePointer(facade, baseDir);
  if (pointerRead.status !== 'ok') {
    return { pointerStatus: pointerRead.status, pointer: null, generation: null };
  }
  const generation = await readGeneration(facade, baseDir, pointerRead.pointer.generation_id);
  // The pointer names a generation AND asserts its digest. A record that merely
  // parses is not enough: if the pointer's `generation_digest` disagrees with
  // the record's own `graph_hash`, the authority document and the content it
  // claims to bind have come apart, and reporting it as servable would hide
  // exactly the corruption this read exists to surface.
  if (generation.ok && pointerRead.pointer.generation_digest !== generation.record.graph_hash) {
    return {
      pointerStatus: 'ok',
      pointer: pointerRead.pointer,
      generation: null,
      generationError: 'pointer_digest_mismatch',
    };
  }
  return {
    pointerStatus: 'ok',
    pointer: pointerRead.pointer,
    generation: generation.ok ? generation.record : null,
    generationError: generation.ok ? null : generation.reason,
  };
}

module.exports = {
  runCommitSequence,
  readCommittedState,
};
