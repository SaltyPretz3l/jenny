'use strict';

/* A19-F4 in the renderer: an Accept whose file changed but whose record did not
 * save is not reported as plain success, and a change whose apply started but
 * never recorded its result says so on its bar. */

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/features/renderer-suggested-changes-model');
const { entry, listOf, makeClient } = require('./helpers/suggested-changes-fixtures');

test('client: an applied change whose record did not save is reported, not plain success', async () => {
  const { bridge, client } = makeClient([entry('a'), entry('b')]);
  await client.refresh('s1');
  client.setCurrent('s1', 'a');
  bridge.acceptResult = { ok: true, status: 'applied', receipt_saved: false };

  const result = await client.accept('s1', 'a', 1);

  assert.equal(result.ok, false);
  assert.equal(result.applied, true);
  assert.equal(result.receiptUnsaved, true);
  assert.match(result.message, /couldn’t record it/);
  assert.equal(client.getCurrent('s1'), 'a', 'the bar stays on the unsettled change');
});

test('model: a change whose apply never settled says so on its bar', () => {
  const unsettled = entry('a', { apply_attempt: { apply_id: '6a1c1d0e-3f2b-4c11-9b0a-7d2e8f6a5b40', revision: 1, at: '2026-10-05T01:00:00.000Z' } });
  const list = listOf([unsettled, entry('b')]);
  assert.match(model.buildBarModel(list, 'a').statusNote, /^Jenny started applying this change/);
  assert.equal(model.buildBarModel(list, 'b').statusNote, '');
});
