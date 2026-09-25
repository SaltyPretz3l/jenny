'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { normalizeProjectId } = require('../projects/project-schema');
const { normalizePolicySnapshot } = require('./tool-policy-evaluator');

const TOOL_PERMISSION_SCHEMA_VERSION = 2;
const MAX_POLICY_VERSION = 1_000_000;
const MAX_POLICY_COUNT = 1_000;
const MAX_RULE_COUNT = 1_000;
const MAX_SCOPED_GRANT_COUNT = 1_000;
const MAX_PENDING_REVIEW_COUNT = 2_000;
const MAX_REVIEW_HISTORY_COUNT = 2_000;
const MAX_TOOL_NAME_CHARS = 160;
const MAX_RULE_ID_CHARS = 80;
const MAX_REASON_CHARS = 240;
const MAX_MATCH_TEXT_CHARS = 1_024;
const MAX_ORIGINAL_RECORD_BYTES = 8 * 1_024;
const VALID_DECISIONS = new Set(['auto', 'ask', 'deny']);
const GLOBAL_DECISIONS = new Set(['ask', 'deny']);
const REVIEW_DECISIONS = new Set(['auto', 'ask', 'deny', 'dismiss']);
const TOOL_NAME_ALIASES = Object.freeze({
  Read: 'read_file', Write: 'write_file', Edit: 'edit_file', Glob: 'glob_files',
  Grep: 'grep_search', Bash: 'run_command', CreateArtifact: 'create_artifact',
});
const TOOL_GRANT_NAME_MIGRATIONS = Object.freeze({
  lsp_diagnostics: 'lsp:diagnostics',
  lsp_symbols: 'lsp:symbols',
  lsp_definition: 'lsp:definition',
  lsp_references: 'lsp:references',
});
const RETIRED_TOOL_NAMES = Object.freeze(new Set([
  'browser_click', 'browser_close', 'browser_eval', 'browser_open', 'browser_screenshot',
  'browser_type', 'apply_patch', 'document_inspect', 'image_inspect', 'notebook_inspect',
  'pdf_inspect', 'presentation_inspect', 'spreadsheet_inspect',
]));
const RETIRED_INSPECT_TOOL_NAMES = Object.freeze(new Set([
  'document_inspect', 'image_inspect', 'notebook_inspect', 'pdf_inspect',
  'presentation_inspect', 'spreadsheet_inspect',
]));
const BLANKET_AUTO_APPROVE_RULE_ID = 'blanket_auto_approve';
const TOP_LEVEL_KEYS = Object.freeze([
  'legacy_policies', 'migration', 'pending_review', 'review_history', 'rules',
  'schema_version', 'scoped_grants', 'version',
]);
const RULE_KEYS = Object.freeze(['decision', 'id', 'match', 'reason']);
const MATCH_KEYS = Object.freeze([
  'action', 'mcp_server', 'mode', 'path_prefix', 'source_kind', 'tool_family', 'tool_id',
]);
const AUTHORITY_KEYS = Object.freeze([
  'device_id', 'inode', 'project_id', 'root_id', 'root_path', 'root_revision',
]);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function hasUniqueValues(values) {
  return new Set(values).size === values.length;
}

function normalizeToolName(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) return '';
  const aliased = Object.hasOwn(TOOL_NAME_ALIASES, token) ? TOOL_NAME_ALIASES[token] : token;
  return Object.hasOwn(TOOL_GRANT_NAME_MIGRATIONS, aliased)
    ? TOOL_GRANT_NAME_MIGRATIONS[aliased]
    : aliased;
}

function validateCompositeToolName(toolName) {
  const separatorIndex = toolName.indexOf(':');
  if (separatorIndex === -1) return;
  const toolSegment = toolName.slice(0, separatorIndex);
  const actionSegment = toolName.slice(separatorIndex + 1);
  const invalid = [...actionSegment].some((character) => (
    /\s/u.test(character) || character.codePointAt(0) < 0x20 || character === '\x7f'
  ));
  if (!toolSegment || !actionSegment || [...actionSegment].length > 64
    || actionSegment.includes(':') || invalid) {
    throw new Error('Invalid composite tool name. Must match "tool:action" with a 1-64 character action.');
  }
}

function splitCompositeToolName(toolName) {
  const separatorIndex = toolName.indexOf(':');
  return separatorIndex === -1
    ? { tool_id: toolName }
    : { tool_id: toolName.slice(0, separatorIndex), action: toolName.slice(separatorIndex + 1) };
}

function validateToolName(value) {
  const name = normalizeToolName(value);
  if (!name || name.length > MAX_TOOL_NAME_CHARS) return null;
  try {
    validateCompositeToolName(name);
  } catch (_error) {
    return null;
  }
  return name;
}

