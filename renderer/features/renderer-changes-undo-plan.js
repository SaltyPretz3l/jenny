/* renderer/features/renderer-changes-undo-plan.js
 * Pure undo/redo planning for the Changes view (row 34 S5; design v3 §3, v6).
 * Turns the real recovery preflights (the edit journal's preflightUndo, the
 * script checkpoint's preflightCheckpointFiles, the safety copy's preflight)
 * into the sheet's groups, and the user's choices into exact requests.
 * No DOM, IPC or renderer state.
 *
 * Who undoes a file:
 * - the edit journal, for files Jenny's typed edits wrote first;
 * - the checkpoint taken before the first script or command that wrote it;
 * - nothing ("Can't be undone"), with the reason.
 *
 * After an undo, Redo and a later Undo are both "swaps": each restores the
 * copy kept just before the previous step, and only for files that still
 * match what that step left (verified against the copy, never guessed).
 * A journal swap entry carries its change set id, so a Redo that put a whole
 * entry back can ask the journal to re-arm that change set.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChangesUndoPlan = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Inverse steps a person would call "a file goes back"; staging moves and
  // empty-folder cleanup are bookkeeping.
  const SHOWN_STEP_KINDS = new Set(['restore_object', 'remove_created', 'move_back', 'restore_protected_occupant']);
  const AFTER_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/i;
  const HASH_KINDS = new Set(['diff_input_text', 'raw_bytes']);

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function checkpointRef(restorePoint) {
    return isPlainObject(restorePoint) && restorePoint.kind === 'git_checkpoint' && typeof restorePoint.ref === 'string'
      ? restorePoint.ref
      : '';
  }

  function firstWriter(file) {
    return list(file && file.writers)[0] || 'edit';
  }

  function timeOf(value) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  function stepPath(step) {
    if (step.kind === 'remove_created') return step.from_relative_path || '';
    return step.to_relative_path || step.from_relative_path || '';
  }

  function fileOwner(file, journalPaths) {
    if (firstWriter(file) !== 'edit' && checkpointRef(file.restorePoint)) return 'checkpoint';
    return journalPaths.has(file.path) ? 'journal' : 'none';
  }

  function cannotReason(file) {
    if (firstWriter(file) === 'edit') return 'no_record';
    const point = isPlainObject(file.restorePoint) ? file.restorePoint : null;
    if (point && point.kind === 'none' && (point.reason === 'not_git' || point.reason === 'disabled')) return point.reason;
    return 'no_copy';
  }

  /** Whether a turn has anything undo could bring back, without IPC. */
  function turnHasUndoSource(turn) {
    if (!isPlainObject(turn)) return false;
    if (list(turn.changeSetIds).length) return true;
    return list(turn.files).some((file) => firstWriter(file) !== 'edit' && checkpointRef(file.restorePoint));
  }

  /** preflightCheckpointFiles requests for the turn's script files, one per checkpoint. */
  function checkpointPreflights(turn) {
    const byRef = new Map();
    for (const file of list(turn && turn.files)) {
      const ref = checkpointRef(file.restorePoint);
      if (!ref) continue;
      const item = { path: file.path };
      if (typeof file.afterHash === 'string' && AFTER_HASH_PATTERN.test(file.afterHash)) {
        item.afterHash = file.afterHash;
        if (HASH_KINDS.has(file.hashKind)) item.hashKind = file.hashKind;
      }
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref).push(item);
    }
    return [...byRef].map(([ref, files]) => ({ ref, files }));
  }

  // The newest later turn in History that changed the same file.
  function laterTurnFor(history, turn, path) {
    for (const other of list(history && history.turns)) {
      if (other === turn || other.turnId === turn.turnId) return null;
      if (list(other.files).some((file) => file.path === path)) return { timeMs: timeOf(other.timeMs) };
    }
    return null;
  }

  function conflictsById(preflight) {
    const map = new Map();
    for (const conflict of list(preflight && preflight.conflicts)) map.set(conflict.inverse_step_id, conflict);
    return map;
  }

  // Path -> the journal step that runs first for it: the newest change set's.
  function governingSteps(journal) {
    const governing = new Map();
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const { changeSetId, preflight } = journal[index];
      const conflicts = conflictsById(preflight);
      for (const step of list(preflight && preflight.inverse_plan)) {
        const conflict = conflicts.get(step.inverse_step_id) || null;
        if (!SHOWN_STEP_KINDS.has(step.kind) && !conflict) continue;
        const path = conflict ? conflict.relative_path : stepPath(step);
        if (!path || governing.has(path)) continue;
        governing.set(path, { changeSetId, step, conflict });
      }
    }
    return governing;
  }

  function checkpointInfo(checkpoints, ref, path) {
    const result = isPlainObject(checkpoints) ? checkpoints[ref] : null;
    if (!isPlainObject(result) || result.ok !== true) return { gone: true, info: null };
    return { gone: false, info: list(result.files).find((item) => item.path === path) || null };
  }

  function journalRow(row, governed, file, context) {
    const { step, conflict } = governed;
    if (conflict) {
      // A typed edit a script rewrote later in the same turn: its conflict is
      // the turn's own doing when the file still holds what Jenny left.
      const ref = file && list(file.writers).some((writer) => writer !== 'edit') ? checkpointRef(file.restorePoint) : '';
      const { info } = ref ? checkpointInfo(context.checkpoints, ref, file.path) : { info: null };
      if (info && info.matchesAfter === true && list(conflict.allowed_outcomes).includes('protect_then_replace')) {
        return { ...row, group: 'back', how: 'revert', decision: 'protect_then_replace' };
      }
      return { ...row, group: 'call', on: false, laterTurn: laterTurnFor(context.history, context.turn, row.path), editedMs: null };
    }
    const how = step.kind === 'remove_created' ? 'remove' : (step.kind === 'move_back' ? 'move' : 'revert');
    return { ...row, group: 'back', how, from: how === 'move' ? step.from_relative_path || '' : '' };
  }

  function checkpointRow(row, file, context) {
    const ref = checkpointRef(file.restorePoint);
    const { gone, info } = checkpointInfo(context.checkpoints, ref, file.path);
    if (gone || !info) return { ...row, group: 'cannot', reason: gone ? 'copy_gone' : 'no_copy' };
    const base = {
      ...row, source: 'checkpoint', ref, exists: info.exists === true, inRef: info.inCheckpoint !== 'absent',
      seenMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
    };
    if (!base.inRef) return info.exists ? { ...base, group: 'stays', on: false } : null;
    // Already as it was: nothing to do.
    if (info.matchesCheckpoint === true) return null;
    if (info.matchesAfter === false) {
      return { ...base, group: 'call', on: false, laterTurn: laterTurnFor(context.history, context.turn, file.path), editedMs: timeOf(info.mtimeMs) };
    }
    return { ...base, group: 'back', how: 'checkpoint', checkpointMs: timeOf(file.restorePoint.createdAt) };
  }

  /**
   * @param {object} input
   * @param {object} input.turn a History turn (renderer-changes-history-model)
   * @param {object} [input.history] the History, newest turn first
   * @param {Array<{changeSetId, preflight}>} input.journal oldest change set first
   * @param {Object<string, object>} input.checkpoints ref -> preflightCheckpointFiles result
   * @returns {{ rows: Array, journalSetIds: string[] }}
   */
  function buildUndoPlan(input) {
    const turn = input.turn;
    const journal = list(input.journal);
    const context = { turn, history: input.history, checkpoints: input.checkpoints || {} };
    const governing = governingSteps(journal);
    const rows = [];
    let next = 0;
    const baseRow = (path, file) => ({
      key: `u${next++}`,
      path,
      source: 'journal',
      sensitive: Boolean(file && file.sensitive),
      fileKey: file ? file.fileKey : '',
    });
    const filesByPath = new Map(list(turn.files).map((file) => [file.path, file]));
    const seen = new Set();
    for (const file of list(turn.files)) {
      seen.add(file.path);
      const owner = fileOwner(file, governing);
      let row;
      if (owner === 'checkpoint') row = checkpointRow(baseRow(file.path, file), file, context);
      else if (owner === 'journal') row = journalRow(baseRow(file.path, file), governing.get(file.path), file, context);
      else row = { ...baseRow(file.path, file), source: null, group: 'cannot', reason: cannotReason(file) };
      if (row) rows.push(row);
    }
    // Journal steps for paths the ledger did not list still run.
    for (const [path, governed] of governing) {
      if (seen.has(path)) continue;
      rows.push(journalRow(baseRow(path, filesByPath.get(path) || null), governed, null, context));
    }
    return { rows, journalSetIds: journal.map((item) => item.changeSetId).reverse() };
  }

  function isChosen(row, choices) {
    if (row.group === 'back') return true;
    if (row.group === 'call' || row.group === 'stays') return Boolean(choices && choices[row.key]);
    return false;
  }

  /** How many files the primary button undoes. */
  function chosenCount(plan, choices) {
    return list(plan && plan.rows).filter((row) => isChosen(row, choices)).length;
  }

  /**
   * One explicit outcome per conflict in a FRESH preflight (taken just before
   * that change set's undo, after newer ones ran), as the sidecar requires.
   */
  function journalDecisions(plan, choices, preflight) {
    const rowsByPath = new Map(list(plan.rows).map((row) => [row.path, row]));
    const decisions = {};
    for (const conflict of list(preflight && preflight.conflicts)) {
      const row = rowsByPath.get(conflict.relative_path) || null;
      const allowed = list(conflict.allowed_outcomes);
      let outcome = 'skip';
      if (row && row.source === 'journal' && row.group === 'back' && row.decision) outcome = row.decision;
      else if (row && row.source === 'journal' && row.group === 'call' && choices && choices[row.key]) outcome = 'protect_then_replace';
      decisions[conflict.inverse_step_id] = allowed.length && !allowed.includes(outcome) ? 'skip' : outcome;
    }
    return decisions;
  }

  /** restoreCheckpointFiles requests: one per checkpoint ref. */
  function checkpointRestores(plan, choices) {
    const byRef = new Map();
    for (const row of list(plan && plan.rows)) {
      if (row.source !== 'checkpoint' || !isChosen(row, choices)) continue;
      if (!byRef.has(row.ref)) byRef.set(row.ref, { ref: row.ref, paths: [], removePaths: [], existed: {} });
      const entry = byRef.get(row.ref);
      (row.inRef ? entry.paths : entry.removePaths).push(row.path);
      entry.existed[row.path] = row.exists;
    }
    return [...byRef.values()];
  }

  /**
   * The sheet can sit open: drop a checkpoint file whose existence or mtime
   * changed since the sheet was built (`fresh` = a new preflightCheckpointFiles).
   */
  function recheckRestore(plan, request, fresh) {
    const files = isPlainObject(fresh) && fresh.ok === true ? list(fresh.files) : [];
    const rows = new Map(list(plan && plan.rows).filter((row) => row.source === 'checkpoint' && row.ref === request.ref).map((row) => [row.path, row]));
    const same = (path) => {
      const row = rows.get(path);
      const item = files.find((file) => file.path === path);
      return Boolean(row && item && item.exists === row.exists && (Number.isFinite(item.mtimeMs) ? item.mtimeMs : null) === row.seenMs);
    };
    const paths = request.paths.filter(same);
    const removePaths = request.removePaths.filter(same);
    return { ...request, paths, removePaths, existed: Object.fromEntries([...paths, ...removePaths].map((path) => [path, request.existed[path]])) };
  }

  function receiptPaths(receipt) {
    const paths = new Set();
    for (const key of ['restored', 'protected', 'renamed_to']) {
      for (const item of list(receipt && receipt[key])) {
        for (const field of ['relative_path', 'workspace_relative_path']) {
          if (typeof item[field] === 'string' && item[field]) paths.add(item[field]);
        }
      }
    }
    return paths;
  }

  // A Redo copy limited to the files the step changed (`only`): files the
  // user kept are in the copy too, unchanged, and must not count as redone.
  function safetyCopySwap(copy, only) {
    if (!isPlainObject(copy) || typeof copy.token !== 'string') return null;
    const unavailable = new Set(list(copy.unavailable).map((item) => item && item.path));
    const paths = list(copy.paths).filter((path) => typeof path === 'string' && !unavailable.has(path)
      && (!only || only.has(path)));
    return paths.length ? { token: copy.token, paths } : null;
  }

  /**
   * File states and the Redo swap after an undo.
   * @param {object} plan
   * @param {object} choices
   * @param {{ journal: Array<object>, checkpoint: Array<{request, result}> }} outcome
   */
  function summarizeUndo(plan, choices, outcome) {
    const undonePaths = new Set();
    // Journal first, then checkpoints: the order this undo ran them in.
    const swap = { journal: [], checkpoint: [], journalFirst: true };
    const movedFrom = new Map(list(plan.rows).filter((row) => row.how === 'move' && row.from).map((row) => [row.path, row.from]));
    for (const result of list(outcome.journal)) {
      if (!isPlainObject(result) || (result.ok !== true && result.status !== 'needs_review')) continue;
      const changed = receiptPaths(result);
      for (const path of changed) undonePaths.add(path);
      // A move back names only its destination; its source is part of the Redo too.
      for (const path of [...changed]) if (movedFrom.has(path)) changed.add(movedFrom.get(path));
      const copy = withChangeSetId(safetyCopySwap(result.safety_copy, changed), result.change_set_id);
      if (copy) swap.journal.push(copy);
    }
    for (const { request, result } of list(outcome.checkpoint)) {
      if (!isPlainObject(result)) continue;
      const changed = [...list(result.restored), ...list(result.removed)];
      for (const path of changed) undonePaths.add(path);
      if (result.rollbackRef && changed.length) {
        swap.checkpoint.push({
          ref: result.rollbackRef,
          verifyRef: request.ref,
          paths: changed.map((path) => ({ path, inRef: request.existed[path] === true })),
        });
      }
    }
    const files = {};
    for (const row of list(plan.rows)) {
      files[row.path] = isChosen(row, choices) && undonePaths.has(row.path) ? 'undone' : 'kept';
    }
    return { files, swap: hasSwap(swap) ? swap : null };
  }

  function withChangeSetId(copy, changeSetId) {
    return copy && typeof changeSetId === 'string' && changeSetId ? { ...copy, changeSetId } : copy;
  }

  function hasSwap(swap) {
    return isPlainObject(swap) && (list(swap.journal).length > 0 || list(swap.checkpoint).length > 0);
  }

  /** preflightCheckpointFiles requests that verify a swap's checkpoint files. */
  function swapCheckpointPreflights(swap) {
    return list(swap && swap.checkpoint).map((entry) => ({
      ref: entry.verifyRef,
      files: entry.paths.map((item) => ({ path: item.path })),
    }));
  }

  /**
   * Which swap files still match what the previous step left.
   * @param {object} swap
   * @param {Array<object>} journalChecks preflightSafetyCopy result per swap.journal entry
   * @param {Array<object>} checkpointChecks preflightCheckpointFiles result per swap.checkpoint entry
   * @returns {Array<{path, unchanged, kind, index, inRef?, existed?}>}
   */
  function verifySwap(swap, journalChecks, checkpointChecks) {
    const rows = [];
    list(swap && swap.journal).forEach((entry, index) => {
      const check = journalChecks[index];
      const files = isPlainObject(check) && check.ok === true ? list(check.files) : [];
      for (const path of entry.paths) {
        const item = files.find((file) => file.path === path);
        rows.push({ path, kind: 'journal', index, unchanged: Boolean(item && item.unchanged === true) });
      }
    });
    list(swap && swap.checkpoint).forEach((entry, index) => {
      const check = checkpointChecks[index];
      const files = isPlainObject(check) && check.ok === true ? list(check.files) : [];
      for (const { path, inRef } of entry.paths) {
        const item = files.find((file) => file.path === path);
        let unchanged = false;
        if (item) unchanged = item.inCheckpoint !== 'absent' ? item.matchesCheckpoint === true : item.exists === false;
        rows.push({ path, kind: 'checkpoint', index, inRef, existed: Boolean(item && item.exists), unchanged });
      }
    });
    // Entries are recorded in the order they ran and a swap runs them in
    // reverse, so a path several entries hold (one file, two change sets, or a
    // script then a typed edit) is checked against the entry recorded last;
    // the others expect the state the previous restore leaves.
    const head = new Map();
    for (const row of recordedOrder(swap, rows)) head.set(row.path, row.unchanged);
    return rows.map((row) => ({ ...row, unchanged: head.get(row.path) === true }));
  }

  function recordedOrder(swap, rows) {
    const journal = rows.filter((row) => row.kind === 'journal');
    const checkpoint = rows.filter((row) => row.kind === 'checkpoint');
    return swap && swap.journalFirst === false ? [...checkpoint, ...journal] : [...journal, ...checkpoint];
  }

  /**
   * The restore requests for a verified swap: unchanged files only, each kind
   * in reverse recorded order; `checkpointFirst` says which kind runs first.
   * A journal request from a journal undo also names its change set and
   * whether it covers the whole entry (`whole`).
   */
  function swapRequests(swap, verified) {
    const journal = list(swap.journal).map((entry, index) => {
      const paths = verified.filter((row) => row.kind === 'journal' && row.index === index && row.unchanged).map((row) => row.path);
      const request = { token: entry.token, paths };
      if (entry.changeSetId) Object.assign(request, { changeSetId: entry.changeSetId, whole: paths.length === list(entry.paths).length });
      return request;
    }).filter((request) => request.paths.length).reverse();
    const checkpoint = list(swap.checkpoint).map((entry, index) => {
      const rows = verified.filter((row) => row.kind === 'checkpoint' && row.index === index && row.unchanged);
      return {
        ref: entry.ref,
        paths: rows.filter((row) => row.inRef).map((row) => row.path),
        removePaths: rows.filter((row) => !row.inRef).map((row) => row.path),
        existed: Object.fromEntries(rows.map((row) => [row.path, row.existed])),
      };
    }).filter((request) => request.paths.length + request.removePaths.length).reverse();
    return { journal, checkpoint, checkpointFirst: swap.journalFirst !== false };
  }

  /** The next swap (the reverse of the one just run) and the paths it changed. */
  function summarizeSwap(requests, outcome) {
    const swap = { journal: [], checkpoint: [], journalFirst: !requests.checkpointFirst };
    const changed = new Set();
    list(outcome.journal).forEach((result, index) => {
      if (!isPlainObject(result)) return;
      for (const path of list(result.restored)) changed.add(path);
      const request = requests.journal[index];
      const copy = withChangeSetId(safetyCopySwap(result.safety_copy, new Set(list(result.restored))), request && request.changeSetId);
      if (copy) swap.journal.push(copy);
    });
    list(outcome.checkpoint).forEach((result, index) => {
      const request = requests.checkpoint[index];
      if (!isPlainObject(result) || !request) return;
      const paths = [...list(result.restored), ...list(result.removed)];
      for (const path of paths) changed.add(path);
      if (result.rollbackRef && paths.length) {
        swap.checkpoint.push({
          ref: result.rollbackRef,
          verifyRef: request.ref,
          paths: paths.map((path) => ({ path, inRef: request.existed[path] === true })),
        });
      }
    });
    return { changed, swap: hasSwap(swap) ? swap : null };
  }

  return {
    buildUndoPlan,
    checkpointPreflights,
    checkpointRef,
    checkpointRestores,
    chosenCount,
    hasSwap,
    isChosen,
    journalDecisions,
    recheckRestore,
    summarizeSwap,
    summarizeUndo,
    swapCheckpointPreflights,
    swapRequests,
    turnHasUndoSource,
    verifySwap,
  };
});
