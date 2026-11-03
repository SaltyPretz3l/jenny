'use strict';

// `schedule_list` (row 85 D8): the primary Jenny chat's scheduled checks (Home reminders with action
// 'jenny_turn'), and plain reminders read-only when asked. Read-only, policy `auto`, no card; it answers in
// Plan mode and read-only chats too, like settings_get (only schedule_change is refused there). The answer comes
// from the schedule port
// (`context.primaryScheduleService`, which re-checks that the caller is the primary chat); no result carries
// exception text.
const { manifestSchema } = require('./tool-result');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');
const NAME = 'schedule_list';
// Either kill switch removes both tools (they are not registered); a stale context still refuses here.
const schedulesOff = (context) => {
  const flags = context?.backendService?.featureFlags;
  return flags?.primary_scheduled_checks === false || flags?.primary_chat === false;
};
const result = (value) => jsonToolResult(NAME, 'Scheduled checks: list', value);
const refused = (reason) => result({ ok: false, reason });

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Scheduled checks: list',
  async execute(input = {}, context = {}) {
    if (schedulesOff(context)) return refused('disabled');
    if (!plainInput(input, ['include_reminders'])
      || (input.include_reminders !== undefined && typeof input.include_reminders !== 'boolean')) return refused('invalid_input');
    const port = context.primaryScheduleService;
    if (typeof port?.list !== 'function') return refused('disabled');
    try {
      const answer = await port.list({
        ...(input.include_reminders === undefined ? {} : { include_reminders: input.include_reminders }),
        caller_session_id: String(context.sessionId || ''),
      });
      return answer && typeof answer === 'object' ? result(answer) : refused('denied');
    } catch (_error) {
      return refused('denied');
    }
  },
};
