'use strict';

const {
  buildTerminalCommitResult,
  isDurableCommitOutcome,
  normalizeTerminalKind,
  terminalIdentityMatches,
  validateTerminalIdentity,
} = require('./chat-lifecycle-contracts');
const { normalizeTerminalMutations } = require('./chat-stream-terminal-tool-repairs');
const { planTerminalToolRepairs } = require('./chat-terminal-tool-repair-planner');
const { normalizeMessageFields } = require('./message-normalization');
const { normalizeId } = require('../shared/normalize');

const MAX_REPAIR_CLEANUP_ATTEMPTS = 3;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeRepairMessage(value) {
  const message = normalizeMessageFields(value);
  return message?.role === 'assistant' && normalizeId(message.id) ? message : null;
}

function repairArtifactMatchesLease(artifact, lease, allowedStates) {
  const source = isRecord(artifact) ? artifact : {};
  return allowedStates.includes(source.state)
    && normalizeId(source.session_id) === normalizeId(lease?.identity?.sessionId)
    && normalizeId(source.session_incarnation) === normalizeId(lease?.identity?.sessionIncarnation)
    && Number(source.turn_generation) === Number(lease?.identity?.generation)
    && normalizeId(source.turn_id) === normalizeId(lease?.identity?.turnId)
    && normalizeId(source.stream_id) === normalizeId(lease?.identity?.streamId);
}

function resultMessageIds(outcome, messages) {
  const candidates = outcome?.value?.persistedMessageIds
    || outcome?.value?.persisted_message_ids
    || outcome?.persistedMessageIds
    || outcome?.persisted_message_ids;
  const source = Array.isArray(candidates)
    ? candidates
    : (Array.isArray(messages) ? messages.map((message) => message?.id) : []);
  return [...new Set(source.map(normalizeId).filter(Boolean))];
}

function buildRefusal(reason, options = {}) {
  return buildTerminalCommitResult({
    ok: false,
    visibleTerminal: options.visibleTerminal === true,
    durableTerminal: false,
    reason: normalizeId(reason) || 'terminal_commit_refused',
    persistedMessageIds: [],
    repairDurable: options.repairDurable,
    artifactId: options.artifactId,
  });
}

function updateQuestionBatchMessage(messages, questionBatch) {
  if (!questionBatch) return messages;
  return messages.map((message) => {
    if (normalizeId(message?.kind) !== 'question_batch') return message;
    return {
      ...message,
      interactive_batch: questionBatch,
      ...(Object.hasOwn(message, 'question_batch') ? { question_batch: questionBatch } : {}),
    };
  });
}

function repairCallId(repair) {
  return normalizeId(
    repair?.callId
    || repair?.call_id
    || repair?.patch?.tool_call?.call_id
    || repair?.patch?.toolCall?.callId
  );
}

function toolResultCallId(message) {
  return normalizeId(message?.tool_result?.call_id || message?.tool_result?.callId);
}

function buildDiscardSnapshotMutation(snapshot, currentMessages = []) {
  const source = isRecord(snapshot) ? snapshot : {};
  const repairs = Array.isArray(source.tool_repairs || source.toolRepairs)
    ? (source.tool_repairs || source.toolRepairs).filter(isRecord)
    : [];
  const callIds = new Set(repairs.map(repairCallId).filter(Boolean));
  const messages = (Array.isArray(source.messages) ? source.messages : [])
    .filter((message) => (
      isRecord(message)
      && normalizeId(message.kind) === 'tool_result'
      && callIds.has(toolResultCallId(message))
    ));
  const persistedResultCalls = new Set([
    ...messages,
    ...(Array.isArray(currentMessages) ? currentMessages : []),
  ].filter((message) => normalizeId(message?.kind) === 'tool_result')
    .map(toolResultCallId).filter((callId) => callIds.has(callId)));
  const effectiveRepairs = repairs.map((repair) => ({
    ...repair,
    ...(persistedResultCalls.has(repairCallId(repair)) ? { synthesizeResult: false } : {}),
  }));
  const messageIds = new Set(messages.map((message) => normalizeId(message.id)).filter(Boolean));
  const turnEvents = (Array.isArray(source.turn_events || source.turnEvents)
    ? (source.turn_events || source.turnEvents)
    : []).filter((event) => {
    if (!isRecord(event)) return false;
    if (callIds.has(normalizeId(event.tool_call_id || event.toolCallId))) return true;
    if (messageIds.has(normalizeId(event.primary_message_id || event.primaryMessageId))) return true;
    const sourceIds = event.source_message_ids || event.sourceMessageIds;
    return Array.isArray(sourceIds)
      && sourceIds.some((messageId) => messageIds.has(normalizeId(messageId)));
  });
  return { messages, toolRepairs: effectiveRepairs, turnEvents };
}

