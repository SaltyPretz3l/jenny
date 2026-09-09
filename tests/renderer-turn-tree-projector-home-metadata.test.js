const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const {
  cloneSubagentReportMetadata,
} = require('../renderer/chat/renderer-turn-tree-projector-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

function project(messages) {
  return projectTurnTree({ messages: normalizeChatMessages(messages) });
}

test('projectTurnTree preserves bounded home calendar metadata from persisted tool results', () => {
  const instances = Array.from({ length: 41 }, (_, index) => ({
    instance_id: `event_${index + 1}:2026-09-${String(7 + Math.floor(index / 12)).padStart(2, '0')}T${String(8 + (index % 12)).padStart(2, '0')}:00`,
    event_id: `event_${index + 1}`,
    title: `Event ${index + 1}`,
    start: `2026-09-${String(7 + Math.floor(index / 12)).padStart(2, '0')}T${String(8 + (index % 12)).padStart(2, '0')}:00`,
    end: `2026-09-${String(7 + Math.floor(index / 12)).padStart(2, '0')}T${String(9 + (index % 12)).padStart(2, '0')}:00`,
    all_day: false,
    category: 'default',
    source: 'local',
    source_kind: 'assistant',
    readonly: false,
    tz_approx: false,
    recurrence_unsupported: false,
    kind: 'event',
  }));
  const calendar = {
    schema_version: 1,
    range_start: '2026-09-07T00:00',
    range_end: '2026-09-11T00:00',
    generated_at: '2026-09-07T08:00',
    instance_count: 41,
    omitted_count: 1,
    instances,
  };
  const calendarReceipt = {
    schema_version: 1,
    kind: 'event',
    op: 'update',
    id: 'event_42',
    title: 'Updated event',
    start: '2026-09-10T10:00',
    end: '2026-09-10T11:00',
    all_day: false,
    category: 'work',
    journal_entry_id: 'journal_42',
    journaled: true,
  };
  const result = project([
    { id: 'user_stream_home', role: 'user', content: 'Show my calendar, then update the event' },
    {
      id: 'tool_use_home_calendar_list',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_home_calendar_list',
        tool_name: 'home',
        parent_stream_id: 'stream_home',
        status: 'running',
      },
    },
    {
      id: 'tool_result_home_calendar_list',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_home_calendar_list',
        tool_name: 'home',
        output_text: '{}',
        parent_stream_id: 'stream_home',
        metadata: {
          result_kind: 'home',
          action: 'calendar_list',
          status: 'ok',
          calendar,
        },
      },
    },
    {
      id: 'tool_use_home_event_upsert',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_home_event_upsert',
        tool_name: 'home',
        parent_stream_id: 'stream_home',
        status: 'running',
      },
    },
    {
      id: 'tool_result_home_event_upsert',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_home_event_upsert',
        tool_name: 'home',
        output_text: '{}',
        parent_stream_id: 'stream_home',
        metadata: {
          result_kind: 'home',
          action: 'event_upsert',
          status: 'ok',
          calendar_receipt: calendarReceipt,
        },
      },
    },
  ]);

  const toolResults = result.turns[0].events.filter((entry) => entry.kind === 'tool_result');
  assert.deepEqual(toolResults[0].payload.metadata, {
    result_kind: 'home',
    action: 'calendar_list',
    status: 'ok',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-11T00:00',
      generated_at: '2026-09-07T08:00',
      instance_count: 41,
      omitted_count: 1,
      instances: instances.slice(0, 40),
    },
  });
  assert.deepEqual(toolResults[1].payload.metadata, {
    result_kind: 'home',
    action: 'event_upsert',
    status: 'ok',
    calendar_receipt: calendarReceipt,
  });
  assert.notStrictEqual(toolResults[0].payload.metadata.calendar, calendar);
  assert.notStrictEqual(toolResults[1].payload.metadata.calendar_receipt, calendarReceipt);
});

test('cloneSubagentReportMetadata keeps non-home and user question behavior unchanged', () => {
  assert.equal(cloneSubagentReportMetadata({
    result_kind: 'task_board',
    action: 'calendar_list',
    status: 'ok',
    calendar: { instances: [{ id: 'event_1' }] },
    calendar_receipt: { event_id: 'event_1' },
  }), null);

  const answers = Array.from({ length: 9 }, (_, index) => ({
    question_id: `question_${index + 1}`,
    answer: `Answer ${index + 1}`,
  }));
  assert.deepEqual(cloneSubagentReportMetadata({
    result_kind: 'user_questions_answered',
    answers,
  }), {
    result_kind: 'user_questions_answered',
    answers: answers.slice(0, 8),
  });
});
