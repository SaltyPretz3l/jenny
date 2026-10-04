'use strict';

// Recent history scope and a persisted compaction summary (CMC-001): the
// summary row a snapshot puts ahead of the first user turn rides along with
// the last six turn groups; nothing else before the first user turn does.

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectContextHistoryMessages } = require('../services/backend/chat-stream-reasoning');

test('selectContextHistoryMessages keeps a leading compaction summary ahead of the recent groups', () => {
  const summary = { role: 'system', content: '## Compacted Conversation Summary\nEarlier turns.' };
  const messages = [summary];
  for (let index = 1; index <= 8; index += 1) {
    messages.push({ role: 'user', content: `Question ${index}` });
    messages.push({ role: 'assistant', content: `Answer ${index}` });
  }

  const selected = selectContextHistoryMessages(messages, { history_scope: 'recent' });

  assert.equal(selected.length, 13);
  assert.equal(selected[0], summary);
  assert.equal(selected[1].content, 'Question 3');
  assert.equal(selected.at(-1).content, 'Answer 8');
});

test('selectContextHistoryMessages still drops a leading non-summary system row in recent mode', () => {
  const messages = [
    { role: 'system', content: 'Persona note, not a compaction summary.' },
    { role: 'assistant', content: 'Orphan reply before any user turn.' },
  ];
  for (let index = 1; index <= 2; index += 1) {
    messages.push({ role: 'user', content: `Question ${index}` });
    messages.push({ role: 'assistant', content: `Answer ${index}` });
  }

  const selected = selectContextHistoryMessages(messages, { history_scope: 'recent' });

  assert.deepEqual(selected.map((message) => message.content), [
    'Question 1', 'Answer 1', 'Question 2', 'Answer 2',
  ]);
});

