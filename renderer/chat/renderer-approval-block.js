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

  // Load-order guard: sibling modules (browser global, else require) must already be loaded.
  function needSibling(mod, key, name) {
    if (!mod || typeof mod[key] !== 'function') {
      throw new Error(`${name} must load before renderer/chat/renderer-approval-block.js`);
    }
    return mod;
  }
  const canRequire = typeof require === 'function';
  const { normalizeText, boundedText, quotedArgumentMarkup } = needSibling(globalThis.rendererApprovalText
    || (canRequire ? require('./renderer-approval-text') : null), 'boundedText', 'renderer-approval-text');
  const {
    RECEIPT_SUBJECT_MAX_CHARS,
    applyApprovalReceipt,
    approvalCardStateKey,
    approvalKeepsReceipt,
    deriveApprovalReceipt,
    receiptDecision,
    renderResolvedReceipt,
    resolveApprovalCardState,
  } = needSibling(globalThis.rendererApprovalReceipts
    || (canRequire ? require('./renderer-approval-receipts') : null), 'deriveApprovalReceipt', 'renderer-approval-receipts');
  const {
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
  } = needSibling(globalThis.rendererApprovalBlockCards
    || (canRequire ? require('./renderer-approval-block-cards') : null), 'renderSettingsChangeApproval', 'renderer-approval-block-cards');

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
    // A browser ask is written from the app's reading of the page, and the model's words never stand in.
    const asksBrowser = toolName === BROWSER_TOOL;
    const browserApproval = asksBrowser ? normalizeBrowserApproval(source.browserApproval) : null;
    const browserCopy = browserApproval ? browserApprovalCopy(browserApproval) : null;
    const ownCardOnly = changesSettings || changesSchedule || asksBrowser;
    const withholdsAllow = (sendsMessage && !sessionMessage) || Boolean(exactUnavailable) || (changesSettings && !settingsReady)
      || (changesSchedule && !scheduleReady) || (asksBrowser && !browserCopy);
    const displayToolName = normalizeText(source.displayToolName) || toolName || jt('approval.block.thisTool', 'this tool');
    const mode = source.mode === 'card' ? 'card' : 'inline';
    const prompt = browserCopy?.prompt || normalizeText(source.prompt)
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
      const settingsSubject = asksBrowser ? (browserCopy?.subject || '') : toolName === SETTINGS_CHANGE_TOOL
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
    const purpose = asksBrowser ? '' : boundedText(source.purpose, PURPOSE_TEXT_MAX_CHARS);
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
    const reason = asksBrowser ? '' : boundedText(source.reason, REASON_TEXT_MAX_CHARS);
    const consequence = asksBrowser ? (browserCopy?.consequence || '') : reason || localizedPolicyConsequence;
    const consequenceMarkup = consequence
      ? `<div class="tool-approval-consequence">${escapeHtml(consequence)}</div>`
      : '';
    // Neutral, uncoloured chips: identity, then the scope, then what the
    // payload itself declares. No severity tint -- a warning on every
    // side-effecting call teaches the reader to click through it.
    const chips = [{ field: 'tool', label: displayToolName }];
    if (browserCopy) chips.push({ field: 'browser', label: browserCopy.fact });
    else if (policyScope && !asksBrowser) chips.push({ field: 'scope', label: localizedPolicyScope });
    if (settingsReady) {
      const count = settingsChange.rows.length;
      chips.push({ field: 'settings', label: jtn('approval.block.settingsCount', count, { count }, '1 setting', '{count} settings') });
    }
    // A check change's facts are the app's reading of it; the input-derived facts never stand in.
    if (scheduleReady) {
      for (const label of scheduleFacts(scheduleChange)) chips.push({ field: 'schedule', label });
    }
    for (const fact of changesSchedule || asksBrowser ? [] : normalizeFacts(source.facts)) {
      chips.push({ field: fact.kind, label: fact.label });
    }
    if (sendsMessage) {
      chips.push({ field: 'send', label: jt('approval.block.sessionMessageFact', 'Sends a message to another chat') });
    }
    const factsMarkup = `<ul class="tool-approval-facts">`
      + chips.map((chip) => `<li class="tool-approval-fact"`
        + ` data-approval-fact="${escapeHtml(chip.field)}">${escapeHtml(chip.label)}</li>`).join('')
      + `</ul>`;
    const policyMarkup = consequence || policyScope || asksBrowser
      ? `${consequenceMarkup}${factsMarkup}`
      : `<div class="tool-approval-policy-fallback">${escapeHtml(translatePolicyText('approvalConsequence', POLICY_FALLBACK))}</div>${factsMarkup}`;
    // The exact command/argument being approved, verbatim (bounded): the
    // headline paraphrases, this quotes. Skipped when the caller has nothing
    // meaningful to show or the preview would only repeat the headline.
    const commandText = String(source.commandText == null ? '' : source.commandText).trim();
    let commandMarkup = '';
    if (asksBrowser) {
      commandMarkup = renderBrowserApproval(browserCopy, escapeHtml);
    } else if (toolName === SESSION_STOP_TOOL) {
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
      + ` title="${escapeHtml(browserCopy?.allow || jt('approval.block.allowTitle', 'Allow this tool call'))}" aria-label="${escapeHtml(browserCopy?.allow || jt('approval.block.allowOnceAriaLabel', 'Allow {tool} once', { tool: displayToolName }))}">${escapeHtml(browserCopy?.allow || jt('approval.block.allowOnce', 'Allow once'))}</button>`)
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