function mergeTerminalTurnEvents(events) {
  const seenIds = new Set();
  const seenToolResults = new Set();
  const merged = [];
  for (const event of events) {
    const eventId = normalizeId(event?.event_id || event?.eventId);
    if (eventId && seenIds.has(eventId)) continue;
    const kind = normalizeId(event?.kind);
    const callId = normalizeId(event?.tool_call_id || event?.toolCallId);
    const primaryMessageId = normalizeId(
      event?.primary_message_id || event?.primaryMessageId
    );
    const toolResultKey = kind === 'tool_result' && callId && primaryMessageId
      ? `${kind}:${callId}:${primaryMessageId}`
      : '';
    if (toolResultKey && seenToolResults.has(toolResultKey)) continue;
    if (eventId) seenIds.add(eventId);
    if (toolResultKey) seenToolResults.add(toolResultKey);
    merged.push({ ...event });
  }
  return merged;
}

class TerminalCoordinator {
  constructor({
    actorRegistry,
    store = null,
    journal = null,
    repairStore = null,
    emitTerminal = null,
    emitDurabilityUpdate = null,
    logger = null,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!actorRegistry || typeof actorRegistry.finalizeTerminal !== 'function') {
      throw new TypeError('TerminalCoordinator requires a SessionTurnActorRegistry.');
    }
    this.actorRegistry = actorRegistry;
    this.store = store;
    this.journal = journal;
    this.repairStore = repairStore;
    this.emitTerminal = typeof emitTerminal === 'function' ? emitTerminal : null;
    this.emitDurabilityUpdate = typeof emitDurabilityUpdate === 'function'
      ? emitDurabilityUpdate
      : null;
    this.logger = typeof logger === 'function' ? logger : null;
    this.now = typeof now === 'function' ? now : () => new Date().toISOString();
  }

  settle(input = {}) {
    const prepared = this._prepare(input);
    if (!prepared.ok) {
      return this.settlePreparationRefusal(input, prepared.reason);
    }
    const { lease } = input;
    if (lease.terminalCoordinatorRequest) {
      const existing = lease.terminalCoordinatorRequest;
      if (
        existing.kind !== prepared.request.kind
        || !terminalIdentityMatches(existing.identity, prepared.request.identity)
      ) {
        return Promise.resolve(buildRefusal('terminal_request_conflict', {
          visibleTerminal: lease.terminalVisibleEmitted === true,
          repairDurable: lease.terminalRepairDurable,
          artifactId: lease.terminalRepairArtifactId,
        }));
      }
    } else {
      lease.terminalCoordinatorRequest = prepared.request;
    }
    return this.retry(lease);
  }

