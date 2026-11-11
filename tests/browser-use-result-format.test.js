'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fail, formatForModel, stepSummary } = require('../services/browser-use/result-format');
const manifest = require('../services/tools/tool-manifest.json');

const { description: BROWSER_TOOL_DESCRIPTION, parameters: BROWSER_TOOL_PARAMETERS } = manifest.tools.find(item => item.name === 'browser');

const PAGE = Object.freeze({
  status: 'ok', title: 'Example Domain', url: 'https://example.com/', text: 'Page: Example Domain\nURL: https://example.com/\n\n# Example',
});

test('an action result puts the message first and the page after it', () => {
  assert.equal(
    formatForModel({ ok: true, status: 'clicked', message: 'Clicked r4.', page: PAGE }),
    `Clicked r4.\n\n${PAGE.text}`,
  );
});

test('a read needs no message above the outline', () => {
  assert.equal(formatForModel({ ok: true, status: 'ok', message: 'Page read.', page: PAGE }), PAGE.text);
});

test('detail reaches the model and never the saved step summary', () => {
  const result = fail('no_such_option', 'r4 has no such option.', 'Available options: Secret Plan, Other.');
  assert.equal(formatForModel(result), 'r4 has no such option. Available options: Secret Plan, Other.');
  assert.equal(stepSummary(result), 'r4 has no such option.');
  assert.equal(formatForModel({ ...result, page: PAGE }), `r4 has no such option. Available options: Secret Plan, Other.\n\n${PAGE.text}`);
  assert.deepEqual(fail('stale_ref', 'gone', ''), { ok: false, status: 'stale_ref', message: 'gone' });
});

test('a result with no page is just its message', () => {
  assert.equal(formatForModel({ ok: false, status: 'stale_ref', message: 'r4 is gone.' }), 'r4 is gone.');
});

test('find lists one match per line with its ref', () => {
  const text = formatForModel({
    ok: true, status: 'ok', message: 'Found 2 matches.', total: 2,
    matches: [
      { ref: 'r3', role: 'link', name: 'Docs', snippet: 'Read the docs' },
      { ref: '', role: 'text', name: '', snippet: 'plain text hit' },
    ],
  });
  assert.equal(text, 'Found 2 matches.\n[r3] link "Docs": Read the docs\nplain text hit');
});

test('find says when it shows fewer than it found', () => {
  const text = formatForModel({
    ok: true, status: 'ok', message: 'Found 45 matches.', total: 45,
    matches: [{ ref: 'r3', role: 'link', name: 'A', snippet: 'A' }],
  });
  assert.match(text, /Showing the first 1\. Narrow the search for the rest\.$/);
});

test('a step summary says what happened and where, without the page text', () => {
  const summary = stepSummary({ ok: true, status: 'clicked', message: 'Clicked r4.', page: PAGE });
  assert.equal(summary, 'Clicked r4. Now on Example Domain (https://example.com/)');
  assert.equal(summary.includes('# Example'), false);
});

test('a step summary with no page is the message alone', () => {
  assert.equal(stepSummary({ ok: false, status: 'declined', message: 'Not allowed.' }), 'Not allowed.');
});

test('a step summary is one bounded line', () => {
  const summary = stepSummary({
    ok: true, status: 'navigated', message: 'Went\nback.',
    page: { title: 'T'.repeat(900), url: `https://example.com/${'x'.repeat(900)}` },
  });
  assert.equal(summary.includes('\n'), false);
  assert.ok(summary.length <= 300, String(summary.length));
});

test('the find matches never reach a step summary', () => {
  const summary = stepSummary({
    ok: true, status: 'ok', message: 'Found 1 match.', total: 1,
    matches: [{ ref: 'r1', role: 'text', name: '', snippet: 'private page text' }],
  });
  assert.equal(summary, 'Found 1 match.');
});

test('the description teaches refs, one step per call and when to stop', () => {
  for (const pattern of [/\[r12\]/, /latest result/i, /untrusted|instructions found in/i, /CAPTCHA/, /take over/i, /scroll|find/]) {
    assert.match(BROWSER_TOOL_DESCRIPTION, pattern);
  }
  assert.ok(BROWSER_TOOL_DESCRIPTION.length < 1400, 'every local request pays for this text');
});

test('the parameters offer exactly the eleven actions and require only action', () => {
  assert.deepEqual(BROWSER_TOOL_PARAMETERS.required, ['action']);
  assert.deepEqual(BROWSER_TOOL_PARAMETERS.properties.action.enum, [
    'navigate', 'read', 'find', 'click', 'type', 'select', 'scroll', 'press', 'screenshot', 'close', 'ad_block',
  ]);
  assert.equal(BROWSER_TOOL_PARAMETERS.additionalProperties, false);
});
