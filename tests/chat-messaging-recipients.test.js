'use strict';

/* chatMessages.listRecipients (row 59 checkpoint 4): profile-wide search over
 * eligible chats, ineligible ones listed disabled, order, paging and bounds. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { listRecipients, projectSessionRef } = require('../services/chat-messaging-recipients');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const V = { schema_version: 1 };
const names = { project_a: 'Alpha Project', project_b: 'Beta' };
const getProjectName = (id) => names[id] || null;

function summary(id, title, extra = {}) {
  return { id, title, project_id: '', session_type: 'chat', archived_at: null, updated_at: '2026-10-15T10:00:00.000Z', ...extra };
}

test('self and plugin chats are excluded; archived chats are listed but ineligible', () => {
  const result = listRecipients({
    summaries: [
      summary('self', 'Me'),
      summary('plug', 'A plugin', { session_type: 'plugin' }),
      summary('arch', 'Old chat', { archived_at: '2026-10-01T00:00:00.000Z' }),
      summary('live', 'Live chat', { project_id: 'project_a' }),
    ],
    sourceSessionId: 'self',
    limit: 50,
    getProjectName,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.session_id).sort(), ['arch', 'live']);
  const live = result.items.find((item) => item.session_id === 'live');
  assert.deepEqual(live, {
    session_id: 'live', title: 'Live chat', project_id: 'project_a', project_name: 'Alpha Project', eligible: true, ineligible_reason: null,
    grant: null,
  });
  const archived = result.items.find((item) => item.session_id === 'arch');
  assert.equal(archived.eligible, false);
  assert.equal(archived.ineligible_reason, 'archived');
  assert.equal(archived.project_id, null, 'an empty project id projects as null');
});

test('a non-continuable chat is listed with its reason, and a throwing predicate fails closed', () => {
  const base = { summaries: [summary('a', 'A')], sourceSessionId: 'x', limit: 50 };
  assert.equal(listRecipients({ ...base, isContinuable: () => false }).items[0].ineligible_reason, 'not_continuable');
  assert.equal(listRecipients({ ...base, isContinuable: () => { throw new Error('x'); } }).items[0].eligible, false);
});

test('query matches title and project name case-insensitively and orders by recency then id', () => {
  const summaries = [
    summary('c', 'Quarterly PLAN', { updated_at: '2026-10-15T09:00:00.000Z' }),
    summary('a', 'plan b', { updated_at: '2026-10-15T11:00:00.000Z' }),
    summary('b', 'Other', { updated_at: '2026-10-15T10:00:00.000Z', project_id: 'project_a' }),
    summary('d', 'plan d', { updated_at: '2026-10-15T11:00:00.000Z' }),
  ];
  const byTitle = listRecipients({ summaries, sourceSessionId: 'x', query: 'PLAN', limit: 50, getProjectName });
  assert.deepEqual(byTitle.items.map((item) => item.session_id), ['a', 'd', 'c']);
  const byProject = listRecipients({ summaries, sourceSessionId: 'x', query: 'alpha', limit: 50, getProjectName });
  assert.deepEqual(byProject.items.map((item) => item.session_id), ['b']);
  assert.deepEqual(listRecipients({ summaries, sourceSessionId: 'x', query: 'nothing', limit: 50, getProjectName }).items, []);
});

test('keyset paging is complete and stable; a cursor for another search is stale', () => {
  const summaries = Array.from({ length: 7 }, (_, n) => summary(`s${n}`, `chat ${n}`, { updated_at: `2026-10-15T10:00:0${n}.000Z` }));
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5 && (page === 0 || cursor); page += 1) {
    const result = listRecipients({ summaries, sourceSessionId: 'x', cursor, limit: 3, getProjectName });
    assert.equal(result.ok, true);
    seen.push(...result.items.map((item) => item.session_id));
    cursor = result.next_cursor;
  }
  assert.deepEqual(seen, ['s6', 's5', 's4', 's3', 's2', 's1', 's0']);
  const first = listRecipients({ summaries, sourceSessionId: 'x', limit: 3, getProjectName });
  const other = listRecipients({ summaries, sourceSessionId: 'x', query: 'chat', cursor: first.next_cursor, limit: 3, getProjectName });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'stale_cursor');
  const again = listRecipients({ summaries, sourceSessionId: 'x', limit: 3, getProjectName });
  assert.equal(again.revision, first.revision, 'the fingerprint of an unchanged set is stable');
  assert.ok(Number.isSafeInteger(first.revision));
  const changed = listRecipients({ summaries: summaries.slice(1), sourceSessionId: 'x', limit: 3, getProjectName });
  assert.notEqual(changed.revision, first.revision);
});

test('titles and project names are bounded to 512 UTF-8 bytes on a code point boundary', () => {
  const long = String.fromCodePoint(0x1f600).repeat(300);
  const result = listRecipients({
    summaries: [summary('a', long, { project_id: 'project_long' })],
    sourceSessionId: 'x',
    limit: 50,
    getProjectName: () => long,
  });
  assert.ok(Buffer.byteLength(result.items[0].title, 'utf8') <= 512);
  assert.ok(Buffer.byteLength(result.items[0].project_name, 'utf8') <= 512);
  assert.equal(result.items[0].title.isWellFormed(), true);
});

test('projectSessionRef marks a missing chat unavailable with no title', () => {
  assert.deepEqual(projectSessionRef('gone', null, getProjectName), {
    session_id: 'gone', available: false, title: null, project_id: null, project_name: null,
  });
});

test('the service lists recipients from the live store and validates the closed request', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const live = f.sessionId('Roadmap notes', { projectId: 'project_a' });
  const archived = f.sessionId('Archived idea');
  f.archive(archived);
  const deleted = f.sessionId('Deleted soon');
  f.store.deleteSession(deleted);
  const result = await f.service.listRecipients({ ...V, source_session_id: src });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.session_id).sort(), [archived, live].sort());
  assert.equal(result.items.find((item) => item.session_id === live).project_name, 'Alpha');
  assert.equal(result.items.find((item) => item.session_id === archived).ineligible_reason, 'archived');
  assert.equal(result.next_cursor, null);
  const searched = await f.service.listRecipients({ ...V, source_session_id: src, query: 'ROADMAP' });
  assert.deepEqual(searched.items.map((item) => item.session_id), [live]);
  const bad = [
    { ...V, source_session_id: src, query: 'x'.repeat(201) },
    { ...V, source_session_id: src, limit: 51 },
    { ...V, source_session_id: src, limit: 0 },
    { ...V, source_session_id: src, cursor: 'a b' },
    { ...V, source_session_id: src, extra: 1 },
    { ...V },
    { source_session_id: src },
  ];
  for (const raw of bad) assert.equal((await f.service.listRecipients(raw)).error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.listRecipients({ ...V, source_session_id: 'sess_missing' })).reason, 'not_found');
  const wide = await f.service.listRecipients({ ...V, source_session_id: src, query: String.fromCharCode(0xe9).repeat(100) });
  assert.equal(wide.ok, true, '200 UTF-8 bytes is the bound, not 200 characters');
  const tooWide = await f.service.listRecipients({ ...V, source_session_id: src, query: String.fromCharCode(0xe9).repeat(101) });
  assert.equal(tooWide.error_code, CODES.INVALID_REQUEST);
});

test('grantFor decorates each item and changes the revision fingerprint; a missing or falsy lookup is null', () => {
  const base = { summaries: [summary('a', 'A'), summary('b', 'B')], sourceSessionId: 'x', limit: 50 };
  const grant = { grant_id: '11111111-1111-4111-8111-111111111111', purpose: 'p', expires_at: '2026-10-22T10:00:00.000Z', remaining_sends: 100 };
  const plain = listRecipients(base);
  const decorated = listRecipients({ ...base, grantFor: (item) => (item.id === 'a' ? grant : undefined) });
  assert.deepEqual(decorated.items.map((item) => item.grant), [grant, null]);
  assert.deepEqual(plain.items.map((item) => item.grant), [null, null]);
  assert.notEqual(decorated.revision, plain.revision, 'a new grant invalidates the listed set');
});
