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
  assert.ok(buttonTags.every((tag) => /class="(?:btn|inv-segmented-option|task-rail-overflow|task-rail-title|task-rail-group-action)/.test(tag)));
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
  // The panel header carries the title; the rail's toolbar row carries the counts.
  assert.match(openHtml, /<span class="inv-segmented-option-label">Open 3<\/span>[\s\S]*?<span class="inv-segmented-option-label">Done 1<\/span>/);
  assert.doesNotMatch(openHtml, /task-rail-title-text|task-rail-summary|task-rail-footer/);
  assert.match(openHtml, /<b>Jenny&#39;s checklist<\/b><span>1 of 3 done<\/span>/);
  assert.match(openHtml, /data-check-status="pending"[\s\S]*?Pending item/);
  assert.match(openHtml, /data-check-status="in_progress"[\s\S]*?Working item[\s\S]*?class="task-rail-check-meta">now/);
  // Finished steps fold into one line in Open; the fold opens them in place.
  assert.doesNotMatch(openHtml, /Finished item/);
  assert.match(openHtml, /<button[^>]*class="task-rail-check-fold"[^>]*data-action="task-rail-checklist-fold"[^>]*aria-expanded="false"[\s\S]*?<span>1 done<\/span><\/button>/);
  const checklistMarkup = openHtml.slice(
    openHtml.indexOf('class="task-rail-check"'),
    openHtml.indexOf('<div class="task-rail-group"><b>Follow-ups</b>')
  );
  assert.doesNotMatch(checklistMarkup, /data-inv-checkbox|data-action=/);
  // Unfolded, the fold stays as the toggle that folds them back.
  const unfolded = renderTaskRailSurface(rows, { filter: 'open' }, { checklist, checklistFoldOpen: true });
  assert.match(unfolded, /data-action="task-rail-checklist-fold"[^>]*aria-expanded="true"[\s\S]*Pending item[\s\S]*Working item[\s\S]*Finished item/);

  const doneHtml = renderTaskRailSurface(rows, { filter: 'done' }, { checklist });
  assert.match(doneHtml, /Finished item/);
  assert.doesNotMatch(doneHtml, /Pending item|Working item|task-rail-check-fold/);
  const allHtml = renderTaskRailSurface(rows, { filter: 'all' }, { checklist });
  assert.match(allHtml, /Pending item/);
  assert.match(allHtml, /Working item/);
  assert.match(allHtml, /Finished item/);
  assert.doesNotMatch(allHtml, /task-rail-check-fold/);
});

test('a follow-up row is its title and one fact; the title opens notes, origin and the chat action', () => {
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
  assert.match(html, /<article class="task-rail-row" data-task-id="task-1" data-expanded="false">/);
  assert.match(html, /<button type="button" class="task-rail-title" data-action="task-rail-toggle" aria-expanded="false" title="Keep it focused\." data-task-id="task-1">Ship the task rail<\/button>/);
  assert.match(html, /<span class="task-rail-fact task-rail-fact--here">This session<\/span>/);
  assert.doesNotMatch(html, /task-rail-meta|task-rail-notes|task-rail-detail|Agent task|Manual/, 'notes and origin wait for the title');
  assert.doesNotMatch(html, /data-action="task-rail-open-session"|data-action="task-rail-start"/);

  const open = renderTaskRailSurface(rows, { filter: 'open', expandedTaskId: 'task-1' }, {});
  assert.match(open, /data-expanded="true"/);
  assert.match(open, /aria-expanded="true" aria-controls="taskRailDetail-task-1"/);
  assert.match(open, /<div class="task-rail-detail" id="taskRailDetail-task-1"><div class="task-rail-notes">Keep it focused\.<\/div><div class="task-rail-meta">from Origin chat<\/div>/);
  assert.match(open, /<button type="button" class="btn btn--sm" data-action="task-rail-open-session" data-task-id="task-1">Open session<\/button>/);
  assert.match(open, /data-action="task-rail-edit" data-task-id="task-1">Edit<\/button>/);

  const unlinked = buildTaskRows({ companion: { openLoopsBoard: { active: [task()], deferred: [], recentResolved: [], archived: [] } } });
  const fresh = renderTaskRailSurface(unlinked, { filter: 'open', expandedTaskId: 'task-1' }, {});
  assert.match(fresh, /data-action="task-rail-start" data-task-id="task-1">Start a session<\/button>/);
  assert.match(fresh, /<div class="task-rail-meta">Added by you<\/div>/);
});

test('the row fact says when: due, snoozed until, added, or done', () => {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const rows = buildTaskRows({
    companion: {
      openLoopsBoard: {
        active: [
          task({ followUpId: 'plain', title: 'Plain', createdAt: minutesAgo(12), updatedAt: minutesAgo(12) }),
          task({ followUpId: 'due', title: 'Due', isDue: true }),
        ],
        deferred: [task({ followUpId: 'later', title: 'Later', status: 'deferred', deferredUntil: tomorrow.toISOString(), updatedAt: minutesAgo(1) })],
        recentResolved: [task({ followUpId: 'done', title: 'Done', status: 'resolved', resolvedAt: minutesAgo(180) })],
        archived: [],
      },
    },
  });
  assert.deepEqual(rows.map((row) => row.followUpId), ['due', 'plain', 'later', 'done'], 'due first, snoozed after open');
  const html = renderTaskRailSurface(rows, { filter: 'all' }, {});
  const fact = (id) => {
    const start = html.indexOf(`data-task-id="${id}" data-expanded`);
    return (html.slice(start).match(/<span class="(task-rail-fact[^"]*)">([^<]*)<\/span>/) || []).slice(1);
  };
  assert.deepEqual(fact('due'), ['task-rail-fact task-rail-fact--due', 'Due now']);
  assert.deepEqual(fact('plain'), ['task-rail-fact', '12m']);
  assert.deepEqual(fact('later'), ['task-rail-fact', 'Tomorrow']);
  assert.deepEqual(fact('done'), ['task-rail-fact', '3h']);
  assert.match(html, /<article class="task-rail-row task-rail-row--later" data-task-id="later"/);
  // All keeps open work first and gathers finished rows under Done.
  assert.match(html, /<b>Follow-ups<\/b>[\s\S]*data-task-id="later"[\s\S]*<div class="task-rail-group"><b>Done<\/b><\/div><article class="task-rail-row task-rail-row--resolved" data-task-id="done"/);
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
  assert.match(current, /<header class="task-rail-header"><div class="inv-segmented task-rail-filters inv-segmented--compact"[\s\S]*?<\/div><button[^>]*id="task-rail-scope"/);
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
  assert.match(html, /<span class="inv-segmented-option-label">Open 1<\/span>/);

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
  const headings = Array.from(html.matchAll(/<div class="task-rail-group"><b>([^<]*)<\/b><span>([^<]*)<\/span>(?:<button[^>]*>[^<]*<\/button>)?<\/div>/g))
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

test('the filter counts what the scope shows: open follow-ups plus open checklist steps', () => {
  const rows = scopedRows([
    { followUpId: 'a1', title: 'A1', projectId: 'project_a' },
    { followUpId: 'a2', title: 'A2', projectId: 'project_a' },
    { followUpId: 'b1', title: 'B1', projectId: 'project_b' },
    { followUpId: 'a-done', title: 'A done', projectId: 'project_a', section: 'done' },
  ]);
  const label = (html, value) => (html.match(new RegExp(`data-value="${value}"[^>]*><span class="inv-segmented-option-label">([^<]*)<`)) || [])[1];
  const all = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.equal(label(all, 'open'), 'Open 3');
  assert.equal(label(all, 'done'), 'Done 1');
  const scoped = renderTaskRailSurface(rows, UI, {
    scope: scopeHelper(), checklist: { items: [{ content: 'Step', status: 'pending' }, { content: 'Was', status: 'completed' }] },
  });
  assert.equal(label(scoped, 'open'), 'Open 3', 'two Alpha follow-ups and one open step');
  assert.equal(label(scoped, 'done'), 'Done 2');
  const empty = renderTaskRailSurface([], UI, { scope: scopeHelper() });
  assert.equal(label(empty, 'open'), 'Open', 'no count when there is nothing');
  assert.equal(label(empty, 'done'), 'Done');
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
  assert.match(html, /<b>Jenny&#39;s checklist<\/b>/);
  assert.match(html, /Chat step/);
  assert.doesNotMatch(html, /No open tasks in/, 'the empty copy is only for an empty list');
});

test('send-list sits on the first follow-up heading and only while the scope has open follow-ups', () => {
  const rows = scopedRows([{ followUpId: 'b1', title: 'Beta one', projectId: 'project_b' }]);
  const empty = renderTaskRailSurface(rows, UI, { scope: scopeHelper() });
  assert.doesNotMatch(empty, /task-rail-send-list/);
  const populated = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(populated, /<div class="task-rail-group"><b>Beta<\/b><span>1 open<\/span><button type="button" class="task-rail-group-action" data-action="task-rail-send-list">Send list to chat<\/button><\/div>/);
  const single = renderTaskRailSurface(rows, UI, { scope: scopeHelper({ mode: 'project', projectId: 'project_b', projectName: 'Beta' }) });
  assert.match(single, /<b>Follow-ups<\/b><button[^>]*data-action="task-rail-send-list"/);
  assert.equal((single.match(/task-rail-send-list/g) || []).length, 1);
  // In All, a group of finished rows never carries it; the first group with an open row does.
  const mixed = scopedRows([
    { followUpId: 'a1', title: 'Alpha done', projectId: 'project_a', section: 'done' },
    { followUpId: 'b1', title: 'Beta one', projectId: 'project_b' },
  ]);
  const allScope = renderTaskRailSurface(mixed, { filter: 'all' }, { scope: scopeHelper({ mode: 'all', projectId: '', projectName: '' }) });
  assert.match(allScope, /<b>Alpha<\/b><span>0 open &middot; this chat<\/span><\/div>[\s\S]*<b>Beta<\/b><span>1 open<\/span><button[^>]*data-action="task-rail-send-list"/);
  assert.equal((allScope.match(/task-rail-send-list/g) || []).length, 1);
});
