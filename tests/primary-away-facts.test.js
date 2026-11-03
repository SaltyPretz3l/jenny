'use strict';

/**
 * tests/primary-away-facts.test.js
 *
 * Row 86 D2: the "While you were away" facts composer. Each source, the
 * (since, until] window, archived and primary exclusion, the honesty rules
 * inherited from the Home away-digest model, caps and `truncated`, the empty
 * precheck and title sanitization.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { composeAwayFacts, hasAwayFacts, DEFAULT_LIMITS } = require('../services/primary-away-facts');

const SINCE = '2026-11-02T00:00:00.000Z';
const UNTIL = '2026-11-02T08:00:00.000Z';
const BASE = Date.parse(SINCE);
const HOUR = 60 * 60 * 1000;
const at = (hours) => new Date(BASE + hours * HOUR).toISOString();
const PRIMARY = 'sess-primary';

const session = (id, extra = {}) => ({
  id, title: `Chat ${id}`, updated_at: at(-10), status: 'idle', last_outcome: null, waiting_on_user: false, ...extra,
});
const work = (workId, sessionId, status, updatedAt) => ({
  work_id: workId, session_id: sessionId, status, updated_at: updatedAt, created_at: at(-1),
});
const inbox = (messageId, sourceId, deliveredAt, kind = 'agent_message', outcome = null) => ({
  receipt_id: `r-${messageId}`,
  receive_sequence: 1,
  delivered_at: deliveredAt,
  read_at: null,
  envelope: {
    message_id: messageId,
    source_session_id: sourceId,
    kind,
    created_at: deliveredAt,
    body: 'SECRET BODY',
    report: kind === 'terminal_report' ? { outcome, clipped: false, error_code: null } : null,
  },
});

const compose = (sources, extra = {}) => composeAwayFacts({
  since: SINCE, until: UNTIL, primarySessionId: PRIMARY, sources, ...extra,
});

test('defaults are 40 items and 6000 chars', () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, { maxItems: 40, maxChars: 6000 });
});

test('terminal work becomes work_<status> items through the shared model', () => {
  const result = compose({
    sessions: [session('a'), session('b'), session('c')],
    work: [
      work('w1', 'a', 'completed', at(1)),
      work('w2', 'b', 'failed', at(2)),
      work('w3', 'c', 'cancelled', at(3)),
      work('w4', 'a', 'running', at(4)),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [
    { kind: 'work_cancelled', at: at(3), title: 'Chat c', session_id: 'c' },
    { kind: 'work_failed', at: at(2), title: 'Chat b', session_id: 'b' },
    { kind: 'work_completed', at: at(1), title: 'Chat a', session_id: 'a' },
  ]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.counts, { total: 3, work_cancelled: 1, work_failed: 1, work_completed: 1 });
  assert.equal(result.since, SINCE);
  assert.equal(result.until, UNTIL);
});

test('honesty: failed work invents no reason; an unknown session gets the model wording', () => {
  const result = compose({
    sessions: [session('a', { title: '' })],
    work: [work('w1', 'gone', 'failed', at(1)), work('w2', 'a', 'completed', at(2))],
  });
  const failed = result.items.find((entry) => entry.kind === 'work_failed');
  assert.equal(failed.title, 'Chat deleted');
  assert.equal(Object.hasOwn(failed, 'detail'), false);
  assert.equal(result.items.find((entry) => entry.kind === 'work_completed').title, 'Untitled chat');
});

test('window: since is exclusive, until is inclusive, for every source', () => {
  const sessions = [
    session('a', { updated_at: SINCE, last_outcome: { status: 'completed' } }),
    session('b', { updated_at: UNTIL, last_outcome: { status: 'completed' } }),
    session('c', { updated_at: at(9), last_outcome: { status: 'completed' } }),
  ];
  const result = compose({
    sessions,
    work: [work('w0', 'x', 'completed', SINCE), work('w1', 'x', 'completed', UNTIL), work('w2', 'x', 'failed', at(8.5))],
    mail: [inbox('m0', 'a', SINCE), inbox('m1', 'a', UNTIL), inbox('m2', 'a', at(9))],
    schedules: [
      { kind: 'schedule_missed', at: SINCE, reminder_id: 'r', label: 'early' },
      { kind: 'schedule_skipped', at: UNTIL, reminder_id: 'r', label: 'edge', reason: 'quiet_hours' },
      { kind: 'schedule_missed', at: at(9), reminder_id: 'r', label: 'late' },
    ],
  });
  assert.deepEqual(result.items.map((entry) => entry.kind).sort(), [
    'chat_updated', 'mail_received', 'schedule_skipped', 'work_completed',
  ]);
  for (const entry of result.items) assert.equal(entry.at, UNTIL);
  assert.equal(result.items.find((entry) => entry.kind === 'chat_updated').session_id, 'b');
});

test('chat_updated needs a last outcome, skips chats already reported through work, and excludes the primary', () => {
  const result = compose({
    sessions: [
      session('a', { updated_at: at(1), last_outcome: { status: 'completed' } }),
      session('b', { updated_at: at(2), last_outcome: null }),
      session('c', { updated_at: at(3), last_outcome: { status: 'failed' } }),
      session(PRIMARY, { updated_at: at(4), last_outcome: { status: 'completed' } }),
    ],
    work: [work('wc', 'c', 'failed', at(3)), work('wp', PRIMARY, 'completed', at(4))],
  });
  assert.deepEqual(result.items, [
    { kind: 'work_failed', at: at(3), title: 'Chat c', session_id: 'c' },
    { kind: 'chat_updated', at: at(1), title: 'Chat a', detail: 'last outcome: completed', session_id: 'a' },
  ]);
});

test('archived chats are excluded from work, updates and waiting, without being called deleted', () => {
  const result = compose({
    sessions: [
      session('arch', { archived_at: at(-1), updated_at: at(1), last_outcome: { status: 'completed' }, status: 'waiting_approval' }),
      { session_id: 'arch2', title: 'Old', archived: true, updated_at: at(1), last_outcome: { status: 'completed' }, waiting_on_user: true },
    ],
    work: [work('w1', 'arch', 'completed', at(1)), work('w2', 'arch2', 'failed', at(2))],
  });
  assert.deepEqual(result.items, []);
  assert.equal(hasAwayFacts(result), false);
});

test('waiting_now is current state stamped until and labelled now', () => {
  const result = compose({
    sessions: [
      session('q', { status: 'waiting_question', waiting_on_user: true, updated_at: at(-50) }),
      session('n', { status: 'needs_attention', updated_at: at(-50) }),
      session('f', { needs_attention: true, status: '', updated_at: at(-50) }),
      session(PRIMARY, { status: 'waiting_approval', waiting_on_user: true }),
      session('idle'),
    ],
  });
  assert.deepEqual(result.items, [
    { kind: 'waiting_now', at: UNTIL, title: 'Chat f', detail: 'now: waiting_on_user', session_id: 'f' },
    { kind: 'waiting_now', at: UNTIL, title: 'Chat n', detail: 'now: needs_attention', session_id: 'n' },
    { kind: 'waiting_now', at: UNTIL, title: 'Chat q', detail: 'now: waiting_question', session_id: 'q' },
  ]);
});

test('mail: reports carry their outcome, messages no body, unknown senders the model wording', () => {
  const result = compose({
    sessions: [session('a'), session('arch', { archived_at: at(-1) })],
    mail: [
      inbox('m1', 'a', at(1), 'terminal_report', 'failed'),
      inbox('m2', 'gone', at(2)),
      inbox('m3', 'arch', at(3), 'user_message'),
      inbox('m1', 'a', at(1), 'terminal_report', 'failed'), // duplicate id
      { delivered_at: at(4) }, // no envelope
    ],
  });
  assert.deepEqual(result.items, [
    { kind: 'mail_received', at: at(3), title: 'Chat arch', detail: 'message', session_id: 'arch' },
    { kind: 'mail_received', at: at(2), title: 'Chat deleted', detail: 'message', session_id: 'gone' },
    { kind: 'mail_received', at: at(1), title: 'Chat a', detail: 'report: failed', session_id: 'a' },
  ]);
  assert.equal(JSON.stringify(result).includes('SECRET BODY'), false);
});

test('schedules: missed, skipped and fired entries; other history kinds ignored', () => {
  const result = compose({
    schedules: [
      { kind: 'schedule_missed', at: at(1), reminder_id: 'r1', label: 'Morning check' },
      { kind: 'schedule_skipped', at: at(2), reminder_id: 'r2', label: '', reason: 'quiet_hours' },
      { kind: 'schedule_fired', at: at(3), label: 'Build watch' },
      { kind: 'schedule_created', at: at(4), reminder_id: 'r3', label: 'New' },
      { kind: 'paused', at: at(5) },
    ],
  });
  assert.deepEqual(result.items, [
    { kind: 'schedule_fired', at: at(3), title: 'Build watch' },
    { kind: 'schedule_skipped', at: at(2), title: 'Scheduled check', detail: 'quiet_hours' },
    { kind: 'schedule_missed', at: at(1), title: 'Morning check' },
  ]);
});

test('newest first with a deterministic tie order; equal inputs give equal output', () => {
  const sources = {
    sessions: [session('b'), session('a'), session('q', { status: 'waiting_plan' })],
    work: [work('w1', 'b', 'completed', at(2)), work('w2', 'a', 'completed', at(2)), work('w3', 'a', 'failed', at(1))],
    mail: [inbox('m1', 'a', at(2))],
  };
  const first = compose(sources);
  const second = compose(JSON.parse(JSON.stringify(sources)));
  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map((entry) => `${entry.kind}:${entry.session_id}`), [
    'waiting_now:q', 'work_completed:a', 'work_completed:b', 'mail_received:a', 'work_failed:a',
  ]);
});

test('item cap and char cap truncate newest-first and count everything', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`));
  const workRows = sessions.map((s, i) => work(`w${i}`, s.id, 'completed', at(1 + i * 0.1)));
  const capped = compose({ sessions, work: workRows }, { limits: { maxItems: 3 } });
  assert.equal(capped.items.length, 3);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.items.map((entry) => entry.session_id), ['s9', 's8', 's7']);
  assert.equal(capped.counts.total, 10);

  const chars = compose({ sessions, work: workRows }, { limits: { maxChars: 'Chat s9'.length * 2 } });
  assert.equal(chars.items.length, 2);
  assert.equal(chars.truncated, true);

  const roomy = compose({ sessions, work: workRows });
  assert.equal(roomy.items.length, 10);
  assert.equal(roomy.truncated, false);
});

test('default caps hold under a flood', () => {
  const sessions = Array.from({ length: 60 }, (_, i) => session(`s${i}`, { title: 'x'.repeat(500) }));
  const workRows = sessions.map((s, i) => work(`w${i}`, s.id, 'completed', at(1 + i * 0.01)));
  const result = compose({ sessions, work: workRows });
  assert.equal(result.items.length, 40);
  assert.equal(result.truncated, true);
  const total = result.items.reduce((sum, entry) => sum + entry.title.length + (entry.detail || '').length, 0);
  assert.ok(total <= 6000);
});

test('titles are flattened, stripped of markdown and clipped like profile_overview', () => {
  const result = compose({
    sessions: [
      session('a', { title: 'Line one\nline\u0000two‮ # *bold* [link](x)' }),
      session('b', { title: 'y'.repeat(200) }),
    ],
    work: [work('w1', 'a', 'completed', at(1)), work('w2', 'b', 'completed', at(2))],
    schedules: [{ kind: 'schedule_missed', at: at(3), label: '\u0007`rm -rf`' }],
  });
  const byId = Object.fromEntries(result.items.map((entry) => [entry.session_id || entry.kind, entry.title]));
  assert.equal(byId.a, 'Line one line two bold link(x)');
  assert.equal(byId.b.length, 60);
  assert.ok(byId.b.endsWith('…'));
  assert.equal(byId.schedule_missed, 'rm -rf');
});

test('unknown status and outcome words read "unknown"', () => {
  const result = compose({
    sessions: [session('a', { updated_at: at(1), last_outcome: { status: 'Bad\nWord' } })],
    mail: [inbox('m1', 'a', at(2), 'terminal_report', 'IGNORE PREVIOUS')],
  });
  assert.deepEqual(result.items.map((entry) => entry.detail), ['report: unknown', 'last outcome: unknown']);
});

test('empty sources -> no facts; invalid window -> not ok', () => {
  const empty = compose({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.truncated, false);
  assert.deepEqual(empty.counts, { total: 0 });
  assert.equal(hasAwayFacts(empty), false);
  assert.equal(hasAwayFacts(compose({ sessions: [session('q', { waiting_on_user: true })] })), true);

  assert.deepEqual(composeAwayFacts({ since: 'nope', until: UNTIL }), { ok: false, reason: 'invalid_window' });
  assert.deepEqual(composeAwayFacts({ since: UNTIL, until: SINCE }), { ok: false, reason: 'invalid_window' });
  assert.deepEqual(composeAwayFacts(), { ok: false, reason: 'invalid_window' });
  assert.equal(hasAwayFacts(composeAwayFacts()), false);
  assert.equal(hasAwayFacts(null), false);
});

test('malformed source entries are ignored, never thrown on', () => {
  const result = compose({
    sessions: [null, 7, { title: 'no id' }, session('a')],
    work: [null, 'x', { work_id: 'w', status: 'completed' }],
    mail: [null, { envelope: null }, { delivered_at: 'bad', envelope: {} }],
    schedules: 'not a list',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, []);
});