  async settlePreparationRefusal(input = {}, reason = 'terminal_preparation_refused', {
    requiresToolReplan = false,
  } = {}) {
    const lease = input?.lease;
    const identityResult = validateTerminalIdentity(lease?.identity);
    if (!identityResult.ok || !lease) return buildRefusal(reason);
    const terminal = isRecord(input.terminal) ? input.terminal : {};
    const kind = normalizeTerminalKind(terminal.kind || terminal.status || input.kind) || 'error';
    const requestedBatch = terminal.questionBatch || terminal.question_batch || null;
    const transition = lease.terminalContinuationTransition
      || this.actorRegistry.prepareTerminalTransition(lease, {
        status: kind,
        questionBatch: requestedBatch,
      });
    const effectiveBatch = transition?.preferencePatch?.pending_question_batch
      || requestedBatch;
    const rendererPayload = isRecord(terminal.rendererPayload)
      ? { ...terminal.rendererPayload, lifecycleState: 'failed_repairable' }
      : { type: 'error', lifecycleState: 'failed_repairable' };
    const messages = updateQuestionBatchMessage(
      (Array.isArray(input.messages) ? input.messages : [])
        .filter((message) => isRecord(message) && normalizeId(message.id)),
      effectiveBatch
    );
    const repairMessage = normalizeRepairMessage(
      terminal.repairMessage || terminal.repair_message
    ) || [...messages].reverse().find(
      (message) => normalizeId(message.role) === 'assistant'
    ) || null;
    const request = {
      identity: identityResult.identity,
      kind,
      store: input.store || this.store || lease.store || null,
      terminal: { ...terminal, kind, questionBatch: effectiveBatch, rendererPayload },
      repairMessage,
      messages,
      toolRepairs: (Array.isArray(input.toolRepairs) ? input.toolRepairs : [])
        .filter(isRecord),
      turnEvents: (Array.isArray(input.turnEvents) ? input.turnEvents : [])
        .filter(isRecord),
      preferencePatch: {
        ...(isRecord(input.preferencePatch) ? input.preferencePatch : {}),
        ...(transition?.ok ? transition.preferencePatch : {}),
      },
      title: typeof input.title === 'string' ? input.title.trim() : null,
      keepRepairTombstone: false,
      preexistingRefusalReason: null,
      requiresToolReplan: requiresToolReplan === true,
    };
    let result = buildRefusal(reason);
    try {
      this.actorRegistry.finalizeTerminal(lease, result, { status: kind });
    } catch (_error) {
      // A refusal must retain ownership even if diagnostics around preservation fail.
    }
    const repair = await this._saveRepair(lease, request, result.reason);
    result = buildTerminalCommitResult({
      ...result,
      repairDurable: repair.durable,
      artifactId: repair.artifactId,
    });
    result = buildTerminalCommitResult({
      ...result,
      visibleTerminal: await this._emitTerminalOnce(lease, request, result),
    });
    lease.terminalCommitResult = result;
    lease.terminalHadRefusal = true;
    return result;
  }

  retry(lease) {
    if (lease?.terminalCommitResult?.ok && lease.terminalCommitResult?.durableTerminal) {
      return Promise.resolve(lease.terminalCommitResult);
    }
    if (!lease?.terminalCoordinatorRequest) {
      return Promise.resolve(buildRefusal('terminal_retry_not_found'));
    }
    if (lease.terminalCommitPromise) {
      return lease.terminalCommitPromise;
    }
    const attempt = this.actorRegistry.runTerminalMutation(
      lease,
      () => this._attempt(lease, lease.terminalCoordinatorRequest)
    ).catch((error) => this._handleAttemptFailure(lease, error));
    let wrapped;
    wrapped = attempt.finally(() => {
      if (lease.terminalCommitPromise === wrapped) {
        lease.terminalCommitPromise = null;
      }
    });
    lease.terminalCommitPromise = wrapped;
    return wrapped;
  }

