'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const {
  cloneBoundedJsonObject,
  normalizePluginOperationMetadata,
} = require('../../backend/session-type');
const { PLUGIN_SESSION_LIMITS } = require('../../plugin-session-budgets');

const POLL_INTERVAL_MS = PLUGIN_SESSION_LIMITS.poll_interval_ms;
const POLL_BACKOFF_MAX_MS = PLUGIN_SESSION_LIMITS.poll_backoff_max_ms;
const MAX_STATUS_FRAMES = PLUGIN_SESSION_LIMITS.poll_frame_batch;
const MAX_OPERATION_DATA_BYTES = 64 * 1024;
const MAX_OPERATION_DATA_KEYS = 64;

function token(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function authorityMatches(left, right) {
  return Boolean(left && right
    && left.active_generation_id === right.active_generation_id
    && left.commit_epoch === right.commit_epoch
    && left.registry_revision === right.registry_revision
    && left.dependency_graph_hash === right.dependency_graph_hash);
}

function terminalContent(status, reason, actionName = 'Plugin operation') {
  const subject = token(actionName, 120) || 'Plugin operation';
  if (status === 'cancelled') return `${subject} was cancelled.`;
  if (status !== 'succeeded') {
    return `${subject} failed (${token(reason || 'operation_failed', 64)}).`;
  }
  return `${subject} completed.`;
}

function schedulePoll(owner, record, delay = POLL_INTERVAL_MS) {
  if (owner.disposed || record.terminalReceived || record.settled) return;
  record.timer = owner.setTimeoutFn(() => { void owner._poll(record); }, delay);
  record.timer?.unref?.();
}

function recordIdentityIsCurrent(owner, record) {
  if (!authorityMatches(record.authority, owner.runtime.currentAuthority?.())) return false;
  const session = owner.sessionStore.getSession(record.sessionId);
  const active = session?.plugin_session?.active_operation;
  return session?.session_incarnation === record.sessionIncarnation
    && active?.operation_id === record.operationId
    && active?.attempt === record.attempt;
}

function beginHostStartup(owner, record) {
  record.startupPromise = Promise.resolve().then(() => owner.runtime.acquireHost({
    authority: record.authority,
    contributionId: record.descriptor.contribution_id,
    descriptor: record.descriptor,
  })).catch(() => ({ ok: false, reason: 'host_session_unavailable' })).then((acquired) => {
    if (acquired?.ok && acquired.session) {
      record.host = acquired.session;
      record.hostSessionId = token(acquired.session.session_id, 96);
      record.hostSessionEpoch = Number(acquired.session.session_epoch);
    }
    return acquired;
  });
  return record.startupPromise;
}

async function poll(owner, record) {
  if (owner.disposed || record.terminalReceived || record.settled
    || owner.operations.get(record.operationId) !== record) return;
  if (!recordIdentityIsCurrent(owner, record)) {
    owner.log('plugins.session_provider.poll_rejected', {
      reason_code: 'operation_authority_stale',
    });
    await owner._settle(record, 'interrupted', 'operation_authority_stale');
    return;
  }
  let response;
  try {
    response = await record.host.status({ operation_id: record.operationId,
      attempt: record.attempt, since_sequence: record.sequence });
  } catch (_error) {
    await owner._settle(record, 'failed', 'host_status_unavailable');
    return;
  }
  if (response?.ok !== true) {
    await owner._settle(record, 'failed', token(response?.reason, 64) || 'host_status_rejected');
    return;
  }
  if (!recordIdentityIsCurrent(owner, record)) {
    owner.log('plugins.session_provider.poll_rejected', {
      reason_code: 'operation_authority_stale',
    });
    await owner._settle(record, 'interrupted', 'operation_authority_stale');
    return;
  }
  const frames = Array.isArray(response?.frames) ? response.frames.slice(0, MAX_STATUS_FRAMES) : [];
  for (const frame of frames) {
    const checked = validate('PluginStreamFrameV1', frame);
    if (!checked.ok || checked.value.invocation_id !== record.operationId
      || checked.value.commit_epoch !== record.authority.commit_epoch
      || checked.value.lifecycle_epoch !== record.hostSessionEpoch
      || checked.value.sequence !== record.sequence) {
      owner.log('plugins.session_provider.frame_rejected', { reason_code: 'frame_identity_mismatch' });
      continue;
    }
    record.sequence += 1;
    record.frames.push(checked.value);
    if (record.frames.length > 64) record.frames.shift();
    if (checked.value.frame.kind === 'data') {
      let parsed;
      try { parsed = safeObject(JSON.parse(checked.value.frame.payload)); }
      catch (_error) { continue; }
      const data = { ...record.data, ...parsed };
      if (Object.keys(data).length > MAX_OPERATION_DATA_KEYS
        || Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_OPERATION_DATA_BYTES) {
        await owner._settle(record, 'failed', 'operation_data_limit_exceeded');
        return;
      }
      record.data = data;
    }
    if (checked.value.frame.kind === 'terminal') {
      await owner._settle(record, checked.value.frame.status,
        checked.value.frame.reason_code || '', { ...record.data, ...safeObject(response.result) });
      return;
    }
  }
  owner.sessionStore.updateSession(record.sessionId, (current) => {
    const active = current.plugin_session?.active_operation;
    if (!active || active.operation_id !== record.operationId || active.attempt !== record.attempt) {
      return null;
    }
    return { plugin_session: { ...current.plugin_session, active_operation: {
      ...active, status: active.status === 'cancelling' ? 'cancelling' : 'running',
      frame_sequence: record.sequence,
    } } };
  });
  const requestedDelay = Number(response.poll_after_ms);
  const delay = Number.isSafeInteger(requestedDelay)
    ? Math.max(POLL_INTERVAL_MS, Math.min(POLL_BACKOFF_MAX_MS, requestedDelay))
    : POLL_INTERVAL_MS;
  schedulePoll(owner, record, delay);
}

async function settle(owner, record, status, reason = '', result = {}) {
  if (record.settled) return { ok: true, duplicate: true };
  if (record.settlementPromise) return record.settlementPromise;
  record.terminalReceived = true;
  record.pendingSettlement ||= { status, reason, result: safeObject(result) };
  if (record.timer) {
    owner.clearTimeoutFn(record.timer);
    record.timer = null;
  }
  const pending = record.pendingSettlement;
  record.settlementPromise = completeSettlement(
    owner, record, pending.status, pending.reason, pending.result
  );
  const settled = await record.settlementPromise;
  record.settlementPromise = null;
  return settled;
}

async function completeSettlement(owner, record, status, reason = '', result = {}) {
  if (record.startupPromise) {
    try { await record.startupPromise; } catch (_error) {
      // A rejected launch is equivalent to an absent host for cleanup.
    }
  }
  let termination = { terminated: true, tree_empty: true, already_absent: true };
  if (record.host) {
    try {
      termination = await owner.runtime.terminateHost({ authority: record.authority,
        descriptor: record.descriptor, reason: `operation_${status}` });
    } catch (_error) {
      termination = { terminated: false, tree_empty: false, reason: 'termination_failed' };
    }
  }
  if (termination?.terminated !== true || termination?.tree_empty !== true) {
    owner.sessionStore.updateSession(record.sessionId, (current) => {
      const active = current.plugin_session?.active_operation;
      if (!active || active.operation_id !== record.operationId || active.attempt !== record.attempt) {
        return null;
      }
      return { plugin_session: { ...current.plugin_session,
        active_operation: { ...active, status: 'cleanup_pending' } } };
    });
    owner.log('plugins.session_provider.cleanup_pending', { reason_code: 'tree_death_unproven' });
    return { ok: false, reason: 'tree_death_unproven' };
  }
  let attachment = record.publishedAttachment;
  if (!attachment && status === 'succeeded'
    && result.artifact && typeof result.artifact === 'object') {
    try {
      attachment = owner.publishArtifact({ fsImpl: owner.fs,
        attachmentAssetStore: owner.attachmentAssetStore,
        scratchDirectory: record.scratchDirectory,
        stagedFile: result.artifact.staged_file,
        expectedDigest: result.artifact.sha256,
        expectedWidth: Number(result.artifact.width) || 0,
        expectedHeight: Number(result.artifact.height) || 0,
        identity: { publisher_id: record.descriptor.publisher_id,
          plugin_id: record.descriptor.plugin_id,
          plugin_version: record.descriptor.plugin_version,
          provider_contribution_id: record.descriptor.contribution_id },
        operationId: record.operationId,
        provenance: result.artifact.provenance || result,
      }).attachment;
      record.publishedAttachment = attachment;
    } catch (error) {
      status = 'failed';
      reason = token(error?.code || 'plugin_artifact_rejected', 64);
    }
  }
  const normalizedStatus = ['succeeded', 'failed', 'cancelled', 'timeout', 'rejected', 'interrupted']
    .includes(status) ? status : 'failed';
  const runtimeStatus = cloneBoundedJsonObject(result.runtime_status, 16 * 1024);
  if (runtimeStatus) owner._rememberProviderStatus(owner._providerStatusKey({
    authority: record.authority, descriptor: record.descriptor,
  }), runtimeStatus);
  const committed = owner.sessionStore.updateSession(record.sessionId, (current) => {
    const active = current.plugin_session?.active_operation;
    if (!active || active.operation_id !== record.operationId || active.attempt !== record.attempt
      || current.session_incarnation !== record.sessionIncarnation) return null;
    const metadata = normalizePluginOperationMetadata({ operation_id: record.operationId,
      attempt: record.attempt, action_id: record.action.action_id, status: normalizedStatus,
      reason_code: reason });
    return {
      plugin_session: { ...current.plugin_session, active_operation: null },
      messages: current.messages.map((message) => message.id === record.assistantMessageId ? {
        ...message,
        content: terminalContent(normalizedStatus, reason, record.action.name),
        status: normalizedStatus === 'succeeded' ? 'complete'
          : (normalizedStatus === 'cancelled' ? 'cancelled' : 'runtime_error'),
        ...(attachment ? { attachments: [attachment] } : {}),
        ...(metadata ? { plugin_operation: metadata } : {}),
      } : message),
    };
  });
  if (!committed) {
    owner.log('plugins.session_provider.settlement_commit_failed', {
      reason_code: 'plugin_operation_settlement_conflict',
    });
    return { ok: false, reason: 'plugin_operation_settlement_conflict', retryable: true };
  }
  if (record.leaseId) owner.exclusiveGpu.releaseLease(record.leaseId, record.owner);
  owner._removeScratch(record.scratchDirectory);
  record.settled = true;
  record.pendingSettlement = null;
  owner.operations.delete(record.operationId);
  return { ok: true, status: normalizedStatus };
}

module.exports = {
  MAX_OPERATION_DATA_BYTES,
  MAX_OPERATION_DATA_KEYS,
  MAX_STATUS_FRAMES,
  POLL_INTERVAL_MS,
  authorityMatches,
  beginHostStartup,
  completeSettlement,
  poll,
  recordIdentityIsCurrent,
  safeObject,
  schedulePoll,
  settle,
  terminalContent,
  token,
};