function canonicalText(value, limit, { optional = false } = {}) {
  if (value === null && optional) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) return optional ? null : undefined;
  if (normalized !== value || normalized.length > limit) return undefined;
  return normalized;
}

function canonicalPathText(value, { optional = false } = {}) {
  if (value === null && optional) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return optional ? null : undefined;
  if (normalized !== value || normalized.length > MAX_MATCH_TEXT_CHARS) return undefined;
  return normalized;
}

function canonicalMode(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const modes = [];
  for (const entry of value) {
    const mode = canonicalText(entry, 80);
    if (!mode || modes.includes(mode)) return undefined;
    modes.push(mode);
  }
  return modes.length ? modes : null;
}

function canonicalRule(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, RULE_KEYS)) return null;
  if (!VALID_DECISIONS.has(value.decision)) return null;
  const id = canonicalText(value.id, MAX_RULE_ID_CHARS);
  const reason = value.reason === undefined
    ? 'Rule matched'
    : canonicalText(value.reason, MAX_REASON_CHARS);
  if (!id || !reason || !isPlainRecord(value.match || {})) return null;
  const matchInput = value.match || {};
  if (!hasOnlyKeys(matchInput, MATCH_KEYS)) return null;
  const match = {};
  for (const [key, limit] of [
    ['tool_id', MAX_TOOL_NAME_CHARS], ['action', MAX_TOOL_NAME_CHARS],
    ['tool_family', 80], ['source_kind', 80],
    ['mcp_server', MAX_TOOL_NAME_CHARS],
  ]) {
    if (!Object.hasOwn(matchInput, key)) continue;
    if (key === 'action' && matchInput[key] === null) return null;
    const normalized = canonicalText(matchInput[key], limit, { optional: true });
    if (normalized === undefined) return null;
    if (normalized !== null) match[key] = key === 'tool_id'
      ? validateToolName(normalized)
      : normalized;
    if (normalized !== null && !match[key]) return null;
  }
  if (Object.hasOwn(matchInput, 'path_prefix')) {
    const pathPrefix = canonicalPathText(matchInput.path_prefix, { optional: true });
    if (pathPrefix === undefined) return null;
    if (pathPrefix !== null) match.path_prefix = pathPrefix;
  }
  if (match.tool_id) {
    const split = splitCompositeToolName(match.tool_id);
    if (split.action && match.action && split.action !== match.action) return null;
    match.tool_id = split.tool_id;
    if (split.action) match.action = split.action;
  }
  if (Object.hasOwn(matchInput, 'mode')) {
    const mode = canonicalMode(matchInput.mode);
    if (mode === undefined) return null;
    if (mode) match.mode = mode;
  }
  const rule = { id, decision: value.decision, reason, match };
  const normalized = normalizePolicySnapshot({ version: 1, legacy_policies: {}, rules: [rule] });
  if (normalized.rules.length !== 1) return null;
  return rule;
}

function canonicalLegacyPolicies(value, { allowAuto }) {
  if (!isPlainRecord(value) || Object.keys(value).length > MAX_POLICY_COUNT) return null;
  const policies = {};
  for (const [rawName, decision] of Object.entries(value)) {
    const toolName = validateToolName(rawName);
    if (!toolName || !VALID_DECISIONS.has(decision) || (!allowAuto && decision === 'auto')) return null;
    const existing = policies[toolName];
    if (existing !== undefined) return null;
    if (!existing || decision === 'deny' || (decision === 'ask' && existing === 'auto')) {
      policies[toolName] = decision;
    }
  }
  return policies;
}

function normalizeAuthority(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, AUTHORITY_KEYS)) return null;
  const projectId = normalizeProjectId(value.project_id);
  if (!projectId || projectId !== value.project_id) return null;
  if (!Number.isSafeInteger(value.root_revision) || value.root_revision < 0) return null;
  const rootPath = value.root_path;
  const rootId = value.root_id;
  const unbound = rootPath === null && rootId === null;
  const bound = typeof rootPath === 'string' && rootPath.length > 0
    && typeof rootId === 'string' && rootId.length > 0;
  if (!unbound && !bound) return null;
  const deviceId = value.device_id;
  const inode = value.inode;
  const noPhysicalId = deviceId === null && inode === null;
  const physicalId = typeof deviceId === 'string' && /^[1-9]\d*$/u.test(deviceId)
    && typeof inode === 'string' && /^[1-9]\d*$/u.test(inode);
  if ((!noPhysicalId && !physicalId) || (unbound && !noPhysicalId)) return null;
  return {
    project_id: projectId,
    root_path: rootPath,
    root_id: rootId,
    root_revision: value.root_revision,
    device_id: deviceId,
    inode,
  };
}

