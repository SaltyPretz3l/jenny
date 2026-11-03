(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererNextStepCard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // The suggest_next_step card (row 97): a recap, an optional question and up to three reply buttons under
  // the reply. The card is a pure projection of the tool result's metadata plus the messages after it
  // (live -> picked or passed); nothing about the choice is stored. A click sends the button's message as an
  // ordinary user message through the pane's send path.
  const TOOL_NAME = 'suggest_next_step';
  const RESULT_KIND = 'next_step';
  // Mirrors LIMITS in services/backend/next-step-result-metadata.js (a test pins the parity): the browser
  // cannot require services/, and the card must only draw what the persisted allowlist would keep.
  const LIMITS = Object.freeze({ recap: 300, question: 100, actions: 3, label: 24, message: 300 });
  const SUCCESS_STATE = 'completed';

  const requireOptional = (path) => {
    if (typeof require !== 'function') return null;
    try { return require(path); } catch (_error) { return null; }
  };

  // The interactive-cards caller always passes escapeHtml; the action button comes from the inventory.
  function resolveDeps(deps) {
    const d = deps || {};
    return {
      escapeHtml: typeof d.escapeHtml === 'function' ? d.escapeHtml : null,
      actionButton: d.actionButton || globalThis.inventoryActionButton || (globalThis.inventory || {}).actionButton || requireOptional('../inventory/action-button'),
      // The proposal cards own the result-metadata lookup (paired row, stored result, own payload, call id).
      proposalCards: globalThis.rendererProposalCards || requireOptional('./renderer-proposal-cards'),
    };
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  const text = (value) => String(value == null ? '' : value).trim();
  const isBounded = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;

  /** {recap, question, actions} when the metadata is exactly the success shape within the limits, else null. */
  function readNextStep(metadata) {
    const source = asObject(metadata);
    if (!source || source.result_kind !== RESULT_KIND || source.schema_version !== 1) return null;
    if (!isBounded(source.recap, LIMITS.recap)) return null;
    const question = source.question == null ? null : source.question;
    if (question !== null && !isBounded(question, LIMITS.question)) return null;
    if (!Array.isArray(source.actions) || source.actions.length > LIMITS.actions) return null;
    const actions = [];
    for (const action of source.actions) {
      const entry = asObject(action);
      if (!entry || !isBounded(entry.label, LIMITS.label) || !isBounded(entry.message, LIMITS.message)) return null;
      actions.push({ label: entry.label, message: entry.message });
    }
    if (question && !actions.length) return null;
    return { recap: source.recap, question, actions };
  }

  // A running or failed call keeps the generic tool row; only a settled, successful result is a card.
  function isSuccessful(row, pairedRow) {
    const payload = asObject(row && row.payload) || {};
    const result = asObject(pairedRow && pairedRow.payload) || {};
    if (result.is_error === true || result.result_is_error === true || payload.result_is_error === true) return false;
    return text(result.state || payload.state) === SUCCESS_STATE;
  }

  function locateCall(row, messages) {
    const list = Array.isArray(messages) ? messages : [];
    const messageId = text(row && row.primary_message_id);
    const callId = text(row && (row.tool_call_id || (row.payload && row.payload.tool_call_id)));
    let index = messageId ? list.findIndex((message) => message && text(message.id) === messageId) : -1;
    if (index < 0 && callId) {
      index = list.findIndex((message) => message && message.kind === 'tool_use'
        && text(message.tool_call && message.tool_call.call_id) === callId);
    }
    return index;
  }

  /** {state: 'live'|'picked'|'passed', picked: index|-1}: derived from the messages after the call, never stored. */
  function deriveState(row, messages, steps) {
    const index = locateCall(row, messages);
    // A call the transcript cannot place is not offered: a stale card must not send.
    if (index < 0) return { state: 'passed', picked: -1 };
    for (let at = index + 1; at < messages.length; at += 1) {
      const message = messages[at];
      if (!message || message.role !== 'user') continue;
      // A wake or auto-resume turn is the app's, not the person's reply.
      if (text(message.application_turn)) continue;
      const reply = text(message.content);
      const picked = steps.actions.findIndex((action) => action.message === reply);
      // A reply that matches no button means the user typed something else.
      return picked < 0 ? { state: 'passed', picked } : { state: 'picked', picked };
    }
    return { state: 'live', picked: -1 };
  }

  /** The tool-call row's card: '' unless this is a successful suggest_next_step result (then the default tool row renders). */
  function buildNextStepMarkup(row, messages, options, deps) {
    const payload = asObject(row && row.payload) || {};
    if (text(payload.tool_name) !== TOOL_NAME) return '';
    const renderOptions = options || {};
    const pairedRow = renderOptions.pairedToolResultRow || null;
    // Cheap check first: a running or failed call never scans the messages.
    if (!isSuccessful(row, pairedRow)) return '';
    const resolved = resolveDeps(deps);
    if (!resolved.escapeHtml || !resolved.actionButton || !resolved.proposalCards) return '';
    const { escapeHtml, actionButton } = resolved;
    const steps = readNextStep(resolved.proposalCards.findResultMetadata(row, pairedRow, messages));
    if (!steps) return '';
    const derived = deriveState(row, messages, steps);
    const state = derived.state;
    // While the reply is still streaming the buttons wait: the card is not final yet.
    const streaming = renderOptions.turnLive === true || renderOptions.isStreaming === true;
    const label = jt('chat.nextStep.label', 'Next step');
    const callId = text(row && (row.tool_call_id || payload.tool_call_id));
    const buttons = state === 'live' && steps.actions.length
      ? `<div class="next-step-actions">${steps.actions.map((action, index) => actionButton({
        plain: true, className: 'next-step-action', label: action.label, title: action.message, disabled: streaming,
        // The message rides its own attribute: the app tooltip layer moves `title` to data-tooltip on hover.
        dataset: { 'next-step-index': index, 'next-step-message': action.message, primary: index === 0 },
      })).join('')}</div>`
      : '';
    const question = steps.question && state !== 'passed'
      ? `<p class="next-step-question">${escapeHtml(steps.question)}</p>` : '';
    const receipt = state === 'picked'
      ? `<p class="next-step-receipt">${escapeHtml(jt('chat.nextStep.chose', 'You chose {label}', { label: steps.actions[derived.picked].label }))}</p>`
      : '';
    return `<div class="next-step-card" role="group" aria-label="${escapeHtml(label)}" data-tool-call-id="${escapeHtml(callId)}" data-state="${state}">`
      + `<div class="next-step-header" aria-hidden="true"><span class="next-step-eyebrow">${escapeHtml(label)}</span><span class="next-step-rule"></span></div>`
      + `<p class="next-step-recap">${escapeHtml(steps.recap)}</p>${question}${buttons}${receipt}</div>`;
  }

  // ---- click handling -----------------------------------------------------------------

  function setButtonsDisabled(card, disabled) {
    card.querySelectorAll('.next-step-action').forEach((button) => { button.disabled = disabled; });
  }

  // In-place picked state: what a re-render of the settled turn would draw, applied before the send
  // resolves so a second click cannot send twice.
  function markPicked(card, button) {
    card.setAttribute('data-state', 'picked');
    setButtonsDisabled(card, true);
    const receipt = card.ownerDocument.createElement('p');
    receipt.className = 'next-step-receipt';
    receipt.textContent = jt('chat.nextStep.chose', 'You chose {label}', { label: text(button.textContent) });
    card.appendChild(receipt);
  }

  function restoreLive(card) {
    card.setAttribute('data-state', 'live');
    const receipt = card.querySelector('.next-step-receipt');
    if (receipt) receipt.remove();
    setButtonsDisabled(card, false);
  }

  /** Delegated click handler on the pane's timeline; returns its cleanup. deps: {sendPrompt, appendClientLog, showToastMessage}. */
  function bindNextStepActions(container, deps) {
    const d = deps || {};
    if (!container || typeof container.addEventListener !== 'function') return () => {};
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    let disposed = false;

    function failed(card, reason) {
      if (disposed || !card.isConnected) return;
      restoreLive(card);
      log('WARN', 'next_step.send_failed', { reason: String(reason || 'blocked').slice(0, 80) });
      if (typeof d.showToastMessage === 'function') {
        d.showToastMessage(jt('chat.nextStep.sendFailed', 'That reply was not sent. Try again when Jenny has finished replying.'));
      }
    }

    function onClick(event) {
      const button = event.target && event.target.closest ? event.target.closest('.next-step-action') : null;
      const card = button && button.closest('.next-step-card');
      if (!button || !card || !container.contains(card)) return;
      event.preventDefault();
      const message = text(button.getAttribute('data-next-step-message'));
      if (button.disabled || card.getAttribute('data-state') !== 'live' || !message || typeof d.sendPrompt !== 'function') return;
      markPicked(card, button);
      Promise.resolve()
        .then(() => d.sendPrompt(message))
        .then((result) => {
          if (!result || result.rejected) {
            failed(card, result && result.reason);
            return;
          }
          // Accepted: the buttons have done their job; the receipt stays until the next render.
          const actions = card.querySelector('.next-step-actions');
          if (actions && !disposed) actions.remove();
        })
        .catch((error) => failed(card, error && error.message));
    }

    container.addEventListener('click', onClick);
    return () => {
      disposed = true;
      container.removeEventListener('click', onClick);
    };
  }

  return { LIMITS, buildNextStepMarkup, bindNextStepActions };
});
