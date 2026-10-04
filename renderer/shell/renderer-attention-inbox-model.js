/* renderer/shell/renderer-attention-inbox-model.js -- "Needs you" model (UMD) */
/**
 * What is waiting on the person, across every session, opened or not.
 *
 * The two sources are the ones the renderer already holds: the global
 * approval map (`state.pendingToolApprovals`, keyed by call id across
 * sessions, so an approval can be answered without opening its chat) and the
 * session summaries' `pending_question_batch`. Nothing here reads a runtime
 * snapshot, a clock or a timestamp -- the data carries none, so the rows never
 * claim how long anything has waited.
 *
 * Honesty rules the model enforces, so no view can break them:
 *   - an approval row always carries its tool, its argument preview and the
 *     writes-or-not facts, because it is read out of the transcript's context;
 *   - "Always allow" is offered only where the transcript's approval block
 *     would offer it (`oneOffOnly` in either spelling withholds it);
 *   - an approval whose session is no longer listed is dropped rather than
 *     rendered against a title the model would have to invent;
 *   - a plan review is a row to OPEN, never one to approve in one line;
 *   - a send the runtime cannot start is listed only when its last reply's
 *     cleanup is unconfirmed (renderer-stuck-send.js): every other wait ends
 *     by itself, and the queue strip already says why.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAttentionInboxModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var PLAN_REVIEW_TOOL = 'exit_plan_mode';
  var INTRO_MAX_CHARS = 120;
  /* One row, one line: the transcript card quotes up to 600 characters and
   * folds the rest; here the bound is tighter and the clip says how much it
   * hid, in the card's own words, so a long payload never becomes a 40 KB
   * tooltip re-serialized into the render signature on every chrome pass. */
  var PREVIEW_MAX_CHARS = 240;
  /* Approvals first, then plan reviews, question batches, stuck sends. */
  var KIND_ORDER = { approval: 0, plan_review: 1, question: 2, stuck_send: 3 };
  /* One muted line, joined the way the Chats panel joins facts. */
  var LINE_SEPARATOR = ' · ';

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function clip(value, maxChars) {
    var normalized = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    var characters = Array.from(normalized);
    // A clipped text ends in an ellipsis so it never reads as a whole sentence.
    return characters.length > maxChars ? characters.slice(0, maxChars).join('') + '…' : normalized;
  }

  function toEntries(pendingToolApprovals) {
    if (!pendingToolApprovals) return [];
    if (typeof pendingToolApprovals.values === 'function') return [...pendingToolApprovals.values()];
    return Array.isArray(pendingToolApprovals) ? pendingToolApprovals : [];
  }

  function sessionTitleFor(summary) {
    // A session id is not a name anyone recognizes; an untitled chat says so.
    return text(summary && summary.title) || jt('chat.attentionInbox.untitledSession', 'Untitled chat');
  }

  function buildSessionIndex(sessions) {
    var index = new Map();
    (Array.isArray(sessions) ? sessions : []).forEach(function addSession(summary) {
      if (!summary || typeof summary !== 'object') return;
      var id = text(summary.id);
      if (id && !index.has(id)) index.set(id, summary);
    });
    return index;
  }

  function factsFor(facts, toolName, input) {
    if (!facts || typeof facts.getApprovalFacts !== 'function') return [];
    var produced = facts.getApprovalFacts(toolName, input);
    if (!Array.isArray(produced)) return [];
    return produced
      .filter(function isFact(fact) { return fact && typeof fact === 'object'; })
      .map(function freezeFact(fact) {
        return Object.freeze({ kind: text(fact.kind), label: text(fact.label) });
      });
  }

  function previewFor(facts, toolName, input) {
    if (!facts || typeof facts.getApprovalCommandPreview !== 'function') return '';
    var preview = String(facts.getApprovalCommandPreview(toolName, input) || '').replace(/\s+/g, ' ').trim();
    var characters = Array.from(preview);
    if (characters.length <= PREVIEW_MAX_CHARS) return preview;
    return jt('approval.block.clippedCommand', '{command}… (+{count} more chars)', {
      command: characters.slice(0, PREVIEW_MAX_CHARS).join(''),
      count: String(characters.length - PREVIEW_MAX_CHARS),
    });
  }

  function buildApprovalRows(options) {
    var rows = [];
    var seenCallIds = new Set();
    toEntries(options.pendingToolApprovals).forEach(function addApproval(entry) {
      if (!entry || typeof entry !== 'object') return;
      var callId = text(entry.callId);
      var sessionId = text(entry.sessionId);
      /* No call id means nothing to answer; an unlisted session means the
       * chat was finalized or removed while its approval lingered. */
      if (!callId || seenCallIds.has(callId) || !options.sessionIndex.has(sessionId)) return;
      seenCallIds.add(callId);
      var toolName = text(entry.toolName);
      var isPlanReview = toolName === PLAN_REVIEW_TOOL;
      var kind = isPlanReview ? 'plan_review' : 'approval';
      var row = {
        key: kind + ':' + callId,
        kind: kind,
        sessionId: sessionId,
        sessionTitle: sessionTitleFor(options.sessionIndex.get(sessionId)),
        callId: callId,
        approvalId: text(entry.approvalId) || callId,
        toolName: toolName,
      };
      if (!isPlanReview) {
        row.preview = previewFor(options.facts, toolName, entry.input);
        row.facts = Object.freeze(factsFor(options.facts, toolName, entry.input));
        // The backend's own scope and consequence for this call, as raw
        // backend strings; the view translates them exactly as the transcript
        // card does. A stated reason outranks the generic consequence.
        row.policyScope = text(entry.policyScope || entry.policy_scope);
        row.consequence = text(entry.reason) || text(entry.policyConsequence || entry.policy_consequence);
        // Mirror renderer-approval-block.js: either spelling withholds the scope.
        row.canAlwaysAllow = !(entry.oneOffOnly === true || entry.one_off_only === true);
      }
      rows.push(row);
    });
    return rows;
  }

  function resolveBackendStrings() {
    if (globalThis.jennyBackendStrings) return globalThis.jennyBackendStrings;
    if (typeof require === 'function') {
      try { return require('../shared/i18n-backend-strings'); } catch (_error) { /* not available */ }
    }
    return null;
  }

  // Scope and consequence are backend strings: translate them exactly as the
  // transcript card does (renderer-approval-block.js), else show the text.
  function translatePolicyText(method, value) {
    var strings = resolveBackendStrings();
    if (!strings || typeof strings[method] !== 'function') return value;
    try { return strings[method](value); } catch (_error) { return value; }
  }

  /* An approval row's line 3: what this call may do, in ONE uniform line --
   * the backend's scope and consequence in its own words, then the
   * writes-or-not facts, none of them painted more alarming than another (the
   * transcript card keeps them uniform on purpose) -- or the card's own
   * fallback line (the same catalog key the backend-strings table resolves it
   * to) when nothing was declared at all, as for every MCP or plugin tool: the
   * row never goes silent on it. */
  function policyLine(row) {
    var parts = [];
    if (row.policyScope) parts.push(translatePolicyText('approvalScope', row.policyScope));
    if (row.consequence) parts.push(translatePolicyText('approvalConsequence', row.consequence));
    (Array.isArray(row.facts) ? row.facts : []).forEach(function addFact(fact) {
      if (fact && fact.label) parts.push(fact.label);
    });
    if (!parts.length) return jt('approval.consequence.reviewRequestedInput', 'Review requested input');
    return parts.join(LINE_SEPARATOR);
  }

  function buildStuckSendRows(options) {
    var rows = [];
    (Array.isArray(options.stuckSends) ? options.stuckSends : []).forEach(function addStuckSend(entry) {
      var sessionId = text(entry && entry.sessionId);
      var key = text(entry && entry.key);
      if (!key || !options.sessionIndex.has(sessionId)) return;
      rows.push({
        key: 'stuck_send:' + key,
        kind: 'stuck_send',
        sessionId: sessionId,
        sessionTitle: sessionTitleFor(options.sessionIndex.get(sessionId)),
      });
    });
    return rows;
  }

  function buildQuestionRows(options) {
    var rows = [];
    options.sessionIndex.forEach(function addQuestionRow(summary, sessionId) {
      var batch = summary && summary.pending_question_batch;
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return;
      var batchId = text(batch.batch_id);
      var questions = Array.isArray(batch.questions) ? batch.questions.filter(Boolean) : [];
      if (!batchId || !questions.length) return;
      rows.push({
        key: 'question:' + sessionId + ':' + batchId,
        kind: 'question',
        sessionId: sessionId,
        sessionTitle: sessionTitleFor(summary),
        batchId: batchId,
        questionCount: questions.length,
        introText: clip(batch.intro_text, INTRO_MAX_CHARS),
      });
    });
    return rows;
  }

  /**
   * Build the frozen "Needs you" view.
   *
   * @param {Object} [options]
   * @param {Array<Object>} [options.sessions] - Session summaries (state.sessions)
   * @param {Map|Array} [options.pendingToolApprovals] - state.pendingToolApprovals
   * @param {string} [options.currentSessionId] - The conversation on screen
   * @param {Object} [options.facts] - { getApprovalFacts, getApprovalCommandPreview }
   * @param {Array<Object>} [options.stuckSends] - runtimeSendController.listStuckSends()
   * @returns {{rows: Array<Object>, counts: Object, hidden: boolean}} frozen
   */
  function buildAttentionInbox(options) {
    var input = options && typeof options === 'object' ? options : {};
    var sessionIndex = buildSessionIndex(input.sessions);
    var currentSessionId = text(input.currentSessionId);
    var context = { sessionIndex: sessionIndex, facts: input.facts, pendingToolApprovals: input.pendingToolApprovals,
      stuckSends: input.stuckSends };
    var rows = buildApprovalRows(context).concat(buildQuestionRows(context), buildStuckSendRows(context));
    // Stable sort: kind first, then the conversation on screen last within its
    // kind (the person is looking elsewhere in the app, so the waits they
    // cannot see come first), then the order the sources produced them in --
    // approval-map insertion order, which is oldest first.
    rows = rows
      .map(function withIndex(row, index) { return { row: row, index: index }; })
      .sort(function compare(left, right) {
        var byKind = KIND_ORDER[left.row.kind] - KIND_ORDER[right.row.kind];
        if (byKind !== 0) return byKind;
        var leftCurrent = currentSessionId && left.row.sessionId === currentSessionId ? 1 : 0;
        var rightCurrent = currentSessionId && right.row.sessionId === currentSessionId ? 1 : 0;
        if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
        return left.index - right.index;
      })
      .map(function freezeRow(entry, order) {
        entry.row.order = order;
        return Object.freeze(entry.row);
      });
    function countOf(kind) { return rows.filter(function isKind(row) { return row.kind === kind; }).length; }
    return Object.freeze({
      rows: Object.freeze(rows),
      // Everything a person can act on from a row; nothing merely informational.
      counts: Object.freeze({
        approvals: countOf('approval'),
        planReviews: countOf('plan_review'),
        questions: countOf('question'),
        stuckSends: countOf('stuck_send'),
        answerable: rows.length,
      }),
      hidden: rows.length === 0,
    });
  }

  return { buildAttentionInbox: buildAttentionInbox, policyLine: policyLine, PLAN_REVIEW_TOOL: PLAN_REVIEW_TOOL };
});
