'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { validate } = require('../contracts/generated-plugin-contracts');
const {
  PLUGIN_SESSION_STATE_MAX_BYTES,
  cloneBoundedJsonObject,
  normalizePluginOperationMetadata,
  normalizePluginSession,
} = require('../../backend/session-type');
const { buildTranscriptPage } = require('./session-context');
const { PLUGIN_SESSION_LIMITS } = require('../../plugin-session-budgets');
const { publishGeneratedArtifact } = require('../artifacts/generated-artifact-publisher');
const {
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
} = require('./operation-lifecycle');

const HOST_ARGUMENT_MAX_BYTES = PLUGIN_SESSION_LIMITS.invoke_arguments_bytes;
const TRANSCRIPT_PRESENTATION_MAX_BYTES = 12 * 1024;

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch (_error) { return Infinity; }
}

function requiredAbsoluteRoot(value, label) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(candidate);
}

function operationOwner(session, operationId) {
  return Object.freeze({
    kind: 'plugin',
    publisher_id: session.plugin_session.publisher_id,
    plugin_id: session.plugin_session.plugin_id,
    operation_id: operationId,
  });
}

function descriptorMatchesSession(descriptor, session) {
  const binding = session?.plugin_session;
  return Boolean(descriptor && binding
    && descriptor.publisher_id === binding.publisher_id
    && descriptor.plugin_id === binding.plugin_id
    && descriptor.contribution_id === binding.provider_contribution_id
    && descriptor.view_contribution_id === binding.view_contribution_id);
}

function actionFor(descriptor, actionId) {
  return (Array.isArray(descriptor?.actions) ? descriptor.actions : [])
    .find((action) => action?.action_id === actionId) || null;
}

class SessionProviderInvocationBroker {
  constructor({ sessionStore, runtime, ticketBroker, attachmentAssetStore,
    exclusiveGpuCoordinator = null, scratchRoot,
    drainChat = async () => ({ ok: true }), unloadChatModel = async () => {},
    getChatEngineType = () => '',
    verifyGpuFree = async () => ({ ok: true }), log = () => {}, now = () => Date.now(),
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, fsImpl = fs,
    publishArtifact = publishGeneratedArtifact } = {}) {
    if (!sessionStore || !runtime || !ticketBroker || !attachmentAssetStore) {
      throw new TypeError('session provider broker dependencies invalid');
    }
    this.sessionStore = sessionStore;
    this.runtime = runtime;
    this.ticketBroker = ticketBroker;
    this.attachmentAssetStore = attachmentAssetStore;
    this.exclusiveGpu = exclusiveGpuCoordinator;
    this.scratchRoot = requiredAbsoluteRoot(scratchRoot, 'scratchRoot');
    this.drainChat = drainChat;
    this.unloadChatModel = unloadChatModel;
    this.getChatEngineType = getChatEngineType;
    this.verifyGpuFree = verifyGpuFree;
    this.log = log;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.fs = fsImpl;
    this.publishArtifact = publishArtifact;
    this.operations = new Map();
    this.providerStatuses = new Map();
    this.deletingSessions = new Set();
    this.disposed = false;
  }

