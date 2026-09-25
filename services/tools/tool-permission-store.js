'use strict';

const fs = require('node:fs');
const { FileJsonStore } = require('../backend/file-json-store');
const { normalizePolicySnapshot } = require('./tool-policy-evaluator');
const {
  authoritiesMatch,
  createEmptyPermissionDocument,
  GLOBAL_DECISIONS,
  MAX_MATCH_TEXT_CHARS,
  MAX_REVIEW_HISTORY_COUNT,
  MAX_RULE_COUNT,
  MAX_SCOPED_GRANT_COUNT,
  migratePermissionDocument,
  normalizeAuthority,
  normalizeToolName,
  REVIEW_DECISIONS,
  stableId,
  splitCompositeToolName,
  validateCompositeToolName,
  validatePermissionDocument,
} = require('./tool-permission-migrations');

const NEVER_PERSIST_ALWAYS_ALLOW = Object.freeze(new Set(['exit_plan_mode']));
const MAX_PERMISSION_DOCUMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_POLICIES = Object.freeze({
  read_file: 'auto', glob_files: 'auto', grep_search: 'auto', write_file: 'ask',
  edit_file: 'ask', run_command: 'ask', create_artifact: 'ask',
});
const VALID_POLICIES = new Set(['auto', 'ask', 'deny']);
const LEGACY_DENY_RULE_ID_PREFIX = 'legacy_deny:';
const UNAVAILABLE_RULE_ID = 'permission-store-unavailable';

class ToolPermissionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolPermissionStoreError';
    this.code = code;
  }
}

function copyRule(rule) {
  return { ...rule, match: { ...rule.match } };
}

function cloneDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

function unavailableSnapshot() {
  return normalizePolicySnapshot({
    version: 1,
    legacy_policies: {},
    rules: [{
      id: UNAVAILABLE_RULE_ID,
      decision: 'deny',
      match: {},
      reason: 'Stored tool permissions are unavailable or incompatible',
    }],
  });
}

function materializeLegacyDenyRules(document) {
  const denyRules = Object.entries(document.legacy_policies)
    .filter(([, decision]) => decision === 'deny')
    .map(([toolName]) => {
      const match = splitCompositeToolName(toolName);
      return {
        id: `${LEGACY_DENY_RULE_ID_PREFIX}${toolName}`,
        decision: 'deny',
        match,
        reason: `Per-tool deny for ${toolName}`,
      };
    });
  return normalizePolicySnapshot({
    version: document.version,
    legacy_policies: document.legacy_policies,
    rules: [...document.rules, ...denyRules],
  });
}

function scopedGrantRule(grant) {
  return {
    id: grant.id,
    decision: 'auto',
    match: { ...grant.match },
    reason: `Always allow ${grant.tool_name} in the captured project authority`,
  };
}

function assertToolName(toolName) {
  const normalizedName = normalizeToolName(toolName);
  if (!normalizedName || normalizedName.length > 160) {
    throw new ToolPermissionStoreError('permission_tool_invalid', 'Tool name is required.');
  }
  validateCompositeToolName(normalizedName);
  return normalizedName;
}

function assertAuthority(authority) {
  const normalized = normalizeAuthority(authority);
  if (!normalized) {
    throw new ToolPermissionStoreError(
      'permission_scope_required',
      'A valid captured project authority is required for an automatic grant.'
    );
  }
  return normalized;
}

function normalizedPathPrefix(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const value = source.path ?? source.file_path ?? '';
  const pathPrefix = typeof value === 'string' ? value.trim() : '';
  if (pathPrefix.length > MAX_MATCH_TEXT_CHARS) {
    throw new ToolPermissionStoreError(
      'permission_path_too_long',
      `Permission path must be at most ${MAX_MATCH_TEXT_CHARS} characters.`
    );
  }
  return pathPrefix || null;
}

function matchForToolGrant(toolName, pathPrefix) {
  const match = toolName === '*' ? {} : splitCompositeToolName(toolName);
  if (pathPrefix) match.path_prefix = pathPrefix;
  return match;
}

function matchForReviewedGrant(record) {
  if (record.original_kind === 'rule' || record.original_kind === 'scoped_grant') {
    return { ...(record.original_record.match || {}) };
  }
  return matchForToolGrant(record.tool_name, record.path_prefix);
}

