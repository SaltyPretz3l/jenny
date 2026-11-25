/* Team tab: a shared conversation drawn as a channel (row 123, slice 3-10; row 171). The desktop chat pane cannot host
 * one: its approval buttons call the desktop backend. The frame's markup is renderer-team-project-channel.js's.
 *
 * Open: `conversationOpen` answers the snapshot (the last 20 messages); then the store hands on this conversation's
 * pushes: `conversation_event` (the stream, the lease, decisions), `snapshot` (main reads one after a resync, a saved
 * prompt, a tool call or its result, an approval, a question, a rename or a turn's end), `viewers`, `lease`, `closed`
 * and `rule_answered`. Leaving the page, the tab or the team disposes it, which sends `conversationClose`.
 *
 * Member messages are #team rows; Jenny has one row per turn with the chip under her name (Stop beside it while it
 * runs, Send again after a failure). The chip opens the turn's transcript on the right (renderer-team-turn-pop.js).
 * The running turn's row has its own region, patched in place: its words are parsed again at most every 100 ms, its
 * chip each second while it shows a time. Questions and approvals stand in that row and in the popover. A turn's state
 * changes (not its clock) are said in a polite live region. The view stays pinned to the bottom unless scrolled up.
 *
 * Every id this view draws starts with its own prefix (two views in one document never share one) and dispose empties the root. The
 * box is the #team composer, built once (the field is never replaced, so typing and IME survive); drafts are kept
 * per conversation while the app runs and on this PC (renderer-team-project-drafts.js, never the host); while the team is
 * not online Send waits and the text stays, and nothing is sent when it comes back (D3). Whoever may send now may queue up to three messages while a turn runs
 * (renderer-team-project-queue.js): one goes after a clean end and the snapshot after it; Stop, a failure, a takeover
 * or leaving the view pauses them. Who drives comes from `control`, `control_changed` and `lease` (the parts' lease).
 *
 * Caps: 400 messages, 32 viewers, 16 drafts, 3 queued, 64 answered questions and turn times. `createConversation({ root,
 * teamId, projectId, sessionId, store, ctx(), clock, timers, frames, renders, board })` -> { push, update, dispose,
 * focusTarget, resources }. `board` (row 151 T7, the Board's conversation column): { id(), hint, viewers() }; a sent
 * message then carries `board_id`, the head is one line and the popover covers the column. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-box'), require('./renderer-team-project-column'), require('./renderer-team-message-row'), require('./renderer-team-store'),
      require('./renderer-team-project-timeline'), require('./renderer-team-project-conversation-parts'), require('./renderer-team-project-rows'), require('./renderer-team-project-queue'),
      require('./renderer-team-turn-pop'), require('./renderer-team-project-channel'), require('./renderer-team-conversation-controls'), require('./renderer-team-project-drafts'));
    return;
  }
  root.rendererTeamProjectConversation = factory(root.rendererTeamProjectBox, root.rendererTeamProjectColumn, root.rendererTeamMessageRow, root.rendererTeamStore, root.rendererTeamProjectTimeline,
    root.rendererTeamProjectConversationParts, root.rendererTeamProjectRows, root.rendererTeamProjectQueue, root.rendererTeamTurnPop, root.rendererTeamProjectChannel, root.rendererTeamConversationControls, root.rendererTeamProjectDrafts);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (box, column, msgRow, teamStores, tl, parts, channelRows, queues, turnPop, channel, controls, draftStore) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const CAPS = Object.freeze({ messages: tl.LIMITS.held, viewers: 32, drafts: 16 });
  const ENDS = tl.ENDS;
  const LIVE_EVERY_MS = 100;
  const TICK_MS = 1000;
  const PIN_SLACK = 24;
  const RENAME_ID = parts.RENAME_ID;
  const BOX_WRITES = ['above', 'locked', 'left', 'bar', 'below'];
  const NO_BOX = Object.freeze({ above: '', locked: '', composer: false, left: '', bar: '', below: '', lifecycle: 'idle' });
  // What was typed and not sent, per conversation, while the app runs.
  const drafts = new Map();

  function inv() { return globalThis.inventory || {}; }
  const remember = parts.remember;
  const defaultFrames = { request: (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)),
    cancel: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)) };
  const defaultTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
  const HAND_WAIT_MS = 1500; // F18: how long this client's own take may take to answer before a seat reads as handed
  const keyOf = (el) => el.id || [el.dataset.projectAction || '', el.dataset.turnId || el.dataset.queueId || el.dataset.messageId || ''].join('|');
  // The name the team engine answers under (server/team/pool-gateway.js POOL_MODEL_ALIAS): it names no model.
  const POOL_ALIAS = 'team-pool';
  // Row 175 item 8 (find): the app's global (the Team scripts load it), or under Node the file; without it the head has no find.
  const NO_FIND = { head: () => ({ open: false, html: '' }), attach() {}, focused: () => false, open: () => false, refresh() {}, dispose() {} };
  function findModule() { if (globalThis.rendererTeamProjectFind) return globalThis.rendererTeamProjectFind; try { return require('./renderer-team-project-find'); } catch (_error) { return null; } }
  // Row 175 item 1: path chips, the Files button and @file (the app's global, or under Node the file); without it none of them is drawn.
  const NO_PATHS = { adopt: () => false, mark() {}, enabled: () => false, refresh() {}, headButton: () => '', dispose() {} };
  function pathsModule() { if (globalThis.rendererTeamProjectPaths) return globalThis.rendererTeamProjectPaths; try { return require('./renderer-team-project-paths'); } catch (_error) { return null; } }
  // Row 175 items 5, 6, 11, F13, F18: the message menu, redo, branch, ask, hand-off and placed receipts; without it none of them.
  const NO_ACTS = { headHtml: () => '', askHtml: () => '', under: () => '', underKey: () => '', placed: () => false, handed() {}, mark() {}, refresh() {}, dispose() {} };
  function actsModule() { if (globalThis.rendererTeamProjectActions) return globalThis.rendererTeamProjectActions; try { return require('./renderer-team-project-actions'); } catch (_error) { return null; } }
  // Row 175 item 7: plan mode (the app's global, or under Node the file); without it the Plan chip and the plan row are not drawn.
  const NO_PLAN = { visible: (x) => x, blank: (x) => x, join: (x) => x, box: () => ({}), on: () => false, version: () => 0, footHtml: () => '', popHtml: () => '', cardsHtml: () => '', click: () => false, key: () => false, decided: () => false };
  function planModule() { if (globalThis.rendererTeamProjectPlan) return globalThis.rendererTeamProjectPlan; try { return require('./renderer-team-project-plan'); } catch (_error) { return null; } }
  // OD-2: whether the project's rules are paused (renderer-team-project-rules.js); without it a card offers no always button.
  const NO_WATCH = { paused: () => true, check() {} };
  const rulesModule = () => globalThis.rendererTeamProjectRules || (() => { try { return require('./renderer-team-project-rules'); } catch (_error) { return null; } })();
  let instances = 0; // each view draws its ids under its own prefix
  const standingText = () => jt('team.conv.standing', 'The team host and the member whose PC answers can read this conversation.');

  function createConversation({ root, teamId, projectId, sessionId, store, ctx, clock = Date.now, timers = defaultTimers, frames = defaultFrames, renders = { log: 0, live: 0, box: 0, head: 0, pop: 0 }, board = null }) {
    const ids = { team_id: teamId, session_id: sessionId };
    const idPrefix = 'tc' + (instances += 1) + '-';
    const draftKey = teamId + '\u0000' + sessionId;
    const s = { snapshot: null, error: '', closed: '', viewers: [], stream: null, answeredQ: new Map(), thought: new Map(), busy: new Set(), confirm: false, takenBy: '', note: '',
      noteWait: false, disposed: false, popTurn: '', liveTurn: '', settling: false, lastEnd: '', announced: '' };
    const last = { head: null, log: null, live: null, queued: null };
    const lastBox = { above: null, locked: null, left: null, bar: null, below: null };
    const liveCache = { text: null, at: -Infinity };
    let tick = null;
    let ticking = false;
    let opening = false;
    let retried = false;
    let pinned = true;

    const c = () => ctx();
    const boardNow = () => (board && typeof board.id === 'function' ? String(board.id() || '') : '');
    const me = () => c().team.member_id;
    const projectRow = () => store.project(teamId, projectId);
    const role = () => { const r = (projectRow() || {}).role; return r === 'owner' ? 'admin' : (r || 'reader'); };
    const owner = () => c().team.role === 'owner';
    const projectName = () => column.clean((projectRow() || {}).name);
    const named = () => column.clean((s.snapshot && s.snapshot.session.title) || ((store.conversationsOf(teamId, projectId) || []).find((r) => r.session_id === sessionId) || {}).title);
    const title = () => named() || jt('team.projects.untitled', 'Untitled conversation');
    const questionsIn = (snapshot) => (snapshot && Array.isArray(snapshot.pending_questions) ? snapshot.pending_questions : []);
    const asking = () => questionsIn(s.snapshot).filter((p) => !s.answeredQ.has(p.question_ref));
    const running = () => Boolean((s.stream && !s.stream.ended) || (s.snapshot && s.snapshot.active_turn && !ENDS.has(String(s.snapshot.active_turn.status || s.snapshot.active_turn.state || ''))));
    const streamId = () => (s.stream && !s.stream.ended && s.stream.id) || (s.snapshot && s.snapshot.active_turn && s.snapshot.active_turn.stream_id) || '';
    // Whoever may send now: a writer when they drive or nobody does. The same member may stop a turn and queue.
    const mayDrive = () => role() !== 'reader' && (!driver() || driver() === me());
    const markdown = (text) => msgRow.bodyHtml(text, [], null, root.ownerDocument);
    // The stream's words change ten times a second: they stay out of the shared markdown cache.
    const liveMarkdown = (text) => msgRow.bodyHtml(text, [], null, root.ownerDocument, { cachePolicy: 'bypass' });
    const errorText = (error) => c().errorText(error);
    const stores = () => teamStores || globalThis.rendererTeamStore;
    // A call for this conversation; null when the view was disposed before it answered.
    const call = async (method, payload) => { const answer = await store.call(method, { ...ids, ...payload }); return s.disposed ? null : answer; };
    const sendPayload = (prompt) => { const boardId = boardNow(); return boardId ? { prompt, board_id: boardId } : { prompt }; };

    // ------------------------------------------------------------ the controllers (the parts file says what each takes)

    const lease = parts.createLease({ timers, clock, reread: async () => { const answer = await call('conversationOpen'); if (answer && answer.ok) { take(answer.snapshot); draw(); } } });
    const driver = lease.driver;
    function setControl(control) { if (lease.set(control)) s.confirm = false; }
    // A saved answer names the pool's alias, not a model: the team's model stands in, else the one the shared GPUs offer.
    const modelName = (name) => (name === POOL_ALIAS ? parts.teamModel(stores(), teamId) || parts.oneModel(parts.poolNodes(stores(), teamId)) : name);
    const rows = channelRows.createRows({ nameOf: (id) => c().nameOf(id), markdown, liveMarkdown, timeText: msgRow.timeText, dayLabel: (key) => msgRow.dayLabel(key, clock()) });
    const history = parts.createHistory({ cap: CAPS.messages, read: (cursor) => call('conversationOpen', { before_message_id: cursor }), errorText });
    const plan = (planModule() ? planModule().createPlan : () => NO_PLAN)({ doc: root.ownerDocument, root, idPrefix, snapshot: () => s.snapshot, messages: () => history.messages(), me, role, mayDrive, driver, running: () => running() || s.settling,
      nameOf: (id) => c().nameOf(id), time: () => msgRow.timeText(clock()), timeText: msgRow.timeText, errorText, decide: (payload) => call('conversationDecide', payload), send: (prompt) => send(prompt), redraw: () => draw(),
      change: (patch) => run('prefs', 'conversationPreferences', patch), takeover: async () => { const a = await run('box', 'conversationControl', { action: 'takeover' }); if (a && a.ok) setControl({ member_id: me(), expires_at: 0 }); return Boolean(a && a.ok); } });
    const approvals = parts.createApprovals({ snapshot: () => plan.visible(s.snapshot), send: (payload) => call('conversationDecide', payload), me, mayAnswer: () => role() !== 'reader' && !s.disposed,
      youOr: (id) => (id === me() ? jt('team.conv.you', 'You') : c().nameOf(id)), nameOf: (id) => c().nameOf(id), errorText, timeText: () => msgRow.timeText(clock()), receiptHtml: box.receiptHtml,
      outcomeHtml: box.outcomeHtml, offersAllow: box.offersAllow, acted: () => { s.takenBy = ''; }, redraw: () => draw(),
      cardHtml: (a, state) => box.cardHtml(a, { role: role(), planMode: s.snapshot.session.plan_mode === true, paused: rulesWatch.paused(), projectName: projectName(), prompter: a.prompter_member_id ? c().nameOf(a.prompter_member_id) : '', askHtml: acts.askHtml(a),
        ...state }),
      rules: async () => { const answer = await store.call('projectRules', { team_id: teamId, project_id: projectId }); return s.disposed ? null : answer; }, sessionId, projectName });
    const pending = approvals.pending;
    const rulesWatch = (rulesModule() ? rulesModule().createPausedWatch : () => NO_WATCH)({ read: () => store.call('projectRules', { team_id: teamId, project_id: projectId }), clock, live: () => !s.disposed, redraw: () => draw() });
    // The host's answer settles a queued row even after this view went (a null would read "Not sent" for a posted one).
    const queue = queues.createQueue({ key: draftKey, send: (prompt) => store.call('conversationSend', { ...ids, ...sendPayload(prompt) }), errorText });
    // Row 172: the Tools chip and model pill (the conversation's preferences) and the quiet lines of their changes.
    const prefs = controls.createControls({ root, idPrefix, nameOf: (id) => c().nameOf(id), projectName, role, mayDrive, driver, running: () => running() || s.settling, busy: () => s.busy.has('prefs'),
      session: () => (s.snapshot && s.snapshot.session) || null, pool: () => parts.poolRead(stores(), teamId), change: (patch) => run('prefs', 'conversationPreferences', patch), redraw: () => drawBox(), timeText: msgRow.timeText });
    const ch = channel.createChannel({ s, history, approvals, queue, rows, clock, me, nameOf: (id) => c().nameOf(id), role, mayDrive, running, streamId, asking, projectName, modelName,
      liveText: () => liveCache.text, notes: () => prefs.notes(history.messages()), under: (item) => acts.under(item), underKey: () => acts.underKey(), placed: (id) => acts.placed(id), plan, idPrefix });

    // ------------------------------------------------------------ markup

    // Why this member cannot rename now: a reader, or another member drives.
    function renameBlock() {
      const d = driver();
      return role() === 'reader' ? jt('team.projects.renameReader', 'Only writers and admins can rename')
        : d && d !== me() ? jt('team.conv.renameDriving', '{name} is driving. You can rename when their turn ends', { name: c().nameOf(d) }) : '';
    }
    const headHtml = () => parts.headHtml({ board, driver: driver(), me: me(), nameOf: c().nameOf, viewers: s.viewers, projectName: projectName(), titleHtml: () => titles.html(), standing: standingText(), find: find.head(), files: paths.headButton(), acts: acts.headHtml() });

    // Nobody shares a GPU: the team is connected and the store has read its GPU list, which is empty (an unread list claims nothing).
    // The Board's column cannot open Settings, so it gets the sentence alone.
    function gpuState() {
      const team = c().team;
      const nodes = parts.poolNodes(stores(), teamId);
      if (!team || team.state !== 'online' || !nodes || nodes.length) return null;
      return { team: column.clean(team.team_name, 64) || jt('team.conv.thisTeam', 'this team'), canShare: !board && team.role !== 'read_only' };
    }
    // '' while the team is online; else the box says when it sends and Send waits (row 175 F7).
    const connection = () => { const state = c().team.state; return state === 'online' ? '' : state === 'offline' ? 'offline' : 'reconnecting'; };
    function boxState() {
      return { connection: connection(), batch: approvals.batch(), role: role(), owner: owner(), driver: driver(), me: me(), running: running() || s.settling, approval: pending().length > 0, confirm: s.confirm, takenBy: s.takenBy,
        busy: s.busy.has('box'), note: s.note, nameOf: c().nameOf, boardHint: board && boardNow() ? String(board.hint || '') : '', gpu: gpuState(), mayQueue: mayDrive(),
        board: Boolean(board), prefs: plan.join(prefs.box()), files: paths.enabled(), idPrefix, ...plan.box() };
    }

    // ------------------------------------------------------------ drawing

    root.innerHTML = parts.channelShellHtml({ board, fieldHtml: box.composerFieldHtml(named(), idPrefix), standing: standingText() });
    const q = (selector) => root.querySelector(selector);
    const part = (name) => q('[data-conv-box="' + name + '"]');
    const region = (name) => q('[data-conv-region="' + name + '"]');
    const regions = { head: region('head'), log: region('log'), live: region('live'), queued: region('queued'), pop: region('pop'), announce: region('announce'), box: region('box') };
    const boxEls = { above: part('above'), shell: part('shell'), locked: part('locked'), composer: part('composer'), toolbar: part('toolbar'), left: part('left'), bar: part('bar'), below: part('below'),
      field: q('[id="' + idPrefix + box.BOX_ID + '"]') };
    const scroller = q('.team-conv__scroll');
    const jump = q('.chat-jump-latest');
    const copier = parts.createCopy({ timers, view: root.ownerDocument.defaultView });
    const questions = parts.createQuestions({ log: root, asking, send: call, mayAnswer: () => role() !== 'reader', errorText,
      answered: (ref) => { remember(s.answeredQ, ref, true); draw(); focusBox(); } });
    const titles = parts.createTitle({ head: regions.head, named, shown: title, reason: renameBlock, rename: (next) => call('conversationRename', { title: next }), errorText, redraw: () => { drawHead(); drawBox(); },
      timers, maxLength: column.TITLE_MAX, idPrefix,
      renamed: (next) => { if (s.snapshot) s.snapshot = { ...s.snapshot, session: { ...s.snapshot.session, title: next } }; } });
    const pop = parts.createPop({ s, ch, popper: () => popper, host: regions.pop, root, scroller, board, questions, asking, mayAnswer: () => role() !== 'reader', draw, earlier, stop, focusBox, renders });
    const paths = (pathsModule() ? pathsModule().createPaths : () => NO_PATHS)({ root, teamId, projectId, projectName, off: Boolean(board), call: (method, payload) => store.call(method, payload),
      files: () => typeof store.team === 'function' && Boolean((store.team(teamId) || {}).filesSupported), field: () => boxEls.field, shell: () => boxEls.shell });
    const popper = turnPop.createTurnPop({ host: regions.pop, doc: root.ownerDocument, markdown, liveMarkdown, sessionKey: draftKey, onAction: (kind) => pop.action(kind), paths, idPrefix });
    // A match in Jenny's work opens its turn and that one row; the focus stays in the field (the popover is never focused here).
    const find = (findModule() ? findModule().createFind : () => NO_FIND)({ root, idPrefix, turns: () => ch.view().turns, markdown, toLocal: turnPop.toLocalMessages, more: () => history.more(), earlier,
      redrawHead: () => drawHead(), openTurn: (id, ref) => { if (s.popTurn !== id) { s.popTurn = id; draw(); } popper.revealRow(ref); } });
    const acts = (actsModule() ? actsModule().createActions : () => NO_ACTS)({ root, teamId, projectId, sessionId, board: Boolean(board), onOpenConversation: board && typeof board.onOpenConversation === 'function' ? board.onOpenConversation : null, call: (method, payload) => store.call(method, payload), timers, me, role, driver,
      running: () => running() || s.settling, online: () => !connection(), nameOf: (id) => c().nameOf(id), projectName, messages: () => history.messages(), view: () => ch.view(), snapshot: () => s.snapshot,
      viewers: () => s.viewers, openTurn: (id) => pop.open(id), errorText, timeText: msgRow.timeText, receiptHtml: box.receiptHtml, promptMax: box.PROMPT_MAX, redraw: () => draw() });
    jump.toggleAttribute('inert', true);
    const kept = draftStore.createDrafts({ memory: drafts, key: draftKey, cap: CAPS.drafts, timers, call: (method, payload) => store.call(method, { ...ids, ...payload }) });
    boxEls.field.value = kept.text();
    void kept.restore((text) => { if (!boxEls.field.value) boxEls.field.value = text; });

    function focusTarget() {
      return (!boxEls.composer.hidden && boxEls.field) || regions.box.querySelector('button:not([disabled])') || q('.team-back');
    }
    function focusBox() { const el = focusTarget(); if (el && typeof el.focus === 'function') el.focus({ preventScroll: true }); }
    const focusedIn = (el) => { const active = root.ownerDocument.activeElement; const key = active && el.contains(active) ? keyOf(active) : ''; return key === '|' ? '' : key; };
    // A write that took the focused control away: the same control again, else what replaced it (a confirm's
    // Cancel), else the box; never the page.
    function refocus(el, had) {
      if (!had) return;
      const doc = root.ownerDocument;
      const active = doc.activeElement;
      if (active && active !== doc.body && root.contains(active) && !active.closest('[hidden]')) return;
      const same = had === idPrefix + box.BOX_ID ? null : Array.from(el.querySelectorAll('[id], [data-project-action], .team-msg')).find((one) => !one.disabled && keyOf(one) === had);
      const next = same || el.querySelector('[data-project-action="takeover-cancel"]') || focusTarget();
      if (!next || typeof next.focus !== 'function') return;
      next.focus({ preventScroll: true });
      if (next.id === idPrefix + RENAME_ID && typeof next.setSelectionRange === 'function') next.setSelectionRange(next.value.length, next.value.length);
    }
    function write(name, html, counter) {
      if (last[name] === html) return;
      const had = focusedIn(regions[name]);
      // The running turn's row and the queued rows are patched in place: their buttons survive the stream's repaints.
      if (name === 'live' || name === 'queued') channel.patch(regions[name], html); else regions[name].innerHTML = html;
      last[name] = html;
      paths.mark(regions[name]);
      acts.mark(regions[name]);
      renders[counter] += 1;
      if (name === 'live' && asking().length) questions.sync();
      if (name === 'log' || name === 'live') rows.rove(scroller);
      refocus(regions[name], had);
    }
    // The find field goes back into a head that was written again (its slot is new); an unchanged head keeps it.
    const drawHead = () => { const had = find.focused(); const html = headHtml(); const fresh = last.head !== html; write('head', html, 'head'); if (fresh) find.attach(regions.head, had); };
    function drawBox() {
      const made = s.error || s.closed ? NO_BOX : box.composerParts(boxState());
      const had = focusedIn(regions.box);
      let wrote = false;
      for (const name of BOX_WRITES) {
        if (lastBox[name] === made[name]) continue;
        boxEls[name].innerHTML = made[name];
        lastBox[name] = made[name];
        wrote = true;
      }
      const shown = { composer: made.composer, toolbar: made.composer || made.toolbar === true, locked: Boolean(made.locked), shell: made.composer || Boolean(made.locked) };
      for (const name of Object.keys(shown)) if (boxEls[name].hidden === shown[name]) { boxEls[name].hidden = !shown[name]; wrote = true; }
      if (boxEls.shell.dataset.sendLifecycle !== made.lifecycle) boxEls.shell.dataset.sendLifecycle = made.lifecycle;
      const placeholder = box.placeholderOf(named(), plan.on());
      if (boxEls.field.placeholder !== placeholder) { boxEls.field.placeholder = placeholder; boxEls.field.setAttribute('aria-label', placeholder); }
      if (!wrote) return;
      renders.box += 1;
      refocus(regions.box, had);
    }
    function showJump() {
      const visible = String(!pinned);
      if (jump.dataset.visible === visible) return;
      jump.dataset.visible = visible;
      jump.toggleAttribute('inert', pinned);
    }
    function follow() { if (pinned) scroller.scrollTop = scroller.scrollHeight; }
    function onScroll() { pinned = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - PIN_SLACK; showJump(); }
    // While the running turn's chip shows a time, its row (and an open popover) is drawn again each second.
    function armTick() {
      if (!ticking || s.disposed || s.closed || s.error) { if (tick !== null) { timers.clear(tick); tick = null; } return; }
      if (tick === null) tick = timers.set(() => { tick = null; if (!s.disposed) { const v = ch.view(); writeLive(v); pop.paint(v); follow(); } }, TICK_MS);
    }
    function writeLive(v) {
      if (s.stream && s.stream.text !== liveCache.text) { liveCache.text = s.stream.text; liveCache.at = clock(); }
      write('live', ch.liveHtml(v), 'live');
      ticking = Boolean(v.live && v.live.status === 'running' && ch.chipOf(v.live, v).elapsed);
      armTick();
      announce(v);
    }
    function writeLog(v) {
      write('log', ch.logHtml(v), 'log');
    }
    const writeQueued = (v) => write('queued', ch.queuedHtml(v), 'live');
    // A turn's state changes (not its clock), said once each.
    function announce(v) {
      const said = ch.announce(v, s.announced);
      if (said) { s.announced = said.key; regions.announce.textContent = said.text; }
    }
    function draw() {
      if (s.disposed) return;
      const v = ch.view();
      if (s.popTurn && !v.turns.some((t) => t.id === s.popTurn)) s.popTurn = '';
      drawHead();
      writeLog(v);
      writeLive(v);
      writeQueued(v);
      pop.paint(v);
      find.refresh();
      drawBox();
      follow();
    }
    const painter = parts.createPainter({ s, live: liveCache, timers, frames, clock, draw, every: LIVE_EVERY_MS });

    // ------------------------------------------------------------ data

    function take(snapshot) {
      // Jenny's messages this snapshot brings: the answer of a turn that ended is among them once it is saved.
      const known = new Set(history.messages().map((m) => m.id));
      const answered = snapshot.messages.some((m) => m.role === 'assistant' && !known.has(m.id));
      s.snapshot = snapshot;
      if (snapshot.pending_approvals && snapshot.pending_approvals.length) rulesWatch.check();
      history.take(snapshot);
      approvals.taken(snapshot);
      for (const ref of [...s.answeredQ.keys()]) if (!questionsIn(snapshot).some((p) => p.question_ref === ref)) s.answeredQ.delete(ref);
      // A snapshot read while a turn runs (an approval, a question, a rename) does not take the running reply away.
      s.stream = tl.streamAfter(s.stream, snapshot, clock(), answered);
      setControl(snapshot.control);
      if (Array.isArray(snapshot.viewers)) s.viewers = snapshot.viewers.slice(0, CAPS.viewers);
      if (running()) return;
      s.confirm = false;
      s.settling = false;
      if (s.noteWait) { s.note = ''; s.noteWait = false; }
      // The first snapshot after a clean end carries the new revision: a queued message may go now.
      settleSend(queue.idle({ maySend: mayDrive() }));
    }
    const settleSend = (sending) => { if (sending) void sending.then(() => draw()); };

    function onStream(event) {
      const type = event.event && event.event.type;
      const before = s.stream;
      s.stream = tl.applyStream(s.stream, event, clock());
      // A new turn: its row is the stream's until a snapshot names its saved turn.
      if (type === 'started') { s.settling = false; s.liveTurn = ''; }
      else if (ENDS.has(type)) {
        // The reply stays until the snapshot that holds it lands (main reads one at a turn's end); a send waits for it.
        if (s.snapshot && s.snapshot.active_turn) s.snapshot = { ...s.snapshot, active_turn: null };
        if (before && !before.ended && before.startedAt && s.liveTurn) { remember(s.thought, s.liveTurn, clock() - before.startedAt); ch.invalidate(); }
        s.confirm = false;
        s.settling = true;
        s.lastEnd = type;
        queue.turnEnded(type);
        if (s.noteWait) { s.note = ''; s.noteWait = false; }
      }
      painter.soon();
    }

    function onEvent(payload) {
      const event = payload.event || {};
      switch (payload.event_type) {
        case 'chat_stream': onStream(event); return;
        case 'control_changed': {
          const before = driver();
          if (event.state === 'released' || !event.member_id) setControl(null);
          else setControl({ member_id: event.member_id, expires_at: event.expires_at });
          if (event.member_id && event.member_id !== me() && event.state !== 'released') { queue.lost(); if (before === me()) s.takenBy = event.member_id; }
          // F18: the seat handed to this member is taken up, unless this client's own take answers first (a `lease` push).
          if (event.member_id === me() && before !== me() && event.state !== 'released') { const at = clock();
            timers.set(() => { if (!s.disposed && !(s.leaseAt >= at) && !s.busy.size && driver() === me()) void acts.handed(); }, HAND_WAIT_MS); }
          draw();
          return;
        }
        case 'decision_changed':
          if (event.question_ref) { remember(s.answeredQ, event.question_ref, true); draw(); } else if (!plan.decided(event)) approvals.decided(event);
          return;
        case 'session_changed':
          if (event.state === 'deleted') { s.closed = jt('team.conv.deleted', 'This conversation was deleted.'); titles.close(); kept.forget(); queue.clear(); stopClock(); }
          draw();
          return;
        default: draw();
      }
    }

    function push(payload) {
      if (s.disposed || !payload) return;
      switch (payload.kind) {
        case 'snapshot': if (payload.snapshot) { take(payload.snapshot); draw(); } return;
        case 'conversation_event': onEvent(payload); return;
        case 'viewers': s.viewers = (payload.viewers || []).slice(0, CAPS.viewers); drawHead(); return;
        case 'lease':
          // This client took the lease: it drives until the host says otherwise (no expiry is invented).
          if (payload.held) { s.leaseAt = clock(); setControl({ member_id: me(), expires_at: 0 }); }
          else if (driver() === me()) { setControl(null); queue.lost(); }
          draw();
          return;
        case 'closed': s.closed = errorText({ reason: payload.reason }); titles.close(); queue.lost(); stopClock(); draw(); return;
        case 'rule_answered': void approvals.ruleAnswered(payload); return;
        default:
      }
    }

    // ------------------------------------------------------------ actions

    // The open: its answer is the snapshot, or the sentence a failed one leaves (Try again opens it once more).
    function open() {
      if (opening) return null;
      opening = true;
      return store.call('conversationOpen', ids).then((answer) => {
        opening = false;
        // Closed before the open answered: the close already went, and this one covers an open that landed after it.
        if (s.disposed) { if (answer.ok) void store.call('conversationClose', ids); return; }
        if (answer.ok) { s.error = ''; retried = false; take(answer.snapshot); pinned = true; } else s.error = errorText(answer.error);
        draw();
      }, () => { opening = false; });
    }

    async function run(key, method, payload) {
      if (s.busy.has(key) || s.disposed) return null;
      s.busy.add(key);
      s.takenBy = '';
      s.note = '';
      s.noteWait = false;
      draw();
      const answer = await store.call(method, { ...ids, ...payload });
      if (s.disposed) return answer;
      s.busy.delete(key);
      if (!answer.ok) s.note = errorText(answer.error);
      draw();
      return answer;
    }

    // One older page above what is held. The messages the person was reading stay where they are.
    async function earlier() {
      const reading = history.earlier();
      if (!reading) return false;
      writeLog(ch.view());
      if (!(await reading)) return false;
      const below = scroller.scrollHeight - scroller.scrollTop;
      draw();
      if (!pinned) scroller.scrollTop = Math.max(0, scroller.scrollHeight - below);
      follow();
      return true;
    }

    // `now`: the box was emptied by a send, which is written without the pause.
    const saveDraft = (now = false) => kept.save(boxEls.field.value, now);
    // What the box holds, or `again` (a failed turn's prompt). While a turn runs, or has just ended and its snapshot has
    // not come, the driver's message waits in the queue; anybody else keeps it in the box with a sentence.
    async function send(again) {
      const fromBox = typeof again !== 'string';
      const prompt = (fromBox ? boxEls.field.value : again).trim();
      if (!prompt || prefs.offline() || connection()) return;
      if (prompt.length > box.PROMPT_MAX) { s.note = jt('team.conv.tooLong', 'That message is too long to send.'); drawBox(); return; }
      if (running() || s.settling) {
        if (!mayDrive()) { s.note = jt('team.conv.waitTurn', 'Jenny is still answering. Send this when the turn ends, or stop it first.'); s.noteWait = true; drawBox(); return; }
        // Send again pressed twice queues its prompt once.
        if (!fromBox && queue.entries().some((e) => e.text === prompt)) return;
        const added = queue.add(prompt);
        if (!added.ok) { s.note = jt('team.queue.full', 'Up to {count} messages can wait. Send or discard one first.', { count: queues.CAP }); drawBox(); return; }
        // Typed after the end: it may go with the snapshot that is on its way.
        if (s.settling) queue.turnEnded('complete');
        if (fromBox) { boxEls.field.value = ''; saveDraft(true); }
        pinned = true;
        draw();
        return;
      }
      const answer = await run('box', 'conversationSend', sendPayload(prompt));
      // Cleared only when nothing more was typed while it was sending.
      if (fromBox && answer && answer.ok && boxEls.field.value.trim() === prompt) { boxEls.field.value = ''; saveDraft(true); }
    }
    // Item 15: "Allow all N" and "Deny all". The first refusal stops it and is said in the box.
    async function decideBatch(approved) {
      s.note = '';
      s.noteWait = false;
      const stopped = await approvals.decideAll(approved);
      if (stopped !== null && !s.disposed) { s.note = jt('team.conv.batchStopped', 'Stopped at the first approval that was refused. {reason}', { reason: stopped }); draw(); }
    }
    function stop() { const stream = streamId(); if (stream) void run('box', 'conversationCancel', { stream_id: stream }); }

    // Two calls: a refused stop says so in its sentence and leaves this member, now the driver, the Stop button.
    async function takeoverAndStop() {
      const stream = streamId();
      const taken = await run('box', 'conversationControl', { action: 'takeover' });
      if (!taken || !taken.ok) return;
      s.confirm = false;
      setControl({ member_id: me(), expires_at: 0 });
      if (stream) await run('box', 'conversationCancel', { stream_id: stream });
      else draw();
    }

    function queueAction(kind, id) {
      if (kind === 'queue-send') settleSend(queue.sendNow(id, { running: running() || s.settling }));
      else if (kind === 'queue-discard') queue.discard(id);
      else {
        const text = queue.edit(id);
        if (!text) return;
        const f = boxEls.field;
        f.value = f.value.trim() ? f.value + '\n' + text : text;
        saveDraft();
        focusBox();
      }
      draw();
    }
    function copyText(id) {
      if (id.startsWith('queue:')) return (queue.entries().find((e) => 'queue:' + e.id === id) || {}).text || '';
      return (history.messages().find((one) => one.id === id) || {}).content || '';
    }

    function onClick(event) {
      const from = (selector) => (event.target && event.target.closest ? event.target.closest(selector) : null);
      const approval = from('.tool-approval-block [data-action]');
      if (approval && !approval.disabled && root.contains(approval)) { void approvals.decide(approval); return; }
      if (plan.click(event) || questions.click(event) || prefs.click(event)) return;
      const target = from('[data-project-action]');
      if (!target || target.disabled || !root.contains(target)) return;
      const action = target.dataset.projectAction;
      switch (action) {
        case 'send': void send(); return;
        case 'stop': stop(); return;
        case 'allow-all': case 'deny-all': void decideBatch(action === 'allow-all'); return;
        case 'takeover': void run('box', 'conversationControl', { action: 'takeover' }); return;
        case 'takeover-ask': s.confirm = true; drawBox(); return;
        case 'takeover-cancel': s.confirm = false; drawBox(); return;
        case 'takeover-stop': void takeoverAndStop(); return;
        case 'rename': if (!s.closed && !s.error) titles.start(); return;
        case 'turn-open': if (s.popTurn === target.dataset.turnId) pop.close(); else pop.open(target.dataset.turnId); return;
        case 'reopen': if (target.closest('[data-conv-region="log"]')) void open(); return;
        case 'send-again': { const t = ch.view().turns.find((one) => one.id === target.dataset.turnId); if (t && t.prompt) void send(String(t.prompt.content || '')); return; }
        case 'queue-send': case 'queue-edit': case 'queue-discard': queueAction(action, target.dataset.queueId); return;
        case 'code': channel.fence(boxEls.field); saveDraft(); return;
        case 'copy': { const text = copyText(target.dataset.messageId || ''); if (text) void copier.copy(target, text); return; }
        case 'earlier': void earlier(); return;
        case 'find': find.open(); return;
        case 'latest': pinned = true; follow(); showJump(); focusBox(); return;
        default:
      }
    }
    // The box's field first; then the title's field and a question card, each by its own controller.
    function onInput(event) {
      if (event.target === boxEls.field) { saveDraft(); if (s.takenBy) { s.takenBy = ''; drawBox(); } return; }
      if (!plan.input(event) && !titles.handle(event)) questions.edit(event);
    }
    function onKeydown(event) {
      if (plan.key(event, boxEls.field) || prefs.key(event)) return;
      rows.key(event, scroller);
      if (event.target === boxEls.field) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } return; }
      // Esc closes the popover from the channel too (the popover handles its own); a field keeps its Esc.
      if ((event.key === 'Escape' || event.key === 'Esc') && s.popTurn && !(event.target.closest && event.target.closest('textarea, input, .user-questions-block'))) {
        event.preventDefault();
        pop.close();
        return;
      }
      if (!titles.handle(event)) questions.key(event);
    }

    function stopClock() {
      lease.clear();
      painter.stop();
      if (tick !== null) timers.clear(tick);
      tick = null;
    }

    const listeners = [['click', onClick], ['input', onInput], ['change', onInput], ['keydown', onKeydown], ['focusout', (event) => { titles.handle(event); }], ['focusin', (event) => rows.note(event, scroller)],
      ['submit', (event) => { event.preventDefault(); }]];
    for (const [type, handler] of listeners) root.addEventListener(type, handler);
    scroller.addEventListener('scroll', onScroll);
    // The GPU list changing (a GPU shared or gone) redraws the box's parts only; the text field is never replaced.
    const gpuStore = (stores() || {}).getTeamStore;
    const stopGpu = typeof gpuStore === 'function' ? gpuStore().subscribe(() => { if (!s.disposed) drawBox(); }) : null;
    draw();
    void open();

    return {
      push,
      // The team's projects changing can change this member's role here; the roster changes names.
      update(change) {
        if (!change || change.team_id !== teamId || s.disposed) return;
        if (change.type === 'board') { drawHead(); drawBox(); } else if (change.type === 'projects' || change.type === 'roster') { ch.invalidate(); draw(); paths.refresh(); acts.refresh(); }
        // The team back online after a failed open: one more try (Try again stays for the next).
        if (change.type === 'roster' && s.error && !retried && c().team.state === 'online') { retried = true; void open(); }
      },
      focusTarget,
      openFind: () => find.open(),
      resources: () => ({ timer: lease.armed(), frame: painter.pending() || tick !== null, listeners: s.disposed ? 0 : listeners.length, messages: history.messages().length,
        tools: s.stream ? s.stream.tools.length : 0, ...approvals.counts(), cached: rows.size(), queued: queue.counts().entries }),
      dispose() {
        if (s.disposed) return;
        s.disposed = true;
        stopClock();
        lease.stop();
        copier.stop();
        titles.close();
        kept.dispose();
        for (const [type, handler] of listeners) root.removeEventListener(type, handler);
        scroller.removeEventListener('scroll', onScroll);
        if (stopGpu) stopGpu();
        prefs.dispose();
        popper.dispose();
        paths.dispose();
        find.dispose();
        acts.dispose();
        // Nothing sends while nobody watches: waiting rows read "Not sent" with Send now when the view opens again.
        queue.lost();
        queue.detach();
        rows.clear();
        ch.clear();
        root.textContent = '';
        void store.call('conversationClose', ids);
      },
    };
  }

  return { createConversation };
});
