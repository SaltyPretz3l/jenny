'use strict';

// Startup recovery and PLUG-D19 epoch high-water reconstruction.
//
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md "Recovery": "validate the active
// pointer and generation digest, reconcile participant revisions, finish or
// abandon staged operations idempotently, reconcile runtime-lease tombstones,
// verify content-store references, and clean abandoned staging ... If none is
// safe, Electron commits or selects a minimal plugins-disabled generation and
// keeps core local chat available."
//
// PLUG-D19: "`commit_epoch` recovery after pointer loss derives from the
// maximum durable epoch across receipts, journal, and retained generations plus
// a recorded safety increment; pointer corruption never resets epoch
// monotonicity."
//
// Evidence note, stated precisely because it matters for the guarantee:
// PluginGenerationV1 records carry no `commit_epoch` (a generation is content
// identity; the epoch is authority identity -- PLUG-D14 keeps them separate).
// So retained generations contribute *safe-candidate* evidence, while the epoch
// high-water comes from the three sources that DO record epochs: operation
// receipts, journal entries, and the retained prior pointer. The safety
// increment exists precisely because that evidence can itself be incomplete.
//
// Every classification below is fail-closed. Recovery never replays an
// authority-bearing effect, never lowers an epoch, and never promotes a
// pending operation it cannot prove committed.

const { readActivePointer, readPriorPointer, commitRecoveredPointer, buildPointer } = require('../store/active-pointer');
const { readGeneration, listGenerationIds } = require('../store/generation-store');
const { getReceipt, settleReceipt, OPERATIONS_DIR } = require('../store/operation-receipts');
const { readJournal, appendJournalEntry } = require('../store/journal');
const { recoverEpoch } = require('../store/commit-epoch');
const { joinPath } = require('../store/fs-facade');

const CONSISTENT = 'consistent';
const RECOVERED = 'recovered';
const PLUGINS_DISABLED_REQUIRED = 'plugins_disabled_required';
const READ_ONLY_INCOMPATIBLE = 'read_only_incompatible';
// Stage 4A supports stable V1 `active` generations without migration. The
// transitional states are process-local only and remain invalid if committed.
const FUTURE_STAGE_STATES = new Set(['preparing', 'disabling']);

function futureStageStates(record) {
  if (!record || !Array.isArray(record.plugins)) return [];
  // A generation may durably preserve a future desired_state as deferred intent
  // while forcing effective_state to installed_disabled. Only effective state
  // carries runtime authority and proves that a newer stage actually acted.
  return [...new Set(record.plugins
    .map((entry) => entry.effective_state)
    .filter((state) => FUTURE_STAGE_STATES.has(state)))].sort();
}

async function detectIncompatibleRetainedState(facade, baseDir, { preferGenerationId = null } = {}) {
  const generationIds = await listGenerationIds(facade, baseDir);
  const orderedIds = generationIds.slice().sort();
  if (preferGenerationId && orderedIds.includes(preferGenerationId)) {
    orderedIds.splice(orderedIds.indexOf(preferGenerationId), 1);
    orderedIds.unshift(preferGenerationId);
  }
  for (const generationId of orderedIds) {
    const generation = await readGeneration(facade, baseDir, generationId);
    if (!generation.ok && generation.reason === 'generation_schema_newer') {
      return {
        reason: 'generation_schema_newer',
        generationId,
        detail: generation.detail || null,
      };
    }
    if (!generation.ok) continue;
    const states = futureStageStates(generation.record);
    if (states.length > 0) {
      return {
        reason: 'future_stage_state_present',
        generationId,
        detail: { states },
      };
    }
  }
  return null;
}

async function listReceipts(facade, baseDir) {
  const names = await facade.list(joinPath(baseDir, OPERATIONS_DIR));
  const receipts = [];
  let corruptCount = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const operationId = name.slice(0, -'.json'.length);
    const existing = await getReceipt(facade, baseDir, operationId);
    if (existing.corrupted) {
      corruptCount += 1;
      continue;
    }
    if (existing.found) receipts.push(existing.receipt);
  }
  return { receipts, corruptCount };
}