  async resolveCreationBinding(authorityTuple = {}) {
    const authority = this.runtime.currentAuthority?.();
    if (!authority
      || (authorityTuple.active_generation_id
        && authorityTuple.active_generation_id !== authority.active_generation_id)
      || (authorityTuple.commit_epoch !== undefined
        && Number(authorityTuple.commit_epoch) !== authority.commit_epoch)) {
      return { ok: false, reason: 'session_provider_authority_stale' };
    }
    const contributionId = token(authorityTuple.provider_contribution_id
      || authorityTuple.contribution_id, 64);
    const resolved = this.runtime.resolveProvider?.(authority, {
      publisher_id: token(authorityTuple.publisher_id, 64),
      plugin_id: token(authorityTuple.plugin_id, 64),
      contribution_id: contributionId,
    });
    if (!resolved?.ok || !resolved.descriptor) return resolved || {
      ok: false, reason: 'session_provider_not_found',
    };
    const descriptor = resolved.descriptor;
    if ((authorityTuple.publisher_id && descriptor.publisher_id !== authorityTuple.publisher_id)
      || (authorityTuple.plugin_id && descriptor.plugin_id !== authorityTuple.plugin_id)) {
      return { ok: false, reason: 'session_provider_identity_mismatch' };
    }
    let defaultState;
    try { defaultState = JSON.parse(descriptor.default_state_json); } catch (_error) {
      return { ok: false, reason: 'session_provider_default_state_invalid' };
    }
    const pluginSession = normalizePluginSession({
      schema_version: 1,
      publisher_id: descriptor.publisher_id,
      plugin_id: descriptor.plugin_id,
      provider_contribution_id: descriptor.contribution_id,
      view_contribution_id: descriptor.view_contribution_id,
      provider_name: descriptor.provider_name,
      icon_token: descriptor.icon_token,
      plugin_version_at_creation: descriptor.plugin_version,
      state_schema_version: descriptor.state_schema_version,
      state_revision: 0,
      state: defaultState,
      active_operation: null,
    });
    return pluginSession ? { ok: true, pluginSession, authority, descriptor }
      : { ok: false, reason: 'session_provider_binding_invalid' };
  }

  async handleViewCall(call, viewContext) {
    const checked = validate('PluginSessionProviderViewCallV1', call);
    if (!checked.ok) return { ok: false, reason: 'session_provider_call_invalid' };
    let payload;
    try { payload = JSON.parse(checked.value.payload_json); } catch (_error) {
      return { ok: false, reason: 'session_provider_payload_invalid' };
    }
    const bound = this._boundSession(viewContext);
    if (!bound.ok) return bound;
    if (checked.value.action === 'get_context') {
      return this.getContext(bound.session, viewContext, payload);
    }
    if (checked.value.action === 'update_state') return this.updateState(bound.session, payload);
    if (checked.value.action === 'invoke') return this.invoke(bound.session, viewContext, payload);
    if (checked.value.action === 'cancel') return this.cancel(bound.session, payload);
    if (checked.value.action === 'reveal_attachment') {
      return this.ticketBroker.reveal({ sessionId: bound.session.id,
        sessionIncarnation: bound.session.session_incarnation,
        attachmentId: payload.attachment_id });
    }
    return { ok: false, reason: 'session_provider_action_rejected' };
  }

  authorizeViewOpen(sessionId, descriptor) {
    const session = this.sessionStore.getSession(token(sessionId));
    if (!session || session.session_type !== 'plugin' || !session.plugin_session
      || descriptor.publisher_id !== session.plugin_session.publisher_id
      || descriptor.plugin_id !== session.plugin_session.plugin_id
      || descriptor.contribution_id !== session.plugin_session.view_contribution_id) {
      return { ok: false, reason: 'plugin_session_view_binding_mismatch' };
    }
    const provider = this._resolveProvider(session);
    if (!provider.ok || provider.descriptor.view_contribution_id !== descriptor.contribution_id
      || provider.authority.active_generation_id !== descriptor.generation_id
      || provider.authority.commit_epoch !== descriptor.commit_epoch) {
      return { ok: false, reason: provider.reason || 'plugin_session_view_authority_stale' };
    }
    return { ok: true, sessionIncarnation: session.session_incarnation };
  }

  getContext(session, viewContext, payload = {}) {
    const provider = this._resolveProvider(session);
    const transcript = payload.include_transcript === false ? null : buildTranscriptPage({
      session, cursor: payload.cursor, viewContext, ticketBroker: this.ticketBroker,
    });
    if (transcript && !transcript.ok) return transcript;
    const live = session.plugin_session.active_operation
      ? this.operations.get(session.plugin_session.active_operation.operation_id) : null;
    return { ok: true, value: {
      session: {
        id: session.id,
        incarnation: session.session_incarnation,
        title: session.title,
        state_revision: session.plugin_session.state_revision,
        state_schema_version: session.plugin_session.state_schema_version,
        state: session.plugin_session.state,
        read_only: provider.ok !== true,
      },
      provider: provider.ok ? {
        status: 'ready',
        name: provider.descriptor.provider_name,
        plugin_version: provider.descriptor.plugin_version,
        actions: provider.descriptor.actions,
        runtime_status: this._providerStatus(provider),
      } : { status: 'unavailable', reason_code: token(provider.reason, 64) },
      active_operation: session.plugin_session.active_operation
        ? { ...session.plugin_session.active_operation,
          frames: live ? live.frames.slice(-64) : [] } : null,
      transcript,
    } };
  }

