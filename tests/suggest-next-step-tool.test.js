'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const suggestNextStepTool = require('../services/tools/builtin/suggest-next-step-tool');
const { normalizeNextStepResultMetadata, LIMITS } = require('../services/backend/next-step-result-metadata');
const { normalizePersistedToolResultMetadata } = require('../services/backend/tool-result-diff-metadata');
const { createDefaultRegistry } = require('../services/tools');

const run = (input) => suggestNextStepTool.execute(input, {});

describe('suggest_next_step execute', () => {
  test('recap only succeeds with a null question and no actions', async () => {
    const result = await run({ recap: 'Fixed the parser.' });
    assert.notEqual(result.isError, true);
    assert.match(result.content, /next-step card is shown/);
    assert.match(result.content, /write nothing more/);
    assert.doesNotMatch(result.content, /finish with|sentences/i);
    assert.deepEqual(result.metadata, {
      schema_version: 1, result_kind: 'next_step', recap: 'Fixed the parser.', question: null, actions: [],
    });
  });

  test('recap, question and three actions return normalized metadata', async () => {
    const result = await run({
      recap: 'Tests pass.',
      question: 'Commit now?',
      actions: [
        { label: 'Commit', message: 'Commit it.' },
        { label: 'Review', message: 'Show me the diff.' },
        { label: 'Not now', message: 'Leave it.' },
      ],
    });
    assert.equal(result.metadata.question, 'Commit now?');
    assert.deepEqual(result.metadata.actions.map((a) => a.label), ['Commit', 'Review', 'Not now']);
    assert.equal(result.metadata.actions[1].message, 'Show me the diff.');
  });

  test('whitespace runs collapse to one space', async () => {
    const result = await run({
      recap: '  Line one.\n\nLine   two.  ',
      question: ' Pick\tone? ',
      actions: [{ label: '  Go   now ', message: 'do\nit\n now' }],
    });
    assert.equal(result.metadata.recap, 'Line one. Line two.');
    assert.equal(result.metadata.question, 'Pick one?');
    assert.deepEqual(result.metadata.actions, [{ label: 'Go now', message: 'do it now' }]);
  });

  test('over-long strings truncate with an ellipsis at the exact limit', async () => {
    const result = await run({
      recap: 'r'.repeat(400),
      question: 'q'.repeat(150),
      actions: [{ label: 'l'.repeat(40), message: 'm'.repeat(500) }],
    });
    assert.equal(result.metadata.recap, `${'r'.repeat(299)}…`);
    assert.equal(result.metadata.question, `${'q'.repeat(99)}…`);
    assert.equal(result.metadata.actions[0].label, `${'l'.repeat(23)}…`);
    assert.equal(result.metadata.actions[0].message, `${'m'.repeat(299)}…`);
    assert.equal(result.metadata.recap.length, LIMITS.recap);
    assert.equal(result.metadata.question.length, LIMITS.question);
  });

  test('strings exactly at the limit are untouched', async () => {
    const result = await run({ recap: 'r'.repeat(300), question: 'q'.repeat(100),
      actions: [{ label: 'l'.repeat(24), message: 'm'.repeat(300) }] });
    assert.equal(result.metadata.recap, 'r'.repeat(300));
    assert.equal(result.metadata.actions[0].label, 'l'.repeat(24));
  });

  const rejected = [
    ['empty recap', { recap: '   ' }, /recap/],
    ['missing recap', {}, /recap/],
    ['four actions', { recap: 'x', actions: [1, 2, 3, 4].map((n) => ({ label: `L${n}`, message: 'm' })) }, /actions/],
    ['empty label', { recap: 'x', actions: [{ label: ' ', message: 'm' }] }, /label/],
    ['empty message', { recap: 'x', actions: [{ label: 'L', message: '' }] }, /message/],
    ['question without actions', { recap: 'x', question: 'Why?' }, /question needs at least one action/],
    ['question with empty actions', { recap: 'x', question: 'Why?', actions: [] }, /question needs at least one action/],
    ['non-array actions', { recap: 'x', actions: 'go' }, /actions/],
    ['non-string recap', { recap: 42 }, /recap/],
    ['non-string question', { recap: 'x', question: 7, actions: [{ label: 'L', message: 'm' }] }, /question/],
    ['non-string label', { recap: 'x', actions: [{ label: 3, message: 'm' }] }, /label/],
  ];
  for (const [name, input, pattern] of rejected) {
    test(`rejects ${name}`, async () => {
      const result = await run(input);
      assert.equal(result.isError, true);
      assert.match(result.content, /^suggest_next_step:/);
      assert.match(result.content, pattern);
      assert.equal(result.metadata?.result_kind === 'next_step', false);
    });
  }

  test('summarize reads as a fixed line', () => {
    assert.equal(suggestNextStepTool.summarize({ recap: 'x' }), 'Suggested a next step');
    assert.equal(suggestNextStepTool.summarize(null), 'Suggested a next step');
  });
});

