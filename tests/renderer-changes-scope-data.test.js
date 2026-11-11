'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scopeData = require('../renderer/features/renderer-changes-scope-data');

const settle = () => new Promise((resolve) => setImmediate(resolve));

const listing = (files, extra = {}) => ({ ok: true, state: 'available', data: { workspace_id: 'w', files, ...extra } });
const file = (path, extra = {}) => ({ path, change: 'modified', binary: false, additions: 1, deletions: 0, ...extra });

test('Working tree requests omit scope and branch requests name it', () => {
  assert.deepEqual(scopeData.listRequest('s1', 'working_tree'), { schema_version: 1, session_id: 's1' });
  assert.deepEqual(scopeData.listRequest('s1', 'branch'), { schema_version: 1, session_id: 's1', scope: 'branch' });
  assert.deepEqual(scopeData.diffRequest('s1', 'a.js', 'branch'), { schema_version: 1, session_id: 's1', scope: 'branch', path: 'a.js' });
  assert.deepEqual(scopeData.diffRequest('s1', 'a.js', 'working_tree'), { schema_version: 1, session_id: 's1', path: 'a.js' });
  assert.equal(scopeData.normalizeScope('branch'), 'branch');
  assert.equal(scopeData.normalizeScope('this_chat'), 'this_chat');
  assert.equal(scopeData.normalizeScope('anything'), 'working_tree');
});

test('applyListing reads each envelope into the slice and keeps open files only while they stay listed', () => {
  const slice = scopeData.createSlice('branch');
  assert.equal(scopeData.applyListing(slice, listing([file('a.js'), file('b.js')])), 'ready');
  assert.deepEqual(Array.from(slice.expanded), ['a.js'], 'the first file opens on the first load');
  slice.expanded.add('b.js');
  slice.diffs.set('b.js', { state: 'ready', sig: 'x' });
  assert.equal(scopeData.applyListing(slice, listing([file('b.js')])), 'ready');
  assert.deepEqual(Array.from(slice.expanded), ['b.js']);
  assert.equal(slice.diffs.has('b.js'), true);
  assert.equal(scopeData.applyListing(slice, listing([])), 'empty');
  assert.equal(scopeData.applyListing(slice, { ok: true, state: 'not_applicable', reason: 'on_base_branch', data: null }), 'not_applicable');
  assert.equal(scopeData.applyListing(slice, { ok: false }), 'unavailable');
  assert.equal(scopeData.applyListing(slice, { ok: true, state: 'available', data: null }), 'unavailable');
  assert.deepEqual(slice.files, []);
});

test('countNotFromChat is null unless the chat paths are a Set, and counts the listed files outside it', () => {
  const files = [file('a.js'), file('b.js'), file('c.js')];
  assert.equal(scopeData.countNotFromChat(files, null), null);
  assert.equal(scopeData.countNotFromChat(files, ['a.js']), null);
  assert.equal(scopeData.countNotFromChat(files, new Set(['a.js'])), 2);
  assert.equal(scopeData.countNotFromChat(files, new Set(['a.js', 'b.js', 'c.js'])), 0);
});

test('the diff loader keeps one request per file, a shared parallel limit, and scope on branch reads', async () => {
  const requests = [];
  const resolvers = [];
  const slices = { working_tree: scopeData.createSlice('working_tree'), branch: scopeData.createSlice('branch') };
  slices.working_tree.files = [file('a.js'), file('b.js')];
  slices.branch.files = [file('a.js'), file('c.js')];
  const settled = [];
  const loader = scopeData.createDiffLoader({
    getBridge: () => ({ getChangeDiff: (request) => { requests.push(request); return new Promise((resolve) => resolvers.push(() => resolve({ ok: true, binary: false, diff: '' }))); } }),
    parse: () => ({ hunks: [], truncated: false }),
    maxParallel: 2,
    log: () => {},
    isLive: (slice) => slices[slice.scope] === slice,
    onSettled: (slice) => settled.push(slice.scope),
  });
  loader.ensure(slices.working_tree, 's1', 'a.js');
  loader.ensure(slices.working_tree, 's1', 'a.js');
  loader.ensure(slices.branch, 's1', 'a.js');
  loader.ensure(slices.branch, 's1', 'c.js');
  assert.deepEqual(requests.map((request) => `${request.scope || 'working_tree'}:${request.path}`), ['working_tree:a.js', 'branch:a.js'], 'two in flight, the rest queued, a repeat ignored');
  loader.dropQueued();
  assert.equal(slices.branch.diffs.has('c.js'), false, 'a dropped queued diff is forgotten so it is asked for again');
  resolvers.forEach((resolve) => resolve());
  await settle();
  await settle();
  assert.deepEqual(settled.sort(), ['branch', 'working_tree']);
  assert.equal(slices.working_tree.diffs.get('a.js').state, 'ready');
  assert.equal(slices.branch.diffs.get('a.js').state, 'ready');
  // A replaced slice (new owner) drops the late result.
  loader.ensure(slices.branch, 's1', 'c.js');
  const orphan = slices.branch;
  slices.branch = scopeData.createSlice('branch');
  resolvers[resolvers.length - 1]();
  await settle();
  assert.equal(orphan.diffs.get('c.js').state, 'loading', 'nothing written for a slice that is no longer the page\'s');
});
