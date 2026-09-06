'use strict';

const { createHash } = require('node:crypto');
const { FileJsonStore } = require('../backend/file-json-store');
const { normalizePolicySnapshot } = require('./tool-policy-evaluator');

// Keep path grants within the evaluator's MAX_POLICY_MATCH_TEXT_CHARS bound.
const MAX_ALWAYS_ALLOW_PATH_CHARS = 1_024;

const TOOL_NAME_ALIASES = Object.freeze({
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Glob: 'glob_files',
  Grep: 'grep_search',
  Bash: 'run_command',
  CreateArtifact: 'create_artifact',
});

const DEFAULT_POLICIES = {
  read_file: 'auto',
  glob_files: 'auto',
  grep_search: 'auto',
  write_file: 'ask',
  edit_file: 'ask',
  run_command: 'ask',
  create_artifact: 'ask',
};

const VALID_POLICIES = new Set(['auto', 'ask', 'deny']);

const NEVER_PERSIST_ALWAYS_ALLOW = Object.freeze(new Set([
  'exit_plan_mode',
]));

const RETIRED_TOOL_NAMES = Object.freeze(new Set([
  'browser_click',
  'browser_close',
  'browser_eval',
  'browser_open',
  'browser_screenshot',
  'browser_type',
  'apply_patch',
  'document_inspect',
  'image_inspect',
  'notebook_inspect',
  'pdf_inspect',
  'presentation_inspect',
  'spreadsheet_inspect',
]));

const RETIRED_INSPECT_TOOL_NAMES = Object.freeze(new Set([
  'document_inspect',
  'image_inspect',
  'notebook_inspect',
  'pdf_inspect',
  'presentation_inspect',
  'spreadsheet_inspect',
]));

const TOOL_GRANT_NAME_MIGRATIONS = Object.freeze({
  lsp_diagnostics: 'lsp:diagnostics',
  lsp_symbols: 'lsp:symbols',
  lsp_definition: 'lsp:definition',
  lsp_references: 'lsp:references',
});

function migratedToolGrantName(toolName) {
  if (
    typeof toolName !== 'string'
    || !Object.prototype.hasOwnProperty.call(TOOL_GRANT_NAME_MIGRATIONS, toolName)
  ) {
    return null;
  }
  return TOOL_GRANT_NAME_MIGRATIONS[toolName];
}

// Legacy rule id retained only for one-time removal and the inert
// compatibility setter. New approval grants are transient per send.
const BLANKET_AUTO_APPROVE_RULE_ID = 'blanket_auto_approve';

// Synthetic rule-id prefix for legacy per-tool deny entries materialized into
// the snapshot (see getSnapshot). Never persisted.
const LEGACY_DENY_RULE_ID_PREFIX = 'legacy_deny:';

function normalizeToolName(toolName) {
  const token = String(toolName || '').trim();
  if (!token) {
    return '';
  }
  return Object.prototype.hasOwnProperty.call(TOOL_NAME_ALIASES, token)
    ? TOOL_NAME_ALIASES[token]
    : token;
}

function validateCompositeToolName(toolName) {
  const separatorIndex = toolName.indexOf(':');
  if (separatorIndex === -1) {
    return;
  }
  const toolSegment = toolName.slice(0, separatorIndex);
  const actionSegment = toolName.slice(separatorIndex + 1);
  const actionCharacters = [...actionSegment];
  const actionHasInvalidCharacter = actionCharacters.some((character) => (
    /\s/.test(character)
    || character.codePointAt(0) < 0x20
    || character === '\x7f'
  ));
  if (
    !toolSegment
    || !actionSegment
    || actionCharacters.length > 64
    || actionSegment.includes(':')
    || actionHasInvalidCharacter
  ) {
    throw new Error('Invalid composite tool name. Must match "tool:action" with a 1-64 character action.');
  }
}

function canonicalizePolicies(policies) {
  const normalized = {};
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
    return normalized;
  }
  for (const [toolName, policy] of Object.entries(policies)) {
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName || !VALID_POLICIES.has(policy)) {
      continue;
    }
    normalized[normalizedName] = policy;
  }
  return normalized;
}

function isRuleListPolicyDocument(raw) {
  return (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    ('legacy_policies' in raw || 'rules' in raw)
  );
}

function normalizeStoredPolicyDocument(raw) {
  if (!isRuleListPolicyDocument(raw)) {
    return normalizePolicySnapshot({
      version: 1,
      legacy_policies: canonicalizePolicies(raw),
      rules: [],
    });
  }

  return normalizePolicySnapshot({
    version: raw && raw.version,
    legacy_policies: canonicalizePolicies(
      raw && typeof raw === 'object' ? raw.legacy_policies : {}
    ),
    rules: Array.isArray(raw && raw.rules) ? raw.rules : [],
  });
}

/**
 * Materialize legacy per-tool `deny` entries as synthetic deny rules so they
 * keep winning against any rule-list auto decision (rule hits outrank the
 * legacy map in both evaluators, and deny rules outrank auto rules). Applied
 * only to the evaluated/serialized snapshot — never written back to disk, so
 * clearing the legacy entry clears the synthetic rule with it.
 */
