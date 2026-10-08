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

test('buildTaskRows keeps the board entry projectId and defaults it to an empty string', () => {
  const rows = buildTaskRows({
    companion: {
      openLoopsBoard: {
        active: [
          task({ followUpId: 'with-project', projectId: ' project_abc ' }),
          task({ followUpId: 'no-project' }),
        ],
        deferred: [], recentResolved: [], archived: [],
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.followUpId, row]));
  assert.equal(byId.get('with-project').projectId, 'project_abc');
  assert.equal(byId.get('no-project').projectId, '');
});

test('buildTaskRows hides loops inside the delete-undo window', () => {
  const board = {
    active: [task({ followUpId: 'task-kept', title: 'Kept' }), task({ followUpId: 'task-pending', title: 'Pending' })],
    deferred: [],
    recentResolved: [task({ followUpId: 'task-done', title: 'Done', status: 'resolved' })],
    archived: [],
  };
  const rows = buildTaskRows({
    companion: { openLoopsBoard: board },
    ui: { pendingLoopDeleteIds: ['task-pending', 'task-done'] },
  });
  assert.deepEqual(rows.map((row) => row.followUpId), ['task-kept']);
  const unfiltered = buildTaskRows({ companion: { openLoopsBoard: board }, ui: {} });
  assert.equal(unfiltered.length, 3);
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
  // The panel header carries the title (area 3); the rail keeps only the summary.
  assert.match(openHtml, /<header class="task-rail-header"><span class="task-rail-summary">1 of 3 done &middot; 1 follow-up open<\/span>/);
  assert.doesNotMatch(openHtml, /task-rail-title-text/);
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

// ---- Project scope (FG-002 B4) ----------------------------------------------

const GENERAL = 'project_general';

function scopedRows(entries) {
  return buildTaskRows({
    currentSessionId: 'chat',
    sessions: [],
    companion: {
      openLoopsBoard: {
        active: entries.filter((entry) => entry.section !== 'done').map(({ section, ...rest }) => task(rest)),
        deferred: [],
        recentResolved: entries.filter((entry) => entry.section === 'done').map(({ section, ...rest }) => task({ ...rest, status: 'resolved' })),
        archived: [],
      },
    },
  });
}

const SCOPE_NAMES = new Map([
  ['project_a', 'Alpha'], ['project_b', 'Beta'], [GENERAL, 'General'],
]);

function scopeHelper(overrides = {}) {
  return {
    mode: 'current',
    projectId: 'project_a',
    projectName: 'Alpha',
    chatProjectId: 'project_a',
    projectNames: SCOPE_NAMES,
    projectOrder: ['project_a', 'project_b', GENERAL],
    ...overrides,
  };
}

const UI = { filter: 'open' };

test('scope button names the project, carries the scope mode and marks an away project', () => {
  const rows = scopedRows([{ followUpId: 'a1', title: 'Alpha task', projectId: 'project_a' }]);
  const current = renderTaskRailSurface(rows, UI, { scope: scopeHelper() });
  assert.match(current, /<header class="task-rail-header"><span class="task-rail-summary">[^<]*<\/span><button[^>]*id="task-rail-scope"/);
  assert.match(current, /class="task-rail-scope"/);
  assert.match(current, /data-action="task-rail-scope"/);
  assert.match(current, /data-task-scope="current"/);
  assert.match(current, /aria-haspopup="menu"/);
  assert.match(current, /aria-label="Show tasks from: Alpha"/);
  assert.match(current, /title="Show tasks from"/);
  assert.match(current, /<span class="task-rail-scope-name">Alpha<\/span><svg/);
  assert.doesNotMatch(current, /task-rail-scope--away/);

  const away = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'project', projectId: 'project_b', projectName: 'Beta' }) });
  assert.match(away, /class="task-rail-scope task-rail-scope--away"/);
  assert.match(away, /data-task-scope="project"/);
  assert.match(away, /<span class="task-rail-scope-name">Beta<\/span>/);

  const all = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(all, /data-task-scope="all"/);
  assert.match(all, /<span class="task-rail-scope-name">All projects<\/span>/);
  assert.match(all, /aria-label="Show tasks from: All projects"/);
  assert.doesNotMatch(all, /task-rail-scope--away/);
});

test('scope project-name text is escaped', () => {
  const html = renderTaskRailSurface([], UI, { scope: scopeHelper({ projectName: '<b>x</b>' }) });
  assert.equal(html.includes('<b>x</b>'), false);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('a single-project scope hides the other projects rows and rows without a project', () => {
  const rows = scopedRows([
    { followUpId: 'a1', title: 'Alpha one', projectId: 'project_a' },
    { followUpId: 'b1', title: 'Beta one', projectId: 'project_b' },
    { followUpId: 'n1', title: 'Orphan one', projectId: '' },
  ]);
  const html = renderTaskRailSurface(rows, UI, { scope: scopeHelper() });
  assert.match(html, /Alpha one/);
  assert.doesNotMatch(html, /Beta one|Orphan one/);
  assert.match(html, /<b>Follow-ups<\/b>/, 'the single heading stays in a single-project scope');
  assert.match(html, /1 follow-up open<\/span>/);

  const beta = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'project', projectId: 'project_b', projectName: 'Beta' }) });
  assert.match(beta, /Beta one/);
  assert.doesNotMatch(beta, /Alpha one|Orphan one/);
});