describe('next-step result metadata', () => {
  const valid = () => ({
    schema_version: 1, result_kind: 'next_step', recap: 'Done.', question: 'Ship?',
    actions: [{ label: 'Ship', message: 'Ship it.' }],
  });

  test('accepts the success shape', () => {
    const out = normalizeNextStepResultMetadata(valid());
    assert.deepEqual(out, {
      result_kind: 'next_step', schema_version: 1, recap: 'Done.', question: 'Ship?',
      actions: [{ label: 'Ship', message: 'Ship it.' }],
    });
  });

  test('accepts a null question with no actions', () => {
    const out = normalizeNextStepResultMetadata({ ...valid(), question: null, actions: [] });
    assert.equal(out.question, null);
    assert.deepEqual(out.actions, []);
  });

  test('rejects another result_kind, wrong version and non-objects', () => {
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), result_kind: 'home' }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), schema_version: 2 }), {});
    assert.deepEqual(normalizeNextStepResultMetadata(null), {});
    assert.deepEqual(normalizeNextStepResultMetadata([]), {});
  });

  test('rejects oversize and extra-shape values', () => {
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), recap: 'r'.repeat(301) }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), question: 'q'.repeat(101) }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), recap: '' }), {});
    const four = [1, 2, 3, 4].map((n) => ({ label: `L${n}`, message: 'm' }));
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), actions: four }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), actions: [{ label: 'L'.repeat(25), message: 'm' }] }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), actions: [{ label: 'L', message: 'm', extra: 1 }] }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), question: 5 }), {});
    assert.deepEqual(normalizeNextStepResultMetadata({ ...valid(), actions: 'x' }), {});
  });

  test('the persisted normalizer keeps a next_step object and drops unknown keys', () => {
    const stored = normalizePersistedToolResultMetadata({ ...valid(), stray: 'gone' });
    assert.deepEqual(stored, {
      result_kind: 'next_step', schema_version: 1, recap: 'Done.', question: 'Ship?',
      actions: [{ label: 'Ship', message: 'Ship it.' }],
    });
    const again = normalizePersistedToolResultMetadata(stored);
    assert.deepEqual(again, stored);
  });
});

describe('suggest_next_step registration', () => {
  test('the registry registers the tool only when the flag option is true', () => {
    const names = (options) => createDefaultRegistry(options).getAllTools().map((tool) => tool.name);
    assert.equal(names({}).includes('suggest_next_step'), false);
    assert.equal(names({ toolsNextStepEnabled: false }).includes('suggest_next_step'), false);
    assert.equal(names({ toolsNextStepEnabled: true }).includes('suggest_next_step'), true);
  });
});

describe('suggest_next_step action message spellings', () => {
  const withAction = (action) => ({ recap: 'Done.', question: 'Next?', actions: [action] });

  test('action or text is accepted for message when message is absent', async () => {
    for (const key of ['action', 'text']) {
      const result = await run(withAction({ label: 'Commit', [key]: 'Commit it.' }));
      assert.notEqual(result.isError, true, key);
      assert.deepEqual(result.metadata.actions, [{ label: 'Commit', message: 'Commit it.' }], key);
    }
  });

  test('a repeated value under several names is fine', async () => {
    const result = await run(withAction({ label: 'Go', message: 'Do it.', text: 'Do it.' }));
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.metadata.actions, [{ label: 'Go', message: 'Do it.' }]);
  });

  test('different values under two names fail and say which names conflict', async () => {
    // A present message wins; an extra name beside it is ignored, as it always was.
    const result = await run(withAction({ label: 'Go', message: 'Do it.', action: 'commit' }));
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.metadata.actions, [{ label: 'Go', message: 'Do it.' }]);
    const both = await run(withAction({ label: 'Go', action: 'A.', text: 'B.' }));
    assert.equal(both.isError, true);
    assert.match(both.content, /action/);
    assert.match(both.content, /text/);
  });

  test('a message that is not text still fails as before', async () => {
    const result = await run(withAction({ label: 'Go', action: 5 }));
    assert.equal(result.isError, true);
    assert.match(result.content, /message must be a string/);
  });
});
