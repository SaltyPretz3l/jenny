'use strict';

// `schedule_change` (row 85 D8): create, update, enable, disable or cancel one of the primary Jenny chat's
// scheduled checks. Side-effecting with an `ask` policy default, never always-allow
// (tool-permission-migrations.js), and the sidecar shows its card even in Auto (Q2), with trusted fields from
// services/backend/schedule-change-approval.js. Refused in Plan mode and read-only chats and when a kill
// switch is off. The top-level shape is checked here; the schedule port (`context.primaryScheduleService`)
// re-checks the caller, validates the cadence and fields, and writes. The caller comes only from the live call
// binding; `purpose` is the card's headline and is not forwarded; no result carries exception text.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');
const { actionRuleDenial } = require('../../backend/action-rule-gate');
const { RULE_DENIED_MESSAGE } = require('../../primary-action-rules');

const NAME = 'schedule_change';
const KEYS = ['action', 'reminder_id', 'label', 'instruction', 'cadence', 'purpose'];
const ACTIONS = ['create', 'update', 'enable', 'disable', 'cancel'];
const PURPOSE_CHARS = 200;

// Either kill switch removes both tools (they are not registered); a stale context still refuses here.
const schedulesOff = (context) => {
  const flags = context?.backendService?.featureFlags;
  return flags?.primary_scheduled_checks === false || flags?.primary_chat === false;
};

const validInput = (input) => plainInput(input, KEYS) && ACTIONS.includes(input.action)
  && typeof input.purpose === 'string' && input.purpose.length >= 1 && input.purpose.length <= PURPOSE_CHARS;

const result = (value) => jsonToolResult(NAME, 'Scheduled checks: change', value, { reminder_id: value.check?.reminder_id });
const refused = (reason, extra = {}) => result({ ok: false, reason, ...extra });

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => 'Scheduled checks: change',
  async execute(input = {}, context = {}) {
    if (schedulesOff(context)) return refused('disabled');
    if (context.readOnly || context.planMode) return refused('denied');
    if (!validInput(input)) return refused('invalid_input');
    const port = context.primaryScheduleService;
    if (typeof port?.change !== 'function') return refused('disabled');
    const live = checkLiveCall(context);
    if (!live.ok) return refused('denied');
    // Row 87: a user's deny rule refuses the change (the approval path already refused before any card).
    if (actionRuleDenial(context.backendService, { toolName: NAME, sessionId: live.sessionId, turnId: live.turnId, input })) {
      return refused('rule_denied', { message: RULE_DENIED_MESSAGE });
    }
    const { purpose: _purpose, ...change } = input;
    try {
      const answer = await port.change({ ...change, caller_session_id: live.sessionId });
      return answer && typeof answer === 'object' ? result(answer) : refused('denied');
    } catch (_error) {
      return refused('denied');
    }
  },
};