function buildScopedGrant(toolName, match, authority, now) {
  const pathPrefix = match.path_prefix || null;
  const scope = { tool_name: toolName, match, authority };
  return {
    id: stableId('grant', scope), tool_name: toolName, path_prefix: pathPrefix,
    match: { ...match }, authority: { ...authority }, source: 'user', created_at: now,
  };
}

function reviewRule(record, decision) {
  if (record.original_kind === 'rule' || record.original_kind === 'scoped_grant') {
    return {
      id: stableId('reviewed', { pending_id: record.id, decision }),
      decision,
      match: { ...(record.original_record.match || {}) },
      reason: `Reviewed ${decision} decision for ${record.tool_name}`,
    };
  }
  const match = record.tool_name === '*' ? {} : { tool_id: record.tool_name };
  if (record.path_prefix) match.path_prefix = record.path_prefix;
  return {
    id: stableId('reviewed', { pending_id: record.id, decision }), decision, match,
    reason: `Reviewed ${decision} decision for ${record.tool_name}`,
  };
}

function commitDocument(instance, document) {
  if (instance._readOnlyReason) {
    throw new ToolPermissionStoreError(
      'permission_store_read_only',
      `Tool permission store is read-only: ${instance._readOnlyReason}`
    );
  }
  const validation = validatePermissionDocument(document);
  if (!validation.ok) {
    const capacityFailure = validation.reason === 'aggregate_rule_capacity_exceeded'
      || validation.reason === 'invalid_policies'
      || validation.reason === 'invalid_rules'
      || validation.reason === 'invalid_scoped_grants'
      || validation.reason === 'invalid_pending_review'
      || validation.reason === 'invalid_review_history';
    throw new ToolPermissionStoreError(
      capacityFailure ? 'permission_capacity_exceeded' : 'permission_document_invalid',
      `Tool permission update is invalid: ${validation.reason}`
    );
  }
  const validatedDocument = validation.document;
  if (Buffer.byteLength(JSON.stringify(validatedDocument), 'utf8') > MAX_PERMISSION_DOCUMENT_BYTES) {
    throw new ToolPermissionStoreError(
      'permission_capacity_exceeded',
      'Tool permission document exceeds its durable storage bound.'
    );
  }
  const result = instance._store.write(validatedDocument);
  if (!result || result.durable !== true) {
    throw new ToolPermissionStoreError(
      'permission_store_not_durable',
      'Tool permission update did not reach durable storage.'
    );
  }
  instance._document = validatedDocument;
  instance._snapshotCache = null;
}

function markReadOnly(instance, reason, details = {}) {
  instance._readOnlyReason = reason;
  if (!instance._logger) return;
  try {
    instance._logger('WARN', 'permission_store.read_only', { reason, ...details });
  } catch (_error) {
    // Logging must not weaken the fail-closed state.
  }
}

function permissionFileStatus(filePath) {
  try {
    return {
      oversized: fs.statSync(filePath).size > MAX_PERMISSION_DOCUMENT_BYTES,
      error: null,
    };
  } catch (error) {
    return error && error.code === 'ENOENT'
      ? { oversized: false, error: null }
      : { oversized: false, error };
  }
}

class ToolPermissionStore {
  constructor(filePath, options = {}) {
    this._logger = typeof options.logger === 'function' ? options.logger : null;
    this._store = new FileJsonStore(filePath, { logger: this._logger });
    this._document = createEmptyPermissionDocument();
    this._snapshotCache = null;
    this._readOnlyReason = null;
    this._blanketRuleRetired = false;
    this._retiredInspectDenySeen = false;
    const fileStatus = permissionFileStatus(filePath);
    if (fileStatus.oversized) {
      markReadOnly(this, 'document_too_large');
      return;
    }
    if (fileStatus.error) {
      markReadOnly(this, 'file_status_unavailable', { errorMessage: fileStatus.error.message });
      return;
    }
    const read = this._store.readWithStatus(null);
    if (read.corrupted) {
      markReadOnly(this, 'unreadable_or_corrupt', {
        errorCode: read.errorCode, errorMessage: read.errorMessage,
      });
      return;
    }
    if (read.missing) {
      try {
        commitDocument(this, this._document);
      } catch (error) {
        markReadOnly(this, 'initial_write_failed', { errorMessage: error.message });
      }
      return;
    }
    const migrated = migratePermissionDocument(read.value);
    if (!migrated.ok) {
      markReadOnly(this, migrated.reason || 'incompatible_document');
      return;
    }
    if (migrated.changed) {
      try {
        commitDocument(this, migrated.document);
      } catch (error) {
        markReadOnly(this, 'migration_write_failed', { errorMessage: error.message });
        return;
      }
      this._blanketRuleRetired = Boolean(migrated.notices?.blanket_rule_retired);
      this._retiredInspectDenySeen = Boolean(migrated.notices?.retired_inspect_deny_seen);
    } else {
      this._document = migrated.document;
    }
  }

