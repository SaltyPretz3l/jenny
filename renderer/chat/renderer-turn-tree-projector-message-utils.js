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

  function copyHomeMetadata(metadata, value) {
    metadata.result_kind = 'home';
    for (const key of ['action', 'status']) {
      if (typeof value[key] !== 'string') continue;
      const text = value[key].trim();
      if (text.length <= 64) metadata[key] = text;
    }
    const calendar = cloneNoticePayload(value.calendar);
    if (calendar) {
      if (Array.isArray(calendar.instances)) calendar.instances = calendar.instances.slice(0, 40);
      metadata.calendar = calendar;
    }
    const calendarReceipt = cloneNoticePayload(value.calendar_receipt);
    if (calendarReceipt) metadata.calendar_receipt = calendarReceipt;
  }

  // A Docker sandbox receipt keeps the exit status under execution; a run the
  // sandbox itself stopped has none to show (mirrors tool-call-utils).
  const SANDBOX_NO_EXIT_STATUSES = new Set(['timed_out', 'cancelled', 'interrupted', 'output_limit', 'running', 'preparing']);
  function commandExitCode(value, toolResult) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const execution = source.execution && typeof source.execution === 'object' && !Array.isArray(source.execution)
      && !SANDBOX_NO_EXIT_STATUSES.has(String(source.execution.status || '').trim().toLowerCase())
      ? source.execution : {};
    const result = toolResult && typeof toolResult === 'object' ? toolResult : {};
    const code = source.exit_code ?? source.exitCode ?? execution.exit_code ?? execution.exitCode
      ?? result.exit_code ?? result.exitCode;
    return Number.isInteger(code) ? code : null;
  }

  // The memory chip (row 58 W1) rebuilds from exactly these scalar fields after a
  // cold reopen; the memory text itself is never among them.
  const MEMORY_METADATA_KEYS = Object.freeze(['result_kind', 'action', 'status', 'memory_id', 'revision',
    'operation_id', 'scope', 'kind', 'duplicate', 'undoable', 'reason', 'text_preview', 'origin']);

  function copyMemoryMetadata(metadata, value) {
    for (const key of MEMORY_METADATA_KEYS) {
      const field = value[key];
      if (typeof field === 'string') metadata[key] = field.slice(0, 256);
      else if (typeof field === 'boolean' || Number.isSafeInteger(field)) metadata[key] = field;
    }
  }

  // The proposal cards (row 59 checkpoint 3) rebuild from these ids after a cold reopen;
  // display content always comes from the live record, never from the stored result.
  const PROPOSAL_METADATA_KEYS = Object.freeze(['result_kind', 'proposal_id', 'revision', 'decision_state', 'action_state']);

  function copyProposalMetadata(metadata, value) {
    for (const key of PROPOSAL_METADATA_KEYS) {
      const field = value[key];
      if (typeof field === 'string') metadata[key] = field.slice(0, 128);
      else if (Number.isSafeInteger(field)) metadata[key] = field;
    }
  }

  // Scalar fields only, each string bounded: the fallback for every allow-list below.
  function copyScalarFields(target, source, keys, maxChars) {
    for (const key of keys) {
      const field = source[key];
      if (typeof field === 'string') target[key] = field.slice(0, maxChars);
      else if (typeof field === 'boolean' || Number.isFinite(field)) target[key] = field;
    }
    return target;
  }

  // The "Updated project notes" row (Open / Undo) rebuilds from these after a
  // cold reopen and settles Undo against the live journal; the note text is
  // never among them.
  const PROJECT_NOTES_METADATA_KEYS = Object.freeze(['result_kind', 'action', 'status', 'project_id',
    'journal_entry_id', 'revision', 'summary']);

  function copyProjectNotesMetadata(metadata, value) {
    copyScalarFields(metadata, value, PROJECT_NOTES_METADATA_KEYS, 256);
    if (value.lines && typeof value.lines === 'object' && !Array.isArray(value.lines)) {
      metadata.lines = copyScalarFields({}, value.lines, ['added', 'removed', 'changed'], 0);
    }
    if (Array.isArray(value.headings)) {
      metadata.headings = value.headings.filter((heading) => typeof heading === 'string')
        .slice(0, 6).map((heading) => heading.slice(0, 128));
    }
  }

  // Header meta the formatter reads (formatToolResultMeta): task mutations and verify verdicts.
  const RESULT_KIND_SCALAR_KEYS = Object.freeze({
    task_board: ['result_kind', 'action', 'status'],
    verify: ['result_kind', 'action', 'status', 'reason', 'passed_count', 'failed_count', 'duration_ms', 'attempt'],
  });
  // A Docker sandbox receipt's header facts, and the per-chat budget block's recovery link.
  const EXECUTION_SCALAR_KEYS = Object.freeze(['backend', 'status', 'exit_code', 'exitCode', 'output_truncated',
    'cleanup_confirmed']);
  const PROVENANCE_SCALAR_KEYS = Object.freeze(['seed', 'image_prompt', 'image_negative_prompt']);

  function copyPresentationMetadata(metadata, value, resultKind) {
    if (resultKind === 'project_notes') copyProjectNotesMetadata(metadata, value);
    if (RESULT_KIND_SCALAR_KEYS[resultKind]) copyScalarFields(metadata, value, RESULT_KIND_SCALAR_KEYS[resultKind], 256);
    copyScalarFields(metadata, value, ['quota_scope', 'session_budget_notice'], 64);
    for (const [key, keys, maxChars] of [['execution', EXECUTION_SCALAR_KEYS, 64], ['provenance', PROVENANCE_SCALAR_KEYS, 2000]]) {
      const nested = value[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const copy = copyScalarFields({}, nested, keys, maxChars);
        if (Object.keys(copy).length) metadata[key] = copy;
      }
    }
    // The review affordance keys on its presence; the change itself lives in the change ledger.
    const suggestedChange = value.suggested_change;
    if (suggestedChange && typeof suggestedChange === 'object' && !Array.isArray(suggestedChange)) {
      metadata.suggested_change = copyScalarFields({}, suggestedChange, Object.keys(suggestedChange).slice(0, 16), 256);
    } else if (suggestedChange === true) {
      metadata.suggested_change = true;
    }
  }

  // `toolResult` is the stored tool_result the metadata belongs to: older
  // results carry the command's exit status only at their top level.
  function cloneSubagentReportMetadata(value, toolResult) {
    const exitCode = commandExitCode(value, toolResult);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return exitCode != null ? { exit_code: exitCode } : null;
    }
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
    // Home calendar cards rebuild from these bounded persisted fields after a
    // cold reopen; without them only the generic tool result remains.
    if (resultKind === 'home') copyHomeMetadata(metadata, value);
    if (resultKind === 'memory') copyMemoryMetadata(metadata, value);
    if (resultKind === 'git_proposal' || resultKind === 'command_proposal') copyProposalMetadata(metadata, value);
    copyPresentationMetadata(metadata, value, resultKind);
    // A command the shell tool stopped at its time limit reads Timed out (B11).
    if (value.timed_out === true) metadata.timed_out = true;
    // A command's own exit status: the row reads "exit N" after a reopen too.
    if (exitCode != null) metadata.exit_code = exitCode;
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