test('All projects groups follow-ups by project: chat project first, then switcher order, No project last', () => {
  const rows = scopedRows([
    { followUpId: 'g1', title: 'General one', projectId: GENERAL },
    { followUpId: 'n1', title: 'Orphan one', projectId: '' },
    { followUpId: 'b1', title: 'Beta one', projectId: 'project_b' },
    { followUpId: 'b2', title: 'Beta two', projectId: 'project_b' },
    { followUpId: 'a1', title: 'Alpha one', projectId: 'project_a' },
    { followUpId: 'z1', title: 'Stranger one', projectId: 'project_zzz' },
  ]);
  const html = renderTaskRailSurface(rows, UI, {
    scope: scopeHelper({ mode: 'all', projectId: '', projectName: '', chatProjectId: 'project_b', projectOrder: ['project_a', 'project_b', GENERAL] }),
  });
  const headings = Array.from(html.matchAll(/<div class="task-rail-group"><b>([^<]*)<\/b><span>([^<]*)<\/span><\/div>/g))
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(headings, [
    ['Beta', '2 open &middot; this chat'],
    ['Alpha', '1 open'],
    ['project_zzz', '1 open'],
    ['General', '1 open'],
    ['No project', '1 open'],
  ]);
  assert.ok(html.indexOf('Beta one') < html.indexOf('Alpha one'));
  assert.ok(html.indexOf('Alpha one') < html.indexOf('Stranger one'));
  assert.ok(html.indexOf('Stranger one') < html.indexOf('General one'));
  assert.ok(html.indexOf('General one') < html.indexOf('Orphan one'));
  assert.doesNotMatch(html, /<b>Follow-ups<\/b>/);
});

test('All projects omits empty groups and counts only open rows in a heading', () => {
  const rows = scopedRows([
    { followUpId: 'a1', title: 'Alpha one', projectId: 'project_a' },
    { followUpId: 'b-done', title: 'Beta done', projectId: 'project_b', section: 'done' },
  ]);
  const open = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(open, /<b>Alpha<\/b><span>1 open &middot; this chat<\/span>/);
  assert.doesNotMatch(open, /<b>Beta<\/b>/);
  const all = renderTaskRailSurface(rows, { filter: 'all' }, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(all, /<b>Beta<\/b><span>0 open<\/span>/);
});

test('summary counts the open follow-ups across projects in All projects', () => {
  const rows = scopedRows([
    { followUpId: 'a1', title: 'A1', projectId: 'project_a' },
    { followUpId: 'a2', title: 'A2', projectId: 'project_a' },
    { followUpId: 'b1', title: 'B1', projectId: 'project_b' },
  ]);
  const all = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(all, /<span class="task-rail-summary">3 follow-ups open in 2 projects<\/span>/);
  const single = renderTaskRailSurface(scopedRows([{ followUpId: 'a1', title: 'A1', projectId: 'project_a' }]), UI,
    { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(single, /<span class="task-rail-summary">1 follow-up open<\/span>/, 'one project reads as a plain count');
  const scoped = renderTaskRailSurface(rows, UI, { scope: scopeHelper() });
  assert.match(scoped, /<span class="task-rail-summary">2 follow-ups open<\/span>/);
});

test('Add placeholder names the scoped project, or the chat project in All projects', () => {
  const placeholder = (html) => (html.match(/placeholder="([^"]*)"/) || [])[1];
  assert.equal(placeholder(renderTaskRailSurface([], UI, { scope: scopeHelper() })), 'Add a task to Alpha');
  assert.equal(placeholder(renderTaskRailSurface([], UI, { scope: scopeHelper({ mode: 'project', projectId: 'project_b', projectName: 'Beta' }) })), 'Add a task to Beta');
  assert.equal(placeholder(renderTaskRailSurface([], UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) })), 'Add a task to Alpha');
  assert.equal(placeholder(renderTaskRailSurface([], UI, {})), 'Add a follow-up', 'no scope keeps the original copy');
});

test('empty copy names the project for a single-project Open filter and is unchanged elsewhere', () => {
  const single = renderTaskRailSurface([], UI, { scope: scopeHelper() });
  assert.match(single, /No open tasks in Alpha\. Ask Jenny to file one, or add one above\./);
  const all = renderTaskRailSurface([], UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(all, /No open tasks\. Ask Jenny to file one, or add one above\./);
  const done = renderTaskRailSurface([], { filter: 'done' }, { scope: scopeHelper() });
  assert.match(done, /No completed tasks yet\./);
  const every = renderTaskRailSurface([], { filter: 'all' }, { scope: scopeHelper() });
  assert.match(every, /No tasks yet\. Ask Jenny to file one, or add one above\./);
});

test('the checklist stays first and visible in every scope', () => {
  const checklist = { items: [{ content: 'Chat step', status: 'pending' }], updatedAt: '' };
  const rows = scopedRows([{ followUpId: 'b1', title: 'Beta one', projectId: 'project_b' }]);
  const html = renderTaskRailSurface(rows, UI, { checklist, scope: scopeHelper() });
  assert.match(html, /<b>This conversation<\/b>/);
  assert.match(html, /Chat step/);
  assert.doesNotMatch(html, /No open tasks in/, 'the empty copy is only for an empty list');
});

test('send-list stays enabled only for open follow-ups inside the scope', () => {
  const rows = scopedRows([{ followUpId: 'b1', title: 'Beta one', projectId: 'project_b' }]);
  const empty = renderTaskRailSurface(rows, UI, { scope: scopeHelper() });
  assert.match(empty, /data-action="task-rail-send-list"[^>]*disabled/);
  const populated = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.doesNotMatch(populated, /data-action="task-rail-send-list"[^>]*disabled/);
});
