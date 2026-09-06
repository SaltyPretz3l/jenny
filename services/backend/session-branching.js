/**
 * Conversation branching for Jenny.
 *
 * Allows forking a session at any message, creating a new session
 * with the conversation history up to that point.  The new session
 * is linked to the parent for cross-session recall.
 */

const {
  normalizeSession,
  createSessionId,
  normalizeLinkedSessionIds,
} = require('./electron-session-store');
const {
  persistSessionWithShadow,
} = require('./session-store-mirror');
const {
  normalizeGeneratedArtifactMetadataList,
} = require('../artifact-metadata-utils');

function isBranchableMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const role = String(message.role || '').trim();
  const kind = String(message.kind || '').trim();
  return (role === 'user' || role === 'assistant') && !kind;
}

/**
 * Build a fork-safe replacement for a copied message's `tool_result`.
 *
 * Generated artifacts are session-scoped: their stored paths live under the
 * SOURCE session's scratch dir, and ArtifactWorkspaceService#resolveArtifact
 * asserts an artifact sits inside the *requesting* session's scratch dir
 * (PATH_OUTSIDE_SCRATCH). A branch that inherited `generated_artifacts` could
 * therefore never open them, and once the source session is deleted the
 * orphan-prune sweep removes the files outright. Drop the references at fork
 * time so the branch never advertises an artifact it cannot resolve.
 *
 * The copy in forkSession is a shallow spread, so `tool_result` is shared by
 * reference with the source session's message: this must return a NEW object
 * and never delete the key in place.
 *
 * The marker lives only in `tool_result.metadata` because
 * `normalizeToolResultMetadata` in message-normalization.js rebuilds
 * `tool_result` from a fixed field allowlist on every persist/read path and
 * spreads the metadata bag through verbatim; a top-level field is silently dropped.
 *
 * @param {Object} [toolResult] - The source message's tool_result, if any
 * @returns {Object|null} Replacement tool_result, or null when nothing to strip
 */
function dropInheritedArtifactReferences(toolResult) {
  if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) {
    return null;
  }
  const inherited = Array.isArray(toolResult.generated_artifacts)
    ? toolResult.generated_artifacts
    : [];
  if (!inherited.length) {
    return null;
  }
  const { generated_artifacts: _dropped, metadata, ...carried } = toolResult;
  const baseMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  return {
    ...carried,
    metadata: {
      ...baseMetadata,
      artifacts_not_carried: true,
    },
  };
}

/**
 * Build the carry-path replacement for a copied message's `tool_result`:
 * every generated artifact entry is rewritten onto the branch session via
 * `rewriteEntry` (see ArtifactWorkspaceService#cloneSessionArtifactsForBranch).
 *
 * Entries that fail to normalize are silently dropped - persistence's
 * normalizeToolResultMetadata would discard them anyway. An entry that
 * normalizes but cannot be rewritten means the carry contract broke for this
 * message, so it degrades to the B1 strip-and-mark shape instead of
 * advertising a reference the branch cannot resolve.
 *
 * @returns {Object|null} Replacement tool_result, or null when there is
 *                        nothing to rewrite
 */
function rewriteInheritedArtifactReferences(toolResult, rewriteEntry) {
  if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) {
    return null;
  }
  const inherited = Array.isArray(toolResult.generated_artifacts)
    ? toolResult.generated_artifacts
    : [];
  if (!inherited.length) {
    return null;
  }
  const rewritten = [];
  for (const entry of inherited) {
    const mapped = rewriteEntry(entry);
    if (mapped) {
      rewritten.push(mapped);
      continue;
    }
    if (normalizeGeneratedArtifactMetadataList([entry]).length) {
      return dropInheritedArtifactReferences(toolResult);
    }
  }
  return {
    ...toolResult,
    generated_artifacts: rewritten,
  };
}

