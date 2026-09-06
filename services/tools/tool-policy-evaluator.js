'use strict';

const {
  declaredAction,
  effectiveSideEffecting,
  isNonEmptyPlainObject,
} = require('./tool-policy-actions');
const crypto = require('node:crypto');
const path = require('node:path');

/**
 * Pure policy evaluator for tool execution decisions.
 *
 * Decision trace shape (consumed by sidecar/tool_execution and the renderer
 * policy surface):
 *
 *   {
 *     decision: 'auto' | 'ask' | 'deny',
 *     stage: 'hard_safety_deny' | 'user_deny' | 'user_allow' | 'user_ask' | 'tool_default',
 *     matched_rule_id: string | null,
 *     reason: string,
 *   }
 *
 * Rule-list precedence: deny beats auto beats ask, regardless of position in
 * the list. Hard safety denies are reserved for future expansion.
 */

const VALID_DECISIONS = new Set(['auto', 'ask', 'deny']);
const LEGACY_POLICY_DECISION_PRIORITY = Object.freeze({ auto: 1, ask: 2, deny: 3 });
const DELEGATE_COMPATIBILITY_TOOL_IDS = Object.freeze([
  'delegate',
  'subagent_run',
  'subagent_batch',
]);

const DEFAULT_TOOL_DEFAULTS = Object.freeze({
  exit_plan_mode: 'ask',
  read_file: 'auto',
  glob_files: 'auto',
  grep_search: 'auto',
  write_file: 'ask',
  edit_file: 'ask',
  run_command: 'ask',
  monitor: 'ask',
  create_artifact: 'ask',
  // Home writes only touch Jenny's own Home surfaces, every write is
  // attributed and one-click-undoable, and deletes self-gate behind an
  // explicit confirm round-trip; without this entry the non-read-only
  // descriptor falls through to 'ask'.
  home: 'auto',
  // `verify` executes shell, so its descriptor is honestly side-effecting —
  // but the model can only pick WHICH of the user's own saved Test Runner
  // configurations to run; it can never author or compose the command. That
  // bound is the safety argument, the same shape as `home` above. A gate that
  // prompted every turn would not be a gate, so the default is auto and stays
  // user-overridable through the normal per-tool policy rules.
  verify: 'auto',
  // `task_board`'s manifest declares per-action side_effecting (add/update/
  // complete: true, list: false), so without this scalar entry every
  // mutation would fall through to the side-effecting 'ask' default on every
  // call. Same safety argument as `home`: every write only touches the
  // user's own persisted Open Loops store, is badged `agent_task`, and stays
  // editable/deferrable/archivable/deletable through the existing follow-up
  // actions the user already controls. A user policy rule still overrides
  // this default in either direction.
  task_board: 'auto',
});

const DEFAULT_SAFETY_FOR_SIDE_EFFECTING = 'ask';
const DEFAULT_SAFETY_FOR_READ_ONLY = 'auto';
const MAX_POLICY_REASON_CHARS = 240;
const MAX_POLICY_ID_CHARS = 80;
const MAX_POLICY_VERSION = 1_000_000;
const MAX_LEGACY_POLICY_COUNT = 1_000;
const MAX_POLICY_RULE_COUNT = 1_000;
const MAX_POLICY_TOOL_NAME_CHARS = 160;
const MAX_POLICY_MATCH_TEXT_CHARS = 1_024;
const MAX_POLICY_MODE_VALUES = 16;
const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:($|[\\/])/;
const UNC_PATH_RE = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;
const POLICY_SECRET_VALUE_RE = /\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,})\b/giu;
const POLICY_AUTH_ASSIGNMENT_RE = /(?:authorization|api[_-]?key|x-api-key|token|secret|password)\s*[:=]\s*["']?[^"',\s}]{8,}/giu;
const POLICY_PROMPT_INJECTION_RE = /ignore\s+all\s+previous\s+instructions/giu;
const NORMALIZED_POLICY_RULES = new WeakSet();

function freezeRule(rule) {
  const match = { ...(rule.match || {}) };
  if (match.action === null) {
    Object.defineProperty(match, 'action', { value: null, enumerable: false });
  }
  const frozenRule = Object.freeze({ ...rule, match: Object.freeze(match) });
  NORMALIZED_POLICY_RULES.add(frozenRule);
  return frozenRule;
}

/**
 * Normalize an incoming snapshot payload (either a legacy flat map or the
 * new {legacy_policies, rules, version} shape) into a stable internal
 * representation. Always succeeds; malformed entries are silently dropped.
 */
function normalizePolicySnapshot(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    return Object.freeze({
      version: 1,
      legacy_policies: Object.freeze({}),
      rules: Object.freeze([]),
    });
  }

  const isLegacyFlatMap =
    !Array.isArray(rawSnapshot) &&
    !('legacy_policies' in rawSnapshot) &&
    !('rules' in rawSnapshot);

  if (isLegacyFlatMap) {
    return Object.freeze({
      version: 1,
      legacy_policies: Object.freeze(canonicalizeLegacyMap(rawSnapshot)),
      rules: Object.freeze([]),
    });
  }

  const legacyMap = canonicalizeLegacyMap(rawSnapshot.legacy_policies || {});
  const rules = normalizeRuleList(rawSnapshot.rules);
  return Object.freeze({
    version: normalizePolicyVersion(rawSnapshot.version),
    legacy_policies: Object.freeze(legacyMap),
    rules: Object.freeze(rules),
  });
}

