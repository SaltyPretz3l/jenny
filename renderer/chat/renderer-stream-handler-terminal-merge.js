/* renderer/chat/renderer-stream-handler-terminal-merge.js -- Pure merge/placement helpers for terminal stream hydration (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerTerminalMerge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeUnsavedDurability(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || String(value.state || '').toLowerCase() !== 'unsaved') return null;
    const artifactId = String(value.artifact_id || value.artifactId || '').trim();
    return {
      state: 'unsaved',
      reason: String(value.reason || '').slice(0, 80),
      scope: String(value.scope || 'assistant').slice(0, 40),
      ...(artifactId ? { artifact_id: artifactId } : {}),
    };
  }

  function buildAgentProgressSnapshot(message, messages, durableEnabled) {
    if (!durableEnabled) return null;
    const liveSteps = Array.isArray(message && message.agent_status_steps) ? message.agent_status_steps : [];
    if (!liveSteps.length) return null;
    const terminalCalls = new Set((Array.isArray(messages) ? messages : []).flatMap((entry) => {
      const result = entry && entry.tool_result;
      const metadata = result && result.metadata;
      const hasSingle = isValidatedSubagentReport(metadata && metadata.subagent_report);
      const batch = metadata && metadata.subagent_batch_report;
      const hasBatch = batch && typeof batch === 'object' && !Array.isArray(batch)
        && String(batch.batch_id || '').trim() && isTerminalReportStatus(batch.status)
        && Array.isArray(batch.tasks) && batch.tasks.length > 0
        && batch.tasks.every(isValidatedSubagentReport);
      const callId = String(result && result.call_id || '').trim();
      return callId && (hasSingle || hasBatch) ? [callId] : [];
    }));
    const snapshot = liveSteps.filter((step) => {
      const isSubagent = String(step?.taskType || step?.task_type || '') === 'sub_agent';
      const callId = String(step?.toolCallId || step?.tool_call_id || '').trim();
      return !isSubagent || !callId || !terminalCalls.has(callId);
    });
    return snapshot.length
      ? snapshot.map((step) => (step && typeof step === 'object' ? { ...step } : step))
      : null;
  }

  function isTerminalReportStatus(value) {
    return ['completed', 'partial', 'failed', 'cancelled', 'rejected', 'skipped_budget']
      .includes(String(value || '').trim().toLowerCase());
  }

  function isValidatedSubagentReport(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && String(value.task_id || '').trim() && String(value.summary || '').trim()
      && isTerminalReportStatus(value.status)
      && Array.isArray(value.evidence) && Array.isArray(value.tools_used)
      && Array.isArray(value.uncertainties));
  }

  function createTerminalMergeUtils(deps = {}) {
    const {
      normalizeId = (value) => String(value || '').trim(),
      readMessageAssociatedStreamId = () => '',
      isTerminalStatus = () => false,
      isCompleteStatus = () => false,
      isTerminalStreamLocalArtifact = () => false,
      appendClientLog = () => {},
    } = deps;

    function isPlainAssistantStreamMessage(message, normalizedStreamId) {
      return Boolean(
        message
        && String(message.role || '') === 'assistant'
        && !message.tool_call
        && !message.tool_result
        && readMessageAssociatedStreamId(message) === normalizedStreamId
      );
    }

    // One-shot late-terminal reconcile target: the newest non-complete
    // assistant bubble still tied to this stream — the partial a preempt
    // (clearStream with no terminal settle) left behind. Used by both
    // terminal handlers' late-reconcile branches.
    function findLateReconcileBubbleIndex(messages, normalizedStreamId) {
      if (!normalizedStreamId) {
        return -1;
      }
      for (let scan = messages.length - 1; scan >= 0; scan -= 1) {
        const candidate = messages[scan];
        if (
          candidate
          && String(candidate.role || '') === 'assistant'
          && !isCompleteStatus(candidate.status)
          && readMessageAssociatedStreamId(candidate) === normalizedStreamId
        ) {
          return scan;
        }
      }
      return -1;
    }

    function findUnpersistedTerminalArtifacts(currentMessages, hydratedMessages, hydratedIds, streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId) {
        return [];
      }
      const hydratedIdentityIds = new Set(hydratedIds);
      hydratedMessages.forEach((message) => {
        const clientMessageId = normalizeId(message?.client_message_id || message?.clientMessageId);
        if (clientMessageId) {
          hydratedIdentityIds.add(clientMessageId);
        }
      });
      const storeHasAssistantRowForStream = hydratedMessages.some((message) =>
        isPlainAssistantStreamMessage(message, normalizedStreamId)
      );
      if (storeHasAssistantRowForStream) {
        return [];
      }
      // The store has NO assistant row for this stream: the failure-marked
      // local bubble (partial text after a crash/cancel, or its error marker)
      // is the only surviving copy — keep it instead of letting hydration
      // delete it. Ordinary success bubbles remain excluded because persisted
      // success rows may carry no stream-id fields. The exception is an
      // explicitly unsaved success: it is the only copy and must survive until
      // retry/discard resolves it. A canonical id/client-id twin always wins.
      return currentMessages.filter((message) =>
        isPlainAssistantStreamMessage(message, normalizedStreamId)
        && isTerminalStatus(message?.status)
        && (
          !isCompleteStatus(message?.status)
          || normalizeId(message?.durability?.state).toLowerCase() === 'unsaved'
        )
        && ![
          message?.id,
          message?.client_message_id,
          message?.clientMessageId,
        ].some((value) => hydratedIdentityIds.has(normalizeId(value)))
        && Boolean(
          String(message?.content || '').trim()
          || String(message?.stream_error || '').trim()
        )
      );
    }

    // Content key for matching an optimistic user bubble against its persisted
    // counterpart. This is the content-keyed FALLBACK; the PRIMARY dedup path is
    // adoptPersistedUserMessageId (renderer-send-flow-helpers.js), which renames
    // the optimistic row by id before hydration. User content is a plain string
    // today; the Array branch defends against future block-content shapes.
    //
    // Whitespace: both sides are already .trim()-ed at the source (the optimistic
    // visiblePrompt in renderer-send-utils.js and the backend transcriptPrompt),
    // and neither collapses INTERNAL whitespace, so we only .trim() here. We must
    // NOT collapse internal whitespace (e.g. /\s+/ -> ' '): pasted code differing
    // only in indentation or blank-line runs would otherwise collide, and a
    // genuinely-new prompt could be wrongly dropped.
    //
    // Attachments: attachments-only sends carry empty text on both sides, so text
    // alone collides for every such message. The key folds in a stable, order-
    // independent list of attachment ids — the ids are symmetric (the same
    // attachmentBudget.accepted entries ride both the optimistic metadata and the
    // backend send payload, and the backend preserves source.id) — so two distinct
    // attachments-only prompts stay distinct. The key is a structural [text, ids]
    // tuple (JSON-serialized) rather than a delimiter-joined string, so it is
    // collision-proof by construction: a text-only prompt can never alias a
    // text+attachment prompt the way a chosen separator could be forged in content.
    function readUserMessageContentKey(message) {
      const raw = message?.content;
      let text = '';
      if (typeof raw === 'string') {
        text = raw;
      } else if (Array.isArray(raw)) {
        text = raw.map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).join('');
      } else if (raw != null) {
        text = String(raw);
      }
      const attachmentIds = (Array.isArray(message?.attachments) ? message.attachments : [])
        .map((attachment) => String(attachment?.id || '').trim())
        .filter(Boolean)
        .sort();
      return JSON.stringify([text.trim(), attachmentIds]);
    }

    // Multiset (content key -> count) of hydrated user messages, so a duplicate
    // optimistic user row is matched/consumed one-for-one against its persisted
    // twin while a genuinely-new or legitimately-repeated prompt is preserved.
    function buildHydratedUserContentCounts(hydratedMessages) {
      const counts = new Map();
      hydratedMessages.forEach((message) => {
        if (String(message?.role || '') !== 'user') {
          return;
        }
        const key = readUserMessageContentKey(message);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      return counts;
    }

    // Turn-anchored insertion index for a synthesized error bubble on the late-
    // error/finalized-stream path. The bubble belongs to `streamId`'s turn, so
    // it must land at the END of that turn, never past a newer turn's user
    // prompt. Anchor: the last message that belongs to this stream (its partial
    // assistant or its `user_<streamId>` prompt); the bubble goes right after
    // it. With no such anchor (the stream left no trace), return -1 so the
    // caller falls back to a tail append.
    function findSyntheticErrorInsertIndex(messages, streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId || !Array.isArray(messages) || !messages.length) {
        return -1;
      }
      const userPromptId = `user_${normalizedStreamId}`;
      let anchorIndex = -1;
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message) {
          continue;
        }
        if (
          readMessageAssociatedStreamId(message) === normalizedStreamId
          || normalizeId(message.id) === userPromptId
        ) {
          anchorIndex = index;
        }
      }
      return anchorIndex === -1 ? -1 : anchorIndex + 1;
    }

    // Merge a store-hydrated snapshot with the renderer's current live list,
    // preserving local-only messages at their ORIGINAL relative position
    // (anchored to the nearest preceding hydrated-known message) rather than
    // blind-appending them, and keeping unpersisted terminal artifacts.
    function mergeTerminalHydratedMessages(currentMessages, hydratedMessages, options = {}) {
      const list = Array.isArray(currentMessages) ? currentMessages : [];
      const sessionId = options.sessionId;
      if (!list.length) {
        return hydratedMessages;
      }
      const hydratedIds = new Set(
        hydratedMessages
          .map((message) => normalizeId(message?.id))
          .filter(Boolean)
      );
      const terminalArtifacts = findUnpersistedTerminalArtifacts(
        list,
        hydratedMessages,
        hydratedIds,
        options.streamId
      );
      let mergedMessages = hydratedMessages;
      // CTL-005: reconciliation runs unconditionally — list length is NOT a
      // set-difference invariant. An equal-length snapshot can replace one
      // local-only message with one newly durable message (net count
      // unchanged but the local one is still gone if we don't check), and a
      // SHORTER current list can still contain a message the hydrated
      // snapshot has no twin for. The old `list.length > hydratedMessages
      // .length` gate assumed a shrinking-or-equal list could never lose a
      // unique local message; it can. Only the id/content-multiset
      // reconciliation below (not the cardinality compare) tells local-only
      // apart from matched/consumed, so it must always run.
      const hydratedUserContentCounts = buildHydratedUserContentCounts(hydratedMessages);
      const localOnlyMessages = list.filter((message) => {
        const messageId = normalizeId(message?.id);
        if (
          !messageId
          || hydratedIds.has(messageId)
          || isTerminalStreamLocalArtifact(message, options.streamId)
        ) {
          return false;
        }
        // An optimistic user bubble (`user_local_*`) is "local-only" by id, but
        // if the hydrated snapshot already holds the same prompt at its canonical
        // position, re-appending it duplicates the bubble in unreachable scroll
        // dead-space. Consume one hydrated match per local user message so a
        // genuinely-new (or legitimately repeated) unpersisted prompt survives.
        if (String(message?.role || '') === 'user') {
          const key = readUserMessageContentKey(message);
          const remaining = hydratedUserContentCounts.get(key) || 0;
          if (remaining > 0) {
            hydratedUserContentCounts.set(key, remaining - 1);
            return false;
          }
        }
        return true;
      });
      if (localOnlyMessages.length) {
        appendClientLog('WARN', 'stream.terminal_hydration_preserved_local_messages', {
          sessionId: String(sessionId || '').slice(0, 30),
          streamId: String(options.streamId || '').slice(0, 30),
          preservedCount: localOnlyMessages.length,
        });
        // A preserved message must land at its ORIGINAL relative position, not
        // the tail: appending unconditionally is what let a preserved user
        // prompt render below the assistant reply that answered it during a
        // live incident (the store lost the prompt; hydration correctly kept
        // it, but the wrong PLACEMENT read as if the reply came first). Anchor
        // each preserved message to the nearest PRECEDING message in
        // `currentMessages` that also exists in the hydrated snapshot, and
        // insert it immediately after that anchor's position in the merged
        // output — after any earlier insertions sharing the same anchor, so
        // relative order among preserved messages is stable. A message with no
        // such anchor (everything before it in `currentMessages` is also
        // local-only) has nowhere to attach and goes to the front, ahead of
        // all hydrated messages, again preserving relative order among those.
        const localOnlyIds = new Set(localOnlyMessages.map((message) => normalizeId(message?.id)));
        // The nearest preceding anchor for each local-only message is the
        // last hydrated-known id seen while walking currentMessages in
        // order, so a single left-to-right pass stamps every local-only
        // message with its predecessor's id (or null if none yet seen).
        let runningAnchorId = null;
        const anchorIdByLocalId = new Map();
        list.forEach((message) => {
          const messageId = normalizeId(message?.id);
          if (messageId && hydratedIds.has(messageId)) {
            runningAnchorId = messageId;
            return;
          }
          if (messageId && localOnlyIds.has(messageId)) {
            anchorIdByLocalId.set(messageId, runningAnchorId);
          }
        });
        const frontInsertions = [];
        const insertionsByAnchorId = new Map();
        localOnlyMessages.forEach((message) => {
          const messageId = normalizeId(message?.id);
          const anchorId = anchorIdByLocalId.get(messageId) || null;
          if (!anchorId) {
            frontInsertions.push(message);
            return;
          }
          if (!insertionsByAnchorId.has(anchorId)) {
            insertionsByAnchorId.set(anchorId, []);
          }
          insertionsByAnchorId.get(anchorId).push(message);
        });
        const reordered = [];
        reordered.push(...frontInsertions);
        mergedMessages.forEach((message) => {
          reordered.push(message);
          const messageId = normalizeId(message?.id);
          const insertions = messageId ? insertionsByAnchorId.get(messageId) : null;
          if (insertions && insertions.length) {
            reordered.push(...insertions);
            // Consume the group: a duplicate id in the hydrated snapshot
            // (already-corrupt input) must not re-emit the same preserved
            // messages after its second occurrence.
            insertionsByAnchorId.delete(messageId);
          }
        });
        mergedMessages = reordered;
      }
      if (terminalArtifacts.length) {
        appendClientLog('WARN', 'stream.terminal_hydration_kept_unpersisted_bubble', {
          sessionId: String(sessionId || '').slice(0, 30),
          streamId: String(options.streamId || '').slice(0, 30),
          preservedCount: terminalArtifacts.length,
        });
        mergedMessages = mergedMessages.concat(terminalArtifacts);
      }
      return mergedMessages;
    }

    return {
      isPlainAssistantStreamMessage,
      findLateReconcileBubbleIndex,
      findUnpersistedTerminalArtifacts,
      readUserMessageContentKey,
      buildHydratedUserContentCounts,
      findSyntheticErrorInsertIndex,
      mergeTerminalHydratedMessages,
    };
  }

  return { buildAgentProgressSnapshot, createTerminalMergeUtils, normalizeUnsavedDurability };
});