function authoritiesMatch(left, right) {
  const a = normalizeAuthority(left);
  const b = normalizeAuthority(right);
  return Boolean(a && b && AUTHORITY_KEYS.every((key) => a[key] === b[key]));
}

function stableId(prefix, value) {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
  return `${prefix}:${digest}`;
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function originalRecordIsValid(value) {
  if (!isPlainRecord(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_ORIGINAL_RECORD_BYTES;
  } catch (_error) {
    return false;
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validateScopedGrant(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'authority', 'created_at', 'id', 'match', 'path_prefix', 'source', 'tool_name',
  ])) return false;
  const pathPrefix = canonicalPathText(value.path_prefix, { optional: true });
  const canonical = canonicalRule({
    id: value.id,
    decision: 'auto',
    reason: 'Scoped grant',
    match: value.match,
  });
  const split = value.tool_name === '*' ? null : splitCompositeToolName(value.tool_name);
  return Boolean(
    canonicalText(value.id, MAX_RULE_ID_CHARS)
    && (value.tool_name === '*' || validateToolName(value.tool_name) === value.tool_name)
    && pathPrefix !== undefined && pathPrefix === value.path_prefix
    && canonical && isDeepStrictEqual(canonical.match, value.match)
    && (value.tool_name === '*' || canonical.match.tool_id === split.tool_id)
    && (!split?.action || canonical.match.action === split.action)
    && (canonical.match.path_prefix || null) === value.path_prefix
    && normalizeAuthority(value.authority)
    && validTimestamp(value.created_at)
    && value.source === 'user'
  );
}

function validatePending(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'created_at', 'id', 'original_kind', 'original_record', 'path_prefix',
    'source', 'tool_name',
  ])) return false;
  const pathPrefix = canonicalPathText(value.path_prefix, { optional: true });
  return Boolean(
    canonicalText(value.id, MAX_RULE_ID_CHARS)
    && (value.tool_name === '*' || validateToolName(value.tool_name) === value.tool_name)
    && pathPrefix !== undefined && pathPrefix === value.path_prefix
    && ['policy', 'rule', 'scoped_grant'].includes(value.original_kind)
    && ['migration', 'import'].includes(value.source)
    && originalRecordIsValid(value.original_record)
    && validTimestamp(value.created_at)
  );
}

function validateHistory(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'decision', 'original_record', 'pending_id', 'reviewed_at', 'scoped_grant_id',
  ])) return false;
  return Boolean(
    canonicalText(value.pending_id, MAX_RULE_ID_CHARS)
    && ['auto', 'ask', 'deny', 'dismiss', 'retired'].includes(value.decision)
    && validTimestamp(value.reviewed_at)
    && (value.scoped_grant_id === null || canonicalText(value.scoped_grant_id, MAX_RULE_ID_CHARS))
    && originalRecordIsValid(value.original_record)
  );
}

function validatePermissionDocument(value) {
  if (!isPlainRecord(value)) return { ok: false, reason: 'invalid_schema' };
  if (Number.isSafeInteger(value.schema_version)
    && value.schema_version > TOOL_PERMISSION_SCHEMA_VERSION) {
    return { ok: false, reason: 'future_schema' };
  }
  if (value.schema_version !== TOOL_PERMISSION_SCHEMA_VERSION || !hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1 || value.version > MAX_POLICY_VERSION) {
    return { ok: false, reason: 'invalid_policy_version' };
  }
  const policies = canonicalLegacyPolicies(value.legacy_policies, { allowAuto: false });
  if (!policies || !isDeepStrictEqual(policies, value.legacy_policies)) {
    return { ok: false, reason: 'invalid_policies' };
  }
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULE_COUNT) {
    return { ok: false, reason: 'invalid_rules' };
  }
  const rules = value.rules.map(canonicalRule);
  if (rules.some((rule) => !rule || !GLOBAL_DECISIONS.has(rule.decision))
    || !hasUniqueValues(rules.filter(Boolean).map((rule) => rule.id))
    || !isDeepStrictEqual(rules, value.rules)) {
    return { ok: false, reason: 'invalid_rules' };
  }
  if (!Array.isArray(value.scoped_grants) || value.scoped_grants.length > MAX_SCOPED_GRANT_COUNT
    || !value.scoped_grants.every(validateScopedGrant)
    || !hasUniqueValues(value.scoped_grants.map((grant) => grant.id))) {
    return { ok: false, reason: 'invalid_scoped_grants' };
  }
  if (!Array.isArray(value.pending_review) || value.pending_review.length > MAX_PENDING_REVIEW_COUNT
    || !value.pending_review.every(validatePending)
    || !hasUniqueValues(value.pending_review.map((record) => record.id))) {
    return { ok: false, reason: 'invalid_pending_review' };
  }
  if (!Array.isArray(value.review_history) || value.review_history.length > MAX_REVIEW_HISTORY_COUNT
    || !value.review_history.every(validateHistory)
    || !hasUniqueValues(value.review_history.map((record) => record.pending_id))) {
    return { ok: false, reason: 'invalid_review_history' };
  }
  if (!isPlainRecord(value.migration)) return { ok: false, reason: 'invalid_migration_metadata' };
  const projectedRuleCount = value.rules.length
    + Object.values(value.legacy_policies).filter((decision) => decision === 'deny').length
    + value.scoped_grants.length;
  if (projectedRuleCount > MAX_RULE_COUNT) {
    return { ok: false, reason: 'aggregate_rule_capacity_exceeded' };
  }
  return { ok: true, document: safeClone(value) };
}

