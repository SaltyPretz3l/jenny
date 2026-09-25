'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSessionChecklist,
  buildTaskRows,
  renderTaskRailSurface,
} = require('../renderer/features/renderer-task-rail-render');

function task(overrides = {}) {
  return {
    id: 'followup:task-1',
    followUpId: 'task-1',
    title: 'Ship the task rail',
    body: 'Keep it focused.',
    status: 'active',
    sessionId: '',
    sessionTitle: '',
    sourceKind: 'agent_task',
    actions: [],
    isDue: false,
    timingLabel: '',
    ...overrides,
  };
}

test('task rail markup uses inventory controls and escapes task metadata', () => {
  const attack = '<img src=x onerror=1>';
  const rows = buildTaskRows({
    currentSessionId: 'session-current',
    sessions: [],
    companion: {
      openLoopsBoard: {
        active: [task({ title: attack, body: attack, sessionId: 'source-session', sessionTitle: attack })],
        deferred: [], recentResolved: [], archived: [],
      },
    },
  });
  const html = renderTaskRailSurface(rows, {
    filter: 'open', draftTitle: '', busyTaskId: '', lastError: '',
  }, {});

  assert.equal(html.includes('<select'), false);
  const inputTags = html.match(/<input\b[^>]*>/g) || [];
  assert.ok(inputTags.length > 0, 'the inventory checkbox renders its native input');
  assert.ok(inputTags.every((tag) => tag.includes('data-inv-checkbox')));
  const buttonTags = html.match(/<button\b[^>]*>/g) || [];
  assert.ok(buttonTags.length > 0);
  assert.ok(buttonTags.every((tag) => /class="(?:btn|inv-segmented-option|task-rail-overflow)/.test(tag)));
  assert.equal(html.includes(attack), false);
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'));
});

test('buildTaskRows filters non-agent rows and sorts the current-session task first', () => {
  const rows = buildTaskRows({
    currentSessionId: 'session-current',
    sessions: [
      { id: 'session-other', linked_task_id: 'task-newer' },
      { id: 'session-current', linked_task_id: 'task-current' },
    ],
    companion: {
      openLoopsBoard: {
        active: [
          task({ followUpId: 'task-newer', title: 'Newer', updatedAt: '2026-09-05T12:00:00Z' }),
          task({ followUpId: 'task-current', title: 'Current', updatedAt: '2026-09-01T12:00:00Z' }),
          task({ followUpId: 'manual', title: 'Not an agent task', sourceKind: 'manual' }),
        ],
        deferred: [], recentResolved: [], archived: [],
      },
    },
  });

  assert.deepEqual(rows.map((row) => row.followUpId), ['task-current', 'task-newer']);
  assert.equal(rows[0].linkedSessionId, 'session-current');
  assert.equal(rows[0].isCurrentSessionTask, true);
});

function todoResult(todos, overrides = {}) {
  return {
    kind: 'tool_result',
    timestamp: '2026-09-20T12:00:00.000Z',
    tool_result: {
      tool_name: 'todo_write',
      output_text: JSON.stringify({ count: todos.length, todos }),
      is_error: false,
      error_code: '',
    },
    ...overrides,
  };
}

test('buildSessionChecklist uses the last successful todo_write result and normalizes its items', () => {
  const tooLong = `  ${'x'.repeat(310)}  `;
  const messages = [
    todoResult([{ content: 'Old item', status: 'pending' }]),
    todoResult([{ content: 'Ignored error', status: 'pending' }], {
      tool_result: {
        tool_name: 'TODO_WRITE', output_text: '{"todos":[]}', is_error: true, error_code: 'failed',
      },
    }),
    todoResult([
      { content: '  Active work  ', status: 'in_progress' },
      { content: tooLong, status: 'mystery' },
      { content: 'Done work', status: 'completed' },
      { content: '   ', status: 'pending' },
      ...Array.from({ length: 60 }, (_, index) => ({ content: `Item ${index}`, status: 'pending' })),
    ], {
      timestamp: '2026-09-21T08:30:00.000Z',
      tool_result: {
        tool_name: 'ToDo_WrItE',
        content: JSON.stringify({ todos: [
          { content: '  Active work  ', status: 'in_progress' },
          { content: tooLong, status: 'mystery' },
          { content: 'Done work', status: 'completed' },
          { content: '   ', status: 'pending' },
          ...Array.from({ length: 60 }, (_, index) => ({ content: `Item ${index}`, status: 'pending' })),
        ] }),
        is_error: false,
        error_code: '',
      },
    }),
  ];

  const result = buildSessionChecklist(messages);
  assert.equal(result.updatedAt, '2026-09-21T08:30:00.000Z');
  assert.equal(result.items.length, 49, 'the first 50 raw entries are capped before blank entries are dropped');
  assert.deepEqual(result.items[0], { content: 'Active work', status: 'in_progress' });
  assert.deepEqual(result.items[1], { content: 'x'.repeat(300), status: 'pending' });
  assert.deepEqual(result.items[2], { content: 'Done work', status: 'completed' });
});

test('buildSessionChecklist treats malformed and cleared latest results as authoritative empty lists', () => {
  const previous = todoResult([{ content: 'Keep me only if no later result', status: 'pending' }]);
  assert.deepEqual(buildSessionChecklist([
    previous,
    todoResult([{ content: 'Failed replacement', status: 'pending' }], {
      tool_result: { tool_name: 'todo_write', output_text: '{"todos":[]}', is_error: true, error_code: 'failed' },
    }),
  ]), {
    items: [{ content: 'Keep me only if no later result', status: 'pending' }],
    updatedAt: '2026-09-20T12:00:00.000Z',
  });
  assert.deepEqual(buildSessionChecklist([
    previous,
    todoResult([], { tool_result: { tool_name: 'todo_write', output_text: '{broken', is_error: false, error_code: '' } }),
  ]), { items: [], updatedAt: '' });
  assert.deepEqual(buildSessionChecklist([
    previous,
    todoResult([], { timestamp: '2026-09-21T09:00:00.000Z' }),
  ]), { items: [], updatedAt: '2026-09-21T09:00:00.000Z' });
  assert.deepEqual(buildSessionChecklist([{ kind: 'assistant', content: 'No tool result' }]), {
    items: [], updatedAt: '',
  });
});

test('buildSessionChecklist keeps the finished snapshot when todo_write clears an all-completed list', () => {
  const snapshot = todoResult([
    { content: 'First', status: 'completed' },
    { content: 'Second', status: 'in_progress' },
  ]);
  const cleared = todoResult([], {
    timestamp: '2026-09-21T09:30:00.000Z',
    tool_result: {
      tool_name: 'todo_write', is_error: false, error_code: '',
      output_text: '{"cleared":true,"reason":"all items completed","count":0}',
    },
  });
  assert.deepEqual(buildSessionChecklist([snapshot, cleared]), {
    items: [{ content: 'First', status: 'completed' }, { content: 'Second', status: 'completed' }],
    updatedAt: '2026-09-21T09:30:00.000Z',
  });
  assert.deepEqual(buildSessionChecklist([cleared]), { items: [], updatedAt: '' });
});

test('task rail renders checklist groups per filter and keeps checklist rows read-only', () => {
  const rows = buildTaskRows({
    currentSessionId: 'current',
    sessions: [{ id: 'current', linked_task_id: 'follow-up' }],
    companion: {
      openLoopsBoard: {
        active: [task({ followUpId: 'follow-up', sessionId: 'origin', sessionTitle: 'Origin chat', timingLabel: 'Today' })],
        deferred: [], recentResolved: [], archived: [],
      },
    },
  });
  const checklist = { items: [
    { content: 'Pending item', status: 'pending' },
    { content: 'Working item', status: 'in_progress' },
    { content: 'Finished item', status: 'completed' },
  ], updatedAt: '2026-09-21T09:00:00.000Z' };
  const openHtml = renderTaskRailSurface(rows, { filter: 'open' }, { checklist });
  assert.match(openHtml, /<b class="task-rail-title-text">Tasks<\/b><span class="task-rail-summary">1 of 3 done &middot; 1 follow-up open<\/span>/);
  assert.match(openHtml, /<b>This conversation<\/b><span>Jenny&#39;s checklist<\/span>/);
  assert.match(openHtml, /data-check-status="pending"[\s\S]*?Pending item/);
  assert.match(openHtml, /data-check-status="in_progress"[\s\S]*?Working item[\s\S]*?class="task-rail-check-meta">in progress/);
  assert.doesNotMatch(openHtml, /Finished item/);
  const checklistMarkup = openHtml.slice(
    openHtml.indexOf('class="task-rail-check"'),
    openHtml.indexOf('<div class="task-rail-group"><b>Follow-ups</b>')
  );
  assert.doesNotMatch(checklistMarkup, /data-inv-checkbox|data-action=/);

  const doneHtml = renderTaskRailSurface(rows, { filter: 'done' }, { checklist });
  assert.match(doneHtml, /Finished item/);
  assert.doesNotMatch(doneHtml, /Pending item|Working item/);
  const allHtml = renderTaskRailSurface(rows, { filter: 'all' }, { checklist });
  assert.match(allHtml, /Pending item/);
  assert.match(allHtml, /Working item/);
  assert.match(allHtml, /Finished item/);
});

test('follow-up rows use one plain metadata line and no secondary action row', () => {
  const rows = buildTaskRows({
    currentSessionId: 'current',
    sessions: [{ id: 'current', linked_task_id: 'task-1' }],
    companion: {
      openLoopsBoard: {
        active: [task({ sessionId: 'origin', sessionTitle: 'Origin chat', timingLabel: 'Tomorrow' })],
        deferred: [], recentResolved: [], archived: [],
      },
    },
  });
  const html = renderTaskRailSurface(rows, { filter: 'open' }, {});
  assert.match(html, /class="task-rail-meta">Agent task &middot; Tomorrow &middot; from Origin chat &middot; This session<\/div>/);
  assert.doesNotMatch(html, /task-rail-row-actions|task-rail-origin-badge|task-rail-current-badge/);
  assert.doesNotMatch(html, /data-action="task-rail-open-session"|data-action="task-rail-start"/);
});
