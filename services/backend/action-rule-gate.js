'use strict';

// Row 87 D3: the deny-only rule hooks of the Jenny chat's `session_stop`, `settings_change` and
// `schedule_change` (plan docs/plans/PRIMARY_ACTION_RULES_2026-10-27.md). The approval path asks before it
// shows a card, so a denied action never asks; each tool asks again at execute, for any path that reached
// it without a card. Only a deny rule decides here (Q1: these actions offer no allow or ask). The matcher
// (services/primary-action-rules.js) is reached through `service.primaryActionRules`; without it, or for any
// other tool, nothing is denied and the tool's own consent applies unchanged.
const { RULE_DENIED_MESSAGE } = require('../primary-action-rules');

const ACTION_BY_TOOL = Object.freeze({ session_stop: 'stop', settings_change: 'setting', schedule_change: 'schedule' });

// The chat's run mode as the rules name it (plan mode wins, like session-execution-authority.js).
function sessionRunMode(service, sessionId) {
  try {
    const summary = service?.sessionStore?.getSessionSummary?.(sessionId);
    if (!summary) return null;
    if (summary.plan_mode === true) return 'plan';
    const mode = String(summary.run_mode || '').trim().toLowerCase();
    return mode || null;
  } catch {
    return null;
  }
}

/** The deny rule `{effect, rule_id}` that refuses this tool call by the primary chat, or null. Never throws. */
function actionRuleDenial(service, { toolName, sessionId, turnId = null, input = {} } = {}) {
  const action = Object.hasOwn(ACTION_BY_TOOL, toolName) ? ACTION_BY_TOOL[toolName] : null;
  const rules = service?.primaryActionRules;
  if (!action || typeof rules?.denial !== 'function' || typeof sessionId !== 'string' || !sessionId) return null;
  const target = action === 'stop' && typeof input?.session_id === 'string' ? { session_id: input.session_id.trim() } : {};
  try {
    return rules.denial({ action, sessionId, turnId, target, runMode: sessionRunMode(service, sessionId) }) || null;
  } catch {
    return null;
  }
}

module.exports = { actionRuleDenial, sessionRunMode };