// Every durable epoch this store can still prove it minted. Deliberately
// over-collects: a stale or superseded epoch only pushes the high-water UP,
// which is always safe, while missing one is what the safety increment covers.
async function gatherEpochEvidence(facade, baseDir) {
  const epochs = [];
  const sources = { receipts: 0, journal: 0, priorPointer: 0 };
  let maxRevision = 0;

  const { receipts, corruptCount } = await listReceipts(facade, baseDir);
  for (const receipt of receipts) {
    epochs.push(receipt.commit_epoch);
    sources.receipts += 1;
  }

  const { entries } = await readJournal(facade, baseDir);
  for (const entry of entries) {
    if (Number.isSafeInteger(entry.commit_epoch)) {
      epochs.push(entry.commit_epoch);
      sources.journal += 1;
    }
    if (Number.isSafeInteger(entry.revision) && entry.revision > maxRevision) {
      maxRevision = entry.revision;
    }
  }

  const prior = await readPriorPointer(facade, baseDir);
  if (prior.status === 'ok') {
    epochs.push(prior.pointer.commit_epoch);
    sources.priorPointer += 1;
    if (prior.pointer.revision > maxRevision) maxRevision = prior.pointer.revision;
  }

  return { epochs, sources, maxRevision, corruptReceiptCount: corruptCount };
}

// Picks an integrity-valid generation. The caller must apply any stage-specific
// trust/runtime validation before this record becomes authoritative again.
async function selectSafeCandidate(facade, baseDir, { preferGenerationId = null } = {}) {
  const tried = [];
  if (preferGenerationId) {
    const preferred = await readGeneration(facade, baseDir, preferGenerationId);
    tried.push({ generationId: preferGenerationId, ok: preferred.ok, reason: preferred.reason || null });
    if (preferred.ok) return { ok: true, record: preferred.record, tried };
  }
  // listGenerationIds order and generation ids carry no recency, so order
  // candidates by `created_at` with `generation_id` as a stable tiebreak.
  const ids = await listGenerationIds(facade, baseDir);
  const { receipts } = await listReceipts(facade, baseDir);
  const excludedGenerationIds = new Set(receipts
    .filter((receipt) => receipt.status !== 'committed')
    .map((receipt) => receipt.generation_id)
    .filter((generationId) => typeof generationId === 'string'));
  const readable = [];
  for (const generationId of ids.slice().sort()) {
    if (generationId === preferGenerationId) continue;
    if (excludedGenerationIds.has(generationId)) {
      tried.push({ generationId, ok: false, reason: 'receipt_not_committed' });
      continue;
    }
    const candidate = await readGeneration(facade, baseDir, generationId);
    tried.push({ generationId, ok: candidate.ok, reason: candidate.reason || null });
    if (candidate.ok) readable.push(candidate.record);
  }
  if (readable.length === 0) return { ok: false, tried };
  readable.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.generation_id < b.generation_id ? 1 : -1;
  });
  return { ok: true, record: readable[0], tried };
}

// "Finish or abandon staged operations idempotently." The pending receipt
// records the epoch the operation INTENDED to commit; the pointer records what
// actually committed. Comparing them classifies without guessing:
//
//   pointer.commit_epoch <  receipt.commit_epoch   it did not land   -> settle failed
//   pointer.commit_epoch >  receipt.commit_epoch   superseded by a later commit
//                                                  (only reachable via lease
//                                                  expiry + reclaim) -> settle
//                                                  indeterminate, never replay
//   no readable pointer                            -> settle indeterminate
//
// Epoch equality is not enough: a competing operation may have minted the same
// next epoch after reclaiming the lease. V1 receipts carry the candidate
// generation_id, so recovery attributes the pointer directly and never infers
// ownership from best-effort journal evidence.
function classifyPending(receipt, pointer) {
  if (!pointer) return 'indeterminate';
  if (pointer.commit_epoch < receipt.commit_epoch) return 'failed';
  if (pointer.commit_epoch > receipt.commit_epoch) return 'indeterminate';
  return pointer.generation_id === receipt.generation_id ? 'committed' : 'failed';
}

async function reconcilePendingReceipts(facade, baseDir, { pointer, now }) {
  const { receipts } = await listReceipts(facade, baseDir);
  const reconciled = [];
  for (const receipt of receipts) {
    if (receipt.status !== 'pending') continue;
    const status = classifyPending(receipt, pointer);
    const settled = await settleReceipt(facade, baseDir, { operationId: receipt.operation_id, status, now });
    reconciled.push({
      operationId: receipt.operation_id,
      status,
      ok: settled.ok,
      reason: settled.ok ? null : settled.reason,
    });
  }
  return reconciled;
}

