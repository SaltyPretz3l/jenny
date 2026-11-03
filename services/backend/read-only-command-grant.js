'use strict';

// Row 102: a read-only shell command runs without an approval card. The sidecar
// classifies the command (allowlisted programs, no write/launch arguments, every
// path inside the bound root) and marks the runtime.operation check with
// `grant: 'read_only_command'`. Electron has no shell classifier, so its half is
// the consent posture only: the host flag, the tool name, and a policy that is
// still the untouched tool default (a saved user rule always wins). The trust
// basis is the same as the Auto run grant. This module is pure; the authority
// owns the per-binding record of granted operations.

const READ_ONLY_COMMAND_GRANT = 'read_only_command';
const READ_ONLY_COMMAND_TOOL = 'run_command';

const RUNTIME_OPERATION_KEYS = Object.freeze(['api_version', 'arguments', 'authority_revision',
  'operation_id', 'phase', 'request_id', 'schema_version', 'session_id', 'tool_name']);

// The tool-check payload is exactly RUNTIME_OPERATION_KEYS, optionally plus `grant`,
// and a present `grant` must be the constant (null or anything else is malformed).
function readOperationEnvelope(params) {
  const hasGrant = Object.hasOwn(params, 'grant');
  const keys = Object.keys(params).filter((key) => key !== 'grant').sort();
  if (keys.join('\0') !== RUNTIME_OPERATION_KEYS.join('\0')
    || (hasGrant && params.grant !== READ_ONLY_COMMAND_GRANT)) {
    return { ok: false, grant: null };
  }
  return { ok: true, grant: hasGrant ? READ_ONLY_COMMAND_GRANT : null };
}

// Does the claimed grant (a validated operation's `grant`), or the one recorded for this
// exact operation, apply to its tool under the live host flag? The caller checks policy.
function readOnlyCommandGrantApplies({ grant, toolName }, flagEnabled, recorded) {
  return flagEnabled === true && toolName === READ_ONLY_COMMAND_TOOL
    && (grant === READ_ONLY_COMMAND_GRANT || recorded === true);
}

// Electron admits only the untouched tool-default ask for a read-only command: never a user rule,
// never a stored v1 per-tool run_command policy (it reads as a tool default; see command-bridge.js).
function admitsPolicyAsk(policy, snapshot) {
  return policy?.decision === 'ask' && policy.stage === 'tool_default'
    && policy.matched_rule_id === null
    && !Object.hasOwn(snapshot?.legacy_policies || {}, READ_ONLY_COMMAND_TOOL);
}

module.exports = {
  READ_ONLY_COMMAND_GRANT,
  admitsPolicyAsk,
  readOnlyCommandGrantApplies,
  readOperationEnvelope,
};
