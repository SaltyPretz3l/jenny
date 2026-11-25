/* Team tab: a shared conversation's message box and approval card (row 123, slice 3-10; picks_3-10.md). Pure: a state
 * in, HTML out; every name escaped.
 *
 * The box (E27, rows 171-172) is the #team composer (`composerParts`: code, @ and attach greyed with their reasons, the
 * Tools chip, the hint, the model pill, Send). It comes in parts (`boxParts`) so the text field, built once by
 * `composerFieldHtml`, is never in compared markup: typing, the caret, an IME composition and undo survive redraws.
 * When somebody else drives, or the member can only read, the sentence with its Take over (an admin's Take over… with
 * its confirm while a turn runs) takes the field's place (`locked`), so nothing jumps when the driver changes. A
 * picked model that went offline puts its line above the box and holds Send.
 *
 * The approval card is the app's own builder (renderer/chat/renderer-approval-block.js, `oneOffOnly`: Allow once and
 * Deny) with this card's always button before Deny: "Always allow" for the project's admins (E66), "Allow once, ask for
 * always" for writers, only for write_file and edit_file and never in Plan mode, nor while the project's rules are paused (project
 * files on: the host's gate answers nothing, so a rule would never fire; the card offers the one-off answers only); then the scope note and whose turn
 * asked. A reader's card has no buttons. A write_file or edit_file card shows the exact fields the host sent
 * (`exact_approval`, row 175 F5: every reader of the conversation sees them, only a writer gets Allow and Deny); one
 * the host marked too large shows the card's note and withholds Allow; a host that sent none (an older one) keeps the
 * summary card. The summary is bounded (600 characters), bidi and zero-width characters
 * removed. While the team is not online (`connection`, row 175 F7, D3) the hint says when Send works, Send waits with
 * that reason and the text stays; nothing fires on reconnect. Two or more approvals waiting in one turn give a writer
 * the batch banner (`batch`, item 15: "Allow all N" and "Deny all"; a reader gets none). Receipts name who answered at the time this client heard it, whose turn when another member answered, and
 * an always that did not land; a withdrawal names nobody. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../chat/renderer-approval-block'), require('./renderer-team-project-column'));
    return;
  }
  root.rendererTeamProjectBox = factory(root.rendererApprovalBlock, root.rendererTeamProjectColumn);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (approvalBlock, column) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const ALWAYS_TOOLS = new Set(['write_file', 'edit_file']);
  const BOX_ID = 'teamConversationInput';
  const HINT_ID = 'teamConversationHint'; // the sentence beside Send, when there is one: the box's description
  const PROMPT_MAX = 100_000;
  const SUMMARY_MAX = 600;

  const STOP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>';
  // The #team composer's own icons (renderer-team-composer.js, renderer-team-attach.js).
  const AT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6"/><path d="M10.6 8v1.1a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8"/></svg>';
  const CODE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/></svg>';
  const CLIP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 7.6 8.1 12.5a3.2 3.2 0 0 1-4.6-4.6l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.8a1.1 1.1 0 0 1-1.5-1.5l4.6-4.6"/></svg>';

  const button = column.button;
  const inv = () => globalThis.inventory || {};
  const line = (text, acts = '') => '<div class="team-drive team-drive--above" role="status"><span dir="auto">' + escapeHtml(text) + '</span>' + acts + '</div>';

  // `s`: { role ('admin' | 'writer' | 'reader'), owner, driver (member id or null), me, running, approval, confirm,
  // takenBy (member id or ''), busy, note, nameOf(id), boardHint (the Board's line, or ''), gpu (null, or { team, canShare } when the team is
  // connected and its GPU list is read and empty), prefs (null, or the conversation controls' { tools, model, above, offline }),
  // connection ('' while the team is online, else 'offline' or 'reconnecting'), batch (null, or { count, allow, busy }: the approvals
  // of one turn that wait together, how many of them offer Allow, and whether a batch is being decided) } ->
  // { above, locked (what takes the field's place, or ''), composer (the field is shown), toolbar (a sentence with the controls), left, bar, below, lifecycle }.
  function boxParts(s) {
    const took = s.takenBy ? '<p class="team-note-line" role="status" dir="auto">' + escapeHtml(jt('team.conv.tookOver', '{name} took over.', { name: s.nameOf(s.takenBy) })) + '</p>' : '';
    const below = s.note ? '<p class="team-set-note team-drive__note" role="status">' + escapeHtml(s.note) + '</p>' : '';
    const lifecycle = s.running ? 'streaming' : 'idle';
    const only = (html) => ({ above: took, locked: html, composer: false, left: '', bar: '', below, lifecycle });
    const sentence = (text, acts = '') => only('<span dir="auto">' + escapeHtml(text) + '</span>' + acts);
    if (s.role === 'reader') return sentence(jt('settings.team.reason.projectReadOnly', 'You can read this project. Only its writers and admins can send.'));
    const other = s.driver && s.driver !== s.me ? s.nameOf(s.driver) : '';
    if (other && s.approval) return sentence(jt('team.conv.approvalWaits', '{name} is driving. You can answer the approval above.', { name: other }));
    if (other && s.planWaits) {
      return sentence(jt('team.plan.drivingDecide', '{name} is driving. You can decide the plan above.', { name: other }),
        button('takeover', jt('team.conv.takeOver', 'Take over'), { title: jt('team.conv.takeOverTitle', 'Become the driver of this conversation'), disabled: s.busy }));
    }
    if (other && s.running && s.confirm) {
      return only(column.confirmBlock(jt('team.conv.takeOverStop', 'Take over and stop it'),
        jt('team.conv.takeOverConfirm', '{name}’s turn is still running. Take over to stop it? {name} is told that you took over.', { name: other }),
        button('takeover-stop', jt('team.conv.takeOverStop', 'Take over and stop it'), { variant: 'danger', title: jt('team.conv.takeOverStopTitle', 'Become the driver and stop {name}’s turn', { name: other }), disabled: s.busy })
        + button('takeover-cancel', jt('team.projects.cancel', 'Cancel')), 'team-drive__confirm'));
    }
    if (other && s.running) {
      if (s.role === 'admin' || s.owner) {
        return sentence(jt('team.conv.drivingRunning', '{name} is driving and their turn is running.', { name: other }),
          button('takeover-ask', jt('team.conv.takeOverAsk', 'Take over…'), { title: jt('team.conv.takeOverAskTitle', 'Stop {name}’s turn and become the driver', { name: other }) }));
      }
      return sentence(jt('team.conv.drivingRunningWriter', '{name} is driving and their turn is running. You can take over when it ends.', { name: other }),
        button('takeover', jt('team.conv.takeOver', 'Take over'), { disabled: true, title: jt('team.conv.takeOverLater', 'You can take over when {name}’s turn ends', { name: other }) }));
    }
    if (other) {
      return sentence(jt('team.conv.driving', '{name} is driving.', { name: other }),
        button('takeover', jt('team.conv.takeOver', 'Take over'), { title: jt('team.conv.takeOverTitle', 'Become the driver of this conversation'), disabled: s.busy }));
    }
    // Nobody shares a GPU: a turn cannot be placed. The box stays usable, a GPU may appear while typing. Only a member who can share gets the button;
    // the Team tab's own click handler opens Settings > Team at the share switch.
    const nobody = s.gpu ? line(jt('team.conv.noGpu', 'Nobody is sharing a GPU with {team} right now, so Jenny cannot answer here yet.', { team: s.gpu.team }),
      s.gpu.canShare ? button('share-gpu', jt('team.conv.shareGpu', 'Share this PC’s GPU…'), { dataset: { 'team-tab-action': 'share-settings' } }) : '') : '';
    // The field's bar (the hint, Send, Stop on the Board) is composerParts's.
    return { above: took + nobody, locked: '', composer: true, left: '', bar: '', below, lifecycle };
  }

  // ------------------------------------------------------------ row 171: the #team composer

  // The #team composer's field, named after the conversation; built once, as `fieldHtml`.
  // The field's placeholder and name: "Message {title}", or a plain sentence while the conversation has no title.
  function placeholderOf(title = '', plan = false) {
    if (plan) return jt('team.plan.placeholder', 'Ask Jenny for a plan');
    const name = column.plain(title, 60);
    return name ? jt('team.conv.channelPlaceholder', 'Message “{title}”', { title: name }) : jt('team.conv.boxLabel', 'Message Jenny in this conversation');
  }
  // `prefix`: the conversation's own (renderer-team-project-conversation.js): two conversations in one document never share an id.
  function composerFieldHtml(title = '', prefix = '') {
    const label = placeholderOf(title);
    return '<textarea class="team-composer__input" id="' + escapeHtml(prefix + BOX_ID) + '" dir="auto" rows="1" spellcheck="true" maxlength="' + PROMPT_MAX + '" aria-label="' + escapeHtml(label)
      + '" placeholder="' + escapeHtml(label) + '" aria-describedby="' + escapeHtml(prefix + HINT_ID) + '" data-project-input="prompt" data-dictation-target="team-box"></textarea>';
  }
  // Item 16: the composer's mic (its icon and title) on the dictation controller's generic target; greyed with its reason while dictation is off.
  function micHtml() {
    const on = globalThis.rendererDictationLive?.isEnabled?.() === true;
    const base = globalThis.rendererDictationController?.micButtonOptions?.() || {};
    return inv().actionButton({ ...base, plain: true, className: 'team-icon-btn', ariaLabel: jt('team.box.dictate', 'Dictate'), disabled: !on, dataset: { 'dictation-button': 'true' },
      title: on ? base.title : jt('team.box.dictateOff', 'Turn on dictation in Settings to use it here.') });
  }

  const icon = (action, label, title, svg, disabled) => inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: label, title, disabled,
    dataset: action ? { 'project-action': action } : {}, trustedHtml: svg });

  // The channel composer's words (renderer-team-composer.js): the host is down, or the connection is coming back.
  const offlineHint = (connection) => (connection === 'offline' ? jt('team.composer.hintOffline', 'Sends when the host is back') : jt('team.composer.hintReconnecting', 'Sends when reconnected'));

  // The approvals of one turn waiting together (row 175 item 15): how many, and the two answers for all of them. "Allow all N" counts
  // the cards that offer Allow; with fewer than two it waits with its reason. A batch being decided greys both.
  function batchHtml(b) {
    if (!b || b.count < 2) return '';
    const waiting = jtn('approval.batch.waitingTools', b.count, { count: b.count }, '1 tool waiting for approval', '{count} tools waiting for approval');
    const allow = jt('team.conv.allowAll', 'Allow all {count}', { count: b.allow });
    const reason = b.allow < 2 ? jt('team.conv.allowAllFew', 'Fewer than two of these can be allowed together. Answer them one at a time.') : '';
    return '<div class="team-batch" data-team-batch="' + b.count + '" role="region" aria-label="' + escapeHtml(jt('approval.batch.pendingToolApprovals', 'Pending tool approvals')) + '">'
      + '<span class="team-batch__title" dir="auto">' + escapeHtml(waiting) + '</span><span class="team-batch__actions">'
      + button('allow-all', allow, { variant: 'primary', title: reason || allow, disabled: Boolean(b.busy || reason) })
      + button('deny-all', jt('approval.batch.denyAll', 'Deny all'), { disabled: Boolean(b.busy) }) + '</span></div>';
  }

  // The hint beside the icons: the Board's line, "Jenny is answering…" while a turn runs and a send would wait, "Sending
  // makes you the driver" when nobody drives, else how to send (the model that answers is the pill's, row 172).
  function hintHtml(s) {
    const span = (inner) => '<span class="team-composer__hint" id="' + escapeHtml((s.idPrefix || '') + HINT_ID) + '" dir="auto">' + inner + '</span>';
    if (s.connection) return span(escapeHtml(offlineHint(s.connection)));
    if (s.boardHint) return span(escapeHtml(s.boardHint));
    if (s.running && s.mayQueue) return span(escapeHtml(jt('team.conv.hintQueue', 'Jenny is answering · what you send waits for her next turn')));
    if (s.planOn) return span(escapeHtml(jt('team.plan.hint', 'Plan mode · nothing changes until a plan is accepted')));
    if (!s.driver) return span(escapeHtml(jt('team.conv.sendDrives', 'Sending makes you the driver')));
    return span(escapeHtml(jt('team.conv.hintSend', 'Markdown · Enter to send')));
  }

  // `s`: boxParts's state, plus `idPrefix` (the conversation's, for the hint's id), `files` (item 13: the host serves files, so @ picks one), `mayQueue` (a send while a turn runs waits for the next turn) and `board` (the Board's
  // column, where the chip may scroll away). Same output as boxParts: every sentence state is boxParts's own; the field
  // state is the #team composer's bar (code, @ and attach greyed with their reasons, the hint, Send). Stop is on the
  // chip's line, except on the Board.
  function composerParts(s) {
    const parts = boxParts(s);
    const batch = s.role === 'reader' ? '' : batchHtml(s.batch);
    // A sentence in the field's place (somebody else drives, a reader): the two controls stay, disabled, with their reason in their popovers.
    if (!parts.composer) return s.prefs ? { ...parts, above: parts.above + batch + s.prefs.above, toolbar: true, left: s.prefs.tools + '<span class="team-composer__hint"></span>' + s.prefs.model } : { ...parts, above: parts.above + batch };
    const mention = jt('team.composer.mention', 'Mention someone');
    const attach = jt('team.attach.button', 'Attach files');
    const left = icon('code', jt('team.composer.code', 'Code block'), jt('team.composer.code', 'Code block'), CODE_ICON, false)
      + (s.files ? icon('at-file', jt('team.paths.at', 'Insert a project file'), jt('team.paths.atTitle', 'Insert the path of a project file (or type @)'), AT_ICON, false)
        : icon('', mention, jt('team.conv.mentionOff', 'Mentions are not sent to Jenny'), AT_ICON, true))
      + icon('', attach, jt('team.conv.attachOff', 'Attachments cannot be sent in project conversations yet'), CLIP_ICON, true) + micHtml()
      + (s.prefs ? s.prefs.tools : '') + hintHtml(s) + (s.prefs ? s.prefs.model : '');
    const mayStop = s.running && (!s.driver || s.driver === s.me);
    const stop = mayStop && s.board
      ? icon('stop', jt('team.conv.stopTitle', 'Stop this turn'), jt('team.conv.stopTitle', 'Stop this turn'), STOP_ICON, s.busy) : '';
    const waits = s.connection ? offlineHint(s.connection) : '';
    const send = button('send', jt('team.conv.send', 'Send'), { variant: 'primary', title: waits || jt('team.conv.sendTitle', 'Send (Enter)'), ariaDescription: waits,
      disabled: Boolean(s.busy || waits || (s.running && !s.mayQueue) || (s.prefs && s.prefs.offline)) });
    return { ...parts, above: parts.above + batch + (s.prefs ? s.prefs.above : ''), left, bar: stop + send };
  }

  // Whose turn asked, from the approval's prompter: "{Name}'s turn asked. …".
  function whoLine(prompter) {
    const text = prompter
      ? jt('team.conv.whoAsked', '{name}’s turn asked. Anyone who can write in this project and is viewing this conversation can answer.', { name: prompter })
      : jt('team.conv.whoAskedNone', 'A turn asked. Anyone who can write in this project and is viewing this conversation can answer.');
    return '<p class="tool-approval-who" dir="auto">' + escapeHtml(text) + '</p>';
  }

  // `a`: a pending approval from the snapshot; `s`: { role, planMode, paused (the project's rules are paused: no always button), projectName, prompter (name or ''), busy, note }.
  function cardHtml(a, s) {
    const tool = String(a.tool_name || '');
    const card = approvalBlock.renderApprovalBlock({ mode: 'card', toolCallId: a.call_id || a.approval_id, approvalId: a.approval_id, toolName: tool,
      prompt: column.plain(a.summary, SUMMARY_MAX), policyScope: a.policy_scope, policyConsequence: a.policy_consequence,
      reason: a.reason, oneOffOnly: true, ...(Object.hasOwn(a, 'exact_approval') ? { exactApproval: a.exact_approval } : {}) });
    // The chat's own card, edited as nodes: a reader loses its buttons; the always button is a copy of Allow once.
    const doc = (typeof document !== 'undefined' && document) || null;
    if (!doc) return card;
    const holder = doc.createElement('template');
    holder.innerHTML = card;
    const block = holder.content.firstElementChild;
    if (!block) return card;
    const actions = block.querySelector('.tool-approval-actions');
    if (s.role === 'reader') { if (actions) actions.remove(); } else if (actions) {
      if (s.busy) for (const b of actions.querySelectorAll('.tool-approve-btn, .tool-deny-btn')) b.disabled = true;
      const admin = s.role === 'admin';
      const once = actions.querySelector('.tool-approve-btn[data-approval-scope="once"]');
      const deny = actions.querySelector('.tool-deny-btn');
      if (ALWAYS_TOOLS.has(tool) && !s.planMode && !s.paused && once && deny) {
        const params = { tool: column.clean(tool, 64), project: s.projectName };
        const title = admin ? jt('team.conv.alwaysAllowTitle', 'Always allow {tool} in {project}, for everyone’s turns', params)
          : jt('team.conv.askAlwaysTitle', 'Allow this once and ask the project’s admins to always allow {tool} here', params);
        const always = once.cloneNode(false);
        always.classList.add('tool-approve-always-btn');
        always.setAttribute('data-approval-scope', 'always');
        always.setAttribute('data-team-always', admin ? 'rule' : 'ask');
        always.setAttribute('title', title);
        always.setAttribute('aria-label', title);
        always.removeAttribute('id');
        always.textContent = admin ? jt('team.conv.alwaysAllow', 'Always allow') : jt('team.conv.askAlways', 'Allow once, ask for always');
        deny.before(always);
        const note = doc.createElement('p');
        note.className = 'tool-approval-scope-note';
        note.textContent = admin ? jt('team.conv.alwaysNote', 'Always allow saves a rule for {tool} in this project, for everyone’s turns. You can change it under Always allowed on the project’s page.', params)
          : jt('team.conv.askNote', 'Ask for always lets the turn go on now and asks the project’s admins to always allow {tool} here. They can agree, narrow it or say no.', params);
        actions.after(note);
      }
    }
    // `askHtml` (row 175 F13, D8): Ask a teammate, from renderer-team-project-actions.js.
    block.insertAdjacentHTML('beforeend', whoLine(s.prompter) + (s.askHtml || '') + (s.note ? '<p class="team-set-note" role="status">' + escapeHtml(s.note) + '</p>' : ''));
    return block.outerHTML;
  }

  // A receipt: { outcome ('allowed' | 'declined' | 'withdrawn'), approver (name), prompter (name or ''), time, asked (tool
  // or ''), rule (tool or ''), failed (the sentence of an always that did not land, or '') }.
  function receiptHtml(r) {
    const params = { name: r.approver, prompter: r.prompter, time: r.time, tool: column.clean(r.asked || r.rule, 64) };
    let text;
    if (r.outcome === 'withdrawn') text = jt('team.conv.withdrawn', 'Withdrawn at {time}: the turn no longer asks.', params);
    else if (r.outcome === 'declined') text = r.prompter ? jt('team.conv.denied', '{name} denied this at {time}, in {prompter}’s turn', params) : jt('team.conv.deniedNoPrompter', '{name} denied this at {time}', params);
    else if (r.asked) text = r.prompter ? jt('team.conv.allowedAsked', '{name} allowed this once at {time}, in {prompter}’s turn, and asked the project’s admins to always allow {tool} here.', params)
      : jt('team.conv.allowedAskedNoPrompter', '{name} allowed this once at {time} and asked the project’s admins to always allow {tool} here.', params);
    else if (r.rule) text = r.prompter ? jt('team.conv.allowedRule', '{name} allowed this at {time}, in {prompter}’s turn, and saved a rule to always allow {tool} in this project.', params)
      : jt('team.conv.allowedRuleNoPrompter', '{name} allowed this at {time} and saved a rule to always allow {tool} in this project.', params);
    else text = r.prompter ? jt('team.conv.allowed', '{name} allowed this at {time}, in {prompter}’s turn', params) : jt('team.conv.allowedNoPrompter', '{name} allowed this at {time}', params);
    const decision = r.outcome === 'declined' ? 'denied' : r.outcome === 'withdrawn' ? 'withdrawn' : 'allowed';
    return '<div class="tool-approval-block" data-approval-status="resolved" data-approval-decision="' + decision + '"><p class="tool-approval-receipt" dir="auto">'
      + escapeHtml(r.failed ? text + ' ' + r.failed : text) + '</p></div>';
  }

  // The asker's outcome line (a request of theirs answered): { outcome, by (name), tool, folder, reason, project }.
  function outcomeHtml(o) {
    const params = { name: o.by, tool: column.clean(o.tool, 64), project: o.project, folder: column.clean(o.folder || '', 255), reason: column.clean(o.reason || '', 200) };
    const text = o.outcome === 'declined'
      ? jt('team.conv.outcomeDeclined', '{name} did not always allow {tool}: “{reason}” Each edit still asks.', params)
      : o.folder ? jt('team.conv.outcomeFolder', '{name} always allowed {tool} in {project}, in {folder} only.', params)
        : jt('team.conv.outcomeAllowed', '{name} always allowed {tool} in {project}.', params);
    return '<div class="turn-activity-row" role="status" data-team-outcome="' + escapeHtml(o.outcome) + '"><span class="turn-activity-label" dir="auto">' + escapeHtml(text) + '</span></div>';
  }

  // Whether the card of `a` offers Allow once: a write whose exact presentation is missing or too large has none (above), so a
  // batch never allows it. An older host that sends no presentation keeps the summary card, with Allow.
  function offersAllow(a) {
    if (!approvalBlock.EXACT_APPROVAL_TOOLS.has(String(a.tool_name || '')) || !Object.hasOwn(a, 'exact_approval')) return true;
    return Boolean(a.exact_approval) && typeof a.exact_approval === 'object' && a.exact_approval.too_large !== true;
  }

  return { boxParts, composerParts, placeholderOf, composerFieldHtml, cardHtml, receiptHtml, outcomeHtml, offersAllow, BOX_ID, PROMPT_MAX };
});
