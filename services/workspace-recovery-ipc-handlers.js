'use strict';

// Validating Electron edge for WO-25a's user-initiated recovery RPCs.
const { registerIpcInvokeHandlers } = require('./ipc-contract');
const { API_VERSION } = require('./backend/sidecar-client');
const { TOOL_ERROR_CODES } = require('./backend/error-codes');
const { isPlainObject } = require('./value-utils');

const METHODS = Object.freeze({
  list: 'workspace.list_change_sets',
  preflight: 'workspace.preflight_undo',
  undo: 'workspace.undo_change_set',
  restoreTrash: 'workspace.restore_trash_entry',
  abandonRestore: 'workspace.abandon_restore',
});
const OUTCOMES = new Set(['skip', 'alternate_name', 'protect_then_replace']);
const CHANGE_SET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_ID_PATTERN = /^[1-9][0-9]*\.[1-9][0-9]*$/;
const TRASH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_CHANGE_SETS = 200;
const MAX_RECOVERY_ITEMS = 500;
const MAX_PATH_LENGTH = 4096;
const MAX_MESSAGE_LENGTH = 512;
const RECOVERY_ERROR_CODE = TOOL_ERROR_CODES.EXECUTION_FAILED;

function boundedText(value, maxLength, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (required && !value)) return null;
  return value;
}

function boundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function failure(reason, message, extra = {}) {
  return {
    ok: false,
    error_code: RECOVERY_ERROR_CODE,
    reason,
    message: String(message || 'Workspace recovery request failed.').slice(0, MAX_MESSAGE_LENGTH),
    ...extra,
  };
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeChangeSetId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return CHANGE_SET_ID_PATTERN.test(id) ? id.toLowerCase() : '';
}

function normalizeStepId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id.length <= 32 && STEP_ID_PATTERN.test(id) ? id : '';
}

function normalizeDecisions(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(value)) return { ok: false };
  const entries = Object.entries(value);
  if (entries.length > MAX_RECOVERY_ITEMS) return { ok: false };
  const decisions = {};
  for (const [rawStepId, rawOutcome] of entries) {
    const stepId = normalizeStepId(rawStepId);
    const outcome = typeof rawOutcome === 'string' ? rawOutcome : '';
    if (!stepId || !OUTCOMES.has(outcome)) return { ok: false };
    decisions[stepId] = outcome;
  }
  return { ok: true, value: decisions };
}

function normalizeTrashName(value) {
  return typeof value === 'string' && TRASH_NAME_PATTERN.test(value) ? value : '';
}

function normalizeOutsideUndoSet(value) {
  if (!isPlainObject(value)) return null;
  const shellMutations = boundedText(value.shell_mutations, 80) ?? '';
  const explorerRename = boundedText(value.explorer_rename, 80) ?? '';
  const warning = boundedText(value.warning, MAX_MESSAGE_LENGTH) ?? '';
  if (!Array.isArray(value.known_unjournaled_events)
    || value.known_unjournaled_events.length > MAX_RECOVERY_ITEMS) return null;
  const events = value.known_unjournaled_events.map((item) => boundedText(item, 160, { required: true }));
  if (events.some((item) => item === null)) return null;
  return {
    shell_mutations: shellMutations,
    explorer_rename: explorerRename,
    known_unjournaled_events: events,
    warning,
  };
}

function normalizeSignature(value) {
  if (!isPlainObject(value)) return null;
  const kind = ['missing', 'file', 'directory', 'symlink', 'junction', 'other'].includes(value.kind)
    ? value.kind : '';
  const byteSize = boundedInteger(value.byte_size, Number.MAX_SAFE_INTEGER);
  const sha256 = typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256)
    ? value.sha256.toLowerCase() : '';
  return kind && byteSize !== null && sha256 ? { kind, byte_size: byteSize, sha256 } : null;
}

function normalizePath(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  return boundedText(value, MAX_PATH_LENGTH) ?? undefined;
}

