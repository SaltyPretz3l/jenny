/* Team tab: a shared conversation, drawn by the Team tab itself (row 123, slice 3-10; brief decisions 5 to 9,
 * picks_3-10.md "Shared conversation"). The desktop chat pane cannot host one: its approval buttons call the desktop
 * backend.
 *
 * Open: `conversationOpen` answers the snapshot (the last 20 messages; main answers a fresh one when this client has
 * it open already); then the store hands on this conversation's pushes: `conversation_event` (the live stream, the
 * lease, decisions), `snapshot` (main reads one after a resync, a saved prompt, an approval asked, a question or a
 * turn's end, and it replaces the state), `viewers`, `lease`, `closed` and `rule_answered`. Leaving the page, hiding
 * the tab, leaving the team or Force local disposes it, which sends `conversationClose` (main releases a held lease),
 * also when the open never answered.
 *
 * Messages render through the team chat's markdown path (renderer-team-message-row.js `bodyHtml`), each person's with
 * a name line ("Maya · 10:31", "You", "Former member"); Jenny's replies have none. Each message's HTML is kept by id,
 * content and author name, so a frame joins kept strings. A running turn shows its reply as it streams (parsed again
 * at most every 100 ms, at most 256 KB drawn) and one quiet line per tool call; at the turn's end the reply stays until
 * the snapshot that holds it lands. Stream events paint once per animation frame, and each region is written only when
 * its markup changed. The view opens at the newest message and stays pinned to the bottom unless the person scrolled
 * up. "Earlier messages are not shown here yet." when the snapshot has more (no method reads older ones).
 *
 * The message box is built once: its text field is never replaced by a redraw (box.boxParts writes the parts around
 * it), so typing, the caret, an IME composition and undo survive the stream, viewers and project pushes.
 *
 * Who drives: from the snapshot's `control`, each `control_changed` and `lease` push. The host renews a lease by
 * heartbeat and publishes nothing, so the local clock never clears it: when a shown lease passes its `expires_at`,
 * the snapshot is read again (one read in flight, at most one every 30 s while that lease is shown) and its control
 * is taken. A release, a `lease {held:false}` for this member or a snapshot that says so clears it.
 *
 * Caps: 50 messages held (the snapshot gives 20 today), 32 tool lines, 32 receipts, 16 outcome lines, 32 viewers, 64
 * answered approvals remembered. `createConversation({ root, teamId, projectId, sessionId, store, ctx(), clock,
 * timers, frames, renders, board })` -> { push(payload), update(change), dispose(), focusTarget(), resources() }.
 * `board` (row 151 T7, the Board tab's conversation column; the Team tab passes none): { id(): the open board's id or '', hint, viewers(): who
 * else has the board open, as a sentence or '' }. While id() answers a board, a sent message carries `board_id` and the box's hint line
 * says `hint`. The column names the conversation in its own header, so the head here is one line (who is driving, who is viewing the
 * board) and the readers' line: no title, no Back button. update({ type: 'board' }) redraws the head and the box only. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-box'), require('./renderer-team-project-column'), require('./renderer-team-message-row'));
    return;
  }
  root.rendererTeamProjectConversation = factory(root.rendererTeamProjectBox, root.rendererTeamProjectColumn, root.rendererTeamMessageRow);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (box, column, rows) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const BACK = SVG('<path d="M9.5 3.5L5 8l4.5 4.5"/>');
  const CAPS = Object.freeze({ messages: 50, tools: 32, receipts: 32, outcomes: 16, viewers: 32, answered: 64 });
  const ENDS = new Set(['complete', 'error', 'cancelled', 'canceled', 'failed']);
  const LIVE_MAX = 256 * 1024;
  const LIVE_EVERY_MS = 100;
  const LEASE_REREAD_MS = 30_000;
  const PIN_SLACK = 24;

  function inv() { return globalThis.inventory || {}; }
  const capPush = (list, item, cap) => { list.push(item); while (list.length > cap) list.shift(); };
  const remember = (map, key, value) => { map.delete(key); map.set(key, value); while (map.size > CAPS.answered) map.delete(map.keys().next().value); };
  const defaultFrames = { request: (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)),
    cancel: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)) };
  const defaultTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

  function createConversation({ root, teamId, projectId, sessionId, store, ctx, clock = Date.now, timers = defaultTimers, frames = defaultFrames, renders = { log: 0, live: 0, box: 0, head: 0 }, board = null }) {
    const ids = { team_id: teamId, session_id: sessionId };
    const s = { snapshot: null, error: '', closed: '', messages: [], control: null, viewers: [], stream: null, tools: [], receipts: [], outcomes: [], answered: new Map(),
      asked: new Map(), lost: new Map(), busy: new Set(), confirm: false, takenBy: '', note: '', disposed: false };
    const last = { head: null, log: null, live: null };
    const lastBox = { above: null, bar: null, below: null };
    const cache = new Map(); // message id -> { key, html }
    const liveCache = { text: null, html: '', at: -Infinity };
    const lease = { timer: null, reading: false, readAt: -Infinity };
    let frame = null;
    let liveTimer = null;
    let pinned = true;

    const c = () => ctx();
    const boardNow = () => (board && typeof board.id === 'function' ? String(board.id() || '') : '');
    const me = () => c().team.member_id;
    const projectRow = () => store.project(teamId, projectId);
    const role = () => { const r = (projectRow() || {}).role; return r === 'owner' ? 'admin' : (r || 'reader'); };
    const owner = () => c().team.role === 'owner';
    const projectName = () => column.clean((projectRow() || {}).name);
    const title = () => column.clean((s.snapshot && s.snapshot.session.title) || ((store.conversationsOf(teamId, projectId) || []).find((r) => r.session_id === sessionId) || {}).title)
      || jt('team.projects.untitled', 'Untitled conversation');
    const nameOf = (id) => (id === me() ? jt('team.conv.you', 'You') : c().nameOf(id));
    const pending = () => (s.snapshot ? s.snapshot.pending_approvals.filter((a) => !s.answered.has(a.approval_id)) : []);
    const running = () => Boolean((s.stream && !s.stream.ended) || (s.snapshot && s.snapshot.active_turn && !ENDS.has(String(s.snapshot.active_turn.status || s.snapshot.active_turn.state || ''))));
    const streamId = () => (s.stream && !s.stream.ended && s.stream.id) || (s.snapshot && s.snapshot.active_turn && s.snapshot.active_turn.stream_id) || '';

    // ------------------------------------------------------------ the lease

    const driver = () => (s.control ? s.control.member_id : null);
    function setControl(control) {
      const before = driver();
      s.control = control && control.member_id ? { member_id: control.member_id, expires_at: Number(control.expires_at) || 0 } : null;
      if (driver() !== before) s.confirm = false;
      armLease();
    }
    function armLease() {
      if (lease.timer !== null) { timers.clear(lease.timer); lease.timer = null; }
      if (s.disposed || lease.reading || !s.control || !s.control.expires_at) return;
      const at = Math.max(s.control.expires_at, lease.readAt + LEASE_REREAD_MS);
      lease.timer = timers.set(() => { lease.timer = null; void checkLease(); }, Math.max(0, at - clock()) + 50);
    }
    // The shown lease is past its expiry: the host may have renewed it silently, or the driver may be gone.
    async function checkLease() {
      if (s.disposed || lease.reading || !s.control) return;
      lease.reading = true;
      lease.readAt = clock();
      const answer = await store.call('conversationOpen', ids);
      lease.reading = false;
      if (s.disposed) return;
      if (answer.ok) { take(answer.snapshot); draw(); } else armLease();
    }

    // ------------------------------------------------------------ markup

    function headHtml() {
      const back = jt('team.chat.back', 'Back to the list');
      const d = driver();
      const driving = d === me() ? jt('team.conv.youDrive', 'You are driving') : d ? jt('team.conv.someoneDrives', '{name} is driving', { name: c().nameOf(d) }) : jt('team.conv.nobodyDrives', 'nobody is driving');
      const others = s.viewers.filter((id) => id !== me()).map((id) => c().nameOf(id));
      const viewing = others.length ? jt('team.conv.viewing', '{names} and you viewing', { names: others.join(', ') }) : jt('team.conv.viewingYou', 'you viewing');
      const sub = board ? [d ? driving : '', typeof board.viewers === 'function' ? String(board.viewers() || '') : ''].filter(Boolean).join(' · ')
        : [projectName(), driving, viewing].filter(Boolean).join(' · ');
      const named = board ? '' : inv().actionButton({ plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back, dataset: { 'team-tab-action': 'back' }, trustedHtml: BACK })
        + '<h2 class="team-head__name" dir="auto" title="' + escapeHtml(title()) + '">' + escapeHtml(title()) + '</h2>';
      return '<header class="team-head">' + named + (sub ? '<span class="team-head__sub" dir="auto">' + escapeHtml(sub) + '</span>' : '')
        // E68: the readers' line, drawn as a direct conversation's standing line is: always there, nothing dismisses it.
        + '<span class="team-head__sub" data-standing="true" dir="auto">' + escapeHtml(jt('team.conv.standing', 'The team host and the member whose PC answers can read this conversation.')) + '</span></header>';
    }

    function renderMessage(message, who) {
      const text = typeof message.content === 'string' ? message.content : '';
      if (message.role === 'user' || message.role === 'assistant') {
        if (!text && message.role === 'assistant') return '';
        const time = rows.timeText(message.timestamp);
        const author = who ? '<span class="chat-author" dir="auto"><b>' + escapeHtml(who) + '</b>' + (time ? ' · ' + escapeHtml(time) : '') + '</span>' : '';
        return '<article class="chat-entry message-shell ' + message.role + '" data-message-id="' + escapeHtml(message.id) + '"><div class="chat-message-content">'
          + author + '<div class="chat-bubble chat-bubble-markdown" dir="auto">' + rows.bodyHtml(text, [], null, root.ownerDocument) + '</div></div></article>';
      }
      const tool = message.tool_call && typeof message.tool_call.name === 'string' ? message.tool_call.name : '';
      return tool ? toolLine({ name: tool, state: 'done' }) : '';
    }
    // One message's HTML, kept by its id while its content and author's name stay the same.
    function messageHtml(message) {
      const who = message.role === 'user' && message.author ? nameOf(message.author.member_id) : '';
      const key = [message.role, who, typeof message.content === 'string' ? message.content : '', (message.tool_call && message.tool_call.name) || '', rows.timeText(message.timestamp)].join('\u0000');
      const hit = message.id ? cache.get(message.id) : null;
      if (hit && hit.key === key) return hit.html;
      const html = renderMessage(message, who);
      if (message.id) cache.set(message.id, { key, html });
      return html;
    }
    function toolLine(t) {
      const word = t.state === 'running' ? jt('team.conv.toolRunning', 'running') : t.state === 'failed' ? jt('team.conv.toolFailed', 'failed') : jt('team.conv.toolDone', 'done');
      return '<div class="turn-activity-row team-tool-line" role="status"><span class="turn-activity-label" dir="auto">' + escapeHtml(column.clean(t.name, 64)) + ' · ' + escapeHtml(word) + '</span></div>';
    }

    function logHtml() {
      if (s.error) return '<p class="team-page__lede" role="status">' + escapeHtml(s.error) + '</p>';
      if (!s.snapshot) return '';
      const earlier = s.snapshot.has_more ? '<p class="team-note-line">' + escapeHtml(jt('team.conv.earlier', 'Earlier messages are not shown here yet.')) + '</p>' : '';
      const cards = pending().map((a) => box.cardHtml(a, { role: role(), planMode: s.snapshot.session.plan_mode === true, projectName: projectName(),
        prompter: a.prompter_member_id ? c().nameOf(a.prompter_member_id) : '', busy: s.busy.has('decide:' + a.approval_id), note: s.lost.get(a.approval_id) || '' })).join('');
      return earlier + s.messages.map(messageHtml).join('') + s.tools.map(toolLine).join('') + s.receipts.map(box.receiptHtml).join('')
        + s.outcomes.map(box.outcomeHtml).join('') + cards + (s.closed ? '<p class="team-note-line" role="status">' + escapeHtml(s.closed) + '</p>' : '');
    }
    function liveHtml() {
      if (!s.stream || !s.stream.text) return '';
      if (liveCache.text !== s.stream.text) {
        liveCache.text = s.stream.text;
        liveCache.at = clock();
        liveCache.html = '<article class="chat-entry message-shell assistant" data-live="true"><div class="chat-message-content"><div class="chat-bubble chat-bubble-markdown" dir="auto">'
          + rows.bodyHtml(s.stream.text, [], null, root.ownerDocument) + '</div></div></article>';
      }
      return liveCache.html;
    }
    function boxState() {
      return { role: role(), owner: owner(), driver: driver(), me: me(), running: running(), approval: pending().length > 0, confirm: s.confirm, takenBy: s.takenBy,
        busy: s.busy.has('box'), note: s.note, nameOf: c().nameOf, boardHint: board && boardNow() ? String(board.hint || '') : '' };
    }

    // ------------------------------------------------------------ drawing

    root.innerHTML = '<div class="team-conv"><div data-conv-region="head"></div><div class="team-conv__scroll team-scroll" role="log" aria-live="polite">'
      + '<div data-conv-region="log"></div><div data-conv-region="live"></div></div><div data-conv-region="box"><div data-conv-box="above"></div>'
      + '<div class="team-composer team-conv-box" data-conv-box="composer" hidden>' + box.fieldHtml() + '<div class="team-composer__bar" data-conv-box="bar"></div></div>'
      + '<div data-conv-box="below"></div></div></div>';
    const q = (selector) => root.querySelector(selector);
    const regions = { head: q('[data-conv-region="head"]'), log: q('[data-conv-region="log"]'), live: q('[data-conv-region="live"]'), box: q('[data-conv-region="box"]') };
    const boxEls = { above: q('[data-conv-box="above"]'), composer: q('[data-conv-box="composer"]'), bar: q('[data-conv-box="bar"]'), below: q('[data-conv-box="below"]'), field: q('#' + box.BOX_ID) };
    const scroller = q('.team-conv__scroll');

    function focusTarget() {
      return (!boxEls.composer.hidden && boxEls.field) || regions.box.querySelector('button:not([disabled])') || q('.team-back');
    }
    const focusedIn = (region) => { const active = root.ownerDocument.activeElement; return active && region.contains(active) ? (active.id || active.dataset.projectAction || '') : ''; };
    // A write that took the focused control away: the same control again, else what replaced it (a confirm's
    // Cancel), else the box; never the page.
    function refocus(region, had) {
      if (!had) return;
      const doc = root.ownerDocument;
      const active = doc.activeElement;
      if (active && active !== doc.body && root.contains(active) && !active.closest('[hidden]')) return;
      const next = (had !== box.BOX_ID && region.querySelector('[data-project-action="' + had + '"]:not([disabled])'))
        || region.querySelector('[data-project-action="takeover-cancel"]') || focusTarget();
      if (next && typeof next.focus === 'function') next.focus({ preventScroll: true });
    }
    function write(name, html, counter) {
      if (last[name] === html) return;
      const had = focusedIn(regions[name]);
      regions[name].innerHTML = html;
      last[name] = html;
      renders[counter] += 1;
      refocus(regions[name], had);
    }
    function drawBox() {
      const parts = s.error || s.closed ? { above: '', composer: false, bar: '', below: '' } : box.boxParts(boxState());
      const had = focusedIn(regions.box);
      let wrote = false;
      for (const name of ['above', 'bar', 'below']) {
        if (lastBox[name] === parts[name]) continue;
        boxEls[name].innerHTML = parts[name];
        lastBox[name] = parts[name];
        wrote = true;
      }
      if (boxEls.composer.hidden === parts.composer) { boxEls.composer.hidden = !parts.composer; wrote = true; }
      if (!wrote) return;
      renders.box += 1;
      refocus(regions.box, had);
    }
    function follow() { if (pinned) scroller.scrollTop = scroller.scrollHeight; }
    function onScroll() { pinned = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - PIN_SLACK; }
    function draw() {
      if (s.disposed) return;
      write('head', headHtml(), 'head');
      write('log', logHtml(), 'log');
      write('live', liveHtml(), 'live');
      drawBox();
      follow();
    }
    // A stream event paints on the next animation frame; several in one frame paint once; the reply is parsed again
    // at most every 100 ms (a timer paints what arrived after the last parse).
    function paint() {
      const text = s.stream ? s.stream.text : '';
      const wait = liveCache.at + LIVE_EVERY_MS - clock();
      if (text && text !== liveCache.text && wait > 0) {
        if (liveTimer === null) liveTimer = timers.set(() => { liveTimer = null; paintSoon(); }, wait);
      } else write('live', liveHtml(), 'live');
      write('log', logHtml(), 'log');
      drawBox();
      follow();
    }
    function paintSoon() {
      if (frame !== null || s.disposed) return;
      frame = frames.request(() => { frame = null; if (!s.disposed) paint(); });
    }

    // ------------------------------------------------------------ data

    function take(snapshot) {
      s.snapshot = snapshot;
      s.messages = snapshot.messages.slice(-CAPS.messages);
      const kept = new Set(s.messages.map((m) => m.id));
      for (const id of [...cache.keys()]) if (!kept.has(id)) cache.delete(id);
      s.tools = [];
      s.lost.clear();
      for (const id of [...s.answered.keys()]) if (!snapshot.pending_approvals.some((a) => a.approval_id === id)) s.answered.delete(id);
      const projection = snapshot.live_projection;
      s.stream = snapshot.active_turn && projection && typeof projection.content === 'string'
        ? { id: projection.stream_id || snapshot.active_turn.stream_id || '', text: projection.content.slice(0, LIVE_MAX), ended: false } : null;
      if (!running()) s.confirm = false;
      setControl(snapshot.control);
    }

    function onStream(event) {
      const e = event.event || {};
      if (e.type === 'started') { s.stream = { id: event.stream_id, text: '', ended: false }; s.tools = []; }
      else if (e.type === 'delta' && s.stream && !s.stream.ended) {
        if (typeof e.aggregate === 'string') s.stream.text = e.aggregate.slice(0, LIVE_MAX);
        else if (s.stream.text.length < LIVE_MAX && typeof e.content === 'string') s.stream.text = (s.stream.text + e.content).slice(0, LIVE_MAX);
      } else if (e.type === 'stream_reset' && s.stream) s.stream.text = '';
      else if (e.type === 'tool_use' || e.type === 'tool_result') {
        const id = e.call_id || '';
        const state = e.type === 'tool_use' ? 'running' : (e.status === 'error' || e.status === 'failed' ? 'failed' : 'done');
        const known = s.tools.find((t) => t.id === id && id);
        if (known) known.state = state; else capPush(s.tools, { id, name: e.tool_name || '', state }, CAPS.tools);
      } else if (ENDS.has(e.type)) {
        // The reply stays until the snapshot that holds it lands (main reads one at a turn's end).
        if (s.stream) s.stream.ended = true;
        if (s.snapshot && s.snapshot.active_turn) s.snapshot = { ...s.snapshot, active_turn: null };
        s.confirm = false;
      }
      paintSoon();
    }

    function onDecision(event) {
      if (!event.approval_id) return;
      const a = s.snapshot && s.snapshot.pending_approvals.find((p) => p.approval_id === event.approval_id);
      const mine = s.asked.get(event.approval_id) || null;
      remember(s.answered, event.approval_id, true);
      s.lost.delete(event.approval_id);
      // A runtime withdrawal carries neither `approved` nor an approver: it names nobody.
      const outcome = event.approved === true ? 'allowed' : event.approved === false ? 'declined' : 'withdrawn';
      const byMe = event.approver_member_id === me() && mine && outcome === 'allowed';
      capPush(s.receipts, { approval_id: event.approval_id, outcome, approver: event.approver_member_id ? nameOf(event.approver_member_id) : jt('settings.team.activity.someone', 'Someone'),
        prompter: event.prompter_member_id ? c().nameOf(event.prompter_member_id) : (a && a.prompter_member_id ? c().nameOf(a.prompter_member_id) : ''), time: rows.timeText(clock()),
        asked: byMe && !mine.failed && mine.always === 'ask' ? mine.tool : '', rule: byMe && !mine.failed && mine.always === 'rule' ? mine.tool : '', failed: byMe ? mine.failed : '' }, CAPS.receipts);
      draw();
    }

    function onEvent(payload) {
      const event = payload.event || {};
      switch (payload.event_type) {
        case 'chat_stream': onStream(event); return;
        case 'control_changed': {
          const before = driver();
          if (event.state === 'released' || !event.member_id) setControl(null);
          else setControl({ member_id: event.member_id, expires_at: event.expires_at });
          if (before === me() && event.member_id && event.member_id !== me()) s.takenBy = event.member_id;
          draw();
          return;
        }
        case 'decision_changed': onDecision(event); return;
        case 'session_changed':
          if (event.state === 'deleted') { s.closed = jt('team.conv.deleted', 'This conversation was deleted.'); stopClock(); }
          draw();
          return;
        default: draw();
      }
    }

    async function outcome(payload) {
      const answer = await store.call('projectRules', { team_id: teamId, project_id: projectId });
      if (s.disposed || !answer.ok) return;
      const request = answer.requests.find((r) => r.request_seq === payload.request_seq);
      if (!request || request.asker_member_id !== me() || request.session_id !== sessionId) return;
      capPush(s.outcomes, { outcome: request.state, by: c().nameOf(request.answered_by), tool: request.outcome_tool || request.tool_name, folder: request.outcome_folder,
        reason: request.reason, project: projectName() }, CAPS.outcomes);
      draw();
    }

    function push(payload) {
      if (s.disposed || !payload) return;
      switch (payload.kind) {
        case 'snapshot': if (payload.snapshot) { take(payload.snapshot); draw(); } return;
        case 'conversation_event': onEvent(payload); return;
        case 'viewers': s.viewers = (payload.viewers || []).slice(0, CAPS.viewers); write('head', headHtml(), 'head'); return;
        case 'lease':
          // This client took the lease: it drives until the host says otherwise (no expiry is invented).
          if (payload.held) setControl({ member_id: me(), expires_at: 0 });
          else if (driver() === me()) setControl(null);
          draw();
          return;
        case 'closed': s.closed = c().errorText({ reason: payload.reason }); stopClock(); draw(); return;
        case 'rule_answered': void outcome(payload); return;
        default:
      }
    }

    // ------------------------------------------------------------ actions

    async function run(key, method, payload) {
      if (s.busy.has(key) || s.disposed) return null;
      s.busy.add(key);
      s.takenBy = '';
      s.note = '';
      draw();
      const answer = await store.call(method, { ...ids, ...payload });
      if (s.disposed) return answer;
      s.busy.delete(key);
      if (!answer.ok) s.note = c().errorText(answer.error);
      draw();
      return answer;
    }

    // What this member asked for is noted before the call, so a `decision_changed` that arrives first builds the
    // whole receipt; an always that did not land shows its sentence in the receipt; the card goes once answered.
    async function decide(target) {
      const a = pending().find((p) => p.approval_id === target.dataset.approvalId);
      const key = a ? 'decide:' + a.approval_id : '';
      if (!a || role() === 'reader' || s.busy.has(key) || s.disposed) return;
      const approved = target.dataset.action === 'approve';
      const always = approved && target.dataset.teamAlways ? target.dataset.teamAlways : '';
      remember(s.asked, a.approval_id, { always, tool: a.tool_name, failed: '' });
      s.lost.delete(a.approval_id);
      s.busy.add(key);
      s.takenBy = '';
      draw();
      const answer = await store.call('conversationDecide', { ...ids, stream_id: a.stream_id, approval_id: a.approval_id, decision_revision: a.decision_revision, approved,
        ...(always ? { always } : {}) });
      if (s.disposed) return;
      s.busy.delete(key);
      if (!answer.ok) s.lost.set(a.approval_id, c().errorText(answer.error));
      else {
        remember(s.answered, a.approval_id, true);
        const result = answer.always_result;
        if (always && result && result.ok === false) {
          const failed = c().errorText({ reason: result.reason });
          const mine = s.asked.get(a.approval_id);
          if (mine) mine.failed = failed;
          const receipt = s.receipts.find((r) => r.approval_id === a.approval_id);
          if (receipt) { receipt.asked = ''; receipt.rule = ''; receipt.failed = failed; }
        }
      }
      draw();
    }

    async function send() {
      const prompt = boxEls.field.value.trim();
      if (!prompt) return;
      if (prompt.length > box.PROMPT_MAX) { s.note = jt('team.conv.tooLong', 'That message is too long to send.'); drawBox(); return; }
      const boardId = boardNow();
      const answer = await run('box', 'conversationSend', boardId ? { prompt, board_id: boardId } : { prompt });
      // Cleared only when nothing more was typed while it was sending.
      if (answer && answer.ok && boxEls.field.value.trim() === prompt) boxEls.field.value = '';
    }

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

    function onClick(event) {
      const approval = event.target && event.target.closest ? event.target.closest('.tool-approval-block [data-action]') : null;
      if (approval && !approval.disabled && root.contains(approval)) { void decide(approval); return; }
      const target = event.target && event.target.closest ? event.target.closest('[data-project-action]') : null;
      if (!target || target.disabled || !root.contains(target)) return;
      switch (target.dataset.projectAction) {
        case 'send': void send(); return;
        case 'stop': { const stream = streamId(); if (stream) void run('box', 'conversationCancel', { stream_id: stream }); return; }
        case 'takeover': void run('box', 'conversationControl', { action: 'takeover' }); return;
        case 'takeover-ask': s.confirm = true; drawBox(); return;
        case 'takeover-cancel': s.confirm = false; drawBox(); return;
        case 'takeover-stop': void takeoverAndStop(); return;
        default:
      }
    }
    function onInput(event) { if (event.target === boxEls.field && s.takenBy) { s.takenBy = ''; drawBox(); } }
    function onKeydown(event) {
      if (event.target === boxEls.field && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
    }

    function stopClock() {
      if (lease.timer !== null) { timers.clear(lease.timer); lease.timer = null; }
      if (frame !== null) { frames.cancel(frame); frame = null; }
      if (liveTimer !== null) { timers.clear(liveTimer); liveTimer = null; }
    }

    const listeners = [['click', onClick], ['input', onInput], ['keydown', onKeydown]];
    for (const [type, handler] of listeners) root.addEventListener(type, handler);
    scroller.addEventListener('scroll', onScroll);
    draw();
    void store.call('conversationOpen', ids).then((answer) => {
      // Closed before the open answered: the close already went, and this one covers an open that landed after it.
      if (s.disposed) { if (answer.ok) void store.call('conversationClose', ids); return; }
      if (answer.ok) { take(answer.snapshot); pinned = true; } else s.error = c().errorText(answer.error);
      draw();
    });

    return {
      push,
      // The team's projects changing can change this member's role here; the roster changes names.
      update(change) {
        if (!change || change.team_id !== teamId || s.disposed) return;
        if (change.type === 'board') { write('head', headHtml(), 'head'); drawBox(); } else if (change.type === 'projects' || change.type === 'roster') draw();
      },
      focusTarget,
      resources: () => ({ timer: lease.timer !== null, frame: frame !== null || liveTimer !== null, listeners: s.disposed ? 0 : listeners.length, messages: s.messages.length, tools: s.tools.length,
        receipts: s.receipts.length, outcomes: s.outcomes.length, answered: s.answered.size, cached: cache.size }),
      dispose() {
        if (s.disposed) return;
        s.disposed = true;
        stopClock();
        for (const [type, handler] of listeners) root.removeEventListener(type, handler);
        scroller.removeEventListener('scroll', onScroll);
        cache.clear();
        void store.call('conversationClose', ids);
      },
    };
  }

  return { createConversation };
});
