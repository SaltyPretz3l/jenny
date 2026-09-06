// Pure Jenny-authored change ledger extraction for chat timeline diff review.
// Consumes canonical turn view-model tool calls only; no DOM, renderer state,
// raw turn_events[], or persistence access.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererJennyChangeLedger = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GET_FAILED = Symbol('get_failed');
  const UNKNOWN_WORKSPACE_ID = 'unknown';
  const MAX_SKIPPED_ITEMS = 100;
  const REVIEWABLE_STATES = new Set(['full', 'partial']);
  const REVIEW_STATES = new Set(['full', 'partial', 'summary_only', 'non_text', 'failed']);
  const BODY_KINDS = new Set(['inline_hunks', 'summary_only', 'lazy_ref', 'none']);
  const PATH_FIELDS = Object.freeze([
    'path',
    'file_path',
    'filePath',
    'relative_path',
    'relativePath',
    'target_path',
    'targetPath',
  ]);

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

  function readFirst(source, fields) {
    for (const field of fields) {
      const value = safeGet(source, field);
      if (value !== undefined && value !== GET_FAILED) return value;
    }
    return undefined;
  }

  function normalizeId(value) {
    return safeString(value).trim();
  }

  function normalizeLower(value) {
    return normalizeId(value).toLowerCase();
  }

  function nonNegativeInt(value, fallback = 0) {
    if (typeof value === 'boolean' || typeof value === 'symbol') return fallback;
    const candidate = Number(value);
    if (!Number.isFinite(candidate)) return fallback;
    return candidate >= 0 ? Math.floor(candidate) : fallback;
  }

  function normalizePath(value) {
    const raw = normalizeId(value);
    if (!raw || raw.includes('\0')) return '';
    if (/^[a-zA-Z]:[\\/]/.test(raw)) return '';
    if (/^\\\\/.test(raw) || /^\/\//.test(raw)) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return '';
    const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized.includes(':')) return '';
    if (normalized.startsWith('/')) return '';
    const parts = [];
    for (const part of normalized.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') return '';
      parts.push(part);
    }
    return parts.join('/');
  }

  function pathCandidate(source, field) {
    if (!isPlainObject(source) || !Object.prototype.hasOwnProperty.call(source, field)) {
      return null;
    }
    let rawPath;
    try {
      rawPath = source[field];
    } catch (_error) {
      return { path: '', invalid: true };
    }
    const path = normalizePath(rawPath);
    return path ? { path, invalid: false } : { path: '', invalid: true };
  }

  function firstPathFrom(source) {
    if (!isPlainObject(source)) return { path: '', invalid: false };
    for (const field of PATH_FIELDS) {
      const candidate = pathCandidate(source, field);
      if (!candidate) continue;
      if (candidate.invalid || candidate.path) return candidate;
    }
    return { path: '', invalid: false };
  }

  function resolvePath(diff, metadata, input) {
    const diffCandidate = pathCandidate(diff, 'path');
    if (diffCandidate) return diffCandidate;
    const metadataCandidate = firstPathFrom(metadata);
    if (metadataCandidate.invalid || metadataCandidate.path) return metadataCandidate;
    return firstPathFrom(input);
  }

  function resolveOldPath(diff) {
    return normalizePath(readFirst(diff, ['old_path', 'oldPath'])) || null;
  }

  function resolveWorkspaceId(toolCall, metadata, context) {
    return normalizeId(readFirst(metadata, ['workspace_id', 'workspaceId']))
      || normalizeId(readFirst(toolCall, ['workspace_id', 'workspaceId']))
      || normalizeId(safeGet(context, 'workspaceId'))
      || UNKNOWN_WORKSPACE_ID;
  }

  function normalizeHash(value) {
    if (value === null) return null;
    const text = normalizeId(value);
    return text || null;
  }

  function normalizeHunks(value) {
    if (!Array.isArray(value)) return [];
    const hunks = [];
    for (const hunk of value) {
      if (!isPlainObject(hunk) || !Array.isArray(hunk.lines)) continue;
      hunks.push({
        oldStart: nonNegativeInt(hunk.oldStart, 0),
        oldLines: nonNegativeInt(hunk.oldLines, 0),
        newStart: nonNegativeInt(hunk.newStart, 0),
        newLines: nonNegativeInt(hunk.newLines, 0),
        lines: hunk.lines.map((line) => safeString(line)),
      });
    }
    return hunks;
  }

  function hasValidHunks(hunks) {
    return Array.isArray(hunks) && hunks.length > 0;
  }

  function normalizeReviewState(diff, hunks) {
    const explicit = normalizeLower(readFirst(diff, ['review_state', 'reviewState']));
    if (REVIEW_STATES.has(explicit)) return explicit;
    const reason = normalizeLower(readFirst(diff, ['truncation_reason', 'truncationReason']));
    if (reason === 'diff_generation_failed') return 'failed';
    if (hasValidHunks(hunks)) return 'full';
    const legacyReviewable = safeGet(diff, 'reviewable');
    if (legacyReviewable === true) return 'full';
    if (legacyReviewable === false) return 'summary_only';
    return 'summary_only';
  }

  function normalizeBodyKind(diff, hunks) {
    const explicit = normalizeLower(readFirst(diff, ['body_kind', 'bodyKind']));
    if (BODY_KINDS.has(explicit)) return explicit;
    return hunks.length > 0 ? 'inline_hunks' : 'summary_only';
  }

  function normalizeStatus(diff, metadata) {
    const explicit = normalizeLower(safeGet(diff, 'status'));
    if (explicit) return explicit;
    if (readFirst(diff, ['before_hash', 'beforeHash']) === null) return 'created';
    if (safeGet(metadata, 'changed') === true) return 'modified';
    return 'unknown';
  }

  function stableHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function deriveChangeId({ turnId, toolCallId, operationIndex, fileKey }) {
    return [
      'change',
      normalizeId(turnId) || 'unknown-turn',
      normalizeId(toolCallId) || 'unknown-tool',
      String(operationIndex),
      stableHash(fileKey),
    ].join(':');
  }

  function makeSkip(reason, toolCall, context) {
    return {
      reason,
      turnId: normalizeId(safeGet(context, 'turnId')),
      toolCallId: normalizeId(safeGet(toolCall, 'toolCallId')),
      toolName: normalizeId(safeGet(toolCall, 'toolName')),
    };
  }

  function normalizeJennyChangeFromDiff(toolCall, metadata, diff, context = {}) {
    const pathResult = resolvePath(diff, metadata, safeGet(toolCall, 'input'));
    if (!pathResult.path) {
      return { change: null, skip: makeSkip('invalid_path', toolCall, context) };
    }
    const workspaceId = resolveWorkspaceId(toolCall, metadata, context);
    const fileKey = `${workspaceId}:${pathResult.path}`;
    const operationIndex = nonNegativeInt(readFirst(diff, ['operation_index', 'operationIndex']), 0);
    const providedDiffId = normalizeId(readFirst(diff, ['diff_id', 'diffId']));
    const turnId = normalizeId(safeGet(context, 'turnId'));
    const toolCallId = normalizeId(safeGet(toolCall, 'toolCallId'));
    const changeId = providedDiffId || deriveChangeId({ turnId, toolCallId, operationIndex, fileKey });
    const hunks = normalizeHunks(safeGet(diff, 'hunks'));
    const reviewState = normalizeReviewState(diff, hunks);
    const bodyKind = normalizeBodyKind(diff, hunks);
    const rawSourceMessageIds = safeGet(toolCall, 'sourceMessageIds');
    const sourceMessageIds = Array.isArray(rawSourceMessageIds) ? rawSourceMessageIds : [];
    const sourceMessageId = normalizeId(sourceMessageIds[sourceMessageIds.length - 1])
      || normalizeId(safeGet(toolCall, 'primaryMessageId'))
      || normalizeId(safeGet(context, 'sourceMessageId'));

    return {
      change: {
        changeId,
        diffId: providedDiffId || changeId,
        operationIndex,
        workspaceId,
        fileKey,
        path: pathResult.path,
        oldPath: resolveOldPath(diff),
        turnId,
        sourceMessageId,
        toolCallId,
        toolName: normalizeId(safeGet(toolCall, 'toolName')),
        status: normalizeStatus(diff, metadata),
        reviewState,
        reviewable: REVIEWABLE_STATES.has(reviewState),
        bodyKind,
        additions: nonNegativeInt(safeGet(diff, 'additions'), 0),
        deletions: nonNegativeInt(safeGet(diff, 'deletions'), 0),
        truncated: safeGet(diff, 'truncated') === true,
        truncationReason: normalizeLower(readFirst(diff, ['truncation_reason', 'truncationReason'])) || null,
        beforeHash: normalizeHash(readFirst(diff, ['before_hash', 'beforeHash'])),
        afterHash: normalizeHash(readFirst(diff, ['after_hash', 'afterHash'])),
        hashKind: normalizeId(readFirst(diff, ['hash_kind', 'hashKind'])) || '',
        hunks,
      },
      skip: null,
    };
  }

  function normalizeJennyChangeFromToolCall(toolCall, context = {}) {
    if (!isPlainObject(toolCall)) {
      return { change: null, skip: makeSkip('invalid_tool_call', toolCall, context) };
    }
    if (normalizeLower(safeGet(toolCall, 'state')) !== 'completed' || safeGet(toolCall, 'resultIsError') === true) {
      return { change: null, skip: makeSkip('tool_not_successful', toolCall, context) };
    }
    const rawMetadata = safeGet(toolCall, 'resultMetadata');
    if (rawMetadata === GET_FAILED) {
      return { change: null, skip: makeSkip('invalid_tool_call', toolCall, context) };
    }
    const metadata = isPlainObject(rawMetadata) ? rawMetadata : {};
    const diff = safeGet(metadata, 'diff');
    if (diff === GET_FAILED || !isPlainObject(diff)) {
      return { change: null, skip: makeSkip('missing_diff', toolCall, context) };
    }
    return normalizeJennyChangeFromDiff(toolCall, metadata, diff, context);
  }

  function normalizeJennyChangesFromToolCall(toolCall, context = {}) {
    if (!isPlainObject(toolCall)) {
      return { changes: [], skipped: [makeSkip('invalid_tool_call', toolCall, context)] };
    }
    if (normalizeLower(safeGet(toolCall, 'state')) !== 'completed' || safeGet(toolCall, 'resultIsError') === true) {
      return { changes: [], skipped: [makeSkip('tool_not_successful', toolCall, context)] };
    }
    const rawMetadata = safeGet(toolCall, 'resultMetadata');
    if (rawMetadata === GET_FAILED) {
      return { changes: [], skipped: [makeSkip('invalid_tool_call', toolCall, context)] };
    }
    const metadata = isPlainObject(rawMetadata) ? rawMetadata : {};
    const rawDiffs = safeGet(metadata, 'diffs');
    if (rawDiffs === GET_FAILED) {
      return { changes: [], skipped: [makeSkip('missing_diff', toolCall, context)] };
    }
    if (Array.isArray(rawDiffs) && rawDiffs.length) {
      const changes = [];
      const skipped = [];
      for (const diff of rawDiffs) {
        if (!isPlainObject(diff)) {
          pushSkipped(skipped, makeSkip('missing_diff', toolCall, context));
          continue;
        }
        const result = normalizeJennyChangeFromDiff(toolCall, metadata, diff, context);
        if (result.change) {
          changes.push(result.change);
        } else {
          pushSkipped(skipped, result.skip);
        }
      }
      return { changes, skipped };
    }

    const result = normalizeJennyChangeFromToolCall(toolCall, context);
    return {
      changes: result.change ? [result.change] : [],
      skipped: result.skip ? [result.skip] : [],
    };
  }

  function pushSkipped(target, skip) {
    if (!skip || target.length >= MAX_SKIPPED_ITEMS) return;
    target.push({
      reason: normalizeId(skip.reason),
      turnId: normalizeId(skip.turnId),
      toolCallId: normalizeId(skip.toolCallId),
      toolName: normalizeId(skip.toolName),
    });
  }

  function buildJennyChangeLedgerFromTurnViewModels(turnViewModels, options = {}) {
    const turns = Array.isArray(turnViewModels) ? turnViewModels : [];
    const sessionId = normalizeId(options.sessionId);
    const workspaceId = normalizeId(options.workspaceId) || UNKNOWN_WORKSPACE_ID;
    const changes = [];
    const skipped = [];
    for (const turnModel of turns) {
      if (!isPlainObject(turnModel)) {
        pushSkipped(skipped, { reason: 'invalid_turn', turnId: '', toolCallId: '', toolName: '' });
        continue;
      }
      const turnId = normalizeId(safeGet(turnModel, 'turnId'));
      const rawToolCalls = safeGet(turnModel, 'toolCalls');
      if (rawToolCalls === GET_FAILED) {
        pushSkipped(skipped, { reason: 'invalid_turn', turnId, toolCallId: '', toolName: '' });
        continue;
      }
      const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : [];
      for (const toolCall of toolCalls) {
        const result = normalizeJennyChangesFromToolCall(toolCall, {
          sessionId,
          workspaceId: '',
          turnId,
          sourceMessageId: safeGet(safeGet(turnModel, 'rootMessageIds'), 'assistant'),
        });
        for (const change of result.changes) {
          changes.push(change);
        }
        for (const skip of result.skipped) {
          pushSkipped(skipped, skip);
        }
      }
    }
    return {
      sessionId,
      workspaceId,
      changes,
      skipped,
    };
  }

  return {
    buildJennyChangeLedgerFromTurnViewModels,
    normalizeJennyChangeFromToolCall,
    normalizeJennyChangesFromToolCall,
  };
});
