(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalBlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_INLINE_PROMPT = 'Approval is required before this tool can continue.';
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
      case 'python_execute': return 'lines of Python';
      case 'run_command': case 'Bash': case 'run_temp_script': return 'lines of shell';
      case 'move_file': return 'moves';
      default: return 'lines';
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
    const displayToolName = normalizeText(source.displayToolName) || toolName || 'this tool';
    const mode = source.mode === 'card' ? 'card' : 'inline';
    const prompt = normalizeText(source.prompt)
      || (mode === 'inline' ? DEFAULT_INLINE_PROMPT : `Approve ${displayToolName}?`);

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
    const labelName = escapeHtml(displayToolName);
    const promptTag = mode === 'inline' ? 'p' : 'div';
    const kickerMarkup = mode === 'inline'
      ? `<div class="tool-approval-kicker"><span class="tool-approval-kicker-dot" aria-hidden="true"></span>Approval needed</div>`
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
      ? `<span class="tool-approval-intent-source">Jenny says</span> ` : '';
    const promptMarkup = `<${promptTag} class="tool-approval-prompt"`
      + ` data-approval-intent="${purpose ? 'stated' : 'derived'}">`
      + `${attributionMarkup}${escapeHtml(headline)}</${promptTag}>`;
    const policyScope = normalizePolicyText(source.policyScope, POLICY_SCOPES);
    const policyConsequence = normalizePolicyText(source.policyConsequence, POLICY_CONSEQUENCES);
    // Bounded like the policy strings above: this also renders from persisted
    // and replayed payloads, which never passed through the backend sanitizer.
    const reason = boundedText(source.reason, REASON_TEXT_MAX_CHARS);
    const consequence = reason || policyConsequence;
    const consequenceMarkup = consequence
      ? `<div class="tool-approval-consequence">${escapeHtml(consequence)}</div>`
      : '';
    // Neutral, uncoloured chips: identity, then the scope, then what the
    // payload itself declares. No severity tint -- a warning on every
    // side-effecting call teaches the reader to click through it.
    const chips = [{ field: 'tool', label: displayToolName }];
    if (policyScope) chips.push({ field: 'scope', label: policyScope });
    for (const fact of normalizeFacts(source.facts)) {
      chips.push({ field: fact.kind, label: fact.label });
    }
    const factsMarkup = `<ul class="tool-approval-facts">`
      + chips.map((chip) => `<li class="tool-approval-fact"`
        + ` data-approval-fact="${escapeHtml(chip.field)}">${escapeHtml(chip.label)}</li>`).join('')
      + `</ul>`;
    const policyMarkup = consequence || policyScope
      ? `${consequenceMarkup}${factsMarkup}`
      : `<div class="tool-approval-policy-fallback">${POLICY_FALLBACK}</div>${factsMarkup}`;
    // The exact command/argument being approved, verbatim (bounded): the
    // headline paraphrases, this quotes. Skipped when the caller has nothing
    // meaningful to show or the preview would only repeat the headline.
    const commandText = String(source.commandText == null ? '' : source.commandText).trim();
    let commandMarkup = '';
    if (commandText && commandText !== headline) {
      const clipped = commandText.length > COMMAND_PREVIEW_MAX_CHARS
        ? `${commandText.slice(0, COMMAND_PREVIEW_MAX_CHARS)}… (+${commandText.length - COMMAND_PREVIEW_MAX_CHARS} more chars)`
        : commandText;
      const quoted = `<pre class="tool-approval-command"><code>${escapeHtml(clipped)}</code></pre>`;
      // A one-liner is shorter than the sentence describing it, so hiding it
      // behind a click costs more than it saves. Only a block gets folded.
      // Counted on the full text: the summary promises what the payload is,
      // not what survived the clip.
      const lineCount = commandText.split('\n').length;
      commandMarkup = lineCount > 1
        ? `<details class="tool-approval-disclosure"><summary>`
          + `Show all ${lineCount} ${commandUnitNoun(toolName)}</summary>${quoted}</details>`
        : quoted;
    }
    // Three decisions, three buttons. The old checkbox-then-Allow pairing
    // hid a persistent policy change behind a modifier the reader could tick
    // and forget; a click on "Always allow" is that decision, and the scope
    // travels on the button that was pressed.
    const buttonIdentity = ` data-tool-call-id="${callIdAttr}" data-call-id="${callIdAttr}"`
      + `${approvalAttrMarkup}`;
    const actionsMarkup = `<div class="tool-approval-actions">`
      + `<button class="tool-approve-btn" type="button" data-action="approve"`
      + ` data-approval-scope="once"${buttonIdentity}`
      + ` title="Allow this tool call" aria-label="Allow ${labelName} once">Allow once</button>`
      + `<button class="tool-approve-btn tool-approve-always-btn" type="button" data-action="approve"`
      + ` data-approval-scope="always"${buttonIdentity}`
      + ` title="Allow this tool call and stop asking for ${labelName}"`
      + ` aria-label="Always allow ${labelName}">Always allow</button>`
      + `<button class="tool-deny-btn" type="button" data-action="deny"${buttonIdentity}`
      + ` title="Deny this tool call" aria-label="Deny ${labelName}">Deny</button>`
      + `</div>`;

    const block = `<div class="tool-approval-block"`
      + ` data-tool-call-id="${callIdAttr}" data-call-id="${callIdAttr}"`
      + `${approvalAttrMarkup}>`
      + `${kickerMarkup}${promptMarkup}${policyMarkup}${commandMarkup}${actionsMarkup}`
      + `</div>`;

    if (mode === 'inline') {
      return `<div class="approval-gap-row" role="status" aria-live="polite"`
        + ` data-tool-call-id="${callIdAttr}" data-call-id="${callIdAttr}"`
        + `${approvalAttrMarkup}`
        + ` data-approval-status="pending">`
        + `${block}`
        + `</div>`;
    }
    return block;
  }

  return {
    renderApprovalBlock,
  };
});
