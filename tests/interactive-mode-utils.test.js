const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INTERACTIVE_OTHER_OPTION_ID,
  allQuestionsAnswered,
  buildQuestionOptionsWithOther,
  INTERACTIVE_PROTOCOL_DRIFT_NOTICE,
  getNextUnansweredIndex,
  getComposerStatusNotice,
  isOtherTrigger,
  isQuestionAnswered,
} = require('../renderer/features/interactive-mode-utils');

test('interactive mode utils returns actionable protocol drift notice copy', () => {
  assert.equal(
    getComposerStatusNotice('protocol_drift'),
    INTERACTIVE_PROTOCOL_DRIFT_NOTICE
  );
  assert.match(INTERACTIVE_PROTOCOL_DRIFT_NOTICE, /requested a direct answer/i);
  assert.match(INTERACTIVE_PROTOCOL_DRIFT_NOTICE, /information already collected/i);
});

test('interactive mode utils returns no composer notice for unknown keys', () => {
  assert.equal(getComposerStatusNotice('unknown'), '');
});

test('interactive mode utils appends a synthetic Other option only when needed', () => {
  const withoutOther = buildQuestionOptionsWithOther({
    options: [
      { id: 'steady', label: 'Steady' },
      { id: 'fast', label: 'Fast' },
    ],
  });
  assert.equal(withoutOther.at(-1).id, INTERACTIVE_OTHER_OPTION_ID);
  assert.equal(withoutOther.at(-1).label, 'Other');

  const withOther = buildQuestionOptionsWithOther({
    options: [
      { id: 'clarity', label: 'Clarity' },
      { id: 'custom', label: 'other' },
    ],
  });
  assert.equal(withOther.length, 2);
  assert.equal(withOther.at(-1).id, 'custom');
});

test('interactive mode utils treat confirmed Other answers as answered', () => {
  const question = {
    id: 'q2',
    options: [
      { id: 'clarity', label: 'Clarity' },
      { id: 'other', label: 'Other' },
    ],
  };
  const draft = {
    selections: { q2: 'other' },
    customTextByQuestionId: { q2: 'Focus on stakeholder alignment' },
    customModeByQuestionId: { q2: false },
  };

  assert.equal(isOtherTrigger(question, 'other'), true);
  assert.equal(isQuestionAnswered(question, draft), true);
});

test('interactive mode utils require Other answers to be confirmed before batch submit', () => {
  const batch = {
    questions: [
      {
        id: 'q1',
        options: [
          { id: 'steady', label: 'Steady' },
          { id: 'fast', label: 'Fast' },
        ],
      },
      {
        id: 'q2',
        options: [
          { id: 'clarity', label: 'Clarity' },
          { id: 'other', label: 'Other' },
        ],
      },
    ],
  };
  const draft = {
    selections: { q1: 'steady', q2: 'other' },
    customTextByQuestionId: { q2: 'Something custom' },
    customModeByQuestionId: { q2: true },
  };

  assert.equal(allQuestionsAnswered(batch, draft), false);
  draft.customModeByQuestionId.q2 = false;
  assert.equal(allQuestionsAnswered(batch, draft), true);
});

test('interactive mode utils find the next unanswered question after the active step', () => {
  const batch = {
    questions: [
      { id: 'q1', options: [{ id: 'a', label: 'A' }] },
      { id: 'q2', options: [{ id: 'b', label: 'B' }] },
      { id: 'q3', options: [{ id: 'c', label: 'C' }] },
    ],
  };
  const draft = {
    selections: { q1: 'a', q3: 'c' },
    customTextByQuestionId: {},
    customModeByQuestionId: {},
  };

  assert.equal(getNextUnansweredIndex(batch, draft, 0), 1);
  assert.equal(getNextUnansweredIndex(batch, draft, 2), 1);

  draft.selections.q2 = 'b';
  assert.equal(getNextUnansweredIndex(batch, draft, 2), -1);
});
