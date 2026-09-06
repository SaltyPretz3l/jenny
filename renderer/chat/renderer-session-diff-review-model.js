// Pure session-level diff review model for Jenny-authored changes.
// This module derives review scopes from normalized ledger records only.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionDiffReviewModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GET_FAILED = Symbol('get_failed');

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function safeString(value) {
    if (typeof value === 'symbol') return '';
    if (value == null) return '';
    try {
      return String(value);
    } catch (_error) {
      return '';
    }
  }

  function safeGet(source, key) {
    if (!isPlainObject(source)) return undefined;
    try {
      return source[key];
    } catch (_error) {
      return GET_FAILED;
    }
  }

  function isFailedGet(value) {
    return value === GET_FAILED;
  }

  function normalizeId(value) {
    return safeString(value).trim();
  }

  function nonNegativeInt(value, fallback = 0) {
    if (typeof value === 'boolean' || typeof value === 'symbol') return fallback;
    const candidate = Number(value);
    if (!Number.isFinite(candidate)) return fallback;
    return candidate >= 0 ? Math.floor(candidate) : fallback;
  }

  function cloneValue(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    const active = seen || new WeakSet();
    if (active.has(value)) return Array.isArray(value) ? [] : {};
    active.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => cloneValue(item, active));
    }
    const result = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      try {
        result[key] = cloneValue(value[key], active);
      } catch (_error) {
        result[key] = undefined;
      }
    }
    return result;
  }

  function emptyTotals() {
    return {
      files: 0,
      changes: 0,
      additions: 0,
      deletions: 0,
      truncatedFiles: 0,
    };
  }

  function skipped(reason, change) {
    return {
      reason,
      changeId: normalizeId(safeGet(change, 'changeId')),
      fileKey: normalizeId(safeGet(change, 'fileKey')),
      turnId: normalizeId(safeGet(change, 'turnId')),
    };
  }

  function normalizeChange(change) {
    if (!isPlainObject(change)) {
      return { change: null, skip: skipped('invalid_change', change) };
    }
    const rawChangeId = safeGet(change, 'changeId');
    if (isFailedGet(rawChangeId)) {
      return { change: null, skip: skipped('invalid_change', change) };
    }
    const changeId = normalizeId(rawChangeId);
    if (!changeId) {
      return { change: null, skip: skipped('missing_change_id', change) };
    }
    const rawFileKey = safeGet(change, 'fileKey');
    if (isFailedGet(rawFileKey)) {
      return { change: null, skip: skipped('invalid_change', change) };
    }
    const fileKey = normalizeId(rawFileKey);
    if (!fileKey) {
      return { change: null, skip: skipped('missing_file_key', change) };
    }
    const rawPath = safeGet(change, 'path');
    if (isFailedGet(rawPath)) {
      return { change: null, skip: skipped('invalid_change', change) };
    }
    const path = normalizeId(rawPath);
    if (!path) {
      return { change: null, skip: skipped('missing_path', change) };
    }
    return {
      change: {
        ...cloneValue(change),
        changeId,
        fileKey,
        path,
        workspaceId: normalizeId(safeGet(change, 'workspaceId')) || fileKey.split(':')[0] || 'default',
        turnId: normalizeId(safeGet(change, 'turnId')),
        additions: nonNegativeInt(safeGet(change, 'additions'), 0),
        deletions: nonNegativeInt(safeGet(change, 'deletions'), 0),
        truncated: safeGet(change, 'truncated') === true,
      },
      skip: null,
    };
  }

  function pushDistinct(list, value) {
    const normalized = normalizeId(value);
    if (!normalized || list.includes(normalized)) return;
    list.push(normalized);
  }

  function sourceChangesFromInput(ledgerOrChanges) {
    if (Array.isArray(ledgerOrChanges)) return ledgerOrChanges;
    const changes = safeGet(ledgerOrChanges, 'changes');
    if (Array.isArray(changes)) {
      return changes;
    }
    return [];
  }

  function sourceSessionId(ledgerOrChanges, options) {
    return normalizeId(options && options.sessionId)
      || normalizeId(safeGet(ledgerOrChanges, 'sessionId'));
  }

  function normalizedScopeModel(sessionModel) {
    const model = isPlainObject(sessionModel) ? sessionModel : {};
    const changes = safeGet(model, 'changes');
    const files = safeGet(model, 'files');
    const turns = safeGet(model, 'turns');
    const totals = safeGet(model, 'totals');
    return {
      changes: Array.isArray(changes) ? changes : [],
      files: Array.isArray(files) ? files : [],
      turns: Array.isArray(turns) ? turns : [],
      totals: isPlainObject(totals) ? totals : emptyTotals(),
    };
  }

  function buildAggregates(changes) {
    const filesByKey = new Map();
    const turnsById = new Map();
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const change of changes) {
      const additions = nonNegativeInt(change.additions, 0);
      const deletions = nonNegativeInt(change.deletions, 0);
      const truncated = change.truncated === true;
      totalAdditions += additions;
      totalDeletions += deletions;

      let file = filesByKey.get(change.fileKey);
      if (!file) {
        file = {
          fileKey: change.fileKey,
          workspaceId: normalizeId(change.workspaceId),
          path: change.path,
          latestChangeId: '',
          changeIds: [],
          changeCount: 0,
          additions: 0,
          deletions: 0,
          truncated: false,
        };
        filesByKey.set(change.fileKey, file);
      }
      file.latestChangeId = change.changeId;
      file.changeIds.push(change.changeId);
      file.changeCount += 1;
      file.additions += additions;
      file.deletions += deletions;
      file.truncated = file.truncated || truncated;

      const turnId = normalizeId(change.turnId);
      if (turnId) {
        let turn = turnsById.get(turnId);
        if (!turn) {
          turn = {
            turnId,
            changeIds: [],
            fileKeys: [],
            additions: 0,
            deletions: 0,
            truncated: false,
          };
          turnsById.set(turnId, turn);
        }
        turn.changeIds.push(change.changeId);
        pushDistinct(turn.fileKeys, change.fileKey);
        turn.additions += additions;
        turn.deletions += deletions;
        turn.truncated = turn.truncated || truncated;
      }
    }
    const files = Array.from(filesByKey.values());
    const turns = Array.from(turnsById.values());
    const totals = {
      files: files.length,
      changes: changes.length,
      additions: totalAdditions,
      deletions: totalDeletions,
      truncatedFiles: files.filter((file) => file.truncated).length,
    };
    return { files, turns, totals };
  }

  function buildSessionDiffReviewModel(ledgerOrChanges, options = {}) {
    const changes = [];
    const skippedItems = [];
    for (const rawChange of sourceChangesFromInput(ledgerOrChanges)) {
      let result;
      try {
        result = normalizeChange(rawChange);
      } catch (_error) {
        result = { change: null, skip: skipped('invalid_change', rawChange) };
      }
      if (result.change) {
        changes.push(result.change);
      } else {
        skippedItems.push(result.skip);
      }
    }
    const { files, turns, totals } = buildAggregates(changes);
    return {
      sessionId: sourceSessionId(ledgerOrChanges, options),
      changes,
      files,
      turns,
      totals,
      skipped: skippedItems,
    };
  }

  function scopeTotals(changes, files) {
    return {
      files: files.length,
      changes: changes.length,
      additions: changes.reduce((sum, change) => sum + nonNegativeInt(change.additions, 0), 0),
      deletions: changes.reduce((sum, change) => sum + nonNegativeInt(change.deletions, 0), 0),
      truncatedFiles: files.filter((file) => file.truncated).length,
    };
  }

  function scopeResult(type, found, reason, scope, changes, files, turns) {
    const scopedChanges = changes.map((change) => cloneValue(change));
    const scopedFiles = files.map((file) => cloneValue(file));
    const scopedTurns = turns.map((turn) => cloneValue(turn));
    return {
      type,
      found,
      reason,
      scope,
      changes: scopedChanges,
      files: scopedFiles,
      turns: scopedTurns,
      totals: found ? scopeTotals(scopedChanges, scopedFiles) : emptyTotals(),
    };
  }

  function resolveByChange(model, changeId) {
    const normalized = normalizeId(changeId);
    const change = model.changes.find((item) => item.changeId === normalized);
    if (!change) {
      return scopeResult('change', false, 'change_not_found', { type: 'change', changeId: normalized }, [], [], []);
    }
    const file = model.files.find((item) => item.fileKey === change.fileKey);
    const turn = model.turns.find((item) => item.turnId === change.turnId);
    return scopeResult(
      'change',
      true,
      '',
      { type: 'change', changeId: normalized },
      [change],
      file ? [file] : [],
      turn ? [turn] : []
    );
  }

  function resolveByTurn(model, turnId) {
    const normalized = normalizeId(turnId);
    const turn = model.turns.find((item) => item.turnId === normalized);
    if (!turn) {
      return scopeResult('turn', false, 'turn_not_found', { type: 'turn', turnId: normalized }, [], [], []);
    }
    const changeIds = new Set(turn.changeIds);
    const fileKeys = new Set(turn.fileKeys);
    return scopeResult(
      'turn',
      true,
      '',
      { type: 'turn', turnId: normalized },
      model.changes.filter((change) => changeIds.has(change.changeId)),
      model.files.filter((file) => fileKeys.has(file.fileKey)),
      [turn]
    );
  }

  function resolveByFile(model, fileKey) {
    const normalized = normalizeId(fileKey);
    const file = model.files.find((item) => item.fileKey === normalized);
    if (!file) {
      return scopeResult('file', false, 'file_not_found', { type: 'file', fileKey: normalized }, [], [], []);
    }
    const changeIds = new Set(file.changeIds);
    const selectedChanges = model.changes.filter((change) => changeIds.has(change.changeId));
    const turnIds = new Set(selectedChanges.map((change) => change.turnId).filter(Boolean));
    return scopeResult(
      'file',
      true,
      '',
      { type: 'file', fileKey: normalized },
      selectedChanges,
      [file],
      model.turns.filter((turn) => turnIds.has(turn.turnId))
    );
  }

  function resolveReviewScope(sessionModel, scopeRequest) {
    const model = normalizedScopeModel(sessionModel);
    const scope = isPlainObject(scopeRequest) ? scopeRequest : {};
    const type = normalizeId(scope.type).toLowerCase();
    if (type === 'change') return resolveByChange(model, scope.changeId);
    if (type === 'turn') return resolveByTurn(model, scope.turnId);
    if (type === 'file') return resolveByFile(model, scope.fileKey);
    if (type === 'session') {
      return scopeResult(
        'session',
        true,
        '',
        { type: 'session' },
        model.changes,
        model.files,
        model.turns
      );
    }
    return scopeResult(type || 'unknown', false, 'unsupported_scope', { type: type || '' }, [], [], []);
  }

  return {
    buildSessionDiffReviewModel,
    resolveReviewScope,
  };
});