  getDefaults() {
    return { ...DEFAULT_POLICIES };
  }

  getPolicy(toolName) {
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName || this._readOnlyReason) return undefined;
    return this._document.legacy_policies[normalizedName];
  }

  setPolicy(toolName, policy, authority) {
    if (!VALID_POLICIES.has(policy)) {
      throw new ToolPermissionStoreError(
        'permission_decision_invalid',
        `Invalid tool policy "${policy}". Must be one of: ${[...VALID_POLICIES].join(', ')}`
      );
    }
    const normalizedName = assertToolName(toolName);
    if (policy === 'auto') return this.grantAlwaysAllow(normalizedName, {}, authority);
    const next = cloneDocument(this._document);
    next.legacy_policies[normalizedName] = policy;
    commitDocument(this, next);
    return { decision: policy, toolName: normalizedName, scope: 'global' };
  }

  grantAlwaysAllow(toolName, input, authority) {
    const normalizedName = assertToolName(toolName);
    const normalizedAuthority = assertAuthority(authority);
    const pathPrefix = normalizedPathPrefix(input);
    const match = matchForToolGrant(normalizedName, pathPrefix);
    const grant = buildScopedGrant(
      normalizedName, match, normalizedAuthority, new Date().toISOString()
    );
    const existing = this._document.scoped_grants.find((item) => item.id === grant.id);
    if (!existing) {
      if (this._document.scoped_grants.length >= MAX_SCOPED_GRANT_COUNT) {
        throw new ToolPermissionStoreError(
          'permission_capacity_exceeded', 'Scoped permission grant capacity has been reached.'
        );
      }
      const next = cloneDocument(this._document);
      next.scoped_grants.push(grant);
      commitDocument(this, next);
    }
    return {
      scope: pathPrefix ? 'path' : 'tool', toolName: normalizedName,
      ...(pathPrefix ? { pathPrefix } : {}), ruleId: grant.id,
    };
  }

  getAllPolicies() {
    if (this._readOnlyReason) {
      return Object.fromEntries(Object.keys(DEFAULT_POLICIES).map((toolName) => [toolName, 'deny']));
    }
    return { ...DEFAULT_POLICIES, ...this._document.legacy_policies };
  }

  listStoredDecisions() {
    return {
      policies: { ...this._document.legacy_policies },
      rules: this._document.rules.map(copyRule),
      scoped_grants: cloneDocument(this._document.scoped_grants),
      pending_review: cloneDocument(this._document.pending_review),
      review_history: cloneDocument(this._document.review_history),
      read_only_reason: this._readOnlyReason,
    };
  }

  getReviewState() {
    return {
      read_only: Boolean(this._readOnlyReason), read_only_reason: this._readOnlyReason,
      pending_count: this._document.pending_review.length,
      pending: cloneDocument(this._document.pending_review),
      history: cloneDocument(this._document.review_history),
    };
  }

  resolvePendingReview(id, { decision, authority } = {}) {
    const pendingId = typeof id === 'string' ? id.trim() : '';
    if (!pendingId) {
      throw new ToolPermissionStoreError('permission_review_id_invalid', 'Review id is required.');
    }
    if (!REVIEW_DECISIONS.has(decision)) {
      throw new ToolPermissionStoreError(
        'permission_review_decision_invalid',
        'Review decision must be auto, ask, deny, or dismiss.'
      );
    }
    const record = this._document.pending_review.find((item) => item.id === pendingId);
    if (!record) {
      const history = this._document.review_history.find((item) => item.pending_id === pendingId);
      return history
        ? { resolved: false, reason: 'already_resolved', review: cloneDocument(history) }
        : { resolved: false, reason: 'not_found' };
    }
    if (this._document.review_history.length >= MAX_REVIEW_HISTORY_COUNT) {
      throw new ToolPermissionStoreError(
        'permission_capacity_exceeded', 'Permission review history capacity has been reached.'
      );
    }
    const next = cloneDocument(this._document);
    next.pending_review = next.pending_review.filter((item) => item.id !== pendingId);
    let scopedGrantId = null;
    if (decision === 'auto') {
      const normalizedAuthority = assertAuthority(authority);
      const match = matchForReviewedGrant(record);
      const grant = buildScopedGrant(
        record.tool_name, match, normalizedAuthority, new Date().toISOString()
      );
      scopedGrantId = grant.id;
      if (!next.scoped_grants.some((item) => item.id === grant.id)) {
        if (next.scoped_grants.length >= MAX_SCOPED_GRANT_COUNT) {
          throw new ToolPermissionStoreError(
            'permission_capacity_exceeded', 'Scoped permission grant capacity has been reached.'
          );
        }
        next.scoped_grants.push(grant);
      }
    } else if (GLOBAL_DECISIONS.has(decision)) {
      const rule = reviewRule(record, decision);
      if (Object.keys(rule.match).length === 1 && rule.match.tool_id && !record.path_prefix
        && record.original_kind === 'policy') {
        next.legacy_policies[record.tool_name] = decision;
      } else {
        if (next.rules.length >= MAX_RULE_COUNT) {
          throw new ToolPermissionStoreError(
            'permission_capacity_exceeded', 'Permission rule capacity has been reached.'
          );
        }
        next.rules.push(rule);
      }
    }
    const review = {
      pending_id: pendingId, decision, reviewed_at: new Date().toISOString(),
      scoped_grant_id: scopedGrantId, original_record: cloneDocument(record.original_record),
    };
    next.review_history.push(review);
    commitDocument(this, next);
    return { resolved: true, review: cloneDocument(review) };
  }

  clearPolicy(toolName) {
    const normalizedName = assertToolName(toolName);
    if (!Object.hasOwn(this._document.legacy_policies, normalizedName)) {
      return { cleared: false, toolName: normalizedName };
    }
    const next = cloneDocument(this._document);
    delete next.legacy_policies[normalizedName];
    commitDocument(this, next);
    return { cleared: true, toolName: normalizedName };
  }

  removeRule(ruleId) {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    if (!id) throw new ToolPermissionStoreError('permission_rule_id_invalid', 'Rule id is required.');
    const next = cloneDocument(this._document);
    const before = next.rules.length + next.scoped_grants.length;
    next.rules = next.rules.filter((rule) => rule.id !== id);
    next.scoped_grants = next.scoped_grants.filter((grant) => grant.id !== id);
    if (next.rules.length + next.scoped_grants.length === before) {
      return { removed: false, ruleId: id };
    }
    commitDocument(this, next);
    return { removed: true, ruleId: id };
  }

  consumeBlanketRuleRetiredNotice() {
    const retired = this._blanketRuleRetired;
    this._blanketRuleRetired = false;
    return retired;
  }

  consumeRetiredInspectDenyNotice() {
    const denySeen = this._retiredInspectDenySeen;
    this._retiredInspectDenySeen = false;
    return denySeen;
  }

  getSnapshot(authority) {
    if (this._readOnlyReason) return unavailableSnapshot();
    const hasAuthorityArgument = arguments.length > 0;
    const normalizedAuthority = hasAuthorityArgument ? normalizeAuthority(authority) : null;
    if (hasAuthorityArgument && !normalizedAuthority) return unavailableSnapshot();
    if (!normalizedAuthority && this._snapshotCache) return this._snapshotCache;
    const base = materializeLegacyDenyRules(this._document);
    if (!normalizedAuthority) {
      this._snapshotCache = base;
      return base;
    }
    return normalizePolicySnapshot({
      version: base.version,
      legacy_policies: base.legacy_policies,
      rules: [
        ...base.rules,
        ...this._document.scoped_grants
          .filter((grant) => authoritiesMatch(grant.authority, normalizedAuthority))
          .map(scopedGrantRule),
      ],
    });
  }
}

module.exports = {
  NEVER_PERSIST_ALWAYS_ALLOW,
  ToolPermissionStore,
  ToolPermissionStoreError,
  normalizeToolName,
};