function normalizeStep(value) {
  if (!isPlainObject(value)) return null;
  const sequence = boundedInteger(value.sequence, 10_000);
  const inverseStepId = normalizeStepId(value.inverse_step_id);
  const kinds = [
    'move_to_stage', 'move_back', 'restore_object', 'remove_created',
    'restore_protected_occupant', 'remove_empty_parent',
  ];
  const kind = kinds.includes(value.kind) ? value.kind : '';
  const fromPath = normalizePath(value.from_relative_path, { nullable: true });
  const toPath = normalizePath(value.to_relative_path, { nullable: true });
  const signature = normalizeSignature(value.expected_current_signature);
  if (sequence === null || !inverseStepId || !kind || !signature
    || fromPath === undefined || toPath === undefined) return null;
  return {
    sequence,
    inverse_step_id: inverseStepId,
    kind,
    from_relative_path: fromPath,
    to_relative_path: toPath,
    expected_current_signature: signature,
  };
}

function normalizeConflict(value) {
  if (!isPlainObject(value)) return null;
  const inverseStepId = normalizeStepId(value.inverse_step_id);
  const sequence = boundedInteger(value.sequence, 10_000);
  const relativePath = normalizePath(value.relative_path);
  const reasons = Array.isArray(value.reasons) && value.reasons.length <= 8
    ? value.reasons.map((item) => boundedText(item, 80, { required: true })) : [];
  const allowed = Array.isArray(value.allowed_outcomes) ? value.allowed_outcomes : [];
  const kinds = ['move_back', 'restore_object', 'remove_created', 'restore_protected_occupant'];
  const expectedSignature = normalizeSignature(value.expected_signature);
  const currentSignature = normalizeSignature(value.current_signature);
  if (!inverseStepId || sequence === null || relativePath === undefined || reasons.some((item) => item === null)
    || !kinds.includes(value.kind) || !expectedSignature || !currentSignature
    || allowed.length !== OUTCOMES.size || new Set(allowed).size !== OUTCOMES.size
    || allowed.some((item) => !OUTCOMES.has(item))) return null;
  return {
    inverse_step_id: inverseStepId,
    sequence,
    kind: value.kind,
    relative_path: relativePath,
    reasons,
    expected_signature: expectedSignature,
    current_signature: currentSignature,
    allowed_outcomes: [...allowed],
  };
}

function normalizeStagingEntry(value) {
  if (!isPlainObject(value)) return null;
  const inverseStepId = normalizeStepId(value.inverse_step_id);
  const stagePath = normalizePath(value.stage_relative_path);
  const signature = normalizeSignature(value.expected_signature);
  return inverseStepId && stagePath !== undefined && signature ? {
    inverse_step_id: inverseStepId,
    stage_relative_path: stagePath,
    expected_signature: signature,
  } : null;
}

function normalizeArray(value, normalizer) {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_ITEMS) return null;
  const normalized = value.map(normalizer);
  return normalized.some((item) => item === null) ? null : normalized;
}

function hasUniqueIds(items, key) {
  const ids = items.map((item) => item[key]);
  return ids.every(Boolean) && new Set(ids).size === ids.length;
}

function normalizeChangeSetSummary(value) {
  if (!isPlainObject(value)) return null;
  const changeSetId = normalizeChangeSetId(value.change_set_id);
  const operationCount = boundedInteger(value.operation_count, 10_000);
  const state = ['prepared', 'in_progress', 'committed', 'rolled_back', 'interrupted'].includes(value.state)
    ? value.state : '';
  const restoreStatus = ['not_requested', 'preflight', 'in_progress', 'committed', 'interrupted', 'abandoned'].includes(value.restore_status)
    ? value.restore_status : '';
  const updatedAt = boundedText(value.updated_at, 64, { required: true });
  const warning = boundedText(value.warning, MAX_MESSAGE_LENGTH) ?? '';
  if (!changeSetId || operationCount === null || !state || !restoreStatus || !updatedAt
    || typeof value.partially_undoable !== 'boolean') return null;
  return {
    change_set_id: changeSetId,
    state,
    restore_status: restoreStatus,
    operation_count: operationCount,
    updated_at: updatedAt,
    partially_undoable: value.partially_undoable,
    warning,
  };
}

function normalizeListResult(result) {
  if (!isPlainObject(result) || !Array.isArray(result.change_sets)
    || result.change_sets.length > MAX_CHANGE_SETS) return null;
  const workspaceId = boundedText(result.workspace_id, 160, { required: true });
  const outside = normalizeOutsideUndoSet(result.outside_undo_set);
  const changeSets = result.change_sets.map(normalizeChangeSetSummary);
  if (!workspaceId || !outside || changeSets.some((item) => item === null)
    || !hasUniqueIds(changeSets, 'change_set_id')) return null;
  return { workspace_id: workspaceId, change_sets: changeSets, outside_undo_set: outside };
}

