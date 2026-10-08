// Pure History model for the Changes view (row 34 S5): one block per turn
// that changed files, newest first, built from the Jenny change ledger.
// No DOM, renderer state or IPC; the view and the undo flow consume it.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChangesHistoryModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TURNS = 200;
  const MAX_FILES_PER_TURN = 200;
  const MAX_TITLE_CHARS = 80;
  const COMMAND_TOOLS = new Set(['run_command', 'bash', 'Bash']);
  const SCRIPT_TOOLS = new Set(['run_temp_script', 'python_execute']);
  const FAILED_OUTCOMES = new Set(['failed', 'timed_out', 'cancelled']);

  function text(value) {
    if (value == null || typeof value === 'symbol') return '';
    try { return String(value).trim(); } catch (_error) { return ''; }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // Who wrote a file, for the hover line: Jenny's typed edit, a script or a command.
  function writerKind(toolName) {
    const name = text(toolName);
    if (COMMAND_TOOLS.has(name)) return 'command';
    if (SCRIPT_TOOLS.has(name)) return 'script';
    return 'edit';
  }

  // The first line of the user's request, bounded, as the turn's title.
  function turnTitle(turnModel) {
    const content = text(isPlainObject(turnModel) && isPlainObject(turnModel.user) ? turnModel.user.content : '');
    const firstLine = content.split(/\r?\n/).find((line) => line.trim()) || '';
    const collapsed = firstLine.replace(/\s+/g, ' ').trim();
    return collapsed.length > MAX_TITLE_CHARS ? `${collapsed.slice(0, MAX_TITLE_CHARS - 1)}…` : collapsed;
  }

  function changeSetIdsFor(turnModel) {
    const ids = [];
    const calls = isPlainObject(turnModel) && Array.isArray(turnModel.toolCalls) ? turnModel.toolCalls : [];
    for (const call of calls) {
      const changeSet = isPlainObject(call) && isPlainObject(call.resultMetadata)
        ? call.resultMetadata.workspace_change_set : null;
      const id = isPlainObject(changeSet) ? text(changeSet.change_set_id).toLowerCase() : '';
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  function emptyFile(change) {
    return {
      path: change.path,
      fileKey: change.fileKey,
      created: false,
      sensitive: false,
      failedAfter: false,
      writers: [],
      toolCallIds: [],
      changeIds: [],
      afterHash: null,
      hashKind: '',
      lastToolName: '',
      restorePoint: null,
    };
  }

  function addChange(file, change) {
    // A file the turn created stays "new" even when later calls edit it again.
    if (!file.changeIds.length && change.status === 'created') file.created = true;
    if (change.sensitive === true) file.sensitive = true;
    const writer = change.scripted === true && writerKind(change.toolName) === 'edit'
      ? 'script'
      : writerKind(change.toolName);
    // The first script or command's restore point holds the file as it was
    // before that writer ran; undo restores from it.
    if (writer !== 'edit' && !file.writers.some((item) => item !== 'edit')) {
      file.restorePoint = isPlainObject(change.restorePoint) ? change.restorePoint : null;
    }
    if (!file.writers.includes(writer)) file.writers.push(writer);
    if (change.toolCallId && !file.toolCallIds.includes(change.toolCallId)) file.toolCallIds.push(change.toolCallId);
    file.changeIds.push(change.changeId);
    // The last change decides the after-state undo compares against, and
    // whether a script failed after writing this file.
    file.failedAfter = writer !== 'edit' && FAILED_OUTCOMES.has(text(change.callOutcome));
    file.afterHash = change.afterHash || null;
    file.hashKind = text(change.hashKind);
    file.lastToolName = text(change.toolName);
  }

  function noticeKind(notice) {
    const state = text(notice.state);
    if (state === 'unsupported') return 'unsupported';
    if (state === 'unavailable' && text(notice.reason) !== 'background') return 'unavailable';
    return '';
  }

  function addNotice(block, notice) {
    const kind = noticeKind(notice);
    if (kind && !block.notices.includes(kind)) block.notices.push(kind);
    const omitted = Number(notice.omittedCount);
    if (Number.isSafeInteger(omitted) && omitted > 0) block.omittedCount += omitted;
  }

  function ensureBlock(blocks, order, turnId, turnModel, getTurnTime) {
    let block = blocks.get(turnId);
    if (!block) {
      const time = Number(typeof getTurnTime === 'function' ? getTurnTime(turnModel, turnId) : NaN);
      block = {
        turnId,
        title: turnTitle(turnModel),
        timeMs: Number.isFinite(time) && time > 0 ? time : null,
        files: [],
        notices: [],
        omittedCount: 0,
        changeSetIds: changeSetIdsFor(turnModel),
        _byKey: new Map(),
      };
      blocks.set(turnId, block);
      order.push(turnId);
    }
    return block;
  }

  /**
   * @param {object} ledger result of buildJennyChangeLedgerFromTurnViewModels
   * @param {Array} turnViewModels the same turn view models, oldest first
   * @param {{ getTurnTime?: Function }} [options]
   * @returns {{ turns: Array }} newest turn first
   */
  function buildChangesHistory(ledger, turnViewModels, options = {}) {
    const turnsById = new Map();
    for (const turnModel of Array.isArray(turnViewModels) ? turnViewModels : []) {
      const turnId = text(isPlainObject(turnModel) ? turnModel.turnId : '');
      if (turnId) turnsById.set(turnId, turnModel);
    }
    const blocks = new Map();
    const order = [];
    const changes = isPlainObject(ledger) && Array.isArray(ledger.changes) ? ledger.changes : [];
    for (const change of changes) {
      if (!isPlainObject(change) || !change.path) continue;
      const turnId = text(change.turnId);
      if (!turnId) continue;
      const block = ensureBlock(blocks, order, turnId, turnsById.get(turnId), options.getTurnTime);
      let file = block._byKey.get(change.fileKey);
      if (!file) {
        if (block.files.length >= MAX_FILES_PER_TURN) {
          block.omittedCount += 1;
          continue;
        }
        file = emptyFile(change);
        block._byKey.set(change.fileKey, file);
        block.files.push(file);
      }
      addChange(file, change);
    }
    const notices = isPlainObject(ledger) && Array.isArray(ledger.notices) ? ledger.notices : [];
    for (const notice of notices) {
      if (!isPlainObject(notice) || !text(notice.turnId)) continue;
      const kind = noticeKind(notice);
      const omitted = Number(notice.omittedCount);
      if (!kind && !(omitted > 0) && !blocks.has(text(notice.turnId))) continue;
      addNotice(ensureBlock(blocks, order, text(notice.turnId), turnsById.get(text(notice.turnId)), options.getTurnTime), notice);
    }
    const turns = order.slice().reverse().slice(0, MAX_TURNS).map((turnId) => {
      const block = blocks.get(turnId);
      delete block._byKey;
      return block;
    });
    return { turns };
  }

  /**
   * A getTurnTime for buildChangesHistory: the turn's user message timestamp.
   * The id -> time map is rebuilt only when the message list changes identity.
   * @param {() => Array} getMessages the active session's messages
   */
  function createTurnTimeLookup(getMessages) {
    let source = null;
    let times = new Map();
    return function getTurnTime(turnModel) {
      const messages = typeof getMessages === 'function' ? getMessages() : null;
      if (!Array.isArray(messages)) return null;
      if (messages !== source) {
        source = messages;
        times = new Map();
        for (const message of messages) {
          const id = text(isPlainObject(message) ? message.id : '');
          const ms = id ? Date.parse(message.timestamp) : NaN;
          if (Number.isFinite(ms)) times.set(id, ms);
        }
      }
      const userId = text(isPlainObject(turnModel) && turnModel.rootMessageIds ? turnModel.rootMessageIds.user : '');
      return times.get(userId) ?? null;
    };
  }

  return { buildChangesHistory, createTurnTimeLookup, writerKind, turnTitle };
});
