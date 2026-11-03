'use strict';

/* services/primary-action-rules.js - the matcher for the Jenny chat's per-action rules (row 87 D2,
 * plan docs/plans/PRIMARY_ACTION_RULES_2026-10-27.md).
 *
 * `match({action, sessionId, turnId, target, runMode})` answers which of the user's rules decides an
 * orchestration action of the primary Jenny chat: `{effect, rule_id}` or null (no rule: the action's
 * own consent applies unchanged). Rules apply to the primary chat only. Precedence: deny > ask > allow;
 * within an effect the most specific target wins (chat > project > linked_children > any), then the
 * newest. A wake turn (a message from another chat, a fired scheduled check or a digest) never spends an
 * `allow` rule: those matches are dropped while `deny` and `ask` still apply, and a wake port that
 * cannot answer counts as a wake. Rules are user-created only (the controls service writes them; no
 * model tool does); this module never writes except the coalesced `rule_denied` history row.
 *
 * Every dependency is an injected getter; a missing or throwing one yields null (no rule), never a
 * throw, so the action falls back to its own card. Diagnostics carry reason tokens only.
 */

const { PRIMARY_ACTION_RULE_SHAPES } = require('./shell-config-primary-chat');

const EFFECT_RANK = Object.freeze({ deny: 3, ask: 2, allow: 1 });
const TARGET_RANK = Object.freeze({ chat: 4, project: 3, linked_children: 2, any: 1 });
// What the model reads when a deny rule refuses an action: a plain reason it can relay, no rule internals.
const RULE_DENIED_MESSAGE = 'Refused by a standing rule the user set for the Jenny chat. Tell the user;'
  + ' they can change it in Activity > Permissions.';

const isText = (value) => typeof value === 'string' && value.length > 0;

function createPrimaryActionRules({
  controls = () => null, getSessionSummary = () => null, isWakeTurn = () => true, log = () => {},
} = {}) {
  const read = (getter) => { try { return typeof getter === 'function' ? getter() || null : null; } catch { return null; } };

  // What a target says about itself: the chat's project and whether the primary started it.
  function facts(target, primaryId) {
    const sessionId = isText(target?.session_id) ? target.session_id : null;
    let summary = null;
    if (sessionId) { try { summary = getSessionSummary(sessionId) || null; } catch { summary = null; } }
    const projectId = isText(target?.project_id) ? target.project_id : (isText(summary?.project_id) ? summary.project_id : null);
    return { sessionId, projectId, linked: Boolean(sessionId) && summary?.spawned_from?.parent_session_id === primaryId };
  }

  function covers(rule, fact) {
    switch (rule.target.kind) {
      case 'any': return true;
      case 'chat': return fact.sessionId !== null && rule.target.id === fact.sessionId;
      case 'project': return fact.projectId !== null && rule.target.id === fact.projectId;
      case 'linked_children': return fact.linked;
      default: return false;
    }
  }

  function wakeTurn(sessionId, turnId) {
    try { return isWakeTurn(sessionId, turnId) !== false; } catch { return true; }
  }

  function match({ action, sessionId, turnId = null, target = {}, runMode = null } = {}) {
    try {
      if (!Object.hasOwn(PRIMARY_ACTION_RULE_SHAPES, action) || !isText(sessionId)) return null;
      const service = read(controls);
      if (service?.actionRulesEnabled?.() !== true) return null;
      if (service.isPrimary?.(sessionId) !== true) return null;
      const primaryId = sessionId;
      // An unreadable run mode still meets every deny and ask rule (fail closed); only an allow needs the mode.
      const rules = (service.listActionRules?.({ include_revoked: false }) || []).filter((rule) => rule?.action === action
        && rule.revoked_at === null && (rule.run_modes === null || (runMode === null && rule.effect !== 'allow')
          || (Array.isArray(rule.run_modes) && rule.run_modes.includes(runMode))));
      if (!rules.length) return null;
      const fact = facts(target, primaryId);
      const wake = rules.some((rule) => rule.effect === 'allow') && wakeTurn(sessionId, turnId);
      const best = rules.filter((rule) => covers(rule, fact) && !(wake && rule.effect === 'allow'))
        .sort((left, right) => (EFFECT_RANK[right.effect] - EFFECT_RANK[left.effect])
          || (TARGET_RANK[right.target.kind] - TARGET_RANK[left.target.kind])
          || right.created_at.localeCompare(left.created_at))[0];
      return best ? Object.freeze({ effect: best.effect, rule_id: best.rule_id }) : null;
    } catch {
      try { log('WARN', 'primary_action_rules.match_failed', { reason: 'exception' }); } catch { /* diagnostics only */ }
      return null;
    }
  }

  // True while `ruleId` names a live rule and rules are on: the delivery re-check of a rule-authorized send.
  function isLive(ruleId) {
    try {
      const service = read(controls);
      return service?.actionRulesEnabled?.() === true
        && (service.listActionRules?.({ include_revoked: false }) || []).some((rule) => rule?.rule_id === ruleId && rule.revoked_at === null);
    } catch {
      return false;
    }
  }

  // The deny rule that refuses this action, recorded once per rule per hour in Activity, or null.
  function denial(args) {
    const found = match(args);
    if (found?.effect !== 'deny') return null;
    try { read(controls)?.recordRuleDenied?.(found.rule_id); } catch { /* the refusal stands without its history row */ }
    return found;
  }

  return { denial, isLive, match };
}

module.exports = { RULE_DENIED_MESSAGE, createPrimaryActionRules };
