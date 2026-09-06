'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTaskRows, renderTaskRailSurface } = require('../renderer/features/renderer-task-rail-render');

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
