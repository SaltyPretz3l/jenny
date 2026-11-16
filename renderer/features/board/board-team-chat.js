/* renderer/features/board/board-team-chat.js - the team project's conversation in the Board's chat column (UMD, global rendererBoardTeamChat).
 *
 * Row 151 slice T7 (D30), the approved mockup's screen A. On a team project, while the chat column is open, `ctx.chatHost` holds one
 * element of this file: an `aside.ide-chat-dock` with
 *  - a header: a button with the current conversation's title and a chevron (it opens the project's conversations, newest first, and
 *    "New conversation", in the app's context menu) and the `Collapse chat` action;
 *  - the conversation itself, drawn by the Team tab's `createConversation` into the body, fed the same pushes and disposed the same way.
 *    It draws its own head (who is driving and who else has this board open, from the team source's presence), thread and message
 *    box: nothing here repeats them. With no conversation, the line of who else has the board open is this file's. A turn sent from here names the open
 *    board (`board.id`) and the box says what the board is shared with (`board.hint`).
 * Which conversation shows is the one last chosen for the project in this window (memory only), else the project's newest, else none: then
 * a line and a New conversation button. At most one conversation is mounted: the one shown is disposed before another mounts, when the
 * column collapses, when the project stops being a team project, and on dispose(). Titles and names reach the page through textContent.
 * For a keyboard and a screen reader: the picker button opens on ArrowDown too; a polite live region of the column says who is viewing, once per
 * change; and when what had the focus goes (the conversation shown deleted, the column
 * collapsed or left with the picker open), the focus moves to the project button, or the page's first control, once the page has drawn.
 *
 * createTeamChat({ ctx, windowRef, jt, data }) -> { sync(), focus(), rescue(), push(change), refresh(change), dispose() }. sync() does nothing when the
 * project, the column and the conversation shown are unchanged. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardTeamChat = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHEVRON = '<svg class="board-team-conv__chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>';
  const HISTORY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>';
  const COLLAPSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';
  const chosen = new WeakMap(); // window -> Map(team|project -> session id): the conversation last chosen (memory only)
  const ROWS_MAX = 200; // conversations offered in the picker, newest first
  const VIEWERS_MAX = 8; // the most members a team has

  function createTeamChat({ ctx, windowRef, jt, data }) {
    const doc = ctx.document;
    let disposed = false;
    let aside = null;
    let trigger = null;
    let historyBtn = null;
    let label = null;
    let viewersEl = null;
    let liveEl = null;
    let lost = false; // the focus was in what unmount removed: the next sync gives it to a control that is left
    let body = null;
    let emptyEl = null;
    let conv = null;
    let key = ''; // team|project the aside is built for
    let session = ''; // the conversation mounted ('' when none)
    let boardSeen = '';
    let fresh = ''; // a conversation just created, before the list names it
    let source = null;
    let offPresence = null;
    let pickerOpen = false;

    const inv = () => globalThis.inventory || windowRef.inventory || {};
    const conversations = () => windowRef.rendererTeamProjectConversation || null;
    const remembered = () => { if (!chosen.has(windowRef)) chosen.set(windowRef, new Map()); return chosen.get(windowRef); };
    const reason = () => { const team = ctx.getTeamSource(); return team ? String(team.whyNot('create') || '') : ''; };
    const untitled = () => jt('team.projects.untitled', 'Untitled conversation');
    const stamp = (row) => { const value = row.updated_at != null ? row.updated_at : row.created_at; const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : 0; };

    function rowsOf(teamId, projectId) {
      const store = data.projectStore();
      let all;
      try { all = store ? store.conversationsOf(teamId, projectId) : []; } catch (_error) { all = []; }
      const seen = new Set();
      const rows = (Array.isArray(all) ? all : []).filter((row) => {
        if (!row || typeof row.session_id !== 'string' || !row.session_id || seen.has(row.session_id)) return false;
        seen.add(row.session_id);
        return true;
      });
      return rows.sort((a, b) => stamp(b) - stamp(a)).slice(0, ROWS_MAX);
    }
    function currentOf(teamId, projectId, rows) {
      if (fresh && rows.some((row) => row.session_id === fresh)) fresh = ''; // the list names it now: a conversation like any other
      const want = remembered().get(`${teamId}|${projectId}`);
      if (want && (want === fresh || rows.some((row) => row.session_id === want))) return want;
      return rows.length ? rows[0].session_id : '';
    }
    function titleOf(rows, id) {
      const row = rows.find((r) => r.session_id === id);
      return (row && data.clean(row.title)) || untitled();
    }

    /* ------------------------------------------------------------ the element */

    function build(project) {
      aside = doc.createElement('aside');
      aside.className = 'ide-chat-dock board-team-conv';
      aside.setAttribute('aria-label', jt('board.team.convLabel', 'Conversation with Jenny'));
      aside.setAttribute('data-board-team-conv', '');
      aside.insertAdjacentHTML('beforeend', '<header class="ide-chat-dock-header board-team-conv__head"><div class="ide-chat-dock-session-control"></div>'
        + '<div class="ide-chat-dock-header-actions"></div></header><p class="board-team-conv__viewers" hidden></p><div class="sr-only" role="status" aria-live="polite" data-board-team-conv="live"></div><div class="board-team-conv__body"></div>');
      aside.querySelector('.ide-chat-dock-session-control').insertAdjacentHTML('beforeend', inv().actionButton({ plain: true, className: 'ide-chat-dock-session-trigger', title: jt('board.team.conversations', 'Conversations'),
        ariaHaspopup: 'menu', ariaExpanded: false, dataset: { 'board-team-conv': 'pick' }, trustedHtml: '<span class="ide-chat-dock-label"></span>' + CHEVRON }));
      const collapse = jt('board.team.collapseChat', 'Collapse chat');
      const history = jt('board.team.history.button', 'History');
      aside.querySelector('.ide-chat-dock-header-actions').insertAdjacentHTML('beforeend', inv().actionButton({ plain: true, className: 'ide-chat-dock-action', ariaLabel: history,
        title: history, dataset: { 'board-team-conv': 'history' }, trustedHtml: HISTORY }) + inv().actionButton({ plain: true, className: 'ide-chat-dock-action',
        ariaLabel: collapse, title: collapse, dataset: { 'board-team-conv': 'collapse' }, trustedHtml: COLLAPSE }));
      historyBtn = aside.querySelector('[data-board-team-conv="history"]');
      trigger = aside.querySelector('[data-board-team-conv="pick"]');
      label = trigger.querySelector('.ide-chat-dock-label');
      viewersEl = aside.querySelector('.board-team-conv__viewers');
      liveEl = aside.querySelector('[data-board-team-conv="live"]');
      body = aside.querySelector('.board-team-conv__body');
      aside.addEventListener('click', onClick);
      aside.addEventListener('keydown', onKeyDown);
      ctx.chatHost.appendChild(aside);
      key = `${project.team.id}|${project.id}`;
    }

    function unmount() {
      if (aside && (aside.contains(doc.activeElement) || pickerOpen)) lost = true;
      if (conv) { conv.dispose(); conv = null; }
      if (typeof offPresence === 'function') offPresence();
      offPresence = null;
      source = null;
      if (pickerOpen) { const menu = data.contextMenu(); if (menu) menu.hide({ restoreFocus: false }); pickerOpen = false; }
      if (aside) { aside.removeEventListener('click', onClick); aside.removeEventListener('keydown', onKeyDown); aside.remove(); }
      aside = trigger = historyBtn = label = viewersEl = liveEl = body = emptyEl = null;
      key = '';
      session = '';
      boardSeen = '';
      if (lost) void Promise.resolve().then(rescue);
    }

    // What had the focus is gone: the project button, or the first control of the page, once the page has drawn what it draws.
    function rescue() {
      if (!lost || disposed) return;
      if (doc.activeElement && doc.activeElement !== doc.body) { lost = false; return; }
      const root = ctx.rootEl;
      const target = root && (root.querySelector('[data-board-action="project"]') || root.querySelector('button:not(:disabled)'));
      if (!target) return;
      lost = false;
      target.focus({ preventScroll: true });
    }

    /* ------------------------------------------------------------ who else is on the board */

    function viewersText() {
      const team = ctx.getTeamSource();
      if (!team) return '';
      const self = data.selfId(team.scope.teamId);
      const viewers = (team.presence.get() || {}).viewers;
      // Each member once, as many as a team has: the host's word for 10,000 viewers is not a count to say.
      const ids = Array.from(new Set((Array.isArray(viewers) ? viewers : []).filter((id) => typeof id === 'string' && id && id !== self))).slice(0, VIEWERS_MAX);
      const names = ids.slice(0, 3).map((id) => data.iso(data.nameOf(id) || jt('board.team.formerMember', 'a former member')));
      if (!ids.length) return '';
      if (ids.length === 1) return jt('board.team.viewing1', '{name} and you are viewing', { name: names[0] });
      if (ids.length === 2) return jt('board.team.viewing2', '{a}, {b} and you are viewing', { a: names[0], b: names[1] });
      return jt('board.team.viewingMore', '{a}, {b} and {count} more are viewing', { a: names[0], b: names[1], count: ids.length - 2 });
    }
    // The line of its own only while no conversation is mounted: a conversation says it in its head, with who is driving.
    function drawViewers() {
      if (!viewersEl) return;
      const text = viewersText();
      const changed = viewersEl.textContent !== text;
      if (changed) { viewersEl.textContent = text; liveEl.textContent = text; }
      viewersEl.hidden = !text || Boolean(conv);
      const project = ctx.getProject();
      if (changed && conv && project && project.team) conv.update({ type: 'board', team_id: project.team.id });
    }
    function watchPresence() {
      const team = ctx.getTeamSource();
      if (team === source) return;
      if (typeof offPresence === 'function') offPresence();
      offPresence = null;
      source = team;
      if (team) offPresence = team.presence.subscribe(drawViewers);
    }

    /* ------------------------------------------------------------ the conversation and its picker */

    function mountConversation(project, id) {
      const had = body.contains(doc.activeElement);
      if (conv) { conv.dispose(); conv = null; }
      body.textContent = '';
      emptyEl = null;
      session = id;
      const store = data.projectStore();
      const made = conversations();
      if (!id) { drawEmpty(); if (had) focusIn(); return; }
      if (!store || !made) return;
      conv = made.createConversation({ root: body, teamId: project.team.id, projectId: project.id, sessionId: id, store, ctx: () => data.ctxOf(project.team.id),
        board: { id: () => String(ctx.getOpenBoardId() || ''), viewers: viewersText,
          hint: jt('board.team.convHint', 'Jenny can see this board from here. The host and the computer that runs the model can read it.') } });
      boardSeen = String(ctx.getOpenBoardId() || '');
      drawViewers();
      if (had) focusIn();
    }

    function drawEmpty() {
      const why = reason();
      body.insertAdjacentHTML('beforeend', '<p class="board-team-conv__empty"></p>' + inv().actionButton({ variant: 'secondary', size: 'sm', className: 'board-team-conv__new',
        label: jt('board.team.newConversation', 'New conversation'), disabled: Boolean(why), title: why || jt('board.team.newConversation', 'New conversation'), dataset: { 'board-team-conv': 'new' } }));
      body.querySelector('.board-team-conv__empty').textContent = jt('board.team.noConversation', 'No conversation in this project yet.');
      emptyEl = body.querySelector('.board-team-conv__empty');
    }

    // History needs a board to read; with none open the button says so.
    function drawHistoryButton() {
      const none = !ctx.getOpenBoardId();
      const title = none ? jt('board.team.history.none', 'Open a board to see its history.') : jt('board.team.history.buttonTitle', 'History: who changed this board');
      if (historyBtn.disabled !== none) historyBtn.disabled = none;
      if (historyBtn.title !== title) historyBtn.title = title;
    }

    function draw(project) {
      watchPresence();
      drawHistoryButton();
      drawViewers();
      const rows = rowsOf(project.team.id, project.id);
      const id = currentOf(project.team.id, project.id, rows);
      const title = id ? titleOf(rows, id) : jt('board.team.conversations', 'Conversations');
      if (label.textContent !== title) { label.textContent = title; trigger.setAttribute('title', title); }
      const stale = !id && emptyEl && emptyEl.nextElementSibling && emptyEl.nextElementSibling.disabled !== Boolean(reason());
      if (id !== session || (!id && !emptyEl) || stale) mountConversation(project, id);
      else if (conv && String(ctx.getOpenBoardId() || '') !== boardSeen) { boardSeen = String(ctx.getOpenBoardId() || ''); conv.update({ type: 'board', team_id: project.team.id }); }
    }

    function choose(project, id) {
      remembered().set(`${project.team.id}|${project.id}`, id);
      if (aside) draw(project);
    }

    async function create(project) {
      const store = data.projectStore();
      if (!store) return;
      const answer = await store.call('conversationCreate', { team_id: project.team.id, project_id: project.id });
      if (disposed || key !== `${project.team.id}|${project.id}`) return;
      if (!answer.ok) { ctx.notify(data.ctxOf(project.team.id).errorText(answer.error), { tone: 'warning' }); return; }
      fresh = answer.session.session_id;
      store.reread(project.team.id);
      choose(project, fresh);
    }

    // The caret goes to the message box, or to New conversation when there is no conversation, or to the picker.
    function focusIn() {
      if (!aside) return;
      const target = conv ? conv.focusTarget() : aside.querySelector('[data-board-team-conv="new"]:not(:disabled)') || trigger;
      if (target && typeof target.focus === 'function') target.focus();
    }

    function openPicker(project) {
      const menu = data.contextMenu();
      if (!menu || !trigger) return;
      if (pickerOpen) { menu.hide(); return; }
      const rows = rowsOf(project.team.id, project.id);
      const current = currentOf(project.team.id, project.id, rows);
      const why = reason();
      const items = rows.map((row) => ({ label: titleOf(rows, row.session_id), value: `conv:${row.session_id}`, checked: row.session_id === current, action: () => choose(project, row.session_id) }));
      items.push({ label: jt('board.team.newConversation', 'New conversation'), value: 'new', disabled: Boolean(why), description: why, action: () => create(project) });
      pickerOpen = true;
      trigger.setAttribute('aria-expanded', 'true');
      menu.show({ rootEl: aside, anchorEl: trigger, placement: 'below', focusChecked: true, ariaLabel: jt('board.team.convMenuLabel', 'Conversations'), restoreFocusTo: trigger,
        heading: jt('board.team.convsIn', 'Conversations in {project}', { project: data.iso(project.name) }),
        onHide: () => { pickerOpen = false; if (trigger) trigger.setAttribute('aria-expanded', 'false'); }, items });
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-board-team-conv]') : null;
      const project = ctx.getProject();
      if (!target || target === aside || target.disabled || !project || !project.team) return;
      switch (target.getAttribute('data-board-team-conv')) {
        case 'pick': openPicker(project); break;
        case 'new': void create(project); break;
        case 'history': data.openHistory(); break;
        case 'collapse': ctx.chat.setOpen(false); sync(); break;
        default:
      }
    }

    // ArrowDown on the picker button opens it, as on any menu button; Enter and Space are the button's own click.
    function onKeyDown(event) {
      const project = ctx.getProject();
      if (event.key !== 'ArrowDown' || event.defaultPrevented || !project || !project.team || !trigger || !event.target || !event.target.closest) return;
      if (event.target.closest('[data-board-team-conv="pick"]') !== trigger || pickerOpen) return;
      event.preventDefault();
      openPicker(project);
    }

    function sync() {
      if (disposed) return;
      const project = ctx.getProject();
      const team = project && project.team;
      if (!team || !ctx.chat.isOpen() || !data.projectStore() || !conversations() || !ctx.chatHost) { unmount(); return; }
      if (!aside || key !== `${team.id}|${project.id}`) { unmount(); build(project); }
      draw(project);
      aside.hidden = data.historyOpen(); // History takes the column; the conversation stays mounted under it
    }

    return {
      sync,
      /** The caret goes to the message box, or to New conversation when there is no conversation. */
      focus: focusIn,
      rescue,
      /** The project's conversations a chat card may name, newest first: [{ id, title }]. */
      list() {
        const project = ctx.getProject();
        if (disposed || !project || !project.team) return [];
        const rows = rowsOf(project.team.id, project.id);
        return rows.map((row) => ({ id: row.session_id, title: titleOf(rows, row.session_id) }));
      },
      /** Makes one of the project's conversations the one the column shows; false when the project has no such conversation. */
      pick(id) {
        const project = ctx.getProject();
        if (disposed || !project || !project.team || !rowsOf(project.team.id, project.id).some((row) => row.session_id === id)) return false;
        choose(project, id);
        return true;
      },
      /** A conversation's push from the project store, to the one shown. */
      push(change) {
        const project = ctx.getProject();
        if (conv && project && project.team && change.team_id === project.team.id && change.session_id === session) conv.push(change.push);
      },
      /** The project list or the roster changed: the conversations offered, the title and the names are drawn again. */
      refresh(change) {
        const project = ctx.getProject();
        if (!aside || !project || !project.team || change.team_id !== project.team.id) return;
        draw(project);
        if (conv) conv.update(change);
      },
      dispose() {
        if (disposed) return;
        unmount();
        disposed = true;
      },
    };
  }

  return { createTeamChat };
});
