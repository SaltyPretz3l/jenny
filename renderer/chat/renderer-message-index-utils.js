/* renderer/chat/renderer-message-index-utils.js — UMD
 * Single-pass derived-state computation and structure hashing for the
 * transcript render pipeline.  Replaces six independent O(n) scans in
 * renderMessages() with one backward pass, and replaces the O(n)-sized
 * structure signature string with a fixed-size numeric hash. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMessageIndexUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* ── kind sets (mirrors chat-message-utils / chat-bubble-action-utils) ── */

  const NON_ASSISTANT_KINDS = new Set([
    'interactive_round_recap',
    'slash_command_output',
  ]);

  const NON_REPLY_ASSISTANT_KINDS = new Set([
    'interactive_round_recap',
    'proactive_suggestion',
    'question_batch',
    'slash_command_output',
    'tool_use',
  ]);

  // Resume-affordance tail: like NON_ASSISTANT_KINDS, plus the two assistant-role
  // rows that get APPENDED after a turn already ended. Status is deliberately not
  // considered -- a newer error or cancelled terminal must still supersede an
  // older budget stop, which is why latestReplyAssistantMessageId (complete-only)
  // is the wrong id here.
  const NON_RESUME_TAIL_ASSISTANT_KINDS = new Set([
    'interactive_round_recap',
    'proactive_suggestion',
    'question_batch',
    'slash_command_output',
  ]);

  const STREAMING_INELIGIBLE_KINDS = new Set([
    'question_batch',
    'interactive_round_recap',
    'slash_command_output',
  ]);

  // Turn plumbing that can legitimately trail the live assistant segment
  // mid-turn: tool_use/tool_result are appended after the segment while it is
  // still streaming, and handleApprovalNeeded (renderer-stream-handler-tools.js)
  // pushes a settled `plan_document` message the same way WITHOUT finalizing
  // the pending segment the way handleToolUse does. These must not steal the
  // "latest assistant" slot for streaming detection, or the live segment loses
  // its streaming-target status — at every tool boundary, and at every plan
  // proposal — and delta patching stalls until the turn completes.
  // A plain assistant message (kind '') trailing the segment is NOT plumbing:
  // it means the streaming row is a remnant, and adoption must stop there.
  const STREAM_TAIL_PLUMBING_KINDS = new Set([
    'tool_use',
    'tool_result',
    'plan_document',
  ]);

  function buildAttachmentSignature(message) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.length) {
      return '';
    }
    return attachments
      .map((attachment) => [
        String(attachment?.id || ''),
        String(attachment?.kind || ''),
        String(attachment?.sourceKind || ''),
        String(attachment?.assetPath || ''),
        String(attachment?.mimeType || ''),
        String(attachment?.durationMs || ''),
      ].join('~'))
      .join('^');
  }

  function buildAgentStatusSignature(message) {
    const lifecycle =
      message?.agent_status && typeof message.agent_status === 'object' && !Array.isArray(message.agent_status)
        ? message.agent_status
        : null;
    const steps = Array.isArray(message?.agent_status_steps) ? message.agent_status_steps : [];
    const snapshotValue = message?.agent_progress_snapshot;
    const snapshot = Array.isArray(snapshotValue)
      ? snapshotValue.filter((step) => step && typeof step === 'object' && !Array.isArray(step))
      : [];
    if (!lifecycle && !steps.length && !snapshot.length) {
      return '';
    }
    const lifecycleSignature = lifecycle
      ? [
          String(lifecycle?.taskId || lifecycle?.task_id || ''),
          String(lifecycle?.agentId || lifecycle?.agent_id || ''),
          String(lifecycle?.parentAgentId || lifecycle?.parent_agent_id || ''),
          String(lifecycle?.toolCallId || lifecycle?.tool_call_id || ''),
          String(lifecycle?.childTaskId || lifecycle?.child_task_id || ''),
          String(lifecycle?.childAgentId || lifecycle?.child_agent_id || ''),
          String(lifecycle?.childOrdinal ?? lifecycle?.child_ordinal ?? ''),
          String(lifecycle?.childCount ?? lifecycle?.child_count ?? ''),
          String(lifecycle?.childLabel || lifecycle?.child_label || ''),
          String(lifecycle?.model || ''),
          String(lifecycle?.provider || ''),
          boundedValueSignature(lifecycle?.usage),
          String(lifecycle?.terminalReason || lifecycle?.terminal_reason || ''),
          String(lifecycle?.taskType || lifecycle?.task_type || ''),
          String(lifecycle?.source || ''),
          String(lifecycle?.status || ''),
          String(lifecycle?.stage || ''),
          String(lifecycle?.percent ?? ''),
          String(lifecycle?.summary || ''),
          lifecycle?.terminal === true ? '1' : '0',
          lifecycle?.success === true ? '1' : '0',
        ].join('~')
      : '';
    const stepsSignature = steps
      .map((step) => [
        String(step?.taskId || step?.task_id || ''),
        String(step?.agentId || step?.agent_id || ''),
        String(step?.parentAgentId || step?.parent_agent_id || ''),
        String(step?.toolCallId || step?.tool_call_id || ''),
        String(step?.childTaskId || step?.child_task_id || ''),
        String(step?.childAgentId || step?.child_agent_id || ''),
        String(step?.childOrdinal ?? step?.child_ordinal ?? ''),
        String(step?.childCount ?? step?.child_count ?? ''),
        String(step?.childLabel || step?.child_label || ''),
        String(step?.model || ''),
        String(step?.provider || ''),
        boundedValueSignature(step?.usage),
        String(step?.terminalReason || step?.terminal_reason || ''),
        String(step?.stage || ''),
        String(step?.status || ''),
        String(step?.percent ?? ''),
        String(step?.summary || ''),
        step?.terminal === true ? '1' : '0',
        step?.success === true ? '1' : '0',
      ].join('~'))
      .join('^');
    const snapshotSignature = snapshot
      .map((step) => [
        String(step?.taskId || step?.task_id || ''),
        String(step?.agentId || step?.agent_id || ''),
        String(step?.parentAgentId || step?.parent_agent_id || ''),
        String(step?.toolCallId || step?.tool_call_id || ''),
        String(step?.childTaskId || step?.child_task_id || ''),
        String(step?.childAgentId || step?.child_agent_id || ''),
        String(step?.childOrdinal ?? step?.child_ordinal ?? ''),
        String(step?.childCount ?? step?.child_count ?? ''),
        String(step?.childLabel || step?.child_label || ''),
        String(step?.model || ''),
        String(step?.provider || ''),
        boundedValueSignature(step?.usage),
        String(step?.terminalReason || step?.terminal_reason || ''),
        String(step?.stage || ''),
        String(step?.status || ''),
        String(step?.percent ?? ''),
        String(step?.summary || ''),
        step?.terminal === true ? '1' : '0',
        step?.success === true ? '1' : '0',
      ].join('~'))
      .join('^');
    return [lifecycleSignature, stepsSignature, snapshotSignature].join('|');
  }

  function buildReasoningPhaseSignature(message) {
    const phases = Array.isArray(message?.reasoning_phases) ? message.reasoning_phases : [];
    if (!phases.length) {
      return '';
    }
    return phases
      .map((phase) => [
        String(phase?.phaseId || ''),
        String(phase?.phaseKind || ''),
        String(phase?.iteration || ''),
        String(phase?.thinkingId || ''),
        String(phase?.toolCallId || ''),
        String(phase?.toolName || ''),
        phase?.completed === true ? '1' : '0',
        phase?.renderCollapsed === true ? '1' : '0',
        String(phase?.summary || ''),
        String(phase?.tokensPerSecond ?? phase?.tokens_per_second ?? ''),
        String(phase?.startedAt || ''),
        String(phase?.completedAt || ''),
      ].join('~'))
      .join('^');
  }

  // message.phases is the DURABLE phase structure; reasoning_phases (hashed
  // above) is a DERIVED projection of it, filtered to reasoning kind, so the
  // signature above covers only that slice. The turn projector reads
  // message.phases directly in emitAssistantEvents: `text` phases bucket
  // visible_segments and emit them IN PHASE ORDER, `reasoning` phases emit the
  // reasoning_phase rows, and an empty phases array is what routes a
  // segment-less message to the legacy whole-content row. A persisted phase
  // structure that arrives or is regrouped under a stable message id with
  // byte-identical content, segments and reasoning entries moves nothing else
  // sampled here, so the id-keyed equal-state reuse below would hand back the
  // pre-phase content token and the per-turn turnRowCache would serve the
  // ungrouped rows. Only the ordered id/kind pairs are folded: that is
  // everything the projector reads off a NON-reasoning phase, and every
  // reasoning-phase lifecycle field is already hashed above, so nothing is
  // re-hashed per frame. phase.entries text is deliberately excluded (CTL-012
  // anti-flicker) — entry lengths and the last entry's text are sampled
  // separately. Keep reconciled with the twin list in
  // buildSourceStructureSignature (renderer-render-pipeline-message-renderer.js),
  // which folds message.phases.length for the canonical-transcript rebuild.
  function buildPhaseStructureSignature(message) {
    const phases = Array.isArray(message?.phases) ? message.phases : [];
    if (!phases.length) {
      return '';
    }
    return phases
      .map((phase) => [
        String(phase?.phaseId || phase?.phase_id || ''),
        String(phase?.phaseKind || phase?.phase_kind || ''),
      ].join('~'))
      .join('^');
  }

  function hashField(hash, field) {
    const text = String(field || '');
    let nextHash = Number(hash) || 5381;
    for (let index = 0; index < text.length; index += 1) {
      nextHash = ((nextHash << 5) + nextHash + text.charCodeAt(index)) | 0;
    }
    return ((nextHash << 5) + nextHash + 58) | 0;
  }

  function hashFields(fields, seed) {
    const list = Array.isArray(fields) ? fields : [];
    let hash = Number(seed) || 5381;
    for (let index = 0; index < list.length; index += 1) {
      hash = hashField(hash, list[index]);
    }
    return hash;
  }

  let nextMessageFingerprintRevision = 1;

  function fingerprintStatesMatch(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }

  // Fixed-size object revisions are shared by the render no-op guard and the
  // per-turn projection cache. Immutable message replacement makes both settled
  // and streaming cache hits independent of cumulative transcript byte size.
  const messageFingerprintCache = new WeakMap();

  // Secondary content-identity index keyed by message id. Hydration and
  // reconcile replace message objects wholesale with equal-content copies; a
  // purely object-keyed monotonic revision would mint a new fingerprint for
  // every copy and invalidate the whole render/projection cache on each
  // rehydrate. An equal-state replacement inherits the prior entry instead.
  // Bounded by insertion-order eviction as a leak backstop.
  const fingerprintEntryByMessageId = new Map();
  const MAX_FINGERPRINT_ID_ENTRIES = 8192;

  // Fixed-size value signature (length + djb2 hash) so nested payloads of any
  // size contribute a bounded field to the fingerprint state.
  function boundedValueSignature(value) {
    if (value === null || value === undefined) {
      return '';
    }
    let text;
    if (typeof value === 'object') {
      try {
        text = JSON.stringify(value) || '';
      } catch (error) {
        text = `unserializable:${Object.keys(value).length}`;
      }
    } else {
      text = String(value);
    }
    return `${text.length.toString(36)}:${(hashField(5381, text) >>> 0).toString(36)}`;
  }

  // tool_result.metadata is replacement-visible (monitor progress, diffs, exit
  // codes all reach the DOM through the tool rows), so the whole object must
  // contribute to the fingerprint state. The whole-object signature is cached
  // per metadata object ref — large payloads (diffs) cost one stringify per
  // replacement, not one per frame. metadata.monitor is the known
  // live-mutating branch and is small, so it is re-read on every resolve to
  // keep same-object monitor updates visible to the render no-op guard.
  const toolResultMetadataSignatureCache = new WeakMap();
  function buildToolResultMetadataSignature(toolResult) {
    const metadata = toolResult && toolResult.metadata
      && typeof toolResult.metadata === 'object' && !Array.isArray(toolResult.metadata)
      ? toolResult.metadata
      : null;
    if (!metadata) {
      return '';
    }
    let wholeSignature = toolResultMetadataSignatureCache.get(metadata);
    if (wholeSignature === undefined) {
      wholeSignature = boundedValueSignature(metadata);
      toolResultMetadataSignatureCache.set(metadata, wholeSignature);
    }
    return `${boundedValueSignature(metadata.monitor)}|${wholeSignature}`;
  }

  // Guards same-object writes to the per-step mutable fields (status and the
  // result-message link) without hashing tool payload content.
  function buildToolStepsSignature(message) {
    const steps = Array.isArray(message.tool_steps) ? message.tool_steps : [];
    if (!steps.length) {
      return '';
    }
    return steps
      .map((step) => [
        String(step?.callId || step?.call_id || ''),
        String(step?.status || ''),
        String(step?.toolResultMessageId || step?.tool_result_message_id || ''),
      ].join('~'))
      .join('^');
  }

  // The cache is keyed on message object identity. A fixed number of exact
  // primitive field values guards legacy same-object writes without building
  // transcript-sized concatenations or hashing cumulative content. New
  // mutation owners must still replace the message object. Nested collections
  // that mutate in place mid-turn (tool_steps status, agent_status lifecycle,
  // tool_result error fields) contribute bounded signatures here so a
  // same-object transition still invalidates the render no-op guard.
  function buildSettledFingerprintState(message) {
    const toolResult = message.tool_result && typeof message.tool_result === 'object' ? message.tool_result : null;
    const toolCall = message.tool_call && typeof message.tool_call === 'object' ? message.tool_call : null;
    return [
      String(message.id || ''),
      String(message.role || ''),
      String(message.kind || ''),
      String(message.status || ''),
      String(message.finalizedAt || ''),
      String(message.updatedAt || message.updated_at || ''),
      String(message.content || ''),
      // Per-entry text lengths (not just counts): with the id-keyed reuse of
      // equal-state replacements below, any field missing here makes an
      // object replacement carrying only that change invisible to the render
      // no-op guard. Lengths keep the state bounded while catching middle-
      // entry edits; the last entry's full text is included further down.
      Array.isArray(message.visible_segments)
        ? message.visible_segments.map((segment) => String(segment?.text || '').length).join(',')
        : '',
      Array.isArray(message?.reasoning?.entries)
        ? message.reasoning.entries.map((entry) => String(entry?.text || '').length).join(',')
        : '',
      buildReasoningPhaseSignature(message),
      buildPhaseStructureSignature(message),
      buildToolStepsSignature(message),
      buildAgentStatusSignature(message),
      buildAttachmentSignature(message),
      // Send failure: the same bug class. annotateUserSendFailureInStore (and
      // the failed-send notice's onDismiss) replace the user message adding /
      // flipping ONLY send_failure.{state,dismissed} — neither path bumps
      // updatedAt, so no other sampled field moves. Without these the id-keyed
      // equal-state reuse below hands back the PRE-FAILURE content token, the
      // per-turn turnRowCache serves the old rows, and every
      // row.projection_fingerprint derived from that token stays put — so the
      // active turn's structure hash AND tail fingerprint (both fold
      // projection_fingerprint) match and patchActiveTurnRoot short-circuits to
      // a no-op "patched", leaving the user bubble's "Failed to send" chip
      // unpainted and, once painted, undismissable. Keep reconciled with the
      // twin list in buildSourceStructureSignature
      // (renderer-render-pipeline-message-renderer.js), which already samples
      // exactly these two fields for the canonical-transcript rebuild.
      String((message.send_failure && message.send_failure.state) || ''),
      String(message.send_failure && message.send_failure.dismissed ? '1' : ''),
      // Interactive round recap: the same bug class once more. The recap object
      // IS the entire rendered row — emitAssistantEvents carries it verbatim
      // into the interactive_recap payload and buildRecapRowMarkup renders from
      // that alone — while message.content is only the kicker line, so a recap
      // replaced under a stable message id (answers re-recorded, the collapsed
      // flag persisted, a recap attached where there was none) moves no other
      // field sampled here. computeTurnStructureHash is blind to it too: a
      // recap row carries no payload.state and its row_id is content-free, so
      // the tail fingerprint derived from row.projection_fingerprint is again
      // the only gate patchActiveTurnRoot has. Bounded signature rather than
      // list 1's raw JSON.stringify so this state stays fixed-size; it yields
      // '' for every message without a recap, so it is byte-inert elsewhere.
      boundedValueSignature(message.interactive_round_recap),
      toolResult ? String(toolResult.status || '') : '',
      toolResult ? String(toolResult.output_text || '') : '',
      toolResult ? String(toolResult.summary || '') : '',
      toolResult ? String(toolResult.error_code || '') : '',
      toolResult && toolResult.is_error === true ? '1' : '0',
      // Whole-record bounded signatures: artifact records are small metadata
      // objects, and EVERY field is replacement-visible (name/path/title/
      // status all reach artifact cards) — enumerating fields left gaps.
      toolResult && Array.isArray(toolResult.generated_artifacts)
        ? toolResult.generated_artifacts.map((artifact) => boundedValueSignature(artifact)).join('^')
        : '',
      buildToolResultMetadataSignature(toolResult),
      toolCall ? String(toolCall.status || '') : '',
      toolCall ? String(toolCall.input_json || '') : '',
      toolCall ? String(toolCall.summary || '') : '',
      String(message.reasoning?.entries?.at?.(-1)?.text || ''),
      String(message.visible_segments?.at?.(-1)?.text || ''),
      String(message.durability?.state || message.durability?.status || ''),
      String(message.durability?.revision ?? message.durability?.commit_epoch ?? ''),
    ];
  }

  function resolveMessageFingerprint(message) {
    if (!message || typeof message !== 'object') {
      return { content: `primitive:${hashField(5381, message).toString(36)}` };
    }
    const state = buildSettledFingerprintState(message);
    const cached = messageFingerprintCache.get(message);
    if (cached && fingerprintStatesMatch(cached.state, state)) {
      return cached;
    }
    const messageId = String(message.id || '');
    const idCached = messageId ? fingerprintEntryByMessageId.get(messageId) : null;
    const revision = nextMessageFingerprintRevision;
    nextMessageFingerprintRevision += 1;
    if (nextMessageFingerprintRevision > Number.MAX_SAFE_INTEGER) {
      nextMessageFingerprintRevision = 1;
    }
    const renderToken = `m:${revision.toString(36)}`;
    // An equal-state replacement inherits the prior PROJECTION revision
    // (content) so per-turn projection caches survive rehydrate, but the
    // RENDER token is minted per object: replacement is deliberately
    // authoritative for the render no-op guard, without a deep comparison
    // (settled-refresh / CTL-012 anti-freeze pins).
    const entry = idCached && fingerprintStatesMatch(idCached.state, state)
      ? { state: idCached.state, content: idCached.content, render: renderToken }
      : { state, content: renderToken, render: renderToken };
    messageFingerprintCache.set(message, entry);
    if (messageId) {
      if (!fingerprintEntryByMessageId.has(messageId)
        && fingerprintEntryByMessageId.size >= MAX_FINGERPRINT_ID_ENTRIES) {
        fingerprintEntryByMessageId.delete(fingerprintEntryByMessageId.keys().next().value);
      }
      fingerprintEntryByMessageId.set(messageId, entry);
    }
    return entry;
  }

  // Message owners replace the object on every semantic mutation. A monotonic
  // object revision is therefore an exact, fixed-size projection fingerprint;
  // it avoids re-reading cumulative transcript bytes on each streaming delta.
  function buildMessageProjectionFingerprint(message) {
    return resolveMessageFingerprint(message).content;
  }

  function computeMessageFingerprintList(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const result = new Array(list.length);
    for (let index = 0; index < list.length; index += 1) {
      result[index] = resolveMessageFingerprint(list[index]);
    }
    return result;
  }

  function signatureFromFingerprints(fingerprints, prefix, useRenderToken) {
    const list = Array.isArray(fingerprints) ? fingerprints : [];
    let hashA = 5381;
    let hashB = 52711;
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const token = (useRenderToken ? entry?.render || entry?.content : entry?.content) || '';
      hashA = hashField(hashA, token);
      hashB = hashField(hashB, token);
    }
    return `${prefix}:${list.length.toString(36)}:${(hashA >>> 0).toString(36)}:${(hashB >>> 0).toString(36)}`;
  }

  function renderSignatureFromFingerprints(fingerprints) {
    // Hashes the per-object render token (falling back to the projection
    // revision for primitive/fallback entries) so an object replacement is
    // authoritative even when its projection revision was inherited.
    return signatureFromFingerprints(fingerprints, 'r', true);
  }

  function computeProjectionSignatureFromFingerprints(fingerprints) {
    return signatureFromFingerprints(fingerprints, 'p');
  }

  function buildMessageRenderSignature(messages) {
    return renderSignatureFromFingerprints(computeMessageFingerprintList(messages));
  }

  /* ── single-pass derived state ── */

  /**
   * Computes all per-render derived values in a single backward pass.
   *
   * @param {Array} messages  Flat message array for the current session.
   * @param {Object} [options]
   * @param {Function} [options.shouldShowThinkingToggle]  Per-message predicate
   *   from chatThinkingUtils — self-contained (role + reasoning), no ordering
   *   dependency.
   * @returns {{
   *   latestAssistantMessageId: string,
   *   streamTargetAssistantMessageId: string,
   *   latestReplyAssistantMessageId: string,
   *   thinkingMessageIds: string[],
   *   streamingMessage: (object|null),
   *   idToIndex: Map<string,number>,
   * }}
   */
  /**
   * Latest assistant message that can own a Resume affordance, scanning back from
   * the tail. Cheap: it returns at the first assistant row, so it walks only the
   * trailing non-assistant rows (typically none).
   * @param {Array<Object>} messages
   * @returns {string}
   */
  function resolveResumeTailAssistantMessageId(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i];
      if (!message || String(message.role || '') !== 'assistant') {
        continue;
      }
      if (NON_RESUME_TAIL_ASSISTANT_KINDS.has(String(message.kind || ''))) {
        continue;
      }
      return String(message.id || '');
    }
    return '';
  }

  function computeDerivedMessageState(messages, options) {
    const list = Array.isArray(messages) ? messages : [];
    const settings = options || {};
    const thinkingPredicate = typeof settings.shouldShowThinkingToggle === 'function'
      ? settings.shouldShowThinkingToggle
      : null;

    let latestAssistantMessageId = '';
    let latestReplyAssistantMessageId = '';
    let latestStreamTargetAssistantMessageId = '';
    let streamingMessage = null;
    const thinkingMessageIds = [];
    const idToIndex = new Map();

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i];
      if (!message) {
        continue;
      }

      const id = String(message.id || '');
      const role = String(message.role || '');
      const kind = String(message.kind || '');
      const status = String(message.status || '');

      // Build id → index map (first-seen wins for duplicates scanned backward,
      // but ids should be unique; forward-order index is correct here).
      idToIndex.set(id, i);

      // Latest assistant message (any non-excluded kind).
      if (!latestAssistantMessageId && role === 'assistant' && !NON_ASSISTANT_KINDS.has(kind)) {
        latestAssistantMessageId = id;
      }

      // Latest assistant message eligible as a streaming target: turn plumbing
      // rows are skipped so the newest unfinalized segment stays the streaming
      // target across tool boundaries and plan proposals.
      if (
        !latestStreamTargetAssistantMessageId
        && role === 'assistant'
        && !NON_ASSISTANT_KINDS.has(kind)
        && !STREAM_TAIL_PLUMBING_KINDS.has(kind)
      ) {
        latestStreamTargetAssistantMessageId = id;
      }

      // Latest reply-eligible assistant message (complete + non-excluded kind).
      if (!latestReplyAssistantMessageId && role === 'assistant' && !NON_REPLY_ASSISTANT_KINDS.has(kind)) {
        const resolvedStatus = status || (role === 'assistant' ? 'complete' : 'complete');
        if (resolvedStatus === 'complete') {
          latestReplyAssistantMessageId = id;
        }
      }

      // Streaming message detection — must be the latest stream-target-eligible
      // assistant message (tool plumbing rows that trail the live segment are
      // ignored), have status 'streaming', and not be an ineligible kind.
      if (
        !streamingMessage &&
        role === 'assistant' &&
        status === 'streaming' &&
        id === latestStreamTargetAssistantMessageId &&
        !STREAMING_INELIGIBLE_KINDS.has(kind)
      ) {
        streamingMessage = message;
      }

      // Thinking toggle — predicate is self-contained per message.
      if (thinkingPredicate && thinkingPredicate(message)) {
        thinkingMessageIds.push(id);
      }
    }

    // thinkingMessageIds was built backward; reverse to match forward order.
    thinkingMessageIds.reverse();

    return {
      latestAssistantMessageId,
      streamTargetAssistantMessageId: latestStreamTargetAssistantMessageId,
      latestReplyAssistantMessageId,
      thinkingMessageIds,
      streamingMessage,
      idToIndex,
    };
  }

  /* ── structure hash ── */

  /**
   * djb2-style hash over the structural fields of every message.
   * Produces a fixed-size 32-bit number instead of an O(n)-length string.
   *
   * Hashes the same fields as buildTimelineStructureSignature:
   * id, role, kind, status, finalizedAt, hasReasoning.
   *
   * @param {Array} messages
   * @returns {number}
   */
  function computeStructureHash(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let hash = 5381;

    for (let i = 0; i < list.length; i += 1) {
      const message = list[i] || {};
      const id = String(message.id || '');
      const role = String(message.role || '');
      const kind = String(message.kind || '');
      const status = String(message.status || '');
      const finalizedAt = String(message.finalizedAt || '');
      const attachmentSignature = buildAttachmentSignature(message);
      const agentStatusSignature = buildAgentStatusSignature(message);
      const hasReasoning = Boolean(
        message.reasoning
        && Array.isArray(message.reasoning.entries)
        && message.reasoning.entries.length
        && String(message.reasoning.source || '') === 'provider'
      );
      const phaseSignature = buildReasoningPhaseSignature(message);

      // Hash each field's characters in sequence, separated by a delimiter byte.
      const fields = [
        id,
        role,
        kind,
        status,
        finalizedAt,
        attachmentSignature,
        agentStatusSignature,
        phaseSignature,
        hasReasoning ? 'R' : '',
      ];
      for (let f = 0; f < fields.length; f += 1) {
        const field = fields[f];
        for (let c = 0; c < field.length; c += 1) {
          hash = ((hash << 5) + hash + field.charCodeAt(c)) | 0;
        }
        // Field delimiter.
        hash = ((hash << 5) + hash + 58) | 0; // 58 = ':'
      }
      // Message delimiter.
      hash = ((hash << 5) + hash + 124) | 0; // 124 = '|'
    }

    return hash;
  }

  /* ── tail fingerprint (Phase 3) ── */

  /**
   * Produces a short fingerprint for a single message, used only for the
   * tail-position incremental DOM check.
   *
   * @param {Object} message
   * @returns {string}
   */
  function tailFingerprint(message) {
    if (!message) {
      return '';
    }
    const attachmentSignature = buildAttachmentSignature(message);
    const hasReasoning = Boolean(
      message.reasoning
      && Array.isArray(message.reasoning.entries)
      && message.reasoning.entries.length
      && String(message.reasoning.source || '') === 'provider'
    );
    const phaseSignature = buildReasoningPhaseSignature(message);
    return [
      String(message.id || ''),
      String(message.role || ''),
      String(message.kind || ''),
      String(message.status || ''),
      String(message.finalizedAt || ''),
      phaseSignature,
      attachmentSignature || (hasReasoning ? 'R' : ''),
    ].join(':');
  }

  function computeProjectionSignature(messages) {
    // Hashes the *structural* fingerprint of each message so a streaming
    // message's growing text does not invalidate the projection cache key
    // (finding #1). Settled messages hash their full content fingerprint, so
    // any settled content change still invalidates the cache. The hot render
    // path threads a precomputed fingerprint list straight into
    // computeProjectionSignatureFromFingerprints; this wrapper keeps the
    // signature identical for the standalone/fallback callers.
    return computeProjectionSignatureFromFingerprints(computeMessageFingerprintList(messages));
  }

  function computeTurnStructureHash(turnMeta, rows) {
    const turn = turnMeta && typeof turnMeta === 'object' ? turnMeta : {};
    const list = Array.isArray(rows) ? rows : [];
    let hash = 5381;
    hash = hashFields([
      String(turn.turn_id || ''),
      String(turn.primary_user_message_id || ''),
      String(turn.primary_assistant_message_id || ''),
      Array.isArray(turn.source_message_ids) ? turn.source_message_ids.join('^') : '',
    ], hash);
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index] && typeof list[index] === 'object' ? list[index] : {};
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      hash = hashFields([
        String(row.kind || ''),
        String(row.row_id || ''),
        String(row.primary_message_id || ''),
        Array.isArray(row.source_message_ids) ? row.source_message_ids.join('^') : '',
        Array.isArray(row.source_events) ? row.source_events.join('^') : '',
        Array.isArray(row.first_event_sort_key) ? row.first_event_sort_key.join('^') : '',
        String(row.tool_call_id || ''),
        String(row.phase_id || ''),
        String(row.assistant_phase || ''),
        String(row.segment_group_index || ''),
        String(payload.state || ''),
        String(payload.subkind || ''),
      ], hash);
      hash = ((hash << 5) + hash + 124) | 0;
    }
    return hash;
  }

  function computeTurnTailFingerprint(turnMeta, rows) {
    const turn = turnMeta && typeof turnMeta === 'object' ? turnMeta : {};
    const list = Array.isArray(rows) ? rows : [];
    let hash = 5381;
    hash = hashFields([
      String(turn.turn_id || ''),
      String(turn.primary_user_message_id || ''),
      String(turn.primary_assistant_message_id || ''),
      Array.isArray(turn.source_message_ids) ? turn.source_message_ids.join('^') : '',
    ], hash);
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index] && typeof list[index] === 'object' ? list[index] : {};
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const reasoningEntries = Array.isArray(payload.entries) ? payload.entries : [];
      hash = hashFields([
        String(row.kind || ''),
        String(row.row_id || ''),
        String(row.primary_message_id || ''),
        String(row.tool_call_id || ''),
        String(row.phase_id || ''),
        String(row.assistant_phase || ''),
        String(row.segment_group_index || ''),
        String(payload.state || ''),
        // payload.text / payload.content intentionally excluded: growing text
        // content within a streaming assistant_text row is a content change,
        // not a structural change. Including it caused patchActiveTurnRoot to
        // do a full outerHTML replacement on every text delta whenever the
        // fingerprint was checked after a structural event (tool call, phase
        // transition). Structural changes are already captured by row_id above.
        // Surgical text updates are handled by queuePatch Case A via the
        // [data-streaming-bubble] element.
        String(payload.summary || ''),
        String(payload.output_text || ''),
        String(payload.result_summary || ''),
        String(payload.error_code || ''),
        payload.result_is_error === true ? '1' : '0',
        String(payload.subkind || ''),
        Array.isArray(payload.attachments) ? String(payload.attachments.length) : '0',
        Array.isArray(payload.segments) ? String(payload.segments.length) : '0',
        reasoningEntries
          .map((entry) => [
            String(entry?.id || ''),
            String(entry?.thinkingId || ''),
            String(entry?.timestamp || ''),
            // entry.text intentionally excluded: text growth within an existing
            // reasoning entry is not a structural change that warrants a root
            // replacement. Including it caused patchActiveTurnRoot to fire on
            // every streaming delta for heavy-reasoning models (800+ chunks),
            // producing visible flickering. Structural changes (new entries,
            // new phases, status/collapse transitions) are still detected via
            // the other fields and via the reasoning_phases hash above.
          ].join('~'))
          .join('^'),
        String(row.projection_fingerprint || ''),
        Array.isArray(row.source_events) ? row.source_events.join('^') : '',
      ], hash);
      hash = ((hash << 5) + hash + 124) | 0;
    }
    return `${String(turn.turn_id || '')}:${hash}`;
  }

  return {
    buildMessageProjectionFingerprint,
    buildMessageRenderSignature,
    computeDerivedMessageState,
    resolveResumeTailAssistantMessageId,
    computeMessageFingerprintList,
    renderSignatureFromFingerprints,
    computeProjectionSignature,
    computeProjectionSignatureFromFingerprints,
    computeStructureHash,
    computeTurnStructureHash,
    computeTurnTailFingerprint,
    tailFingerprint,
  };
});