function normalizePolicyVersion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return 1;
  }
  return Math.min(Math.trunc(numeric), MAX_POLICY_VERSION);
}

function canonicalizeLegacyMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') {
    return out;
  }
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const decision = value[key];
    if (typeof key !== 'string' || !key.trim()) continue;
    if (!VALID_DECISIONS.has(decision)) continue;
    const normalizedName = boundedPolicyText(key, MAX_POLICY_TOOL_NAME_CHARS, '');
    if (!normalizedName) continue;
    out[normalizedName] = decision;
    count += 1;
    if (count >= MAX_LEGACY_POLICY_COUNT) {
      break;
    }
  }
  return out;
}

function normalizeRuleList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const entry of value) {
    if (NORMALIZED_POLICY_RULES.has(entry)) {
      out.push(entry);
      if (out.length >= MAX_POLICY_RULE_COUNT) break;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const decision = entry.decision;
    if (!VALID_DECISIONS.has(decision)) continue;
    const id = boundedPolicyMetadataText(entry.id, MAX_POLICY_ID_CHARS, '');
    if (!id) continue;
    const match = entry.match && typeof entry.match === 'object' ? entry.match : {};
    const actionValue = match.action;
    let action = null;
    if (actionValue !== undefined) {
      if (typeof actionValue !== 'string') continue;
      action = boundedPolicyText(actionValue, MAX_POLICY_TOOL_NAME_CHARS, '');
      if (!action) continue;
    }
    out.push(
      freezeRule({
        id,
        decision,
          reason: boundedPolicyMetadataText(entry.reason, MAX_POLICY_REASON_CHARS, 'Rule matched'),
        match: {
          tool_id: normalizeOptionalMatchText(match.tool_id, MAX_POLICY_TOOL_NAME_CHARS),
          action,
          tool_family: normalizeOptionalMatchText(match.tool_family, 80),
          source_kind: normalizeOptionalMatchText(match.source_kind, 80),
          mode: normalizePolicyModeList(match.mode),
          path_prefix: normalizeOptionalMatchText(match.path_prefix, MAX_POLICY_MATCH_TEXT_CHARS),
          mcp_server: normalizeOptionalMatchText(match.mcp_server, MAX_POLICY_TOOL_NAME_CHARS),
        },
      })
    );
    if (out.length >= MAX_POLICY_RULE_COUNT) {
      break;
    }
  }
  return out;
}

function normalizeOptionalMatchText(value, limit) {
  if (typeof value !== 'string') {
    return null;
  }
  return boundedPolicyText(value, limit, '') || null;
}

function normalizePolicyModeList(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = [];
  for (const entry of value) {
    const mode = normalizeOptionalMatchText(entry, 80);
    if (!mode || out.includes(mode)) {
      continue;
    }
    out.push(mode);
    if (out.length >= MAX_POLICY_MODE_VALUES) {
      break;
    }
  }
  return out.length ? out : null;
}

