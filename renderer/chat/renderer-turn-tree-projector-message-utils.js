/* renderer/chat/renderer-turn-tree-projector-message-utils.js -- pure
 * message/phase field normalizers shared by the turn-tree projector (UMD).
 * Extracted from renderer-turn-tree-projector.js to keep it under the
 * modularity cap; no behavior of its own beyond these helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-turn-normalization-utils'));
    return;
  }
  root.rendererTurnTreeProjectorMessageUtils = factory(root.rendererTurnNormalizationUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils) {
  'use strict';

  const { deepCloneJsonValue, normalizeId } = turnNormalizationUtils;

  function cloneNoticePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return deepCloneJsonValue(value);
  }

  function clonePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return deepCloneJsonValue(value);
  }

  function cloneSubagentReportMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const metadata = {};
    for (const key of ['subagent_report', 'subagent_batch_report']) {
      const report = cloneNoticePayload(value[key]);
      if (report) metadata[key] = report;
    }
    // ask_user settled receipts render from these two fields; without them the
    // message-derived projection can only fall back to generic tool markup.
    const resultKind = typeof value.result_kind === 'string' ? value.result_kind.trim().slice(0, 64) : '';
    if (resultKind === 'user_questions_answered' || resultKind === 'user_questions_declined') {
      metadata.result_kind = resultKind;
      if (Array.isArray(value.answers)) {
        metadata.answers = deepCloneJsonValue(value.answers.slice(0, 8));
      }
    }
    return Object.keys(metadata).length ? metadata : null;
  }

  function contextCompactedPayloadsMatch(left, right) {
    if (!left || !right) return false;
    return String(left.strategy || '') === String(right.strategy || '')
      && String(left.summaryStatus || '') === String(right.summaryStatus || '')
      && String(left.reasonCode || '') === String(right.reasonCode || '')
      && (Number(left.tokensBefore) || 0) === (Number(right.tokensBefore) || 0)
      && (Number(left.tokensAfter) || 0) === (Number(right.tokensAfter) || 0);
  }

  function normalizeRecoveryActionText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeRecoveryActions(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return null;
        }
        const id = normalizeRecoveryActionText(entry.id);
        if (!id) {
          return null;
        }
        const label = normalizeRecoveryActionText(entry.label);
        return label ? { id, label } : { id };
      })
      .filter(Boolean);
  }

  function buildInteractiveRecapViewModel(message) {
    const recap = message && message.interactive_round_recap && typeof message.interactive_round_recap === 'object'
      ? message.interactive_round_recap
      : {};
    return {
      requestId: normalizeId(recap.request_id || message && (message.request_id || message.requestId)),
    };
  }

  function buildPlanDocumentEvent(message, messageIndex, intra, messageId) {
    const planDocument = message && message.plan_document && typeof message.plan_document === 'object'
      ? message.plan_document
      : {};
    return {
      message_index: messageIndex,
      intra_message_order: intra,
      primary_message_id: messageId,
      source_message_ids: [messageId],
      tool_call_id: normalizeId(planDocument.tool_call_id),
      status: normalizeId(planDocument.state || message && message.status),
      payload: { ...planDocument, transition: normalizeId(planDocument.state) },
    };
  }

  function planDocumentParentStreamId(message) {
    return normalizeId(message && message.plan_document && message.plan_document.parent_stream_id);
  }

  function groupLegacyReasoningEntries(entries) {
    const groups = [];
    const list = Array.isArray(entries) ? entries : [];
    let current = null;
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const thinkingId = normalizeId(entry && entry.thinkingId);
      if (!current || current.thinkingId !== thinkingId) {
        current = {
          thinkingId,
          entries: [],
        };
        groups.push(current);
      }
      current.entries.push(entry);
    }
    return groups;
  }

  function getPhaseField(phase, key) {
    if (!phase || typeof phase !== 'object') {
      return '';
    }
    return normalizeId(phase[key] || phase[key.replace(/_([a-z])/g, (_, value) => value.toUpperCase())]);
  }

  return {
    cloneNoticePayload,
    clonePlainObject,
    cloneSubagentReportMetadata,
    contextCompactedPayloadsMatch,
    normalizeRecoveryActions,
    buildInteractiveRecapViewModel,
    buildPlanDocumentEvent,
    planDocumentParentStreamId,
    groupLegacyReasoningEntries,
    getPhaseField,
  };
});
