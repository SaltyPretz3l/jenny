/* Team tab: a shared conversation's message box and approval card (row 123, slice 3-10; picks_3-10.md "The message
 * box by state", "Approval card" and "Always allowed"). Pure: a state in, HTML out; every name escaped.
 *
 * The box, by state (E27): a reader's line; "{Name} is driving. You can answer the approval above." while an
 * approval waits; another member driving with a turn running: a writer's disabled Take over with its reason, an admin
 * or the team owner's Take over… and its confirm ("Take over and stop it" makes two calls: the takeover, then the
 * cancel); another member driving with no turn running: Take over for any writer; nobody driving or this member:
 * the box, with "Sending makes you the driver" when nobody drives, and Stop while this member's turn runs.
 * "{Name} took over." stays above it until this member next acts.
 *
 * The box comes in parts (`boxParts`) so the text field is never part of compared markup: the conversation builds the
 * field once (`fieldHtml`, no draft in it) and writes only the parts around it, so typing, the caret, an IME
 * composition and undo survive every redraw.
 *
 * The approval card is the app's own builder (renderer/chat/renderer-approval-block.js, `oneOffOnly` so it draws
 * Allow once and Deny only) with this card's always button put before Deny: "Always allow" for the project's admins
 * (the host's rule: the team owner manages rules only where they hold a project admin row, E66), "Allow once, ask for
 * always" for writers, only for write_file and edit_file and never in Plan mode; then the scope note and the line
 * naming whose turn asked. A reader's card has no buttons. The summary the approver reads is bounded (600 characters)
 * with bidi and zero-width characters removed. Receipts: allowed, declined or withdrawn (no person named), at the
 * time this client heard it, whose turn asked, and an always that did not land in its own sentence. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../chat/renderer-approval-block'), require('./renderer-team-project-column'));
    return;
  }
  root.rendererTeamProjectBox = factory(root.rendererApprovalBlock, root.rendererTeamProjectColumn);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (approvalBlock, column) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const ALWAYS_TOOLS = new Set(['write_file', 'edit_file']);
  const BOX_ID = 'teamConversationInput';
  const HINT_ID = 'teamConversationHint'; // the sentence beside Send, when there is one: the box's description
  const PROMPT_MAX = 100_000;
  const SUMMARY_MAX = 600;

  const button = column.button;
  const line = (text, acts = '') => '<div class="team-drive" role="status"><span dir="auto">' + escapeHtml(text) + '</span>' + acts + '</div>';

  // The text field, built once by the conversation; its value lives on the element, never in this markup.
  function fieldHtml() {
    const label = jt('team.conv.boxLabel', 'Message Jenny in this conversation');
    return '<textarea class="team-composer__input" id="' + BOX_ID + '" rows="2" maxlength="' + PROMPT_MAX + '" aria-label="' + escapeHtml(label)
      + '" placeholder="' + escapeHtml(label) + '" aria-describedby="' + HINT_ID + '" data-project-input="prompt"></textarea>';
  }

  // `s`: { role ('admin' | 'writer' | 'reader'), owner, driver (member id or null), me, running, approval, confirm,
  // takenBy (member id or ''), busy, note, nameOf(id), boardHint (the Board's line, or '') } -> { above, composer (the field is shown), bar, below }.
  function boxParts(s) {
    const took = s.takenBy ? '<p class="team-note-line" role="status" dir="auto">' + escapeHtml(jt('team.conv.tookOver', '{name} took over.', { name: s.nameOf(s.takenBy) })) + '</p>' : '';
    const below = s.note ? '<p class="team-set-note team-drive__note" role="status">' + escapeHtml(s.note) + '</p>' : '';
    const only = (html) => ({ above: took + html, composer: false, bar: '', below });
    if (s.role === 'reader') return only(line(jt('settings.team.reason.projectReadOnly', 'You can read this project. Only its writers and admins can send.')));
    const other = s.driver && s.driver !== s.me ? s.nameOf(s.driver) : '';
    if (other && s.approval) return only(line(jt('team.conv.approvalWaits', '{name} is driving. You can answer the approval above.', { name: other })));
    if (other && s.running && s.confirm) {
      return only(column.confirmBlock(jt('team.conv.takeOverStop', 'Take over and stop it'),
        jt('team.conv.takeOverConfirm', '{name}’s turn is still running. Take over to stop it? {name} is told that you took over.', { name: other }),
        button('takeover-stop', jt('team.conv.takeOverStop', 'Take over and stop it'), { variant: 'danger', title: jt('team.conv.takeOverStopTitle', 'Become the driver and stop {name}’s turn', { name: other }), disabled: s.busy })
        + button('takeover-cancel', jt('team.projects.cancel', 'Cancel')), 'team-drive__confirm'));
    }
    if (other && s.running) {
      if (s.role === 'admin' || s.owner) {
        return only(line(jt('team.conv.drivingRunning', '{name} is driving and their turn is running.', { name: other }),
          button('takeover-ask', jt('team.conv.takeOverAsk', 'Take over…'), { title: jt('team.conv.takeOverAskTitle', 'Stop {name}’s turn and become the driver', { name: other }) })));
      }
      return only(line(jt('team.conv.drivingRunningWriter', '{name} is driving and their turn is running. You can take over when it ends.', { name: other }),
        button('takeover', jt('team.conv.takeOver', 'Take over'), { disabled: true, title: jt('team.conv.takeOverLater', 'You can take over when {name}’s turn ends', { name: other }) })));
    }
    if (other) {
      return only(line(jt('team.conv.driving', '{name} is driving.', { name: other }),
        button('takeover', jt('team.conv.takeOver', 'Take over'), { title: jt('team.conv.takeOverTitle', 'Become the driver of this conversation'), disabled: s.busy })));
    }
    // On the Board the one hint line says what the board is shared with (s.boardHint); the head already says nobody drives.
    const hint = s.boardHint ? '<span class="team-composer__hint" id="' + HINT_ID + '" dir="auto">' + escapeHtml(s.boardHint) + '</span>'
      : s.driver === s.me ? '' : '<span class="team-composer__hint" id="' + HINT_ID + '">' + escapeHtml(jt('team.conv.sendDrives', 'Sending makes you the driver')) + '</span>';
    const action = s.running && s.driver === s.me
      ? button('stop', jt('team.conv.stop', 'Stop'), { title: jt('team.conv.stopTitle', 'Stop this turn'), disabled: s.busy })
      : button('send', jt('team.conv.send', 'Send'), { variant: 'primary', title: jt('team.conv.sendTitle', 'Send (Enter)'), disabled: s.busy });
    return { above: took, composer: true, bar: hint + action, below };
  }

  // Whose turn asked, from the approval's prompter: "{Name}'s turn asked. …".
  function whoLine(prompter) {
    const text = prompter
      ? jt('team.conv.whoAsked', '{name}’s turn asked. Anyone who can write in this project and is viewing this conversation can answer.', { name: prompter })
      : jt('team.conv.whoAskedNone', 'A turn asked. Anyone who can write in this project and is viewing this conversation can answer.');
    return '<p class="tool-approval-who" dir="auto">' + escapeHtml(text) + '</p>';
  }

  // `a`: a pending approval from the snapshot; `s`: { role, planMode, projectName, prompter (name or ''), busy, note }.
  function cardHtml(a, s) {
    const tool = String(a.tool_name || '');
    const card = approvalBlock.renderApprovalBlock({ mode: 'card', toolCallId: a.call_id || a.approval_id, approvalId: a.approval_id, toolName: tool,
      prompt: column.plain(a.summary, SUMMARY_MAX), policyScope: a.policy_scope, policyConsequence: a.policy_consequence,
      reason: a.reason, oneOffOnly: true });
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
      if (ALWAYS_TOOLS.has(tool) && !s.planMode && once && deny) {
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
    block.insertAdjacentHTML('beforeend', whoLine(s.prompter) + (s.note ? '<p class="team-set-note" role="status">' + escapeHtml(s.note) + '</p>' : ''));
    return block.outerHTML;
  }

  // A receipt: { outcome ('allowed' | 'declined' | 'withdrawn'), approver (name), prompter (name), time, asked (tool
  // or ''), rule (tool or ''), failed (the sentence of an always that did not land, or '') }.
  function receiptHtml(r) {
    const params = { name: r.approver, prompter: r.prompter, time: r.time, tool: column.clean(r.asked || r.rule, 64) };
    let text;
    if (r.outcome === 'withdrawn') text = jt('team.conv.withdrawn', 'Withdrawn at {time}: the turn no longer asks.', params);
    else if (r.outcome === 'declined') text = r.prompter ? jt('team.conv.denied', 'Denied by {name} at {time} · asked by {prompter}’s turn', params) : jt('team.conv.deniedNoPrompter', 'Denied by {name} at {time}', params);
    else if (r.asked) text = jt('team.conv.allowedAsked', 'Allowed once by {name} at {time} · asked by {prompter}’s turn. {name} asked the project’s admins to always allow {tool} here.', params);
    else if (r.rule) text = jt('team.conv.allowedRule', 'Allowed by {name} at {time} · asked by {prompter}’s turn. {name} saved a rule to always allow {tool} in this project.', params);
    else text = r.prompter ? jt('team.conv.allowed', 'Allowed by {name} at {time} · asked by {prompter}’s turn', params) : jt('team.conv.allowedNoPrompter', 'Allowed by {name} at {time}', params);
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

  return { boxParts, fieldHtml, cardHtml, receiptHtml, outcomeHtml, BOX_ID, PROMPT_MAX };
});