/**
 * Evaluate a tool call against a normalized policy snapshot.
 *
 * @param {object} context
 * @param {{name:string, side_effecting?:boolean, read_only?:boolean, tool_family?:string, source_kind?:string, server_name?:string, actions?:object}} context.descriptor
 * @param {object} [context.args] - parsed tool arguments (path fields used by path_prefix rules)
 * @param {string} [context.mode] - current safety mode ('chat', 'assist', 'autonomous', ...)
 * @param {object} context.snapshot - already-normalized policy snapshot
 * @returns {{decision: 'auto'|'ask'|'deny', stage: string, matched_rule_id: string|null, reason: string}}
 */
function evaluatePolicy({ descriptor, args = {}, mode = '', snapshot }) {
  const normalizedSnapshot = normalizePolicySnapshot(snapshot);
  const action = declaredAction(descriptor, args);
  const hasActions = isNonEmptyPlainObject(descriptor && descriptor.actions);
  const unresolvable = hasActions && !action;

  if (!descriptor || typeof descriptor.name !== 'string') {
    return buildPolicyDecision({
      descriptor: descriptor || {},
      snapshot: normalizedSnapshot,
      mode,
      decision: 'ask',
      stage: 'hard_safety_deny',
      matched_rule_id: null,
      reason: 'descriptor missing name; refusing without explicit consent',
    });
  }

  const ruleHit = firstRuleHit(normalizedSnapshot.rules, { descriptor, args, mode });
  if (ruleHit && (!unresolvable || ruleHit.decision === 'deny')) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: ruleHit.decision,
      stage: RULE_HIT_STAGE[ruleHit.decision],
      matched_rule_id: ruleHit.id,
      reason: ruleHit.reason,
    });
  }

  const legacy = legacyPolicyForDescriptor(
    normalizedSnapshot.legacy_policies,
    descriptor.name,
    unresolvable ? '' : action
  );
  if (legacy && (!unresolvable || legacy.decision === 'deny')) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: legacy.decision,
      stage: 'tool_default',
      matched_rule_id: null,
      reason: `legacy per-tool policy: ${legacy.toolName}=${legacy.decision}`,
    });
  }

  const actionDefaultName = action ? `${descriptor.name}:${action}` : '';
  const actionDefault = unresolvable ? undefined : DEFAULT_TOOL_DEFAULTS[actionDefaultName];
  if (actionDefault) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: actionDefault,
      stage: 'tool_default',
      matched_rule_id: null,
      reason: `built-in default for ${actionDefaultName}`,
    });
  }

  // A declared read action is auto because of its action-level contract, even
  // when the mixed tool has a scalar built-in default for its write actions.
  // Keeping this ahead of the whole-tool fallback preserves that distinction
  // in policy diagnostics and decision fingerprints without overriding a more
  // specific action default.
  if (!unresolvable && action && effectiveSideEffecting(descriptor, args) === false) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: DEFAULT_SAFETY_FOR_READ_ONLY,
      stage: 'tool_default',
      matched_rule_id: null,
      reason: 'read-only action defaults to auto',
    });
  }

  const fallbackDefaultName = descriptor.name;
  const fallbackDefault = unresolvable ? undefined : DEFAULT_TOOL_DEFAULTS[fallbackDefaultName];
  if (fallbackDefault) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: fallbackDefault,
      stage: 'tool_default',
      matched_rule_id: null,
      reason: `built-in default for ${fallbackDefaultName}`,
    });
  }

  if (!unresolvable && !action && descriptor.read_only === true) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: DEFAULT_SAFETY_FOR_READ_ONLY,
      stage: 'tool_default',
      matched_rule_id: null,
      reason: 'read-only tool defaults to auto',
    });
  }

  if (!unresolvable && (action || descriptor.side_effecting === true)) {
    return buildPolicyDecision({
      descriptor,
      snapshot: normalizedSnapshot,
      mode,
      decision: DEFAULT_SAFETY_FOR_SIDE_EFFECTING,
      stage: 'tool_default',
      matched_rule_id: null,
      reason: 'side-effecting tool defaults to ask',
    });
  }

  return buildPolicyDecision({
    descriptor,
    snapshot: normalizedSnapshot,
    mode,
    decision: 'ask',
    stage: 'tool_default',
    matched_rule_id: null,
    reason: unresolvable
      ? 'action not declared by tool; failing closed to ask'
      : 'no policy rule matched and no descriptor default; defaulting to ask',
  });
}


