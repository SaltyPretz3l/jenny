'use strict';

const { isSessionOfflineLockdownActive } = require('../backend/session-lockdown-gate');
const toolManifest = require('../tools/tool-manifest.json');

const PHONE_OK = 'phone_ok';
const DESKTOP_ONLY = 'desktop_only';

const DECISION_OPTIONS = Object.freeze({
  tool: Object.freeze(['approve_once', 'deny']),
  question: Object.freeze(['answer', 'decline']),
  plan: Object.freeze(['approve', 'revise']),
});

// Tools whose approvals never leave the desktop in v1. Approval records carry
// only free-text `reason`/`policyConsequence` copy, so the tool name is the only
// machine-readable evidence of the decision class: file-safety (delete/move),
// local command execution (destructive-shell approvals are a subset of
// run_command and cannot be told apart from the record), and arbitrary code.
const DESKTOP_ONLY_TOOLS = Object.freeze([
  'delete_file',
  'move_file',
  'run_command',
  'run_temp_script',
  'python_execute',
  'worktree_delete',
]);
const DESKTOP_ONLY_TOOL_SET = new Set(DESKTOP_ONLY_TOOLS);
const MANIFEST_TOOL_IDS = new Set(
  (Array.isArray(toolManifest.tools) ? toolManifest.tools : [])
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean)
);
const PHONE_ONE_OFF_TOOLS = Object.freeze(
  [...MANIFEST_TOOL_IDS].filter((name) => !DESKTOP_ONLY_TOOL_SET.has(name)).sort()
);
const PHONE_ONE_OFF_TOOL_SET = new Set(PHONE_ONE_OFF_TOOLS);

const FORBIDDEN_BACKEND_OPTIONS = Object.freeze([
  'alwaysAllow',
  'approved_auto',
  'plan',
  'toolPreferences',
  'approvalMode',
  'debugOptions',
  'attachments',
  'mentionContents',
  'activeFileContext',
  'interactiveResponse',
  'pluginCommandInvocation',
  'skillInvocation',
  'editedMessageId',
  'failureRetry',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object'
    || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null
    && typeof prototype.constructor === 'function'
    && prototype.constructor.name === 'Object');
}

function canListSession(session, featureFlags) {
  return Boolean(session)
    && !isSessionOfflineLockdownActive(featureFlags, session)
    && session.session_type === 'chat'
    && !session.archived_at;
}

function canReadSession(session, featureFlags, shareGrant) {
  return canListSession(session, featureFlags)
    && shareGrant?.session_id === session.id;
}

function canSend(session, featureFlags, lease, deviceId) {
  return canReadSession(session, featureFlags, lease)
    && lease?.device_id === deviceId
    && lease?.session_id === session.id;
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// `pending` is the decision adapter's NORMALIZED shape built from live backend
// state (never from phone-supplied fields):
//   toolName       non-empty string
//   factsComplete  true only when every fact the phone will see (tool name,
//                  bounded input summary, scope, consequence) is complete and
//                  representable; truncation or missing metadata => false
//   authority      'one_off' when the pending decision is an ordinary one-off
//                  tool/plan approval; 'desktop_only' for file-safety and
//                  destructive classes, plan edits, always-allow scopes, and
//                  anything the adapter cannot classify
// `policyConsequence`/`policyScope` are display text and carry no authority.
// Anything short of affirmative evidence stays on desktop.
function classifyDecision(pending) {
  if (!isPlainObject(pending) || !hasNonEmptyString(pending.toolName)) return DESKTOP_ONLY;
  if (pending.factsComplete !== true) return DESKTOP_ONLY;
  return pending.authority === 'one_off' ? PHONE_OK : DESKTOP_ONLY;
}

// Only Jenny-owned manifest tools may cross the phone decision boundary.
// Plugin, MCP, and otherwise unknown names fail closed on the desktop.
function authorityForTool(toolName) {
  if (!hasNonEmptyString(toolName)) return DESKTOP_ONLY;
  return PHONE_ONE_OFF_TOOL_SET.has(toolName.trim()) ? 'one_off' : DESKTOP_ONLY;
}

function allowedDecisionOptions(kind) {
  return DECISION_OPTIONS[kind] || Object.freeze([]);
}

function stripForbiddenBackendOptions(obj) {
  const result = obj && typeof obj === 'object' ? { ...obj } : {};
  for (const key of FORBIDDEN_BACKEND_OPTIONS) delete result[key];
  return result;
}

module.exports = Object.freeze({
  DESKTOP_ONLY_TOOLS,
  PHONE_ONE_OFF_TOOLS,
  FORBIDDEN_BACKEND_OPTIONS,
  allowedDecisionOptions,
  authorityForTool,
  canListSession,
  canReadSession,
  canSend,
  classifyDecision,
  stripForbiddenBackendOptions,
});
