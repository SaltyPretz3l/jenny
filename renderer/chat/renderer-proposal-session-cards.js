(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProposalSessionCards = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // The session offer card and the suggestion row (row 59 checkpoint 5a-2), drawn only from
  // the projection (renderer-proposal-card-store.js). An ordinary offer is one soft tray with
  // two equal choices, Do it here and New session, and an Options disclosure; an unsolicited
  // suggestion is a compact row (title, short description, Options, Do it here, Start, dismiss)
  // whose group header comes from renderer-proposal-suggestion-group.js. Every state after a
  // choice is a receipt with the shipped .proposal-status grammar (dot, state word, detail).
  // `h` is the helper bag renderer-proposal-cards.js passes in (shared markup pieces and the
  // resolved inventory primitives); nothing here executes anything.
  const requireOptional = (path) => {
    if (typeof require !== 'function') return null;
    try { return require(path); } catch (_error) { return null; }
  };
  const suggestionGroup = (typeof globalThis !== 'undefined' && globalThis.rendererProposalSuggestionGroup)
    || requireOptional('./renderer-proposal-suggestion-group');

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function inventoryPrimitive(name, path) {
    const inv = globalThis.inventory || {};
    const direct = inv[name];
    if (typeof direct === 'function') return direct;
    const loaded = requireOptional(path);
    return typeof loaded === 'function' ? loaded : null;
  }

  // ---- status ---------------------------------------------------------------------

  function preparationDetail(causeCode) {
    switch (causeCode) {
      case 'deadline': return jt('chat.proposal.session.prepDeadline', 'Preparing took longer than 60 seconds. You can try again.');
      case 'no_handoff': return jt('chat.proposal.session.prepNoBrief', "Jenny didn't finish the brief. You can try again.");
      case 'prep_error': return jt('chat.proposal.session.prepError', 'The preparation turn failed. You can try again.');
      default: return jt('chat.proposal.session.prepFailed', "Jenny couldn't prepare the new chat. You can try again.");
    }
  }

  function localAttentionDetail(error) {
    if (error.reason === 'dispatch_failed' || error.code === 'CMP-PROPOSAL-0011') return jt('chat.proposal.dispatchFailed', "Jenny couldn't start this. You can try again.");
    if (error.reason === 'unavailable' || error.code === 'CMP-PROPOSAL-0002') return jt('chat.proposal.runtimeUnavailable', "Jenny isn't available right now. You can try again.");
    return jt('chat.proposal.needsAttentionDetail', 'This needs your attention.');
  }

  function staleDetail() {
    return jt('chat.proposal.session.stale', 'The chat or project changed since Jenny proposed this. Ask for a fresh proposal.');
  }

  function localStatus(proposal, status) {
    const prefix = `${jt('chat.proposal.session.doItHere', 'Do it here')} · `;
    const word = (text) => `${prefix}${text}`;
    switch (proposal.action_state) {
      case 'waiting_for_source':
        return status('pending', word(jt('chat.proposal.session.waitingSource', 'Waiting for the current turn to finish')), '', { cancel: true });
      case 'admitted': return status('active', word(jt('chat.proposal.working', 'Jenny is working on it')), '', { running: true, cancel: true });
      case 'succeeded': return status('ok', word(jt('chat.proposal.turnFinished', 'Turn finished')), '', { replyLink: true });
      case 'failed': return status('error', word(jt('chat.proposal.turnFailed', 'Turn failed')), '', { replyLink: true });
      case 'cancelled': return status('muted', word(jt('chat.proposal.cancelled', 'Cancelled')));
      case 'needs_attention': {
        const error = asObject(proposal.last_error) || {};
        if (error.reason === 'authority_changed' || error.code === 'CMP-PROPOSAL-0007') return status('warn', word(jt('chat.proposal.outOfDate', 'Out of date')), staleDetail());
        return status('warn', word(jt('chat.proposal.needsAttention', 'Needs attention')), localAttentionDetail(error), { retry: true });
      }
      default:
        return status('pending', word(jt('chat.proposal.queued', 'Queued')), jt('chat.proposal.runsAfterTurn', 'Runs after the current turn'), { cancel: true, withdraw: true });
    }
  }

  function newSessionAttention(proposal, status, hasChild) {
    const error = asObject(proposal.last_error) || {};
    // A child whose first turn never started can also be cancelled, which lets it take ordinary sends.
    const child = { openChild: hasChild, retry: true, cancel: hasChild };
    if (error.reason === 'authority_changed' || error.code === 'CMP-PROPOSAL-0007') {
      return status('warn', jt('chat.proposal.outOfDate', 'Out of date'), staleDetail(), { openChild: hasChild, cancel: hasChild });
    }
    if (error.reason === 'preparation_failed' || error.code === 'CMP-PROPOSAL-0010') {
      return status('warn', jt('chat.proposal.session.prepFailedWord', "Couldn't prepare the new chat"), preparationDetail(error.cause_code), child);
    }
    if (error.reason === 'dispatch_failed' || error.code === 'CMP-PROPOSAL-0011') {
      return status('warn', jt('chat.proposal.session.startFailedWord', "Couldn't start the new chat"),
        hasChild ? jt('chat.proposal.session.startFailedChild', 'The new chat exists. You can try starting it again.') : localAttentionDetail(error), child);
    }
    if (error.reason === 'unavailable' || error.code === 'CMP-PROPOSAL-0002') {
      return status('warn', jt('chat.proposal.session.unavailableWord', "Background chats aren't available"),
        jt('chat.proposal.session.unavailableDetail', 'Nothing was started. Do it here still works.'), child);
    }
    return status('warn', jt('chat.proposal.needsAttention', 'Needs attention'), jt('chat.proposal.needsAttentionDetail', 'This needs your attention.'), child);
  }

  /** The closed table for kind session: every decision_state/action_state pair maps to one status; nothing else renders. */
  function deriveSessionStatus(proposal) {
    const status = (tone, word, detail, extra) => ({ tone, word, detail: detail || '', ...extra });
    switch (proposal.decision_state) {
      case 'dismissed': return status('muted', jt('chat.proposal.dismissed', 'Dismissed'), '', { plain: true });
      case 'expired': return status('muted', jt('chat.proposal.expired', 'Expired after 7 days'), '', { plain: true });
      case 'withdrawn': return status('muted', jt('chat.proposal.withdrawn', 'Withdrawn'), '', { plain: true });
      case 'stale': return status('warn', jt('chat.proposal.outOfDate', 'Out of date'), staleDetail(), { plain: true });
      case 'accepted': break;
      default: return null;
    }
    const decision = asObject(proposal.decision) || {};
    if (decision.choice === 'do_it_here') return localStatus(proposal, status);
    const display = asObject(proposal.display) || {};
    const links = asObject(proposal.links) || {};
    const hasChild = Boolean(links.child_session_id);
    switch (proposal.action_state) {
      case 'waiting_for_source':
        return status('pending', jt('chat.proposal.session.waitingSource', 'Waiting for the current turn to finish'), '', { cancel: true });
      case 'preparing':
        return status('active', jt('chat.proposal.session.preparing', 'Preparing the new chat…'), '', { running: true, cancel: true });
      case 'child_created':
      case 'admitted':
        return status('active', jt('chat.proposal.session.starting', 'Starting the new chat…'), '', { running: true, openChild: hasChild });
      case 'succeeded':
        return status('ok', jt('chat.proposal.session.started', 'Started · {title}', { title: String(display.title || '') }), '', { openChild: hasChild });
      case 'failed': return status('error', jt('chat.proposal.session.startFailedWord', "Couldn't start the new chat"), '', { openChild: hasChild });
      case 'cancelled': return status('muted', jt('chat.proposal.cancelled', 'Cancelled'));
      case 'needs_attention': return newSessionAttention(proposal, status, hasChild);
      default:
        return status('pending', jt('chat.proposal.queued', 'Queued'), jt('chat.proposal.runsAfterTurn', 'Runs after the current turn'), { cancel: true, withdraw: true });
    }
  }

  // ---- Options --------------------------------------------------------------------

  const MODE_LABELS = () => ({ agent: jt('chat.proposal.session.modeAgent', 'Agent'), plan: jt('chat.proposal.session.modePlan', 'Plan') });

  function withCurrent(list, current, fallbackLabel) {
    return list.some((entry) => entry.value === current) ? list : [...list, { value: current, label: fallbackLabel }];
  }

  function optionLists(caps, options) {
    const automatic = jt('chat.proposal.session.automatic', 'Automatic');
    const destinations = caps.destinations.filter((d) => asObject(d) && typeof d.label === 'string')
      .map((d) => ({ value: typeof d.project_id === 'string' ? d.project_id : '', label: d.label, disabled: d.available === false }));
    const models = [{ value: '', label: automatic }, ...caps.models.filter((m) => asObject(m) && typeof m.id === 'string')
      .map((m) => ({ value: m.id, label: typeof m.label === 'string' && m.label ? m.label : m.id }))];
    const efforts = [{ value: '', label: automatic }, ...caps.reasoning_efforts.filter((e) => typeof e === 'string').map((e) => ({ value: e, label: e }))];
    const dest = typeof options.destination_project_id === 'string' ? options.destination_project_id : '';
    return {
      destinations: withCurrent(destinations, dest, jt('chat.proposal.session.currentProject', 'Current project')),
      models: withCurrent(models, options.preferred_model || '', options.preferred_model || automatic),
      efforts: withCurrent(efforts, options.reasoning_effort || '', options.reasoning_effort || automatic),
    };
  }

  function optionsSummary(h, options, lookup) {
    const modes = MODE_LABELS();
    const parts = [];
    const caps = lookup.capabilities && lookup.capabilities.status === 'ready' ? lookup.capabilities.value : null;
    if (caps) {
      const lists = optionLists(caps, options);
      const pick = (list, value) => (list.find((entry) => entry.value === value) || {}).label;
      const dest = pick(lists.destinations, options.destination_project_id || '');
      if (dest) parts.push(dest);
      if (options.preferred_model) parts.push(pick(lists.models, options.preferred_model));
      if (options.reasoning_effort) parts.push(pick(lists.efforts, options.reasoning_effort));
    }
    parts.push(modes[options.run_mode] || modes.agent);
    return `<span class="proposal-options-summary">${h.escapeHtml(parts.filter(Boolean).join(' · '))}</span>`;
  }

  function optionsBody(h, proposal, lookup, idBase, disabled) {
    const { escapeHtml } = h;
    const capsState = lookup.capabilities || { status: 'idle', value: null };
    const caps = capsState.value;
    const note = (text) => `<p class="proposal-options-note">${escapeHtml(text)}</p>`;
    if (!caps || capsState.status === 'error' || caps.unavailable_reason) {
      return capsState.status === 'loading' || capsState.status === 'idle'
        ? note(jt('chat.proposal.session.optionsLoading', 'Loading options…'))
        : note(jt('chat.proposal.session.optionsUnavailable', "Options aren't available right now."));
    }
    const options = proposal.options || {};
    const lists = optionLists(caps, options);
    const select = inventoryPrimitive('selectField', '../inventory/select-field');
    const segmented = inventoryPrimitive('segmentedControl', '../inventory/segmented-control');
    if (!select) return '';
    const locked = disabled || capsState.status === 'loading';
    const field = (key, label, list, value) => select({
      id: `${idBase}-${key}`, label, value, options: list, disabled: locked, dataset: { 'proposal-option': key },
    });
    const modes = MODE_LABELS();
    const runModes = caps.run_modes.filter((mode) => modes[mode]);
    const modeControl = runModes.length >= 2 && segmented
      ? segmented({
        ariaLabel: jt('chat.proposal.session.mode', 'Mode'), value: options.run_mode, disabled: locked,
        options: runModes.map((mode) => ({ value: mode, label: modes[mode] })), dataset: { 'proposal-option': 'run_mode' },
      })
      : `<span class="proposal-options-value">${escapeHtml(modes[runModes[0]] || modes[options.run_mode] || modes.agent)}</span>`;
    return field('destination', jt('chat.proposal.session.project', 'Project'), lists.destinations, options.destination_project_id || '')
      + field('model', jt('chat.proposal.session.model', 'Model'), lists.models, options.preferred_model || '')
      + field('effort', jt('chat.proposal.session.effort', 'Effort'), lists.efforts, options.reasoning_effort || '')
      + `<div class="proposal-options-row"><span class="proposal-options-label">${escapeHtml(jt('chat.proposal.session.mode', 'Mode'))}</span>${modeControl}</div>`
      + `<p class="proposal-options-note">${escapeHtml(jt('chat.proposal.session.optionsFootnote', "Permissions follow this chat and can't be raised here."))}</p>`;
  }

  /** Options toggle, its summary and the popover (kept open by lookup.optionsOpen across re-renders). */
  function optionsMarkup(h, ctx, proposal) {
    if (!proposal || proposal.decision_state !== 'pending' || !asObject(proposal.options)) return '';
    const popover = inventoryPrimitive('popover', '../inventory/popover');
    if (!popover) return '';
    const lookup = ctx.lookup;
    const idBase = `proposal-options-${String(ctx.proposalId).replace(/^proposal_/, '').slice(0, 12)}`;
    const open = lookup.optionsOpen === true;
    const editable = proposal.options_editable === true;
    const shell = popover({
      domId: idBase, className: 'proposal-options-popover', ariaLabel: jt('chat.proposal.session.optionsAria', 'Options for this new chat'),
      trustedHtml: optionsBody(h, proposal, lookup, idBase, !editable || lookup.busy),
    });
    const toggle = h.actionButton({
      plain: true, className: 'proposal-link proposal-options-toggle', label: jt('chat.proposal.session.options', 'Options'),
      title: jt('chat.proposal.session.optionsTitle', 'Choose project, model, effort and mode for the new chat'),
      ariaHaspopup: 'dialog', ariaExpanded: open, ariaControls: idBase, disabled: !editable, dataset: { 'proposal-action': 'options' },
    });
    // The popover primitive renders hidden; an open one (state held in the store) drops the attribute.
    const body = open ? shell.replace(' hidden>', '>') : shell;
    return `<div class="proposal-options">${toggle}${optionsSummary(h, proposal.options, lookup)}${body}</div>`;
  }

  // ---- markup ---------------------------------------------------------------------

  function blockedLine(h, proposal) {
    const actions = proposal.actions || {};
    const newBlocked = actions.new_session && !actions.new_session.available && actions.new_session.reason;
    const localBlocked = actions.do_it_here && !actions.do_it_here.available && actions.do_it_here.reason;
    if (!newBlocked && !localBlocked) return '';
    const localOk = Boolean(actions.do_it_here && actions.do_it_here.available);
    if (newBlocked === 'unsupported_capability') {
      return h.simpleStatus(h, 'muted', jt('chat.proposal.err.unsupportedSession', "Starting a separate chat isn't available here."),
        localOk ? jt('chat.proposal.session.doItHereStillWorks', 'Do it here still works.') : jt('chat.proposal.dismissStill', 'You can still dismiss this.'));
    }
    const label = newBlocked ? jt('chat.proposal.session.newSession', 'New session') : jt('chat.proposal.session.doItHere', 'Do it here');
    return h.simpleStatus(h, 'muted', jt('chat.proposal.choiceUnavailable', "{choice} isn't available right now.", { choice: label }),
      jt('chat.proposal.dismissStill', 'You can still dismiss this.'));
  }

  function groupHeader(h, ctx) {
    const proposal = ctx.lookup.proposal;
    const group = ctx.lookup.group;
    if (!suggestionGroup || !proposal || !proposal.group_id || !group || !suggestionGroup.isFirstMember(group, ctx.proposalId)) return '';
    return suggestionGroup.headerMarkup(h, { sessionId: ctx.sessionId, groupId: proposal.group_id, group, now: Date.now() });
  }

  function choiceButtons(h, ctx, proposal, suggestion, can) {
    const title = String((asObject(proposal && proposal.display) || ctx.lookup.fallback || {}).title || '');
    const button = (action, label, variant, aria) => {
      // A restored record's choices say why they are off; a row's accessible name still carries its task title.
      const why = h.restoredChoiceTitle(proposal && proposal.actions, action);
      return h.actionButton({
        variant, size: 'sm', label, disabled: !can(action), dataset: { 'proposal-action': action },
        // Rows repeat the same words: the accessible name carries the task title (and a matching title attribute).
        ...(aria ? { ariaLabel: aria, title: aria } : {}),
        ...(why ? { title: why } : {}),
      });
    };
    if (suggestion) {
      return button('do_it_here', jt('chat.proposal.session.doItHere', 'Do it here'), 'ghost', jt('chat.proposal.session.doItHereAria', 'Do {title} here in this chat', { title }))
        + button('new_session', jt('chat.proposal.session.start', 'Start'), 'secondary', jt('chat.proposal.session.startAria', 'Start {title} in a new chat', { title }));
    }
    return button('do_it_here', jt('chat.proposal.session.doItHere', 'Do it here'), 'secondary', '')
      + button('new_session', jt('chat.proposal.session.newSession', 'New session'), 'secondary', '');
  }

  function titleMarkup(h, display) {
    const description = typeof display.description === 'string' && display.description
      ? `<p class="proposal-session-desc">${h.escapeHtml(display.description)}</p>` : '';
    return `<p class="proposal-session-title">${h.escapeHtml(String(display.title || ''))}</p>${description}`;
  }

  /** ctx: {sessionId, proposalId, lookup}; the card for kind session (offer tray, suggestion row or receipt). */
  function buildSessionMarkup(h, ctx) {
    const { escapeHtml } = h;
    const lookup = ctx.lookup;
    const proposal = lookup.proposal;
    const display = proposal ? (asObject(proposal.display) || {}) : (lookup.fallback || {});
    const suggestion = display.initiation === 'own_initiative';
    const view = { ...ctx, ariaLabel: suggestion ? jt('chat.proposal.session.suggestionAria', 'Suggested task') : jt('chat.proposal.session.offerAria', 'Offer to start a new chat') };
    if (lookup.status === 'not_found') return h.goneMarkup(h, view, 'session');
    if (typeof display.title !== 'string' || !display.title) {
      return `${h.cardOpen(h, view, 'session', lookup.status, 'proposal-receipt')}${h.lookupStatus(h, lookup)}</section>`;
    }
    const state = proposal ? proposal.decision_state : lookup.status;
    const status = proposal ? h.restoreStatus(proposal, deriveSessionStatus(proposal)) : null;
    const head = groupHeader(h, ctx);
    const rowClass = suggestion ? ' proposal-suggestion' : '';
    if (status) {
      const statusView = { ...status, links: proposal.links, cancelAvailable: proposal.actions.cancel && proposal.actions.cancel.available,
        retryAvailable: proposal.actions.retry && proposal.actions.retry.available, elapsed: status.running ? h.elapsedMarkup(h, proposal) : '' };
      return `${h.cardOpen(h, view, 'session', state, `proposal-receipt${rowClass}`)}${head}`
        + `${suggestion ? '' : '<span class="user-questions-receipt-rule"></span>'}`
        + `<p class="proposal-session-title">${escapeHtml(display.title)}</p>`
        + `${h.statusLineMarkup(h, statusView)}${h.noticeMarkup(h, lookup.notice)}</section>`;
    }
    const pending = state === 'pending';
    const actions = proposal ? proposal.actions : {};
    // A row is locked while its own request or its group's Start all is in flight.
    const can = (name) => pending && !lookup.busy && !(lookup.group && lookup.group.busy) && Boolean(actions[name] && actions[name].available);
    const eyebrow = suggestion ? ''
      : `<div class="user-questions-header" aria-hidden="true"><span class="user-questions-eyebrow">${escapeHtml(jt('chat.proposal.session.offerEyebrow', 'Start this in its own session?'))}</span><span class="user-questions-rule"></span></div>`;
    const authNote = pending && display.authorization_required === true
      ? `<p class="proposal-session-note">${escapeHtml(jt('chat.proposal.session.authorizationNote', 'You asked for a separate chat, but it was not authorized, so here is the choice.'))}</p>` : '';
    let tail = '';
    if (!proposal) tail = h.lookupStatus(h, lookup);
    else if (pending) tail = h.restoreInfo(proposal) ? h.restoredPendingLine(h, proposal) : blockedLine(h, proposal);
    const dismiss = pending || !proposal ? h.dismissButton(h, !can('dismiss')) : '';
    return `${h.cardOpen(h, view, 'session', state, suggestion ? 'proposal-suggestion' : ['proposal-decision', 'proposal-session-offer'].join(' '))}${head}${eyebrow}`
      + `${titleMarkup(h, display)}${authNote}`
      + `<div class="proposal-actions">${optionsMarkup(h, ctx, proposal)}<div class="proposal-choices">${choiceButtons(h, ctx, proposal, suggestion, can)}</div></div>`
      + `${dismiss}${tail}${h.noticeMarkup(h, lookup.notice)}</section>`;
  }

  return { buildSessionMarkup, deriveSessionStatus };
});
