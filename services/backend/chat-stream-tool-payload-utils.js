const path = require('path');
const {
  CANCEL_REASON_TIMEOUT,
  TERMINAL_STATUS_TIMEOUT,
} = require('./chat-stream-terminal-utils');
const { TOOL_ERROR_CODES } = require('./error-codes');
const {
  REDACTED_PATH_TOKEN,
  redactPathLikeText,
  redactSensitiveLikeText,
  sanitizeApprovalReason,
  sanitizeApprovalPolicyText,
  sanitizeToolSummary,
  sanitizeToolInputValue,
  buildPersistedToolInputSnapshot,
} = require('./tool-loop-input-sanitization');
const {
  buildCanonicalTurnEvent,
} = require('./canonical-turn-event');
const { workspaceRootId } = require('../workspace-root-identity');

const TOOL_APPROVAL_MISSING_CALL_ID_CODE = TOOL_ERROR_CODES.COMMAND_BLOCKED;
const APPROVAL_POLICY_SCOPES = new Set([
  'Local command execution', 'Workspace files', 'Web and browser session',
  'Jenny work items', 'Jenny content', 'Local computer', 'Requested tool',
]);
const APPROVAL_POLICY_CONSEQUENCES = new Set([
  'May run a local command and change local state.',
  'May change data in this scope.', 'May read data in this scope.',
  'Review requested input',
]);

function containsTraversal(p) {
  if (!p || typeof p !== 'string') return true;
  return p.includes('\0') || p.split(/[\\/]/).includes('..');
}

function normalizeDurationMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function sanitizeApprovalPolicyPresentation(params = {}) {
  const policyScope = sanitizeApprovalPolicyText(params.policy_scope ?? params.policyScope);
  const policyConsequence = sanitizeApprovalPolicyText(params.policy_consequence ?? params.policyConsequence);
  return {
    policyScope: APPROVAL_POLICY_SCOPES.has(policyScope) ? policyScope : '',
    policyConsequence: APPROVAL_POLICY_CONSEQUENCES.has(policyConsequence) ? policyConsequence : '',
  };
}

function buildScopedApprovalId({ sessionId, streamId, callId } = {}) {
  return [
    'approval',
    String(sessionId || '').trim(),
    String(streamId || '').trim(),
    String(callId || '').trim(),
  ].filter(Boolean).join('_');
}

function buildApprovalCanonicalEvent({
  streamId,
  sessionId,
  callId,
  type,
  payload,
}) {
  const normalizedType = String(type || '').trim();
  const normalizedStreamId = String(streamId || '').trim();
  const normalizedCallId = String(callId || '').trim();
  const suffix = normalizedType === 'tool_approval_resolved' ? 'resolved' : 'requested';
  return buildCanonicalTurnEvent({
    type: normalizedType,
    turn_id: normalizedStreamId,
    stream_id: normalizedStreamId,
    session_id: String(sessionId || '').trim(),
    tool_call_id: normalizedCallId,
    event_id: `${normalizedStreamId}:approval:${suffix}:${normalizedCallId}`,
    payload,
  });
}

function approvalStateFromAbortSignal(controller) {
  const reason = controller?.signal?.reason;
  const source = reason && typeof reason === 'object' ? reason : {};
  const tokens = [
    source.cancel_reason,
    source.cancelReason,
    source.terminal_subcode,
    source.category,
    source.status,
  ].map((value) => String(value || '').trim().toLowerCase());
  return tokens.includes(CANCEL_REASON_TIMEOUT) || tokens.includes(TERMINAL_STATUS_TIMEOUT)
    ? 'timeout'
    : 'cancelled';
}

