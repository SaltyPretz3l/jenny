(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalBlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
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

  // Which card a pending approval row shows (A4, owner-approved 2026-09-22).
  // Live wins: Allow and Deny resolve by call id, so any approval the runtime
  // holds for the call is answerable. A paused reply for the turn offers its
  // Resume; one being discarded, or a card whose answer was refused, folds to
  // a receipt, as does a row the sealed fold marked interrupted (the turn is
  // over). Anything else keeps today's buttons: before the live approvals and
  // paused work load, a card must not claim it is dead.
  function resolveApprovalCardState(state, ref) {
    const callId = normalizeText(ref && ref.callId);
    if (!state || !callId) return { state: 'live' };
    const approvals = state.pendingToolApprovals && typeof state.pendingToolApprovals.values === 'function'
      ? [...state.pendingToolApprovals.values()] : [];
    if (approvals.some((approval) => normalizeText(approval && approval.callId) === callId)) {
      return { state: 'live' };
    }
    const sessionId = normalizeText(ref.sessionId);
    const turnId = normalizeText(ref.turnId);
    const rows = sessionId && turnId && typeof state.runtimeSendController?.listPending === 'function'
      ? state.runtimeSendController.listPending(sessionId) : [];
    const held = rows.find((row) => row.turnId === turnId && HELD_STATUSES.has(row.status));
    if (held) return held.status === 'paused' ? { state: 'paused', resumeKey: held.key } : { state: 'inactive' };
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
        .map((row) => `${row.turnId}=${row.status}:${row.key}`).sort()
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

  function renderApprovalBlock(options, deps) {
    const source = options || {};
    const dependencies = deps || {};
    const escapeHtml = typeof dependencies.escapeHtml === 'function'
      ? dependencies.escapeHtml
      : defaultEscapeHtml;

    const toolCallId = normalizeText(source.toolCallId);
    const approvalId = normalizeText(source.approvalId);
    const toolName = normalizeText(source.toolName);
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
    const policyScope = normalizePolicyText(source.policyScope, POLICY_SCOPES);
    const policyConsequence = normalizePolicyText(source.policyConsequence, POLICY_CONSEQUENCES);
    const localizedPolicyScope = translatePolicyText('approvalScope', policyScope);
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
    for (const fact of normalizeFacts(source.facts)) {
      chips.push({ field: fact.kind, label: fact.label });
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
    if (commandText && commandText !== headline) {
      const clipped = commandText.length > COMMAND_PREVIEW_MAX_CHARS
        ? jt('approval.block.clippedCommand', '{command}… (+{count} more chars)', { command: commandText.slice(0, COMMAND_PREVIEW_MAX_CHARS), count: commandText.length - COMMAND_PREVIEW_MAX_CHARS })
        : commandText;
      const quoted = `<pre class="tool-approval-command"><code>${escapeHtml(clipped)}</code></pre>`;
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
    const alwaysAllowMarkup = source.oneOffOnly === true || source.one_off_only === true ? ''
      : `<button class="tool-approve-btn tool-approve-always-btn" type="button" data-action="approve"`
        + ` data-approval-scope="always"${buttonIdentity}`
        + ` title="${escapeHtml(jt('approval.block.alwaysAllowTitle', 'Allow this tool call and stop asking for {tool}', { tool: displayToolName }))}"`
        + ` aria-label="${escapeHtml(jt('approval.block.alwaysAllowAriaLabel', 'Always allow {tool}', { tool: displayToolName }))}">${escapeHtml(jt('approval.block.alwaysAllow', 'Always allow'))}</button>`;
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
      + `<button class="tool-approve-btn" type="button" data-action="approve"`
      + ` data-approval-scope="once"${buttonIdentity}`
      + ` title="${escapeHtml(jt('approval.block.allowTitle', 'Allow this tool call'))}" aria-label="${escapeHtml(jt('approval.block.allowOnceAriaLabel', 'Allow {tool} once', { tool: displayToolName }))}">${escapeHtml(jt('approval.block.allowOnce', 'Allow once'))}</button>`
      + alwaysAllowMarkup
      + `<button class="tool-deny-btn" type="button" data-action="deny"${buttonIdentity}`
      + ` title="${escapeHtml(jt('approval.block.denyTitle', 'Deny this tool call'))}" aria-label="${escapeHtml(jt('approval.block.denyAriaLabel', 'Deny {tool}', { tool: displayToolName }))}">${escapeHtml(jt('approval.block.deny', 'Deny'))}</button>`
      + `</div>`;

    const approvalStatus = cardState === 'paused' ? 'paused' : 'pending';
    const block = `<div class="tool-approval-block"`
      + `${rowIdentity}`
      + `${mode === 'card' && cardState === 'paused' ? ' data-approval-status="paused"' : ''}>`
      + `${kickerMarkup}${promptMarkup}${policyMarkup}${commandMarkup}${actionsMarkup}`
      + `</div>`;

    if (mode === 'inline') {
      return `<div class="approval-gap-row" role="status" aria-live="polite"`
        + `${rowIdentity}`
        + ` data-approval-status="${approvalStatus}">`
        + `${block}`
        + `</div>`;
    }
    return block;
  }

  return {
    approvalCardStateKey,
    renderApprovalBlock,
    resolveApprovalCardState,
  };
});
