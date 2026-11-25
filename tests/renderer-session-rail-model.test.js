'use strict';

/* Row 59 checkpoint 2, slice S3 and row 195: the session rail's pure model (words, data states, disclosure
   defaults, the four sections). No DOM. */

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../renderer/chat/renderer-session-rail-model.js');
const render = require('../renderer/chat/renderer-session-rail-render.js');

const SID = 'sess_one';
const jtPlain = (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d);

function wrapper(data, state = 'available', extra = {}) {
  return { state, sampled_at: state === 'checking' ? null : '2026-10-15T10:00:00.000Z', reason: null, data, ...extra };
}

const COMPLETE = { counts: { active: 0, waiting: 0, failed: 0, completed: 0 }, coverage: 'complete', unsupported_sources: [], items: [] };

function summary(overrides = {}) {
  return {
    session_id: SID,
    session_incarnation: 'inc_1',
    revision: 3,
    environment: wrapper({
      project_id: 'p1', project_name: 'jenny', workspace_id: 'w1', display_path: 'D:\\Work\\jenny',
      branch: 'main', worktree_id: null, execution_environment: 'local', run_mode: 'auto',
    }),
    context: wrapper({ turn_id: null, used_tokens: 20480, capacity_tokens: 32000, available_tokens: 11520, measurement: 'actual', scope: 'request' }),
    outputs: wrapper({ items: [{ artifact_id: 'art_1', display_name: 'context_probe.py', kind: 'code', availability: 'available' }], total_count: 1, next_cursor: null }),
    changes: wrapper({ workspace_id: 'w1', scope: 'working_tree', file_count: 6, additions: 412, deletions: 37, ref: 'main', head: 'abc1234' }),
    background_tasks: wrapper({ scope: 'session_and_direct_children', ...COMPLETE }),
    ...overrides,
  };
}

const withTasks = (data, state = 'available') => summary({ background_tasks: wrapper({ scope: 'session_and_direct_children', ...COMPLETE, ...data }, state) });
const build = (extra = {}) => model.buildRailViewModel({ summary: summary(), sessionId: SID, workspaceView: null, ...extra });
const byKey = (vm, key) => vm.sections.find((section) => section.key === key);
const keysOf = (vm) => vm.sections.map((section) => section.key);

const ROWS = [
  { id: 'job:aaaaaaaaaaaa', kind: 'server', label: 'npm run dev', detail: 'localhost:5173', startedAt: 1000, canStop: true },
  { id: 'job:bbbbbbbbbbbb', kind: 'command', label: 'npm test', detail: '', startedAt: 2000, canStop: true },
];

test('Session: This chat, Context and Running now only (no Outputs, Changes or Servers); Running now takes its rows from getRunningRows', () => {
  const vm = build({ getRunningRows: () => ROWS });
  assert.deepEqual(keysOf(vm), ['this_chat', 'context', 'running_now']);
  const running = byKey(vm, 'running_now');
  assert.equal(running.title, 'Running now');
  assert.equal(running.valueText, '2');
  assert.deepEqual(running.dot, { tone: 'active', pulse: true });
  assert.equal(running.open, true);
  assert.equal(running.rows.at(-1).text, 'All runs');
  assert.equal(running.rows.at(-1).kind, 'action');
  assert.equal(running.rows.at(-1).allRuns, true);
});

test('Running now: absent when nothing runs, for an injected empty list and for a summary with nothing running', () => {
  assert.deepEqual(keysOf(build()), ['this_chat', 'context']);
  assert.deepEqual(keysOf(build({ getRunningRows: () => [] })), ['this_chat', 'context']);
  assert.deepEqual(keysOf(build({ getRunningRows: () => { throw new Error('boom'); } })), ['this_chat', 'context'], 'a reader that throws is no rows');
  assert.deepEqual(keysOf(build({ summary: withTasks({ items: [{ source_kind: 'background_job', operation_id: 'job:a', job_id: 'aaaaaaaaaaaa', command: 'npm test', state: 'completed' }] }) })), ['this_chat', 'context']);
});

