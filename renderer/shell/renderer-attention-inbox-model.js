/* renderer/shell/renderer-attention-inbox-model.js -- "Needs you" model (UMD) */
/**
 * What is waiting on the person, across every session, opened or not.
 *
 * The sources are the ones the renderer already holds: the global
 * approval map (`state.pendingToolApprovals`, keyed by call id across
 * sessions, so an approval can be answered without opening its chat), the
 * session summaries' `pending_question_batch` and `failed_delivery_count`. Nothing here reads a runtime
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
 *   - a cross-chat message that failed to deliver is a row to OPEN: Retry
 *     and Cancel send live in the sending chat (on the send's own row, or
 *     its composer strip for a send with no row);
 *   - a send the runtime cannot start is listed only when its last reply's
 *     cleanup is unconfirmed (renderer-stuck-send.js): every other wait ends
 *     by itself, and the queue strip already says why;
 *   - a row for the conversation on screen shows its title and one line and
 *     offers no decisions (`onScreen`), because the transcript card beside it
 *     is where that wait is answered; it still counts.
 *   - a Team row (row 175 F10, from renderer-team-notify.js `attention()`) is
 *     marked `source: 'team'`, names its project on the muted line and is only
 *     ever opened: the Team tab is where an approval is answered. It follows the
 *     local rows of its kind, in arrival order, and never carries a decision.
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
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  var PLAN_REVIEW_TOOL = 'exit_plan_mode';
  var INTRO_MAX_CHARS = 120;
  /* One row, one line: the transcript card quotes up to 600 characters and
   * folds the rest; here the bound is tighter and the clip says how much it
   * hid, in the card's own words, so a long payload never becomes a 40 KB
   * tooltip re-serialized into the render signature on every chrome pass. */
  var PREVIEW_MAX_CHARS = 240;
  /* Approvals first, then plan reviews, question batches, failed deliveries, stuck sends. */
  var KIND_ORDER = { approval: 0, plan_review: 1, question: 2, delivery_failed: 3, stuck_send: 4 };
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

  function sessionStopTitle(value) {
    var target = value && typeof value === 'object' && value.schema_version === 1 ? value.target : null;
    var title = target && typeof target === 'object' ? text(target.title).replace(/\s+/g, ' ') : '';
    if (!title || title === 'New Chat') return '';
    var characters = Array.from(title);
    return characters.length > PREVIEW_MAX_CHARS ? characters.slice(0, PREVIEW_MAX_CHARS - 1).join('') + '\u2026' : title;
  }

  /* A pending settings or scheduled-check change's row title, read by the transcript card's own
   * normalizer: how many settings it changes, or "Change a check: <title>" (rows 88 / 85). */
  function approvalBlockSubject(method, value) {
    var block = globalThis.rendererApprovalBlock;
    if (!block && typeof require === 'function') {
      try { block = require('../chat/renderer-approval-block'); } catch (_error) { block = null; }
    }
    return block && typeof block[method] === 'function' ? block[method](value) : '';
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
        // A stop names the app's own target (row 69 Q11); its raw id is never the preview.
        var stopTitle = toolName === 'session_stop' ? sessionStopTitle(entry.sessionStopApproval) : '';
        var settingsTitle = toolName === 'settings_change' ? approvalBlockSubject('settingsChangeSubject', entry.settingsChangeApproval) : '';
        // A check change never previews the model's input, only the app's reading of it (row 85).
        var changesSchedule = toolName === 'schedule_change';
        var scheduleTitle = changesSchedule ? approvalBlockSubject('scheduleChangeSubject', entry.scheduleChangeApproval) : '';
        row.preview = toolName === 'session_stop'
          ? (stopTitle ? jt('approval.block.sessionStopSubject', 'Stop {title}', { title: stopTitle })
            : jt('chat.attentionInbox.stopAnotherChat', 'Stop another chat'))
          : changesSchedule ? (scheduleTitle || jt('chat.attentionInbox.scheduledCheck', 'Change a scheduled check'))
            : (settingsTitle || previewFor(options.facts, toolName, entry.input));
        row.facts = Object.freeze(changesSchedule ? [] : factsFor(options.facts, toolName, entry.input));
        // The backend's own scope and consequence for this call, as raw
        // backend strings; the view translates them exactly as the transcript
        // card does. A stated reason outranks the generic consequence.
        row.policyScope = text(entry.policyScope || entry.policy_scope);
        row.consequence = text(entry.reason) || text(entry.policyConsequence || entry.policy_consequence);
        // Mirror renderer-approval-block.js: either spelling withholds the scope.
        row.canAlwaysAllow = !(entry.oneOffOnly === true || entry.one_off_only === true);
        // A settings or check change is approved only on its card, where the app's reading is (rows 88 / 85).
        row.canAllow = toolName !== 'settings_change' && !changesSchedule;
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
    // A live question card (ask_user) in a chat's current turn (G7). Its desktop toast comes from the
    // stream listener, so the row says where it came from. A chat whose batch is already listed keeps one row.
    var batchSessions = new Set(rows.map(function sessionOf(row) { return row.sessionId; }));
    (Array.isArray(options.questionCards) ? options.questionCards : []).forEach(function addCardRow(card) {
      var sessionId = text(card && card.sessionId);
      var callId = text(card && card.callId);
      if (!sessionId || !callId || !options.sessionIndex.has(sessionId) || batchSessions.has(sessionId)) return;
      rows.push({
        key: 'question:' + sessionId + ':' + callId,
        kind: 'question',
        source: 'card',
        sessionId: sessionId,
        sessionTitle: sessionTitleFor(options.sessionIndex.get(sessionId)),
        callId: callId,
        questionCount: Math.max(1, Math.floor(Number(card.questionCount)) || 0),
        introText: clip(card.introText, INTRO_MAX_CHARS),
      });
    });
    return rows;
  }

  // One row per chat whose sent messages could not be delivered (the summary's derived count).
  function buildDeliveryFailedRows(options) {
    var rows = [];
    options.sessionIndex.forEach(function addDeliveryFailedRow(summary, sessionId) {
      var failedCount = summary && summary.failed_delivery_count;
      if (!Number.isSafeInteger(failedCount) || failedCount <= 0) return;
      rows.push({
        key: 'delivery_failed:' + sessionId,
        kind: 'delivery_failed',
        sessionId: sessionId,
        sessionTitle: sessionTitleFor(summary),
        failedCount: failedCount,
      });
    });
    return rows;
  }

  /* Row 175 F10: what the Team notifier says waits on this member, as rows. The source is read at the call, never held:
   * `options.team` for a caller that has it, else the Team notifier's own accessor (absent until Team has loaded). */
  function teamSource(option) {
    if (option !== undefined) return option;
    var notify = globalThis.rendererTeamNotify;
    return notify && typeof notify.attention === 'function' ? notify.attention() : null;
  }

  /* 'Team · <project> · <what waits>': an own approval says whose turn it is, an unattended one says nobody is viewing. */
  function teamLine(item) {
    var where = text(item.where);
    var head = where ? jt('team.home.marker', 'Team · {project}', { project: where }) : jt('team.home.markerBare', 'Team');
    var count = Math.max(1, Math.floor(Number(item.count)) || 1);
    var tail;
    if (item.kind === 'question') {
      tail = jtn('team.home.questionsWaiting', count, { count: String(count) }, '{count} question waiting', '{count} questions waiting');
    } else if (!item.unattended) {
      tail = jt('team.home.yourTurn', 'Your turn');
    } else if (text(item.prompterName)) {
      tail = jt('team.home.theirTurnNobodyViewing', "{name}'s turn · Nobody is viewing", { name: text(item.prompterName) });
    } else {
      tail = jt('team.home.nobodyViewing', 'Nobody is viewing');
    }
    return head + LINE_SEPARATOR + tail;
  }

  function buildTeamRows(team) {
    var items = team && Array.isArray(team.waiting) ? team.waiting : [];
    return items.filter(function valid(item) {
      return item && (item.kind === 'approval' || item.kind === 'question') && text(item.teamId) && text(item.sessionId);
    }).map(function teamRow(item) {
      return {
        key: 'team_' + item.kind + ':' + text(item.sessionId),
        kind: item.kind,
        source: 'team',
        teamId: text(item.teamId),
        projectId: text(item.projectId),
        sessionId: text(item.sessionId),
        sessionTitle: text(item.title) || jt('team.notify.projectUntitled', 'A project conversation'),
        teamLine: teamLine(item),
        questionCount: Math.max(1, Math.floor(Number(item.count)) || 1),
        canAllow: false,
        canAlwaysAllow: false,
        onScreen: item.onScreen === true,
      };
    });
  }

  /* A Team row opens its conversation in the Team tab, by the same intent a toast's click runs. */
  function openTeamConversation(row) {
    var notify = globalThis.rendererTeamNotify;
    if (!row || !notify || typeof notify.request !== 'function') return false;
    return notify.request({ kind: 'conversation', teamId: row.teamId, projectId: row.projectId || '', sessionId: row.sessionId }) === true;
  }

  /* What the view's second gate compares: everything a row says, so a source that moved without changing a word touches no DOM. */
  function rowSignature(row) {
    return [row.key, row.sessionTitle, row.toolName, row.preview, row.canAllow, row.canAlwaysAllow, row.questionCount,
      row.introText, row.consequence, row.policyScope, row.failedCount, row.onScreen, row.teamLine,
      (row.facts || []).map(function labelOf(fact) { return fact.label; })];
  }

  /* The muted line under a row that is not an approval (approvals use policyLine). */
  function rowNote(row) {
    if (row.source === 'team') return row.teamLine;
    if (row.kind === 'stuck_send') {
      return jt('chat.attentionInbox.stuckSend', "Message waiting to start · last reply's cleanup unconfirmed");
    }
    if (row.kind === 'plan_review') return jt('chat.attentionInbox.planReady', 'Plan ready for review');
    if (row.kind === 'delivery_failed') {
      return jtn('chat.attentionInbox.deliveryFailed', row.failedCount, { count: String(row.failedCount) },
        "Couldn't deliver a message", "Couldn't deliver {count} messages");
    }
    var waiting = jtn('chat.attentionInbox.questionsWaiting', row.questionCount, { count: String(row.questionCount) },
      '{count} question waiting', '{count} questions waiting');
    return row.introText ? waiting + LINE_SEPARATOR + row.introText : waiting;
  }

  /* Every kind's wait as the dot a chat row or strip chip wears: approval
   * beats plan review beats input needed, so a chat with several waits shows
   * its most pressing one. A question, a failed delivery and a stuck send are
   * all "input needed" (no new state names). */
  var STATE_BY_KIND = { approval: 'approval', plan_review: 'plan_review', question: 'input_needed',
    delivery_failed: 'input_needed', stuck_send: 'input_needed' };
  var STATE_RANK = { approval: 0, plan_review: 1, input_needed: 2 };

  function waitingStates(rows) {
    var states = new Map();
    (Array.isArray(rows) ? rows : []).forEach(function addState(row) {
      var next = row && STATE_BY_KIND[row.kind];
      if (!next || !row.sessionId) return;
      var current = states.get(row.sessionId);
      if (!current || STATE_RANK[next] < STATE_RANK[current]) states.set(row.sessionId, next);
    });
    return states;
  }

  /* Field separators for the source fingerprint: never valid in an id, a
   * title or a batch id, so two different sets of sources cannot collide. */
  var FIELD = '\u0001';
  var PART = '\u0002';
  var GROUP = '\u0003';

  function sortedKeys(set) {
    return [...set].sort().join(FIELD);
  }

  /* A cheap read of the sources THEMSELVES, taken before the model is built.
   * render() runs on every workspace-chrome pass, which during streaming is
   * every frame, and a model build is two source scans, a facts-helper call
   * per approval, a sort and a signature serialization. The approval map's
   * keys, each summary's id, title and pending batch, the conversation on
   * screen and the view it is shown in, the collapsed choice and the
   * controller's own local verdicts (`extras`) are everything a rendered row
   * can be made of, so an unchanged fingerprint means an unchanged inbox. */
  function sourceFingerprint(state, extras) {
    var approvals = state.pendingToolApprovals;
    var entries = [];
    if (approvals && typeof approvals.values === 'function') entries = [...approvals.values()];
    else if (Array.isArray(approvals)) entries = approvals;
    // The key AND the fields a row is made of: rehydration re-sets the same
    // key synchronously with the persisted fields, so no pass sees the key
    // move (the input never changes under one call id).
    var approvalKeys = entries.map(function sourceOf(entry) {
      if (!entry || typeof entry !== 'object') return '';
      return [entry.approvalId || entry.callId || '', entry.sessionId || '', entry.toolName || '',
        entry.policyScope || '', entry.policyConsequence || '', entry.reason || '', entry.summary || '',
        entry.oneOffOnly === true ? '1' : '0'].join(PART);
    }).join(FIELD);
    var sessions = Array.isArray(state.sessions) ? state.sessions : [];
    var sessionKeys = sessions.map(function sourceOf(summary) {
      if (!summary || typeof summary !== 'object') return '';
      var batch = summary.pending_question_batch;
      var questions = batch && Array.isArray(batch.questions) ? batch.questions.length : 0;
      // The title is in here because a conversation renamed mid-wait must
      // rename its row, and nothing else in these sources would say so.
      // The intro, clipped as the model clips it: revised under one batch id.
      return String(summary.id || '') + PART + String(summary.title || '')
        + PART + String((batch && batch.batch_id) || '') + PART + questions
        + PART + String((batch && batch.intro_text) || '').slice(0, 120) + PART + String(summary.failed_delivery_count || 0);
    }).join(FIELD);
    var cardKeys = (Array.isArray(extras.questionCards) ? extras.questionCards : []).map(function keyOf(card) {
      return [card.sessionId, card.callId, card.questionCount, String(card.introText || '').slice(0, 120)].join(PART);
    }).join(FIELD);
    return [
      extras.collapsed ? '1' : '0', String(state.currentSessionId || ''), String(state.ui && state.ui.activeView || ''),
      approvalKeys, sessionKeys, cardKeys, String((teamSource(extras.team) || {}).key || ''),
      (Array.isArray(extras.stuckSends) ? extras.stuckSends : []).map(function keyOf(entry) { return entry.key + PART + entry.sessionId; }).join(FIELD),
    ].concat(extras.verdicts.map(sortedKeys)).join(GROUP);
  }

  /* What the collapsed strip and the chat dots read: the chats that wait, in
   * row order, how each one waits, and a key that moves whenever any of that
   * does. Built from the rows a person can still act on. */
  function snapshotOf(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var ids = [...new Set(list.map(function idOf(row) { return row.sessionId; }))];
    var states = waitingStates(list);
    return Object.freeze({
      answerable: list.length,
      waitingSessionIds: Object.freeze(ids),
      states: states,
      key: [list.length].concat(ids.map(function keyOf(id) { return id + PART + states.get(id); })).join(FIELD),
    });
  }

  /**
   * Build the frozen "Needs you" view.
   *
   * @param {Object} [options]
   * @param {Array<Object>} [options.sessions] - Session summaries (state.sessions)
   * @param {Map|Array} [options.pendingToolApprovals] - state.pendingToolApprovals
   * @param {string} [options.currentSessionId] - The conversation on screen
   * @param {boolean} [options.currentSessionOnScreen] - The chat view is showing it (rows get `onScreen`)
   * @param {Object} [options.facts] - { getApprovalFacts, getApprovalCommandPreview }
   * @param {Array<Object>} [options.stuckSends] - runtimeSendController.listStuckSends()
   * @param {Array<Object>} [options.questionCards] - live ask_user cards { sessionId, callId, questionCount, introText }
   * @param {Object|null} [options.team] - The Team notifier's `attention()` (default: read from it when loaded)
   * @returns {{rows: Array<Object>, counts: Object, hidden: boolean}} frozen
   */
  function buildAttentionInbox(options) {
    var input = options && typeof options === 'object' ? options : {};
    var sessionIndex = buildSessionIndex(input.sessions);
    var currentSessionId = text(input.currentSessionId);
    var currentSessionOnScreen = input.currentSessionOnScreen === true;
    var context = { sessionIndex: sessionIndex, facts: input.facts, pendingToolApprovals: input.pendingToolApprovals,
      stuckSends: input.stuckSends, questionCards: input.questionCards };
    var rows = buildApprovalRows(context).concat(buildQuestionRows(context), buildDeliveryFailedRows(context),
      buildStuckSendRows(context), buildTeamRows(teamSource(input.team)));
    // Stable sort: kind first, then the conversation on screen last within its
    // kind (the person is looking elsewhere in the app, so the waits they
    // cannot see come first), then the order the sources produced them in --
    // approval-map insertion order, which is oldest first. A Team row follows the local rows of its kind (F10, D16).
    rows = rows
      .map(function withIndex(row, index) { return { row: row, index: index }; })
      .sort(function compare(left, right) {
        var byKind = KIND_ORDER[left.row.kind] - KIND_ORDER[right.row.kind];
        if (byKind !== 0) return byKind;
        var byTeam = (left.row.source === 'team' ? 1 : 0) - (right.row.source === 'team' ? 1 : 0);
        if (byTeam !== 0) return byTeam;
        var leftCurrent = currentSessionId && left.row.sessionId === currentSessionId ? 1 : 0;
        var rightCurrent = currentSessionId && right.row.sessionId === currentSessionId ? 1 : 0;
        if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
        return left.index - right.index;
      })
      .map(function freezeRow(entry, order) {
        entry.row.order = order;
        if (entry.row.source !== 'team') entry.row.onScreen = currentSessionOnScreen && currentSessionId !== '' && entry.row.sessionId === currentSessionId;
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
        deliveryFailures: countOf('delivery_failed'),
        stuckSends: countOf('stuck_send'),
        answerable: rows.length,
      }),
      hidden: rows.length === 0,
    });
  }

  return { buildAttentionInbox: buildAttentionInbox, policyLine: policyLine, rowNote: rowNote, waitingStates: waitingStates,
    snapshotOf: snapshotOf, sourceFingerprint: sourceFingerprint, rowSignature: rowSignature, openTeamConversation: openTeamConversation,
    PLAN_REVIEW_TOOL: PLAN_REVIEW_TOOL };
});
