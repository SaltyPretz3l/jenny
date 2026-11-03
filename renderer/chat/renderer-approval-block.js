(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalBlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const DEFAULT_INLINE_PROMPT = jt('approval.block.requiredPrompt', 'Approval is required before this tool can continue.');
  // The card shows the exact command being approved; beyond this the Input
  // panel (auto-expanded while awaiting approval) carries the full payload.
  const COMMAND_PREVIEW_MAX_CHARS = 600;
  const POLICY_TEXT_MAX_CHARS = 120;
  // Above the backend sanitizer's own cap (512 chars + its '...' marker) so a
  // reason it already bounded is never clipped a second time mid-word.
  const REASON_TEXT_MAX_CHARS = 520;
  const PURPOSE_TEXT_MAX_CHARS = 240;
  const FACT_LABEL_MAX_CHARS = 160;
  // Four is what fits on one line at the narrowest chat width; beyond
  // that the row wraps into a list nobody reads.
  const MAX_FACTS = 4;
  const POLICY_FALLBACK = 'Review requested input';
  const POLICY_SCOPES = new Set([
    'Local command execution', 'Workspace files', 'Web and browser session',
    'Jenny work items', 'Jenny content', 'Local computer', 'Requested tool',
  ]);
  const POLICY_CONSEQUENCES = new Set([
    'May run a local command and change local state.',
    'May change data in this scope.', 'May read data in this scope.', POLICY_FALLBACK,
  ]);

  const stringUtils = (function resolveStringUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.stringUtils) {
      return globalThis.stringUtils;
    }
    if (typeof require === 'function') {
      try { return require('../shared/string-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  })();

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const defaultEscapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : fallbackEscapeHtml;

  // Resolved per render: index.html may load the button primitive after this.
  function resolveActionButton() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.inventoryActionButton === 'function') {
      return globalThis.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try { return require('../inventory/action-button'); } catch (_error) { /* not available */ }
    }
    return null;
  }

  // Paused work, and paused work being discarded: the runtime holds the turn.
  const HELD_STATUSES = new Set(['paused', 'withdrawing']);

  // A resolved approval keeps its row as one receipt line (HB-038 H2, owner
  // pick B 2026-10-05): the card's slot never vanishes and the chat keeps a
  // record of what was allowed or denied. The live reducer and the hydrated
  // projector both settle the row from the call's own record through these
  // two helpers, so a live receipt and a reopened one say the same thing.
  const RECEIPT_HARD_OUTCOMES = new Set(['denied', 'timed_out', 'cancelled']);
  // A call that ran, or is running, was allowed even when the record of the
  // answer itself is missing.
  const RECEIPT_RAN_STATES = new Set(['approved', 'running', 'completed', 'errored', 'interrupted']);
  // The receipt subject ellipsizes in CSS; this bound stays above what a
  // Wide chat width row shows.
  const RECEIPT_SUBJECT_MAX_CHARS = 500;

  // The plan card owns a plan approval's record.
  function approvalKeepsReceipt(toolName) {
    return normalizeText(toolName) !== 'exit_plan_mode';
  }

  function deriveApprovalReceipt(callPayload) {
    const payload = callPayload && typeof callPayload === 'object' ? callPayload : {};
    if (!approvalKeepsReceipt(payload.tool_name)) return null;
    const state = normalizeText(payload.state).toLowerCase();
    // The reader's recorded answer wins: an allowed command that later timed
    // out or was stopped was still allowed. The call's own outcome only
    // speaks when no answer was recorded.
    const resolutions = Array.isArray(payload.approval_resolutions) ? payload.approval_resolutions : [];
    const last = resolutions.length && resolutions[resolutions.length - 1] && typeof resolutions[resolutions.length - 1] === 'object'
      ? resolutions[resolutions.length - 1] : {};
    const resolved = normalizeText(last.approval_state || last.status).toLowerCase();
    if (resolved === 'approved') {
      const scope = normalizeText(last.approval_scope).toLowerCase();
      // A command's Always allow saved a program + subcommand prefix (row 103).
      const prefix = scope === 'always' ? normalizeText(last.always_allow_prefix) : '';
      if (prefix) return { decision: 'allowed', scope, alwaysAllowPrefix: prefix };
      return scope === 'always' || scope === 'once' ? { decision: 'allowed', scope } : { decision: 'allowed' };
    }
    if (RECEIPT_HARD_OUTCOMES.has(resolved)) return { decision: resolved };
    if (RECEIPT_HARD_OUTCOMES.has(state)) return { decision: state };
    if (state === 'awaiting_approval' || state === 'pending_approval') return null;
    return RECEIPT_RAN_STATES.has(state) ? { decision: 'allowed' } : { decision: 'closed' };
  }

  function applyApprovalReceipt(rowPayload, receipt) {
    if (!rowPayload || !receipt) return;
    rowPayload.state = 'resolved';
    rowPayload.status = 'resolved';
    rowPayload.decision = receipt.decision;
    if (receipt.scope) rowPayload.approval_scope = receipt.scope;
    else delete rowPayload.approval_scope;
    if (receipt.alwaysAllowPrefix) rowPayload.always_allow_prefix = receipt.alwaysAllowPrefix;
    else delete rowPayload.always_allow_prefix;
  }

  function receiptLabel(decision, scope) {
    switch (decision) {
      case 'allowed':
        if (scope === 'always') return jt('approval.receipt.alwaysAllowed', 'Always allowed');
        return scope === 'once' ? jt('approval.receipt.allowedOnce', 'Allowed once') : jt('approval.receipt.allowed', 'Allowed');
      case 'denied': return jt('approval.receipt.denied', 'Denied');
      case 'timed_out': return jt('approval.receipt.timedOut', 'Not answered in time');
      case 'cancelled': return jt('approval.receipt.cancelled', 'Approval cancelled');
      default: return jt('approval.receipt.closed', 'Approval closed');
    }
  }

  function receiptDecision(value) {
    const decision = normalizeText(value);
    return decision === 'allowed' || decision === 'closed' || RECEIPT_HARD_OUTCOMES.has(decision) ? decision : 'closed';
  }

  // The receipt names what was decided: the command's first line when there
  // is one, else the tool.
  // `subjectText` (a stop's "Stop <title>") replaces the command line as plain text.
  function renderResolvedReceipt(source, displayToolName, escapeHtml, subjectText = '') {
    const decision = receiptDecision(source.decision);
    const mark = decision === 'allowed' ? '\u2713' : (decision === 'denied' ? '\u2715' : '');
    const firstLine = String(source.commandText == null ? '' : source.commandText).trim().split('\n')[0];
    // An Always allowed command names what the saved rule covers (row 103).
    const savedPrefix = source.approvalScope === 'always' ? normalizeText(source.alwaysAllowPrefix) : '';
    const command = subjectText ? '' : (savedPrefix ? `${boundedText(savedPrefix, RECEIPT_SUBJECT_MAX_CHARS)} …`
      : boundedText(firstLine, RECEIPT_SUBJECT_MAX_CHARS));
    const subject = command
      ? `<code class="tool-approval-receipt-subject">${escapeHtml(command)}</code>`
      : `<span class="tool-approval-receipt-subject">${escapeHtml(boundedText(subjectText, RECEIPT_SUBJECT_MAX_CHARS) || displayToolName)}</span>`;
    return `<p class="tool-approval-receipt tool-approval-receipt--resolved">`
      + (mark ? `<span class="tool-approval-receipt-mark" aria-hidden="true">${mark}</span>` : '')
      + `<span class="tool-approval-receipt-label">${escapeHtml(receiptLabel(decision, source.approvalScope))}</span>`
      + `<span class="tool-approval-receipt-sep" aria-hidden="true">\u00b7</span>${subject}</p>`;
  }

  // Which card a pending approval row shows (A4, owner-approved 2026-09-22).
  // Live wins: Allow and Deny resolve by call id, so any approval the runtime
  // holds for the call is answerable. A paused reply for the turn offers its
  // Resume, unless the runtime says the pause cannot continue (a restart left
  // no checkpoint: the scheduler would refuse the Resume); then, like one
  // being discarded or a card whose answer was refused, it folds to a
  // receipt, as does a row the sealed fold marked interrupted (the turn is
  // over). Anything else keeps today's buttons: before the live approvals and
  // paused work load, a card must not claim it is dead. A live approval also
  // hands over its exact presentation, which only the live request (or the backend's waiter, on a
  // reopen) carries.
  function resolveApprovalCardState(state, ref) {
    const callId = normalizeText(ref && ref.callId);
    if (!state || !callId) return { state: 'live' };
    const approvals = state.pendingToolApprovals && typeof state.pendingToolApprovals.values === 'function'
      ? [...state.pendingToolApprovals.values()] : [];
    const live = approvals.find((approval) => normalizeText(approval && approval.callId) === callId);
    if (live) {
      const card = live.exactApproval && typeof live.exactApproval === 'object'
        ? { state: 'live', exactApproval: live.exactApproval } : { state: 'live' };
      // What a command card's Always allow covers (row 103): only the live request carries it.
      if (live.alwaysAllowScope && typeof live.alwaysAllowScope === 'object') card.alwaysAllowScope = live.alwaysAllowScope;
      if (live.rememberOffer === 'linked_children') card.rememberOffer = 'linked_children'; // row 87 C1
      return card;
    }
    const sessionId = normalizeText(ref.sessionId);
    const turnId = normalizeText(ref.turnId);
    const rows = sessionId && turnId && typeof state.runtimeSendController?.listPending === 'function'
      ? state.runtimeSendController.listPending(sessionId) : [];
    const held = rows.find((row) => row.turnId === turnId && HELD_STATUSES.has(row.status));
    if (held) {
      return held.status === 'paused' && held.resumable !== false
        ? { state: 'paused', resumeKey: held.key } : { state: 'inactive' };
    }
    if (state.inactiveApprovalCallIds instanceof Set && state.inactiveApprovalCallIds.has(callId)) {
      return { state: 'inactive' };
    }
    if (normalizeText(ref.rowState) === 'interrupted') return { state: 'inactive' };
    return { state: 'live' };
  }

  // Every input resolveApprovalCardState reads, as one string: the transcript
  // forces a full render when it changes, because no message changed with it.
  function approvalCardStateKey(state, sessionId) {
    if (!state) return '';
    const live = state.pendingToolApprovals && typeof state.pendingToolApprovals.values === 'function'
      ? [...state.pendingToolApprovals.values()].map((approval) => normalizeText(approval && approval.callId)).sort()
      : [];
    const id = normalizeText(sessionId);
    const paused = id && typeof state.runtimeSendController?.listPending === 'function'
      ? state.runtimeSendController.listPending(id).filter((row) => HELD_STATUSES.has(row.status))
        .map((row) => `${row.turnId}=${row.status}${row.resumable === false ? '!' : ''}:${row.key}`).sort()
      : [];
    const inactive = state.inactiveApprovalCallIds instanceof Set ? [...state.inactiveApprovalCallIds].sort() : [];
    return live.length || paused.length || inactive.length
      ? `${live.join(',')}/${paused.join(',')}/${inactive.join(',')}` : '';
  }

  function resolveBackendStrings() {
    if (typeof globalThis !== 'undefined' && globalThis.jennyBackendStrings) {
      return globalThis.jennyBackendStrings;
    }
    if (typeof require === 'function') {
      try { return require('../shared/i18n-backend-strings'); } catch (_error) { /* not available */ }
    }
    return null;
  }

  function translatePolicyText(method, text) {
    const backendStrings = resolveBackendStrings();
    if (!backendStrings || typeof backendStrings[method] !== 'function') return text;
    try { return backendStrings[method](text); } catch (_error) { return text; }
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  // Free text arriving from a payload: collapse, bound, never membership-test.
  // Format controls (bidi overrides, zero-width joiners) are stripped: a
  // model-authored purpose could otherwise reorder the headline the reader
  // is approving. A clip is marked so a cut sentence does not read as whole.
  function boundedText(value, maxChars) {
    if (typeof value !== 'string') return '';
    const characters = Array.from(
      value.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
    );
    return characters.length > maxChars
      ? characters.slice(0, maxChars - 1).join('') + '\u2026'
      : characters.join('');
  }

  // Quoted arguments keep every character, but an invisible control shows as a visible marker
  // (⟨U+202E⟩) instead of being honored: a bidi override would reorder the command the reader
  // approves, a zero-width space would hide a split. Tabs, newlines and CRLF stay as they are.
  const INVISIBLE_CHARACTER_RE = /(?![\t\n]|\r\n)[\p{Cc}\p{Cf}]/gu;

  function quotedArgumentMarkup(text, escapeHtml) {
    let markup = '';
    let last = 0;
    for (const match of text.matchAll(INVISIBLE_CHARACTER_RE)) {
      const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      markup += escapeHtml(text.slice(last, match.index))
        + `<span class="tool-approval-invisible">\u27E8U+${code}\u27E9</span>`;
      last = match.index + match[0].length;
    }
    return markup + escapeHtml(text.slice(last));
  }

  // Commands and writes are approved against the exact arguments that decide what runs
  // (`exact_approval`, built by services/backend/chat-stream-tool-approval.js, whose
  // EXACT_APPROVAL_FIELDS keys this set mirrors), never the redacted, clipped input snapshot.
  // Mirrors EXACT_APPROVAL_FIELDS (services/backend/chat-stream-tool-approval.js): these cards show the decisive
  // fields whole, never the clipped preview.
  const EXACT_APPROVAL_TOOLS = new Set(['run_command', 'run_temp_script', 'python_execute', 'monitor', 'write_file', 'edit_file',
    'project_create', 'session_export', 'terminal_run']);
  const EXACT_APPROVAL_MAX_CHARS = 32 * 1024;

  function normalizeExactApproval(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1) return null;
    if (value.too_large === true) return { tooLarge: true, fields: [] };
    if (!Array.isArray(value.fields) || !SHA256_HEX.test(String(value.sha256 || ''))) return null;
    const fields = value.fields
      .filter((field) => field && typeof field.name === 'string' && field.name && typeof field.text === 'string')
      .map((field) => ({ name: field.name, text: field.text }));
    if (fields.length !== value.fields.length) return null;
    const chars = fields.reduce((total, field) => total + field.name.length + field.text.length, 0);
    return { tooLarge: chars > EXACT_APPROVAL_MAX_CHARS, fields };
  }

  // Each decisive argument whole, in its own scrollable block; a lone field needs no label.
  function renderExactApproval(exact, escapeHtml) {
    const labelled = exact.fields.length > 1;
    return `<div class="tool-approval-exact" data-approval-exact-input>`
      + exact.fields.map((field) => (labelled ? `<div class="tool-approval-exact-name">${escapeHtml(field.name)}</div>` : '')
        + `<pre class="tool-approval-command" data-approval-exact-field="${escapeHtml(field.name)}">`
        + `<code>${quotedArgumentMarkup(field.text, escapeHtml)}</code></pre>`).join('')
      + `</div>`;
  }

  function renderExactUnavailable(reason, escapeHtml) {
    const note = reason === 'too_large'
      ? jt('approval.block.exactTooLarge', "This request is too large to review here, so it can't be approved. Deny it.")
      : jt('approval.block.exactUnavailable', "The exact request can't be shown, so it can't be approved. Deny it.");
    return `<p class="tool-approval-message-note" data-approval-exact-unavailable="${reason}">${escapeHtml(note)}</p>`;
  }

  // What the folded preview counts, in the tool's own terms.
  function commandUnitNoun(toolName) {
    switch (toolName) {
      case 'python_execute': return jt('approval.block.pythonLines', 'lines of Python');
      case 'run_command': case 'Bash': case 'run_temp_script': return jt('approval.block.shellLines', 'lines of shell');
      case 'move_file': return jt('approval.block.moves', 'moves');
      default: return jt('approval.block.lines', 'lines');
    }
  }

  // Facts are app-derived, but they still arrive through a caller, so treat
  // them as untrusted: drop malformed entries rather than rendering a blank.
  function normalizeFacts(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((fact) => (fact && typeof fact === 'object'
        ? { kind: boundedText(fact.kind, 32), label: boundedText(fact.label, FACT_LABEL_MAX_CHARS) }
        : { kind: '', label: '' }))
      .filter((fact) => fact.kind && fact.label)
      .slice(0, MAX_FACTS);
  }

  function normalizePolicyText(value, allowedValues) {
    if (typeof value !== 'string') return '';
    const normalized = Array.from(value.replace(/\s+/g, ' ').trim())
      .slice(0, POLICY_TEXT_MAX_CHARS).join('');
    return allowedValues.has(normalized) ? normalized : '';
  }

  // Agent-to-chat message approval (row 59 cp5b-2). The request carries the whole body, the
  // recipient and the envelope hash in its own field, because the stock input preview clips. The
  // value arrives from a persisted/replayed payload, so it is validated and rebuilt, not trusted.
  const SESSION_MESSAGE_TOOL = 'session_message';
  const SESSION_MESSAGE_TITLE_MAX_CHARS = 120;
  const SESSION_MESSAGE_PROJECT_MAX_CHARS = 80;
  const SESSION_MESSAGE_HASH_CHARS = 12;
  const SHA256_HEX = /^[0-9a-f]{64}$/i;

  function normalizeSessionMessageApproval(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const destination = value.destination;
    if (value.schema_version !== 1 || !destination || typeof destination !== 'object' || Array.isArray(destination)) return null;
    if (typeof value.body !== 'string' || !value.body.length) return null;
    if (typeof destination.session_id !== 'string' || !destination.session_id) return null;
    const hash = typeof value.envelope_sha256 === 'string' ? value.envelope_sha256.trim() : '';
    if (!SHA256_HEX.test(hash)) return null;
    return {
      title: boundedText(destination.title, SESSION_MESSAGE_TITLE_MAX_CHARS) || jt('chat.messages.untitledChat', 'Untitled chat'),
      project: boundedText(destination.project_label, SESSION_MESSAGE_PROJECT_MAX_CHARS),
      body: value.body,
      shortHash: hash.slice(0, SESSION_MESSAGE_HASH_CHARS).toLowerCase(),
    };
  }

  // The recipient, the full body (scrollable, selectable, text only) and the short hash.
  function renderSessionMessageApproval(message, escapeHtml) {
    return `<div class="tool-approval-message" data-approval-session-message>`
      + `<div class="tool-approval-message-recipient"><span class="tool-approval-message-label">${escapeHtml(jt('approval.block.sessionMessageTo', 'To'))}</span>`
      + `<span class="tool-approval-message-title">${escapeHtml(message.title)}</span>`
      + (message.project ? `<span class="tool-approval-message-project">${escapeHtml(message.project)}</span>` : '')
      + `</div>`
      + `<pre class="tool-approval-message-body" tabindex="0" role="region"`
      + ` aria-label="${escapeHtml(jt('approval.block.sessionMessageBodyLabel', 'Message to send, exactly as written'))}"`
      + ` data-approval-message-body>${escapeHtml(message.body)}</pre>`
      + `<p class="tool-approval-message-note">${escapeHtml(jt('approval.block.sessionMessageOneOff', 'This approval covers this one message only.'))}`
      + ` <span class="tool-approval-message-hash">${escapeHtml(jt('approval.block.sessionMessageFingerprint', 'Fingerprint {hash}', { hash: message.shortHash }))}</span></p>`
      + `</div>`;
  }

  // Row 88: the words for a settings change Jenny asks for, shared by the settings_change card and
  // the Activity entry (renderer-primary-activity.js). A setting's name comes from the catalog by its
  // key; a value is translated where the app owns the word and otherwise shows the label the app
  // carried with the change (palette, typography and language names), never the model's text.
  const SETTING_NAMES = {
    time_format_24h: () => jt('primarySettings.key.time_format_24h', '24-hour time'),
    ui_language: () => jt('primarySettings.key.ui_language', 'Language'),
    default_run_mode: () => jt('primarySettings.key.default_run_mode', 'Default run mode'),
    transcript_view_default: () => jt('primarySettings.key.transcript_view_default', 'Transcript view'),
    app_zoom_percent: () => jt('primarySettings.key.app_zoom_percent', 'App zoom'),
    palette: () => jt('primarySettings.key.palette', 'Palette'),
    typography: () => jt('primarySettings.key.typography', 'Typography'),
    font_scale: () => jt('primarySettings.key.font_scale', 'Text size'),
    chat_width: () => jt('primarySettings.key.chat_width', 'Chat width'),
    notifications_enabled: () => jt('primarySettings.key.notifications_enabled', 'Desktop notifications'),
    notifications_sound: () => jt('primarySettings.key.notifications_sound', 'Notification sound'),
    notifications_only_when_unfocused: () => jt('primarySettings.key.notifications_only_when_unfocused', 'Notify only when Jenny is in the background'),
    notifications_category_replies: () => jt('primarySettings.key.notifications_category_replies', 'Notify when a reply is ready'),
    notifications_category_failures: () => jt('primarySettings.key.notifications_category_failures', 'Notify when a run fails'),
    notifications_category_permissions: () => jt('primarySettings.key.notifications_category_permissions', 'Notify when Jenny needs permission'),
    notifications_category_questions: () => jt('primarySettings.key.notifications_category_questions', 'Notify when Jenny asks or a plan is ready'),
    notifications_category_reminders: () => jt('primarySettings.key.notifications_category_reminders', 'Notify when a reminder is due'),
    memory_take_notes: () => jt('primarySettings.key.memory_take_notes', 'Take notes automatically'),
    memory_ask_before_saving: () => jt('primarySettings.key.memory_ask_before_saving', 'Ask before saving a memory'),
    memory_pause_saving: () => jt('primarySettings.key.memory_pause_saving', 'Pause memory saving'),
    memory_use_in_chats: () => jt('primarySettings.key.memory_use_in_chats', 'Use memory in chats'),
    editor_font_size: () => jt('primarySettings.key.editor_font_size', 'Editor font size'),
    editor_tab_size: () => jt('primarySettings.key.editor_tab_size', 'Editor tab size'),
    editor_auto_save: () => jt('primarySettings.key.editor_auto_save', 'Editor auto save'),
  };
  const SETTING_VALUE_WORDS = {
    default_run_mode: {
      ask: () => jt('chat.primary.mode.ask', 'Ask'),
      plan: () => jt('chat.primary.mode.plan', 'Plan'),
      propose: () => jt('chat.primary.mode.propose', 'Propose'),
    },
    transcript_view_default: {
      answers: () => jt('settings.transcriptView.answers', 'Answers'),
      thinking: () => jt('settings.transcriptView.thinking', 'Thinking'),
      everything: () => jt('settings.transcriptView.everything', 'Everything'),
    },
    editor_auto_save: {
      off: () => jt('common.off', 'Off'),
      afterDelay: () => jt('settings.editor.autoSave.afterDelay', 'After a delay'),
      onFocusChange: () => jt('settings.editor.autoSave.onFocusChange', 'When the editor loses focus'),
      onWindowChange: () => jt('settings.editor.autoSave.onWindowChange', 'When the window loses focus'),
    },
  };
  const SETTING_LABEL_MAX_CHARS = 120;
  const hasOwn = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);

  /** A setting's display name by its key ('' for a key the app does not know). */
  function settingName(key) {
    return hasOwn(SETTING_NAMES, key) ? SETTING_NAMES[key]() : '';
  }

  /** A setting value's display text: On / Off, an app-owned word, a zoom percentage, else the carried label. */
  function settingValueText(key, value, label) {
    if (typeof value === 'boolean') return value ? jt('common.on', 'On') : jt('common.off', 'Off');
    const words = hasOwn(SETTING_VALUE_WORDS, key) ? SETTING_VALUE_WORDS[key] : null;
    if (words && hasOwn(words, value)) return words[value]();
    if (key === 'app_zoom_percent' && Number.isFinite(value)) return `${value}%`;
    return boundedText(label, SETTING_LABEL_MAX_CHARS)
      || (typeof value === 'string' || Number.isFinite(value) ? boundedText(String(value), SETTING_LABEL_MAX_CHARS) : '');
  }

  // Stopping another chat (row 69 Q11, owner 2026-10-20). The model names the chat only by id; the
  // card names it from the app's own directory (title, project, live state) and says what the stop
  // does in that state. The raw id never shows; a target that did not arrive reads as unnamed.
  const SESSION_STOP_TOOL = 'session_stop';
  const SESSION_STOP_STATES = new Set(['running', 'waiting_approval', 'queued', 'idle', 'not_found']);

  function normalizeSessionStopApproval(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1) return null;
    if (!SESSION_STOP_STATES.has(value.state)) return null;
    if (value.state === 'not_found') return { state: 'not_found', title: '', project: '' };
    const target = value.target;
    if (!target || typeof target !== 'object' || typeof target.session_id !== 'string' || !target.session_id) return null;
    const title = boundedText(target.title, SESSION_MESSAGE_TITLE_MAX_CHARS);
    return {
      state: value.state,
      title: title && title !== 'New Chat' ? title : jt('chat.messages.untitledChat', 'Untitled chat'),
      project: boundedText(target.project_label, SESSION_MESSAGE_PROJECT_MAX_CHARS),
    };
  }

  function sessionStopEffect(state) {
    switch (state) {
      case 'running': return jt('approval.block.sessionStopRunning', 'Running now: its reply in progress is cancelled, and its waiting sends are cleared.');
      case 'waiting_approval': return jt('approval.block.sessionStopApproval', 'Paused on your approval: that request is cancelled, and its waiting sends are cleared.');
      case 'queued': return jt('approval.block.sessionStopQueued', 'Waiting to start: its waiting sends are cleared.');
      case 'idle': return jt('approval.block.sessionStopIdle', 'Nothing is running there right now, so nothing is stopped.');
      case 'not_found': return jt('approval.block.sessionStopNotFound', 'This chat can’t reach that one, so nothing is stopped.');
      default: return '';
    }
  }

  function renderSessionStopApproval(stop, escapeHtml) {
    const title = stop ? (stop.title || jt('approval.block.sessionStopOtherChat', 'Another chat'))
      : jt('approval.block.sessionStopUnnamed', 'A chat Jenny could not name');
    const effect = stop ? sessionStopEffect(stop.state) : '';
    return `<div class="tool-approval-message" data-approval-session-stop="${escapeHtml(stop ? stop.state : 'unknown')}">`
      + `<div class="tool-approval-message-recipient"><span class="tool-approval-message-label">${escapeHtml(jt('approval.block.sessionStopLabel', 'Stop'))}</span>`
      + `<span class="tool-approval-message-title">${escapeHtml(title)}</span>`
      + (stop && stop.project ? `<span class="tool-approval-message-project">${escapeHtml(stop.project)}</span>` : '')
      + `</div>`
      + (effect ? `<p class="tool-approval-message-note">${escapeHtml(effect)}</p>` : '')
      + `</div>`;
  }

  // A settings change Jenny asks for (row 88, owner design "A1 lines"). The model names keys and
  // values; the card shows the app's own reading of them (`settings_change_approval`): each setting
  // and its before -> after. A change the app could not read, refused, or that arrived malformed shows
  // no rows and has no Allow: nothing is approved on a partial or unverifiable card.
  const SETTINGS_CHANGE_TOOL = 'settings_change';
  const SETTINGS_CHANGE_MAX_ROWS = 5;
  const SETTINGS_REFUSAL_REASONS = new Set(['not_allowed', 'invalid_value', 'unchanged', 'unavailable']);

  function normalizeSettingsChangeApproval(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1) return null;
    if (value.state === 'refused') {
      return { state: 'refused', reason: SETTINGS_REFUSAL_REASONS.has(value.reason) ? value.reason : 'other' };
    }
    if (value.state !== 'ready' || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > SETTINGS_CHANGE_MAX_ROWS) return null;
    const rows = [];
    for (const entry of value.rows) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const name = settingName(entry.key);
      const before = settingValueText(entry.key, entry.before, entry.before_label);
      const after = settingValueText(entry.key, entry.after, entry.after_label);
      if (!name || !before || !after) return null;
      rows.push({ key: entry.key, name, before, after });
    }
    return { state: 'ready', rows };
  }

  function settingsRefusedText(reason) {
    switch (reason) {
      case 'not_allowed': return jt('approval.block.settingsRefusedNotAllowed', "Jenny can't change that setting, so this can't be approved. Deny it.");
      case 'invalid_value': return jt('approval.block.settingsRefusedInvalidValue', "That value isn't one this setting takes, so this can't be approved. Deny it.");
      case 'unchanged': return jt('approval.block.settingsRefusedUnchanged', 'Nothing would change: these settings already have those values. Deny it.');
      case 'unavailable': return jt('approval.block.settingsRefusedUnavailable', "The app couldn't read these settings right now, so this can't be approved. Deny it.");
      default: return jt('approval.block.settingsRefused', "This change can't be shown, so it can't be approved. Deny it.");
    }
  }

  function settingsChangeNote(count) {
    if (count === 1) return jt('approval.block.settingsNoteOne', 'You can undo this from Activity.');
    if (count === 2) return jt('approval.block.settingsNoteTwo', 'Both change together, or neither does. You can undo this from Activity.');
    return jt('approval.block.settingsNoteMany', 'All {count} change together, or none does. You can undo this from Activity.', { count });
  }

  function renderSettingsChangeApproval(change, escapeHtml) {
    if (!change || change.state !== 'ready') {
      return `<p class="tool-approval-message-note" data-approval-settings-unavailable="${change ? change.reason : 'missing'}">`
        + `${escapeHtml(settingsRefusedText(change && change.reason))}</p>`;
    }
    const to = ` ${jt('approval.block.settingTo', 'to')} `;
    return `<div class="tool-approval-message" data-approval-settings="ready"><ul class="tool-approval-settings">`
      + change.rows.map((entry) => `<li class="tool-approval-setting"><span class="tool-approval-setting-name">${escapeHtml(entry.name)}</span>`
        + `<span class="tool-approval-setting-change"><span class="tool-approval-setting-before">${escapeHtml(entry.before)}</span>`
        + `<span class="tool-approval-setting-arrow" aria-hidden="true">\u2192</span><span class="sr-only">${escapeHtml(to)}</span>`
        + `<span class="tool-approval-setting-after">${escapeHtml(entry.after)}</span></span></li>`).join('')
      + `</ul><p class="tool-approval-message-note">${escapeHtml(settingsChangeNote(change.rows.length))}</p></div>`;
  }

  function settingsChangeSubject(change, decision) {
    if (!change || change.state !== 'ready') return '';
    const count = change.rows.length;
    return decision === 'allowed'
      ? jtn('approval.block.settingsChanged', count, { count }, 'Changed 1 setting', 'Changed {count} settings')
      : jtn('approval.block.settingsChange', count, { count }, 'Change 1 setting', 'Change {count} settings');
  }

  // A scheduled-check change (row 85, owner pick "B · Approval cards"). The model names a check by id
  // and proposes text and a cadence; the card shows what the app computed from the record the change
  // would write (`schedule_change_approval`): the label and instruction as stored, the cadence in words
  // and the next fire times, before -> after for an edit, in the row 88 setting lines. A refused,
  // missing or malformed reading has no Allow, and a check change is never "always".
  const SCHEDULE_CHANGE_TOOL = 'schedule_change';
  const SCHEDULE_ACTIONS = new Set(['create', 'update', 'enable', 'disable', 'cancel']);
  const SCHEDULE_REFUSAL_REASONS = new Set(['invalid_input', 'not_found', 'not_a_check', 'limit_reached', 'denied', 'disabled']);
  const SCHEDULE_TEXT_MAX_CHARS = 160;
  const SCHEDULE_NEXT_FIRES = 3;
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  function normalizeScheduleSide(side) {
    if (!isRecord(side)) return null;
    const instruction = typeof side.instruction === 'string' && side.instruction.length <= EXACT_APPROVAL_MAX_CHARS
      ? side.instruction : '';
    const nextFires = (Array.isArray(side.next_fires) ? side.next_fires : [])
      .filter((at) => typeof at === 'string' && Number.isFinite(Date.parse(at))).slice(0, SCHEDULE_NEXT_FIRES);
    return { label: boundedText(side.label, SCHEDULE_TEXT_MAX_CHARS), instruction,
      cadence: boundedText(side.cadence_text, SCHEDULE_TEXT_MAX_CHARS), enabled: side.enabled !== false, nextFires };
  }

  function normalizeScheduleChangeApproval(value) {
    if (!isRecord(value) || value.schema_version !== 1) return null;
    if (value.state === 'refused') {
      return { state: 'refused', reason: SCHEDULE_REFUSAL_REASONS.has(value.reason) ? value.reason : 'other' };
    }
    const action = value.action;
    if (value.state !== 'ready' || !SCHEDULE_ACTIONS.has(action)) return null;
    const before = normalizeScheduleSide(value.before);
    const after = normalizeScheduleSide(value.after);
    // Create has no before and cancel no after; every other side must be there and readable.
    if ((action === 'create') !== (value.before == null) || (action === 'cancel') !== (value.after == null)) return null;
    if ((action !== 'create' && !before) || (action !== 'cancel' && !after)) return null;
    if (action === 'create' && (!after.instruction.trim() || !after.cadence)) return null;
    const label = action === 'create' ? after.label : (before.label || (after && after.label));
    if (action !== 'create' && !label) return null;
    if (action === 'cancel' && !before.cadence) return null;
    return { state: 'ready', action, label, before, after };
  }

  function scheduleActionText(action) {
    switch (action) {
      case 'create': return jt('chat.approval.schedule.create', 'Schedule a check');
      case 'update': return jt('chat.approval.schedule.update', 'Change a check');
      case 'enable': return jt('chat.approval.schedule.enable', 'Turn on a check');
      case 'disable': return jt('chat.approval.schedule.disable', 'Turn off a check');
      default: return jt('chat.approval.schedule.cancel', 'Delete a check');
    }
  }

  function scheduleFacts(change) {
    if (change.action === 'create') {
      return [scheduleActionText('create'), change.after.cadence, jt('chat.approval.schedule.asksBeforeTools', 'Always asks before tools')];
    }
    return [scheduleActionText(change.action), change.label].concat(change.action === 'cancel' ? [change.before.cadence] : []);
  }

  function scheduleRefusedText(reason) {
    switch (reason) {
      case 'invalid_input': return jt('chat.approval.schedule.refusedInvalidInput', "That check isn't one Jenny can save, so this can't be approved. Deny it.");
      case 'not_found': return jt('chat.approval.schedule.refusedNotFound', "That check no longer exists, so this can't be approved. Deny it.");
      case 'not_a_check': return jt('chat.approval.schedule.refusedNotACheck', "That reminder isn't a Jenny check, so Jenny can't change it. Deny it.");
      case 'limit_reached': return jt('chat.approval.schedule.refusedLimitReached', "You already have as many checks as Jenny can keep, so this can't be approved. Deny it.");
      case 'denied': return jt('chat.approval.schedule.refusedDenied', "The app couldn't prepare this change, so it can't be approved. Deny it.");
      case 'disabled': return jt('chat.approval.schedule.refusedDisabled', "Scheduled checks are turned off, so this can't be approved. Deny it.");
      default: return jt('chat.approval.schedule.refused', "This change can't be shown, so it can't be approved. Deny it.");
    }
  }

  // "Tue 3 Nov 8 AM": the local short form; minutes only when the time has them.
  function shortFireText(iso) {
    const at = new Date(iso);
    const tag = globalThis.jennyI18n?.tag?.();
    const day = at.toLocaleDateString(tag, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = at.toLocaleTimeString(tag, at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
    return `${day} ${time}`;
  }

  function scheduleLineMarkup(name, before, after, escapeHtml) {
    const beforeMarkup = before == null ? ''
      : `<span class="tool-approval-setting-before">${quotedArgumentMarkup(before, escapeHtml)}</span>`
        + `<span class="tool-approval-setting-arrow" aria-hidden="true">→</span>`
        + `<span class="sr-only">${escapeHtml(` ${jt('approval.block.settingTo', 'to')} `)}</span>`;
    return `<li class="tool-approval-setting"><span class="tool-approval-setting-name">${escapeHtml(name)}</span>`
      + `<span class="tool-approval-setting-change">${beforeMarkup}`
      + `<span class="tool-approval-setting-after">${quotedArgumentMarkup(after, escapeHtml)}</span></span></li>`;
  }

  function renderScheduleChangeApproval(change, escapeHtml) {
    if (!change || change.state !== 'ready') {
      return `<p class="tool-approval-message-note" data-approval-schedule-unavailable="${change ? change.reason : 'missing'}">`
        + `${escapeHtml(scheduleRefusedText(change && change.reason))}</p>`;
    }
    const { action, before, after } = change;
    const lines = [];
    if (action === 'update') {
      if (before.label !== after.label) lines.push([jt('chat.approval.schedule.title', 'Title'), before.label, after.label]);
      if (before.instruction !== after.instruction) {
        lines.push([jt('chat.approval.schedule.instruction', 'Instruction'), before.instruction, after.instruction]);
      }
      if (before.cadence !== after.cadence) lines.push([jt('chat.approval.schedule.time', 'Time'), before.cadence, after.cadence]);
    }
    if ((action === 'create' || action === 'update' || action === 'enable') && after.nextFires.length) {
      lines.push([jt('chat.approval.schedule.next', 'Next'), null, after.nextFires.map(shortFireText).join(' · ')]);
    }
    let note = '';
    if (action === 'create') note = jt('chat.approval.schedule.noteCreate', 'It runs as a turn in this chat. Turn it off or delete it from Home, or ask Jenny.');
    else if (action === 'update' && before.instruction === after.instruction) note = jt('chat.approval.schedule.noteSameInstruction', 'The instruction stays the same.');
    else if (action === 'cancel') note = jt('chat.approval.schedule.noteCancel', 'It will not run again. Your plain reminders are not touched.');
    return `<div class="tool-approval-message" data-approval-schedule="${action}">`
      + (action === 'create' ? `<blockquote class="tool-approval-schedule-instruction" data-approval-schedule-instruction>${quotedArgumentMarkup(after.instruction, escapeHtml)}</blockquote>` : '')
      + (lines.length ? `<ul class="tool-approval-settings">${lines.map((line) => scheduleLineMarkup(line[0], line[1], line[2], escapeHtml)).join('')}</ul>` : '')
      + (note ? `<p class="tool-approval-message-note">${escapeHtml(note)}</p>` : '')
      + `</div>`;
  }

  function scheduleChangeSubject(change) {
    if (!change || change.state !== 'ready') return '';
    const actionText = scheduleActionText(change.action);
    return change.label ? jt('chat.approval.schedule.subject', '{action}: {label}', { action: actionText, label: change.label }) : actionText;
  }

  // Row 103 (owner pick B, 2026-11-02): a command card names what "Always allow" saves -- the
  // program + subcommand with any arguments, or exactly this command -- from the backend's own
  // derivation (services/tools/command-prefix.js). A chained command is allowed once only.
  const RUN_COMMAND_TOOL = 'run_command';
  const CODE_SLOT = '\u0000';

  function normalizeCommandScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.kind === 'exact' || value.kind === 'none') return { kind: value.kind };
    const prefix = value.kind === 'prefix' ? boundedText(value.prefix, RECEIPT_SUBJECT_MAX_CHARS) : '';
    return prefix ? { kind: 'prefix', prefix } : null;
  }

  // A translated sentence whose {prefix} was filled with CODE_SLOT: escaped first, then the slot
  // becomes inline <code>.
  function withCodeSlot(text, codeText, escapeHtml) {
    return escapeHtml(text).split(CODE_SLOT).join(`<code>${escapeHtml(codeText)}</code>`);
  }

  function commandAlwaysAllowCopy(scope, escapeHtml) {
    if (scope.kind === 'prefix') {
      const slot = { prefix: CODE_SLOT };
      return {
        labelHtml: withCodeSlot(jt('approval.block.alwaysAllowCommandPrefix', 'Always allow {prefix}', slot), `${scope.prefix} …`, escapeHtml),
        title: jt('approval.block.alwaysAllowCommandPrefixTitle', 'Allow this command and stop asking for {prefix} with any arguments in this project', { prefix: scope.prefix }),
        ariaLabel: jt('approval.block.alwaysAllowCommandPrefixAriaLabel', 'Always allow {prefix} with any arguments in this project', { prefix: scope.prefix }),
        noteHtml: withCodeSlot(jt('approval.block.scopeNotePrefix', 'Covers {prefix} with any arguments, in this project. Other commands still ask.', slot), scope.prefix, escapeHtml),
      };
    }
    return {
      labelHtml: escapeHtml(jt('approval.block.alwaysAllowThisCommand', 'Always allow this command')),
      title: jt('approval.block.alwaysAllowCommandExactTitle', 'Allow this command and stop asking for exactly this command in this project'),
      ariaLabel: jt('approval.block.alwaysAllowCommandExactAriaLabel', 'Always allow exactly this command in this project'),
      noteHtml: escapeHtml(jt('approval.block.scopeNoteExact', 'Covers exactly this command, in this project. Other commands still ask.')),
    };
  }

  function scopeNoteMarkup(noteHtml) {
    return noteHtml ? `<p class="tool-approval-scope-note">${noteHtml}</p>` : '';
  }

  function renderApprovalBlock(options, deps) {
    const source = options || {};
    const dependencies = deps || {};
    const escapeHtml = typeof dependencies.escapeHtml === 'function'
      ? dependencies.escapeHtml
      : defaultEscapeHtml;

    const toolCallId = normalizeText(source.toolCallId);
    const approvalId = normalizeText(source.approvalId);
    const toolName = normalizeText(source.toolName);
    // A message to another chat is approved against its full body or not at all: a request whose
    // body did not arrive intact has no Allow button, so the stock clipped preview never stands in.
    const sendsMessage = toolName === SESSION_MESSAGE_TOOL;
    const sessionMessage = sendsMessage ? normalizeSessionMessageApproval(source.sessionMessageApproval) : null;
    // A caller that carries exact presentations passes the key even when the value is absent (a
    // rehydrated row): a command or write without one then has no Allow, like a message without its
    // body. A caller that never carries them (the legacy card) keeps the ordinary preview.
    const needsExact = EXACT_APPROVAL_TOOLS.has(toolName);
    const exactApproval = needsExact ? normalizeExactApproval(source.exactApproval) : null;
    const exactUnavailable = exactApproval && exactApproval.tooLarge ? 'too_large'
      : (needsExact && !exactApproval && Object.prototype.hasOwnProperty.call(source, 'exactApproval') ? 'missing' : '');
    // A settings change is approved against the app's own reading of it or not at all, and only on its
    // own card: its Allow is withheld unless the rows arrived intact, and it is never "always".
    const changesSettings = toolName === SETTINGS_CHANGE_TOOL;
    const settingsChange = changesSettings ? normalizeSettingsChangeApproval(source.settingsChangeApproval) : null;
    const settingsReady = Boolean(settingsChange && settingsChange.state === 'ready');
    // A scheduled-check change likewise (row 85): Allow once only on the app's own reading of it.
    const changesSchedule = toolName === SCHEDULE_CHANGE_TOOL;
    const scheduleChange = changesSchedule ? normalizeScheduleChangeApproval(source.scheduleChangeApproval) : null;
    const scheduleReady = Boolean(scheduleChange && scheduleChange.state === 'ready');
    const ownCardOnly = changesSettings || changesSchedule;
    const withholdsAllow = (sendsMessage && !sessionMessage) || Boolean(exactUnavailable) || (changesSettings && !settingsReady)
      || (changesSchedule && !scheduleReady);
    const displayToolName = normalizeText(source.displayToolName) || toolName || jt('approval.block.thisTool', 'this tool');
    const mode = source.mode === 'card' ? 'card' : 'inline';
    const prompt = normalizeText(source.prompt)
      || (mode === 'inline' ? DEFAULT_INLINE_PROMPT : jt('approval.block.approvePrompt', 'Approve {tool}?', { tool: displayToolName }));

    const callIdAttr = escapeHtml(toolCallId);
    const approvalIdAttr = escapeHtml(approvalId);
    const approvalAttrMarkup = approvalId
      ? ` data-approval-id="${approvalIdAttr}"`
      : '';
    if (mode === 'inline' && source.variant === 'plan') {
      // No role/aria-live: the row stays permanently empty (the plan card owns
      // the approval announcement), and an empty live region announces nothing.
      return `<div class="approval-gap-row"`
        + ` data-tool-call-id="${callIdAttr}" data-call-id="${callIdAttr}"`
        + `${approvalAttrMarkup}`
        + ` data-approval-status="pending" data-approval-variant="plan"></div>`;
    }
    // The runtime no longer waits on this approval: a paused reply offers
    // Resume in place of the three buttons, and a withdrawn one folds to one
    // quiet receipt line.
    const cardState = source.cardState === 'paused' || source.cardState === 'inactive'
      ? source.cardState : 'live';
    const rowIdentity = ` data-tool-call-id="${callIdAttr}" data-call-id="${callIdAttr}"${approvalAttrMarkup}`;
    if (source.cardState === 'resolved') {
      const stopTarget = toolName === SESSION_STOP_TOOL ? normalizeSessionStopApproval(source.sessionStopApproval) : null;
      const settingsSubject = toolName === SETTINGS_CHANGE_TOOL
        ? settingsChangeSubject(normalizeSettingsChangeApproval(source.settingsChangeApproval), receiptDecision(source.decision))
        // A check change's receipt never quotes the model's input: without a reading it names the tool.
        : (toolName === SCHEDULE_CHANGE_TOOL
          ? scheduleChangeSubject(normalizeScheduleChangeApproval(source.scheduleChangeApproval)) || displayToolName : '');
      const receipt = renderResolvedReceipt(source, displayToolName, escapeHtml, stopTarget && stopTarget.title
        ? jt('approval.block.sessionStopSubject', 'Stop {title}', { title: stopTarget.title }) : settingsSubject);
      const decisionAttr = ` data-approval-status="resolved" data-approval-decision="${receiptDecision(source.decision)}"`;
      return mode === 'inline'
        ? `<div class="approval-gap-row" role="status" aria-live="polite"${rowIdentity}${decisionAttr}>${receipt}</div>`
        : `<div class="tool-approval-block"${rowIdentity}${decisionAttr}>${receipt}</div>`;
    }
    if (cardState === 'inactive') {
      const receipt = `<p class="tool-approval-receipt">${escapeHtml(jt('approval.block.noLongerActive', 'Approval no longer active'))}</p>`;
      return mode === 'inline'
        ? `<div class="approval-gap-row" role="status" aria-live="polite"${rowIdentity} data-approval-status="inactive">${receipt}</div>`
        : `<div class="tool-approval-block"${rowIdentity} data-approval-status="inactive">${receipt}</div>`;
    }
    const promptTag = mode === 'inline' ? 'p' : 'div';
    const kickerLabel = cardState === 'paused'
      ? jt('approval.block.paused', 'Paused')
      : jt('approval.block.needed', 'Approval needed');
    const kickerMarkup = mode === 'inline'
      ? `<div class="tool-approval-kicker"><span class="tool-approval-kicker-dot" aria-hidden="true"></span>${escapeHtml(kickerLabel)}</div>`
      : '';
    // The headline says what will happen. A model-authored purpose wins it when
    // present -- only the model knows intent -- and the facts row below is the
    // check on that claim, since only the app can be trusted about effects.
    // A stated intent is attributed in the text itself, not only in a data
    // attribute: the reader must see that this sentence is Jenny's claim,
    // and a screen reader must hear it.
    const purpose = boundedText(source.purpose, PURPOSE_TEXT_MAX_CHARS);
    const headline = purpose || prompt;
    const attributionMarkup = purpose
      ? `<span class="tool-approval-intent-source">${escapeHtml(jt('approval.block.jennySays', 'Jenny says'))}</span> ` : '';
    const promptMarkup = `<${promptTag} class="tool-approval-prompt"`
      + ` data-approval-intent="${purpose ? 'stated' : 'derived'}">`
      + `${attributionMarkup}${escapeHtml(headline)}</${promptTag}>`;
    // "Another chat" (session_stop), "App settings" (settings_change) and "Scheduled checks"
    // (schedule_change) are the backend's own scopes (shown via approval.scope.anotherChat /
    // approval.scope.appSettings / chat.approval.schedule.scope).
    const requestedScope = normalizeText(source.policyScope);
    const policyScope = requestedScope === 'Another chat' || requestedScope === 'App settings' || requestedScope === 'Scheduled checks'
      ? requestedScope : normalizePolicyText(source.policyScope, POLICY_SCOPES);
    const policyConsequence = normalizePolicyText(source.policyConsequence, POLICY_CONSEQUENCES);
    const localizedPolicyScope = policyScope === 'Scheduled checks' ? jt('chat.approval.schedule.scope', 'Scheduled checks')
      : translatePolicyText('approvalScope', policyScope);
    const localizedPolicyConsequence = translatePolicyText('approvalConsequence', policyConsequence);
    // Bounded like the policy strings above: this also renders from persisted
    // and replayed payloads, which never passed through the backend sanitizer.
    const reason = boundedText(source.reason, REASON_TEXT_MAX_CHARS);
    const consequence = reason || localizedPolicyConsequence;
    const consequenceMarkup = consequence
      ? `<div class="tool-approval-consequence">${escapeHtml(consequence)}</div>`
      : '';
    // Neutral, uncoloured chips: identity, then the scope, then what the
    // payload itself declares. No severity tint -- a warning on every
    // side-effecting call teaches the reader to click through it.
    const chips = [{ field: 'tool', label: displayToolName }];
    if (policyScope) chips.push({ field: 'scope', label: localizedPolicyScope });
    if (settingsReady) {
      const count = settingsChange.rows.length;
      chips.push({ field: 'settings', label: jtn('approval.block.settingsCount', count, { count }, '1 setting', '{count} settings') });
    }
    // A check change's facts are the app's reading of it; the input-derived facts never stand in.
    if (scheduleReady) {
      for (const label of scheduleFacts(scheduleChange)) chips.push({ field: 'schedule', label });
    }
    for (const fact of changesSchedule ? [] : normalizeFacts(source.facts)) {
      chips.push({ field: fact.kind, label: fact.label });
    }
    if (sendsMessage) {
      chips.push({ field: 'send', label: jt('approval.block.sessionMessageFact', 'Sends a message to another chat') });
    }
    const factsMarkup = `<ul class="tool-approval-facts">`
      + chips.map((chip) => `<li class="tool-approval-fact"`
        + ` data-approval-fact="${escapeHtml(chip.field)}">${escapeHtml(chip.label)}</li>`).join('')
      + `</ul>`;
    const policyMarkup = consequence || policyScope
      ? `${consequenceMarkup}${factsMarkup}`
      : `<div class="tool-approval-policy-fallback">${escapeHtml(translatePolicyText('approvalConsequence', POLICY_FALLBACK))}</div>${factsMarkup}`;
    // The exact command/argument being approved, verbatim (bounded): the
    // headline paraphrases, this quotes. Skipped when the caller has nothing
    // meaningful to show or the preview would only repeat the headline.
    const commandText = String(source.commandText == null ? '' : source.commandText).trim();
    let commandMarkup = '';
    if (toolName === SESSION_STOP_TOOL) {
      commandMarkup = renderSessionStopApproval(normalizeSessionStopApproval(source.sessionStopApproval), escapeHtml);
    } else if (changesSettings) {
      commandMarkup = renderSettingsChangeApproval(settingsChange, escapeHtml);
    } else if (changesSchedule) {
      commandMarkup = renderScheduleChangeApproval(scheduleChange, escapeHtml);
    } else if (sessionMessage) {
      commandMarkup = renderSessionMessageApproval(sessionMessage, escapeHtml);
    } else if (sendsMessage) {
      commandMarkup = `<p class="tool-approval-message-note" data-approval-session-message-unavailable>`
        + `${escapeHtml(jt('approval.block.sessionMessageUnavailable', "The full message can't be shown, so it can't be approved. Deny it."))}</p>`;
    } else if (exactUnavailable) {
      commandMarkup = renderExactUnavailable(exactUnavailable, escapeHtml);
    } else if (exactApproval) {
      commandMarkup = renderExactApproval(exactApproval, escapeHtml);
    } else if (commandText && commandText !== headline) {
      const clipped = commandText.length > COMMAND_PREVIEW_MAX_CHARS
        ? jt('approval.block.clippedCommand', '{command}… (+{count} more chars)', { command: commandText.slice(0, COMMAND_PREVIEW_MAX_CHARS), count: commandText.length - COMMAND_PREVIEW_MAX_CHARS })
        : commandText;
      const quoted = `<pre class="tool-approval-command"><code>${quotedArgumentMarkup(clipped, escapeHtml)}</code></pre>`;
      // A one-liner is shorter than the sentence describing it, so hiding it
      // behind a click costs more than it saves. Only a block gets folded.
      // Counted on the full text: the summary promises what the payload is,
      // not what survived the clip.
      const lineCount = commandText.split('\n').length;
      commandMarkup = lineCount > 1
        ? `<details class="tool-approval-disclosure"><summary>`
          + `${escapeHtml(jt('approval.block.showAllLines', 'Show all {count} {unit}', { count: lineCount, unit: commandUnitNoun(toolName) }))}</summary>${quoted}</details>`
        : quoted;
    }
    // Three decisions, three buttons. The old checkbox-then-Allow pairing
    // hid a persistent policy change behind a modifier the reader could tick
    // and forget; a click on "Always allow" is that decision, and the scope
    // travels on the button that was pressed.
    const buttonIdentity = ` data-tool-call-id="${callIdAttr}" data-call-id="${callIdAttr}"`
      + `${approvalAttrMarkup}`;
    // A command offers Always allow only with a known, persistable scope (row 103).
    const commandScope = toolName === RUN_COMMAND_TOOL ? normalizeCommandScope(source.alwaysAllowScope) : null;
    const commandCopy = commandScope && commandScope.kind !== 'none' ? commandAlwaysAllowCopy(commandScope, escapeHtml) : null;
    const alwaysWithheld = sendsMessage || ownCardOnly || withholdsAllow || source.oneOffOnly === true || source.one_off_only === true
      || (toolName === RUN_COMMAND_TOOL && !commandCopy);
    const alwaysAllowMarkup = alwaysWithheld ? ''
      : `<button class="tool-approve-btn tool-approve-always-btn" type="button" data-action="approve"`
        + ` data-approval-scope="always"${buttonIdentity}`
        + ` title="${escapeHtml(commandCopy ? commandCopy.title : jt('approval.block.alwaysAllowTitle', 'Allow this tool call and stop asking for {tool}', { tool: displayToolName }))}"`
        + ` aria-label="${escapeHtml(commandCopy ? commandCopy.ariaLabel : jt('approval.block.alwaysAllowAriaLabel', 'Always allow {tool}', { tool: displayToolName }))}">`
        + `${commandCopy ? commandCopy.labelHtml : escapeHtml(jt('approval.block.alwaysAllow', 'Always allow'))}</button>`;
    const scopeNote = commandScope && commandScope.kind === 'none'
      ? scopeNoteMarkup(escapeHtml(jt('approval.block.scopeNoteChained', 'Chained commands can only be allowed once.')))
      : scopeNoteMarkup(alwaysAllowMarkup && commandCopy ? commandCopy.noteHtml : '');
    // Row 87 C1: a Jenny-chat message to a chat it started offers a standing rule; the backend made the offer.
    const rememberButton = sessionMessage && source.rememberOffer === 'linked_children' ? resolveActionButton() : null;
    const rememberMarkup = rememberButton ? rememberButton({
      id: 'approve', plain: true, className: 'tool-approve-btn tool-approve-always-btn',
      label: jt('approval.block.rememberLinked', 'Always allow for chats Jenny started'),
      dataset: { 'approval-scope': 'once', 'approval-remember': 'linked_children', 'tool-call-id': toolCallId, 'call-id': toolCallId,
        ...(approvalId ? { 'approval-id': approvalId } : {}) },
    }) : '';
    const actionButton = cardState === 'paused' ? resolveActionButton() : null;
    const resumeKey = normalizeText(source.resumeKey);
    const pausedActionsMarkup = `<div class="tool-approval-actions tool-approval-actions--paused">`
      + (actionButton && resumeKey ? actionButton({
        id: 'resume-paused-approval',
        label: jt('approval.block.resume', 'Resume'),
        variant: 'secondary',
        size: 'sm',
        className: 'resume-turn-action',
        ariaLabel: jt('approval.block.resumeAriaLabel', 'Resume the paused reply to answer'),
        title: jt('approval.block.resumeAriaLabel', 'Resume the paused reply to answer'),
        dataset: { 'resume-key': resumeKey },
      }) : '')
      + `<span class="tool-approval-paused-note">${escapeHtml(jt('approval.block.pausedNote', 'Resume to answer.'))}</span>`
      + `</div>`;
    const actionsMarkup = cardState === 'paused' ? pausedActionsMarkup : `<div class="tool-approval-actions">`
      + (withholdsAllow ? '' : `<button class="tool-approve-btn" type="button" data-action="approve"`
      + ` data-approval-scope="once"${buttonIdentity}`
      + ` title="${escapeHtml(jt('approval.block.allowTitle', 'Allow this tool call'))}" aria-label="${escapeHtml(jt('approval.block.allowOnceAriaLabel', 'Allow {tool} once', { tool: displayToolName }))}">${escapeHtml(jt('approval.block.allowOnce', 'Allow once'))}</button>`)
      + alwaysAllowMarkup + rememberMarkup
      + `<button class="tool-deny-btn" type="button" data-action="deny"${buttonIdentity}`
      + ` title="${escapeHtml(jt('approval.block.denyTitle', 'Deny this tool call'))}" aria-label="${escapeHtml(jt('approval.block.denyAriaLabel', 'Deny {tool}', { tool: displayToolName }))}">${escapeHtml(jt('approval.block.deny', 'Deny'))}</button>`
      + `</div>${scopeNote}${rememberMarkup ? scopeNoteMarkup(escapeHtml(jt('approval.block.rememberLinkedNote',
        'Always allow saves a rule you can remove in Activity > Permissions. Each message is still recorded.'))) : ''}`;

    const approvalStatus = cardState === 'paused' ? 'paused' : 'pending';
    const block = `<div class="tool-approval-block"`
      + `${rowIdentity}`
      + `${mode === 'card' && cardState === 'paused' ? ' data-approval-status="paused"' : ''}>`
      + `${kickerMarkup}${promptMarkup}${policyMarkup}${commandMarkup}${actionsMarkup}`
      + `</div>`;

    if (mode === 'inline') {
      // An exact-content message approval, or a request with no Allow, is decided only on its own
      // card, never by a batch.
      return `<div class="approval-gap-row" role="status" aria-live="polite"`
        + `${rowIdentity}`
        + `${sendsMessage || ownCardOnly || withholdsAllow ? ' data-approval-exact="true"' : ''}`
        + ` data-approval-status="${approvalStatus}">`
        + `${block}`
        + `</div>`;
    }
    return block;
  }

  return {
    EXACT_APPROVAL_TOOLS,
    applyApprovalReceipt,
    approvalCardStateKey,
    approvalKeepsReceipt,
    deriveApprovalReceipt,
    normalizeSessionMessageApproval,
    normalizeScheduleChangeApproval,
    scheduleChangeSubject: (value) => scheduleChangeSubject(normalizeScheduleChangeApproval(value)),
    normalizeSessionStopApproval,
    normalizeSettingsChangeApproval,
    renderApprovalBlock,
    resolveApprovalCardState,
    settingName,
    settingValueText,
    settingsChangeSubject: (value) => settingsChangeSubject(normalizeSettingsChangeApproval(value), 'pending'),
  };
});