  updateState(session, payload = {}) {
    const expected = Number(payload.state_revision);
    const state = cloneBoundedJsonObject(payload.state, PLUGIN_SESSION_STATE_MAX_BYTES);
    if (!Number.isSafeInteger(expected) || !state) {
      return { ok: false, reason: 'plugin_session_state_invalid' };
    }
    let updated = null;
    const committed = this.sessionStore.updateSession(session.id, (current) => {
      if (current?.session_incarnation !== session.session_incarnation
        || current?.plugin_session?.state_revision !== expected) return null;
      updated = normalizePluginSession({ ...current.plugin_session,
        state_revision: expected + 1, state });
      return updated ? { plugin_session: updated } : null;
    });
    return committed && updated
      ? { ok: true, value: { state_revision: updated.state_revision, state: updated.state } }
      : { ok: false, reason: 'plugin_session_state_conflict', retryable: true };
  }

  async invoke(session, viewContext, payload = {}) {
    if (this.disposed) return { ok: false, reason: 'session_provider_broker_disposed' };
    if (this.deletingSessions.has(session.id)) {
      return { ok: false, reason: 'plugin_session_deleting' };
    }
    const provider = this._resolveProvider(session);
    if (!provider.ok) return provider;
    const actionId = token(payload.action_id, 64);
    const action = actionFor(provider.descriptor, actionId);
    const args = safeObject(payload.arguments);
    const presentation = token(payload.presentation_text, 12_000);
    if (!action || jsonBytes(args) > HOST_ARGUMENT_MAX_BYTES
      || Buffer.byteLength(presentation, 'utf8') > TRANSCRIPT_PRESENTATION_MAX_BYTES) {
      return { ok: false, reason: 'session_provider_invoke_invalid' };
    }
    const latest = this.sessionStore.getSession(session.id);
    if (!latest || latest.session_incarnation !== session.session_incarnation
      || latest.plugin_session?.state_revision !== Number(payload.state_revision)
      || latest.plugin_session.active_operation) {
      return { ok: false, reason: 'plugin_session_state_conflict', retryable: true };
    }
    const operationId = `op_${crypto.randomUUID().replaceAll('-', '')}`;
    const attempt = 1;
    const assistantMessageId = `plugin_assistant_${operationId.slice(3)}`;
    const owner = operationOwner(latest, operationId);
    let leaseId = '';
    if (action.requires_exclusive_gpu) {
      try {
        const lease = await this.exclusiveGpu.acquireExclusiveLease({ owner });
        leaseId = lease.leaseId;
        const engineType = token(this.getChatEngineType(), 64).toLowerCase();
        const drained = await this.drainChat();
        if (drained?.ok !== true) throw Object.assign(new Error('Chat drain was not verified.'), {
          code: drained?.reason || 'chat_drain_unverified',
        });
        this.exclusiveGpu.assertLease(leaseId, owner);
        await this.unloadChatModel();
        const free = await this.verifyGpuFree({ engineType });
        if (free?.ok !== true) throw Object.assign(new Error('GPU eviction was not verified.'), {
          code: free.reason || 'gpu_eviction_unverified',
        });
        this.exclusiveGpu.markPrivilegedResident(leaseId, owner);
      } catch (error) {
        if (leaseId) this.exclusiveGpu.releaseLease(leaseId, owner);
        return { ok: false, reason: token(error?.code || 'exclusive_gpu_unavailable', 64) };
      }
    }
    const scratchDirectory = this._createScratch(operationId);
    if (!scratchDirectory) {
      if (leaseId) this.exclusiveGpu.releaseLease(leaseId, owner);
      return { ok: false, reason: 'plugin_operation_scratch_unavailable' };
    }
    const started = this._persistStart(latest, { operationId, attempt, actionId,
      assistantMessageId, presentation });
    if (!started) {
      this._removeScratch(scratchDirectory);
      if (leaseId) this.exclusiveGpu.releaseLease(leaseId, owner);
      return { ok: false, reason: 'plugin_operation_start_conflict', retryable: true };
    }
    const record = {
      operationId, attempt, action, descriptor: provider.descriptor,
      authority: provider.authority, sessionId: session.id,
      sessionIncarnation: session.session_incarnation, assistantMessageId,
      scratchDirectory, owner, leaseId, frames: [], sequence: 0,
      host: null, timer: null, terminalReceived: false, settled: false,
      settlementPromise: null, pendingSettlement: null, publishedAttachment: null, data: {},
      startupPromise: null, cancelRequested: false,
    };
    this.operations.set(operationId, record);
    const acquired = await beginHostStartup(this, record);
    if (!acquired?.ok || typeof acquired.session?.invoke !== 'function') {
      await this._settle(record, 'failed', acquired?.reason || 'host_session_unavailable');
      return { ok: false, reason: acquired?.reason || 'host_session_unavailable' };
    }
    if (record.terminalReceived || record.cancelRequested
      || this.operations.get(operationId) !== record) {
      if (record.settlementPromise) await record.settlementPromise;
      else await this._settle(record, 'cancelled', 'operation_cancelled_before_start');
      return { ok: false, reason: 'plugin_operation_cancelled_before_start' };
    }
    if (!this._recordIdentityIsCurrent(record)) {
      await this._settle(record, 'interrupted', 'operation_authority_stale');
      return { ok: false, reason: 'operation_authority_stale' };
    }
    if (record.leaseId) {
      try { this.exclusiveGpu.assertLease(record.leaseId, record.owner); }
      catch (_error) {
        await this._settle(record, 'interrupted', 'exclusive_gpu_lease_stale');
        return { ok: false, reason: 'exclusive_gpu_lease_stale' };
      }
    }
    let accepted;
    try {
      accepted = await record.host.invoke({ operation_id: operationId, attempt, action_id: actionId,
        arguments: args, scratch_directory: scratchDirectory,
        session_id: session.id, session_incarnation: session.session_incarnation,
        state_revision: payload.state_revision, state: latest.plugin_session.state,
        commit_epoch: record.authority.commit_epoch,
        host_session_epoch: record.hostSessionEpoch });
    } catch (_error) {
      accepted = { ok: false, reason: 'host_start_response_lost' };
    }
    if (!accepted?.ok || accepted.accepted !== true
      || accepted.operation_id !== operationId || Number(accepted.attempt) !== attempt) {
      await this._settle(record, 'failed', accepted?.reason || 'host_start_ambiguous');
      return { ok: false, reason: accepted?.reason || 'host_start_ambiguous' };
    }
    this._schedulePoll(record);
    return { ok: true, value: { accepted: true, operation_id: operationId, attempt } };
  }

