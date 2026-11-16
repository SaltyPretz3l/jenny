/* renderer/features/board/board-editor.js - the board's selection and commands (UMD, global rendererBoardEditor).
 *
 * One editor per open board page. It holds the board the person sees (the newest document, or the optimistic one
 * while a batch is in flight), the selection, and every command a view can run: each builds one batch, applies it to
 * its own copy through the model's applyBatch (no authority, so views repaint at once), sends it with source.apply,
 * and then takes the board that comes back. A refusal puts the board back, tells the person through notify, and
 * resolves { ok: false, reason, message }. Nothing here rejects. The canvas, the outline and the keyboard are views
 * of this object: they listen to onChange and call commands, and none of them touches a document.
 *
 * Contract: scratchpad briefs/w3/board-editor-contract.md, section 1. The one addition: setBoard also takes
 * `canUndo` and `canRedo` (what the source's answer said), so Undo is right after a board is opened. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardEditor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const TONES = Object.freeze(['amber', 'blue', 'green', 'red']);
  const COPY_OFFSET = 24;
  const GROUP_PAD = 16;
  const GROUP_HEADER = 40;
  const NOTHING_TO = new Set(['nothing_to_undo', 'nothing_to_redo']);
  const PART_OPS = new Set(['card.add', 'group.add', 'connector.add', 'card.remove']);

  function same(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }
  function num(value, fallback) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }

  function createBoardEditor(deps) {
    const { model, source } = deps;
    const jt = typeof deps.jt === 'function' ? deps.jt : fallbackJt;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const notifyOut = typeof deps.notify === 'function' ? deps.notify : () => {};
    const makeId = typeof deps.makeId === 'function' ? deps.makeId : () => globalThis.crypto.randomUUID();
    const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
    const limits = model.LIMITS;
    const tidyModule = () => deps.tidy || globalThis.jennyBoardTidy || null;

    let board = null;
    let readOnly = false;
    let selection = [];
    let connectorId = '';
    let flags = { undo: false, redo: false };
    let version = 0; // counts setBoard calls: an answer that arrives after the page re-read the board does not undo that
    let inflight = 0;
    let disposed = false;
    const listeners = new Set();

    function emit(kind) {
      Array.from(listeners).forEach((listener) => {
        try { listener({ kind }); } catch (_error) { /* a view must not break the editor */ }
      });
    }
    function notify(message, tone) {
      try { notifyOut(message, { tone: tone || 'warning' }); } catch (_error) { /* a toast must not break the editor */ }
    }
    function canEdit() { return !disposed && board !== null && !readOnly; }

    /* ---------------------------------------------------------------- what a refusal says */

    function limitText(limit) {
      switch (limit) {
        case 'cards': return jt('board.limit.cards', 'This board already holds the most cards it can ({max}).', { max: limits.cards });
        case 'connectors': return jt('board.limit.connectors', 'This board already holds the most connectors it can ({max}).', { max: limits.connectors });
        case 'groups': return jt('board.limit.groups', 'This board already holds the most groups it can ({max}).', { max: limits.groups });
        case 'batch_ops': return jt('board.limit.batchOps', 'That changes more than {max} things at once. Select fewer items.', { max: limits.batch_ops });
        case 'note_chars': return jt('board.limit.noteChars', 'A note holds at most {max} characters.', { max: String(limits.note_chars).replace(/\B(?=(\d{3})+$)/g, ',') });
        case 'document_bytes': return jt('board.limit.documentBytes', 'This board is full: it has reached its 2 MB size limit.');
        case 'diagram_chars': return jt('board.limit.diagramChars', 'A diagram holds at most {max} characters.', { max: limits.diagram_chars });
        default: return jt('board.limit.other', 'This board has reached a limit.');
      }
    }

    function messageFor(result) {
      if (typeof result.message === 'string' && result.message) return result.message; // a team board's own sentence
      const detail = String(result.detail || '');
      switch (result.reason) {
        case 'read_only': return jt('board.error.readOnly', 'This board cannot be changed.');
        case 'limit': return limitText(result.limit);
        case 'stale': return jt('board.edit.stale', 'Someone else changed this just now. Your text is still here; save again to keep yours.');
        case 'missing_target': return jt('board.error.missing', 'That item is no longer on the board.');
        case 'exists': return jt('board.error.exists', 'Those two cards are already connected.');
        case 'nothing_selected': return jt('board.error.nothingSelected', 'Select something on the board first.');
        case 'not_applicable': return jt('board.error.notApplicable', 'That does not apply to what is selected.');
        case 'nothing_to_undo': return jt('board.undo.nothing', 'Nothing to undo.');
        case 'nothing_to_redo': return jt('board.redo.nothing', 'Nothing to redo.');
        case 'invalid':
          if (result.limit) return limitText(result.limit);
          if (detail.indexOf('url') >= 0) return jt('board.error.url', 'A link needs an address that starts with http:// or https://.');
          if (detail.indexOf('title') >= 0) return jt('board.error.title', 'A title is one line of up to 200 characters.');
          if (detail.indexOf('label') >= 0 || detail.indexOf('connector') >= 0) return jt('board.error.label', 'A label is one line of up to 200 characters.');
          if (result.field === 'tone' || detail.indexOf('tone') >= 0) return jt('board.error.tone', 'That is not one of the board’s colours.');
          return jt('board.error.invalid', 'That value is not allowed here.');
        case 'disposed': return jt('board.error.closed', 'This board is closed.');
        default: return jt('board.editor.failed', 'That change could not be made. Try again.');
      }
    }

    function refusal(result, extra) {
      const out = { ok: false, reason: result.reason || 'invalid', message: messageFor(result) };
      ['limit', 'detail', 'op_index', 'current'].forEach((key) => { if (result[key] !== undefined) out[key] = result[key]; });
      return Object.assign(out, extra || {});
    }
    /** A refusal the person is told about. */
    function told(result) {
      const out = refusal(result);
      log('WARN', 'board.editor_refused', { reason: out.reason, limit: out.limit || '' });
      notify(out.message, 'warning');
      return out;
    }

    /* ---------------------------------------------------------------- the board and the selection */

    function known(id) { return Boolean(board && (board.cards[id] || board.groups[id])); }

    /** Drops what is no longer on the board; returns whether the selection changed. */
    function prune() {
      const before = selection;
      const beforeConnector = connectorId;
      selection = board ? selection.filter(known) : [];
      if (!board || !board.connectors[connectorId]) connectorId = '';
      return !same(before, selection) || beforeConnector !== connectorId;
    }

    function replaceBoard(next) {
      board = next;
      const changed = prune();
      emit('board');
      if (changed) emit('selection');
    }

    function setBoard(next, options) {
      if (disposed) return;
      const opts = options || {};
      const sameBoard = Boolean(next && board && next.id === board.id);
      version += 1;
      unsettled = false;
      readOnly = opts.readOnly === true;
      if (opts.canUndo !== undefined || opts.canRedo !== undefined || !sameBoard) {
        flags = { undo: opts.canUndo === true, redo: opts.canRedo === true };
      }
      replaceBoard(next || null);
    }

    function setSelection(ids, connector) {
      const changed = !same(selection, ids) || connectorId !== connector;
      selection = ids;
      connectorId = connector;
      if (changed) emit('selection');
    }

    function select(ids, options) {
      if (disposed) return;
      const wanted = (Array.isArray(ids) ? ids : []).filter(known);
      const base = options && options.add === true ? selection : [];
      setSelection(Array.from(new Set(base.concat(wanted))), '');
    }
    function toggle(id) {
      if (disposed || !known(id)) return;
      setSelection(selection.includes(id) ? selection.filter((entry) => entry !== id) : selection.concat([id]), '');
    }
    function clearSelection() { setSelection([], ''); }
    function selectAll() {
      if (!board) return;
      setSelection(Object.keys(board.cards).concat(Object.keys(board.groups)), '');
    }
    function selectConnector(id) {
      if (disposed) return;
      if (!id || !board || !board.connectors[id]) { if (!id) setSelection(selection, ''); return; }
      setSelection([], id);
    }

    /* ---------------------------------------------------------------- sending a batch */

    // This editor's own recent batches, each with the board version it was sent on. The page asks `sentBatch` before
    // it reads the board again for an `applied` event: the answer to the batch already carries the board. Not when
    // the board was set since the batch left (its answer will not be taken), and not while a refused batch could not
    // be taken back cleanly (another was layered on it): then the next read settles what the board really holds.
    const sentOn = new Map();
    let unsettled = false;
    function sentBatch(batchId) { return !unsettled && sentOn.get(batchId) === version; }

    function take(answer, started) {
      if (answer.canUndo !== undefined) flags.undo = answer.canUndo === true;
      if (answer.canRedo !== undefined) flags.redo = answer.canRedo === true;
      if (answer.board && version === started && inflight === 0 && board && answer.board.id === board.id && answer.board.rev >= board.rev) {
        replaceBoard(answer.board);
        return;
      }
      emit('board'); // the flags changed
    }

    /**
     * Applies `ops` here, then sends them. `onApplied` runs after the optimistic apply (a command's selection).
     * Resolves { ok: true } or the refusal; never rejects.
     */
    async function run(ops, onApplied) {
      if (disposed) return refusal({ reason: 'disposed' });
      if (!canEdit()) return refusal({ reason: 'read_only' });
      const before = board;
      const started = version;
      const batch = { batch_id: makeId(), board_id: before.id, actor: 'owner', ops };
      const local = model.applyBatch(before, batch, { now: now() });
      if (!local.ok) return told(local);
      sentOn.set(batch.batch_id, started);
      if (sentOn.size > 32) sentOn.delete(sentOn.keys().next().value);
      const selectedBefore = selection.slice();
      const connectorBefore = connectorId;
      board = local.board;
      prune();
      if (onApplied) onApplied();
      emit('board');
      if (!same(selectedBefore, selection) || connectorBefore !== connectorId) emit('selection');
      inflight += 1;
      let answer;
      try {
        answer = await source.apply({ boardId: before.id, batch });
      } catch (_error) {
        answer = { ok: false, reason: 'io' };
      }
      inflight -= 1;
      if (!answer || typeof answer !== 'object') answer = { ok: false, reason: 'io' };
      if (disposed) return refusal({ reason: 'disposed' });
      if (answer.ok) {
        if (version === started || !board) take(answer, started);
        else if (answer.canUndo !== undefined) { flags.undo = answer.canUndo === true; flags.redo = answer.canRedo === true; emit('board'); }
        if (answer.undoable === false && !answer.duplicate) notify(jt('board.undo.notUndoable', 'That change cannot be undone.'), 'warning');
        return { ok: true };
      }
      if (version === started && board === local.board) {
        const selectedNow = selection.slice();
        board = before;
        prune();
        emit('board');
        if (!same(selectedNow, selection)) emit('selection');
      } else {
        unsettled = true;
      }
      return told(answer);
    }

    function done(result, extra) { return result.ok ? Object.assign({}, result, extra) : result; }
    function nothing(reason) { return Promise.resolve(refusal({ reason })); }
    function unchanged() { return Promise.resolve({ ok: true, unchanged: true }); }
    function guard() {
      if (disposed) return refusal({ reason: 'disposed' });
      return canEdit() ? null : refusal({ reason: 'read_only' });
    }

    function selectedCards() { return board ? selection.map((id) => board.cards[id]).filter(Boolean) : []; }
    function selectedGroups() { return board ? selection.map((id) => board.groups[id]).filter(Boolean) : []; }

    /* ---------------------------------------------------------------- commands: adding and editing */

    async function addNote(options) {
      const blocked = guard(); if (blocked) return blocked;
      const o = options || {};
      const id = makeId();
      const card = { id, kind: 'note', data: { text: typeof o.text === 'string' ? o.text : '', tone: null } };
      if (typeof o.x === 'number' && typeof o.y === 'number') { card.x = o.x; card.y = o.y; }
      if (o.groupId) card.group_id = o.groupId;
      return done(await run([{ op: 'card.add', card }], () => { selection = [id]; connectorId = ''; }), { id });
    }

    async function addLink(options) {
      const blocked = guard(); if (blocked) return blocked;
      const o = options || {};
      const id = makeId();
      const url = typeof o.url === 'string' ? o.url.trim() : '';
      const card = { id, kind: 'link', data: { url, title: typeof o.title === 'string' ? o.title : '' } };
      if (typeof o.x === 'number' && typeof o.y === 'number') { card.x = o.x; card.y = o.y; }
      return done(await run([{ op: 'card.add', card }], () => { selection = [id]; connectorId = ''; }), { id });
    }

    /** Adds one card of any kind; a kind module supplies `data` (file, image, chat and diagram cards). */
    async function addCard(options) {
      const blocked = guard(); if (blocked) return blocked;
      const o = options || {};
      const id = makeId();
      const card = { id, kind: o.kind, data: o.data && typeof o.data === 'object' ? Object.assign({}, o.data) : {} };
      ['x', 'y', 'w', 'h'].forEach((key) => { if (typeof o[key] === 'number') card[key] = o[key]; });
      if (o.groupId) card.group_id = o.groupId;
      return done(await run([{ op: 'card.add', card }], () => { selection = [id]; connectorId = ''; }), { id });
    }

    /**
     * `base` is `{ rev }`: the item's content_rev as an editor read it when it opened. When the item changed since
     * (an accepted proposal, another window), the save is refused once as `stale` and `base` moves to the current
     * revision, so saving again keeps the caller's text, as the message says.
     */
    function movedOn(base, item) {
      if (!base || !Number.isInteger(base.rev) || base.rev === item.content_rev) return false;
      base.rev = item.content_rev;
      return true;
    }

    /** The main process refused the save as stale and sent the item as it is now: the caller has been told, so its base moves. */
    function seen(base, result) {
      if (base && result && result.reason === 'stale' && result.current && Number.isInteger(result.current.content_rev)) base.rev = result.current.content_rev;
      return result;
    }

    function editCard(id, data, base) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const card = board.cards[id];
      if (!card) return nothing('missing_target');
      const fields = data && typeof data === 'object' ? data : {};
      if (Object.keys(fields).every((key) => card.data[key] === fields[key])) return unchanged();
      if (movedOn(base, card)) return nothing('stale');
      return run([{ op: 'card.edit', id, content_rev: card.content_rev, data: Object.assign({}, fields) }]).then((result) => seen(base, result));
    }

    function editGroup(id, fields, base) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const group = board.groups[id];
      if (!group) return nothing('missing_target');
      const op = { op: 'group.edit', id, content_rev: group.content_rev };
      ['title', 'tone'].forEach((key) => { if (fields && fields[key] !== undefined && fields[key] !== group[key]) op[key] = fields[key]; });
      if (Object.keys(op).length === 3) return unchanged();
      return movedOn(base, group) ? nothing('stale') : run([op]).then((result) => seen(base, result));
    }

    function setTone(tone) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      if (tone !== null && !TONES.includes(tone)) return Promise.resolve(told({ reason: 'invalid', field: 'tone' }));
      const targets = selectedCards().filter((card) => card.kind === 'note');
      const groups = selectedGroups();
      if (!targets.length && !groups.length) return nothing('not_applicable');
      const ops = [];
      targets.forEach((card) => { if (card.data.tone !== tone) ops.push({ op: 'card.edit', id: card.id, content_rev: card.content_rev, data: { tone } }); });
      groups.forEach((group) => { if (group.tone !== tone) ops.push({ op: 'group.edit', id: group.id, content_rev: group.content_rev, tone }); });
      return ops.length ? run(ops) : unchanged();
    }

    /** Takes one card off the board whatever is selected: a note made a moment ago and cancelled (board-card-editing.js). */
    function removeCard(id) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      return board.cards[id] ? run([{ op: 'card.remove', id }]) : nothing('missing_target');
    }

    function removeSelected() {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      if (connectorId) return removeConnector(connectorId);
      const ops = selectedCards().map((card) => ({ op: 'card.remove', id: card.id }))
        .concat(selectedGroups().map((group) => ({ op: 'group.remove', id: group.id })));
      return ops.length ? run(ops) : nothing('nothing_selected');
    }

    /* ---------------------------------------------------------------- commands: place, order, copy */

    function placeItems(items) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const list = Array.isArray(items) ? items.filter((item) => item && typeof item.id === 'string') : [];
      const listed = new Set(list.map((item) => item.id));
      const ops = [];
      for (const item of list) {
        const card = board.cards[item.id];
        const target = card || board.groups[item.id];
        if (!target) return nothing('missing_target');
        const x = num(item.x, target.x);
        const y = num(item.y, target.y);
        const w = num(item.w, target.w);
        const h = num(item.h, target.h);
        const kind = card ? 'card.place' : 'group.place';
        const op = { op: kind, id: item.id };
        if (x !== target.x || y !== target.y) { op.x = x; op.y = y; }
        if (w !== target.w || h !== target.h) { op.w = w; op.h = h; }
        if (Object.keys(op).length > 2) ops.push(op);
        if (!card && (x !== target.x || y !== target.y)) {
          Object.values(board.cards).forEach((member) => {
            if (member.group_id === item.id && !listed.has(member.id)) ops.push({ op: 'card.place', id: member.id, x: member.x + (x - target.x), y: member.y + (y - target.y) });
          });
        }
      }
      return ops.length ? run(ops) : unchanged();
    }

    /** Arranges a group (by id), else the selection (one group, or cards), else the whole board, as one batch. */
    function tidy(groupId) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const tidyOps = (tidyModule() || {}).tidyOps;
      if (typeof tidyOps !== 'function') return nothing('unavailable');
      const cards = selectedCards();
      const groups = selectedGroups();
      let target = {};
      if (typeof groupId === 'string' && groupId) target = { groupId };
      else if (cards.length) target = { ids: cards.map((card) => card.id) };
      else if (groups.length === 1) target = { groupId: groups[0].id };
      const out = tidyOps(board, target);
      if (!out.ok) {
        const message = out.reason === 'too_many' ? jt('board.tidy.tooMany', 'That is too many cards to tidy at once. Select fewer.') : jt('board.tidy.failed', 'Could not tidy.');
        notify(message, 'warning');
        return Promise.resolve({ ok: false, reason: out.reason, message });
      }
      return out.ops.length ? run(out.ops) : unchanged();
    }

    /** Runs a prepared list (Break apart: adds, and the removal of the card) as one batch, then selects `selectIds` that exist. */
    function applyParts(ops, selectIds) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      if (!Array.isArray(ops) || !ops.length || ops.length > limits.batch_ops || !ops.every((op) => op && PART_OPS.has(op.op))) return nothing('invalid');
      const wanted = Array.isArray(selectIds) ? selectIds : [];
      return run(ops, () => { selection = wanted.filter(known); connectorId = ''; });
    }

    function nudgeSelected(dx, dy) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const items = selectedCards().concat(selectedGroups()).map((item) => ({ id: item.id, x: item.x + dx, y: item.y + dy }));
      return items.length ? placeItems(items) : nothing('nothing_selected');
    }

    /** Moves the selected cards above (or below) every other card, keeping their own order. */
    function reorder(front) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const picked = selectedCards().sort((a, b) => a.z - b.z);
      if (!picked.length) return nothing('nothing_selected');
      const others = Object.values(board.cards).filter((card) => !picked.includes(card)).map((card) => card.z);
      if (!others.length) return unchanged();
      const first = front ? Math.max(...others) + 1 : Math.min(...others) - picked.length;
      const ops = [];
      picked.forEach((card, index) => { if (card.z !== first + index) ops.push({ op: 'card.place', id: card.id, z: first + index }); });
      return ops.length ? run(ops) : unchanged();
    }

    async function duplicateSelected() {
      const blocked = guard(); if (blocked) return blocked;
      const cards = selectedCards();
      if (!cards.length) return refusal({ reason: 'nothing_selected' });
      const ids = [];
      const ops = cards.map((card) => {
        const id = makeId();
        ids.push(id);
        const copy = { id, kind: card.kind, x: card.x + COPY_OFFSET, y: card.y + COPY_OFFSET, w: card.w, h: card.h, data: JSON.parse(JSON.stringify(card.data)) };
        if (card.group_id) copy.group_id = card.group_id;
        return { op: 'card.add', card: copy };
      });
      return done(await run(ops, () => { selection = ids.slice(); connectorId = ''; }), { ids });
    }

    /* ---------------------------------------------------------------- commands: connectors and groups */

    async function connect(fromId, toId, options) {
      const blocked = guard(); if (blocked) return blocked;
      if (fromId === toId) return refusal({ reason: 'exists' });
      if (!board.cards[fromId] || !board.cards[toId]) return refusal({ reason: 'missing_target' });
      if (Object.values(board.connectors).some((connector) => connector.from === fromId && connector.to === toId)) return refusal({ reason: 'exists' });
      const id = makeId();
      const connector = { id, from: fromId, to: toId };
      if (options && typeof options.label === 'string' && options.label) connector.label = options.label;
      return done(await run([{ op: 'connector.add', connector }]), { id });
    }

    function editConnector(id, fields) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      const connector = board.connectors[id];
      if (!connector) return nothing('missing_target');
      const op = { op: 'connector.edit', id, content_rev: connector.content_rev };
      ['label', 'style', 'ends', 'tone'].forEach((key) => { if (fields && fields[key] !== undefined && fields[key] !== connector[key]) op[key] = fields[key]; });
      return Object.keys(op).length === 3 ? unchanged() : run([op]);
    }

    function removeConnector(id) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      if (!board.connectors[id]) return nothing('missing_target');
      return run([{ op: 'connector.remove', id }]);
    }

    async function groupSelected() {
      const blocked = guard(); if (blocked) return blocked;
      const cards = selectedCards();
      if (!cards.length) return refusal({ reason: 'nothing_selected' });
      const minX = Math.min(...cards.map((card) => card.x));
      const minY = Math.min(...cards.map((card) => card.y));
      const maxX = Math.max(...cards.map((card) => card.x + card.w));
      const maxY = Math.max(...cards.map((card) => card.y + card.h));
      const id = makeId();
      const group = { id, title: jt('board.group.defaultTitle', 'Group'), x: minX - GROUP_PAD, y: minY - GROUP_HEADER, w: maxX - minX + 2 * GROUP_PAD, h: maxY - minY + GROUP_PAD + GROUP_HEADER };
      const ops = [{ op: 'group.add', group }].concat(cards.map((card) => ({ op: 'group.assign', card_id: card.id, group_id: id })));
      return done(await run(ops, () => { selection = [id]; connectorId = ''; }), { id });
    }

    async function ungroupSelected() {
      const blocked = guard(); if (blocked) return blocked;
      const groups = selectedGroups();
      if (!groups.length) return refusal({ reason: 'nothing_selected' });
      const gone = new Set(groups.map((group) => group.id));
      const freed = Object.values(board.cards).filter((card) => gone.has(card.group_id)).map((card) => card.id);
      return run(groups.map((group) => ({ op: 'group.remove', id: group.id })), () => { selection = freed; connectorId = ''; });
    }

    function assignToGroup(cardIds, groupId) {
      const blocked = guard(); if (blocked) return Promise.resolve(blocked);
      if (groupId !== null && !board.groups[groupId]) return nothing('missing_target');
      const ops = [];
      for (const id of Array.isArray(cardIds) ? cardIds : []) {
        const card = board.cards[id];
        if (!card) return nothing('missing_target');
        if (card.group_id !== groupId) ops.push({ op: 'group.assign', card_id: id, group_id: groupId });
      }
      return ops.length ? run(ops) : unchanged();
    }

    /* ---------------------------------------------------------------- undo and redo */

    async function replay(name) {
      const blocked = guard(); if (blocked) return blocked;
      const started = version;
      let answer;
      try { answer = await source[name]({ boardId: board.id }); } catch (_error) { answer = { ok: false, reason: 'io' }; }
      if (!answer || typeof answer !== 'object') answer = { ok: false, reason: 'io' };
      if (disposed) return refusal({ reason: 'disposed' });
      if (!answer.ok) {
        if (NOTHING_TO.has(answer.reason)) {
          if (name === 'undo') flags.undo = false; else flags.redo = false;
          emit('board');
          return refusal(answer);
        }
        return told(answer);
      }
      if (answer.canUndo !== undefined) flags.undo = answer.canUndo === true;
      if (answer.canRedo !== undefined) flags.redo = answer.canRedo === true;
      const skipped = Array.isArray(answer.skipped) ? answer.skipped : [];
      if (answer.board && board && answer.board.id === board.id && (version === started || answer.board.rev >= board.rev)) replaceBoard(answer.board);
      else emit('board');
      if (skipped.length) {
        notify(jt('board.undo.skipped', 'Part of that could not be undone: {count} changes were left because the items changed since.', { count: skipped.length }), 'warning');
      }
      return { ok: true, skipped };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      board = null;
      selection = [];
      connectorId = '';
    }

    return {
      setBoard,
      getBoard: () => board,
      sentBatch,
      canEdit,
      canUndo: () => flags.undo === true,
      canRedo: () => flags.redo === true,
      onChange(listener) {
        if (disposed || typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      dispose,
      getSelection: () => selection.slice(),
      isSelected: (id) => selection.includes(id),
      select,
      toggle,
      clearSelection,
      selectAll,
      getSelectedConnector: () => connectorId,
      selectConnector,
      addNote,
      addLink,
      addCard,
      editCard,
      editGroup,
      setTone,
      removeCard,
      removeSelected,
      placeItems,
      tidy,
      applyParts,
      nudgeSelected,
      connect,
      editConnector,
      removeConnector,
      groupSelected,
      ungroupSelected,
      assignToGroup,
      bringForward: () => reorder(true),
      sendBack: () => reorder(false),
      duplicateSelected,
      undo: () => replay('undo'),
      redo: () => replay('redo'),
    };
  }

  return { createBoardEditor, TONES };
});
