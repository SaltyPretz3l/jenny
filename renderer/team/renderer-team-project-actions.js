/* Team tab: a shared conversation's message menu (right-click, Menu key, Shift+F10 on a row), Regenerate (asks first: the host
 * keeps no earlier answer, a recorded deviation from D7), Edit and resend in the row, Branch, Ask a teammate, Hand to… and host
 * receipts under their turn (row 175 items 5, 6, 9, 11, F13, F18). What does not apply is greyed with its reason; what no team
 * conversation can do yet (Pin to board) is not listed. Names are escaped in markup and isolated in menus; ids go only in
 * payloads. Lazy with the Team tab. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamProjectActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);
  function teamModule(global, file) { if (globalThis[global]) return globalThis[global]; try { return require(file); } catch (_error) { return null; } }

  const TOAST_MS = 1800;
  const MEMBERS_MS = 30_000;
  const PICK_MAX = 32;
  const WRITE_ROLES = new Set(['owner', 'admin', 'writer']);
  const ROW = '.team-msg[data-message-id], .team-msg[data-turn-id]';
  const KEEP_DEFAULT = 'a[href], pre, .markdown-code-block, .team-edit, textarea, input, select, [contenteditable="true"]';
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const ASK_ICON = SVG('<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.6-2.4 2.3-3.8 4.5-3.8s3.9 1.4 4.5 3.8M12.5 5v5M10 7.5h5"/>');
  const HAND_ICON = SVG('<circle cx="11" cy="5" r="2.2"/><path d="M7.5 13.5c.4-2 1.8-3.3 3.5-3.3s3.1 1.3 3.5 3.3M1.5 8h5M4.5 5.5 7 8l-2.5 2.5"/>');
  const isolate = (text) => '⁨' + String(text || '') + '⁩';
  const dayOf = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-'); }; // YYYY-MM-DD, local
  const menuApi = () => (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null;
  const savedOf = (turn) => (turn.messages || []).findLast((m) => m && m.role === 'assistant' && m.content) || null;
  const authorOf = (m) => (m && m.author && m.author.kind === 'member' && m.author.member_id) || '';
  const resolved = (decision, text) => '<div class="tool-approval-block" data-approval-status="resolved" data-approval-decision="' + decision + '"><p class="tool-approval-receipt" dir="auto">'
    + escapeHtml(text) + '</p></div>';

  // `d`: the conversation's ids and accessors (renderer-team-project-conversation.js passes them); `call` is the store's. `d.promptMax`:
  // the message box's own limit (renderer-team-project-box.js PROMPT_MAX): Edit and resend takes as much as a sent message.
  function createActions(d) {
    const scope = { team_id: d.teamId, project_id: d.projectId, session_id: d.sessionId };
    const conv = { team_id: d.teamId, session_id: d.sessionId };
    const doc = d.root.ownerDocument;
    const live = { panel: null, busy: false, menu: false, disposed: false, toast: null, members: null, membersAt: -Infinity, receipts: null, key: '', placed: new Set() };

    const writeBlock = () => (!d.online() ? jt('team.actions.offline', 'Available when the team is online.') : d.role() === 'reader' ? jt('team.actions.reader', 'Only writers and admins can do this here.') : '');
    const latestPrompt = () => d.messages().findLast((m) => m && m.role === 'user') || null;
    function redoBlock(t, edit) {
      const base = writeBlock();
      if (base) return base;
      const author = authorOf(t.prompt);
      if (edit && author !== d.me()) return jt('team.actions.editWho', 'Only the member who asked can edit and resend this question.');
      if (!edit && author !== d.me() && d.role() !== 'admin') return jt('team.actions.regenerateWho', 'Only the member who asked, or a project admin, can regenerate this answer.');
      if (d.running()) return jt('team.actions.running', 'Wait until Jenny’s turn ends.');
      const driver = d.driver();
      if (driver && driver !== d.me()) return jt('team.actions.driving', '{name} is driving.', { name: d.nameOf(driver) });
      return live.busy ? jt('team.actions.busy', 'Wait for the last action to finish.') : '';
    }

    // A row: its turn, its prompt, the saved message it stands for, its words.
    function targetOf(row) {
      const turns = d.view().turns;
      if (row.dataset.turnId) {
        const turn = turns.find((one) => one.id === row.dataset.turnId);
        if (!turn) return null;
        const said = savedOf(turn);
        return { row, turn, prompt: turn.prompt || null, messageId: said ? said.id : '', text: String(turn.text || ''), jenny: true, at: said ? said.timestamp : turn.startedAt };
      }
      const message = d.messages().find((m) => m.id === row.dataset.messageId);
      if (!message) return null;
      const turn = turns.find((one) => one.prompt && one.prompt.id === message.id) || null;
      return { row, turn, prompt: message, messageId: message.id, text: String(message.content || ''), jenny: false, at: message.timestamp };
    }

    function itemsFor(t) {
      const off = (why) => (why ? { disabled: true, description: why } : {});
      const empty = t.text ? '' : jt('team.actions.nothing', 'There is nothing to copy yet.');
      const unsaved = t.messageId ? '' : jt('team.actions.unsaved', 'This answer is not saved yet.');
      const items = [
        { value: 'copy', label: jt('team.actions.copy', 'Copy'), ...off(empty), action: () => { const body = t.row.querySelector('.team-msg__text'); return copy(body ? body.textContent.trim() : t.text, jt('team.conv.copied', 'Copied')); } },
        { value: 'copy-markdown', label: jt('team.actions.copyMarkdown', 'Copy as Markdown'), ...off(empty), action: () => copy(t.text, jt('team.conv.copied', 'Copied')) },
        { value: 'work', label: jt('team.turn.showWorkTitle', 'Show Jenny’s work'), ...off(t.turn ? '' : jt('team.actions.noWork', 'Jenny has not answered this yet.')), action: () => d.openTurn(t.turn.id) },
        { value: 'copy-link', label: jt('team.link.copyLabel', 'Copy link'), ...off(unsaved), action: () => copyLink(t) },
        { value: 'copy-source', label: jt('team.message.copyWithSource', 'Copy with source'), ...off(empty), action: () => copySource(t) },
        { separator: true },
        { value: 'branch', label: jt('team.actions.branch', 'Branch from here'), ...off(writeBlock() || unsaved), action: () => branch(t.messageId) },
      ];
      const latest = latestPrompt();
      if (t.prompt && latest && t.prompt.id === latest.id) {
        items.push({ value: 'regenerate', label: jt('team.actions.regenerate', 'Regenerate'), ...off(redoBlock(t, false)), action: () => openPanel('redo', t) },
          { value: 'edit', label: jt('team.actions.edit', 'Edit and resend'), ...off(redoBlock(t, true)), action: () => openPanel('edit', t) });
      }
      return items;
    }

    function showMenu(opts) {
      const api = menuApi();
      if (!api || typeof api.show !== 'function') return false;
      api.show({ className: 'team-msg-menu', ...opts, onHide: () => { live.menu = false; } });
      live.menu = true;
      return true;
    }
    function openRowMenu(row, point) {
      const t = targetOf(row);
      if (!t) return false;
      return showMenu({ ...(point ? { anchorX: point.x, anchorY: point.y } : { anchorEl: row }), rootEl: row, restoreFocusTo: row,
        ariaLabel: jt('team.acts.label', 'Message actions'), items: itemsFor(t) });
    }
    const rowAt = (target) => {
      const row = target?.closest?.(ROW);
      return row && d.root.contains(row) && row.closest('[data-conv-region="log"], [data-conv-region="live"]') ? row : null;
    };

    function toast(text) {
      const host = d.root.querySelector('.team-conv__stage') || d.root;
      if (live.toast) { d.timers.clear(live.toast.timer); live.toast.el.remove(); }
      const el = doc.createElement('div');
      el.className = 'team-copied';
      el.innerHTML = '<div class="inv-toast" role="status" aria-live="polite"><div class="inv-toast__body"><div class="inv-toast__message" dir="auto">' + escapeHtml(text) + '</div></div></div>';
      host.appendChild(el);
      const mine = { el, timer: 0 };
      mine.timer = d.timers.set(() => { el.remove(); if (live.toast === mine) live.toast = null; }, TOAST_MS);
      live.toast = mine;
    }
    async function copy(text, said) {
      const clipboard = doc.defaultView?.jennyShell?.clipboard;
      let ok;
      try { ok = Boolean(text && clipboard && typeof clipboard.writeText === 'function') && (await clipboard.writeText(text), true); } catch (_error) { ok = false; }
      if (!live.disposed) toast(ok ? said : jt('team.message.copyFailed', 'The message could not be copied.'));
    }
    function copyLink(t) {
      const links = teamModule('rendererTeamLink', './renderer-team-link');
      const token = links ? links.build({ teamId: d.teamId, sessionId: d.sessionId, messageId: t.messageId }, { teamId: d.teamId, conversationListed: (id) => id === d.sessionId }) : '';
      if (!token) { toast(jt('team.link.copyFailed', 'The link could not be copied.')); return null; }
      return copy(token, jt('team.link.copied', 'Link copied'));
    }
    function copySource(t) {
      const actions = teamModule('rendererTeamMessageActions', './renderer-team-message-actions');
      if (!actions || typeof actions.buildQuote !== 'function') return null;
      const name = t.jenny ? jt('team.conv.jenny', 'Jenny') : d.nameOf(authorOf(t.prompt)) || jt('team.chat.formerMember', 'Former member');
      return copy(actions.buildQuote({ name, where: d.projectName(), date: dayOf(t.at), text: t.text }), jt('team.message.copiedWithSource', 'Copied with source'));
    }

    async function once(method, payload) {
      if (live.busy || live.disposed) return null;
      live.busy = true;
      const answer = await d.call(method, payload);
      live.busy = false;
      return live.disposed ? null : answer;
    }
    // A refusal is said in a toast; `ok(answer)` runs on an ok answer.
    async function act(method, extra, ok) {
      const answer = await once(method, { ...scope, ...extra });
      if (answer && !answer.ok) toast(d.errorText(answer.error)); else if (answer) ok(answer);
    }
    const branch = (id) => act('projectBranch', { message_id: id }, (a) => { if (d.onOpenConversation && d.onOpenConversation(a.session_id) === true) return; const n = globalThis.rendererTeamNotify; if (n && n.request) n.request({ kind: 'conversation', teamId: d.teamId, sessionId: a.session_id, projectId: d.projectId }); });
    const ask = (id, approvalId) => act('projectAskTeammate', { member_id: id, ...(approvalId ? { approval_id: approvalId } : {}) }, () => toast(jt('team.actions.asked', 'Asked {name}', { name: d.nameOf(id) })));
    const hand = (id) => act('projectHandDriver', { member_id: id }, () => toast(jt('team.actions.handedTo', '{name} is driving now.', { name: d.nameOf(id) })));
    // F18: the seat was handed to this member.
    async function handed() {
      const answer = await d.call('conversationControl', { ...conv, action: 'take' });
      if (!live.disposed && answer && answer.ok) toast(jt('team.actions.drivingNow', 'You are driving now'));
    }

    async function membersList() {
      const now = Date.now();
      if (live.members && now - live.membersAt < MEMBERS_MS) return live.members;
      const answer = await d.call('projectMembers', { team_id: d.teamId, project_id: d.projectId });
      if (live.disposed) return null;
      if (!answer.ok || !Array.isArray(answer.members)) { toast(d.errorText(answer.error)); return null; }
      live.members = answer.members.filter((m) => m && typeof m.member_id === 'string').slice(0, 256);
      live.membersAt = now;
      return live.members;
    }
    // Ask: the project's members but this one; Hand to…: the viewers among them who can write.
    async function pick(anchor, kind, approvalId) {
      const list = await membersList();
      if (!list || !anchor.isConnected) return;
      const viewing = new Set(d.viewers());
      const people = list.filter((m) => m.member_id !== d.me() && (kind === 'ask' || (WRITE_ROLES.has(m.role) && viewing.has(m.member_id)))).slice(0, PICK_MAX);
      const items = people.map((m) => ({ value: m.member_id, label: isolate(d.nameOf(m.member_id)), action: () => (kind === 'ask' ? ask(m.member_id, approvalId) : hand(m.member_id)) }));
      const heading = kind === 'ask' ? jt('team.actions.askHeading', 'Ask a teammate to look') : jt('team.actions.handHeading', 'Hand the driver seat to');
      if (!items.length) {
        items.push({ value: 'none', disabled: true, label: kind === 'ask' ? jt('team.actions.askNobody', 'Nobody else is in this project.') : jt('team.actions.handNobody', 'Nobody else who can write is viewing.') });
      }
      showMenu({ anchorEl: anchor, rootEl: anchor, restoreFocusTo: anchor, heading, ariaLabel: heading, items });
    }

    const button = (act, label, variant, disabled = false) => actionButton({ label, variant, size: 'sm', title: label, disabled, dataset: { 'conv-act': act } });
    const status = (note) => (note ? '<p class="team-set-note" role="status" dir="auto">' + escapeHtml(note) + '</p>' : '');
    function panelHtml(p) {
      if (p.kind === 'redo') {
        const label = jt('team.actions.regenerate', 'Regenerate');
        return '<div class="team-set-confirm team-conv-act" role="group" aria-label="' + escapeHtml(label) + '" data-conv-act-panel="redo"><p dir="auto">'
          + escapeHtml(jt('team.actions.regenerateConfirm', 'The current answer is replaced. Branch from here first to keep it.')) + '</p><div class="team-set-inline">'
          + button('redo-go', label, 'danger', p.busy) + button('redo-branch', jt('team.actions.branchFirst', 'Branch first'), 'secondary', p.busy || !p.answerId)
          + button('panel-cancel', jt('team.projects.cancel', 'Cancel'), 'ghost') + '</div>' + status(p.note) + '</div>';
      }
      return '<div class="team-edit team-conv-act" data-conv-act-panel="edit"><textarea class="team-edit__input" rows="2" dir="auto" maxlength="' + d.promptMax + '" aria-label="'
        + escapeHtml(jt('team.actions.editLabel', 'Edit your question')) + '"' + (p.busy ? ' disabled' : '') + '></textarea><div class="team-edit__bar"><span class="team-edit__hint">'
        + escapeHtml(jt('team.actions.editHint', 'Enter to send · Esc to cancel')) + '</span>' + button('panel-cancel', jt('team.projects.cancel', 'Cancel'), 'ghost')
        + button('edit-save', jt('team.actions.editSave', 'Save and send'), 'primary', p.busy) + '</div>' + status(p.note) + '</div>';
    }
    const panelEl = () => d.root.querySelector('[data-conv-act-panel]');
    const promptRow = (id) => [...d.root.querySelectorAll('.team-msg[data-message-id]')].find((el) => el.dataset.messageId === id) || null;
    // The redo confirm or the editor in its row, again after a write of the log took it away.
    function mount(focus) {
      const p = live.panel;
      const old = panelEl();
      if (old) old.remove();
      const row = p ? promptRow(p.promptId) : null;
      if (!row) return;
      const text = row.querySelector('.team-msg__text');
      if (text) text.insertAdjacentHTML('afterend', panelHtml(p)); else row.insertAdjacentHTML('beforeend', panelHtml(p));
      const el = panelEl();
      const field = el.querySelector('textarea');
      if (field) field.value = p.value;
      const active = doc.activeElement;
      if (focus || !active || active === doc.body) (field || el.querySelector('button:not([disabled])')).focus({ preventScroll: true });
    }
    function openPanel(kind, t) {
      const said = t.turn ? savedOf(t.turn) : null;
      live.panel = { kind, promptId: t.prompt.id, answerId: said ? said.id : '', value: String(t.prompt.content || ''), busy: false, note: '' };
      mount(true);
    }
    function closePanel() {
      const row = live.panel && promptRow(live.panel.promptId);
      live.panel = null;
      mount();
      if (row) row.focus({ preventScroll: true });
    }
    async function redo() {
      const p = live.panel;
      if (!p || p.busy) return;
      const prompt = p.value.trim();
      if (p.kind === 'edit' && (!prompt || prompt.length > d.promptMax)) { p.note = prompt ? jt('team.conv.tooLong', 'That message is too long to send.') : jt('team.actions.editEmpty', 'Write the question first.'); mount(true); return; }
      p.busy = true;
      p.note = '';
      mount(false);
      const answer = await once(p.kind === 'edit' ? 'projectEditResend' : 'projectRegenerate', { ...scope, message_id: p.promptId, ...(p.kind === 'edit' ? { prompt } : {}) });
      const shown = live.panel === p;
      if (!answer || !answer.ok) { if (shown) { p.busy = false; p.note = answer ? d.errorText(answer.error) : ''; mount(true); } return; }
      if (shown) closePanel();
      await d.call('conversationControl', { ...conv, action: 'take' });
      if (!live.disposed) d.redraw();
    }

    function receipts() {
      const snap = d.snapshot();
      const list = snap && Array.isArray(snap.receipts) ? snap.receipts : [];
      if (list !== live.receipts) {
        live.receipts = list;
        // A plan's decision is drawn by the plan row (its words are not Allowed or Declined).
        live.placeable = list.filter((r) => r && r.tool_name !== 'exit_plan_mode' && (typeof r.call_id === 'string' || typeof r.approval_id === 'string'));
        live.key = live.placeable.map((r) => [r.seq, r.outcome, r.call_id || '', r.approval_id || ''].join(':')).join('|');
        live.calls = null;
      }
      // The approvals whose receipt `under` draws: those whose tool call is in a saved message.
      const messages = snap && Array.isArray(snap.messages) ? snap.messages : [];
      if (live.calls !== messages) {
        live.calls = messages;
        const calls = callIdsOf({ messages });
        live.placed = new Set(live.placeable.filter((r) => belongs(r, calls)).map((r) => r.approval_id).filter(Boolean));
      }
      return live.placeable;
    }
    const callIdsOf = (turn) => (turn.messages || []).map((m) => (m && m.tool_call && typeof m.tool_call.call_id === 'string' ? m.tool_call.call_id : '')).filter(Boolean);
    const belongs = (r, calls) => (typeof r.call_id === 'string' && calls.includes(r.call_id)) || (typeof r.approval_id === 'string' && calls.some((id) => r.approval_id.endsWith('_' + id)));
    function receiptRow(r) {
      const id = r.approver_member_id;
      const name = id ? (id === d.me() ? jt('team.conv.you', 'You') : d.nameOf(id)) : jt('settings.team.activity.someone', 'Someone');
      const time = d.timeText(r.decided_at);
      if (r.outcome === 'answered') return resolved('allowed', jt('team.actions.answeredBy', 'Answered by {name} · {time}', { name, time }));
      if (r.outcome === 'expired') return resolved('withdrawn', jt('team.actions.expired', 'Expired at {time}: nobody answered in time.', { time }));
      const prompter = r.prompter_member_id && r.prompter_member_id !== id ? d.nameOf(r.prompter_member_id) : '';
      return d.receiptHtml({ outcome: r.outcome, approver: name, prompter, time, asked: '', rule: '', failed: '' });
    }
    function under(item) {
      if (!item || item.kind !== 'turn') return '';
      const list = receipts();
      const calls = list.length ? callIdsOf(item) : [];
      const mine = calls.length ? list.filter((r) => belongs(r, calls)) : [];
      return mine.length ? '<div class="team-conv__receipts team-conv__receipts--turn">' + mine.map(receiptRow).join('') + '</div>' : '';
    }

    const iconButton = (act, label, why, svg) => actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: label, title: why || label, disabled: Boolean(why), ariaHaspopup: 'menu',
      dataset: { 'conv-act': act }, trustedHtml: svg });
    function headHtml() {
      if (d.board) return '';
      const handWhy = writeBlock() || (d.driver() === d.me() ? '' : jt('team.actions.handDriver', 'Only the member who is driving can hand the seat on.'));
      return iconButton('ask', jt('team.actions.ask', 'Ask a teammate'), writeBlock(), ASK_ICON) + iconButton('hand', jt('team.actions.hand', 'Hand to…'), handWhy, HAND_ICON);
    }
    // A reader's card has no controls (D10); the head's Ask stays greyed.
    function askHtml(a) {
      if (d.role() === 'reader') return '';
      const label = jt('team.actions.askApproval', 'Ask a teammate…');
      const why = writeBlock();
      return '<p class="team-conv-ask">' + actionButton({ label, variant: 'ghost', size: 'sm', title: why || jt('team.actions.askApprovalTitle', 'Ask another member to decide this approval'), disabled: Boolean(why),
        ariaHaspopup: 'menu', dataset: { 'conv-act': 'ask', 'approval-id': String(a.approval_id || '') } }) + '</p>';
    }

    function onContextMenu(event) {
      const row = rowAt(event.target);
      if (!row || event.defaultPrevented || event.target.closest(KEEP_DEFAULT)) return;
      const selection = doc.getSelection?.();
      if (selection && !selection.isCollapsed && String(selection).trim()) return;
      if (openRowMenu(row, { x: event.clientX, y: event.clientY })) event.preventDefault();
    }
    function onKeydown(event) {
      const target = event.target;
      const p = live.panel;
      if (p && target?.closest?.('[data-conv-act-panel]')) {
        if (event.key === 'Escape' || event.key === 'Esc') { event.preventDefault(); event.stopPropagation(); closePanel(); return; }
        if (p.kind === 'edit' && target.tagName === 'TEXTAREA' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void redo(); }
        return;
      }
      if (live.menu || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
      const row = rowAt(target);
      if (row && row === target && openRowMenu(row, null)) event.preventDefault();
    }
    function onInput(event) {
      if (live.panel && event.target?.closest?.('[data-conv-act-panel="edit"] textarea')) live.panel.value = event.target.value;
    }
    function onClick(event) {
      const target = event.target?.closest?.('[data-conv-act]');
      if (!target || target.disabled || !d.root.contains(target)) return;
      switch (target.dataset.convAct) {
        case 'ask': void pick(target, 'ask', target.dataset.approvalId || ''); return;
        case 'hand': void pick(target, 'hand', ''); return;
        case 'redo-go': case 'edit-save': void redo(); return;
        case 'redo-branch': if (live.panel) { const id = live.panel.answerId; closePanel(); void branch(id); } return;
        case 'panel-cancel': closePanel(); return;
        default:
      }
    }
    const listeners = [['contextmenu', onContextMenu], ['keydown', onKeydown], ['input', onInput], ['click', onClick]];
    for (const [type, handler] of listeners) d.root.addEventListener(type, handler);

    return {
      headHtml, askHtml, under, handed,
      underKey: () => { receipts(); return live.key; },
      // A decision drawn under its turn: the client's copy is not drawn below.
      placed: (approvalId) => { receipts(); return live.placed.has(approvalId); },
      mark(el) { if (live.panel && !panelEl() && el.querySelector(ROW)) mount(false); },
      refresh() { live.members = null; },
      dispose() {
        live.disposed = true;
        live.panel = null;
        for (const [type, handler] of listeners) d.root.removeEventListener(type, handler);
        if (live.menu) menuApi()?.hide?.({ restoreFocus: false });
        if (live.toast) { d.timers.clear(live.toast.timer); live.toast.el.remove(); live.toast = null; }
      },
    };
  }

  return { createActions };
});