function createEmptyPermissionDocument({ now = new Date().toISOString(), sourceFormat = 'created' } = {}) {
  return {
    schema_version: TOOL_PERMISSION_SCHEMA_VERSION,
    version: 1,
    legacy_policies: {},
    rules: [],
    scoped_grants: [],
    pending_review: [],
    review_history: [],
    migration: { source_format: sourceFormat, migrated_at: now },
  };
}

function pendingFromPolicy(toolName, originalRecord, now, source = 'migration') {
  return {
    id: stableId('review', { original_kind: 'policy', toolName, originalRecord, source }),
    tool_name: toolName,
    path_prefix: null,
    original_kind: 'policy',
    original_record: safeClone(originalRecord),
    source,
    created_at: now,
  };
}

function pendingFromRule(rule, now, source = 'migration') {
  const toolName = rule.match.tool_id
    ? `${rule.match.tool_id}${rule.match.action ? `:${rule.match.action}` : ''}`
    : '*';
  return {
    id: stableId('review', { original_kind: 'rule', rule, source }),
    tool_name: toolName,
    path_prefix: rule.match.path_prefix || null,
    original_kind: 'rule',
    original_record: safeClone(rule),
    source,
    created_at: now,
  };
}

function retiredHistory(originalRecord, now) {
  return {
    pending_id: stableId('retired', originalRecord),
    decision: 'retired',
    reviewed_at: now,
    scoped_grant_id: null,
    original_record: safeClone(originalRecord),
  };
}

function parseLegacyPermissionDocument(raw) {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'invalid_schema' };
  const inline = Object.hasOwn(raw, 'legacy_policies') || Object.hasOwn(raw, 'rules')
    || Object.hasOwn(raw, 'version');
  if (!inline) {
    const policies = canonicalLegacyPolicies(raw, { allowAuto: true });
    return policies ? { ok: true, sourceFormat: 'legacy_flatmap', version: 1, policies, rules: [] }
      : { ok: false, reason: 'invalid_legacy_flatmap' };
  }
  if (!hasOnlyKeys(raw, ['legacy_policies', 'rules', 'schema_version', 'version'])) {
    return { ok: false, reason: 'unknown_legacy_fields' };
  }
  if (Object.hasOwn(raw, 'schema_version') && raw.schema_version !== 1) {
    return { ok: false, reason: 'invalid_legacy_schema_version' };
  }
  if (!Number.isSafeInteger(raw.version) || raw.version < 1 || raw.version > MAX_POLICY_VERSION) {
    return { ok: false, reason: 'invalid_policy_version' };
  }
  const policies = canonicalLegacyPolicies(raw.legacy_policies, { allowAuto: true });
  if (!policies || !Array.isArray(raw.rules) || raw.rules.length > MAX_RULE_COUNT) {
    return { ok: false, reason: 'invalid_legacy_document' };
  }
  const rules = raw.rules.map(canonicalRule);
  if (rules.some((rule) => !rule) || !hasUniqueValues(rules.map((rule) => rule.id))) {
    return { ok: false, reason: 'invalid_legacy_rules' };
  }
  return { ok: true, sourceFormat: 'inline_v1', version: raw.version, policies, rules };
}