test('Running now: a server shows its address and Up with a clock, a command its name and a clock, a helper Running', () => {
  const rows = byKey(build({ getRunningRows: () => [...ROWS, { id: 'chat:h1', kind: 'helper', label: 'Helper: summarise', startedAt: 3000, canStop: false }], nowMs: 62000 }), 'running_now').rows;
  const [server, command, helper] = rows;
  assert.deepEqual([server.kind, server.text, server.addr, server.metaPrefix, server.startedAtMs, server.runId, server.canStop], ['server', 'localhost:5173', true, 'Up', 1000, 'job:aaaaaaaaaaaa', true]);
  assert.equal(server.title, 'npm run dev on localhost:5173');
  assert.deepEqual([command.kind, command.text, command.meta, command.jobId, command.dot], ['job', 'npm test', '01:00', 'bbbbbbbbbbbb', { tone: 'active', pulse: true }]);
  assert.deepEqual([helper.kind, helper.text, helper.meta, helper.runId, helper.surface], ['action', 'Helper: summarise', 'Running', 'chat:h1', 'background_tasks']);
  assert.equal(rows.length, 4, 'three runs and the All runs link');
});

test('Running now: a Stop that does not apply is disabled with the reason, and the same id is listed once', () => {
  const rows = byKey(build({ getRunningRows: () => [{ id: 'job:x', kind: 'command', label: 'a', canStop: false }, { id: 'job:x', kind: 'command', label: 'dup', canStop: true }, { id: 'task:t', kind: 'test', label: 'Workspace tests', canStop: true }] }), 'running_now').rows;
  assert.equal(rows.filter((row) => row.kind !== 'action' || row.runId).length, 2);
  assert.equal(rows[0].canStop, false);
  assert.equal(rows[0].stopTitle, 'This run cannot be stopped from here.');
  const html = render.bodyHtml({ rows });
  assert.match(html, /session-rail-job-stop[^>]*disabled|disabled[^>]*session-rail-job-stop/);
  assert.match(html, /data-rail-run="job:x"/);
  assert.match(html, /data-rail-runs="true"/);
});

test('Running now without getRunningRows: the summary\u2019s serving jobs, commands, tests and linked chats, in the same shape', () => {
  const summaryWith = withTasks({
    counts: { active: 4, waiting: 0, failed: 0, completed: 1 },
    items: [
      { source_kind: 'background_job', operation_id: 'job:bbbbbbbbbbbb', job_id: 'bbbbbbbbbbbb', command: 'npm test', state: 'running', started_at_ms: 2000 },
      { source_kind: 'background_job', operation_id: 'job:aaaaaaaaaaaa', job_id: 'aaaaaaaaaaaa', command: 'npm run dev', state: 'running', started_at_ms: 1000, serving_url: 'http://localhost:5173', serving_port: 5173, serving_since_ms: 1500 },
      { source_kind: 'workspace_test', operation_id: 'op_1', state: 'running' },
      { source_kind: 'linked_chat_turn', operation_id: 'w1', session_id: 'sess_child', state: 'running', title: 'Fix the flaky test' },
      { source_kind: 'background_job', operation_id: 'job:cccccccccccc', job_id: 'cccccccccccc', command: 'done', state: 'completed' },
    ],
  });
  const running = byKey(build({ summary: summaryWith }), 'running_now');
  assert.equal(running.valueText, '4');
  assert.deepEqual(running.rows.map((row) => [row.kind, row.runId, row.text]), [
    ['server', 'job:aaaaaaaaaaaa', 'localhost:5173'], ['job', 'job:bbbbbbbbbbbb', 'npm test'],
    ['action', 'task:op_1', 'Workspace tests'], ['action', 'chat:sess_child', 'Fix the flaky test'], ['action', undefined, 'All runs'],
  ]);
  assert.equal(running.rows[3].sessionRef, 'sess_child');
});

