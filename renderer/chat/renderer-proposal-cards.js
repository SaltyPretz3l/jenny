(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProposalCards = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // Pure markup for the inline Git decision tray, the command card (row 59
  // checkpoint 3) and the session offer/suggestion cards (checkpoint 5a-2, delegated to
  // renderer-proposal-session-cards.js). The card draws only the record's projection (see
  // renderer-proposal-card-store.js); the tool result merely names the proposal.
  // Nothing here executes anything: every button carries data-proposal-action
  // and only the bound click handler (renderer-proposal-card-actions.js) acts.
  // A record parked by a trusted archive restore (actions.confirm_restored present, cp5b-3) shows one attention
  // line and a Confirm control; a restored command stays inert (Copy only, a fresh proposal is needed).
  const TOOL_KINDS = Object.freeze({ propose_git_action: 'git', propose_command: 'command', propose_session: 'session' });
  const RESULT_KINDS = Object.freeze({ git_proposal: 'git', command_proposal: 'command', session_proposal: 'session' });
  const PROPOSAL_ID_PATTERN = /^proposal_[a-f0-9]{64}$/;
  const EMPTY_LOOKUP = Object.freeze({ status: 'unavailable', proposal: null, notice: null, busy: false, acks: [], fallback: null });

  const X_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const RUN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M5 3.2v9.6a.5.5 0 0 0 .76.43l7.6-4.8a.5.5 0 0 0 0-.86l-7.6-4.8A.5.5 0 0 0 5 3.2z"/></svg>';

  const requireOptional = (path) => {
    if (typeof require !== 'function') return null;
    try { return require(path); } catch (_error) { return null; }
  };
  const suggestionGroup = (typeof globalThis !== 'undefined' && globalThis.rendererProposalSuggestionGroup)
    || requireOptional('./renderer-proposal-suggestion-group');
  const sessionCards = (typeof globalThis !== 'undefined' && globalThis.rendererProposalSessionCards)
    || requireOptional('./renderer-proposal-session-cards');

  function resolveDeps(deps) {
    const d = deps || {};
    const inv = globalThis.inventory || {};
    const checkboxModule = inv.checkbox || requireOptional('../inventory/checkbox');
    const codeModule = inv.codeBlock || requireOptional('../inventory/codeblock');
    return {
      escapeHtml: typeof d.escapeHtml === 'function' ? d.escapeHtml
        : ((globalThis.stringUtils || requireOptional('../shared/string-utils') || {}).escapeHtml),
      actionButton: d.actionButton || globalThis.inventoryActionButton || inv.actionButton || requireOptional('../inventory/action-button'),
      checkbox: d.checkbox || (typeof checkboxModule === 'function' ? checkboxModule : checkboxModule && checkboxModule.checkbox),
      codeblock: d.codeblock || (codeModule && codeModule.codeblock),
      // Row 76: the offer card's "Always allow" row appears only for the primary chat (default: never).
      isPrimarySession: typeof d.isPrimarySession === 'function' ? d.isPrimarySession : () => false,
      launchPermissionEnabled: d.launchPermissionEnabled !== false,
    };
  }

  // ---- identity -------------------------------------------------------------------

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function parseInput(row) {
    const payload = asObject(row && row.payload) || {};
    const direct = asObject(payload.input);
    if (direct && Object.keys(direct).length) return direct;
    const raw = String(payload.input_json || '').trim();
    if (raw.startsWith('{')) {
      try { return asObject(JSON.parse(raw)) || {}; } catch (_error) { return {}; }
    }
    return direct || {};
  }

  function findResultMetadata(row, pairedRow, messages) {
    const fromPaired = asObject(asObject(pairedRow && pairedRow.payload) && pairedRow.payload.metadata);
    if (fromPaired) return fromPaired;
    const resultMessageId = String(pairedRow && pairedRow.primary_message_id || '').trim();
    if (resultMessageId && Array.isArray(messages)) {
      const resultMessage = messages.find((message) => message && String(message.id || '').trim() === resultMessageId);
      const stored = asObject(asObject(resultMessage && resultMessage.tool_result) && resultMessage.tool_result.metadata);
      if (stored) return stored;
    }
    const own = asObject(asObject(row && row.payload) && row.payload.metadata);
    if (own) return own;
    const callId = String(row && (row.tool_call_id || (row.payload && row.payload.tool_call_id)) || '').trim();
    if (!callId || !Array.isArray(messages)) return null;
    for (const message of messages) {
      const result = asObject(message && message.tool_result);
      if (!result) continue;
      const id = String(result.call_id || result.tool_call_id || '').trim();
      if (id === callId) return asObject(result.metadata);
    }
    return null;
  }

  /** {proposalId, kind} when the tool row is a paired proposal result, else null. */
  function resolveProposalIdentity(row, pairedRow, messages) {
    const payload = asObject(row && row.payload) || {};
    const toolKind = TOOL_KINDS[String(payload.tool_name || '').trim()];
    if (!toolKind) return null;
    const meta = findResultMetadata(row, pairedRow, messages);
    const resultKind = RESULT_KINDS[String(meta && meta.result_kind || '')];
    const proposalId = String(meta && meta.proposal_id || '');
    if (!meta || resultKind !== toolKind || !PROPOSAL_ID_PATTERN.test(proposalId)) return null;
    return { proposalId, kind: toolKind };
  }

  // ---- copy -----------------------------------------------------------------------

  function choiceLabel(choice) {
    return choice === 'test_first' ? jt('chat.proposal.testFirst', 'Test first') : jt('chat.proposal.commit', 'Commit');
  }

  const RUN_UNAVAILABLE = () => ({
    plan_mode: jt('chat.proposal.runPlanMode', "Run isn't available in Plan mode."),
    read_only: jt('chat.proposal.runReadOnly', "Run isn't available in a read-only chat."),
    unsupported_capability: jt('chat.proposal.runUnsupported', "Run isn't available yet."),
    lockdown: jt('chat.proposal.runLockdown', "Run isn't available while this chat is in offline lockdown."),
  });

  function choiceUnavailableText(action, reason) {
    const label = action === 'test_first' ? jt('chat.proposal.testFirst', 'Test first') : jt('chat.proposal.commit', 'Commit');
    if (reason === 'plan_mode') return jt('chat.proposal.choicePlanMode', "{choice} isn't available in Plan mode.", { choice: label });
    if (reason === 'read_only') return jt('chat.proposal.choiceReadOnly', "{choice} isn't available in a read-only chat.", { choice: label });
    if (reason === 'authorization_required') return jt('chat.proposal.choiceRestored', '{choice} needs your confirmation first.', { choice: label });
    return jt('chat.proposal.choiceUnavailable', "{choice} isn't available right now.", { choice: label });
  }

  // ---- archive-restore confirmation (cp5b-3) --------------------------------------------

  /** {available, command, parked} for a restored record still awaiting the user, else null. */
  function restoreInfo(proposal) {
    const actions = asObject(proposal && proposal.actions);
    const confirm = actions && asObject(actions.confirm_restored);
    if (!confirm) return null;
    const parked = proposal.decision_state === 'accepted' && proposal.action_state === 'needs_attention';
    if (proposal.decision_state !== 'pending' && !parked) return null;
    return { available: confirm.available === true, command: proposal.kind === 'command', parked };
  }

  const restoredDetail = (command) => (command
    ? jt('chat.proposal.restoredCommand', "Restored command proposals can't run. Ask for a fresh proposal.")
    : jt('chat.proposal.restoredAttention', 'Restored from a backup. Confirm before anything runs.'));

  /** A parked (accepted) status keeps its word and gains the restore detail and the Confirm control; Retry never stands in for it. */
  function restoreStatus(proposal, status) {
    const info = restoreInfo(proposal);
    if (!info || !info.parked || !status) return status;
    return { ...status, tone: 'warn', detail: restoredDetail(info.command), retry: false, confirm: !info.command, confirmAvailable: info.available };
  }

  /** The attention line of a pending restored record: the reason, and Confirm when the record allows it. */
  function restoredPendingLine(deps, proposal) {
    const info = restoreInfo(proposal);
    if (!info) return '';
    if (info.command) {
      return statusLineMarkup(deps, { tone: 'muted', word: restoredDetail(true), detail: jt('chat.proposal.copyStillWorks', 'Copy still works.') });
    }
    return statusLineMarkup(deps, {
      tone: 'warn', word: jt('chat.proposal.restoredWord', 'Restored from a backup'), detail: jt('chat.proposal.restoredConfirm', 'Confirm before anything runs.'),
      confirm: true, confirmAvailable: info.available,
    });
  }

  /** Why a choice is off for a restored record (a hover/accessible title), else ''. */
  function restoredChoiceTitle(actions, name) {
    const action = asObject(actions && actions[name]);
    return action && action.available === false && action.reason === 'authorization_required'
      ? jt('chat.proposal.restoredChoiceTitle', 'Confirm this restored proposal first.') : '';
  }

  function attentionDetail(kind, lastError) {
    const error = asObject(lastError) || {};
    if (error.reason === 'authority_changed' || error.code === 'CMP-PROPOSAL-0007') return staleDetail(kind);
    if (error.reason === 'outcome_unknown' || error.code === 'CMP-PROPOSAL-0012') return unknownDetail(error.cause_code);
    if (error.reason === 'dispatch_failed' || error.code === 'CMP-PROPOSAL-0011') {
      return jt('chat.proposal.dispatchFailed', "Jenny couldn't start this. You can try again.");
    }
    if (error.reason === 'unavailable' || error.code === 'CMP-PROPOSAL-0002') {
      return jt('chat.proposal.runtimeUnavailable', "Jenny isn't available right now. You can try again.");
    }
    return jt('chat.proposal.needsAttentionDetail', 'This needs your attention.');
  }

  // The unknown-outcome detail names what actually happened (last_error.cause_code).
  function unknownDetail(causeCode) {
    switch (causeCode) {
      case 'restart':
        return jt('chat.proposal.outcomeUnknown', 'Jenny restarted while this ran. Check the result before trying again.');
      case 'cleanup_uncertain':
        return jt('chat.proposal.unknownCleanup', "Jenny couldn't confirm the process stopped. Check the result before trying again.");
      case 'dispatch_unconfirmed':
        return jt('chat.proposal.unknownDispatch', "Jenny couldn't confirm this started. Check the result before trying again.");
      default:
        return jt('chat.proposal.unknownInterrupted', 'This stopped before Jenny could confirm how it ended. Check the result before trying again.');
    }
  }

  function staleDetail(kind) {
    return kind === 'command'
      ? jt('chat.proposal.staleCommand', 'The folder or shell changed since this was proposed.')
      : jt('chat.proposal.staleGit', 'The branch or these files changed since Jenny proposed this. Ask for a fresh proposal.');
  }

  /** The closed table: every decision_state/action_state pair maps to one status; nothing outside it renders. */
  function deriveStatus(proposal) {
    return restoreStatus(proposal, deriveBaseStatus(proposal));
  }

  function deriveBaseStatus(proposal) {
    const kind = proposal.kind;
    if (kind === 'session') return sessionCards ? sessionCards.deriveSessionStatus(proposal) : null;
    const decision = asObject(proposal.decision) || {};
    const prefix = kind === 'git' && decision.choice ? `${choiceLabel(decision.choice)} · ` : '';
    const status = (tone, word, detail, extra) => ({ tone, word: `${prefix}${word}`.trim(), detail: detail || '', ...extra });
    switch (proposal.decision_state) {
      case 'dismissed': return status('muted', jt('chat.proposal.dismissed', 'Dismissed'), '', { plain: true });
      case 'expired': return status('muted', jt('chat.proposal.expired', 'Expired after 7 days'), '', { plain: true });
      case 'withdrawn': return status('muted', jt('chat.proposal.withdrawn', 'Withdrawn'), '', { plain: true });
      case 'stale': return status('warn', jt('chat.proposal.outOfDate', 'Out of date'), staleDetail(kind), { plain: true });
      case 'accepted': break;
      default: return null;
    }
    const execution = asObject(proposal.execution);
    const links = asObject(proposal.links) || {};
    if (kind === 'command') return commandStatus(proposal, execution, links, status);
    switch (proposal.action_state) {
      case 'admitted':
        return status('active', jt('chat.proposal.working', 'Jenny is working on it'), '', { running: true, cancel: true });
      case 'succeeded':
        return status('ok', jt('chat.proposal.turnFinished', 'Turn finished'),
          decision.choice === 'test_first' ? jt('chat.proposal.noCommitRequested', 'No commit was requested.') : '', { replyLink: true });
      case 'failed': return status('error', jt('chat.proposal.turnFailed', 'Turn failed'), '', { replyLink: true });
      case 'cancelled': return status('muted', jt('chat.proposal.cancelled', 'Cancelled'));
      case 'needs_attention':
        return status('warn', jt('chat.proposal.needsAttention', 'Needs attention'), attentionDetail(kind, proposal.last_error), { retry: true });
      default: // none, waiting_for_source, queued, preparing, child_created
        return status('pending', jt('chat.proposal.queued', 'Queued'), jt('chat.proposal.runsAfterTurn', 'Runs after the current turn'), { cancel: true, withdraw: true });
    }
  }

  function commandStatus(proposal, execution, links, status) {
    const state = String(execution && execution.status || '');
    const output = Boolean(links.command_tool_call_id);
    const exitCode = execution && Number.isInteger(execution.exit_code) ? execution.exit_code : null;
    // `denied` covers both a user denial and a policy block: name neither.
    if (state === 'denied') return status('muted', jt('chat.proposal.notApproved', 'Not approved. Nothing ran.'));
    if (state === 'cancelled') {
      return status('muted', execution.cleanup === 'uncertain'
        ? jt('chat.proposal.cancelledUncertain', 'Cancelled · cleanup not confirmed')
        : jt('chat.proposal.cancelledStopped', 'Cancelled · process stopped'), '', { output });
    }
    if (state === 'running') return status('active', jt('chat.proposal.running', 'Running'), '', { running: true, output, cancel: true });
    // The sidecar judged success against expected_exit_codes; the exit code is shown, never re-judged.
    if (state === 'succeeded' || state === 'failed') {
      const tone = state === 'failed' ? 'error' : 'ok';
      if (exitCode != null) return status(tone, jt('chat.proposal.exited', 'Exited {code}', { code: exitCode }), '', { output });
      return state === 'failed'
        ? status('error', jt('chat.proposal.didNotComplete', "Didn't complete"), jt('chat.proposal.noExitCode', 'No exit code was reported.'), { output })
        : status('ok', jt('chat.proposal.done', 'Done'), '', { output });
    }
    if (state === 'interrupted_unknown' || proposal.action_state === 'needs_attention') {
      const error = asObject(proposal.last_error) || {};
      const unknown = error.reason === 'outcome_unknown' || error.code === 'CMP-PROPOSAL-0012' || state === 'interrupted_unknown';
      if (unknown) {
        return status('warn', jt('chat.proposal.interrupted', 'Interrupted · outcome unknown'), unknownDetail(error.cause_code), { output });
      }
      return status('warn', jt('chat.proposal.needsAttention', 'Needs attention'), attentionDetail('command', proposal.last_error), { output });
    }
    if (proposal.action_state === 'admitted' || state === 'awaiting_approval') {
      return status('warn', jt('chat.proposal.waitingApproval', 'Waiting for your approval'), '', { review: Boolean(links.command_tool_call_id) });
    }
    if (proposal.action_state === 'succeeded') return status('ok', jt('chat.proposal.done', 'Done'), '', { output });
    if (proposal.action_state === 'failed') return status('error', jt('chat.proposal.failed', 'Failed'), '', { output });
    if (proposal.action_state === 'cancelled') return status('muted', jt('chat.proposal.cancelledStopped', 'Cancelled · process stopped'));
    return status('pending', jt('chat.proposal.queued', 'Queued'), '', { cancel: true, withdraw: true });
  }

  // ---- markup ---------------------------------------------------------------------

  function dotClass(tone) {
    return { ok: 'status-dot--ok', warn: 'status-dot--warn', error: 'status-dot--error', active: 'status-dot--active', pending: 'status-dot--pending' }[tone] || 'status-dot--muted';
  }

  function linkButton(deps, action, label, extra) {
    return deps.actionButton({
      plain: true, className: 'proposal-link', label,
      dataset: { 'proposal-action': action, ...(extra || {}) },
    });
  }

  function elapsedMarkup(deps, proposal, startedAt) {
    const accepted = Date.parse(String(startedAt || (asObject(proposal.decision) && proposal.decision.accepted_at) || ''));
    if (!Number.isFinite(accepted)) return '';
    const total = Math.max(0, Math.floor((Date.now() - accepted) / 1000));
    const label = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    return `<span class="proposal-elapsed" aria-hidden="true" data-turn-elapsed="true" data-elapsed-started-at="${accepted}" data-elapsed-running="true">${deps.escapeHtml(label)}</span>`;
  }

  /** One grammar for every receipt: dot + state word + detail. Not a live region: a patch replaces
   *  the card, so state changes are announced through the shared announcer (card actions). */
  function statusLineMarkup(deps, view) {
    const { escapeHtml } = deps;
    const links = view.links || {};
    let controls = '';
    if (view.cancel && view.cancelAvailable) {
      controls += linkButton(deps, 'cancel', view.withdraw ? jt('chat.proposal.withdraw', 'Withdraw') : jt('chat.proposal.cancel', 'Cancel'));
    }
    if (view.retry && view.retryAvailable) controls += linkButton(deps, 'retry', jt('chat.proposal.retry', 'Retry'));
    if (view.retryChild && links.child_session_id) {
      controls += linkButton(deps, 'retry-child', jt('chat.proposal.retry', 'Retry'), { 'proposal-child-id': links.child_session_id, 'proposal-message-id': view.retryChild });
    }
    if (view.confirm && view.confirmAvailable) {
      controls += deps.actionButton({
        plain: true, className: 'proposal-link', label: jt('chat.proposal.confirmRestored', 'Confirm'),
        ariaLabel: jt('chat.proposal.confirmRestoredAria', 'Confirm this restored proposal'),
        title: jt('chat.proposal.confirmRestoredAria', 'Confirm this restored proposal'), dataset: { 'proposal-action': 'confirm-restored' },
      });
    }
    if (view.openChild && links.child_session_id) {
      controls += linkButton(deps, 'open-child', jt('chat.proposal.session.open', 'Open'), { 'proposal-child-id': links.child_session_id });
    }
    const replyTurnId = view.replyTurnId || (view.replyLink && links.continuation_turn_id) || '';
    if (replyTurnId) controls += linkButton(deps, 'jump-reply', jt('chat.proposal.seeReply', 'See the reply'), { 'proposal-turn-id': replyTurnId });
    if (view.output && links.command_tool_call_id) {
      controls += linkButton(deps, 'jump-tool', jt('chat.proposal.viewOutput', 'View output'), { 'proposal-tool-call-id': links.command_tool_call_id });
    }
    if (view.review && links.command_tool_call_id) {
      controls += linkButton(deps, 'jump-tool', jt('chat.proposal.review', 'Review'), { 'proposal-tool-call-id': links.command_tool_call_id });
    }
    return `<div class="proposal-status" data-tone="${escapeHtml(view.tone)}" tabindex="-1"`
      + `${view.running ? ' data-running="true"' : ''}>`
      + `<span class="status-dot ${dotClass(view.tone)}" aria-hidden="true"></span>`
      + `<span class="proposal-state">${escapeHtml(view.word)}</span>`
      + `${view.detail ? `<span class="proposal-detail">${escapeHtml(view.detail)}</span>` : ''}`
      + `${view.elapsed || ''}${controls}</div>`;
  }

  function dismissButton(deps, disabled) {
    return deps.actionButton({
      variant: 'ghost', size: 'sm', className: 'proposal-dismiss', trustedHtml: X_ICON, disabled,
      ariaLabel: jt('chat.proposal.dismissAria', 'Dismiss this proposal'),
      title: jt('chat.proposal.dismissAria', 'Dismiss this proposal'),
      dataset: { 'proposal-action': 'dismiss' },
    });
  }

  function cardOpen(deps, ctx, kind, state, extraClass) {
    const { escapeHtml } = deps;
    const busy = ctx.lookup.busy || ctx.lookup.status === 'checking';
    return `<section class="proposal-card ${extraClass}" role="group" data-proposal-id="${escapeHtml(ctx.proposalId)}"`
      + ` data-proposal-session="${escapeHtml(ctx.sessionId)}" data-proposal-kind="${kind}" data-proposal-state="${escapeHtml(state)}"`
      + `${busy ? ' aria-busy="true"' : ''}`
      + ` aria-label="${escapeHtml(ctx.ariaLabel || (kind === 'command' ? jt('chat.proposal.commandAria', 'Proposed command') : jt('chat.proposal.gitAria', 'Proposed commit')))}">`;
  }

  function simpleStatus(deps, tone, word, detail) {
    return statusLineMarkup(deps, { tone, word, detail });
  }

  function lookupStatus(deps, lookup) {
    if (lookup.status === 'checking') return simpleStatus(deps, 'pending', jt('chat.proposal.checking', 'Checking…'));
    if (lookup.status === 'unavailable') {
      return simpleStatus(deps, 'muted', jt('chat.proposal.cannotCheck', "Can't check this proposal right now."));
    }
    return '';
  }

  function noticeMarkup(deps, notice) {
    const text = notice && typeof notice.text === 'string' ? notice.text : '';
    return text ? `<p class="proposal-notice" role="status" aria-live="polite">${deps.escapeHtml(text)}</p>` : '';
  }

  // ---- Git tray -------------------------------------------------------------------

  function pathsDisclosure(deps, display) {
    const paths = Array.isArray(display.paths) ? display.paths : [];
    const count = Number.isSafeInteger(display.path_count) ? display.path_count : paths.length;
    if (!count && !paths.length) return '';
    const label = jtn('chat.proposal.fileCount', count, { count }, '{count} file', '{count} files');
    const items = paths.map((path) => `<li><code>${deps.escapeHtml(path)}</code></li>`).join('');
    return `<details class="proposal-scope"><summary>${deps.escapeHtml(label)}</summary><ul class="proposal-paths">${items}</ul></details>`;
  }

  const choiceTitle = (actions, name) => {
    const title = restoredChoiceTitle(actions, name);
    return title ? { title } : {};
  };

  function gitMarkup(deps, ctx) {
    const { escapeHtml } = deps;
    const lookup = ctx.lookup;
    const proposal = lookup.proposal;
    if (lookup.status === 'not_found') return goneMarkup(deps, ctx, 'git');
    const display = proposal ? (asObject(proposal.display) || {}) : (lookup.fallback || {});
    const state = proposal ? proposal.decision_state : lookup.status;
    const status = proposal ? deriveStatus(proposal) : null;
    const eyebrow = `<div class="user-questions-header" aria-hidden="true"><span class="user-questions-eyebrow">${escapeHtml(jt('chat.proposal.readyToCommit', 'Ready to commit'))}</span><span class="user-questions-rule"></span></div>`;
    const question = display.question ? `<p class="proposal-question">${escapeHtml(display.question)}</p>` : '';
    const settled = Boolean(status) && state !== 'stale';
    if (settled) {
      const view = { ...status, links: proposal.links, cancelAvailable: proposal.actions.cancel && proposal.actions.cancel.available,
        retryAvailable: proposal.actions.retry && proposal.actions.retry.available,
        elapsed: status.running ? elapsedMarkup(deps, proposal) : '' };
      return `${cardOpen(deps, ctx, 'git', state, 'proposal-receipt')}<span class="user-questions-receipt-rule"></span>${question}`
        + `${statusLineMarkup(deps, view)}${noticeMarkup(deps, lookup.notice)}</section>`;
    }
    const pending = state === 'pending';
    const actions = proposal ? proposal.actions : {};
    const can = (name) => pending && !lookup.busy && Boolean(actions[name] && actions[name].available);
    const summary = display.summary ? `<p class="proposal-summary">${escapeHtml(display.summary)}</p>` : '';
    const buttons = !proposal || pending
      ? deps.actionButton({ variant: 'primary', size: 'sm', label: jt('chat.proposal.commit', 'Commit'), disabled: !can('commit'), dataset: { 'proposal-action': 'commit' }, ...choiceTitle(actions, 'commit') })
        + deps.actionButton({ variant: 'secondary', size: 'sm', label: jt('chat.proposal.testFirst', 'Test first'), disabled: !can('test_first'), dataset: { 'proposal-action': 'test_first' }, ...choiceTitle(actions, 'test_first') })
      : '';
    let tail = '';
    if (state === 'stale') tail = statusLineMarkup(deps, { ...status, links: {} });
    else if (!proposal) tail = lookupStatus(deps, lookup);
    else if (pending && restoreInfo(proposal)) tail = restoredPendingLine(deps, proposal);
    else if (pending) {
      const blocked = ['commit', 'test_first'].filter((name) => actions[name] && !actions[name].available && actions[name].reason);
      if (blocked.length) {
        tail = simpleStatus(deps, 'muted', choiceUnavailableText(blocked[0], actions[blocked[0]].reason), jt('chat.proposal.dismissStill', 'You can still dismiss this.'));
      }
    }
    return `${cardOpen(deps, ctx, 'git', state, 'proposal-decision')}${eyebrow}${summary}${question}`
      + `<div class="proposal-actions">${buttons}${pathsDisclosure(deps, display)}</div>`
      + `${pending || !proposal ? dismissButton(deps, !can('dismiss')) : ''}${tail}${noticeMarkup(deps, lookup.notice)}</section>`;
  }

  function goneMarkup(deps, ctx, kind) {
    return `${cardOpen(deps, ctx, kind, 'not_found', 'proposal-receipt')}<p class="proposal-gone">`
      + `${deps.escapeHtml(jt('chat.proposal.gone', 'This proposal is no longer available.'))}</p></section>`;
  }

  // ---- command card ---------------------------------------------------------------

  function targetLine(display) {
    const cwd = display.cwd && display.cwd !== '.' ? display.cwd : jt('chat.proposal.workspaceRoot', 'Workspace root');
    const where = display.backend === 'docker' ? jt('chat.proposal.backendDocker', 'Docker sandbox') : jt('chat.proposal.backendNative', 'This computer');
    return [display.shell, cwd, where].filter(Boolean).join(' · ');
  }

  function preconditionsMarkup(deps, display, acks) {
    const items = Array.isArray(display.preconditions) ? display.preconditions : [];
    if (!items.length) return '';
    const rows = items.map((item, index) => deps.checkbox({
      label: String(asObject(item) && item.text || ''), checked: acks.includes(index), dataset: { 'proposal-ack': String(index) },
    })).join('');
    return `<div class="proposal-precond" role="group" aria-label="${deps.escapeHtml(jt('chat.proposal.beforeRunning', 'Before running, confirm'))}">`
      + `<p class="proposal-precond-title">${deps.escapeHtml(jt('chat.proposal.beforeRunning', 'Before running, confirm'))}</p>${rows}</div>`;
  }

  function commandMarkup(deps, ctx) {
    const { escapeHtml } = deps;
    const lookup = ctx.lookup;
    const proposal = lookup.proposal;
    if (lookup.status === 'not_found') return goneMarkup(deps, ctx, 'command');
    const display = proposal ? (asObject(proposal.display) || {}) : (lookup.fallback || {});
    if (typeof display.command !== 'string' || !display.command) {
      return `${cardOpen(deps, ctx, 'command', lookup.status, 'proposal-receipt')}${lookupStatus(deps, lookup)}</section>`;
    }
    const state = proposal ? proposal.decision_state : lookup.status;
    const pending = state === 'pending';
    const actions = proposal ? proposal.actions : {};
    const preconditions = Array.isArray(display.preconditions) ? display.preconditions : [];
    const runAvailable = pending && Boolean(actions.run && actions.run.available);
    const allTicked = preconditions.every((_item, index) => lookup.acks.includes(index));
    const runEnabled = runAvailable && allTicked && !lookup.busy;
    const runTitle = !allTicked && runAvailable
      ? jt('chat.proposal.runTickFirst', 'Confirm each item under "Before running" to enable Run')
      : jt('chat.proposal.runAria', 'Run command');
    const runButton = !proposal || pending
      ? deps.actionButton({
        plain: true, className: 'proposal-run', trustedHtml: RUN_ICON, disabled: !runEnabled,
        ariaLabel: jt('chat.proposal.runAria', 'Run command'), title: runTitle, dataset: { 'proposal-action': 'run' },
      })
      : '';
    const code = deps.codeblock({
      code: display.command, label: targetLine(display), copyable: true, copyIcon: true,
      copyLabel: jt('chat.proposal.copyAria', 'Copy command'), ariaLabel: jt('chat.proposal.commandCode', 'Command'),
      toolbarActionsHtml: runButton, className: 'proposal-codeblock',
    });
    const status = proposal ? deriveStatus(proposal) : null;
    let tail = '';
    if (status) {
      tail = statusLineMarkup(deps, { ...status, links: proposal.links, cancelAvailable: proposal.actions.cancel && proposal.actions.cancel.available,
        retryAvailable: false, elapsed: status.running ? elapsedMarkup(deps, proposal) : '' });
    } else if (!proposal) {
      tail = lookupStatus(deps, lookup);
    } else if (pending && restoreInfo(proposal)) {
      tail = restoredPendingLine(deps, proposal);
    } else if (pending && !runAvailable) {
      const reason = String(actions.run && actions.run.reason || '');
      tail = simpleStatus(deps, 'muted', RUN_UNAVAILABLE()[reason] || jt('chat.proposal.runUnavailable', "Run isn't available right now."), jt('chat.proposal.copyStillWorks', 'Copy still works.'));
    }
    const purpose = display.purpose ? `<p class="proposal-purpose">${escapeHtml(display.purpose)}</p>` : '';
    const showAcks = proposal && runAvailable;
    const foot = pending && proposal
      ? `<div class="proposal-foot">${deps.actionButton({ variant: 'ghost', size: 'sm', label: jt('chat.proposal.dismiss', 'Dismiss'), disabled: lookup.busy || !(actions.dismiss && actions.dismiss.available), dataset: { 'proposal-action': 'dismiss' } })}</div>`
      : '';
    return `${cardOpen(deps, ctx, 'command', state, 'proposal-command')}${purpose}${code}`
      + `${showAcks ? preconditionsMarkup(deps, display, lookup.acks) : ''}${tail}${noticeMarkup(deps, lookup.notice)}${foot}</section>`;
  }

  /** ctx: {sessionId, proposalId, kind, lookup}; lookup.fallback is the tool input shown until the record loads. */
  function buildProposalCardMarkup(ctx, deps) {
    const resolved = resolveDeps(deps);
    if (!resolved.escapeHtml || !resolved.actionButton || !resolved.checkbox || !resolved.codeblock) return '';
    const view = { ...ctx, lookup: ctx.lookup || EMPTY_LOOKUP };
    if (view.kind === 'session') {
      if (!sessionCards) return '';
      return sessionCards.buildSessionMarkup({
        ...resolved, cardOpen, statusLineMarkup, dismissButton, noticeMarkup, lookupStatus, simpleStatus, goneMarkup, elapsedMarkup,
        restoreInfo, restoreStatus, restoredPendingLine, restoredChoiceTitle,
      }, view);
    }
    return view.kind === 'command' ? commandMarkup(resolved, view) : gitMarkup(resolved, view);
  }

  /** The suggestion group's header element (ctx: {sessionId, groupId, group}); '' when it cannot be drawn. */
  function buildGroupHeaderMarkup(ctx, deps) {
    const resolved = resolveDeps(deps);
    if (!suggestionGroup || !resolved.escapeHtml || !resolved.actionButton || !ctx || !ctx.group) return '';
    return suggestionGroup.headerMarkup(resolved, { ...ctx, now: Date.now() });
  }

  /** The tool-call row's card: '' unless this is a paired proposal result (then the default tool row renders). */
  function buildProposalRowMarkup(row, messages, options, deps) {
    const identity = resolveProposalIdentity(row, options && options.pairedToolResultRow, messages);
    if (!identity) return '';
    const sessionId = String(options && options.sessionId || '').trim();
    const store = globalThis.rendererProposalCardStore && globalThis.rendererProposalCardStore.getDefaultStore();
    const input = parseInput(row);
    const fallback = identity.kind === 'session'
      ? { title: typeof input.title === 'string' ? input.title : '', description: typeof input.description === 'string' ? input.description : '', initiation: typeof input.initiation === 'string' ? input.initiation : 'offer' }
      : identity.kind === 'command'
      ? { command: typeof input.command === 'string' ? input.command : '', cwd: typeof input.cwd === 'string' ? input.cwd : '', purpose: typeof input.purpose === 'string' ? input.purpose : '', preconditions: [] }
      : { summary: typeof input.summary === 'string' ? input.summary : '', question: typeof input.question === 'string' ? input.question : '', paths: Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === 'string') : [] };
    const lookup = store && sessionId ? store.lookup(sessionId, identity.proposalId, fallback) : { ...EMPTY_LOOKUP, fallback };
    return buildProposalCardMarkup({ sessionId, proposalId: identity.proposalId, kind: identity.kind, lookup }, deps);
  }

  return { buildProposalCardMarkup, buildProposalRowMarkup, buildGroupHeaderMarkup, resolveProposalIdentity, deriveStatus, targetLine };
});
