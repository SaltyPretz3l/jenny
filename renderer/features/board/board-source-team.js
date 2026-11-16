/* renderer/features/board/board-source-team.js - the BoardSource of one team project's boards (UMD).
 *
 * Row 151 slice T7 (D30): a team project's boards open in the Board tab. This is the contract of
 * the project board plan section 6 over the `team.board…` bridge methods (services/team/board-ipc.js),
 * for one (team, project). The page reaches it through board-source-bridge.js createScopedBoardSource. It is loaded
 * only with Team on, and nothing here runs before createTeamBoardSource is called.
 *
 * - The host is the truth and this Jenny's main process keeps the open board (services/team/board-client.js): `get`
 *   opens it there and answers its view, `apply` hands it a batch, and the host's word comes back as events. One board
 *   is held open at a time; opening another, and dispose(), close the one before.
 * - Every answer is { ok: true, ... } or { ok: false, reason, message?, teamReason }: `reason` is one of the board's own
 *   words where one fits (so the page and the editor act as they do on a board of one's own) and `message` is the
 *   sentence to say when the board's own sentence for that word would be wrong. A refusal from the board model itself
 *   keeps the model's reason, detail and limit.
 * - Events: `applied` (reload unless the editor sent the batch), `refused` (a batch the host turned down: the page
 *   reloads and says `message`), `proposals`, and `list` (anything else reloads the list).
 * - Not here: undo and redo (the answer is nothing_to_undo / nothing_to_redo), duplicate, export and import of a
 *   file, file cards, the selection report. whyNot(name) says why in a sentence; it also says what the member's role
 *   in the project does not allow, so a control is disabled with its reason instead of refused by the host.
 * - presence: who else is viewing, their pointers and the notes they hold, with cursor(), lock() and unlock().
 * - Slice T9 (D31, D32): history(id) answers the board's last changes as counts of operations, never a card's text;
 *   revert(id, rev) takes one back and trash() lists the deleted boards, both a project admin's.
 *
 * copyBoardToTeam copies one of this Jenny's boards into a team project: the document in one request, then its
 * pictures one by one. Board text reaches the page as data only; nothing here writes markup. Everything the host says is bounded and
 * checked here (row 151 hardening): an answer that is `ok` with nothing in it is `io`, a board list keeps boards with a string id once
 * (at most 200) and their names cleaned (`cleanText`, the one cleaner of the team half), and a refusal's words are the board's own. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardSourceTeam = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // A team refusal as one of the board's own words. A reason that is not here is `io`.
  const OWN_WORD = Object.freeze({
    team_board_not_found: 'not_found', team_not_found: 'not_found', team_board_asset_not_found: 'not_found',
    team_board_read_only: 'read_only', team_project_read_only: 'read_only', role_forbidden: 'read_only',
    team_board_limit: 'limit', team_board_invalid: 'invalid',
    team_board_proposal_closed: 'closed', team_board_proposal_not_found: 'closed', team_board_proposal_additions_first: 'additions_first',
    team_board_asset_size_limit: 'too_large', team_board_asset_unsupported: 'unsupported', team_board_asset_dimensions: 'dimensions',
    team_board_asset_invalid: 'unreadable',
  });
  // The words whose own sentence is right as it is.
  const OWN_SENTENCE = new Set(['not_found', 'limit', 'invalid', 'closed', 'additions_first', 'too_large', 'unsupported', 'dimensions', 'unreadable']);
  const WRITER_CALLS = new Set(['create', 'rename', 'apply', 'addAsset', 'decideProposal', 'lock', 'importBoard']);
  const ADMIN_CALLS = new Set(['delete', 'restore', 'revert', 'trash']);
  const NOT_HERE = new Set(['undo', 'redo', 'duplicate', 'setSelection', 'resolveFile', 'openFile', 'fileStatus', 'exportFile', 'importFile', 'revealFile', 'setAside']);
  const EMPTY_PRESENCE = Object.freeze({ viewers: [], cursors: [], locks: [] });
  const NO_ANSWER = Object.freeze({ ok: false, error: { reason: 'team_unavailable' } });

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const HIDDEN = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g; // taken out; U+200C and U+200D stay: they join letters and emoji
  const BREAKS = /[\u2028\u2029]/g;
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  const TOKEN = /^[A-Za-z0-9_.:-]{1,60}$/;
  const BOARDS_MAX = 200; // rows of a board list kept (the page's own limit is far below)
  const PRESENCE_MAX = 500; // viewers, pointers or holds kept from one push
  const CHANGES_MAX = 200; // history rows kept (the host keeps 200)
  const OPS_MAX = 32; // operation names kept in one row
  const OP_NAME = /^[a-z]{1,16}\.[a-z_]{1,16}$/;
  const KINDS = new Set(['change', 'proposal', 'revert']);

  /** Another person's text made safe to show, the one cleaner of the team half: controls and line separators become spaces; marks, overrides
   *  and isolates are taken out (the two joiners stay); a lone surrogate half becomes a replacement character; spaces fold; and it is cut at
   *  `max` whole characters with an ellipsis. */
  function cleanText(value, max = 80) {
    const flat = Array.from(String(value == null ? '' : value).slice(0, 4 * max + 64), (ch) => { const c = ch.charCodeAt(0); return c < 32 || (c >= 127 && c < 160) ? ' ' : ch; })
      .join('').replace(BREAKS, ' ').replace(HIDDEN, '').replace(LONE, '\ufffd').replace(/\s+/g, ' ').trim();
    if (!/[^\u200c\u200d\s]/.test(flat)) return ''; // nothing to read: joiners alone are no name
    const chars = Array.from(flat);
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
  }
  const ownWord = (reason) => (Object.hasOwn(OWN_WORD, reason) ? OWN_WORD[reason] : '');
  // A board of an answer, its name cleaned: the page draws it in a list, a label and a tooltip.
  const named = (board) => (isObject(board) ? { ...board, name: cleanText(board.name, 200) } : null);
  function boardRows(list) {
    const seen = new Set();
    const rows = [];
    for (const row of Array.isArray(list) ? list : []) {
      if (rows.length >= BOARDS_MAX) break;
      if (!isObject(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(named(row));
    }
    return rows;
  }
  const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  const word = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  /** A history answer's counts by operation: own keys that look like an operation name with a positive integer count, at most OPS_MAX; null when there are none to read. */
  function opCounts(ops) {
    if (!isObject(ops)) return null;
    const out = {};
    let kept = 0;
    for (const name of Object.keys(ops)) {
      if (kept >= OPS_MAX) break;
      if (OP_NAME.test(name) && count(ops[name])) { out[name] = ops[name]; kept += 1; }
    }
    return out;
  }
  // The changes of a board's history, each rebuilt to the page's own shape (no host text but the member id and the time).
  function changeRows(list) {
    return (Array.isArray(list) ? list : []).filter(isObject).slice(0, CHANGES_MAX).map((entry) => {
      const rev = count(entry.rev);
      return { rev, actor: word(entry.actor, 160), at: word(entry.at, 40), kind: KINDS.has(entry.kind) ? entry.kind : 'change', ofRev: count(entry.of_rev) || null,
        ops: opCounts(entry.ops), takeable: rev > 0 && entry.takeable === true, reverted: entry.reverted === true };
    });
  }
  // The deleted boards of a project: boardRows, and when and by whom each was deleted.
  const trashRows = (list) => boardRows(list).map((row) => ({ id: row.id, name: row.name, deletedAt: word(row.deleted_at, 40), deletedBy: word(row.deleted_by, 160) }));
  const writes = (role) => role === 'writer' || role === 'admin' || role === 'owner';
  const administers = (role) => role === 'admin' || role === 'owner';

  function sentences(jt, words) {
    const busy = () => jt('board.team.refused.busy', 'The team server is busy. Try again in a moment.');
    const full = () => jt('board.team.refused.full', "This team's boards have used the space they have for pictures.");
    const said = {
      role_forbidden: () => jt('board.team.refused.role', 'Your role in this project does not allow that.'),
      team_project_read_only: () => jt('board.team.refused.reader', "You can look at this project's boards. Its writers and admins can change them."),
      team_board_read_only: () => jt('board.team.refused.unreadable', 'The team server cannot read this board, so it cannot be changed.'),
      team_board_note_locked: () => jt('board.team.refused.locked', 'Someone else is editing that note.'),
      team_board_chat_outside_project: () => jt('board.team.refused.chat', 'A chat card on a team board can only point at a conversation of this project.'),
      team_board_rate_limit: busy,
      team_board_upload_limit: busy,
      team_board_queue_full: () => jt('board.team.refused.queue', 'Too many changes are waiting to be sent. They go out when the team can be reached again.'),
      team_board_not_viewing: () => jt('board.team.refused.notViewing', 'Open this board to answer what Jenny proposes on it.'),
      team_board_storage_limit: () => jt('board.team.refused.storage', "This project's boards have used the space the team server gives them."),
      team_board_trash_limit: () => jt('board.team.refused.trash', 'This project has too many deleted boards. Each is removed for good 7 days after it was deleted.'),
      team_board_asset_storage_limit: full,
      team_board_asset_limit: full,
      team_board_unavailable: () => jt('board.team.refused.unavailable', 'The team server cannot reach its boards right now. Try again in a moment.'),
      disk_pressure: () => jt('board.team.refused.disk', 'The team server is low on disk space, so nothing can be added right now.'),
    };
    /** The sentence for a team refusal, or '' when the board's own sentence for its word is the one to say. */
    return function sentence(error) {
      const reason = isObject(error) && typeof error.reason === 'string' ? error.reason : '';
      if (Object.prototype.hasOwnProperty.call(said, reason)) return said[reason]();
      if (OWN_SENTENCE.has(ownWord(reason))) return '';
      // Everything else is the team's own wording (not connected, pending, removed, and so on).
      if (reason && words && typeof words.errorText === 'function') {
        try { return cleanText(words.errorText(error), 300); } catch (_error) { return ''; }
      }
      return '';
    };
  }

  /**
   * deps: { bridge (window.jennyShell.team), teamId, projectId, role(): the member's role in the project now
   * ('admin' | 'writer' | 'reader'), words (the Team tab's strings, for errorText), jt }.
   */
  function createTeamBoardSource(deps) {
    const bridge = deps.bridge;
    const teamId = String(deps.teamId || '');
    const projectId = String(deps.projectId || '');
    const jt = typeof deps.jt === 'function' ? deps.jt : fallbackJt;
    const sentence = sentences(jt, deps.words || null);
    const roleNow = () => { try { return String(deps.role() || ''); } catch (_error) { return ''; } };
    const project = { team_id: teamId, project_id: projectId };
    const on = (boardId) => ({ team_id: teamId, project_id: projectId, board_id: String(boardId || '') });

    let disposed = false;
    let wanted = ''; // the board the page asked for last: the one board held open on this Jenny
    let presence = EMPTY_PRESENCE;
    const listeners = new Set();
    const watchers = new Set();

    const fan = (set, value) => Array.from(set).forEach((listener) => {
      try { listener(value); } catch (_error) { /* one listener must not stop the next */ }
    });
    const emit = (event) => { if (!disposed) fan(listeners, event); };

    async function call(method, payload) {
      if (disposed || !bridge || typeof bridge[method] !== 'function') return NO_ANSWER;
      let answer;
      try { answer = await bridge[method](payload); } catch (_error) { answer = null; }
      return isObject(answer) ? answer : NO_ANSWER;
    }

    function refusal(answer) {
      const error = isObject(answer) && isObject(answer.error) ? answer.error : {};
      const teamReason = typeof error.reason === 'string' ? error.reason : '';
      const inner = isObject(answer) && isObject(answer.board) ? answer.board : null;
      if (teamReason === 'team_board_refused' && inner && typeof inner.reason === 'string') {
        // The board model's own refusal, in its own closed words: said as on a board of one's own. A word that is not one is `io`.
        const out = { ok: false, reason: /^[a-z_]{1,40}$/.test(inner.reason) ? inner.reason : 'io', teamReason };
        if (typeof inner.detail === 'string' && TOKEN.test(inner.detail)) out.detail = inner.detail;
        if (typeof inner.limit === 'string' && TOKEN.test(inner.limit)) out.limit = inner.limit;
        if (Number.isSafeInteger(inner.index)) out.op_index = inner.index;
        // The team host keeps the way back of every change (1 MB of them): a change too large for that is not taken.
        if (out.limit === 'journal_bytes') out.message = jt('board.team.refused.tooLarge', 'That is too much to change at once on a team board. Change fewer items at a time.');
        return out;
      }
      const out = { ok: false, reason: ownWord(teamReason) || 'io', teamReason };
      const message = sentence(error);
      if (message) out.message = message;
      return out;
    }

    function whyNot(name) {
      if (name === 'undo' || name === 'redo') return jt('board.team.off.undo', 'Undo and redo are not available on a team board.');
      if (NOT_HERE.has(name)) return jt('board.team.off.general', 'Not available on a team board.');
      const role = roleNow();
      if (ADMIN_CALLS.has(name) && !administers(role)) return jt('board.team.off.admin', 'Only an admin of this project can do that.');
      if (WRITER_CALLS.has(name) && !writes(role)) return jt('board.team.off.writer', 'You can look at this board. Writers and admins of this project can change it.');
      return '';
    }
    // A change the member's role does not allow is not sent: the host would refuse it, and the queue would hold it.
    const held = (name) => {
      const message = whyNot(name);
      return message ? { ok: false, reason: 'read_only', teamReason: '', message } : null;
    };
    const plain = async (method, payload, pick) => {
      const answer = await call(method, payload);
      if (answer.ok !== true) return refusal(answer);
      const picked = pick ? pick(answer) : {};
      return picked ? Object.assign({ ok: true }, picked) : { ok: false, reason: 'io', teamReason: '' }; // `ok` with nothing in it is not an answer
    };
    const withBoard = (answer) => { const board = named(answer.board); return board ? { board } : null; };
    const guarded = (name, method, payload, pick) => {
      const stopped = held(name);
      return stopped ? Promise.resolve(stopped) : plain(method, payload, pick);
    };

    function setPresence(value) {
      const next = isObject(value) ? value : EMPTY_PRESENCE;
      const some = (list) => (Array.isArray(list) ? list.slice(0, PRESENCE_MAX) : []);
      presence = { viewers: some(next.viewers), cursors: some(next.cursors), locks: some(next.locks) };
      if (!disposed) fan(watchers, presence);
    }

    function close(boardId) {
      if (bridge && typeof bridge.boardClose === 'function') { try { Promise.resolve(bridge.boardClose(on(boardId))).catch(() => {}); } catch (_error) { /* closed with the team */ } }
    }

    async function get(request) {
      const boardId = String(request && request.boardId || '');
      const before = wanted;
      wanted = boardId;
      if (before && before !== boardId) { close(before); setPresence(null); }
      const answer = await call('boardOpen', on(boardId));
      if (wanted !== boardId) {
        // The page asked for another board while this one was read: it is not kept open.
        if (answer.ok === true && !disposed) close(boardId);
        return { ok: false, reason: 'io', teamReason: '' };
      }
      if (answer.ok !== true) return refusal(answer);
      setPresence(answer.presence);
      if (answer.read_only === true || !isObject(answer.board)) {
        return { ok: true, readOnly: true, reason: 'team_unreadable', message: sentence({ reason: 'team_board_read_only' }) };
      }
      return { ok: true, board: answer.board, canUndo: false, canRedo: false, viewOnly: !writes(roleNow()) };
    }

    async function apply(request) {
      const batch = request && request.batch;
      const stopped = held('apply');
      if (stopped) return stopped;
      if (!isObject(batch)) return { ok: false, reason: 'invalid', teamReason: '' };
      // The member's id is the host's to write: the page's actor and board id are not sent.
      const answer = await call('boardApply', Object.assign(on(request.boardId), { batch: { batch_id: batch.batch_id, ops: batch.ops } }));
      if (answer.ok !== true) return refusal(answer);
      return { ok: true, board: isObject(answer.board) ? answer.board : undefined, duplicate: answer.duplicate === true }; // the editor reads a board only when there is one
    }

    function decideProposal(request) {
      const numbered = request.n !== undefined;
      // Accept additions is the host's accept with no number; every edit and removal is its own accept (D16),
      // so an accept that names no change is not sent as one.
      const known = request.action === 'accept_additions' || request.action === 'reject' || (request.action === 'accept' && numbered);
      if (!known) return Promise.resolve({ ok: false, reason: 'invalid', teamReason: '' });
      const payload = Object.assign(on(request.boardId), { proposal_id: request.proposalId });
      if (request.action !== 'accept_additions' && numbered) payload.n = request.n;
      return guarded('decideProposal', request.action === 'reject' ? 'boardProposalReject' : 'boardProposalAccept', payload,
        (answer) => ({ proposal: isObject(answer.proposal) ? answer.proposal : null, applied: answer.applied, skipped: answer.skipped }));
    }

    function onBoard(payload) {
      if (disposed || !isObject(payload) || payload.team_id !== teamId || payload.project_id !== projectId) return;
      const boardId = typeof payload.board_id === 'string' ? payload.board_id : '';
      if (payload.kind === 'list_changed') { emit({ kind: 'list', projectId }); return; }
      if (!boardId || boardId !== wanted) return;
      switch (payload.kind) {
        case 'applied': emit({ kind: 'applied', projectId, boardId, applied: isObject(payload.applied) ? payload.applied : null, actor: typeof payload.actor === 'string' ? payload.actor : '', own: payload.own === true }); return;
        // The snapshot was read again, or the board is gone for this member: the page reads it and finds out which.
        case 'reloaded':
        case 'gone': emit({ kind: 'applied', projectId, boardId, applied: null }); return;
        case 'refused': {
          const told = refusal({ error: { reason: payload.reason }, board: isObject(payload.detail) ? payload.detail : null });
          emit({ kind: 'refused', projectId, boardId, batchId: payload.batch_id, cardId: typeof payload.card_id === 'string' ? payload.card_id : '',
            reason: told.reason, teamReason: told.teamReason,
            message: told.message || jt('board.team.refused.batch', 'The team did not take your last change, so it was taken back here.') });
          return;
        }
        case 'proposals_changed': emit({ kind: 'proposals', projectId, boardId }); return;
        case 'presence': setPresence(payload); return;
        default: return;
      }
    }
    let offBoard = null;
    try { offBoard = bridge && typeof bridge.onBoard === 'function' ? bridge.onBoard(onBoard) : null; } catch (_error) { offBoard = null; }

    const live = (method, extra) => (wanted ? plain(method, Object.assign(on(wanted), extra)) : Promise.resolve({ ok: false, reason: 'not_found', teamReason: '' }));

    const source = {
      list: (request) => (request && request.projectId && request.projectId !== projectId
        ? Promise.resolve({ ok: false, reason: 'not_found', teamReason: '' })
        : plain('boardList', project, (answer) => ({ boards: boardRows(answer.boards) }))),
      create: (request) => guarded('create', 'boardCreate', Object.assign({}, project, { name: request.name }), withBoard),
      rename: (request) => guarded('rename', 'boardRename', Object.assign(on(request.boardId), { name: request.name })),
      delete: (request) => guarded('delete', 'boardDelete', on(request.boardId)),
      restore: (request) => guarded('restore', 'boardRestore', on(request.boardId), withBoard),
      history: (request) => plain('boardHistory', on(request.boardId), (answer) => ({ changes: changeRows(answer.changes) })),
      revert: (request) => guarded('revert', 'boardRevert', Object.assign(on(request.boardId), { rev: request.rev }), (answer) => ({ reverted: Number.isSafeInteger(answer.reverted) ? answer.reverted : 0, skipped: Number.isSafeInteger(answer.skipped) ? answer.skipped : 0 })),
      trash: () => guarded('trash', 'boardTrash', project, (answer) => ({ boards: trashRows(answer.boards) })),
      get,
      apply,
      undo: () => Promise.resolve({ ok: false, reason: 'nothing_to_undo', teamReason: '' }),
      redo: () => Promise.resolve({ ok: false, reason: 'nothing_to_redo', teamReason: '' }),
      addAsset: (request) => guarded('addAsset', 'boardAssetAdd', Object.assign(on(request.boardId), { bytes: request.bytes }),
        (answer) => (typeof answer.asset === 'string' ? { asset: answer.asset, mime: answer.mime, width: answer.width, height: answer.height } : null)),
      readAsset: (request) => plain('boardAssetRead', Object.assign(on(request.boardId), { asset: request.asset }), (answer) => (answer.bytes ? { bytes: answer.bytes, mime: answer.mime } : null)),
      listProposals: (request) => plain('boardProposals', on(request.boardId), (answer) => ({ proposals: Array.isArray(answer.proposals) ? answer.proposals.filter(isObject) : [] })),
      decideProposal,
      onChanged(listener) {
        if (disposed || typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      /** A board document of this Jenny's, copied in whole as a new board of this project (its pictures: copyBoardToTeam). */
      importBoard: (board) => guarded('importBoard', 'boardImport', Object.assign({}, project, { board }),
        (answer) => { const made = withBoard(answer); return made && Object.assign(made, { pictures: Array.isArray(answer.pictures) ? answer.pictures.slice(0, 500) : [] }); }),
      can: (name) => whyNot(name) === '' && typeof source[name] === 'function',
      whyNot,
      scope: Object.freeze({ teamId, projectId }),
      role: roleNow,
      presence: Object.freeze({
        get: () => presence,
        subscribe(listener) {
          if (disposed || typeof listener !== 'function') return () => {};
          watchers.add(listener);
          return () => { watchers.delete(listener); };
        },
        // The pointer is best effort and never answered with more than ok.
        cursor: (point) => { if (wanted && !disposed) void call('boardCursor', Object.assign(on(wanted), { x: point.x, y: point.y, selected: Array.isArray(point.selected) ? point.selected : [] })); },
        /** Holds a note while the member types in it: { ok } or { ok: false, message, heldBy }. */
        async lock(cardId) {
          const stopped = held('lock');
          if (stopped) return stopped;
          if (!wanted) return { ok: false, reason: 'not_found', teamReason: '' };
          const answer = await call('boardLock', Object.assign(on(wanted), { card_id: cardId }));
          if (answer.ok === true) return { ok: true };
          return Object.assign(refusal(answer), { heldBy: typeof answer.held_by === 'string' ? answer.held_by.slice(0, 100) : '' });
        },
        unlock: () => live('boardUnlock'),
      }),
      dispose() {
        if (disposed) return;
        if (wanted) close(wanted);
        disposed = true;
        wanted = '';
        if (typeof offBoard === 'function') { try { offBoard(); } catch (_error) { /* the bridge is gone */ } }
        listeners.clear();
        watchers.clear();
      },
    };
    return source;
  }

  /**
   * Copies one of this Jenny's boards into a team project. deps: { own (this Jenny's BoardSource), team (the team
   * project's source), boardId }. The document goes in one request (the host makes the board with its content or
   * not at all); then each picture its cards name is read here and sent. Resolves
   * { ok: true, board: { id, name }, pictures: { sent, failed } } or the refusal; never rejects.
   */
  async function copyBoardToTeam({ own, team, boardId }) {
    let read;
    try { read = await own.get({ boardId }); } catch (_error) { read = null; }
    if (!isObject(read) || read.ok !== true || !isObject(read.board)) return { ok: false, reason: isObject(read) && read.reason ? read.reason : 'io' };
    const made = await team.importBoard(read.board);
    if (!made || made.ok !== true || !isObject(made.board)) return made && made.ok === false ? made : { ok: false, reason: 'io' };
    let sent = 0;
    let failed = 0;
    for (const asset of made.pictures || []) {
      let ok = false;
      try {
        const picture = await own.readAsset({ boardId, asset });
        if (picture && picture.ok === true && picture.bytes) ok = (await team.addAsset({ boardId: made.board.id, bytes: picture.bytes })).ok === true;
      } catch (_error) { ok = false; }
      if (ok) sent += 1; else failed += 1;
    }
    return { ok: true, board: { id: made.board.id, name: made.board.name }, pictures: { sent, failed } };
  }

  return { createTeamBoardSource, copyBoardToTeam, cleanText };
});