function migratePermissionDocument(raw, { now = new Date().toISOString() } = {}) {
  if (isPlainRecord(raw) && Object.hasOwn(raw, 'schema_version')) {
    if (raw.schema_version === TOOL_PERMISSION_SCHEMA_VERSION
      || (Number.isSafeInteger(raw.schema_version)
        && raw.schema_version > TOOL_PERMISSION_SCHEMA_VERSION)) {
      const validation = validatePermissionDocument(raw);
      return validation.ok
        ? { ok: true, changed: false, document: validation.document, notices: {} }
        : validation;
    }
  }
  const legacy = parseLegacyPermissionDocument(raw);
  if (!legacy.ok) return legacy;
  const document = createEmptyPermissionDocument({ now, sourceFormat: legacy.sourceFormat });
  document.version = legacy.version;
  const notices = { blanket_rule_retired: false, retired_inspect_deny_seen: false };
  for (const [toolName, decision] of Object.entries(legacy.policies)) {
    const original = { tool_name: toolName, decision };
    if (RETIRED_TOOL_NAMES.has(toolName)) {
      document.review_history.push(retiredHistory(original, now));
      if (decision === 'deny' && RETIRED_INSPECT_TOOL_NAMES.has(toolName)) {
        notices.retired_inspect_deny_seen = true;
      }
    } else if (decision === 'auto') {
      document.pending_review.push(pendingFromPolicy(toolName, original, now));
    } else {
      document.legacy_policies[toolName] = decision;
    }
  }
  for (const rule of legacy.rules) {
    const toolName = rule.match.tool_id || '';
    if (rule.id === BLANKET_AUTO_APPROVE_RULE_ID || RETIRED_TOOL_NAMES.has(toolName)) {
      document.review_history.push(retiredHistory(rule, now));
      if (rule.id === BLANKET_AUTO_APPROVE_RULE_ID) notices.blanket_rule_retired = true;
      if (rule.decision === 'deny' && RETIRED_INSPECT_TOOL_NAMES.has(toolName)) {
        notices.retired_inspect_deny_seen = true;
      }
    } else if (rule.decision === 'auto') {
      document.pending_review.push(pendingFromRule(rule, now));
    } else {
      document.rules.push(rule);
    }
  }
  if (document.pending_review.length > MAX_PENDING_REVIEW_COUNT
    || document.review_history.length > MAX_REVIEW_HISTORY_COUNT) {
    return { ok: false, reason: 'migration_capacity_exceeded' };
  }
  const validation = validatePermissionDocument(document);
  return validation.ok
    ? { ok: true, changed: true, document: validation.document, notices }
    : validation;
}

function pendingFromScopedGrant(grant, now) {
  const original = safeClone(grant);
  return {
    id: stableId('review', { original_kind: 'scoped_grant', grant: original, source: 'import' }),
    tool_name: grant.tool_name,
    path_prefix: grant.path_prefix,
    original_kind: 'scoped_grant',
    original_record: original,
    source: 'import',
    created_at: now,
  };
}

function sanitizePermissionDocumentForImport(raw, { now = new Date().toISOString() } = {}) {
  const migrated = migratePermissionDocument(raw, { now });
  if (!migrated.ok) return migrated;
  const source = migrated.document;
  const output = createEmptyPermissionDocument({ now, sourceFormat: 'import' });
  output.version = source.version;
  output.legacy_policies = safeClone(source.legacy_policies);
  output.rules = safeClone(source.rules);
  output.pending_review = source.pending_review.map((record) => ({
    ...safeClone(record), source: 'import', created_at: now,
  }));
  output.pending_review.push(...source.scoped_grants.map((grant) => pendingFromScopedGrant(grant, now)));
  output.review_history = safeClone(source.review_history);
  if (output.pending_review.length > MAX_PENDING_REVIEW_COUNT) {
    return { ok: false, reason: 'import_capacity_exceeded' };
  }
  const validation = validatePermissionDocument(output);
  return validation.ok ? { ok: true, document: validation.document } : validation;
}

module.exports = {
  authoritiesMatch,
  BLANKET_AUTO_APPROVE_RULE_ID,
  createEmptyPermissionDocument,
  GLOBAL_DECISIONS,
  MAX_MATCH_TEXT_CHARS,
  MAX_PENDING_REVIEW_COUNT,
  MAX_REVIEW_HISTORY_COUNT,
  MAX_RULE_COUNT,
  MAX_SCOPED_GRANT_COUNT,
  migratePermissionDocument,
  normalizeAuthority,
  normalizeToolName,
  RETIRED_INSPECT_TOOL_NAMES,
  RETIRED_TOOL_NAMES,
  REVIEW_DECISIONS,
  sanitizePermissionDocumentForImport,
  stableId,
  splitCompositeToolName,
  TOOL_PERMISSION_SCHEMA_VERSION,
  validateCompositeToolName,
  validatePermissionDocument,
};