test('Running now without getRunningRows: the Live tab program is one running row named by its title', () => {
  const live = { source_kind: 'live_run', operation_id: 'live:p1', session_id: SID, project_id: 'p1', state: 'running', run_state: 'running', title: 'game.exe' };
  const closed = { ...live, operation_id: 'live:p2', project_id: 'p2', state: 'completed', run_state: 'closed' };
  const unnamed = { ...live, operation_id: 'live:p3', project_id: 'p3', title: '' };
  const running = byKey(build({ summary: withTasks({ counts: { active: 2, waiting: 0, failed: 0, completed: 1 }, items: [live, closed, unnamed] }) }), 'running_now');
  assert.deepEqual(running.rows.slice(0, 2).map((row) => [row.kind, row.runId, row.text, row.meta]), [
    ['action', 'live:p1', 'game.exe', 'Running'], ['action', 'live:p3', 'Live tab program', 'Running'],
  ]);
  assert.equal(running.rows.length, 3, 'the finished run is not a running row');
});

test('Running now without getRunningRows: a live run says its state in words (kind live), the plain running state still reads Running', () => {
  const live = { source_kind: 'live_run', operation_id: 'live:p1', session_id: SID, project_id: 'p1', state: 'running', title: 'game.exe' };
  const items = [['p1', 'building'], ['p2', 'starting'], ['p3', 'stopping'], ['p4', 'minimized'], ['p5', 'running']].map(([project, runState]) => ({ ...live, operation_id: `live:${project}`, project_id: project, run_state: runState }));
  const running = byKey(build({ summary: withTasks({ counts: { active: 5, waiting: 0, failed: 0, completed: 0 }, items }) }), 'running_now');
  assert.deepEqual(running.rows.slice(0, 5).map((row) => row.meta), ['Building', 'Starting', 'Stopping', 'Minimized', 'Running']);
  assert.equal(model.liveStateWord('ended_early', 3, 'finished', jtPlain), 'Ended early · exit 3');
  assert.equal(model.liveStateWord('', null, 'running', jtPlain), 'Running', 'no run state: the task phase word');
});

test('Running now from the Runs list: the Live tab program shows its state words, not a bare Running', () => {
  const rows = [{ id: 'live:p1', kind: 'live', label: 'game.exe', detail: 'Building', startedAt: 1, canStop: false }];
  const running = byKey(build({ getRunningRows: () => rows }), 'running_now');
  assert.deepEqual([running.rows[0].kind, running.rows[0].text, running.rows[0].meta, running.rows[0].title], ['action', 'game.exe', 'Building', 'game.exe (Building)']);
  assert.equal(running.rows[0].resourceRef, 'live:p1', 'correctness review 6: the row names its own run, so it opens the Live tab, not the list');
});

test('Running now: the chat\u2019s open browser page is one more row that closes itself', () => {
  const vm = build({ browser: { open: true, url: 'https://example.com/docs', title: 'Example docs' } });
  const running = byKey(vm, 'running_now');
  assert.equal(running.valueText, '1');
  const [page] = running.rows;
  assert.deepEqual([page.kind, page.serverKind, page.text, page.meta, page.surface, page.stopLabel], ['server', 'browser', 'Example docs', 'Browser', 'browser', 'Close']);
  assert.equal(keysOf(build({ browser: { open: true, url: '', title: 'x' } })).includes('running_now'), false);
});

test('rail markup: server and command rows carry the run, a stop control and a ticking clock; a page title is escaped', () => {
  const rows = byKey(build({ getRunningRows: () => ROWS, browser: { open: true, url: 'https://example.com/"><b>', title: '<img src=x onerror=alert(1)>' } }), 'running_now').rows;
  const html = render.bodyHtml({ rows });
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-rail-server-stop="browser"/);
  assert.match(html, /data-rail-server-stop="job:aaaaaaaaaaaa"/);
  assert.match(html, /data-rail-job-stop="bbbbbbbbbbbb"/);
  assert.match(html, /Up \u00b7 <span data-rail-started-at="1000">/);
  assert.match(html, /data-rail-run="job:aaaaaaaaaaaa"/);
  assert.equal((html.match(/session-rail-ellip--addr/g) || []).length, 1, 'only the server address is mono');
  assert.equal(html.includes('session-rail-dot-pulse'), true);
});

