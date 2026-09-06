'use strict';

const {
  PLUGIN_SESSION_LIMITS,
} = require('../plugin-session-budgets');

const CHAT_SESSION_TYPE = 'chat';
const PLUGIN_SESSION_TYPE = 'plugin';
const LEGACY_IMAGE_SESSION_TYPE = 'image';

const PLUGIN_SESSION_SCHEMA_VERSION = 1;
const PLUGIN_SESSION_STATE_MAX_BYTES = PLUGIN_SESSION_LIMITS.state_bytes;
const PLUGIN_OPERATION_METADATA_MAX_BYTES = PLUGIN_SESSION_LIMITS.message_operation_metadata_bytes;
const PLUGIN_OPERATION_SESSION_MAX_BYTES = PLUGIN_SESSION_LIMITS.session_operation_metadata_bytes;

const OFFICIAL_IMAGE_PROVIDER = Object.freeze({
  schema_version: PLUGIN_SESSION_SCHEMA_VERSION,
  publisher_id: 'jenny-official',
  plugin_id: 'local-image-generation',
  provider_contribution_id: 'local_image_generation',
  view_contribution_id: 'image_workspace',
  provider_name: 'Local image generation',
  icon_token: 'image',
  plugin_version_at_creation: '1.0.0',
  state_schema_version: 1,
});

const IMAGE_STEPS_MIN = 1;
const IMAGE_STEPS_MAX = 100;
const IMAGE_RESOLUTION_PATTERN = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const SEMVER_PATTERN = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/;
const ACTIVE_OPERATION_STATUSES = new Set([
  'accepted', 'running', 'cancelling', 'cleanup_pending',
]);
const TERMINAL_OPERATION_STATUSES = new Set([
  'succeeded', 'failed', 'cancelled', 'interrupted', 'rejected', 'timeout',
]);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch (_error) { return Infinity; }
}

function cloneBoundedJsonObject(value, maxBytes) {
  const source = plainObject(value);
  if (!source || jsonBytes(source) > maxBytes) return null;
  try { return JSON.parse(JSON.stringify(source)); } catch (_error) { return null; }
}

function boundedIdentifier(value, pattern = IDENTIFIER_PATTERN) {
  const token = String(value || '').trim();
  return pattern.test(token) ? token : '';
}

function nonnegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSessionType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === PLUGIN_SESSION_TYPE || normalized === LEGACY_IMAGE_SESSION_TYPE) {
    return PLUGIN_SESSION_TYPE;
  }
  return CHAT_SESSION_TYPE;
}

function readSessionType(session) {
  if (typeof session === 'string') return normalizeSessionType(session);
  return normalizeSessionType(plainObject(session)?.session_type);
}

function normalizeImageConfig(value) {
  const source = plainObject(value);
  if (!source) return null;
  const modelId = String(source.model_id ?? source.modelId ?? '').trim();
  const resolution = String(source.resolution ?? '').trim().toLowerCase();
  const steps = Number(source.steps);
  if (!modelId || !IMAGE_RESOLUTION_PATTERN.test(resolution)
    || !Number.isSafeInteger(steps) || steps < IMAGE_STEPS_MIN || steps > IMAGE_STEPS_MAX) {
    return null;
  }
  return { model_id: modelId.slice(0, 200), resolution, steps };
}

function normalizeSessionImageConfig(sessionType, value) {
  const rawType = String(typeof sessionType === 'string'
    ? sessionType : sessionType?.session_type || '').trim().toLowerCase();
  return rawType === LEGACY_IMAGE_SESSION_TYPE ? normalizeImageConfig(value) : null;
}

function normalizeActivePluginOperation(value) {
  const source = plainObject(value);
  if (!source) return null;
  const operationId = boundedIdentifier(source.operation_id || source.operationId,
    OPERATION_ID_PATTERN);
  const actionId = boundedIdentifier(source.action_id || source.actionId);
  const attempt = Number(source.attempt);
  const status = String(source.status || '').trim().toLowerCase();
  const startedAt = String(source.started_at || source.startedAt || '').trim();
  if (!operationId || !actionId || !Number.isSafeInteger(attempt) || attempt < 1
    || !ACTIVE_OPERATION_STATUSES.has(status) || !startedAt) return null;
  const normalized = {
    operation_id: operationId,
    attempt,
    action_id: actionId,
    status,
    started_at: startedAt.slice(0, 40),
    frame_sequence: nonnegativeInteger(source.frame_sequence || source.frameSequence),
  };
  const assistantMessageId = boundedIdentifier(
    source.assistant_message_id || source.assistantMessageId, OPERATION_ID_PATTERN
  );
  if (assistantMessageId) normalized.assistant_message_id = assistantMessageId;
  return jsonBytes(normalized) <= PLUGIN_OPERATION_METADATA_MAX_BYTES ? normalized : null;
}