  settlePendingRepair({ lease, artifact, store = null } = {}) {
    const source = isRecord(artifact) ? artifact : {};
    const snapshot = isRecord(source.terminal_snapshot || source.terminalSnapshot)
      ? (source.terminal_snapshot || source.terminalSnapshot)
      : null;
    if (
      !repairArtifactMatchesLease(source, lease, ['pending'])
      || !snapshot
    ) {
      return Promise.resolve(buildRefusal('stale_terminal_repair'));
    }
    lease.terminalRepairArtifactId = normalizeId(source.artifact_id);
    lease.terminalRepairDurable = true;
    let toolRepairs = snapshot.tool_repairs || snapshot.toolRepairs || [];
    if (snapshot.requires_tool_replan === true || snapshot.requiresToolReplan === true) {
      const effectiveStore = store || this.store || lease?.store;
      const currentMessages = effectiveStore?.getSessionMessages?.(
        lease.identity.sessionId
      ) || [];
      const planned = planTerminalToolRepairs(currentMessages, lease.identity.streamId, {
        model: snapshot.terminal?.model,
        terminalState: snapshot.kind || snapshot.terminal?.kind,
      });
      if (!planned.ok) {
        const result = buildRefusal(planned.reason, {
          visibleTerminal: true,
          repairDurable: true,
          artifactId: lease.terminalRepairArtifactId,
        });
        try {
          this.actorRegistry.finalizeTerminal(lease, result, {
            status: normalizeTerminalKind(snapshot.kind || snapshot.terminal?.kind) || 'error',
          });
        } catch (_error) {
          // The persisted artifact and active-turn bracket remain the recovery authority.
        }
        lease.terminalCommitResult = result;
        lease.terminalHadRefusal = true;
        return Promise.resolve(result);
      }
      toolRepairs = planned.repairs;
    }
    return this.settle({
      lease,
      identity: lease.identity,
      store,
      terminal: {
        ...(isRecord(snapshot.terminal) ? snapshot.terminal : {}),
        kind: snapshot.kind || snapshot.terminal?.kind,
        replay: true,
        visibleTerminal: true,
      },
      messages: snapshot.messages,
      toolRepairs,
      turnEvents: snapshot.turn_events || snapshot.turnEvents || [],
      preferencePatch: snapshot.preference_patch || snapshot.preferencePatch || {},
      title: snapshot.title,
    });
  }

  async discardPendingRepair({ lease, artifact, store = null } = {}) {
    const source = isRecord(artifact) ? artifact : {};
    const snapshot = isRecord(source.terminal_snapshot || source.terminalSnapshot)
      ? (source.terminal_snapshot || source.terminalSnapshot)
      : null;
    if (!repairArtifactMatchesLease(source, lease, ['pending', 'discarded'])) {
      return buildRefusal('stale_terminal_repair');
    }
    if (!snapshot) return buildRefusal('missing_terminal_repair_snapshot');
    const artifactId = normalizeId(source.artifact_id);
    if (!artifactId) return buildRefusal('missing_terminal_repair_artifact_id');
    if (lease?.terminalCommitPromise) {
      return buildRefusal('terminal_commit_in_progress', {
        artifactId,
        repairDurable: lease.terminalRepairDurable,
      });
    }
    if (source.state === 'pending') {
      if (!this.repairStore || typeof this.repairStore.markDiscardPending !== 'function') {
        return buildRefusal('terminal_repair_discard_capability_missing', {
          artifactId,
          repairDurable: false,
        });
      }
      let discarded;
      try {
        discarded = await this.repairStore.markDiscardPending(artifactId, {
          session_id: lease.identity.sessionId,
          session_incarnation: lease.identity.sessionIncarnation,
          turn_generation: lease.identity.generation,
        });
      } catch (error) {
        this._log('WARN', 'lifecycle.terminal_repair_discard_intent_failed', lease.identity, error?.message);
        return buildRefusal('terminal_repair_discard_intent_failed', {
          artifactId,
          repairDurable: false,
        });
      }
      if (discarded?.ok !== true || discarded?.durable !== true) {
        this._log(
          'WARN',
          'lifecycle.terminal_repair_discard_intent_refused',
          lease.identity,
          discarded?.reason
        );
        return buildRefusal(
          normalizeId(discarded?.reason) || 'terminal_repair_discard_intent_refused',
          { artifactId, repairDurable: false }
        );
      }
    }
    lease.terminalRepairArtifactId = artifactId;
    lease.terminalRepairDurable = true;
    lease.terminalRepairState = source.state === 'discarded' ? 'discarded' : 'discard_pending';
    lease.terminalCoordinatorRequest = null;
    lease.terminalCommitResult = null;
    const effectiveStore = store || this.store || lease?.store;
    const mutation = buildDiscardSnapshotMutation(
      snapshot,
      effectiveStore?.getSessionMessages?.(lease.identity.sessionId) || []
    );
    const result = await this.settle({
      lease,
      identity: lease.identity,
      store,
      terminal: { kind: 'cancelled', replay: true, visibleTerminal: true },
      messages: mutation.messages,
      toolRepairs: mutation.toolRepairs,
      turnEvents: mutation.turnEvents,
      preferencePatch: {},
      title: null,
      keepRepairTombstone: true,
    });
    if (result?.durableTerminal !== true || source.state === 'discarded') return result;
    try {
      const discarded = await this.repairStore.markDiscarded(artifactId, {
        session_id: lease.identity.sessionId,
        session_incarnation: lease.identity.sessionIncarnation,
        turn_generation: lease.identity.generation,
      });
      if (discarded?.ok === true && discarded?.durable === true) {
        lease.terminalRepairState = 'discarded';
      } else {
        this._log(
          'WARN',
          'lifecycle.terminal_repair_discard_finalize_refused',
          lease.identity,
          discarded?.reason
        );
      }
    } catch (error) {
      this._log(
        'WARN',
        'lifecycle.terminal_repair_discard_finalize_failed',
        lease.identity,
        error?.message
      );
    }
    return result;
  }