test('Jenny\u2019s checklist: from getChecklist, "1 of 3 done", Done and Now second signals; absent without steps', () => {
  const steps = [{ text: 'Load the ledger', state: 'done' }, { text: 'Compare to plan', state: 'now' }, { text: 'Chart FX', state: 'todo' }, { text: '', state: 'todo' }];
  const vm = build({ getChecklist: () => steps });
  assert.deepEqual(keysOf(vm), ['this_chat', 'context', 'checklist']);
  const list = byKey(vm, 'checklist');
  assert.equal(list.title, "Jenny's checklist");
  assert.equal(list.valueText, '1 of 3 done');
  assert.equal(list.open, true);
  assert.deepEqual(list.rows.map((row) => [row.text, row.meta, Boolean(row.dot)]), [['Load the ledger', 'Done', false], ['Compare to plan', 'Now', true], ['Chart FX', '', false]]);
  assert.deepEqual(keysOf(build({ getChecklist: () => [] })), ['this_chat', 'context']);
  assert.deepEqual(keysOf(build()), ['this_chat', 'context'], 'no reader, no section');
  assert.deepEqual(keysOf(build({ getRunningRows: () => ROWS, getChecklist: () => steps })), ['this_chat', 'context', 'running_now', 'checklist']);
});

test('no summary: This chat and Context are checking, in words, never a number; the injected sections need no summary', () => {
  const vm = model.buildRailViewModel({ summary: null, sessionId: SID, status: 'checking' });
  assert.deepEqual(keysOf(vm), ['this_chat', 'context']);
  for (const section of vm.sections) {
    assert.equal(section.state, 'checking');
    assert.equal(section.valueText, 'Checking\u2026');
    assert.deepEqual(section.rows, []);
    assert.doesNotMatch(section.valueText, /\d/);
  }
  assert.deepEqual(keysOf(model.buildRailViewModel({ summary: null, sessionId: SID, getRunningRows: () => ROWS })), ['this_chat', 'context', 'running_now']);
});

test('a failed fetch reads unavailable; another session\u2019s summary is never shown', () => {
  const failed = model.buildRailViewModel({ summary: null, sessionId: SID, status: 'unavailable' });
  assert.ok(failed.sections.every((section) => section.valueText === 'Unavailable' && section.state === 'unavailable'));
  const other = model.buildRailViewModel({ summary: summary({ session_id: 'sess_two' }), sessionId: SID, status: 'checking' });
  assert.ok(other.sections.every((section) => section.state === 'checking'), 'a switch clears to checking');
  assert.equal(JSON.stringify(other).includes('jenny'), false, 'none of the other session\u2019s values leak');
  assert.equal(model.buildRailViewModel({ summary: summary(), sessionId: '', status: 'checking' }).sections[0].state, 'checking', 'no session, no facts');
});

test('This chat: execution word in the header; project, path and branch rows; open by default', () => {
  const chat = byKey(build(), 'this_chat');
  assert.equal(chat.title, 'This chat');
  assert.equal(chat.valueText, 'Local');
  assert.equal(chat.open, true);
  assert.deepEqual(chat.rows.map((row) => [row.kind, row.text, row.meta]), [['action', 'jenny', 'Auto'], ['fact', 'D:\\Work\\jenny', ''], ['fact', 'main', '']]);
  assert.equal(chat.rows[0].surface, 'environment');
  const bare = model.buildSection('this_chat', wrapper({ project_name: null, display_path: null, branch: null, worktree_id: 'wt_1', execution_environment: 'sandbox', run_mode: 'plan' }), jtPlain);
  assert.equal(bare.rows[0].text, 'No project', 'no binding is words, not a blank');
  assert.equal(bare.valueText, 'Sandbox');
  assert.deepEqual(bare.rows.map((row) => row.key), ['project']);
  assert.equal(model.buildSection('this_chat', wrapper({ project_name: 'p', branch: 'feat', worktree_id: 'wt_1', execution_environment: 'hosted' }), jtPlain).rows.find((row) => row.key === 'branch').meta, 'worktree');
  assert.equal(byKey(build({ fullAuto: true }), 'this_chat').rows[0].meta, 'Full auto', 'an armed full auto is the run mode');
  assert.equal(byKey(build(), 'this_chat').rows[0].meta, 'Auto');
});

