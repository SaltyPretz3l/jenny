const {
  collectAssetPaths,
} = require('../attachment-service');
const {
  collectDeletedSessionPayloadKeys,
  collectRemainingReferencedPayloadKeys,
  listCanonicalSessionIds,
  listShadowSessionIds,
  readStoreMessages,
} = require('./backend-session-reference-scan');
const { hydrateMessagesWithTerminalRepairs } = require('./terminal-repair-service');
const { editUserMessageAndTruncate } = require('./backend-session-truncate');
const { normalizeLinkedTaskId } = require('./session-store-migrations');
const { normalizeRunMode } = require('./session-preferences-patch');
const {
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
} = require('../shell-config-followups-schema');

const INITIAL_PROMPT_CLIP_MARKER = '\n\n[clipped]';
const MAX_INITIAL_PROMPT_CHARS = MAX_FOLLOW_UP_LABEL_CHARS + 2 + MAX_FOLLOW_UP_BODY_CHARS;

function normalizeInitialPrompt(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\0/gu, '').trim();
  if (!normalized || normalized.length <= MAX_INITIAL_PROMPT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_INITIAL_PROMPT_CHARS - INITIAL_PROMPT_CLIP_MARKER.length).trimEnd()}${INITIAL_PROMPT_CLIP_MARKER}`;
}

function normalizeLockdownPreferencePatch(preferences) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)
    || !Object.prototype.hasOwnProperty.call(preferences, 'lockdown')) return preferences;
  return { ...preferences, lockdown: preferences.lockdown === true };
}

async function listSessions(service) {
    service._normalizeManagedReasoningEfforts();
    const data = service.sessionStore.listSessions();
    return {
      object: 'list',
      data,
      total: data.length,
    };
}

async function createSession(service, {
  title, preferences, sessionType, providerAuthority, initialPrompt, linkedTaskId,
} = {}) {
    const composerDraft = normalizeInitialPrompt(initialPrompt);
    const normalizedLinkedTaskId = normalizeLinkedTaskId(linkedTaskId);
    let normalizedPreferences = normalizeLockdownPreferencePatch(
      service._normalizeManagedSessionPreferencePatch(preferences)
    );
    // The normalizer passes a falsy `preferences` through as-is (null included).
    if (!normalizedPreferences || typeof normalizedPreferences !== 'object') {
      normalizedPreferences = {};
    }
    if (!Object.prototype.hasOwnProperty.call(normalizedPreferences, 'run_mode')
      && !Object.prototype.hasOwnProperty.call(normalizedPreferences, 'plan_mode')) {
      const configuredMode = service.configService?.getState?.()?.defaultRunMode;
      if (typeof configuredMode === 'string' && ['ask', 'auto', 'plan'].includes(configuredMode.trim().toLowerCase())) {
        normalizedPreferences = { ...normalizedPreferences, run_mode: normalizeRunMode(configuredMode) };
      }
    }
    const wantsPluginSession = providerAuthority != null
      || ['plugin', 'image'].includes(String(sessionType || '').trim().toLowerCase());
    let pluginSession = null;
    if (wantsPluginSession) {
      if (!providerAuthority || !service._pluginSessionProviderBroker) {
        throw new Error('Plugin sessions require an enabled session provider.');
      }
      const resolved = await service._pluginSessionProviderBroker
        .resolveCreationBinding(providerAuthority);
      if (!resolved?.ok || !resolved.pluginSession) {
        const error = new Error('The requested plugin session provider is unavailable.');
        error.code = resolved?.reason || 'session_provider_unavailable';
        throw error;
      }
      pluginSession = resolved.pluginSession;
    }
    const session = service.sessionStore.createSession({
      title,
      preferences: normalizedPreferences,
      sessionType: pluginSession ? 'plugin' : 'chat',
      pluginSession,
      ...(composerDraft ? { composerDraft } : {}),
      ...(normalizedLinkedTaskId ? { linkedTaskId: normalizedLinkedTaskId } : {}),
    });
    if (!session) {
      throw new Error(
        'Session could not be created: session storage rejected the write '
        + '(a newer-schema session file is on disk; storage is read-only).'
      );
    }
    return {
      object: 'session',
      data: session,
    };
}

async function renameSession(service, sessionId, title) {
  const session = service.sessionStore.renameSession(sessionId, title);
  return {
    object: 'session',
    data: session,
  };
}

function collectMessageAssetPaths(messages) {
  return (Array.isArray(messages) ? messages : [])
    .flatMap((message) => collectAssetPaths(message?.attachments));
}

function collectDeletedSessionAssetPaths(service, sessionId) {
  const paths = [
    ...collectMessageAssetPaths(
      readStoreMessages(service.sessionStore, 'getSessionMessages', sessionId)
    ),
    ...collectMessageAssetPaths(
      readStoreMessages(service.shadowStore, 'getMessages', sessionId)
    ),
  ];
  return [...new Set(paths)];
}

function collectRemainingReferencedAssetPaths(service, deletedSessionId) {
  const referencedPaths = [];
  for (const sessionId of listCanonicalSessionIds(service)) {
    if (sessionId === deletedSessionId) {
      continue;
    }
    referencedPaths.push(...collectMessageAssetPaths(
      readStoreMessages(service.sessionStore, 'getSessionMessages', sessionId)
    ));
  }
  for (const sessionId of listShadowSessionIds(service)) {
    if (sessionId === deletedSessionId) {
      continue;
    }
    referencedPaths.push(...collectMessageAssetPaths(
      readStoreMessages(service.shadowStore, 'getMessages', sessionId)
    ));
  }
  return [...new Set(referencedPaths)];
}

function collectRemainingSessionIds(service, deletedSessionId) {
  return [...new Set([
    ...listCanonicalSessionIds(service),
    ...listShadowSessionIds(service),
  ])].filter((sessionId) => sessionId !== deletedSessionId);
}

function recordDeleteCleanupError(service, sessionId, cleanupErrors, step, code, error = null) {
  const cleanupError = { step, code };
  cleanupErrors.push(cleanupError);
  try {
    service._emitServiceLog?.('WARN', 'session.delete_cleanup_degraded', {
      sessionId,
      step,
      code,
      ...(error ? { errorName: String(error.name || 'Error').slice(0, 80) } : {}),
    });
  } catch (_) {
    // Data deletion already committed; diagnostic listeners cannot roll it back.
  }
}

async function runDeleteCleanupStep(service, sessionId, cleanupErrors, step, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    recordDeleteCleanupError(
      service,
      sessionId,
      cleanupErrors,
      step,
      'cleanup_failed',
      error
    );
  }
}

function sessionSummaries(store) {
  if (typeof store?.listSessions === 'function') {
    const listed = store.listSessions();
    return Array.isArray(listed) ? listed : [];
  }
  if (typeof store?.summarize === 'function') {
    return Object.values(store.summarize() || {});
  }
  return [];
}

async function flushDeletedSessionStore(service, sessionId, cleanupErrors, step, store) {
  if (typeof store?.flush !== 'function') return;
  await runDeleteCleanupStep(service, sessionId, cleanupErrors, step, async () => {
    store.flush();
    if (store.hasPendingWrites?.() === true) {
      throw new Error('session store still has pending durability work');
    }
    if (store.getSession?.(sessionId)) {
      throw new Error('deleted session remains visible after flush');
    }
    const dangling = sessionSummaries(store).some((summary) => (
      String(summary?.id || '') === sessionId
      || (Array.isArray(summary?.linked_session_ids)
        && summary.linked_session_ids.includes(sessionId))
    ));
    if (dangling) throw new Error('deleted session or link remains after flush');
  });
}

async function cleanupDeletedSession(
  service,
  sessionId,
  deletedAssetPaths,
  attachmentPreparationError,
  deletedPayloadPaths,
  payloadPreparationError,
  { deleteShadow = false } = {}
) {
  const cleanupErrors = [];

  if (deleteShadow) {
    try {
      const shadowDeleted = service.shadowStore?.deleteSession?.(
        sessionId,
        { scrubLinks: false }
      );
      if (shadowDeleted !== true) {
        recordDeleteCleanupError(
          service,
          sessionId,
          cleanupErrors,
          'shadow_session',
          'delete_refused'
        );
      }
    } catch (error) {
      recordDeleteCleanupError(
        service,
        sessionId,
        cleanupErrors,
        'shadow_session',
        'delete_failed',
        error
      );
    }
  }

  for (const [step, store] of [
    ['canonical_links', service.sessionStore],
    ['shadow_links', service.shadowStore],
  ]) {
    if (typeof store?.scrubLinkedSessionReferences !== 'function') continue;
    await runDeleteCleanupStep(service, sessionId, cleanupErrors, step, async () => {
      const result = store.scrubLinkedSessionReferences(sessionId);
      if (result?.ok !== true) throw new Error('link scrub refused');
    });
  }

  await flushDeletedSessionStore(
    service,
    sessionId,
    cleanupErrors,
    'canonical_store_flush',
    service.sessionStore
  );
  await flushDeletedSessionStore(
    service,
    sessionId,
    cleanupErrors,
    'shadow_store_flush',
    service.shadowStore
  );

  if (typeof service.turnEventJournal?.purgeTurnsAfter === 'function') {
    await runDeleteCleanupStep(
      service,
      sessionId,
      cleanupErrors,
      'turn_event_journal',
      async () => {
        service.turnEventJournal.purgeTurnsAfter(sessionId, new Set());
        service.turnEventJournal.flush?.();
        const remaining = service.turnEventJournal.listAll?.()?.[sessionId];
        if (remaining && Object.keys(remaining.turns || {}).length) {
          throw new Error('journal purge remains visible after flush');
        }
      }
    );
  }

  if (attachmentPreparationError) {
    recordDeleteCleanupError(
      service,
      sessionId,
      cleanupErrors,
      'attachment_assets',
      'candidate_scan_failed',
      attachmentPreparationError
    );
  } else if (service.attachmentAssetStore && deletedAssetPaths.length) {
    await runDeleteCleanupStep(
      service,
      sessionId,
      cleanupErrors,
      'attachment_assets',
      async () => service.attachmentAssetStore.pruneAssetPaths(
        deletedAssetPaths,
        collectRemainingReferencedAssetPaths(service, sessionId)
      )
    );
  }

  if (payloadPreparationError) {
    recordDeleteCleanupError(
      service,
      sessionId,
      cleanupErrors,
      'ipc_payloads',
      'candidate_scan_failed',
      payloadPreparationError
    );
  } else if (service.ipcPayloadStore && deletedPayloadPaths.length) {
    await runDeleteCleanupStep(service, sessionId, cleanupErrors, 'ipc_payloads', async () => (
      // graceMs: 0 -- the age grace exists to protect a payload written mid-turn
      // whose message is not persisted yet. These candidates came FROM persisted
      // messages of a session that has already been quiesced and deleted, so
      // that hazard cannot apply, and the default hour would strand the payloads
      // of any session deleted soon after its last turn.
      service.ipcPayloadStore.prunePayloadPaths(
        deletedPayloadPaths,
        collectRemainingReferencedPayloadKeys(service, sessionId),
        { graceMs: 0 }
      )
    ));
  }

  if (service.artifactService) {
    await runDeleteCleanupStep(service, sessionId, cleanupErrors, 'artifacts', async () => {
      await service.artifactService.deleteSessionArtifacts(sessionId);
      if (typeof service.artifactService.pruneOrphanedArtifacts === 'function') {
        // Provider form: re-resolved before each deletion so a fork that
        // persists a branch mid-prune is not swept on a stale snapshot.
        await service.artifactService.pruneOrphanedArtifacts(
          () => collectRemainingSessionIds(service, sessionId)
        );
      }
    });
  }

  if (typeof service.terminalRepairStore?.deleteSession === 'function') {
    await runDeleteCleanupStep(service, sessionId, cleanupErrors, 'terminal_repairs', async () => {
      const result = service.terminalRepairStore.deleteSession(sessionId);
      if (result?.ok !== true || result?.durable !== true) {
        throw new Error('terminal repair deletion was not durable');
      }
    });
  }

  if (typeof service.usageHistory?.resetSession === 'function') {
    await runDeleteCleanupStep(
      service,
      sessionId,
      cleanupErrors,
      'usage',
      async () => {
        const result = await service.usageHistory.resetSession(sessionId);
        if (result?.ok !== true) {
          throw new Error('usage history reset failed');
        }
      }
    );
  }

  return {
    cleanup_status: cleanupErrors.length ? 'degraded' : 'complete',
    cleanup_errors: cleanupErrors,
  };
}

async function deleteSession(service, sessionId) {
  let deletedAssetPaths = [];
  let attachmentPreparationError = null;
  if (service.attachmentAssetStore) {
    try {
      deletedAssetPaths = collectDeletedSessionAssetPaths(service, sessionId);
    } catch (error) {
      attachmentPreparationError = error;
    }
  }
  let deletedPayloadPaths = [];
  let payloadPreparationError = null;
  if (service.ipcPayloadStore) {
    try {
      deletedPayloadPaths = [...collectDeletedSessionPayloadKeys(service, sessionId)];
    } catch (error) {
      payloadPreparationError = error;
    }
  }

    const deleted = service.sessionStore.deleteSession(sessionId, { scrubLinks: false });
    if (deleted !== true) {
      return {
        object: 'session',
        id: sessionId,
        deleted: false,
      };
    }
    const cleanup = await cleanupDeletedSession(
      service,
      sessionId,
      deletedAssetPaths,
      attachmentPreparationError,
      deletedPayloadPaths,
      payloadPreparationError,
      { deleteShadow: Boolean(service.shadowStore?.getSession?.(sessionId)) }
    );
    return {
      object: 'session',
      id: sessionId,
      deleted: true,
      ...cleanup,
    };
}

async function getSessionMessages(service, sessionId) {
    const session = service.sessionStore.getSession(sessionId);
    const messages = Array.isArray(session?.messages) ? [...session.messages] : [];
    const turnEvents = Array.isArray(session?.turn_events) ? [...session.turn_events] : [];
    return {
      object: 'list',
      data: hydrateMessagesWithTerminalRepairs(
        service,
        sessionId,
        messages
      ),
      turn_event_log_version: Number(session?.turn_event_log_version || 0),
      turn_events: turnEvents,
      // Authoritative in-flight signal for the renderer's rehydrate gate: a
      // settled turn has active_turn === null (clearActiveTurn always persists),
      // so reopening it does not resurrect a phantom Active Turn deck
      // (session-persistence audit #2).
      active_turn: session?.active_turn || null,
      has_more: false,
    };
}

async function setSessionPreferences(service, sessionId, preferences = {}) {
  if (!sessionId) {
    return null;
  }
  const previous = service.sessionStore.getSession?.(sessionId) || null;
  const updated = service.sessionStore.setSessionPreferences(
    sessionId,
    normalizeLockdownPreferencePatch(
      service._normalizeManagedSessionPreferencePatch(preferences, sessionId)
    )
  );
  const stored = service.sessionStore.getSession?.(sessionId) || updated;
  const changedKeys = stored
    ? ['run_mode', 'plan_mode'].filter((key) => stored[key] !== previous?.[key])
    : [];
  const modeChanged = changedKeys.length > 0;
  const activeTurn = modeChanged ? service.sessionStore.getActiveTurn?.(sessionId) : null;
  const streamId = String(activeTurn?.stream_id || activeTurn?.request_id || '').trim();
  const hasActiveStream = Boolean(streamId && service.activeStreams?.has?.(streamId));
  if (
    hasActiveStream
    && typeof service.sidecarClient?.notifySessionRunModeUpdated === 'function'
  ) {
    const runMode = String(stored.run_mode || '').trim().toLowerCase();
    service.sidecarClient.notifySessionRunModeUpdated({
      sessionId,
      approvalMode: runMode === 'auto' ? 'auto_run' : 'prompt',
      readOnly: runMode === 'plan' || stored.plan_mode === true,
    });
  } else if (modeChanged && !hasActiveStream) {
    service._emitServiceLog?.('INFO', 'session.run_mode_push_skipped', {
      sessionId,
      changedKeys,
    });
  }
  return updated;
}

async function setSessionMeta(service, sessionId, meta = {}) {
  if (!sessionId) {
    return null;
  }
  return service.sessionStore.setSessionMeta(sessionId, meta);
}

async function sweepEmptySessions(service, { dryRun = false, currentSessionId = null } = {}) {
  const candidates = service.sessionStore.sweepEmptySessions({
    dryRun: true,
    currentSessionId: currentSessionId ? String(currentSessionId) : null,
  });
  const candidateIds = Array.isArray(candidates?.candidateIds)
    ? candidates.candidateIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const eligibleIds = candidateIds.filter((sessionId) => {
    let active = service.sessionTurnActors?.hasActiveLifecycle?.(sessionId) === true;
    try {
      active = active || Boolean(service.sessionStore.getActiveTurn?.(sessionId));
    } catch (error) {
      active = true;
      service._emitServiceLog?.('WARN', 'session.sweep_active_state_unavailable', {
        sessionId,
        errorName: String(error?.name || 'Error').slice(0, 80),
      });
    }
    if (active) {
      service._emitServiceLog?.('DEBUG', 'session.sweep_active_candidate_skipped', {
        sessionId,
      });
    }
    return !active;
  });
  const filteredCandidates = eligibleIds.length === candidateIds.length
    ? candidates
    : { ...candidates, candidateIds: eligibleIds };
  if (dryRun === true) return filteredCandidates;
  if (typeof service.deleteSession !== 'function') {
    throw new Error('Lifecycle-aware session deletion is unavailable.');
  }
  let deleted = 0;
  const failures = [];
  for (const sessionId of eligibleIds) {
    try {
      const result = await service.deleteSession(sessionId);
      if (result?.deleted === true) {
        deleted += 1;
      } else {
        failures.push({
          sessionId,
          reason: String(result?.reason || 'delete_refused').slice(0, 120),
        });
      }
    } catch (error) {
      const reason = String(error?.code || error?.reason || 'delete_failed').slice(0, 120);
      failures.push({ sessionId, reason });
      service._emitServiceLog?.('WARN', 'session.sweep_delete_failed', {
        sessionId,
        reason,
        errorName: String(error?.name || 'Error').slice(0, 80),
      });
    }
  }
  return {
    candidateIds: eligibleIds,
    deleted,
    ...(failures.length ? { failed: failures.length, failures } : {}),
  };
}

async function updateSessionMessage(service, sessionId, messageId, patch = {}) {
  if (!sessionId || !messageId) {
    return null;
  }
  return service.sessionStore.updateMessage(sessionId, messageId, patch);
}

module.exports = {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  getSessionMessages,
  setSessionPreferences,
  setSessionMeta,
  sweepEmptySessions,
  updateSessionMessage,
  editUserMessageAndTruncate,
  normalizeLockdownPreferencePatch,
  normalizeInitialPrompt,
  MAX_INITIAL_PROMPT_CHARS,
};