  _prepare(input) {
    const lease = input?.lease;
    const identityResult = validateTerminalIdentity(input.identity || lease?.identity);
    if (!identityResult.ok) return identityResult;
    if (!terminalIdentityMatches(identityResult.identity, lease?.identity)) {
      return { ok: false, reason: 'terminal_identity_mismatch' };
    }
    const terminal = isRecord(input.terminal) ? input.terminal : {};
    const kind = normalizeTerminalKind(terminal.kind || terminal.status || input.kind);
    if (!kind) return { ok: false, reason: 'invalid_terminal_kind' };
    const repairMessageSource = terminal.repairMessage ?? terminal.repair_message ?? null;
    const repairMessage = repairMessageSource == null
      ? null
      : normalizeRepairMessage(repairMessageSource);
    if (repairMessageSource != null && !repairMessage) {
      return { ok: false, reason: 'invalid_terminal_repair_message' };
    }
    if (terminal.visibleTerminal === true) {
      lease.terminalVisibleEmitted = true;
    }
    const store = input.store || this.store || lease?.store;
    if (!store || typeof store.commitTerminal !== 'function') {
      return { ok: false, reason: 'terminal_store_capability_missing' };
    }
    if (input.preferencePatch != null && !isRecord(input.preferencePatch)) {
      return { ok: false, reason: 'invalid_terminal_preference_patch' };
    }
    if (!Array.isArray(input.turnEvents || [])) {
      return { ok: false, reason: 'invalid_terminal_turn_events' };
    }

    const questionBatch = terminal.questionBatch || terminal.question_batch || null;
    const transition = terminal.replay === true
      ? { ok: true, reason: null, kind: 'replay', preferencePatch: {} }
      : this.actorRegistry.prepareTerminalTransition(lease, {
          status: kind,
          questionBatch,
        });
    if (!transition?.ok) return { ok: false, reason: transition?.reason || 'terminal_transition_refused' };
    const effectiveBatch = transition.preferencePatch?.pending_question_batch || questionBatch;
    const rendererPayload = isRecord(terminal.rendererPayload)
      ? {
          ...terminal.rendererPayload,
          ...(kind === 'question_batch' && effectiveBatch
            ? { batch: effectiveBatch }
            : {}),
        }
      : {};
    const timestamp = normalizeId(terminal.timestamp) || normalizeId(this.now());
    const preexistingRefusalReason = normalizeId(
      terminal.preexistingRefusalReason || terminal.preexisting_refusal_reason
    );
    const mutationResult = normalizeTerminalMutations(
      updateQuestionBatchMessage(input.messages || [], effectiveBatch),
      input.toolRepairs || [],
      identityResult.identity,
      timestamp
    );
    if (!mutationResult.ok) return mutationResult;

    return {
      ok: true,
      request: {
        identity: identityResult.identity,
        kind,
        store,
        terminal: {
          ...terminal,
          kind,
          questionBatch: effectiveBatch,
          rendererPayload,
        },
        repairMessage,
        messages: mutationResult.messages,
        toolRepairs: mutationResult.toolRepairs,
        turnEvents: mergeTerminalTurnEvents([
          ...(input.turnEvents || []),
          ...mutationResult.repairTurnEvents,
        ]),
        preferencePatch: {
          ...(input.preferencePatch || {}),
          ...(transition.preferencePatch || {}),
        },
        title: typeof input.title === 'string' ? input.title.trim() : null,
        keepRepairTombstone: input.keepRepairTombstone === true,
        preexistingRefusalReason: preexistingRefusalReason || null,
      },
    };
  }