function normalizePreflightResult(result) {
  if (!isPlainObject(result) || result.status !== 'preflight') return null;
  const changeSetId = normalizeChangeSetId(result.change_set_id);
  const conflicts = normalizeArray(result.conflicts, normalizeConflict);
  const plan = normalizeArray(result.inverse_plan, normalizeStep);
  const staging = normalizeArray(result.staging_entries, normalizeStagingEntry);
  const outside = normalizeOutsideUndoSet(result.outside_undo_set);
  if (!changeSetId || !conflicts || !plan || !staging || !outside
    || !hasUniqueIds(conflicts, 'inverse_step_id') || !hasUniqueIds(plan, 'inverse_step_id')
    || !hasUniqueIds(staging, 'inverse_step_id')) return null;
  const planIds = new Set(plan.map((step) => step.inverse_step_id));
  if (conflicts.some((conflict) => !planIds.has(conflict.inverse_step_id))
    || staging.some((entry) => !planIds.has(entry.inverse_step_id))) return null;
  return {
    change_set_id: changeSetId,
    status: 'preflight',
    conflicts,
    inverse_plan: plan,
    staging_entries: staging,
    outside_undo_set: outside,
  };
}

function normalizeReceiptRow(value) {
  if (!isPlainObject(value)) return null;
  const result = {};
  for (const key of ['inverse_step_id', 'relative_path', 'restored_relative_path', 'object_id', 'workspace_relative_path']) {
    if (value[key] === undefined) continue;
    const normalized = key === 'inverse_step_id' ? normalizeStepId(value[key]) : normalizePath(value[key]);
    if (!normalized) return null;
    result[key] = normalized;
  }
  if (value.signature !== undefined) {
    result.signature = normalizeSignature(value.signature);
    if (!result.signature) return null;
  }
  return Object.keys(result).length ? result : null;
}

function normalizeReceipt(result, { trash = false } = {}) {
  if (!isPlainObject(result) || !['committed', 'needs_review'].includes(result.status)) return null;
  const restored = normalizeArray(result.restored, normalizeReceiptRow);
  const skipped = normalizeArray(result.skipped, normalizeReceiptRow);
  const renamedTo = normalizeArray(result.renamed_to, normalizeReceiptRow);
  const protectedRows = normalizeArray(result.protected, normalizeReceiptRow);
  const outside = normalizeOutsideUndoSet(result.outside_undo_set);
  if (!restored || !skipped || !renamedTo || !protectedRows || !outside) return null;
  const receipt = {
    status: result.status,
    restored,
    skipped,
    renamed_to: renamedTo,
    protected: protectedRows,
    outside_undo_set: outside,
  };
  if (trash) {
    const name = normalizeTrashName(result.name);
    if (!name || (result.recovery_retained !== undefined && typeof result.recovery_retained !== 'boolean')) return null;
    receipt.name = name;
    if (result.recovery_retained !== undefined) receipt.recovery_retained = result.recovery_retained;
  } else {
    const changeSetId = normalizeChangeSetId(result.change_set_id);
    if (!changeSetId) return null;
    receipt.change_set_id = changeSetId;
  }
  return receipt;
}

function normalizeResult(method, result) {
  if (method === METHODS.list) return normalizeListResult(result);
  if (method === METHODS.preflight) return normalizePreflightResult(result);
  if (method === METHODS.undo) return normalizeReceipt(result);
  if (method === METHODS.abandonRestore) return normalizeChangeSetSummary(result);
  return normalizeReceipt(result, { trash: true });
}

function structuredRpcFailure(error) {
  const rpc = isPlainObject(error?.rpc) ? error.rpc : {};
  const data = isPlainObject(rpc.data) ? rpc.data : {};
  // Worker-family caps report their CMP code under data.code; transport-level
  // failures carry it on the error itself.
  const errorCode = boundedText(data.error_code, 80) || boundedText(data.code, 80)
    || boundedText(error?.errorCode, 80) || boundedText(error?.error_code, 80) || RECOVERY_ERROR_CODE;
  const reason = boundedText(data.reason, 120) || 'workspace_recovery_failed';
  const message = boundedText(rpc.message, MAX_MESSAGE_LENGTH)
    || boundedText(error?.message, MAX_MESSAGE_LENGTH)
    || 'Workspace recovery request failed.';
  const extra = data.status === 'needs_review' ? { status: 'needs_review' } : {};
  if (Array.isArray(data.required_inverse_step_ids) && data.required_inverse_step_ids.length <= MAX_RECOVERY_ITEMS) {
    const ids = data.required_inverse_step_ids.map(normalizeStepId);
    if (ids.every(Boolean)) extra.required_inverse_step_ids = ids;
  }
  return { ...failure(reason, message, extra), error_code: errorCode };
}