test('a complete summary says nothing about coverage; a really partial one keeps one plain note', () => {
  const notes = (vm) => byKey(vm, 'this_chat').rows.filter((row) => row.kind === 'note');
  assert.deepEqual(notes(build()), []);
  const partial = notes(build({ summary: withTasks({ coverage: 'partial', unsupported_sources: ['linked_chat_turn'] }) }));
  assert.deepEqual(partial.map((row) => row.text), ["Some sources aren't connected yet."]);
  assert.equal(notes(build({ summary: withTasks({ failed_sources: ['workspace_test'] }) })).length, 1);
  assert.equal(notes(build({ summary: withTasks({ coverage: 'partial' }, 'checking') })).length, 0, 'a section still checking claims nothing');
});

test('Context: "64% full", closed by default, opened it is Used, one plain line and the details link', () => {
  const ctx = byKey(build(), 'context');
  assert.equal(ctx.valueText, '64% full');
  assert.equal(ctx.dot, null);
  assert.equal(ctx.open, false);
  assert.deepEqual(ctx.rows.map((row) => [row.kind, row.text, row.meta]), [
    ['fact', 'Used', '20.5k of 32k'], ['note', 'Jenny summarises older messages when this fills.', undefined], ['action', 'Context details', ''],
  ]);
  assert.equal(ctx.rows[2].surface, 'context');
  const hot = model.buildSection('context', wrapper({ used_tokens: 26000, capacity_tokens: 32000, available_tokens: 6000, measurement: 'actual', scope: 'request' }), jtPlain);
  assert.equal(hot.valueText, '81% full');
  assert.deepEqual(hot.dot, { tone: 'warn', pulse: false });
  const exactly = model.buildSection('context', wrapper({ used_tokens: 80, capacity_tokens: 100, available_tokens: 20, measurement: 'actual', scope: 'request' }), jtPlain);
  assert.equal(exactly.dot.tone, 'warn', '80% itself is amber');
});

test('Context: the token ledger and the breakdown are not in the rail, for a next-send estimate too', () => {
  const estimate = { used_tokens: 15000, capacity_tokens: 32768, compact_at_tokens: 24600, available_tokens: null, measurement: 'estimated', scope: 'next_send', breakdown: { system: 1000, messages: 14000 } };
  const ctx = model.buildSection('context', wrapper(estimate), jtPlain);
  assert.equal(ctx.valueText, '61% full');
  assert.deepEqual(ctx.rows.map((row) => row.key), ['used', 'note', 'details']);
  assert.equal(ctx.rows[0].meta, '15k of 24.6k', 'the figures agree with the percent of the compact point');
});

test('Context: unknown is never a percentage or zero; nothing used yet reads in one voice', () => {
  const noCapacity = model.buildSection('context', wrapper({ used_tokens: 18400, capacity_tokens: null, available_tokens: null, measurement: 'estimated', scope: 'request' }), jtPlain);
  assert.equal(noCapacity.valueText, '18.4k tokens');
  assert.equal(noCapacity.dot, null);
  assert.equal(noCapacity.rows[0].meta, '18.4k');
  const nothing = model.buildSection('context', wrapper({ used_tokens: null, capacity_tokens: null, available_tokens: null, measurement: 'actual', scope: 'request' }), jtPlain);
  assert.equal(nothing.valueText, 'Unknown');
  assert.equal(nothing.rows.some((row) => row.key === 'used'), false);
  const zeroCapacity = model.buildSection('context', wrapper({ used_tokens: 5, capacity_tokens: 0, available_tokens: null, measurement: 'actual', scope: 'request' }), jtPlain);
  assert.doesNotMatch(zeroCapacity.valueText, /%|Infinity|NaN/);
  const fresh = model.buildSection('context', wrapper({ used_tokens: 0, capacity_tokens: 32000, available_tokens: 32000, measurement: 'actual', scope: 'request' }), jtPlain);
  assert.deepEqual(fresh.rows.map((row) => [row.key, row.text]), [['empty', 'Nothing used yet. This fills as you and Jenny talk.'], ['details', 'Context details']]);
});

