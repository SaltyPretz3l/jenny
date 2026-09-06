(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnNormalizationUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var REDACTED_PATH_TOKEN = '[redacted:path]';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeDimension(value) {
    const dimension = Number(value || 0);
    return Number.isFinite(dimension) ? Math.max(dimension, 0) : 0;
  }

  function normalizeGeneratedArtifact(artifact) {
    const source = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
      ? artifact
      : {};
    const artifactId = normalizeId(source.artifact_id || source.artifactId);
    if (!artifactId) {
      return null;
    }
    const fileName = String(source.file_name || source.fileName || '').trim();
    return {
      artifact_id: artifactId,
      session_id: normalizeId(source.session_id || source.sessionId),
      artifact_kind: normalizeId(source.artifact_kind || source.artifactKind).toLowerCase() || 'document',
      title: String(source.title || fileName || 'Generated artifact').trim() || 'Generated artifact',
      file_name: fileName,
      display_path: String(source.display_path || source.displayPath || '').trim(),
      absolute_path: String(source.absolute_path || source.absolutePath || '').trim()
        ? REDACTED_PATH_TOKEN
        : '',
      language: String(source.language || '').trim(),
      mime_type: String(source.mime_type || source.mimeType || '').trim().toLowerCase(),
      width: normalizeDimension(source.width),
      height: normalizeDimension(source.height),
      source_kind: String(source.source_kind || source.sourceKind || '').trim().toLowerCase(),
      editable: source.editable !== false,
      status: String(source.status || 'available').trim().toLowerCase() || 'available',
      ...(Object.prototype.hasOwnProperty.call(source, 'local_trusted') || Object.prototype.hasOwnProperty.call(source, 'localTrusted')
        ? { local_trusted: source.local_trusted === true || source.localTrusted === true }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(source, 'trusted_local_path') || Object.prototype.hasOwnProperty.call(source, 'trustedLocalPath')
        ? { trusted_local_path: source.trusted_local_path === true || source.trustedLocalPath === true }
        : {}),
    };
  }

  function normalizeToolLifecycleStatus(value) {
    const status = normalizeId(value).toLowerCase();
    if (status === 'timeout' || status === 'timed_out') {
      return 'timed_out';
    }
    if (status === 'preempted') {
      return 'cancelled';
    }
    return status;
  }

  function cloneSortKey(sortKey) {
    const value = Array.isArray(sortKey) ? sortKey : [0, 0, 0];
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }

  function sortKeyCompare(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    for (let index = 0; index < 3; index += 1) {
      const delta = (Number(a[index]) || 0) - (Number(b[index]) || 0);
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  }

  function pushDistinct(list, value) {
    const normalized = normalizeId(value);
    if (!normalized || list.includes(normalized)) {
      return;
    }
    list.push(normalized);
  }

  function deepCloneJsonValue(value, seen) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const _seen = seen || new WeakSet();
    if (_seen.has(value)) {
      return Array.isArray(value) ? [] : {};
    }
    _seen.add(value);
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        result.push(deepCloneJsonValue(value[index], _seen));
      }
      return result;
    }
    const cloned = {};
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      cloned[key] = deepCloneJsonValue(value[key], _seen);
    }
    return cloned;
  }

  function clonePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return deepCloneJsonValue(value);
  }

  function extractToolCallId(payload) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};
    return normalizeId(
      source.callId
      || source.call_id
      || source.toolCallId
      || source.tool_call_id
      || (source.tool_call && source.tool_call.call_id)
      || (source.toolCall && source.toolCall.callId)
      || (source.tool_result && source.tool_result.call_id)
      || (source.toolResult && source.toolResult.callId)
    );
  }

  return Object.freeze({
    clonePlainObject,
    cloneSortKey,
    deepCloneJsonValue,
    extractToolCallId,
    normalizeGeneratedArtifact,
    normalizeId,
    normalizeToolLifecycleStatus,
    pushDistinct,
    sortKeyCompare,
  });
});