function buildPolicyDecision({
  descriptor = {},
  snapshot,
  mode = '',
  decision,
  stage,
  matched_rule_id: matchedRuleId,
  reason,
}) {
  const normalizedSnapshot = normalizePolicySnapshot(snapshot);
  const payload = normalizePolicyDecisionPayload({
    descriptor,
    mode,
    decision,
    stage,
    matchedRuleId,
    reason,
    snapshotVersion: normalizedSnapshot.version,
  });
  return Object.freeze({
    ...payload,
    id: buildPolicyDecisionId(payload),
  });
}

function normalizePolicyDecisionPayload({
  descriptor = {},
  mode = '',
  decision,
  stage,
  matchedRuleId,
  reason,
  snapshotVersion,
}) {
  return {
    decision: VALID_DECISIONS.has(decision) ? decision : 'ask',
    stage: boundedPolicyText(stage, 80, 'tool_default'),
    matched_rule_id: boundedPolicyMetadataText(matchedRuleId, MAX_POLICY_ID_CHARS, '') || null,
    reason: boundedPolicyMetadataText(reason, MAX_POLICY_REASON_CHARS, 'Policy matched'),
    snapshot_version: normalizePolicyVersion(snapshotVersion),
    tool_name: boundedPolicyText(descriptor.name, MAX_POLICY_TOOL_NAME_CHARS, ''),
    tool_family: boundedPolicyText(descriptor.tool_family, 80, ''),
    source_kind: boundedPolicyText(descriptor.source_kind, 80, ''),
    mode: boundedPolicyText(mode, 80, ''),
  };
}

function buildPolicyDecisionId(decision) {
  const payload = [
    decision.snapshot_version,
    decision.tool_name,
    decision.tool_family,
    decision.source_kind,
    decision.mode,
    decision.decision,
    decision.stage,
    decision.matched_rule_id || '',
    decision.reason,
  ].join('|');
  return `policy_${crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16)}`;
}

function buildPolicyDecisionMetadata(decision) {
  if (!decision || typeof decision !== 'object') {
    return null;
  }
  const payload = normalizePolicyDecisionPayload({
    descriptor: {
      name: decision.tool_name,
      tool_family: decision.tool_family,
      source_kind: decision.source_kind,
    },
    mode: decision.mode,
    decision: decision.decision,
    stage: decision.stage,
    matchedRuleId: decision.matched_rule_id,
    reason: decision.reason,
    snapshotVersion: decision.snapshot_version,
  });
  return {
    id: buildPolicyDecisionId(payload),
    ...payload,
  };
}

function boundedPolicyText(value, limit, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, limit);
}

function sanitizePolicyMetadataText(value) {
  return String(value || '')
    .replace(POLICY_AUTH_ASSIGNMENT_RE, (match) => {
      const separator = match.includes('=') ? '=' : ':';
      const key = match.split(separator)[0].trim();
      return `${key}${separator}[redacted-secret]`;
    })
    .replace(POLICY_SECRET_VALUE_RE, '[redacted-secret]')
    .replace(POLICY_PROMPT_INJECTION_RE, '[redacted-instruction]');
}

function boundedPolicyMetadataText(value, limit, fallback) {
  const text = sanitizePolicyMetadataText(String(value ?? '').replace(/\s+/g, ' ').trim());
  if (!text) {
    return fallback;
  }
  return text.slice(0, limit);
}

const RULE_HIT_STAGE = Object.freeze({
  deny: 'user_deny',
  auto: 'user_allow',
  ask: 'user_ask',
});

function firstRuleHit(rules, context) {
  let firstAuto = null;
  let firstAsk = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, context)) continue;
    if (rule.decision === 'deny') return rule;
    if (rule.decision === 'auto' && firstAuto === null) firstAuto = rule;
    else if (rule.decision === 'ask' && firstAsk === null) firstAsk = rule;
  }
  return firstAuto || firstAsk;
}

function policyToolIdsForDescriptor(descriptorName) {
  return descriptorName === 'delegate'
    ? DELEGATE_COMPATIBILITY_TOOL_IDS
    : [descriptorName];
}