function materializeLegacyDenyRules(snapshot) {
  const denyTools = Object.entries(snapshot.legacy_policies)
    .filter(([, decision]) => decision === 'deny')
    .map(([toolName]) => toolName);
  if (!denyTools.length) {
    return snapshot;
  }
  return normalizePolicySnapshot({
    version: snapshot.version,
    legacy_policies: snapshot.legacy_policies,
    rules: [
      ...snapshot.rules,
      // Deny rules win regardless of list position, so appending keeps the
      // stored rules' indices stable for callers that inspect the snapshot.
      ...denyTools.map((toolName) => ({
        id: `${LEGACY_DENY_RULE_ID_PREFIX}${toolName}`,
        decision: 'deny',
        match: { tool_id: toolName },
        reason: `Per-tool deny for ${toolName}`,
      })),
    ],
  });
}

class ToolPermissionStore {
  constructor(filePath, options = {}) {
    this._store = new FileJsonStore(filePath, {
      logger: typeof options.logger === 'function' ? options.logger : null,
    });
    // Cache the normalized snapshot because policy is evaluated twice per tool
    // call. This store is the sole writer, so mutations invalidate it below.
    this._snapshotCache = null;
    this._blanketRuleRetired = false;
    this._retiredInspectDenySeen = false;
    this._retirePersistedBlanketRule();
    this._pruneRetiredToolGrants();
    this._migrateToolGrantNames();
  }

  _retirePersistedBlanketRule() {
    const raw = this._store.read({});
    if (!isRuleListPolicyDocument(raw) || !Array.isArray(raw.rules)) {
      return;
    }
    const rules = raw.rules.filter((rule) => rule?.id !== BLANKET_AUTO_APPROVE_RULE_ID);
    if (rules.length === raw.rules.length) {
      return;
    }
    const snapshot = normalizeStoredPolicyDocument({ ...raw, rules });
    this._store.write({
      version: snapshot.version,
      legacy_policies: { ...snapshot.legacy_policies },
      rules: [...snapshot.rules],
    });
    this._blanketRuleRetired = true;
  }

  _pruneRetiredToolGrants() {
    const snapshot = normalizeStoredPolicyDocument(this._store.read({}));
    const legacyPolicies = {};
    let dropped = false;
    let retiredInspectDenySeen = false;

    for (const [toolName, decision] of Object.entries(snapshot.legacy_policies)) {
      if (!RETIRED_TOOL_NAMES.has(toolName)) {
        legacyPolicies[toolName] = decision;
        continue;
      }
      dropped = true;
      if (decision === 'deny' && RETIRED_INSPECT_TOOL_NAMES.has(toolName)) {
        retiredInspectDenySeen = true;
      }
    }

    const rules = snapshot.rules.filter((rule) => {
      const toolName = rule?.match?.tool_id;
      if (!RETIRED_TOOL_NAMES.has(toolName)) {
        return true;
      }
      dropped = true;
      if (rule.decision === 'deny' && RETIRED_INSPECT_TOOL_NAMES.has(toolName)) {
        retiredInspectDenySeen = true;
      }
      return false;
    });

    if (!dropped) {
      return;
    }
    this._store.write({
      version: snapshot.version,
      legacy_policies: legacyPolicies,
      rules,
    });
    this._snapshotCache = null;
    this._retiredInspectDenySeen = retiredInspectDenySeen;
  }

  _migrateToolGrantNames() {
    const snapshot = normalizeStoredPolicyDocument(this._store.read({}));
    const legacyPolicies = {};
    let changed = false;

    for (const [toolName, decision] of Object.entries(snapshot.legacy_policies)) {
      const mappedName = migratedToolGrantName(toolName);
      const migratedName = mappedName || toolName;
      if (mappedName) {
        validateCompositeToolName(migratedName);
        changed = true;
      }
      const existingDecision = legacyPolicies[migratedName];
      if (
        existingDecision === undefined
        || decision === 'deny'
        || (decision === 'ask' && existingDecision === 'auto')
      ) {
        legacyPolicies[migratedName] = decision;
      }
    }

    const rules = snapshot.rules.map((rule) => {
      const toolName = rule?.match?.tool_id;
      const migratedName = migratedToolGrantName(toolName);
      if (!migratedName) {
        return rule;
      }
      validateCompositeToolName(migratedName);
      changed = true;
      return {
        ...rule,
        match: { ...rule.match, tool_id: migratedName },
      };
    });

    if (!changed) {
      return;
    }
    this._store.write({
      version: snapshot.version,
      legacy_policies: legacyPolicies,
      rules,
    });
    this._snapshotCache = null;
  }

  getDefaults() {
    return { ...DEFAULT_POLICIES };
  }

