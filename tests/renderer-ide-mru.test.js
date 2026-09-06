'use strict';

/* renderer-ide-mru — the runtime file-tab MRU extracted from the IDE
 * controller (Ctrl+E jump list). Pure state; no DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeMru } = require('../renderer/features/renderer-ide-mru');

function makeMru() {
  return createIdeMru({
    isDiffTabId: (p) => String(p).startsWith('diff://'),
    isPreviewTabId: (p) => String(p).startsWith('preview://'),
  });
}

test('record keeps most-recent-first order and dedupes re-activations', () => {
  const mru = makeMru();
  mru.record('a.js');
  mru.record('b.js');
  mru.record('c.js');
  mru.record('a.js'); // re-activate -> moves to front, no duplicate
  const open = [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }];
  assert.deepEqual(mru.getRecentFiles(open), ['a.js', 'c.js', 'b.js']);
});

test('diff/preview surfaces and empty paths never enter the list', () => {
  const mru = makeMru();
  mru.record('diff://change/x');
  mru.record('preview://y');
  mru.record('');
  mru.record(null);
  mru.record('real.js');
  assert.deepEqual(mru.getRecentFiles([{ path: 'real.js' }, { path: 'diff://change/x' }]), ['real.js']);
});

test('getRecentFiles filters to still-open tabs without evicting the record', () => {
  const mru = makeMru();
  mru.record('a.js');
  mru.record('b.js');
  // b.js closed: filtered at read...
  assert.deepEqual(mru.getRecentFiles([{ path: 'a.js' }]), ['a.js']);
  // ...but returns when reopened (record kept).
  assert.deepEqual(mru.getRecentFiles([{ path: 'a.js' }, { path: 'b.js' }]), ['b.js', 'a.js']);
  // Hostile inputs.
  assert.deepEqual(mru.getRecentFiles(undefined), []);
  assert.deepEqual(mru.getRecentFiles([null, {}]), []);
});

test('the runtime list is capped at 128 entries', () => {
  const mru = makeMru();
  for (let i = 0; i < 140; i += 1) {
    mru.record(`f${i}.js`);
  }
  const open = [];
  for (let i = 0; i < 140; i += 1) {
    open.push({ path: `f${i}.js` });
  }
  const recent = mru.getRecentFiles(open);
  assert.equal(recent.length, 128);
  assert.equal(recent[0], 'f139.js');
  assert.equal(recent.includes('f11.js'), false, 'oldest entries evicted past the cap');
});

test('root reset clears same-relative-path recency', () => {
  const mru = makeMru();
  mru.record('same.js');
  assert.deepEqual(mru.getRecentFiles([{ path: 'same.js' }]), ['same.js']);
  mru.clear();
  assert.deepEqual(mru.getRecentFiles([{ path: 'same.js' }]), []);
});

test('missing deps default to never-filtering (no throw)', () => {
  const mru = createIdeMru();
  mru.record('diff://still-recorded-without-deps');
  assert.deepEqual(
    mru.getRecentFiles([{ path: 'diff://still-recorded-without-deps' }]),
    ['diff://still-recorded-without-deps']
  );
});