  async _attempt(lease, request) {
    this.actorRegistry.markProviderQuiesced(lease);
    let outcome;
    if (request.preexistingRefusalReason) {
      outcome = {
        ok: false,
        durable: false,
        reason: request.preexistingRefusalReason,
      };
    } else {
      try {
        outcome = await request.store.commitTerminal(
          request.identity.sessionId,
          {
            identity: request.identity,
            messages: request.messages,
            toolRepairs: request.toolRepairs,
            turnEvents: request.turnEvents,
            preferencePatch: request.preferencePatch,
            title: request.title,
            clearActiveTurnMatch: {
              requestId: request.identity.turnId,
              turnId: request.identity.turnId,
              streamId: request.identity.streamId,
              sessionIncarnation: request.identity.sessionIncarnation,
              generation: request.identity.generation,
              userMessageId: request.identity.userMessageId,
            },
          },
          { durable: true }
        );
      } catch (error) {
        outcome = { ok: false, durable: false, reason: 'terminal_commit_threw', error };
      }
    }

    const epochDurable = isDurableCommitOutcome(outcome);
    let result = buildTerminalCommitResult({
      ok: epochDurable,
      visibleTerminal: false,
      durableTerminal: epochDurable,
      reason: epochDurable
        ? null
        : (normalizeId(outcome?.reason) || 'terminal_durability_unproven'),
      persistedMessageIds: epochDurable ? resultMessageIds(outcome, request.messages) : [],
      repairDurable: lease.terminalRepairDurable,
      artifactId: lease.terminalRepairArtifactId,
    });
    const finalized = this.actorRegistry.finalizeTerminal(lease, result, { status: request.kind });
    if (!finalized.released && result.durableTerminal) {
      result = buildRefusal(finalized.reason, {
        repairDurable: lease.terminalRepairDurable,
        artifactId: lease.terminalRepairArtifactId,
      });
    }
    if (!result.durableTerminal) {
      const repair = request.keepRepairTombstone
        ? {
            durable: lease.terminalRepairDurable === true,
            artifactId: lease.terminalRepairArtifactId || null,
          }
        : await this._saveRepair(lease, request, result.reason);
      result = buildTerminalCommitResult({
        ...result,
        repairDurable: repair.durable,
        artifactId: repair.artifactId,
      });
      request.preexistingRefusalReason = null;
      lease.terminalHadRefusal = true;
    }

    const wasVisible = lease.terminalVisibleEmitted === true;
    const visibleTerminal = await this._emitTerminalOnce(lease, request, result);
    result = buildTerminalCommitResult({ ...result, visibleTerminal });
    lease.terminalCommitResult = result;

    if (result.durableTerminal && finalized.released) {
      await this._clearJournal(request.identity, outcome);
      if (!request.keepRepairTombstone) await this._clearRepair(lease, request.identity);
      if (wasVisible && lease.terminalHadRefusal && !request.keepRepairTombstone) {
        await this._emitDurabilityResolved(request, result);
      }
    }
    return result;
  }