  getPolicy(toolName) {
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName) {
      return undefined;
    }
    return this.getSnapshot().legacy_policies[normalizedName];
  }

  setPolicy(toolName, policy) {
    if (!VALID_POLICIES.has(policy)) {
      throw new Error(`Invalid tool policy "${policy}". Must be one of: ${[...VALID_POLICIES].join(', ')}`);
    }
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName) {
      throw new Error('Tool name is required.');
    }
    validateCompositeToolName(normalizedName);
    const raw = this._store.read({});
    if (isRuleListPolicyDocument(raw)) {
      const snapshot = normalizeStoredPolicyDocument(raw);
      this._store.write({
        version: snapshot.version,
        legacy_policies: {
          ...snapshot.legacy_policies,
          [normalizedName]: policy,
        },
        rules: Array.isArray(snapshot.rules) ? snapshot.rules : [],
      });
      this._snapshotCache = null;
      return;
    }

    const data = canonicalizePolicies(raw);
    data[normalizedName] = policy;
    this._store.write(data);
    this._snapshotCache = null;
  }

  grantAlwaysAllow(toolName, input) {
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName) {
      throw new Error('Tool name is required.');
    }
    validateCompositeToolName(normalizedName);

    const toolInput = input && typeof input === 'object' ? input : {};
    const pathPrefix = String(toolInput.path ?? toolInput.file_path ?? '')
      .trim()
      .slice(0, MAX_ALWAYS_ALLOW_PATH_CHARS);
    if (!pathPrefix) {
      this.setPolicy(normalizedName, 'auto');
      return { scope: 'tool', toolName: normalizedName };
    }

    const pathHash = createHash('sha256').update(pathPrefix).digest('hex').slice(0, 12);
    const rule = {
      id: `always-allow:${normalizedName}:${pathHash}`,
      decision: 'auto',
      match: { tool_id: normalizedName, path_prefix: pathPrefix },
      reason: `Always allow ${normalizedName} for ${pathPrefix} (approved in chat)`,
    };
    const snapshot = normalizeStoredPolicyDocument(this._store.read({}));
    if (!snapshot.rules.some((storedRule) => storedRule.id === rule.id)) {
      this._store.write({
        version: snapshot.version,
        legacy_policies: { ...snapshot.legacy_policies },
        rules: [...snapshot.rules, rule],
      });
      this._snapshotCache = null;
    }
    return {
      scope: 'path',
      toolName: normalizedName,
      pathPrefix,
      ruleId: rule.id,
    };
  }

  getAllPolicies() {
    return {
      ...DEFAULT_POLICIES,
      ...this.getSnapshot().legacy_policies,
    };
  }

  /**
   * The user's own saved decisions, for Settings > Tools > Approval rules:
   * the stored per-tool policies (NOT merged with defaults) and the stored
   * rule list. Reads the stored document rather than getSnapshot() because
   * the synthetic legacy-deny rules are a presentation of the per-tool map,
   * not rows of their own.
   */
  listStoredDecisions() {
    const snapshot = normalizeStoredPolicyDocument(this._store.read({}));
    return {
      policies: { ...snapshot.legacy_policies },
      rules: snapshot.rules.map((rule) => ({
        id: rule.id,
        decision: rule.decision,
        reason: rule.reason,
        match: { ...rule.match },
      })),
    };
  }

  // Drop a stored per-tool policy so the tool falls back to its default (the
  // manifest's side-effect metadata decides when DEFAULT_POLICIES has no entry).
  clearPolicy(toolName) {
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName) {
      throw new Error('Tool name is required.');
    }
    const snapshot = normalizeStoredPolicyDocument(this._store.read({}));
    if (!Object.prototype.hasOwnProperty.call(snapshot.legacy_policies, normalizedName)) {
      return { cleared: false, toolName: normalizedName };
    }
    const legacyPolicies = { ...snapshot.legacy_policies };
    delete legacyPolicies[normalizedName];
    this._store.write({
      version: snapshot.version,
      legacy_policies: legacyPolicies,
      rules: [...snapshot.rules],
    });
    this._snapshotCache = null;
    return { cleared: true, toolName: normalizedName };
  }

  removeRule(ruleId) {
    const id = String(ruleId || '').trim();
    if (!id) {
      throw new Error('Rule id is required.');
    }
    const snapshot = normalizeStoredPolicyDocument(this._store.read({}));
    const rules = snapshot.rules.filter((rule) => rule.id !== id);
    if (rules.length === snapshot.rules.length) {
      return { removed: false, ruleId: id };
    }
    this._store.write({
      version: snapshot.version,
      legacy_policies: { ...snapshot.legacy_policies },
      rules,
    });
    this._snapshotCache = null;
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

  /**
   * Return an immutable snapshot suitable for the pure policy evaluator and
   * for serializing into the sidecar RuntimeConfig. Accepts both the legacy
   * flat-map persistence format and the future {legacy_policies, rules,
   * version} shape so a single store file works during the transition.
   */
  getSnapshot() {
    if (this._snapshotCache) {
      return this._snapshotCache;
    }
    const snapshot = materializeLegacyDenyRules(
      normalizeStoredPolicyDocument(this._store.read({}))
    );
    this._snapshotCache = snapshot;
    return snapshot;
  }
}

module.exports = {
  NEVER_PERSIST_ALWAYS_ALLOW,
  ToolPermissionStore,
  normalizeToolName,
};
