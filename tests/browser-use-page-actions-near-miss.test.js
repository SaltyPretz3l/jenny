'use strict';

// Near-miss input the browser tools accept: an element reference copied with its brackets or spaces, and a
// bare localhost address with no scheme. Anything that is not exactly one well-formed reference or a
// local development address stays refused.

const test = require('node:test');
const assert = require('node:assert/strict');

const { logNames } = require('./helpers/fake-web-contents-view');
const { harness } = require('./helpers/browser-use-page-actions-harness');

test('a reference copied as [r12], with spaces, or both resolves to r12', async () => {
  for (const spelling of ['[r12]', ' r12 ', ' [r12] ', 'r12']) {
    const h = harness();
    const result = await h.actions.click({ ref: spelling });
    assert.equal(result.status, 'clicked', JSON.stringify(spelling));
    assert.equal(h.calls('probe')[0].args.ref, 'r12', JSON.stringify(spelling));
  }
  const read = harness();
  await read.actions.read({ ref: '[r4]' });
  assert.equal(read.calls('read')[0].args.ref, 'r4');
});

test('anything that is not exactly one reference is refused and the message shows the accepted form', async () => {
  for (const bad of ['[r12', 'r12]', '[[r12]]', '[r12][r13]', 'r12 r13', 'ref=r12', '[]', '[ ]', 'x12', '[r12];x', '']) {
    const h = harness();
    const result = await h.actions.click({ ref: bad });
    assert.equal(result.status, 'invalid_arguments', JSON.stringify(bad));
    assert.match(result.message, /r12/, 'the message shows an example reference');
    assert.match(result.message, /\[r12\]|brackets/i, 'the message says brackets are fine');
    assert.deepEqual(h.log, []);
  }
});

test('navigate to localhost:3000 loads http://localhost:3000 through the same gate', async () => {
  for (const [given, expected] of [
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost:3000/docs?x=1', 'http://localhost:3000/docs?x=1'],
    ['LOCALHOST', 'http://LOCALHOST'],
    ['127.0.0.1:8080/a', 'http://127.0.0.1:8080/a'],
    ['127.0.0.1', 'http://127.0.0.1'],
  ]) {
    const h = harness();
    const result = await h.actions.navigate({ url: given });
    assert.equal(result.status, 'navigated', given);
    assert.deepEqual(h.log[0].args, [expected], given);
    assert.ok(logNames(h.log).includes('wc.loadURL'));
    assert.equal(h.log.find((entry) => entry.name === 'loadURL').args[0], expected);
  }
});

test('other scheme-less or foreign-scheme addresses reach the gate exactly as given', async () => {
  for (const given of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,hi', 'example.com', 'localhost.evil.test:3000',
    'localhost@evil.test', 'localhost:3000@evil.test', '10.0.0.5:3000']) {
    const h = harness();
    await h.actions.navigate({ url: given });
    assert.deepEqual(h.log[0].args, [given], given);
  }
});
