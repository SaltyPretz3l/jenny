/* renderer/features/board/board-source-memory.js - the in-memory BoardSource (UMD).
 *
 * The same shape as the preload bridge `window.jennyShell.boards` and the main-process board service
 * (the project board plan, section 6): every call takes one object, resolves a result
 * object and never rejects for a refusal. It is built over `jennyBoardModel`, so it refuses what the
 * model refuses, caps a project at 20 boards, journals every applied batch for undo and redo with the
 * model's applyInverse and pushJournal, keeps a deleted board restorable for a while, and tells its
 * listeners what changed. It is the test double and the page's source when there is no bridge.
 *
 * Seeds: `seed` is an array of board documents, or { unreadable: { id, project_id, name, reason } }
 * for a board the real service could not read ('corrupt' | 'newer_schema'): it lists, answers get
 * with a read-only result and refuses every change.
 *
 * Pictures and file cards (slice B7) are stand-ins for the main process's: addAsset keeps the bytes in memory and may
 * trust a { width, height } hint; resolveFile, openFile and fileStatus work against settings.files
 * ({ root, paths: [relative paths that exist] }), and without it the project has no folder.
 *
 * Export and import (slice B10): exportFile answers the .jennyboard text through services/boards/board-package.js when it
 * can be loaded (Node, tests), else `disabled`; importFile takes { projectId, text } (tests only: there is no file picker
 * here, so without text it answers `disabled`).
 *
 * Proposals (slice C3): `setProposals(boardId, [proposal])` is the memory source's own way in (the main process makes them in the
 * app); it tells the listeners with a `proposals` event. listProposals answers what was set; decideProposal changes the
 * states of its changes the simple way (nothing is applied, no board changes) and tells the listeners again.
 *
 * A read-only board (slice B11): revealFile and setAside answer only for an `unreadable` seed. There is no file here, so
 * revealFile just answers ok; setAside drops the record, tells the listeners `deleted` and names the aside file as the
 * main process would. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardSourceMemory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;
  const ACTOR = 'owner';
  const UNKNOWN_TIME = '1970-01-01T00:00:00.000Z';

  function resolveModel() {
    if (typeof globalThis !== 'undefined' && globalThis.jennyBoardModel) return globalThis.jennyBoardModel;
    if (typeof require === 'function') {
      try { return require('../../../services/boards/board-model'); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function randomId() {
    const crypto = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (crypto && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const isText = (value) => typeof value === 'string' && value.length > 0;
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const refuse = (reason, extra) => Object.assign({ ok: false, reason }, extra || {});

  /** A model refusal as the contract carries it: the reason and its details, nothing else. */
  function passRefusal(result) {
    const out = { ok: false, reason: result && result.reason ? result.reason : 'invalid' };
    ['detail', 'op_index', 'limit', 'current'].forEach((key) => { if (result && result[key] !== undefined) out[key] = result[key]; });
    return out;
  }

  function createMemoryBoardSource(options) {
    const settings = options || {};
    const model = settings.model || resolveModel();
    if (!model || typeof model.applyBatch !== 'function') throw new Error('board source: jennyBoardModel unavailable');
    const makeId = typeof settings.makeId === 'function' ? settings.makeId : randomId;
    const readClock = typeof settings.now === 'function' ? settings.now : () => new Date();
    const restoreWindowMs = Number.isFinite(settings.restoreWindowMs) ? settings.restoreWindowMs : RESTORE_WINDOW_MS;
    const limit = model.LIMITS.boards_per_project;
    // id -> { board, unreadable?, undo: [{ batch_id, inverse }], redo: [{ batch_id, inverse }], deletedUntil: ISO|null }
    const records = new Map();
    const listeners = new Set();
    let order = 0;

    function nowIso() {
      const value = readClock();
      return typeof value === 'string' ? value : new Date(value).toISOString();
    }
    function boardId() { return `board_${makeId()}`; }

    function summary(record) {
      const doc = record.unreadable || record.board;
      return {
        id: doc.id, project_id: doc.project_id, name: doc.name, rev: record.unreadable ? 0 : doc.rev,
        created_at: record.unreadable ? UNKNOWN_TIME : doc.created_at, updated_at: record.unreadable ? UNKNOWN_TIME : doc.updated_at,
      };
    }
    function live(id) {
      const record = typeof id === 'string' ? records.get(id) : undefined;
      return record && record.deletedUntil === null ? record : null;
    }
    function liveCount(projectId) {
      let count = 0;
      records.forEach((record) => { if (record.deletedUntil === null && summary(record).project_id === projectId) count += 1; });
      return count;
    }
    function emit(record, kind, applied) {
      const doc = record.unreadable || record.board;
      const event = { boardId: doc.id, projectId: doc.project_id, kind, rev: record.unreadable ? 0 : doc.rev };
      if (applied) event.applied = applied;
      Array.from(listeners).forEach((listener) => {
        try { listener(event); } catch (_error) { /* a listener must not break the source */ }
      });
    }
    function add(board, unreadable) {
      const record = { board, unreadable: unreadable || null, undo: [], redo: [], deletedUntil: null, order: order += 1 };
      records.set(unreadable ? unreadable.id : board.id, record);
      return record;
    }
    function flags(record) {
      return { canUndo: record.undo.length > 0, canRedo: record.redo.length > 0 };
    }
    function journalPush(list, entry) {
      const pushed = model.pushJournal(list, entry);
      return { list: pushed.journal, undoable: pushed.ok === true };
    }

    (Array.isArray(settings.seed) ? settings.seed : []).forEach((item) => {
      if (item && isObject(item.unreadable)) {
        add(null, Object.assign({}, item.unreadable));
      } else {
        const read = model.normalizeBoard(clone(item));
        if (read.ok) add(read.board);
      }
    });

    function list(request) {
      if (!isObject(request) || !isText(request.projectId)) return refuse('invalid');
      const boards = [];
      records.forEach((record) => {
        if (record.deletedUntil === null && summary(record).project_id === request.projectId) boards.push(record);
      });
      boards.sort((a, b) => a.order - b.order);
      return { ok: true, boards: boards.map(summary) };
    }

    function create(request) {
      if (!isObject(request) || !isText(request.projectId)) return refuse('invalid');
      const made = model.createBoard({ id: boardId(), project_id: request.projectId, name: request.name, now: nowIso() });
      if (!made.ok) return passRefusal(made);
      if (liveCount(request.projectId) >= limit) return refuse('limit', { limit: 'boards_per_project' });
      const record = add(made.board);
      emit(record, 'created');
      return { ok: true, board: clone(record.board) };
    }

    function get(request) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return { ok: true, board: null, readOnly: true, reason: record.unreadable.reason };
      return Object.assign({ ok: true, board: clone(record.board), readOnly: false }, flags(record));
    }

    function applyTo(record, batch, kind) {
      const next = Object.assign({}, batch, { actor: ACTOR });
      const result = model.applyBatch(record.board, next, { now: nowIso(), authority: true });
      if (!result.ok) return passRefusal(result);
      if (result.duplicate) {
        return Object.assign({ ok: true, board: clone(record.board), applied: null, duplicate: true, undoable: false }, flags(record));
      }
      record.board = result.board;
      let undoable = false;
      if (result.inverse) {
        const pushed = journalPush(record.undo, { batch_id: result.applied.batch_id, inverse: result.inverse });
        record.undo = pushed.list;
        undoable = pushed.undoable;
      }
      record.redo = [];
      emit(record, kind, clone(result.applied));
      return Object.assign({ ok: true, board: clone(record.board), applied: clone(result.applied), undoable }, flags(record));
    }

    function apply(request) {
      if (!isObject(request) || !isObject(request.batch)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return refuse('read_only');
      return applyTo(record, request.batch, 'applied');
    }

    function replay(request, from, to, empty) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return refuse('read_only');
      const entry = record[from][record[from].length - 1];
      if (!entry) return refuse(empty);
      const result = model.applyInverse(record.board, entry.inverse, { now: nowIso(), authority: true, batch_id: `undo:${makeId()}` });
      if (!result.ok) return passRefusal(result);
      record[from] = record[from].slice(0, -1);
      if (result.inverse) {
        record[to] = journalPush(record[to], { batch_id: result.applied.batch_id, inverse: result.inverse }).list;
      }
      record.board = result.board;
      emit(record, 'applied', clone(result.applied));
      return Object.assign({ ok: true, board: clone(record.board), applied: clone(result.applied), skipped: clone(result.skipped || []) }, flags(record));
    }

    function undo(request) { return replay(request, 'undo', 'redo', 'nothing_to_undo'); }
    function redo(request) { return replay(request, 'redo', 'undo', 'nothing_to_redo'); }

    function rename(request) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return refuse('read_only');
      const batch = { batch_id: `rename_${makeId()}`, board_id: record.board.id, actor: ACTOR, ops: [{ op: 'board.rename', name: request.name }] };
      const result = applyTo(record, batch, 'renamed');
      return result.ok ? { ok: true, board: result.board } : result;
    }

    function copyOf(board, name, id, now) {
      const ids = new Map();
      const fresh = (old) => { if (!ids.has(old)) ids.set(old, makeId()); return ids.get(old); };
      const doc = clone(board);
      doc.id = id;
      doc.name = name;
      doc.rev = 0;
      doc.created_at = now;
      doc.updated_at = now;
      doc.recent_batches = [];
      const remap = (map, fix) => {
        const out = {};
        Object.keys(map).forEach((old) => { const item = map[old]; item.id = fresh(old); fix(item); out[item.id] = item; });
        return out;
      };
      doc.groups = remap(board.groups ? clone(board.groups) : {}, () => {});
      doc.cards = remap(clone(board.cards), (card) => { if (card.group_id) card.group_id = fresh(card.group_id); });
      doc.connectors = remap(clone(board.connectors), (connector) => { connector.from = fresh(connector.from); connector.to = fresh(connector.to); });
      return doc;
    }

    function duplicate(request) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return refuse('read_only');
      if (typeof request.name !== 'string') return refuse('invalid');
      const doc = copyOf(record.board, request.name, boardId(), nowIso());
      const read = model.normalizeBoard(doc);
      if (!read.ok) return passRefusal(read);
      if (liveCount(doc.project_id) >= limit) return refuse('limit', { limit: 'boards_per_project' });
      const created = add(read.board);
      emit(created, 'created');
      return { ok: true, board: clone(created.board) };
    }

    function remove(request) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      record.deletedUntil = new Date(new Date(nowIso()).getTime() + restoreWindowMs).toISOString();
      emit(record, 'deleted');
      return { ok: true, restorableUntil: record.deletedUntil };
    }

    function restore(request) {
      if (!isObject(request) || !isText(request.boardId)) return refuse('invalid');
      const record = records.get(request.boardId);
      if (!record || record.deletedUntil === null || record.deletedUntil < nowIso()) return refuse('not_found');
      if (liveCount(summary(record).project_id) >= limit) return refuse('limit', { limit: 'boards_per_project' });
      record.deletedUntil = null;
      emit(record, 'restored');
      return record.unreadable ? { ok: true, board: null } : { ok: true, board: clone(record.board) };
    }

    function onChanged(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }

    // Fetching a title needs the network from the main process; the in-memory source has neither.
    function fetchLinkTitle() { return { ok: false, reason: 'disabled' }; }

    /* ---------------------------------------------------------------- pictures and file cards (slice B7) */

    // An open board that can change, or the refusal.
    function openRecord(request) {
      if (!isObject(request)) return { failure: refuse('invalid') };
      const record = live(request.boardId);
      if (!record) return { failure: refuse('not_found') };
      return record.unreadable ? { failure: refuse('read_only') } : { record };
    }

    // Pictures are kept here by a stand-in for their hash and typed by their first bytes; the size is the request's
    // { width, height } hint when it has one, else a PNG's or a GIF's header, else 1 x 1.
    function pictureType(b) {
      if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ['png', 'image/png'];
      if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['jpg', 'image/jpeg'];
      if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return ['webp', 'image/webp'];
      if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ['gif', 'image/gif'];
      return null;
    }
    function headerSize(b, ext) {
      if (ext === 'png' && b.length >= 24) return { width: ((b[16] << 24) >>> 0) + (b[17] << 16) + (b[18] << 8) + b[19], height: ((b[20] << 24) >>> 0) + (b[21] << 16) + (b[22] << 8) + b[23] };
      if (ext === 'gif') return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
      return { width: 1, height: 1 };
    }
    function standInHash(b) {
      let out = '';
      for (let seed = 0; seed < 8; seed += 1) {
        let h = (0x811c9dc5 ^ seed) >>> 0;
        for (let i = 0; i < b.length; i += 1) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
        out += h.toString(16).padStart(8, '0');
      }
      return out;
    }
    const pictures = new Map(); // asset -> { bytes, mime }

    function addAsset(request) {
      const opened = openRecord(request);
      if (opened.failure) return opened.failure;
      const raw = request.bytes;
      const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
      if (!bytes) return refuse('invalid');
      if (bytes.byteLength > model.LIMITS.image_asset_bytes) return refuse('too_large');
      const type = pictureType(bytes);
      if (!type) return refuse('unsupported');
      const hinted = Number.isInteger(request.width) && Number.isInteger(request.height);
      const size = hinted ? { width: request.width, height: request.height } : headerSize(bytes, type[0]);
      const asset = standInHash(bytes);
      pictures.set(asset, { bytes: bytes.slice(), mime: type[1] });
      return { ok: true, asset, ext: type[0], mime: type[1], width: size.width, height: size.height, bytes: bytes.byteLength };
    }

    function readAsset(request) {
      const picture = isObject(request) && typeof request.asset === 'string' ? pictures.get(request.asset) : null;
      return picture ? { ok: true, bytes: picture.bytes.slice(), mime: picture.mime } : refuse('not_found');
    }

    // Files: settings.files = { root, paths: [relative paths that exist] }, read on every call; none means no folder.
    function relativeOf(raw) {
      const root = settings.files.root ? String(settings.files.root).replace(/\\/g, '/').replace(/\/+$/, '') : '';
      let text = String(raw).replace(/\\/g, '/');
      if (root && text.toLowerCase().startsWith(`${root.toLowerCase()}/`)) text = text.slice(root.length + 1);
      else if (/^([A-Za-z]:)?\//.test(text)) return null;
      const parts = text.split('/').filter((part) => part && part !== '.');
      return parts.length && parts.indexOf('..') < 0 ? parts.join('/') : null;
    }
    const known = () => new Set(Array.isArray(settings.files && settings.files.paths) ? settings.files.paths : []);

    function resolveFile(request) {
      if (!isObject(request) || !isText(request.path)) return refuse('invalid');
      const opened = openRecord(request);
      if (opened.failure) return opened.failure;
      if (!settings.files) return refuse('no_root');
      const path = relativeOf(request.path);
      if (path === null) return refuse('outside');
      return known().has(path) ? { ok: true, path, title: path.split('/').pop() } : refuse('not_found');
    }

    function openFile(request) {
      const opened = openRecord(request);
      if (opened.failure) return opened.failure;
      const card = typeof request.cardId === 'string' ? opened.record.board.cards[request.cardId] : null;
      if (!card) return refuse('not_found');
      if (card.kind !== 'file') return refuse('invalid');
      if (!settings.files) return refuse('no_root');
      return known().has(card.data.path) ? { ok: true, relativePath: card.data.path, projectId: opened.record.board.project_id } : refuse('not_found');
    }

    function fileStatus(request) {
      const opened = openRecord(request);
      if (opened.failure) return opened.failure;
      if (!settings.files) return refuse('no_root');
      const paths = known();
      const missing = Object.values(opened.record.board.cards).filter((card) => card.kind === 'file' && !paths.has(card.data.path)).map((card) => card.id);
      return { ok: true, missing };
    }

    // The selection is reported for the docked chat's turns, which the in-memory source never has.
    function setSelection() { return { ok: true }; }

    /* ---------------------------------------------------------------- the .jennyboard file (slice B10) */

    function packageModule() {
      if (typeof require !== 'function') return null;
      try { return require('../../../services/boards/board-package'); } catch (_error) { return null; }
    }

    function exportFile(request) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return refuse('unreadable');
      const pkg = packageModule();
      if (!pkg) return refuse('disabled');
      const exts = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
      const wanted = new Set(Object.values(record.board.cards).filter((card) => card.kind === 'image').map((card) => card.data.asset));
      const assets = Array.from(wanted).filter((asset) => pictures.has(asset)).map((asset) => ({ ext: exts[pictures.get(asset).mime], bytes: pictures.get(asset).bytes }));
      const packed = pkg.pack({ board: record.board, assets, now: nowIso() });
      return packed.ok ? { ok: true, name: `${record.board.name}.jennyboard`, text: packed.text } : passRefusal(packed);
    }

    function importFile(request) {
      if (!isObject(request) || !isText(request.projectId)) return refuse('invalid');
      const pkg = typeof request.text === 'string' ? packageModule() : null;
      if (!pkg) return refuse('disabled');
      if (liveCount(request.projectId) >= limit) return refuse('limit', { limit: 'boards_per_project' });
      const out = pkg.unpack(request.text, { makeId, now: nowIso(), projectId: request.projectId, newBoardId: boardId() });
      if (!out.ok) return passRefusal(out);
      let skippedPictures = 0;
      out.pictures.forEach((picture) => {
        const type = pictureType(picture.bytes);
        if (type) pictures.set(standInHash(picture.bytes), { bytes: picture.bytes.slice(), mime: type[1] });
        else skippedPictures += 1;
      });
      const record = add(out.board);
      emit(record, 'created');
      return { ok: true, board: clone(record.board), skippedPictures };
    }

    /* ---------------------------------------------------------------- proposals (slice C3) */

    const proposals = new Map(); // board id -> [proposal], newest first, the shape listProposals answers
    const OPEN_STATES = new Set(['pending', 'partly_accepted']);
    function tally(proposal) {
      const counts = { total: proposal.changes.length, pending: 0, additions: 0, edits: 0, removals: 0, applied: 0, refused: 0, skipped: 0, rejected: 0 };
      proposal.changes.forEach((item) => {
        if (item.state !== 'pending') { counts[item.state] += 1; return; }
        counts.pending += 1;
        counts[item.class === 'addition' ? 'additions' : item.class === 'edit' ? 'edits' : 'removals'] += 1;
      });
      proposal.counts = counts;
      if (proposal.state !== 'superseded') {
        if (counts.pending > 0) proposal.state = counts.applied > 0 ? 'partly_accepted' : 'pending';
        else proposal.state = counts.applied === 0 ? 'rejected' : counts.rejected > 0 ? 'partly_accepted' : 'accepted';
      }
      proposal.open = OPEN_STATES.has(proposal.state) && (proposal.state === 'pending' || counts.pending > 0);
    }

    // `list` is newest first; each is the public shape (`open`, `counts`, `changes`, `preview`).
    function setProposals(id, list) {
      const record = live(id);
      if (!record || !Array.isArray(list)) return;
      proposals.set(id, clone(list));
      emit(record, 'proposals');
    }

    function listProposals(request) {
      if (!isObject(request)) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      return { ok: true, proposals: clone(proposals.get(request.boardId) || []) };
    }

    function decideProposal(request) {
      if (!isObject(request) || !['accept_additions', 'accept', 'reject'].includes(request.action)
        || (request.n !== undefined && !Number.isInteger(request.n))) return refuse('invalid');
      const record = live(request.boardId);
      if (!record) return refuse('not_found');
      if (record.unreadable) return refuse('read_only');
      const proposal = (proposals.get(request.boardId) || []).find((item) => item.id === request.proposalId);
      if (!proposal) return refuse('not_found');
      if (!proposal.open) return refuse('closed');
      const pending = proposal.changes.filter((item) => item.state === 'pending');
      let applied = 0;
      if (request.action === 'accept_additions') {
        const additions = pending.filter((item) => item.class === 'addition');
        if (!additions.length) return refuse('nothing_pending');
        additions.forEach((item) => { item.state = 'applied'; applied += 1; });
      } else {
        const targets = pending.filter((item) => request.n === undefined || item.n === request.n);
        if (request.n !== undefined && (!targets.length || (request.action === 'accept' && targets[0].class === 'addition'))) return refuse('invalid');
        targets.forEach((item) => { item.state = request.action === 'accept' ? 'applied' : 'rejected'; if (request.action === 'accept') applied += 1; });
      }
      tally(proposal);
      emit(record, 'proposals');
      return { ok: true, proposal: clone(proposal), applied, skipped: 0 };
    }

    /* ---------------------------------------------------------------- a board that loads read-only (slice B11) */

    function readOnlyRecord(request) {
      const record = isObject(request) ? live(request.boardId) : null;
      if (!record) return { failure: refuse(isObject(request) ? 'not_found' : 'invalid') };
      return record.unreadable ? { record } : { failure: refuse('not_read_only') };
    }

    function revealFile(request) { return readOnlyRecord(request).failure || { ok: true }; }

    function setAside(request) {
      const found = readOnlyRecord(request);
      if (found.failure) return found.failure;
      records.delete(request.boardId);
      emit(found.record, 'deleted');
      return { ok: true, movedTo: `${request.boardId}.json.aside-${new Date(nowIso()).getTime()}` };
    }

    return {
      list, create, get, apply, undo, redo, rename, duplicate, delete: remove, restore, fetchLinkTitle, setSelection, onChanged,
      addAsset, readAsset, resolveFile, openFile, fileStatus, exportFile, importFile, setProposals, listProposals, decideProposal,
      revealFile, setAside,
    };
  }

  return { createMemoryBoardSource, RESTORE_WINDOW_MS };
});