function normalizeGeneratedArtifactsFromNotification(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const rawAbsolutePath = String(entry.absolute_path || '').trim();
      const hasLocalTrusted = Object.prototype.hasOwnProperty.call(entry, 'local_trusted');
      const hasTrustedLocalPath = Object.prototype.hasOwnProperty.call(entry, 'trusted_local_path');
      return {
        artifact_id: String(entry.artifact_id || '').trim(),
        artifact_kind: String(entry.artifact_kind || '').trim(),
        title: String(entry.title || '').trim(),
        file_name: String(entry.file_name || '').trim(),
        display_path: String(entry.display_path || '').trim(),
        absolute_path: rawAbsolutePath ? REDACTED_PATH_TOKEN : '',
        _raw_absolute_path: rawAbsolutePath,
        language: String(entry.language || '').trim(),
        mime_type: String(entry.mime_type || entry.mimeType || '').trim(),
        width: Math.max(Number(entry.width || 0), 0),
        height: Math.max(Number(entry.height || 0), 0),
        editable: entry.editable !== false,
        status: String(entry.status || 'available').trim(),
        ...(hasLocalTrusted ? { local_trusted: entry.local_trusted === true } : {}),
        ...(hasTrustedLocalPath ? { trusted_local_path: entry.trusted_local_path === true } : {}),
      };
    })
    .filter((entry) => (
      entry.artifact_id
      && entry.title
      && entry.file_name
      && entry.display_path
      && (!entry._raw_absolute_path || !containsTraversal(entry._raw_absolute_path))
      && !containsTraversal(entry.display_path)
    ))
    .map((artifact) => {
      const normalized = { ...artifact };
      delete normalized._raw_absolute_path;
      return normalized;
    });
}

function mergeLocalGeneratedArtifactPaths(service, {
  streamId,
  callId,
  sessionId,
  artifacts,
}) {
  const store = service?._electronToolGeneratedArtifactsByCall;
  if (!(store instanceof Map) || !Array.isArray(artifacts) || !artifacts.length) {
    return artifacts;
  }
  const normalizedStreamId = String(streamId || '').trim();
  const normalizedCallId = String(callId || '').trim();
  const keys = [
    `${normalizedStreamId}|${normalizedCallId}`,
    `|${normalizedCallId}`,
  ];
  let localArtifacts = [];
  let consumedKey = '';
  for (const key of keys) {
    const value = store.get(key);
    if (Array.isArray(value) && value.length) {
      localArtifacts = value;
      consumedKey = key;
      break;
    }
  }
  if (!localArtifacts.length) {
    return artifacts;
  }
  if (consumedKey) {
    store.delete(consumedKey);
  }
  const localById = new Map(
    localArtifacts
      .map((entry) => [String(entry?.artifact_id || '').trim(), entry])
      .filter(([artifactId]) => artifactId)
  );
  return artifacts.map((artifact) => {
    const local = localById.get(String(artifact?.artifact_id || '').trim());
    const absolutePath = String(local?.absolute_path || '').trim();
    return absolutePath && !containsTraversal(absolutePath)
      ? {
        ...artifact,
        absolute_path: REDACTED_PATH_TOKEN,
        local_trusted: true,
        session_id: String(sessionId || '').trim() || undefined,
      }
      : artifact;
  });
}

function normalizeToolResultMetadataFromNotification(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
  const lateEvents = Array.isArray(metadata.late_events) ? metadata.late_events.slice() : [];
  return {
    ...metadata,
    late_events: lateEvents,
  };
}

function workspaceIdentityForDiffMetadata(service, value, trustedWorkspaceRoot = '') {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!metadata.diff && !Array.isArray(metadata.diffs)) return {};
  try {
    const root = String(trustedWorkspaceRoot || '').trim()
      || service?.configService?.getToolsWorkspaceRoot?.()
      || service?.configService?.getState?.()?.toolsWorkspaceRoot
      || '';
    const workspaceId = workspaceRootId(root);
    return workspaceId ? { workspace_id: workspaceId } : {};
  } catch (_error) {
    return {};
  }
}

function attachWorkspaceIdentityToCanonicalEvent(params, service, trustedWorkspaceRoot = '') {
  const payload = params?.payload;
  const identity = workspaceIdentityForDiffMetadata(service, payload?.metadata, trustedWorkspaceRoot);
  if (!identity.workspace_id) return params;
  return {
    ...params,
    payload: { ...payload, metadata: { ...payload.metadata, ...identity } },
  };
}