  async _handleAttemptFailure(lease, error) {
    const request = lease?.terminalCoordinatorRequest;
    const reason = normalizeId(error?.reason || error?.code) || 'terminal_commit_failed';
    const base = buildRefusal(reason, {
      visibleTerminal: lease?.terminalVisibleEmitted === true,
      repairDurable: lease?.terminalRepairDurable,
      artifactId: lease?.terminalRepairArtifactId,
    });
    if (!request) return base;
    try {
      this.actorRegistry.finalizeTerminal(lease, base, { status: request.kind });
    } catch (_error) {
      // The lease remains the admission barrier; report the original refusal.
    }
    const repair = request.keepRepairTombstone
      ? {
          durable: lease.terminalRepairDurable === true,
          artifactId: lease.terminalRepairArtifactId || null,
        }
      : await this._saveRepair(lease, request, reason);
    let result = buildTerminalCommitResult({
      ...base,
      repairDurable: repair.durable,
      artifactId: repair.artifactId,
    });
    result = buildTerminalCommitResult({
      ...result,
      visibleTerminal: await this._emitTerminalOnce(lease, request, result),
    });
    lease.terminalCommitResult = result;
    lease.terminalHadRefusal = true;
    return result;
  }

  async _saveRepair(lease, request, reason) {
    const message = request.repairMessage || [...request.messages].reverse().find(
      (candidate) => normalizeId(candidate?.role) === 'assistant'
    ) || null;
    if (!this.repairStore || typeof this.repairStore.savePending !== 'function') {
      return { durable: null, artifactId: null };
    }
    try {
      const result = await this.repairStore.savePending({
        session_id: request.identity.sessionId,
        session_incarnation: request.identity.sessionIncarnation,
        turn_generation: request.identity.generation,
        turn_id: request.identity.turnId,
        stream_id: request.identity.streamId,
        message,
        reason,
        scope: message ? 'assistant' : 'terminal',
        terminal_snapshot: {
          kind: request.kind,
          terminal: {
            kind: request.kind,
            rendererPayload: isRecord(request.terminal.rendererPayload)
              ? request.terminal.rendererPayload
              : {},
          },
          messages: request.messages,
          tool_repairs: request.toolRepairs,
          turn_events: request.turnEvents,
          preference_patch: request.preferencePatch,
          title: request.title,
          requires_tool_replan: request.requiresToolReplan === true,
        },
        ...(lease.terminalRepairArtifactId
          ? { artifact_id: lease.terminalRepairArtifactId }
          : {}),
      });
      const returnedArtifactId = normalizeId(result?.artifact?.artifact_id);
      const artifactId = returnedArtifactId || normalizeId(lease.terminalRepairArtifactId);
      const saved = result?.ok === true && result?.durable === true && Boolean(returnedArtifactId);
      const durable = saved || (lease.terminalRepairDurable === true && Boolean(artifactId));
      lease.terminalRepairDurable = durable;
      lease.terminalRepairArtifactId = artifactId || null;
      if (!saved) this._log('WARN', 'lifecycle.terminal_repair_persist_refused', request.identity, result?.reason);
      return { durable, artifactId: artifactId || null };
    } catch (error) {
      const retained = lease.terminalRepairDurable === true
        && Boolean(normalizeId(lease.terminalRepairArtifactId));
      lease.terminalRepairDurable = retained;
      this._log('WARN', 'lifecycle.terminal_repair_persist_failed', request.identity, error?.message);
      return { durable: retained, artifactId: lease.terminalRepairArtifactId || null };
    }
  }