  async cancel(session, payload = {}) {
    const operationId = token(payload.operation_id, 96);
    const attempt = Number(payload.attempt);
    const active = session.plugin_session.active_operation;
    const record = this.operations.get(operationId);
    if (!record || !active || active.operation_id !== operationId || active.attempt !== attempt
      || record.sessionIncarnation !== session.session_incarnation) {
      return { ok: false, reason: 'plugin_operation_not_active' };
    }
    record.cancelRequested = true;
    this.sessionStore.updateSession(session.id, (current) => ({ plugin_session: {
      ...current.plugin_session, active_operation: { ...current.plugin_session.active_operation,
        status: 'cancelling' },
    } }));
    if (!record.host) {
      return { ok: true, value: { cancel_requested: true, startup_pending: true } };
    }
    try {
      const result = await record.host.cancel({ operation_id: operationId, attempt });
      return result?.ok === false ? result : { ok: true, value: { cancel_requested: true } };
    } catch (_error) {
      return { ok: false, reason: 'plugin_operation_cancel_failed', retryable: true };
    }
  }

  async cancelSession(sessionId, reason = 'session_left') {
    const session = this.sessionStore.getSession(token(sessionId));
    const active = session?.plugin_session?.active_operation;
    if (!active) return { ok: true, already_absent: true };
    const record = this.operations.get(active.operation_id);
    if (!record || record.action.cancel_on_session_leave !== true) {
      return { ok: true, continues: true };
    }
    return this.cancel(session, { operation_id: active.operation_id, attempt: active.attempt, reason });
  }