function normalizeToolInputFromNotification(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

function normalizeExternalPayloadsFromNotification(value, service) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const userDataPath = String(service?.options?.userDataPath || '').trim();
  if (!userDataPath) {
    return {};
  }
  const allowedRoot = path.resolve(path.join(userDataPath, 'background-memory', 'ipc-payloads'));
  const normalized = {};
  for (const [field, rawEntry] of Object.entries(value)) {
    const normalizedField = String(field || '').trim();
    if (!normalizedField || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      continue;
    }
    const rawPath = String(rawEntry.path || '').trim();
    if (!rawPath || containsTraversal(rawPath) || !path.isAbsolute(rawPath)) {
      continue;
    }
    const resolvedPath = path.resolve(rawPath);
    const compareResolved = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    const compareAllowed = process.platform === 'win32' ? allowedRoot.toLowerCase() : allowedRoot;
    if (!(compareResolved === compareAllowed || compareResolved.startsWith(`${compareAllowed}${path.sep}`))) {
      continue;
    }
    const relativePath = path.relative(allowedRoot, resolvedPath).replace(/\\/g, '/');
    if (!relativePath || containsTraversal(relativePath) || path.isAbsolute(relativePath)) {
      continue;
    }
    normalized[normalizedField] = {
      path: relativePath,
      bytes: Math.max(Number(rawEntry.bytes || 0), 0),
      encoding: String(rawEntry.encoding || 'utf-8').trim() || 'utf-8',
      format: String(rawEntry.format || 'json').trim() || 'json',
    };
  }
  return normalized;
}

function completedToolResultCallIdsForStream(messages, streamId) {
  const normalizedStreamId = String(streamId || '').trim();
  return new Set(
    (Array.isArray(messages) ? messages : [])
      .filter((message) => String(message?.kind || '').trim() === 'tool_result')
      .filter((message) => (
        String(message?.tool_result?.parent_stream_id || '').trim() === normalizedStreamId
      ))
      .map((message) => String(message?.tool_result?.call_id || '').trim())
      .filter(Boolean)
  );
}

function buildToolCallPayload({
  callId,
  approvalId = '',
  policyDecisionId = '',
  reason = '',
  policyScope = '',
  policyConsequence = '',
  toolName,
  input,
  inputSnapshot = null,
  summary,
  status,
  approvalState,
  streamId,
  externalPayloads = {},
}) {
  // Reuse a snapshot the caller already computed: sanitizing the
  // input (recursive redaction + JSON.stringify) is otherwise run twice per tool
  // event. A provided snapshot must carry the canonical { input, inputJson } shape.
  const sanitizedInput = inputSnapshot
    && typeof inputSnapshot === 'object'
    && Object.prototype.hasOwnProperty.call(inputSnapshot, 'input')
    && Object.prototype.hasOwnProperty.call(inputSnapshot, 'inputJson')
    ? inputSnapshot
    : buildPersistedToolInputSnapshot(input);
  const {
    policyScope: sanitizedPolicyScope,
    policyConsequence: sanitizedPolicyConsequence,
  } = sanitizeApprovalPolicyPresentation({ policyScope, policyConsequence });
  // Sanitized here rather than only at the caller: the policy pair is bounded
  // inside this builder, and a reason reaching it unbounded from any other
  // caller would be persisted raw.
  const sanitizedReason = sanitizeApprovalReason(reason);
  return {
    call_id: String(callId || '').trim(),
    ...(String(approvalId || '').trim() ? { approval_id: String(approvalId || '').trim() } : {}),
    ...(String(policyDecisionId || '').trim()
      ? { policy_decision_id: String(policyDecisionId || '').trim() }
      : {}),
    ...(sanitizedReason ? { reason: sanitizedReason } : {}),
    ...(sanitizedPolicyScope
      ? { policy_scope: sanitizedPolicyScope }
      : {}),
    ...(sanitizedPolicyConsequence
      ? { policy_consequence: sanitizedPolicyConsequence }
      : {}),
    tool_name: String(toolName || '').trim(),
    input: sanitizedInput.input,
    input_json: sanitizedInput.inputJson,
    summary: sanitizeToolSummary(summary).trim(),
    status: String(status || '').trim() || 'completed',
    approval_state: String(approvalState || '').trim() || 'auto',
    duration_ms: 0,
    parent_stream_id: String(streamId || '').trim(),
    ...(Object.keys(externalPayloads).length ? { external_payloads: externalPayloads } : {}),
  };
}

