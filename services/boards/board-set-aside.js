'use strict';

// "Show file" and "Remove from list" for a board that loads read-only (row 150 slice B11, owner decision D20; plan
// PROJECT_BOARD_2026-11-13 section 6.4). A damaged or newer-schema document is never rewritten or removed, so without
// these the board stays in the list for good and the person cannot find its file.
//
// - reveal({ boardId }) hands the injected revealPath (Electron's shell.showItemInFolder in the app) the absolute path
//   of <boards>/<board_id>.json. The store builds the path from the checked id; nothing else the caller sent is read.
// - setAside({ boardId }) renames the board's document, journal and proposals file to `<name>.aside-<ms>` in the same
//   folder (board-store.js setAsideFiles: no copy, no delete, no link followed), then drops the index entry, then emits
//   one `changed` event of kind `deleted` so every open page reads its list again. A document that cannot move changes
//   nothing (`io`); a later step that fails still drops the entry and answers `partial: true`, so the board never comes
//   back half-present (a restart drops an index entry whose document is gone).
// - Both answer only for a board in the index, not in the trash, that loads read-only now: `not_read_only` for any
//   other listed board (a healthy one is deleted with boards.delete, which keeps its undo), `not_found` for an id the
//   index does not know, `disabled` with the flag off. Both run in the board's own queue, so neither interleaves with
//   another call on the same board.
//
// board-service.js is at its line cap and has no public way to take an entry out of its index, so this module uses the
// service's own internals, all of them here: _call (flag check and the io envelope), _run (the board's queue, which
// loads the index first), _index, _load, _forget and _persistIndex. A public method on the service repays this.

const ids = require('./board-ids');

const fail = (reason) => ({ ok: false, reason });

function createBoardSetAside({ store, service, now = () => new Date(), revealPath, logger = () => {} } = {}) {
  if (!store || !service || typeof revealPath !== 'function') throw new Error('createBoardSetAside requires a store, a service and revealPath.');
  // The service, or a function that builds it on first use (the IPC registration builds it lazily).
  const serviceOf = () => (typeof service === 'function' ? service() : service);
  const log = (level, event, data) => { try { logger(level, event, data); } catch (_error) { /* a logger never fails a call */ } };
  const nowMs = () => {
    const value = now();
    return Math.floor(value instanceof Date ? value.getTime() : Number(value));
  };

  // One call on a listed, untrashed, read-only board, inside that board's queue. Only `boardId` is read from `raw`.
  function onReadOnlyBoard(raw, body) {
    const boardId = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw.boardId : undefined;
    if (!ids.isBoardId(boardId)) return Promise.resolve(fail('invalid'));
    const boards = serviceOf();
    return boards._call(() => boards._run(boardId, () => {
      const entry = boards._index.get(boardId);
      if (!entry) return fail('not_found');
      if (entry.deleted_at) return fail('not_read_only');
      const loaded = boards._load(boardId);
      if (loaded.missing) return fail('not_found');
      return loaded.readOnly ? body(boardId, entry, boards) : fail('not_read_only');
    }));
  }

  function reveal(raw) {
    return onReadOnlyBoard(raw, (boardId) => {
      const filePath = store.documentPath(boardId);
      if (!filePath) return fail('io');
      revealPath(filePath);
      return { ok: true };
    });
  }

  function setAside(raw) {
    return onReadOnlyBoard(raw, (boardId, entry, boards) => {
      const moved = store.setAsideFiles(boardId, nowMs());
      if (!moved) return fail('io');
      boards._index.delete(boardId);
      boards._forget(boardId);
      const indexed = boards._persistIndex();
      try {
        boards.emit('changed', { boardId, projectId: entry.project_id, kind: 'deleted', rev: entry.rev });
      } catch (_error) {
        log('WARN', 'boards.listener_failed', { code: 'set_aside' });
      }
      const partial = moved.failed.length > 0 || !indexed;
      log(partial ? 'WARN' : 'INFO', 'boards.set_aside', { partial, failed: moved.failed.join(','), indexed });
      return partial ? { ok: true, movedTo: moved.movedTo, partial: true } : { ok: true, movedTo: moved.movedTo };
    });
  }

  return Object.freeze({ reveal, setAside });
}

module.exports = { createBoardSetAside };
