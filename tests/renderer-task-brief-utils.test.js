'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTaskBrief,
  TASK_BRIEF_FOOTER_PREFIX,
  MAX_TASK_BRIEF_CHARS,
} = require('../renderer/shared/task-brief-utils');

test('task brief footer carries the linked task id', () => {
  const brief = buildTaskBrief({ title: 'Ship it', body: 'Finish the slice.' }, { linkedTaskId: 'task-17' });
  assert.match(brief, new RegExp(`${TASK_BRIEF_FOOTER_PREFIX}task-17`));
  assert.match(brief, /task_board \{ action: "complete", id: "task-17" \}/);
});

test('task brief clips long notes while preserving the footer and id', () => {
  const brief = buildTaskBrief({ title: 'Ship it', body: 'x'.repeat(4000) }, { linkedTaskId: 'task-17' });
  assert.ok(brief.length <= MAX_TASK_BRIEF_CHARS);
  assert.equal(MAX_TASK_BRIEF_CHARS, 4202);
  assert.ok(brief.includes(TASK_BRIEF_FOOTER_PREFIX));
  assert.ok(brief.includes('task-17'));
});

test('task brief has no footer without a linked task id', () => {
  const brief = buildTaskBrief({ title: 'Ship it', body: 'Finish the slice.' });
  assert.equal(brief.includes(TASK_BRIEF_FOOTER_PREFIX), false);
});

test('task brief with an id and no notes puts the footer right after the title', () => {
  const brief = buildTaskBrief({ title: 'Ship it' }, { linkedTaskId: 'task-17' });
  assert.equal(brief.startsWith(`Ship it\n\n${TASK_BRIEF_FOOTER_PREFIX}task-17`), true);
  assert.equal(brief.includes('\n\n\n'), false);
});

test('task brief without an id matches the legacy title and notes form', () => {
  assert.equal(
    buildTaskBrief({ title: ' Ship it ', body: ' Finish the slice. ' }),
    'Ship it\n\nFinish the slice.'
  );
});