  async cancelSessionAndWait(sessionId, reason = 'session_left', { force = false } = {}) {
    const session = this.sessionStore.getSession(token(sessionId));
    const active = session?.plugin_session?.active_operation;
    if (!active) return { ok: true, already_absent: true };
    const record = this.operations.get(active.operation_id);
    if (!record) return { ok: false, reason: 'plugin_operation_recovery_required' };
    if (!force && record.action.cancel_on_session_leave !== true) {
      return { ok: true, continues: true };
    }
    if (active.status !== 'cleanup_pending') {
      const requested = await this.cancel(session, {
        operation_id: active.operation_id,
        attempt: active.attempt,
        reason,
      });
      if (!requested?.ok) {
        this.log('plugins.session_provider.cancel_request_failed', {
          reason_code: token(requested?.reason || 'plugin_operation_cancel_failed', 64),
        });
      }
    }
    const pending = record.pendingSettlement || {
      status: 'cancelled', reason: token(reason, 64) || 'session_left', result: {},
    };
    return this._settle(record, pending.status, pending.reason, pending.result);
  }

  async prepareSessionDeletion(sessionId) {
    const normalized = token(sessionId);
    if (!normalized) return { ok: false, reason: 'plugin_session_not_found' };
    this.deletingSessions.add(normalized);
    const settled = await this.cancelSessionAndWait(normalized, 'session_deleted', { force: true });
    if (!settled?.ok) this.deletingSessions.delete(normalized);
    return settled;
  }

  finishSessionDeletion(sessionId) {
    this.deletingSessions.delete(token(sessionId));
  }

  reconcileInterruptedOperations() {
    let settled = 0;
    for (const summary of this.sessionStore.listSessions()) {
      const session = this.sessionStore.getSession(summary.id);
      const active = session?.plugin_session?.active_operation;
      if (!active) continue;
      const scratchDirectory = path.join(this.scratchRoot, token(active.operation_id, 96));
      if (!this._removeScratch(scratchDirectory)) {
        this.log('plugins.session_provider.scratch_cleanup_failed', {
          reason_code: 'restart_scratch_cleanup_failed',
        });
      }
      const assistantId = active.assistant_message_id;
      this.sessionStore.updateSession(session.id, (current) => ({
        plugin_session: { ...current.plugin_session, active_operation: null },
        messages: current.messages.map((message) => message.id === assistantId ? {
          ...message,
          content: 'The plugin operation was interrupted before it finished.',
          status: 'runtime_error',
          plugin_operation: normalizePluginOperationMetadata({ ...active,
            status: 'interrupted', reason_code: 'app_restarted' }),
        } : message),
      }));
      settled += 1;
    }
    return { ok: true, settled };
  }

  _boundSession(context) {
    const sessionId = token(context?.sessionId);
    const session = this.sessionStore.getSession(sessionId);
    if (!session || session.session_type !== 'plugin' || !session.plugin_session) {
      return { ok: false, reason: 'plugin_session_not_found' };
    }
    if (context.sessionIncarnation !== session.session_incarnation
      || context.publisherId !== session.plugin_session.publisher_id
      || context.pluginId !== session.plugin_session.plugin_id
      || context.contributionId !== session.plugin_session.view_contribution_id) {
      return { ok: false, reason: 'plugin_session_binding_mismatch' };
    }
    return { ok: true, session };
  }

  _resolveProvider(session) {
    const authority = this.runtime.currentAuthority?.();
    if (!authority) return { ok: false, reason: 'session_provider_unavailable' };
    const resolved = this.runtime.resolveProvider?.(authority, {
      publisher_id: session.plugin_session.publisher_id,
      plugin_id: session.plugin_session.plugin_id,
      contribution_id: session.plugin_session.provider_contribution_id,
    });
    if (!resolved?.ok || !descriptorMatchesSession(resolved.descriptor, session)) {
      return { ok: false, reason: resolved?.reason || 'session_provider_binding_stale' };
    }
    if (resolved.descriptor.state_schema_version < session.plugin_session.state_schema_version) {
      return { ok: false, reason: 'session_provider_state_future' };
    }
    return { ok: true, authority, descriptor: resolved.descriptor };
  }