  async _clearRepair(lease, identity) {
    if (!lease.terminalRepairArtifactId || !this.repairStore) return;
    if (typeof this.repairStore.clearResolved !== 'function') return;
    for (let attempt = 1; attempt <= MAX_REPAIR_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.repairStore.clearResolved(lease.terminalRepairArtifactId, {
          session_id: identity.sessionId,
          session_incarnation: identity.sessionIncarnation,
          turn_generation: identity.generation,
        });
        if (result?.ok === true && result?.durable === true) return;
        this._log('WARN', 'lifecycle.terminal_repair_clear_refused', identity, result?.reason);
      } catch (error) {
        this._log('WARN', 'lifecycle.terminal_repair_clear_failed', identity, error?.message);
      }
    }
    this._log('ERROR', 'lifecycle.terminal_repair_clear_retry_exhausted', identity, 'retry_exhausted');
  }

  // Retries mirror _clearRepair's bounded pattern: a transient clear() failure
  // must not silently leave the partition uncleared -- a surviving non-empty
  // partition after a successful turn is exactly the hard-interruption
  // signature interrupted-turn-receipts.js keys on, so an unretried failure
  // here would frame a successful turn as interrupted on the next chat.send.
  async _clearJournal(identity, commitResult) {
    if (!this.journal || typeof this.journal.clear !== 'function') return;
    for (let attempt = 1; attempt <= MAX_REPAIR_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.journal.clear(
          identity.sessionId,
          identity.turnId,
          { commitResult }
        );
        if (result?.ok === true && result?.durable === true) return;
        this._log('WARN', 'lifecycle.terminal_journal_clear_refused', identity, result?.reason);
      } catch (error) {
        this._log('WARN', 'lifecycle.terminal_journal_clear_failed', identity, error?.message);
      }
    }
    this._log('ERROR', 'lifecycle.terminal_journal_clear_retry_exhausted', identity, 'retry_exhausted');
  }

  async _emitTerminalOnce(lease, request, result) {
    if (lease.terminalVisibleEmitted) return true;
    if (lease.terminalEmissionAttempted) return false;
    if (!this.emitTerminal) return false;
    // The latch means "an attempt is in flight or has already succeeded",
    // not "one attempt ever happened": a failed/thrown emit clears it below
    // so a later retry pass (see retry()/_attempt()) can re-attempt instead
    // of permanently suppressing the user-visible terminal. Success still
    // latches for good via terminalVisibleEmitted.
    lease.terminalEmissionAttempted = true;
    try {
      const emitted = await this.emitTerminal({
        ...(isRecord(request.terminal.rendererPayload) ? request.terminal.rendererPayload : {}),
        // Carry the events a cold reopen folds so live and reopened renderings of
        // one turn can be compared; nothing consumes them yet.
        ...(request.turnEvents.length > 0
          ? { canonicalTurnEvents: request.turnEvents }
          : {}),
        sessionId: request.identity.sessionId,
        streamId: request.identity.streamId,
        turnId: request.identity.turnId,
        terminalStatus: request.kind,
        durability: {
          state: result.durableTerminal ? 'saved' : 'unsaved',
          reason: result.reason,
          repairDurable: result.repairDurable,
          artifactId: result.artifactId,
        },
      });
      if (emitted === false) {
        lease.terminalEmissionAttempted = false;
        return false;
      }
      lease.terminalVisibleEmitted = true;
      return true;
    } catch (error) {
      lease.terminalEmissionAttempted = false;
      this._log('WARN', 'lifecycle.terminal_emit_failed', request.identity, error?.message);
      return false;
    }
  }

  async _emitDurabilityResolved(request, result) {
    if (!this.emitDurabilityUpdate) return;
    try {
      await this.emitDurabilityUpdate({
        sessionId: request.identity.sessionId,
        streamId: request.identity.streamId,
        turnId: request.identity.turnId,
        terminalStatus: request.kind,
        persistedMessageIds: result.persistedMessageIds,
        durability: { state: 'saved', reason: null },
      });
    } catch (error) {
      this._log('WARN', 'lifecycle.terminal_durability_update_failed', request.identity, error?.message);
    }
  }

  _log(level, event, identity, reason) {
    try {
      this.logger?.(level, event, {
        sessionId: identity?.sessionId || null,
        streamId: identity?.streamId || null,
        generation: identity?.generation || null,
        reason: normalizeId(reason) || null,
      });
    } catch (_error) {
      // Observability must not reopen settlement.
    }
  }
}

module.exports = {
  TerminalCoordinator,
};