function policyToolIdMatchesDescriptor(policyToolId, descriptorName) {
  return policyToolIdsForDescriptor(descriptorName).includes(policyToolId);
}

function legacyPolicyForDescriptor(legacyPolicies, descriptorName, action = '') {
  let selected = null;
  if (action && !descriptorName.includes(':')) {
    for (const toolName of policyToolIdsForDescriptor(descriptorName)) {
      const compositeName = `${toolName}:${action}`;
      const decision = legacyPolicies[compositeName];
      if (!VALID_DECISIONS.has(decision)) continue;
      if (
        selected === null
        || LEGACY_POLICY_DECISION_PRIORITY[decision]
          > LEGACY_POLICY_DECISION_PRIORITY[selected.decision]
      ) {
        selected = { toolName: compositeName, decision };
      }
    }
    if (selected !== null) {
      return selected;
    }
  }
  for (const toolName of policyToolIdsForDescriptor(descriptorName)) {
    const decision = legacyPolicies[toolName];
    if (!VALID_DECISIONS.has(decision)) continue;
    if (
      selected === null
      || LEGACY_POLICY_DECISION_PRIORITY[decision]
        > LEGACY_POLICY_DECISION_PRIORITY[selected.decision]
    ) {
      selected = { toolName, decision };
    }
  }
  return selected;
}

function ruleMatches(rule, { descriptor, args, mode }) {
  const m = rule.match;
  if (m.tool_id && !policyToolIdMatchesDescriptor(m.tool_id, descriptor.name)) return false;
  // Electron-authored rules are scoped by tool_id; matching uses the raw call argument.
  if (m.action && m.action !== String(args.action || '')) return false;
  if (m.tool_family && m.tool_family !== (descriptor.tool_family || '')) return false;
  if (m.source_kind && m.source_kind !== (descriptor.source_kind || '')) return false;
  if (m.mcp_server && m.mcp_server !== (descriptor.server_name || '')) return false;
  if (m.mode && m.mode.length > 0) {
    if (!mode || !m.mode.includes(mode)) return false;
  }
  if (m.path_prefix) {
    const pathArg = String(args.file_path || args.path || '').trim();
    if (!pathPrefixMatches(pathArg, m.path_prefix)) return false;
  }
  return true;
}

function pathPrefixMatches(pathValue, prefixValue) {
  const rawPath = String(pathValue || '').trim();
  const rawPrefix = String(prefixValue || '').trim();
  if (!rawPath || !rawPrefix) return false;

  const windowsLike = isWindowsLikePolicyPath(rawPath) || isWindowsLikePolicyPath(rawPrefix);
  const normalizedPath = normalizePolicyPathForMatch(rawPath, windowsLike);
  const normalizedPrefix = normalizePolicyPathForMatch(rawPrefix, windowsLike);
  if (!normalizedPath || !normalizedPrefix) return false;
  return (
    normalizedPath === normalizedPrefix ||
    isRootPolicyPrefix(normalizedPrefix) && normalizedPath.startsWith(normalizedPrefix) ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

function isRootPolicyPrefix(value) {
  return value === '/' || /^[a-z]:\/$/i.test(value);
}

function isWindowsLikePolicyPath(value) {
  return (
    value.includes('\\') ||
    WINDOWS_DRIVE_PATH_RE.test(value) ||
    UNC_PATH_RE.test(value)
  );
}

function normalizePolicyPathForMatch(value, windowsLike) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (windowsLike && /^[a-zA-Z]:$/.test(raw)) {
    return `${raw.toLowerCase()}/`;
  }
  const normalized = windowsLike
    ? path.win32.normalize(raw).replace(/\\/g, '/').toLowerCase()
    : path.posix.normalize(raw.replace(/\\/g, '/'));
  return stripTrailingPolicySeparators(normalized);
}

function stripTrailingPolicySeparators(value) {
  let out = value;
  while (
    out.length > 1 &&
    out.endsWith('/') &&
    !/^[a-z]:\/$/i.test(out)
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

module.exports = {
  buildPolicyDecision,
  buildPolicyDecisionMetadata,
  DEFAULT_TOOL_DEFAULTS,
  evaluatePolicy,
  normalizePolicySnapshot,
};
