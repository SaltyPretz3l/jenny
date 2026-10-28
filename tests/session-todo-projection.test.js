'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { latestTodoList } = require('../services/backend/session-todo-projection');

const todoRow = (output, extra = {}) => ({ kind: 'tool_result', role: 'tool', turn_id: extra.turn_id || 'turn_1',
  tool_result: { tool_name: 'todo_write', output_text: typeof output === 'string' ? output : JSON.stringify(output),
    ...(extra.tool_result || {}) }, ...(extra.message || {}) });

test('no todo_write in the transcript projects as null', () => {
  assert.equal(latestTodoList([]), null);
  assert.equal(latestTodoList(null), null);
  assert.equal(latestTodoList([{ role: 'user', content: 'hi' }, { kind: 'tool_result', tool_result: { tool_name: 'read_file' } }]), null);
});

test('the newest successful todo_write wins and statuses are normalized', () => {
  const messages = [
    todoRow({ todos: [{ content: 'old', status: 'pending' }] }, { turn_id: 'turn_old' }),
    todoRow({ todos: [{ content: '  first  ', status: 'IN_PROGRESS' }, { content: 'second', status: 'bogus' },
      { content: '', status: 'pending' }, { content: 'x'.repeat(400), status: 'completed' }] }, { turn_id: 'turn_new' }),
    todoRow({ todos: [{ content: 'failed write', status: 'pending' }] }, { tool_result: { is_error: true } }),
    todoRow({ todos: [{ content: 'coded error', status: 'pending' }] }, { tool_result: { error_code: 'CMP-TOOL-0001' } }),
  ];
  const list = latestTodoList(messages);
  assert.equal(list.source_turn, 'turn_new');
  assert.deepEqual(list.items.slice(0, 2), [{ content: 'first', status: 'in_progress' }, { content: 'second', status: 'pending' }]);
  assert.equal(list.items.length, 3);
  assert.equal(list.items[2].content.length, 300);
});

test('a newest cleared answer empties the list, and unparsable output is an empty list', () => {
  const finished = [todoRow({ todos: [{ content: 'done', status: 'completed' }] }), todoRow({ cleared: true }, { turn_id: 'turn_2' })];
  assert.deepEqual(latestTodoList(finished), { items: [], source_turn: 'turn_2' });
  assert.deepEqual(latestTodoList([todoRow('not json', { turn_id: 'turn_3' })]), { items: [], source_turn: 'turn_3' });
  const capped = latestTodoList([todoRow({ todos: Array.from({ length: 80 }, (_, i) => ({ content: `t${i}` })) })]);
  assert.equal(capped.items.length, 50);
});