function findToolMessageId(messages, { kind, callId, streamId = '', fallbackId = '' }) {
  const list = Array.isArray(messages) ? messages : [];
  const normalizedCallId = String(callId || '').trim();
  const normalizedStreamId = String(streamId || '').trim();
  const normalizedFallbackId = String(fallbackId || '').trim();
  if (!list.length) {
    return '';
  }
  if (normalizedFallbackId) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (String(message?.id || '') === normalizedFallbackId) {
        return normalizedFallbackId;
      }
    }
  }
  if (!normalizedCallId) {
    return '';
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (String(message?.kind || '').trim() !== kind) {
      continue;
    }
    const candidateCallId = kind === 'tool_use'
      ? String(message?.tool_call?.call_id || '').trim()
      : String(message?.tool_result?.call_id || '').trim();
    const candidateStreamId = kind === 'tool_use'
      ? String(message?.tool_call?.parent_stream_id || '').trim()
      : String(message?.tool_result?.parent_stream_id || '').trim();
    if (normalizedStreamId && candidateStreamId && candidateStreamId !== normalizedStreamId) {
      continue;
    }
    if (candidateCallId === normalizedCallId) {
      return String(message?.id || '').trim();
    }
  }
  return '';
}

function resolveApprovalCallId(toolName, explicitCallId) {
  const explicit = String(explicitCallId || '').trim();
  if (explicit) {
    return explicit;
  }
  throw new Error(
    `${TOOL_APPROVAL_MISSING_CALL_ID_CODE} Tool approval request for "${String(toolName || 'unknown_tool').trim() || 'unknown_tool'}" is missing tool_call_id.`
  );
}

function approvalTerminalOutput(toolName, approvalState) {
  const name = String(toolName || 'tool').trim() || 'tool';
  switch (String(approvalState || '').trim()) {
    case 'denied':
      return `Tool "${name}" was denied by the user.`;
    case 'cancelled':
      return `Tool "${name}" was cancelled before execution.`;
    case 'timeout':
      return `Approval for "${name}" timed out before execution.`;
    case 'preempted':
      return `Approval for "${name}" was preempted before execution.`;
    default:
      return `Tool "${name}" did not run because approval was not granted.`;
  }
}

function makeNoteTurnEvent(turnEventCollector, streamId) {
  return function noteTurnEvent(kind, buildEvent) {
    if (!turnEventCollector) return null;
    const event = buildEvent();
    return turnEventCollector.noteEvent(kind === null ? event : { turn_id: streamId, kind, ...event });
  };
}

module.exports = {
  containsTraversal,
  normalizeDurationMs,
  redactPathLikeText,
  redactSensitiveLikeText,
  sanitizeToolSummary,
  sanitizeToolInputValue,
  buildPersistedToolInputSnapshot,
  buildScopedApprovalId,
  buildApprovalCanonicalEvent,
  approvalStateFromAbortSignal,
  normalizeGeneratedArtifactsFromNotification,
  mergeLocalGeneratedArtifactPaths,
  normalizeToolResultMetadataFromNotification,
  workspaceIdentityForDiffMetadata,
  attachWorkspaceIdentityToCanonicalEvent,
  normalizeToolInputFromNotification,
  normalizeExternalPayloadsFromNotification,
  completedToolResultCallIdsForStream,
  buildToolCallPayload,
  sanitizeApprovalReason,
  sanitizeApprovalPolicyText,
  sanitizeApprovalPolicyPresentation,
  findToolMessageId,
  resolveApprovalCallId,
  approvalTerminalOutput,
  makeNoteTurnEvent,
};
