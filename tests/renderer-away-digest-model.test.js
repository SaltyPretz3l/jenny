'use strict';

/**
 * tests/renderer-away-digest-model.test.js
 *
 * Runtime UX A4 (JEN-059) gate — the "While you were away" model.
 *
 * The model is the honesty boundary for the digest: it lists only work that
 * reached a terminal state, only what finished after the applicable cursors,
 * and it derives "older than 30 days" from the row's own
 * `updated_at` against an injected clock, so nothing claims a compaction it
 * cannot see. Usage is projected separately so no dollar field can cross the
 * model boundary.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAwayDigest,
  tokensForStream,
  RETENTION_MS,
  TERMINAL_STATUSES,
  IN_PROGRESS_STATUSES,
  DEFAULT_ROW_LIMIT,
} = require('../renderer/shell/renderer-away-digest-model');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

const work = (overrides = {}) => ({
  work_id: 'w1',
  project_id: 'p1',
  session_id: 's1',
  turn_id: 't1',
  purpose: 'root_chat',
  status: 'completed',
  revision: 2,
  submission_sequence: 1,
  created_at: at(2 * 60 * 60 * 1000),
  updated_at: at(60 * 60 * 1000),
  ...overrides,
});

const session = (id, title) => ({ id, title });

const build = (options = {}) => buildAwayDigest({ now: NOW, ...options });

test('only terminal work is listed, and every non-terminal status is dropped', () => {
  const digest = build({
    work: [
      work({ work_id: 'done', status: 'completed', updated_at: at(60000) }),
      work({ work_id: 'broke', status: 'failed', updated_at: at(120000) }),
      work({ work_id: 'stopped', status: 'cancelled', updated_at: at(180000) }),
      work({ work_id: 'pending', status: 'pending', updated_at: at(1000) }),
      work({ work_id: 'paused', status: 'paused', updated_at: at(2000) }),
      work({ work_id: 'running', status: 'running', updated_at: at(3000) }),
      work({ work_id: 'asking', status: 'needs_attention', updated_at: at(4000) }),
    ],
    sessions: [session('s1', 'Chat one')],
  });
  assert.deepEqual(digest.rows.map((row) => row.workId), ['done', 'broke', 'stopped']);
  assert.deepEqual(digest.rows.map((row) => row.outcome), ['completed', 'failed', 'cancelled']);
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['cancelled', 'completed', 'failed']);
});

test('the seen cursor excludes work whose timestamp equals it, and keeps everything newer', () => {
  const cursor = at(30 * 60 * 1000);
  const digest = build({
    seenAt: cursor,
    work: [
      work({ work_id: 'newer', updated_at: at(29 * 60 * 1000) }),
      work({ work_id: 'equal', updated_at: cursor }),
      work({ work_id: 'older', updated_at: at(31 * 60 * 1000) }),
    ],
    sessions: [session('s1', 'Chat one')],
  });
  assert.deepEqual(digest.rows.map((row) => row.workId), ['newer'],
    'a row whose updated_at equals the cursor was already seen');
  assert.equal(digest.unseenCount, 1);
});

test('the per-session cursor composes with the global cursor using the newer instant', () => {
  const globalCursor = at(50 * 60 * 1000);
  const sessionCursor = at(30 * 60 * 1000);
  const digest = build({
    seenAt: globalCursor,
    seenBySession: { s1: sessionCursor },
    work: [
      work({ work_id: 's1-newer', session_id: 's1', updated_at: at(29 * 60 * 1000) }),
      work({ work_id: 's1-equal', session_id: 's1', updated_at: sessionCursor }),
      work({ work_id: 's1-older', session_id: 's1', updated_at: at(31 * 60 * 1000) }),
      work({ work_id: 's2-after-global', session_id: 's2', updated_at: at(40 * 60 * 1000) }),
      work({ work_id: 's2-before-global', session_id: 's2', updated_at: at(51 * 60 * 1000) }),
    ],
    sessions: [session('s1', 'Chat one'), session('s2', 'Chat two')],
  });
  assert.deepEqual(digest.rows.map((row) => row.workId), ['s1-newer', 's2-after-global']);
  assert.equal(digest.unseenCount, 2);
});

test('rows are newest first, deduped, and honor default, infinite, and invalid limits', () => {
  const rows = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push(work({ work_id: `w${index}`, updated_at: at((index + 1) * 60 * 1000) }));
  }
  // The page arrives oldest-first here on purpose: the order is established by
  // the model, not inherited. The store can also page the same work twice
  // across a revision bump; the first projection of a work id wins and the
  // duplicate never doubles the count.
  const page = rows.slice().reverse();
  page.push(work({ work_id: 'w3', status: 'failed', updated_at: at(4 * 60 * 1000) }));
  const digest = build({ work: page, sessions: [session('s1', 'Chat one')] });
  assert.equal(DEFAULT_ROW_LIMIT, 8);
  assert.equal(digest.rows.length, 8);
  assert.equal(digest.unseenCount, 10, 'the count names everything unseen the page carried');
  assert.equal(digest.truncated, true);
  assert.deepEqual(digest.rows.slice(0, 3).map((row) => row.workId), ['w0', 'w1', 'w2']);
  assert.equal(digest.rows.filter((row) => row.workId === 'w3').length, 1);
  assert.equal(digest.rows.find((row) => row.workId === 'w3').outcome, 'completed',
    'the first projection wins, so the duplicate never rewrites the outcome');
  assert.equal(digest.newestAt, digest.rows[0].finishedAt);
  const all = build({ work: page, sessions: [], limit: Infinity });
  assert.equal(all.rows.length, 10);
  assert.equal(all.truncated, false);
  assert.equal(build({ work: page, limit: Number.NaN }).rows.length, 8);
});

test('older than thirty days is derived from the row and the injected clock, never from a claim', () => {
  const digest = build({
    work: [
      work({ work_id: 'fresh', updated_at: at(RETENTION_MS - 1000) }),
      work({ work_id: 'stale', updated_at: at(RETENTION_MS + 1000) }),
    ],
    sessions: [session('s1', 'Chat one')],
  });
  assert.equal(RETENTION_MS, 30 * DAY);
  const byId = new Map(digest.rows.map((row) => [row.workId, row]));
  assert.equal(byId.get('fresh').olderThanRetention, false);
  assert.equal(byId.get('stale').olderThanRetention, true);
});

test('tokensForStream projects both usage shapes and never passes dollar fields through', () => {
  const usage = new Map([
    ['direct', { input: 120, output: 340, cost_usd: 1.25, cost_source: 'table' }],
    ['legacy', { input_tokens: 10, output_tokens: 20 }],
  ]);
  const direct = tokensForStream(usage, 'direct');
  assert.deepEqual(direct, { input: 120, output: 340 });
  assert.deepEqual(tokensForStream(usage, 'legacy'), { input: 10, output: 20 });
  assert.equal(tokensForStream(usage, 'missing'), null);
  assert.equal(Object.isFrozen(direct), true);
  assert.ok(!('cost_usd' in direct));
  assert.ok(!('cost_source' in direct));
});

test('a work id whose session is gone says so instead of inventing a title', () => {
  const digest = build({
    work: [
      work({ work_id: 'kept', session_id: 's1' }),
      work({ work_id: 'orphan', session_id: 's-gone', updated_at: at(2 * 60 * 60 * 1000) }),
      work({ work_id: 'untitled', session_id: 's2', updated_at: at(3 * 60 * 60 * 1000) }),
    ],
    sessions: [session('s1', 'Chat one'), session('s2', '   ')],
  });
  const byId = new Map(digest.rows.map((row) => [row.workId, row]));
  assert.equal(byId.get('kept').sessionTitle, 'Chat one');
  assert.equal(byId.get('kept').sessionGone, false);
  assert.equal(byId.get('orphan').sessionGone, true, 'the session summary no longer lists it');
  assert.equal(byId.get('orphan').sessionTitle, 'Chat deleted');
  assert.equal(byId.get('untitled').sessionGone, false);
  assert.equal(byId.get('untitled').sessionTitle, 'Untitled chat');
});

test('runningCount counts distinct in-progress work and excludes other statuses', () => {
  const digest = build({
    work: [
      work({ work_id: 'pending', status: 'pending' }),
      work({ work_id: 'paused', status: 'paused' }),
      work({ work_id: 'running', status: 'running' }),
      work({ work_id: 'running', status: 'running', revision: 3 }),
      work({ work_id: 'asking', status: 'needs_attention' }),
      work({ work_id: 'done', status: 'completed' }),
      work({ work_id: 'failed', status: 'failed' }),
      work({ work_id: 'cancelled', status: 'cancelled' }),
    ],
  });
  assert.equal(digest.runningCount, 3);
  assert.deepEqual(IN_PROGRESS_STATUSES, ['pending', 'paused', 'running']);
  assert.equal(Object.isFrozen(IN_PROGRESS_STATUSES), true);
});

test('outcomeBySession uses each newest unseen outcome beyond the shown slice', () => {
  const digest = build({
    seenAt: at(60 * 60 * 1000),
    limit: 1,
    work: [
      work({ work_id: 's1-new', session_id: 's1', status: 'completed', updated_at: at(10 * 60 * 1000) }),
      work({ work_id: 's1-old', session_id: 's1', status: 'failed', updated_at: at(20 * 60 * 1000) }),
      work({ work_id: 's2', session_id: 's2', status: 'failed', updated_at: at(30 * 60 * 1000) }),
      work({ work_id: 's3-seen', session_id: 's3', updated_at: at(70 * 60 * 1000) }),
    ],
  });
  assert.equal(digest.rows.length, 1);
  assert.deepEqual(digest.outcomeBySession, { s1: 'completed', s2: 'failed' });
  assert.ok(!('s3' in digest.outcomeBySession));
});

test('latestTerminalBySession ignores cursors and keeps each newest terminal timestamp', () => {
  const digest = build({
    seenAt: at(5 * 60 * 1000),
    work: [
      work({ work_id: 's1-new', session_id: 's1', updated_at: at(10 * 60 * 1000) }),
      work({ work_id: 's1-old', session_id: 's1', status: 'failed', updated_at: at(20 * 60 * 1000) }),
      work({ work_id: 's1-running', session_id: 's1', status: 'running', updated_at: at(1000) }),
      work({ work_id: 's2', session_id: 's2', status: 'cancelled', updated_at: at(30 * 60 * 1000) }),
    ],
  });
  assert.deepEqual(digest.latestTerminalBySession, {
    s1: at(10 * 60 * 1000),
    s2: at(30 * 60 * 1000),
  });
  assert.equal(digest.rows.length, 0);
});

test('rows carry startedAt and omit controller-era join fields', () => {
  const [row] = build({ work: [work()], sessions: [session('s1', 'Chat one')] }).rows;
  assert.equal(row.startedAt, at(2 * 60 * 60 * 1000));
  assert.ok(!('turnId' in row));
  assert.ok(!('tokens' in row));
  assert.ok(!('available' in row));
});

test('nothing unseen hides the digest, and the result is frozen through and through', () => {
  const empty = build({ work: [], sessions: [] });
  assert.equal(empty.hidden, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.unseenCount, 0);
  assert.equal(empty.newestAt, '');
  assert.equal(empty.truncated, false);
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.rows), true);
  assert.equal(Object.isFrozen(empty.outcomeBySession), true);
  assert.equal(Object.isFrozen(empty.latestTerminalBySession), true);

  const filled = build({ work: [work()], sessions: [session('s1', 'Chat one')] });
  assert.equal(filled.hidden, false);
  assert.equal(Object.isFrozen(filled.rows[0]), true);
  assert.throws(() => { filled.rows[0].outcome = 'completed-ish'; }, TypeError);
});

test('a malformed page never throws and never invents a row', () => {
  const digest = build({
    work: [null, 'nope', {}, work({ work_id: '', status: 'completed' }), work({ work_id: 'ok' })],
    sessions: [null, 'nope', session('s1', 'Chat one')],
  });
  assert.deepEqual(digest.rows.map((row) => row.workId), ['ok']);
  assert.equal(digest.rows[0].key, 'work:ok');
  assert.equal(digest.rows[0].sessionId, 's1');
});
