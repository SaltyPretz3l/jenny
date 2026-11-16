/* renderer/features/board/board-team-presence.js - who else is on a team board (UMD, global rendererBoardTeamPresence).
 *
 * Row 151 slice T7 (D30). Loaded with board-team.js only while the `team` flag is on. While a team board is open this part
 *  - draws each other member's pointer (an arrow and their name) and the label `{name} is typing` over a note another member holds,
 *    in the canvas's world coordinates: both live in the surface's layer, so they pan and zoom with the cards. Both are
 *    aria-hidden-free of pointer events; this member's own pointer is never drawn;
 *  - sends this member's pointer while it moves over the canvas, in world coordinates with the selection (`presence.cursor`),
 *    readers included: the first move in the next animation frame, then the newest position at most once every POINTER_MS, which
 *    is as often as this member's Jenny sends the host one.
 * The drawing patches the nodes that changed: no card and no canvas is redrawn. Nothing runs while the board is idle: one listener
 * on the canvas, a frame only after a move. Everything goes when the board closes, the project is no longer a team project, or on
 * dispose(). Names reach the page through textContent. A pointer is drawn only for a member id that is a string, once, at a place inside the board's
 * own limit, and for at most the team's eight members; a held note only for a card that is on the board, once. For a screen reader the pointers
 * stay aria-hidden and one polite live region of the page says when another member starts or stops typing in a note, by the note's short name.
 *
 * createTeamPresence({ ctx, windowRef, jt, data }) -> { sync(), refresh(), dispose() }; `data` answers selfId(teamId) and nameOf(memberId). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardTeamPresence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const POINTER_MS = 100; // services/team/board-presence-client.js CURSOR_MS
  const COORD_MAX = 1e6; // services/boards/board-model.js COORD_MAX: a place outside the board's own limit is no place
  const MEMBERS_MAX = 8; // the most members a team has
  const ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 2l9.5 5.2-4.2 1.2-1.7 4.1z"/></svg>';

  function createTeamPresence({ ctx, windowRef, jt, data }) {
    const doc = ctx.document;
    const pointers = new Map(); // member id -> { el, label, at }
    const holds = new Map(); // card id -> { el, key }
    let holder = null;
    let live = null; // the page's polite live region, while a board is open
    let told = null; // card id -> { member, note } of the holds already said (null until the first draw of this board)
    let source = null;
    let boardId = '';
    let offPresence = null;
    let offEditor = null;
    let listening = null; // the canvas element the move listener is on
    let pending = null;
    let frame = 0;
    let waiting = 0; // the timer until the next pointer may go
    let sentAt = -Infinity;
    let disposed = false;

    const surface = () => (ctx.canvas && ctx.canvas.surface) || null;
    const requestFrame = (fn) => (typeof windowRef.requestAnimationFrame === 'function' ? windowRef.requestAnimationFrame(fn) : windowRef.setTimeout(fn, 16));
    const cancelFrame = (id) => (typeof windowRef.cancelAnimationFrame === 'function' ? windowRef.cancelAnimationFrame(id) : windowRef.clearTimeout(id));

    const nowMs = () => (windowRef.performance && typeof windowRef.performance.now === 'function' ? windowRef.performance.now() : Date.now());

    const nameOf = (id) => data.nameOrFormer(id);

    function layerHolder() {
      const layer = surface() && surface().layer;
      if (!layer) return null;
      if (!holder) {
        holder = doc.createElement('div');
        holder.className = 'board-team-presence';
        holder.setAttribute('data-board-team-presence', '');
      }
      if (holder.parentNode !== layer) layer.appendChild(holder);
      return holder;
    }

    function clear() {
      pointers.forEach((entry) => entry.el.remove());
      pointers.clear();
      holds.forEach((entry) => entry.el.remove());
      holds.clear();
      if (holder) { holder.remove(); holder = null; }
      told = null;
    }

    function pointer(id) {
      let entry = pointers.get(id);
      if (entry) return entry;
      const el = doc.createElement('div');
      el.className = 'board-team-cursor';
      el.setAttribute('aria-hidden', 'true');
      el.insertAdjacentHTML('beforeend', ARROW);
      const label = doc.createElement('span');
      el.appendChild(label);
      entry = { el, label, at: '' };
      pointers.set(id, entry);
      layerHolder().appendChild(el);
      return entry;
    }

    const inside = (n) => typeof n === 'number' && Math.abs(n) <= COORD_MAX; // not NaN, not infinite
    function drawPointers(state, self) {
      const seen = new Set();
      (state.cursors || []).forEach((cursor) => {
        if (seen.size >= MEMBERS_MAX || !cursor || typeof cursor.member_id !== 'string' || !cursor.member_id || cursor.member_id === self || seen.has(cursor.member_id)) return;
        if (!inside(cursor.x) || !inside(cursor.y)) return;
        seen.add(cursor.member_id);
        const entry = pointer(cursor.member_id);
        const at = `${cursor.x}|${cursor.y}`;
        if (entry.at !== at) { entry.at = at; entry.el.style.left = `${cursor.x}px`; entry.el.style.top = `${cursor.y}px`; }
        const name = nameOf(cursor.member_id);
        if (entry.label.textContent !== name) entry.label.textContent = name;
      });
      pointers.forEach((entry, id) => { if (!seen.has(id)) { entry.el.remove(); pointers.delete(id); } });
    }

    function drawHolds(state, self) {
      const board = ctx.editor && typeof ctx.editor.getBoard === 'function' ? ctx.editor.getBoard() : null;
      const seen = new Set();
      const now = new Map();
      (state.locks || []).forEach((lock) => {
        if (!lock || typeof lock.card_id !== 'string' || typeof lock.member_id !== 'string' || !lock.member_id || lock.member_id === self || seen.has(lock.card_id)) return;
        const card = board && Object.hasOwn(board.cards, lock.card_id) ? board.cards[lock.card_id] : null;
        if (!card) return;
        seen.add(lock.card_id);
        now.set(lock.card_id, { member: lock.member_id, note: card.alias || card.kind });
        let entry = holds.get(lock.card_id);
        if (!entry) {
          const el = doc.createElement('div');
          el.className = 'board-team-hold';
          entry = { el, key: '' };
          holds.set(lock.card_id, entry);
          layerHolder().appendChild(el);
        }
        const key = `${card.x}|${card.y}|${lock.member_id}|${nameOf(lock.member_id)}`;
        if (entry.key === key) return;
        entry.key = key;
        entry.el.style.left = `${card.x}px`;
        entry.el.style.top = `${card.y}px`;
        entry.el.textContent = jt('board.team.typing', '{name} is typing', { name: data.iso(nameOf(lock.member_id)) });
      });
      holds.forEach((entry, id) => { if (!seen.has(id)) { entry.el.remove(); holds.delete(id); } });
      announce(now);
    }

    // Who started or stopped holding a note since the last draw, said once; the holds there when the board opened are not news.
    function announce(now) {
      const before = told;
      told = now;
      if (!before || !live) return;
      const said = [];
      now.forEach((hold, id) => { if (!before.has(id) || before.get(id).member !== hold.member) said.push(jt('board.team.typingIn', '{name} is typing in {note}', { name: data.iso(nameOf(hold.member)), note: hold.note })); });
      before.forEach((hold, id) => { if (!now.has(id)) said.push(jt('board.team.typingStopped', '{name} stopped typing in {note}', { name: data.iso(nameOf(hold.member)), note: hold.note })); });
      if (said.length) live.textContent = said.slice(0, 3).join(' '); // a push that changes more is not read out
    }

    function draw() {
      if (disposed) return;
      if (!source || !boardId || !layerHolder()) { clear(); return; }
      const state = source.presence.get();
      const self = data.selfId(source.scope.teamId);
      drawPointers(state, self);
      drawHolds(state, self);
      if (!pointers.size && !holds.size && holder) { holder.remove(); holder = null; }
    }

    // This member's pointer: the last position in each frame, in world coordinates, with the selection.
    function flush() {
      frame = 0;
      const point = pending;
      pending = null;
      const view = surface();
      if (!point || !source || !boardId || !view) return;
      const at = view.toBoard(point.x, point.y);
      sentAt = nowMs();
      source.presence.cursor({ x: at.x, y: at.y, selected: ctx.editor && typeof ctx.editor.getSelection === 'function' ? ctx.editor.getSelection() : [] });
    }
    function onMove(event) {
      pending = { x: event.clientX, y: event.clientY };
      if (frame || waiting) return;
      const left = POINTER_MS - (nowMs() - sentAt);
      if (left <= 0) { frame = requestFrame(flush); return; }
      waiting = windowRef.setTimeout(() => { waiting = 0; if (pending && !frame) frame = requestFrame(flush); }, left);
    }

    function stop() {
      if (typeof offPresence === 'function') offPresence();
      offPresence = null;
      if (typeof offEditor === 'function') offEditor();
      offEditor = null;
      if (listening) listening.removeEventListener('pointermove', onMove);
      listening = null;
      if (frame) { cancelFrame(frame); frame = 0; }
      if (waiting) { windowRef.clearTimeout(waiting); waiting = 0; }
      pending = null;
      clear();
      if (live) { live.remove(); live = null; }
      source = null;
      boardId = '';
    }

    function start(team, id) {
      source = team;
      boardId = id;
      if (ctx.rootEl) {
        live = doc.createElement('div');
        live.className = 'sr-only';
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
        live.setAttribute('data-board-team-live', 'presence');
        ctx.rootEl.appendChild(live);
      }
      const view = surface();
      if (view && view.element) { listening = view.element; listening.addEventListener('pointermove', onMove, { passive: true }); }
      offPresence = source.presence.subscribe(draw);
      if (ctx.editor && typeof ctx.editor.onChange === 'function') offEditor = ctx.editor.onChange(() => { if (holds.size) draw(); });
      draw();
    }

    return {
      /** Brings the drawing and the pointer in line with the team source and the open board; nothing when neither changed. */
      sync() {
        if (disposed) return;
        const team = ctx.getTeamSource();
        const id = team ? String(ctx.getOpenBoardId() || '') : '';
        if (team === source && id === boardId) return;
        stop();
        if (team && id) start(team, id);
      },
      /** The roster changed: names are drawn again. */
      refresh: draw,
      dispose() {
        if (disposed) return;
        stop();
        disposed = true;
      },
    };
  }

  return { createTeamPresence };
});