test('an unavailable or not-applicable section is a word', () => {
  assert.equal(model.buildSection('this_chat', { state: 'unavailable', reason: 'feature_disabled', sampled_at: null, data: null }, jtPlain).valueText, 'Unavailable');
  assert.equal(model.buildSection('this_chat', { state: 'not_applicable', reason: 'x', sampled_at: null, data: null }, jtPlain).valueText, 'Not applicable');
});

test('stale data keeps its value with the muted word and no live dot', () => {
  const vm = build({ summary: summary({ context: wrapper({ used_tokens: 26000, capacity_tokens: 32000, available_tokens: 6000, measurement: 'actual', scope: 'request' }, 'stale') }) });
  const ctx = byKey(vm, 'context');
  assert.equal(ctx.state, 'stale');
  assert.equal(ctx.valueText, '81% full \u00b7 stale');
  assert.equal(ctx.dot, null, 'a stale reading is never an alert');
});

test('disclosures: persisted values win under the service keys; defaults apply only where null; overrides win for an unconfirmed toggle', () => {
  const rows = () => ROWS;
  const defaults = build({ getRunningRows: rows, getChecklist: () => [{ text: 'a', state: 'todo' }] });
  assert.deepEqual(defaults.sections.map((section) => [section.key, section.open]), [['this_chat', true], ['context', false], ['running_now', true], ['checklist', true]]);
  assert.deepEqual(model.PERSIST_KEY, { this_chat: 'environment', context: 'context', running_now: 'background_tasks' });
  const persisted = build({ getRunningRows: rows, workspaceView: { disclosures: { environment: false, context: true, background_tasks: false } } });
  assert.deepEqual(persisted.sections.map((section) => section.open), [false, true, false]);
  const override = build({ workspaceView: { disclosures: { context: false } }, overrides: { context: true, this_chat: false } });
  assert.equal(byKey(override, 'context').open, true);
  assert.equal(byKey(override, 'this_chat').open, false);
  const junk = build({ workspaceView: { disclosures: { context: 'yes', environment: 1 } } });
  assert.equal(byKey(junk, 'context').open, false, 'non-boolean persisted values are ignored');
  assert.equal(byKey(junk, 'this_chat').open, true);
  assert.equal(model.isDisclosureOpen(defaults, 'running_now'), true);
});

test('formatTokens: compact, never invents a number', () => {
  assert.equal(model.formatTokens(0), '0');
  assert.equal(model.formatTokens(742), '742');
  assert.equal(model.formatTokens(1000), '1k');
  assert.equal(model.formatTokens(18400), '18.4k');
  assert.equal(model.formatTokens(131072), '131k');
  assert.equal(model.formatTokens(2500000), '2.5M');
  for (const bad of [null, -5, 1.5, '12']) assert.equal(model.formatTokens(bad), '');
});

test('copy resolves through the supplied translator with parameters', () => {
  const seen = [];
  const jt = (key, fallback, params) => { seen.push(key); return `[${key}]${params ? JSON.stringify(params) : ''}`; };
  const vm = model.buildRailViewModel({ summary: summary(), sessionId: SID, jt, getRunningRows: () => ROWS, getChecklist: () => [{ text: 'a', state: 'done' }] });
  const stray = [...new Set(seen)].filter((key) => !/^(sessionRail\.|chat\.sessionRail\.|chat\.backgroundJobs\.|composer\.runMode\.)/.test(key));
  assert.deepEqual(stray, []);
  assert.match(byKey(vm, 'context').valueText, /sessionRail\.contextFull/);
  assert.match(byKey(vm, 'checklist').valueText, /sessionRail\.checklistDone/);
});
