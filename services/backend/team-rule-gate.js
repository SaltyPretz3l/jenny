'use strict';

// Slice 3-12 (E66): whether a team project's "Always allowed" rule answers an approval instead of a person. Read once
// per call, beside Full auto, after every refusal has had its say (deny rules, port refusals, the duplicate check).
//
// The port is `service.teamProjectRules`, set only by a team host (server/team/team-project-rules.js `attach`); a
// desktop and a single-owner hosted backend have none and are unchanged. The port decides the project (from the
// host's own session index now), the turn's starter and the path, from the same `tool_input` the exact-input check
// hashes. The gate itself refuses first, without asking the port: a tool outside the closed list, a request that
// must be approved once by a person (`oneOffOnly`: the sidecar's consecutive-auto-approval cap, a chained command,
// `one_off_only`), and a turn with no trusted binding or one in Plan or read-only. Anything missing, unknown or
// throwing means a person is asked.
//
// Review sweeps, second run (X2b-F03): the rule tool list (server/team/project-rules-match.js) loads only on a team
// host's first call, so desktop main loads no server/team module (tests/team-off.test.js).

const { getTrustedExecutionBinding } = require('./session-execution-authority');

const TEAM_RULE_SCOPE = 'team_rule';

// The rule that answers this call ({ rule_seq }), or null.
function teamRuleApproves(service, { toolName, sessionId, input, oneOffOnly = false, executionAuthority = null } = {}) {
  if (service?.hostMode !== 'server' || oneOffOnly !== false) return null;
  // D5 (the team host file tools plan): while file tools are on, every write and edit asks a person.
  if (service.hostRootBoundary) return null;
  const { isRuleTool } = require('../../server/team/project-rules-match');
  if (!isRuleTool(toolName)) return null;
  try {
    const binding = getTrustedExecutionBinding(executionAuthority);
    if (!binding || binding.mode === 'plan' || binding.readOnly !== false) return null;
    const port = service.teamProjectRules;
    if (typeof port?.match !== 'function' || !input || typeof input !== 'object' || Array.isArray(input)) return null;
    const answer = port.match({ sessionId, toolName, input });
    return Number.isSafeInteger(answer?.rule_seq) && answer.rule_seq >= 1 ? { rule_seq: answer.rule_seq } : null;
  } catch {
    return null;
  }
}

// The call a rule answered settled approved: the port counts one use. Never throws.
function noteTeamRuleUse(service, { sessionId, ruleSeq }) {
  try {
    service?.teamProjectRules?.used?.({ sessionId, ruleSeq });
  } catch {
    // A count is bookkeeping; the settled call stands.
  }
}

module.exports = { TEAM_RULE_SCOPE, noteTeamRuleUse, teamRuleApproves };