  _providerStatus(provider) {
    const key = this._providerStatusKey(provider);
    if (this.providerStatuses.has(key)) return this.providerStatuses.get(key);
    const resolved = this.runtime.providerStatus?.(provider.authority, provider.descriptor);
    const status = cloneBoundedJsonObject(resolved?.runtime_status, 16 * 1024);
    if (status) this._rememberProviderStatus(key, status);
    return status;
  }

  _providerStatusKey(provider) {
    return [provider.authority?.active_generation_id, provider.authority?.commit_epoch,
      provider.descriptor?.publisher_id, provider.descriptor?.plugin_id,
      provider.descriptor?.contribution_id].join('\0');
  }

  _rememberProviderStatus(key, status) {
    this.providerStatuses.set(key, status);
    while (this.providerStatuses.size > 32) {
      this.providerStatuses.delete(this.providerStatuses.keys().next().value);
    }
  }

  _persistStart(session, operation) {
    const now = new Date(this.now()).toISOString();
    const activeOperation = {
      operation_id: operation.operationId, attempt: operation.attempt,
      action_id: operation.actionId, status: 'accepted', started_at: now,
      frame_sequence: 0, assistant_message_id: operation.assistantMessageId,
    };
    const committed = this.sessionStore.updateSession(session.id, (current) => {
      if (current.session_incarnation !== session.session_incarnation
        || current.plugin_session?.active_operation) return null;
      const seq = Math.max(Number(current.message_seq_counter) || 0, current.messages.length);
      const messages = [...current.messages];
      if (operation.presentation) messages.push({
        id: `plugin_user_${operation.operationId.slice(3)}`, role: 'user',
        content: operation.presentation, status: 'complete', timestamp: now, event_seq: seq,
      });
      messages.push({
        id: operation.assistantMessageId, role: 'assistant', content: 'Working...',
        status: 'streaming', timestamp: now,
        event_seq: seq + (operation.presentation ? 1 : 0),
      });
      return {
        messages, message_count: messages.length,
        message_seq_counter: seq + (operation.presentation ? 2 : 1),
        plugin_session: { ...current.plugin_session, active_operation: activeOperation },
      };
    });
    return Boolean(committed);
  }

  _schedulePoll(record, delay = POLL_INTERVAL_MS) {
    return schedulePoll(this, record, delay);
  }

  async _poll(record) {
    return poll(this, record);
  }

  _recordIdentityIsCurrent(record) {
    return recordIdentityIsCurrent(this, record);
  }

  async _settle(record, status, reason = '', result = {}) {
    return settle(this, record, status, reason, result);
  }

  async _completeSettlement(record, status, reason = '', result = {}) {
    return completeSettlement(this, record, status, reason, result);
  }

  _createScratch(operationId) {
    try {
      this.fs.mkdirSync(this.scratchRoot, { recursive: true });
      const target = path.join(this.scratchRoot, operationId);
      const relative = path.relative(this.scratchRoot, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
      this.fs.mkdirSync(target, { recursive: false });
      return target;
    } catch (_error) { return ''; }
  }

  _removeScratch(directory) {
    const target = path.resolve(String(directory || ''));
    const relative = path.relative(this.scratchRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try { this.fs.rmSync(target, { recursive: true, force: true }); return true; }
    catch (_error) { return false; }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.operations.values()) {
      if (record.timer) this.clearTimeoutFn(record.timer);
      try { await record.host?.cancel?.({ operation_id: record.operationId, attempt: record.attempt }); }
      catch (_error) { /* termination below owns cleanup */ }
      await this._settle(record, 'interrupted', 'broker_disposed');
    }
    this.providerStatuses.clear();
    this.deletingSessions.clear();
    this.ticketBroker.dispose();
  }
}

module.exports = {
  HOST_ARGUMENT_MAX_BYTES,
  MAX_STATUS_FRAMES,
  POLL_INTERVAL_MS,
  SessionProviderInvocationBroker,
  authorityMatches,
  terminalContent,
};