async function callRecoveryRpc(backendService, method, params) {
  if (!backendService?.sidecarClient) {
    return failure('sidecar_unavailable', 'Workspace recovery is unavailable right now.');
  }
  try {
    const raw = await backendService.sidecarClient.request(method, {
      accept_version: API_VERSION,
      ...params,
    });
    const result = normalizeResult(method, raw);
    return result
      ? { ok: true, ...result }
      : failure('recovery_response_invalid', 'Workspace recovery returned an invalid response.');
  } catch (error) {
    return structuredRpcFailure(error);
  }
}

function registerWorkspaceRecoveryIpcHandlers({ ipcMainLike, backendService, ipcAuthorization = {} }) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'workspaceRecovery.listChangeSets': (_event, payload = {}) => (
      hasOnlyKeys(payload, [])
        ? callRecoveryRpc(backendService, METHODS.list, {})
        : failure('payload_invalid', 'The list request was invalid.')
    ),
    'workspaceRecovery.preflightUndo': (_event, payload = {}) => {
      if (!hasOnlyKeys(payload, ['changeSetId'])) return failure('payload_invalid', 'The preflight request was invalid.');
      const changeSetId = normalizeChangeSetId(payload.changeSetId);
      return changeSetId
        ? callRecoveryRpc(backendService, METHODS.preflight, { change_set_id: changeSetId })
        : failure('change_set_id_invalid', 'The change set id was invalid.');
    },
    'workspaceRecovery.undoChangeSet': (_event, payload = {}) => {
      if (!hasOnlyKeys(payload, ['changeSetId', 'decisions'])) return failure('payload_invalid', 'The undo request was invalid.');
      const changeSetId = normalizeChangeSetId(payload.changeSetId);
      const decisions = normalizeDecisions(payload.decisions);
      if (!changeSetId) return failure('change_set_id_invalid', 'The change set id was invalid.');
      if (!decisions.ok) return failure('decisions_invalid', 'The undo decisions were invalid.');
      return callRecoveryRpc(backendService, METHODS.undo, {
        change_set_id: changeSetId,
        ...(decisions.value !== undefined ? { decisions: decisions.value } : {}),
      });
    },
    'workspaceRecovery.restoreTrashEntry': (_event, payload = {}) => {
      if (!hasOnlyKeys(payload, ['name', 'decision'])) return failure('payload_invalid', 'The trash restore request was invalid.');
      const name = normalizeTrashName(payload.name);
      const decision = payload.decision;
      if (!name) return failure('trash_entry_name_invalid', 'The trash entry name was invalid.');
      if (decision !== undefined && !OUTCOMES.has(decision)) {
        return failure('decision_invalid', 'The restore decision was invalid.');
      }
      return callRecoveryRpc(backendService, METHODS.restoreTrash, {
        name,
        ...(decision !== undefined ? { decision } : {}),
      });
    },
    'workspaceRecovery.abandonRestore': (_event, payload = {}) => {
      if (!hasOnlyKeys(payload, ['workspaceId', 'changeSetId'])) {
        return failure('payload_invalid', 'The abandon restore request was invalid.');
      }
      const workspaceId = boundedText(payload.workspaceId, 160, { required: true });
      const changeSetId = normalizeChangeSetId(payload.changeSetId);
      if (!workspaceId) return failure('workspace_id_invalid', 'The workspace id was invalid.');
      if (!changeSetId) return failure('change_set_id_invalid', 'The change set id was invalid.');
      return callRecoveryRpc(backendService, METHODS.abandonRestore, {
        workspace_id: workspaceId,
        change_set_id: changeSetId,
      });
    },
  }, ipcAuthorization);
}

module.exports = { registerWorkspaceRecoveryIpcHandlers };