function normalizePluginSession(value) {
  const source = plainObject(value);
  if (!source || Number(source.schema_version) !== PLUGIN_SESSION_SCHEMA_VERSION) return null;
  const identity = {
    schema_version: PLUGIN_SESSION_SCHEMA_VERSION,
    publisher_id: boundedIdentifier(source.publisher_id, /^[a-z][a-z0-9-]{0,63}$/),
    plugin_id: boundedIdentifier(source.plugin_id),
    provider_contribution_id: boundedIdentifier(source.provider_contribution_id),
    view_contribution_id: boundedIdentifier(source.view_contribution_id),
    provider_name: String(source.provider_name || '').trim().slice(0, 120),
    icon_token: boundedIdentifier(source.icon_token),
    plugin_version_at_creation: String(source.plugin_version_at_creation || '').trim(),
  };
  if (!identity.publisher_id || !identity.plugin_id || !identity.provider_contribution_id
    || !identity.view_contribution_id || !identity.provider_name || !identity.icon_token
    || !SEMVER_PATTERN.test(identity.plugin_version_at_creation)) return null;
  const stateSchemaVersion = Number(source.state_schema_version);
  const stateRevision = Number(source.state_revision);
  const state = cloneBoundedJsonObject(source.state, PLUGIN_SESSION_STATE_MAX_BYTES);
  if (!Number.isSafeInteger(stateSchemaVersion) || stateSchemaVersion < 1
    || !Number.isSafeInteger(stateRevision) || stateRevision < 0 || !state) return null;
  return {
    ...identity,
    state_schema_version: stateSchemaVersion,
    state_revision: stateRevision,
    state,
    active_operation: normalizeActivePluginOperation(source.active_operation),
  };
}

function createOfficialImagePluginSession(imageConfig = null) {
  return normalizePluginSession({
    ...OFFICIAL_IMAGE_PROVIDER,
    state_revision: 0,
    state: normalizeImageConfig(imageConfig) || {},
    active_operation: null,
  });
}

function normalizePluginOperationMetadata(value) {
  const source = plainObject(value);
  if (!source) return null;
  const operationId = boundedIdentifier(source.operation_id || source.operationId,
    OPERATION_ID_PATTERN);
  const actionId = boundedIdentifier(source.action_id || source.actionId);
  const attempt = Math.max(1, nonnegativeInteger(source.attempt, 1));
  const status = String(source.status || '').trim().toLowerCase();
  if (!operationId || !actionId || !TERMINAL_OPERATION_STATUSES.has(status)) return null;
  const normalized = { operation_id: operationId, attempt, action_id: actionId, status };
  const reasonCode = boundedIdentifier(source.reason_code || source.error_code);
  if (reasonCode) normalized.reason_code = reasonCode;
  return jsonBytes(normalized) <= PLUGIN_OPERATION_METADATA_MAX_BYTES ? normalized : null;
}

function pluginOperationBytes(message) {
  return message?.plugin_operation ? jsonBytes(message.plugin_operation) : 0;
}

function enforcePluginOperationMetadataBudget(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let total = list.reduce((sum, message) => sum + pluginOperationBytes(message), 0);
  if (total <= PLUGIN_OPERATION_SESSION_MAX_BYTES) return list;
  const next = [...list];
  for (let index = 0; index < next.length && total > PLUGIN_OPERATION_SESSION_MAX_BYTES; index += 1) {
    const message = next[index];
    if (!message?.plugin_operation
      || !TERMINAL_OPERATION_STATUSES.has(message.plugin_operation.status)) continue;
    total -= pluginOperationBytes(message);
    const { plugin_operation: _stripped, ...retained } = message;
    next[index] = retained;
  }
  return next;
}

function sessionAllowsChatSend(session) {
  return readSessionType(session) === CHAT_SESSION_TYPE;
}

module.exports = {
  CHAT_SESSION_TYPE,
  IMAGE_RESOLUTION_PATTERN,
  IMAGE_STEPS_MAX,
  IMAGE_STEPS_MIN,
  LEGACY_IMAGE_SESSION_TYPE,
  OFFICIAL_IMAGE_PROVIDER,
  PLUGIN_OPERATION_METADATA_MAX_BYTES,
  PLUGIN_OPERATION_SESSION_MAX_BYTES,
  PLUGIN_SESSION_SCHEMA_VERSION,
  PLUGIN_SESSION_STATE_MAX_BYTES,
  PLUGIN_SESSION_TYPE,
  cloneBoundedJsonObject,
  createOfficialImagePluginSession,
  enforcePluginOperationMetadataBudget,
  jsonBytes,
  normalizeActivePluginOperation,
  normalizeImageConfig,
  normalizePluginOperationMetadata,
  normalizePluginSession,
  normalizeSessionImageConfig,
  normalizeSessionType,
  readSessionType,
  sessionAllowsChatSend,
};