// The single recovery entry point. Returns a bounded structured report; never
// throws for a domain reason.
async function recoverStore(facade, baseDir, { now, safetyIncrement, validateCandidate = null } = {}) {
  const pointerRead = await readActivePointer(facade, baseDir);
  // A downgraded build must preserve every newer retained generation,
  // not only the one currently named by the pointer. Otherwise pointer loss
  // could make recovery select an older generation and mutate the very store
  // whose newer bytes prove this build is not authoritative.
  const retainedIncompatibility = await detectIncompatibleRetainedState(facade, baseDir, {
    preferGenerationId: pointerRead.status === 'ok' ? pointerRead.pointer.generation_id : null,
  });
  if (retainedIncompatibility) {
    return {
      classification: READ_ONLY_INCOMPATIBLE,
      reason: retainedIncompatibility.reason,
      detail: retainedIncompatibility.detail,
      pointer: pointerRead.status === 'ok' ? pointerRead.pointer : null,
      generationId: retainedIncompatibility.generationId,
      reconciled: [],
      epochEvidence: null,
    };
  }

  // Path A: the pointer is readable. Authority is intact unless the generation
  // it names is unusable, in which case the pointer is pointing at nothing
  // serveable and we fall through to candidate selection.
  if (pointerRead.status === 'ok') {
    const generation = await readGeneration(facade, baseDir, pointerRead.pointer.generation_id);
    if (!generation.ok && generation.reason === 'generation_schema_newer') {
      return {
        classification: READ_ONLY_INCOMPATIBLE,
        reason: 'generation_schema_newer',
        detail: generation.detail || null,
        pointer: pointerRead.pointer,
        reconciled: [],
        epochEvidence: null,
      };
    }
    const incompatibleStates = generation.ok ? futureStageStates(generation.record) : [];
    if (incompatibleStates.length > 0) {
      return {
        classification: READ_ONLY_INCOMPATIBLE,
        reason: 'future_stage_state_present',
        detail: { states: incompatibleStates },
        pointer: pointerRead.pointer,
        generationId: generation.record.generation_id,
        reconciled: [],
        epochEvidence: null,
      };
    }
    // "Validate the active pointer AND generation digest." A record that passes
    // its own graph_hash check still has to be the one the pointer claims: a
    // pointer whose `generation_digest` was altered to another schema-valid
    // 64-hex value used to classify CONSISTENT, because nothing ever compared
    // the two sides of that binding.
    const digestMatches = generation.ok
      && pointerRead.pointer.generation_digest === generation.record.graph_hash;
    if (generation.ok && digestMatches) {
      const reconciled = await reconcilePendingReceipts(facade, baseDir, { pointer: pointerRead.pointer, now });
      return {
        classification: CONSISTENT,
        pointer: pointerRead.pointer,
        generationId: generation.record.generation_id,
        reconciled,
        epochEvidence: null,
      };
    }
    return {
      classification: PLUGINS_DISABLED_REQUIRED,
      reason: generation.ok ? 'pointer_digest_mismatch' : 'active_generation_unusable',
      detail: generation.ok
        ? {
          generationId: pointerRead.pointer.generation_id,
          pointerDigest: pointerRead.pointer.generation_digest,
          generationHash: generation.record.graph_hash,
        }
        : { generationId: pointerRead.pointer.generation_id, error: generation.reason },
      pointer: pointerRead.pointer,
      reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: pointerRead.pointer, now }),
      epochEvidence: null,
    };
  }

  // Path B: PLUG-D19. The pointer is missing or corrupt, so the current epoch
  // cannot be read. Rebuild it from durable evidence + safety increment, then
  // re-point at a safe candidate under a strictly higher epoch.
  const evidence = await gatherEpochEvidence(facade, baseDir);
  const recoveredEpoch = recoverEpoch({
    evidenceEpochs: evidence.epochs,
    ...(safetyIncrement === undefined ? {} : { safetyIncrement }),
  });

  const epochEvidence = {
    recoveredEpoch,
    observedEpochs: evidence.epochs.length,
    sources: evidence.sources,
    maxRevision: evidence.maxRevision,
    corruptReceiptCount: evidence.corruptReceiptCount,
  };

  if (evidence.corruptReceiptCount !== 0) {
    return {
      classification: PLUGINS_DISABLED_REQUIRED,
      reason: 'operation_receipt_corrupted',
      detail: { corruptReceiptCount: evidence.corruptReceiptCount, pointerStatus: pointerRead.status },
      pointer: null,
      reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: null, now }),
      epochEvidence,
    };
  }

  const prior = await readPriorPointer(facade, baseDir);
  const preferGenerationId = prior.status === 'ok' ? prior.pointer.generation_id : null;
  const candidate = await selectSafeCandidate(facade, baseDir, { preferGenerationId });

  // Total epoch-evidence loss. A retained generation exists, which PROVES some
  // epoch was once minted (a generation only exists because a commit created
  // it) -- but every source that records how high epochs climbed is gone. Any
  // epoch we mint here could collide with one already handed out to a token,
  // approval, view, or progress stream, which is exactly what PLUG-D19 exists
  // to prevent ("recovered epochs never collide with previously minted
  // epochs"). No algorithm can reconstruct the high-water from nothing, so
  // recovery fails closed into the plugins-disabled generation rather than
  // guessing low. A fresh store with no generations at all is NOT this case:
  // nothing was ever minted there, and it falls through to candidate selection.
  if (evidence.epochs.length === 0 && candidate.ok) {
    return {
      classification: PLUGINS_DISABLED_REQUIRED,
      reason: 'epoch_evidence_lost',
      detail: { retainedGenerationId: candidate.record.generation_id },
      pointer: null,
      reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: null, now }),
      epochEvidence,
    };
  }

  if (!candidate.ok) {
    return {
      classification: PLUGINS_DISABLED_REQUIRED,
      reason: 'no_safe_candidate_generation',
      detail: { tried: candidate.tried, pointerStatus: pointerRead.status },
      pointer: null,
      reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: null, now }),
      epochEvidence,
    };
  }

  const nextPointer = buildPointer({
    revision: evidence.maxRevision + 1,
    commitEpoch: recoveredEpoch,
    generationId: candidate.record.generation_id,
    generationDigest: candidate.record.graph_hash,
    committedAt: now,
  });
  if (typeof validateCandidate === 'function') {
    let validated;
    try {
      validated = await validateCandidate({ generation: candidate.record, pointer: nextPointer });
    } catch (_error) {
      validated = { ok: false, reason: 'candidate_validation_failed' };
    }
    if (!validated || validated.ok !== true) {
      const rawReason = String(validated?.reason || 'candidate_validation_failed');
      const reason = /^[a-z][a-z0-9_]{0,63}$/.test(rawReason)
        ? rawReason
        : 'candidate_validation_failed';
      return {
        classification: PLUGINS_DISABLED_REQUIRED,
        reason: 'candidate_reverification_failed',
        detail: { reason },
        pointer: null,
        reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: null, now }),
        epochEvidence,
      };
    }
  }

  const committed = await commitRecoveredPointer(facade, baseDir, {
    nextPointer,
    recoveredEpoch,
    maxKnownRevision: evidence.maxRevision,
  });
  if (!committed.ok) {
    return {
      classification: PLUGINS_DISABLED_REQUIRED,
      reason: committed.reason,
      detail: committed.detail || null,
      pointer: null,
      reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: null, now }),
      epochEvidence,
    };
  }

  // A recovered epoch that lives ONLY in the pointer pair is not durable
  // evidence: losing both pointer files again re-derives the high-water from
  // receipts and journal, which still top out below it, and the next recovery
  // re-mints an epoch this one already published (observed re-minting 5 after 5).
  // Recording it in the journal gives the high-water a witness outside the very
  // files whose loss triggers recovery. The append is best-effort like every
  // other journal write -- it is evidence, never authority (PLUG-D01).
  const evidenceDegraded = [];
  try {
    await appendJournalEntry(facade, baseDir, {
      kind: 'recovery_epoch',
      recorded_at: now,
      commit_epoch: recoveredEpoch,
      revision: committed.pointer.revision,
      generation_id: candidate.record.generation_id,
    });
  } catch (error) {
    evidenceDegraded.push({ source: 'journal', error: (error && error.message) || String(error) });
  }

  return {
    classification: RECOVERED,
    pointer: committed.pointer,
    generationId: candidate.record.generation_id,
    reconciled: await reconcilePendingReceipts(facade, baseDir, { pointer: committed.pointer, now }),
    epochEvidence,
    degradedEvidence: evidenceDegraded,
  };
}

module.exports = {
  CONSISTENT,
  RECOVERED,
  PLUGINS_DISABLED_REQUIRED,
  READ_ONLY_INCOMPATIBLE,
  FUTURE_STAGE_STATES,
  futureStageStates,
  detectIncompatibleRetainedState,
  listReceipts,
  gatherEpochEvidence,
  selectSafeCandidate,
  reconcilePendingReceipts,
  recoverStore,
};
