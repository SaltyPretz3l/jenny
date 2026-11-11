(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalBlockCards = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // Load-order guard: the shared text helpers must already be loaded.
  const textUtils = globalThis.rendererApprovalText
    || (typeof require === 'function' ? require('./renderer-approval-text') : null);
  if (!textUtils || typeof textUtils.boundedText !== 'function') {
    throw new Error('renderer-approval-text must load before renderer/chat/renderer-approval-block-cards.js');
  }
  const { boundedText, quotedArgumentMarkup } = textUtils;

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

  // Browser asks (row 114). Every word comes from the app's reading of the page and the address; the
  // value arrives from a persisted or replayed payload, so it is validated and rebuilt here.
  const BROWSER_TOOL = 'browser';
  const BROWSER_KINDS = new Set(['navigate', 'click', 'submit']);
  const BROWSER_REASONS = new Set(['new_site', 'risky_words', 'form_post']);
  const BROWSER_HOST_MAX_CHARS = 253;
  const BROWSER_LABEL_MAX_CHARS = 120;
  const BROWSER_URL_MAX_CHARS = 2048;

  function normalizeBrowserApproval(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1) return null;
    if (!BROWSER_KINDS.has(value.kind) || !BROWSER_REASONS.has(value.reason)) return null;
    const host = boundedText(value.host, BROWSER_HOST_MAX_CHARS);
    const label = boundedText(value.label, BROWSER_LABEL_MAX_CHARS);
    const url = boundedText(value.url, BROWSER_URL_MAX_CHARS);
    if (!host || (value.kind === 'navigate') !== (value.reason === 'new_site')) return null;
    const form = value.kind === 'submit' || value.reason === 'form_post';
    if (!form && value.kind === 'click' && !label) return null;
    return { shape: value.kind === 'navigate' ? 'site' : (form ? 'form' : 'action'), host, label, url };
  }

  function browserApprovalCopy(approval) {
    const { shape, host, label, url } = approval;
    if (shape === 'site') {
      return {
        prompt: jt('approval.block.browserOpenSite', 'Open {host}?', { host }),
        consequence: jt('approval.block.browserOpenSiteNote', 'Jenny has not been to this site in this chat. If you allow it, Jenny can keep using it until the chat ends.'),
        fact: jt('approval.block.browserNewSite', 'New site'), allow: jt('approval.block.browserAllowSite', 'Allow this site'), url, subject: host,
      };
    }
    const fact = jt('approval.block.browserOneAction', 'One action');
    if (shape === 'form') {
      return {
        prompt: jt('approval.block.browserSendForm', 'Send this form to {host}?', { host }),
        consequence: jt('approval.block.browserSendFormNote', 'What is in the form goes to the site. Allowing covers this one send.'),
        fact, url, subject: host,
      };
    }
    return {
      prompt: jt('approval.block.browserClick', 'Click "{label}" on {host}?', { label, host }),
      consequence: jt('approval.block.browserClickNote', 'This looks like it could buy, send or delete something. Allowing covers this one click.'),
      fact, url: '', subject: label,
    };
  }

  function renderBrowserApproval(copy, escapeHtml) {
    if (!copy) {
      return `<p class="tool-approval-message-note" data-approval-browser-unavailable>`
        + `${escapeHtml(jt('approval.block.browserUnavailable', "The details of this step can't be shown, so it can't be approved. Deny it."))}</p>`;
    }
    return copy.url ? `<pre class="tool-approval-command"><code>${escapeHtml(copy.url)}</code></pre>` : '';
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

  return {
    BROWSER_TOOL,
    EXACT_APPROVAL_TOOLS,
    SESSION_MESSAGE_TOOL,
    SESSION_STOP_TOOL,
    SETTINGS_CHANGE_TOOL,
    SCHEDULE_CHANGE_TOOL,
    browserApprovalCopy,
    normalizeBrowserApproval,
    normalizeExactApproval,
    normalizeScheduleChangeApproval,
    normalizeSessionMessageApproval,
    normalizeSessionStopApproval,
    normalizeSettingsChangeApproval,
    renderBrowserApproval,
    renderExactApproval,
    renderExactUnavailable,
    renderScheduleChangeApproval,
    renderSessionMessageApproval,
    renderSessionStopApproval,
    renderSettingsChangeApproval,
    scheduleChangeSubject,
    scheduleFacts,
    settingName,
    settingValueText,
    settingsChangeSubject,
  };
});