function branchMessage(message, artifactRewrite) {
  const branched = {
    ...message,
    id: `msg_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    client_message_id: message.id,
  };
  const replacementToolResult = typeof artifactRewrite === 'function'
    ? rewriteInheritedArtifactReferences(message?.tool_result, artifactRewrite)
    : dropInheritedArtifactReferences(message?.tool_result);
  if (replacementToolResult) {
    branched.tool_result = replacementToolResult;
  }
  return branched;
}

function updateLinkedSessionIds(store, sessionId, linkedSessionId) {
  if (!store || !sessionId || !linkedSessionId) {
    return null;
  }
  const current = typeof store.getSession === 'function'
    ? store.getSession(sessionId)
    : null;
  if (!current) {
    return null;
  }
  const nextLinkedIds = normalizeLinkedSessionIds(
    [...(Array.isArray(current.linked_session_ids) ? current.linked_session_ids : []), linkedSessionId],
    sessionId
  );
  const existingLinkedIds = normalizeLinkedSessionIds(current.linked_session_ids, sessionId);
  if (
    nextLinkedIds.length === existingLinkedIds.length
    && nextLinkedIds.every((value, index) => value === existingLinkedIds[index])
  ) {
    return current;
  }
  if (typeof store._updateSessionRecord === 'function') {
    return store._updateSessionRecord(sessionId, {
      linked_session_ids: nextLinkedIds,
    }, {
      bumpUpdatedAt: false,
    });
  }
  if (typeof store.updateSession === 'function') {
    return store.updateSession(sessionId, {
      linked_session_ids: nextLinkedIds,
    });
  }
  if (typeof store.upsertSession === 'function') {
    return store.upsertSession(sessionId, {
      linked_session_ids: nextLinkedIds,
    }, {
      bumpUpdatedAt: false,
    });
  }
  if (typeof store._read === 'function' && typeof store._write === 'function') {
    const payload = store._read() || { sessions: {} };
    const sessions = payload.sessions && typeof payload.sessions === 'object' && !Array.isArray(payload.sessions)
      ? { ...payload.sessions }
      : {};
    sessions[sessionId] = {
      ...current,
      linked_session_ids: nextLinkedIds,
    };
    store._write({
      ...payload,
      sessions,
    });
    return sessions[sessionId];
  }
  return null;
}

/**
 * Fork a session at a specific message, creating a new branch session.
 *
 * The new session contains all messages up to and including the target
 * message.  The new session is linked to the parent session for
 * cross-session recall.
 *
 * @param {Object} sessionStore    - ElectronSessionStore instance
 * @param {string} sourceSessionId - The session to fork from
 * @param {string} atMessageId     - Fork point (inclusive)
 * @param {Object} [options]
 * @param {string} [options.title] - Optional title override for the branch
 * @param {Object} [options.shadowStore] - SessionShadowStore mirror for legacy listings
 * @param {string} [options.branchSessionId] - Pre-generated branch session id
 *   (used by forkSessionWithArtifacts so the artifact copy target and the
 *   persisted session agree); must be fresh - a collision aborts the fork
 * @param {Function} [options.artifactRewrite] - Per-entry generated-artifact
 *   rewriter; when present, copied tool results carry rewritten artifact
 *   references instead of the default strip-and-mark behavior
 * @returns {Object|null} Session summary of the new branch, or null on error
 */
function forkSession(sessionStore, sourceSessionId, atMessageId, options = {}) {
  const sourceSession = sessionStore.getSession(sourceSessionId);
  if (!sourceSession) {
    return null;
  }

  const targetMessageId = String(atMessageId || '').trim();
  if (!targetMessageId) {
    return null;
  }

  const requestedBranchId = String(options.branchSessionId || '').trim();
  if (requestedBranchId
    && (requestedBranchId === String(sourceSessionId) || sessionStore.getSession(requestedBranchId))) {
    // Never overwrite an existing session via a pre-generated id.
    return null;
  }

  const sourceMessages = Array.isArray(sourceSession.messages) ? sourceSession.messages : [];
  const forkIndex = sourceMessages.findIndex(
    (message) => String(message.id || '') === targetMessageId
  );
  if (forkIndex < 0) {
    return null;
  }
  const targetMessage = sourceMessages[forkIndex];
  if (!isBranchableMessage(targetMessage)) {
    return null;
  }

  const branchCreatedAt = new Date().toISOString();
  const branchedMessages = sourceMessages
    .slice(0, forkIndex + 1)
    .map((message) => branchMessage(message, options.artifactRewrite));

  if (branchedMessages.length === 0) {
    return null;
  }
  const branchMessageSeqCounter = branchedMessages.reduce((maxSeq, message) => {
    const eventSeq = Number.isInteger(message?.event_seq) ? message.event_seq : -1;
    return Math.max(maxSeq, eventSeq + 1);
  }, branchedMessages.length);

  const branchSessionId = requestedBranchId || createSessionId();
  const sourceTitle = String(sourceSession.title || 'Chat').trim();
  const branchTitle = String(options.title || '').trim()
    || `${sourceTitle} (branch)`;

  const linkedIds = normalizeLinkedSessionIds(
    [sourceSessionId, ...(sourceSession.linked_session_ids || [])],
    branchSessionId
  );

  const session = normalizeSession(branchSessionId, {
    title: branchTitle,
    preferred_model: sourceSession.preferred_model,
    reasoning_effort: sourceSession.reasoning_effort,
    conversation_mode: sourceSession.conversation_mode,
    context_preferences: sourceSession.context_preferences,
    lockdown: sourceSession.lockdown === true,
    linked_session_ids: linkedIds,
    branch_origin: {
      source_session_id: sourceSessionId,
      source_message_id: targetMessageId,
      source_title: sourceTitle,
      created_at: branchCreatedAt,
    },
    created_at: branchCreatedAt,
    updated_at: branchCreatedAt,
    messages: branchedMessages,
    message_seq_counter: branchMessageSeqCounter,
    turn_events: [],
    active_turn: null,
  });

  let summary;
  try {
    summary = persistSessionWithShadow(sessionStore, session, {
      shadowStore: options.shadowStore,
    });
  } catch (_error) {
    return null;
  }
  if (!summary || !sessionStore.getSession(branchSessionId)) {
    return null;
  }
  updateLinkedSessionIds(sessionStore, sourceSessionId, branchSessionId);
  if (options.shadowStore) {
    updateLinkedSessionIds(options.shadowStore, sourceSessionId, branchSessionId);
  }
  return summary;
}

function collectCarriedArtifactEntries(sessionStore, sourceSessionId, atMessageId) {
  const sourceSession = typeof sessionStore?.getSession === 'function'
    ? sessionStore.getSession(sourceSessionId)
    : null;
  const sourceMessages = Array.isArray(sourceSession?.messages) ? sourceSession.messages : [];
  const targetMessageId = String(atMessageId || '').trim();
  const forkIndex = sourceMessages.findIndex(
    (message) => String(message.id || '') === targetMessageId
  );
  if (forkIndex < 0) {
    return [];
  }
  const entries = [];
  for (const message of sourceMessages.slice(0, forkIndex + 1)) {
    const artifacts = message?.tool_result?.generated_artifacts;
    if (Array.isArray(artifacts)) {
      entries.push(...artifacts);
    }
  }
  return entries;
}

async function cleanupClonedBranchArtifacts(artifactService, branchSessionId) {
  if (typeof artifactService?.deleteSessionArtifacts !== 'function') {
    return;
  }
  try {
    await artifactService.deleteSessionArtifacts(branchSessionId);
  } catch (_error) {
    // Best effort: an undeletable leftover dir is reclaimed by the next
    // orphan prune once protection is released.
  }
}

/**
 * Fork a session and carry its generated artifacts into the branch (B2 of
 * the fork-artifact plan).
 *
 * The source session's artifact scratch dir is copied (size-capped) into a
 * pre-generated branch session id, and every copied message's
 * `generated_artifacts` entry is rewritten onto the branch's ids/paths. The
 * branch id is held out of the orphan prune for the whole window between
 * "files exist on disk" and "branch session is persisted", because the prune
 * only trusts persisted session ids.
 *
 * Any copy or rewrite failure degrades to plain forkSession semantics
 * (references stripped, `artifacts_not_carried` marker set) and removes the
 * partially copied dir, so a fork never fails outright because its artifacts
 * could not travel.
 *
 * @param {Object} sessionStore    - ElectronSessionStore instance
 * @param {string} sourceSessionId - The session to fork from
 * @param {string} atMessageId     - Fork point (inclusive)
 * @param {Object} [options] - forkSession options, plus:
 * @param {Object} [options.artifactService] - ArtifactWorkspaceService; when
 *   absent the fork falls back to strip-and-mark
 * @param {number} [options.maxArtifactCopyBytes] - Override for the copy
 *   size cap (defaults to the service's MAX_BRANCH_CLONE_TOTAL_BYTES)
 * @returns {Promise<Object|null>} Session summary of the new branch, or null
 */
async function forkSessionWithArtifacts(sessionStore, sourceSessionId, atMessageId, options = {}) {
  const { artifactService, maxArtifactCopyBytes, ...forkOptions } = (
    options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  );
  const carriedEntries = collectCarriedArtifactEntries(sessionStore, sourceSessionId, atMessageId);
  const carryableEntries = normalizeGeneratedArtifactMetadataList(carriedEntries);
  if (
    !carryableEntries.length
    || typeof artifactService?.cloneSessionArtifactsForBranch !== 'function'
  ) {
    return forkSession(sessionStore, sourceSessionId, atMessageId, forkOptions);
  }

  const branchSessionId = createSessionId();
  const releasePruneProtection = typeof artifactService.markSessionPruneProtected === 'function'
    ? artifactService.markSessionPruneProtected(branchSessionId)
    : () => {};
  try {
    let clone = null;
    try {
      clone = await artifactService.cloneSessionArtifactsForBranch(
        sourceSessionId,
        branchSessionId,
        Number.isFinite(maxArtifactCopyBytes) && maxArtifactCopyBytes > 0
          ? { maxTotalBytes: maxArtifactCopyBytes }
          : {}
      );
    } catch (_error) {
      clone = null;
    }

    const rewriteEntry = clone?.cloned === true && typeof clone.rewriteEntry === 'function'
      ? clone.rewriteEntry
      : null;
    if (rewriteEntry && carryableEntries.every((entry) => rewriteEntry(entry))) {
      let summary = null;
      try {
        summary = forkSession(sessionStore, sourceSessionId, atMessageId, {
          ...forkOptions,
          branchSessionId,
          artifactRewrite: rewriteEntry,
        });
      } catch (error) {
        // A throwing fork must not leak the copied dir.
        await cleanupClonedBranchArtifacts(artifactService, branchSessionId);
        throw error;
      }
      if (summary) {
        return summary;
      }
      // The branch never persisted: reclaim the copied files immediately.
      await cleanupClonedBranchArtifacts(artifactService, branchSessionId);
      return null;
    }

    if (clone?.cloned === true) {
      // Files copied but at least one carryable reference could not be
      // rewritten: fall back to strip-and-mark for the whole fork rather
      // than persist a half-carried branch.
      await cleanupClonedBranchArtifacts(artifactService, branchSessionId);
    }
    return forkSession(sessionStore, sourceSessionId, atMessageId, forkOptions);
  } finally {
    releasePruneProtection();
  }
}

module.exports = {
  forkSession,
  forkSessionWithArtifacts,
  isBranchableMessage,
  dropInheritedArtifactReferences,
  rewriteInheritedArtifactReferences,
};
