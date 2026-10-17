(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProposalCardActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Delegated interactions for the proposal cards (row 59 checkpoints 3 and 5a-2). One bound
  // handler per pane timeline. A click is one gesture: one decision_id, reused when the
  // same intent is retried after a transport failure, one request in flight per card.
  // The session always comes from the card (data-proposal-session), never from the
  // current session, so a click in a split pane reaches the right chat. Copy is the
  // inventory code block's own handler and never calls a proposal method.
  const SCHEMA_VERSION = 1;
  const DECIDE_CHOICES = new Set(['commit', 'test_first', 'dismiss', 'run', 'do_it_here', 'new_session']);
  const METHOD_BY_ACTION = { cancel: 'cancel', retry: 'retry', 'confirm-restored': 'confirmRestored' };
  // The wire action key behind a data-proposal-action attribute (the projection names it with an underscore).
  const ACTION_KEYS = { 'confirm-restored': 'confirm_restored' };
  // Options popover controls (data-proposal-option) -> the record's options key; '' means "automatic" (null).
  const OPTION_FIELDS = { destination: 'destination_project_id', model: 'preferred_model', effort: 'reasoning_effort', run_mode: 'run_mode' };

  function errorText(code, reason, kind) {
    if (kind === 'session' && (code === 'CMP-PROPOSAL-0009' || (!code && reason === 'unsupported_capability'))) {
      return jt('chat.proposal.err.unsupportedSession', "Starting a separate chat isn't available here.");
    }
    switch (code) {
      case 'CMP-PROPOSAL-0001': return jt('chat.proposal.err.invalid', "That request wasn't valid.");
      case 'CMP-PROPOSAL-0002': return jt('chat.proposal.err.unavailable', "Jenny isn't available right now. Try again.");
      case 'CMP-PROPOSAL-0003': return jt('chat.proposal.err.stale', 'This proposal changed. It has been refreshed.');
      case 'CMP-PROPOSAL-0004': return jt('chat.proposal.err.conflict', 'That conflicts with an earlier choice.');
      case 'CMP-PROPOSAL-0005': return jt('chat.proposal.err.expired', 'This proposal has expired.');
      case 'CMP-PROPOSAL-0006': return jt('chat.proposal.err.capacity', 'Too many proposals are open. Resolve one first.');
      case 'CMP-PROPOSAL-0007': return jt('chat.proposal.err.authority', 'This proposal is out of date.');
      case 'CMP-PROPOSAL-0008': return jt('chat.proposal.err.authorization', 'This needs your approval first.');
      case 'CMP-PROPOSAL-0009': return jt('chat.proposal.err.unsupported', "Run isn't available yet. Copy still works.");
      case 'CMP-PROPOSAL-0010': return jt('chat.proposal.err.preparation', "Jenny couldn't prepare that. Try again.");
      case 'CMP-PROPOSAL-0011': return jt('chat.proposal.err.dispatch', "Jenny couldn't start that. Try again.");
      case 'CMP-PROPOSAL-0012': return jt('chat.proposal.err.outcome', 'The outcome is unknown. Check before trying again.');
      default: return reason === 'unsupported_capability'
        ? jt('chat.proposal.err.unsupported', "Run isn't available yet. Copy still works.")
        : jt('chat.proposal.err.generic', "That didn't work. Try again.");
    }
  }

  function findByAttribute(scope, attribute, value) {
    for (const node of scope.querySelectorAll(`[${attribute}]`)) {
      if (node.getAttribute(attribute) === value) return node;
    }
    return null;
  }

  function bindProposalCardInteractions(container, deps) {
    const d = deps || {};
    if (!container || typeof container.addEventListener !== 'function') return () => {};
    const store = d.store || (globalThis.rendererProposalCardStore && globalThis.rendererProposalCardStore.getDefaultStore());
    const cards = d.cards || globalThis.rendererProposalCards || require('./renderer-proposal-cards');
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    if (!store || !cards) return () => {};
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge
      : () => { const shell = d.shell || (globalThis.window && globalThis.window.jennyShell); return (shell && shell.sessionProposals) || null; };
    const announcer = () => d.announcer || (globalThis.window && globalThis.window.rendererLiveAnnouncerInstance) || null;
    const suggestionGroup = d.suggestionGroup || globalThis.rendererProposalSuggestionGroup || require('./renderer-proposal-suggestion-group');
    let disposed = false;
    const focusAfterPatch = new Map(); // proposalId -> 'options-toggle' | 'options-control' | 'option:<key>'

    function cardOf(node) {
      const card = node && node.closest ? node.closest('[data-proposal-id]') : null;
      return card && container.contains(card) ? card : null;
    }

    // ---- in-place patching ----------------------------------------------------------
    function describeFocus(card) {
      const doc = card.ownerDocument;
      const active = doc && doc.activeElement;
      if (!active || active === card || !card.contains(active)) return null;
      const action = active.closest('[data-proposal-action]');
      if (action) return { attribute: 'data-proposal-action', value: action.getAttribute('data-proposal-action') };
      const ack = active.closest('[data-proposal-ack]');
      if (ack) return { attribute: 'data-proposal-ack', value: ack.getAttribute('data-proposal-ack') };
      const option = active.closest('[data-proposal-option]');
      if (option) return { attribute: 'data-proposal-option', value: option.getAttribute('data-proposal-option') };
      return { attribute: null, value: null };
    }

    function restoreFocus(next, focus) {
      if (!focus) return;
      let target = focus.attribute ? findByAttribute(next, focus.attribute, focus.value) : null;
      // The mode control is a radio group: focus its tab stop, not the group element.
      if (target && target.getAttribute('role') === 'radiogroup') target = target.querySelector('[tabindex="0"]') || target.querySelector('button:not([disabled])');
      if (target && target.disabled) target = null;
      if (!target) target = next.querySelector('.proposal-status');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function statusText(card) {
      const line = card && card.querySelector('.proposal-status');
      if (!line) return '';
      return ['.proposal-state', '.proposal-detail'].map((selector) => {
        const node = line.querySelector(selector);
        return node ? String(node.textContent || '').trim() : '';
      }).filter(Boolean).join('. ');
    }

    function announceStatus(proposalId, before, after) {
      const channel = announcer();
      if (!after || after === before || !channel || typeof channel.announce !== 'function') return;
      channel.announce(after, { key: `proposal-status:${proposalId}` });
    }

    function patchCard(card) {
      const sessionId = card.dataset.proposalSession || '';
      const proposalId = card.dataset.proposalId || '';
      const lookup = store.lookup(sessionId, proposalId);
      const markup = cards.buildProposalCardMarkup({ sessionId, proposalId, kind: card.dataset.proposalKind, lookup });
      if (!markup) return;
      const wanted = focusAfterPatch.get(proposalId);
      const template = card.ownerDocument.createElement('template');
      template.innerHTML = markup;
      const next = template.content.firstElementChild;
      if (!next) return;
      const focus = describeFocus(card);
      const before = statusText(card);
      const details = card.querySelector('.proposal-scope');
      const nextDetails = next.querySelector('.proposal-scope');
      if (details && nextDetails && details.open) nextDetails.open = true;
      card.replaceWith(next);
      const optionKey = typeof wanted === 'string' && wanted.startsWith('option:') ? wanted.slice(7) : '';
      const popover = next.querySelector('.proposal-options-popover:not([hidden])');
      // The inventory click-away and Escape treat the live toggle as this popover's trigger.
      if (popover) popover.__invPopoverTrigger = next.querySelector('[data-proposal-action="options"]');
      let control = optionKey ? findByAttribute(next, 'data-proposal-option', optionKey) : null;
      if (control && control.getAttribute('role') === 'radiogroup') control = control.querySelector('[tabindex="0"]') || control.querySelector('button:not([disabled])');
      // The changed control keeps focus once it is enabled again (it is disabled while the request runs).
      if (control && !control.disabled && !control.closest('[aria-disabled="true"]')) {
        focusAfterPatch.delete(proposalId);
        control.focus();
      } else restoreFocus(next, focus);
      if (wanted === 'options-toggle') {
        focusAfterPatch.delete(proposalId);
        const toggle = next.querySelector('[data-proposal-action="options"]');
        if (toggle && typeof toggle.focus === 'function') toggle.focus();
      } else if (wanted === 'options-control') {
        const control = next.querySelector('.proposal-options-popover:not([hidden]) select:not([disabled]), .proposal-options-popover:not([hidden]) [role="radio"][tabindex="0"]');
        if (control && typeof control.focus === 'function') { focusAfterPatch.delete(proposalId); control.focus(); }
      }
      announceStatus(proposalId, before, statusText(next));
    }

    // The group header is its own element: any member change repaints it in place (count, Start all, notice).
    function patchGroupHeaders(sessionId) {
      for (const head of [...container.querySelectorAll('[data-proposal-group]')]) {
        if (head.dataset.proposalSession !== sessionId) continue;
        const group = store.lookupGroup(sessionId, head.dataset.proposalGroup || '');
        const markup = group && typeof cards.buildGroupHeaderMarkup === 'function'
          ? cards.buildGroupHeaderMarkup({ sessionId, groupId: head.dataset.proposalGroup, group }) : '';
        if (!markup) continue;
        const template = head.ownerDocument.createElement('template');
        template.innerHTML = markup;
        const next = template.content.firstElementChild;
        if (!next) continue;
        const hadFocus = head.contains(head.ownerDocument.activeElement);
        head.replaceWith(next);
        if (!hadFocus) continue;
        const button = next.querySelector('[data-proposal-action="start-all"]:not([disabled])');
        const target = button || next;
        if (typeof target.focus === 'function') target.focus();
      }
    }

    const unsubscribe = store.subscribe(({ sessionId, proposalId }) => {
      if (disposed) return;
      for (const card of [...container.querySelectorAll('[data-proposal-id]')]) {
        if (card.dataset.proposalSession === sessionId && card.dataset.proposalId === proposalId) patchCard(card);
      }
      patchGroupHeaders(sessionId);
    });

    // ---- gestures -------------------------------------------------------------------
    async function perform(card, action) {
      const sessionId = card.dataset.proposalSession || '';
      const proposalId = card.dataset.proposalId || '';
      const lookup = store.lookup(sessionId, proposalId);
      const proposal = lookup.proposal;
      if (!sessionId || !proposalId || !proposal || lookup.status !== 'ready') return;
      if (store.isBusy(sessionId, proposalId)) return;
      const descriptor = proposal.actions && proposal.actions[ACTION_KEYS[action] || action];
      if (!descriptor || descriptor.available !== true) return;
      const isDecision = DECIDE_CHOICES.has(action);
      const method = isDecision ? 'decide' : METHOD_BY_ACTION[action];
      if (!method) return;
      let confirmed = null;
      if (action === 'run') {
        const preconditions = Array.isArray(proposal.display && proposal.display.preconditions) ? proposal.display.preconditions : [];
        confirmed = preconditions.map((_item, index) => index);
        if (!confirmed.every((index) => lookup.acks.includes(index))) return;
      }
      const signature = [method, action, proposal.revision, (confirmed || []).join(',')].join(':');
      const request = {
        schema_version: SCHEMA_VERSION,
        session_id: sessionId,
        proposal_id: proposalId,
        expected_revision: proposal.revision,
        decision_id: store.gestureId(sessionId, proposalId, signature),
      };
      if (isDecision) request.choice = action;
      if (confirmed) request.confirmed_preconditions = confirmed;
      await submit(card, method, request, { gesture: true });
    }

    /** One request on one card: busy while in flight, the projection applied, a calm notice on refusal. */
    async function submit(card, method, request, { gesture }) {
      const sessionId = request.session_id;
      const proposalId = request.proposal_id;
      const kind = card.dataset.proposalKind;
      const bridge = getBridge();
      if (!bridge || typeof bridge[method] !== 'function') {
        store.setNotice(sessionId, proposalId, { text: errorText('CMP-PROPOSAL-0002', '', kind) });
        return;
      }
      store.setNotice(sessionId, proposalId, null);
      store.setBusy(sessionId, proposalId, true);
      let response = null;
      try {
        response = await bridge[method](request);
      } catch (error) {
        log('WARN', 'proposal_card.action_failed', { method, message: String(error && error.message || error || '').slice(0, 120) });
      }
      if (disposed) {
        // The store is shared across panes: a pane closed mid-request must not leave the card busy.
        store.setBusy(sessionId, proposalId, false);
        return;
      }
      const ok = response && typeof response === 'object' && response.ok === true && response.proposal;
      if (ok) {
        if (gesture) store.settleGesture(sessionId, proposalId);
        store.apply(sessionId, response.proposal);
      } else if (response && response.ok === false && (response.retryable !== true || response.error_code === 'CMP-PROPOSAL-0003')) {
        // A definite refusal ends the gesture; a transport failure or a retryable refusal keeps its decision_id.
        // A stale revision is definite for this gesture (retryable only as a fresh one at the new revision).
        if (gesture) store.settleGesture(sessionId, proposalId);
        store.setNotice(sessionId, proposalId, { text: errorText(response.error_code, response.reason, kind) });
        if (response.error_code === 'CMP-PROPOSAL-0003' || response.error_code === 'CMP-PROPOSAL-0007' || response.reason === 'stale_revision') {
          void store.refresh(sessionId, proposalId);
        }
      } else {
        store.setNotice(sessionId, proposalId, { text: errorText(response && response.error_code, response && response.reason, kind) });
      }
      store.setBusy(sessionId, proposalId, false);
      const live = [...container.querySelectorAll('[data-proposal-id]')].find((node) => node.dataset.proposalId === proposalId);
      const status = live && live.querySelector('.proposal-status');
      if (status && typeof status.focus === 'function' && card.ownerDocument.activeElement === card.ownerDocument.body) status.focus();
    }

    // ---- Options (kind session) -------------------------------------------------------
    function toggleOptions(card) {
      const sessionId = card.dataset.proposalSession || '';
      const proposalId = card.dataset.proposalId || '';
      const open = !store.isOptionsOpen(sessionId, proposalId);
      focusAfterPatch.set(proposalId, open ? 'options-control' : 'options-toggle');
      store.setOptionsOpen(sessionId, proposalId, open);
    }

    function closeOptions(card, returnFocus) {
      const sessionId = card.dataset.proposalSession || '';
      const proposalId = card.dataset.proposalId || '';
      if (!store.isOptionsOpen(sessionId, proposalId)) return;
      if (returnFocus) focusAfterPatch.set(proposalId, 'options-toggle');
      else focusAfterPatch.delete(proposalId);
      store.setOptionsOpen(sessionId, proposalId, false);
    }

    // A click outside an open Options popover closes it (focus stays where the click put it).
    function closeOptionsAway(target) {
      for (const popover of [...container.querySelectorAll('.proposal-options-popover:not([hidden])')]) {
        const card = cardOf(popover);
        if (!card || popover.contains(target) || (card.querySelector('[data-proposal-action="options"]') || { contains: () => false }).contains(target)) continue;
        closeOptions(card, false);
      }
    }

    async function applyOption(card, key, value) {
      const field = OPTION_FIELDS[key];
      const sessionId = card.dataset.proposalSession || '';
      const proposalId = card.dataset.proposalId || '';
      const lookup = store.lookup(sessionId, proposalId);
      const proposal = lookup.proposal;
      if (!field || !proposal || proposal.kind !== 'session' || lookup.status !== 'ready' || proposal.options_editable !== true
        || !proposal.options || store.isBusy(sessionId, proposalId)) return;
      const next = { ...proposal.options, [field]: field === 'run_mode' ? String(value) : (value === '' ? null : String(value)) };
      if (JSON.stringify(next) === JSON.stringify(proposal.options)) return;
      focusAfterPatch.set(proposalId, `option:${key}`);
      await submit(card, 'setOptions', {
        schema_version: SCHEMA_VERSION, session_id: sessionId, proposal_id: proposalId, expected_revision: proposal.revision, options: next,
      }, { gesture: false });
    }

    // ---- Start all (suggestion group) -------------------------------------------------
    async function startAll(trigger) {
      const head = trigger.closest('[data-proposal-group]');
      const sessionId = head ? head.dataset.proposalSession || '' : '';
      const groupId = head ? head.dataset.proposalGroup || '' : '';
      if (!sessionId || !groupId || store.isGroupBusy(sessionId, groupId)) return;
      const group = store.lookupGroup(sessionId, groupId);
      if (!group || group.status !== 'ready') return;
      // The snapshot is taken now: later arrivals are excluded, started or failed rows are never re-selected.
      const items = suggestionGroup.snapshotItems(group, Date.now());
      if (!items.length) return;
      const bridge = getBridge();
      if (!bridge || typeof bridge.startAll !== 'function') {
        store.setGroupNotice(sessionId, groupId, { text: errorText('CMP-PROPOSAL-0002', '', 'session') });
        return;
      }
      const request = {
        schema_version: SCHEMA_VERSION, session_id: sessionId, group_id: groupId,
        decision_id: store.groupGestureId(sessionId, groupId, suggestionGroup.snapshotSignature(items)), items,
      };
      store.setGroupNotice(sessionId, groupId, null);
      store.setGroupBusy(sessionId, groupId, true);
      let response = null;
      try {
        response = await bridge.startAll(request);
      } catch (error) {
        log('WARN', 'proposal_card.start_all_failed', { message: String(error && error.message || error || '').slice(0, 120) });
      }
      if (disposed) { store.setGroupBusy(sessionId, groupId, false); return; }
      if (response && response.ok === true && Array.isArray(response.results)) {
        store.settleGroupGesture(sessionId, groupId);
        let failed = 0;
        for (const result of response.results) {
          if (!result || typeof result.proposal_id !== 'string') continue;
          if (result.ok === true && result.proposal) { store.apply(sessionId, result.proposal); continue; }
          failed += 1;
          store.setNotice(sessionId, result.proposal_id, { text: errorText(result.error_code, result.reason, 'session') });
          if (result.error_code === 'CMP-PROPOSAL-0003' || result.reason === 'stale_revision') void store.refresh(sessionId, result.proposal_id);
        }
        if (failed) {
          store.setGroupNotice(sessionId, groupId, {
            text: jt('chat.proposal.session.startAllPartial', "Some suggestions didn't start. Each one shows why."),
          });
        }
      } else if (response && response.ok === false && response.retryable !== true) {
        store.settleGroupGesture(sessionId, groupId);
        store.setGroupNotice(sessionId, groupId, { text: errorText(response.error_code, response.reason, 'session') });
      } else {
        store.setGroupNotice(sessionId, groupId, { text: errorText(response && response.error_code, response && response.reason, 'session') });
      }
      store.setGroupBusy(sessionId, groupId, false);
      void store.refreshGroup(sessionId, groupId);
    }

    function jump(action, trigger) {
      const scope = container;
      let target;
      if (action === 'jump-reply') {
        const turnId = trigger.dataset.proposalTurnId || '';
        if (typeof d.scrollToTurn === 'function' && d.scrollToTurn(turnId) === true) return;
        target = findByAttribute(scope, 'data-turn-id', turnId);
      } else {
        const callId = trigger.dataset.proposalToolCallId || '';
        const matches = [...scope.querySelectorAll('[data-tool-call-id]')].filter((node) => node.getAttribute('data-tool-call-id') === callId && !node.closest('[data-proposal-id]'));
        target = matches[0] || null;
        const toggle = target && target.querySelector('[data-tool-row-toggle][aria-expanded="false"]');
        if (toggle && typeof toggle.click === 'function') toggle.click();
      }
      if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    }

    function onClick(event) {
      if (disposed) return;
      closeOptionsAway(event.target);
      const trigger = event.target && event.target.closest ? event.target.closest('[data-proposal-action]') : null;
      const card = cardOf(trigger);
      if (!trigger || !card || trigger.disabled) {
        const segment = event.target && event.target.closest ? event.target.closest('.inv-segmented-option') : null;
        const group = segment && segment.closest('[data-proposal-option]');
        const owner = cardOf(group);
        if (segment && group && owner && !segment.disabled) void applyOption(owner, group.getAttribute('data-proposal-option'), segment.getAttribute('data-value'));
        return;
      }
      const action = trigger.getAttribute('data-proposal-action');
      if (action === 'jump-reply' || action === 'jump-tool') jump(action, trigger);
      else if (action === 'options') toggleOptions(card);
      else if (action === 'start-all') void startAll(trigger);
      else if (action === 'open-child') {
        const childId = trigger.dataset.proposalChildId || '';
        if (childId && typeof d.openSession === 'function') void d.openSession(childId);
      } else void perform(card, action);
    }

    function onChange(event) {
      if (disposed) return;
      const target = event.target;
      const box = target && target.closest ? target.closest('[data-proposal-ack]') : null;
      const card = cardOf(box);
      if (box && card) {
        store.setAck(card.dataset.proposalSession || '', card.dataset.proposalId || '', Number(box.getAttribute('data-proposal-ack')), Boolean(target.checked));
        return;
      }
      const select = target && target.closest ? target.closest('select[data-proposal-option]') : null;
      const owner = cardOf(select);
      if (select && owner) void applyOption(owner, select.getAttribute('data-proposal-option'), select.value);
    }

    // Arrow keys on the mode radio group come through the inventory's own handler as this event.
    function onSegmentChange(event) {
      if (disposed) return;
      const group = event.target && event.target.closest ? event.target.closest('[data-proposal-option]') : null;
      const owner = cardOf(group);
      if (group && owner && event.detail) void applyOption(owner, group.getAttribute('data-proposal-option'), event.detail.value);
    }

    function onKeydown(event) {
      if (disposed || event.key !== 'Escape') return;
      const popover = event.target && event.target.closest ? event.target.closest('.proposal-options-popover') : null;
      const card = cardOf(popover);
      if (!popover || !card) return;
      event.stopPropagation();
      closeOptions(card, true);
    }

    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    container.addEventListener('inv-segmented-change', onSegmentChange);
    container.addEventListener('keydown', onKeydown);
    // The inventory closed an open Options popover (click away elsewhere in the app, Escape): follow it.
    function onPopoverToggle(event) {
      if (disposed || !event.detail || event.detail.open !== false) return;
      const popover = event.target && event.target.closest ? event.target.closest('.proposal-options-popover') : null;
      const card = cardOf(popover);
      if (!popover || !card) return;
      focusAfterPatch.delete(card.dataset.proposalId || '');
      if (store.isOptionsOpen(card.dataset.proposalSession || '', card.dataset.proposalId || '')) {
        store.setOptionsOpen(card.dataset.proposalSession || '', card.dataset.proposalId || '', false);
      }
    }
    container.addEventListener('inv-popover-toggle', onPopoverToggle);
    return function dispose() {
      if (disposed) return;
      disposed = true;
      container.removeEventListener('click', onClick);
      container.removeEventListener('change', onChange);
      container.removeEventListener('inv-segmented-change', onSegmentChange);
      container.removeEventListener('keydown', onKeydown);
      container.removeEventListener('inv-popover-toggle', onPopoverToggle);
      unsubscribe();
    };
  }

  return { bindProposalCardInteractions, errorText };
});
