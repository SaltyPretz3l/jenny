'use strict';

/* Row 59 checkpoint 2, slice S3: the session rail's pure model (words, data states, disclosure
   defaults, docking). No DOM. */

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../renderer/chat/renderer-session-rail-model.js');

const SID = 'sess_one';

function wrapper(data, state = 'available', extra = {}) {
  return { state, sampled_at: state === 'checking' ? null : '2026-10-15T10:00:00.000Z', reason: null, data, ...extra };
}

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
    outputs: wrapper({
      items: [
        { artifact_id: 'art_1', display_name: 'context_probe.py', kind: 'code', availability: 'available' },
        { artifact_id: 'art_2', display_name: 'results.md', kind: 'document', availability: 'missing' },
      ],
      total_count: 2, next_cursor: null,
    }),
    changes: wrapper({ workspace_id: 'w1', scope: 'working_tree', file_count: 6, additions: 412, deletions: 37, ref: 'main', head: 'abc1234' }),
    background_tasks: wrapper({
      scope: 'session_and_direct_children',
      counts: { active: 1, waiting: 0, failed: 0, completed: 12 },
      coverage: 'partial', unsupported_sources: ['linked_chat_turn'],
      items: [{ source_kind: 'workspace_test', operation_id: 'op_1', session_id: SID, state: 'running', started_at: '2026-10-15T09:59:00.000Z', finished_at: null, output_ref: null }],
    }),
    ...overrides,
  };
}

const build = (extra = {}) => model.buildRailViewModel({ summary: summary(), sessionId: SID, workspaceView: null, ...extra });
const byKey = (vm, key) => vm.sections.find((section) => section.key === key);

test('the five sections come in the PO order', () => {
  assert.deepEqual(build().sections.map((section) => section.key), ['environment', 'context', 'outputs', 'changes', 'background_tasks']);
  assert.deepEqual(build().sections.map((section) => section.title), ['Environment', 'Context', 'Outputs', 'Changes', 'Background tasks']);
});

test('docking: 920px docks; 640px keeps a docked rail while a panel is open; a rail that was not docked stays out', () => {
  const { resolveDocked } = model;
  assert.equal(resolveDocked({ paneWidth: 920 }), true);
  assert.equal(resolveDocked({ paneWidth: 919, wasDocked: true }), false, 'no panel: the 920 rule alone');
  assert.equal(resolveDocked({ paneWidth: 713, panelActive: true, wasDocked: true }), true, '1455 single with the panel open');
  assert.equal(resolveDocked({ paneWidth: 640, panelActive: true, wasDocked: true }), true);
  assert.equal(resolveDocked({ paneWidth: 639, panelActive: true, wasDocked: true }), false, 'below the 360px reading floor + rail');
  assert.equal(resolveDocked({ paneWidth: 800, panelActive: true, wasDocked: false }), false, 'a panel opening never docks an undocked rail');
  assert.equal(resolveDocked({ paneWidth: 0, wasDocked: true }), true, 'an unmeasurable pane keeps its answer');
  assert.equal(resolveDocked({ paneWidth: Number.NaN, wasDocked: false }), false);
});

test('rail mode: rail_visible null means shown; false hides only a docked rail', () => {
  const { resolveRailMode } = model;
  assert.equal(resolveRailMode({ docked: true, railVisible: null }), 'docked');
  assert.equal(resolveRailMode({ docked: true, railVisible: true }), 'docked');
  assert.equal(resolveRailMode({ docked: true, railVisible: false }), 'hidden');
  assert.equal(resolveRailMode({ docked: false, railVisible: false }), 'undocked', 'responsive collapse ignores the preference');
  assert.equal(resolveRailMode({ docked: false, railVisible: null }), 'undocked');
});

test('no summary: every section is checking, in words, never a number', () => {
  for (const vm of [model.buildRailViewModel({ summary: null, sessionId: SID, status: 'checking' })]) {
    for (const section of vm.sections) {
      assert.equal(section.state, 'checking');
      assert.equal(section.valueText, 'Checking\u2026');
      if (section.key === 'context') {
        const categories = section.rows.filter((row) => row.kind === 'category');
        assert.equal(categories.length, 7);
        assert.ok(categories.every((row) => row.tokens === null));
      } else assert.deepEqual(section.rows, []);
      assert.doesNotMatch(section.valueText, /\d/);
    }
  }
});

test('a failed fetch reads unavailable; another session\u2019s summary is never shown', () => {
  const failed = model.buildRailViewModel({ summary: null, sessionId: SID, status: 'unavailable' });
  assert.ok(failed.sections.every((section) => section.valueText === 'Unavailable' && section.state === 'unavailable'));
  const other = model.buildRailViewModel({ summary: summary({ session_id: 'sess_two' }), sessionId: SID, status: 'checking' });
  assert.ok(other.sections.every((section) => section.state === 'checking'), 'a switch clears to checking');
  const json = JSON.stringify(other);
  assert.equal(json.includes('jenny'), false, 'none of the other session\u2019s values leak');
  assert.equal(model.buildRailViewModel({ summary: summary(), sessionId: '', status: 'checking' }).sections[0].state, 'checking', 'no session, no facts');
});

test('Environment: execution word in the header; project, path and branch rows; open by default', () => {
  const env = byKey(build(), 'environment');
  assert.equal(env.valueText, 'Local');
  assert.equal(env.open, true);
  assert.deepEqual(env.rows.map((row) => [row.kind, row.text, row.meta]), [
    ['action', 'jenny', 'Auto'], ['fact', 'D:\\Work\\jenny', ''], ['fact', 'main', ''],
  ]);
  assert.equal(env.rows[0].surface, 'environment');
  const bare = model.buildSection('environment', wrapper({ project_name: null, display_path: null, branch: null, worktree_id: 'wt_1', execution_environment: 'sandbox', run_mode: 'plan' }), (k, d) => d);
  assert.equal(bare.rows[0].text, 'No project', 'no binding is words, not a blank');
  assert.equal(bare.valueText, 'Sandbox');
  assert.deepEqual(bare.rows.map((row) => row.key), ['project']);
  const withTree = model.buildSection('environment', wrapper({ project_name: 'p', branch: 'feat', worktree_id: 'wt_1', execution_environment: 'hosted' }), (k, d) => d);
  assert.equal(withTree.rows.find((row) => row.key === 'branch').meta, 'worktree');
});

test('Context: percent from known counts, amber dot at 80% and over, closed by default', () => {
  const ctx = byKey(build(), 'context');
  assert.equal(ctx.valueText, '64%');
  assert.equal(ctx.dot, null);
  assert.equal(ctx.open, false);
  assert.ok(ctx.rows.some((row) => row.text === 'Available' && row.meta === '11.5k'));
  assert.ok(ctx.rows.some((row) => row.surface === 'context'));
  const hot = model.buildSection('context', wrapper({ used_tokens: 26000, capacity_tokens: 32000, available_tokens: 6000, measurement: 'actual', scope: 'request' }), (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d));
  assert.equal(hot.valueText, '81%');
  assert.deepEqual(hot.dot, { tone: 'warn', pulse: false });
  const exactly = model.buildSection('context', wrapper({ used_tokens: 80, capacity_tokens: 100, available_tokens: 20, measurement: 'actual', scope: 'request' }), (k, d) => d);
  assert.equal(exactly.dot.tone, 'warn', '80% itself is amber');
});

test('Context: unknown is never a percentage or zero', () => {
  const jt = (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d);
  const noCapacity = model.buildSection('context', wrapper({ used_tokens: 18400, capacity_tokens: null, available_tokens: null, measurement: 'estimated', scope: 'request' }), jt);
  assert.equal(noCapacity.valueText, '18.4k tokens');
  assert.equal(noCapacity.dot, null);
  assert.ok(noCapacity.rows.some((row) => /Estimated/.test(row.text)), 'an estimate says so');
  assert.equal(noCapacity.rows.some((row) => row.text === 'Available'), false, 'available only when comparable counts are known');
  const nothing = model.buildSection('context', wrapper({ used_tokens: null, capacity_tokens: null, available_tokens: null, measurement: 'actual', scope: 'request' }), jt);
  assert.equal(nothing.valueText, 'Unknown');
  assert.doesNotMatch(nothing.valueText, /0/);
  const zeroCapacity = model.buildSection('context', wrapper({ used_tokens: 5, capacity_tokens: 0, available_tokens: null, measurement: 'actual', scope: 'request' }), jt);
  assert.doesNotMatch(zeroCapacity.valueText, /%|Infinity|NaN/);
});

test('Outputs: count in the header, rows open the artifact by id, open when it has items', () => {
  const outputs = byKey(build(), 'outputs');
  assert.equal(outputs.valueText, '2');
  assert.equal(outputs.open, true);
  assert.deepEqual(outputs.rows.map((row) => [row.surface, row.resourceRef, row.text]), [
    ['outputs', 'art_1', 'context_probe.py'], ['outputs', 'art_2', 'results.md'],
  ]);
  assert.equal(outputs.rows[1].meta, 'Unavailable', 'a missing artifact says unavailable');
  const none = model.buildSection('outputs', wrapper({ items: [], total_count: 0, next_cursor: null }), (k, d) => d);
  assert.equal(none.valueText, 'None yet');
  assert.equal(none.defaultOpen, false);
  const more = model.buildSection('outputs', wrapper({ items: [{ artifact_id: 'a', display_name: 'a.txt', kind: 'text', availability: 'available' }], total_count: 14, next_cursor: null }), (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d));
  assert.equal(more.rows.at(-1).text, '13 more');
  assert.equal(more.rows.at(-1).resourceRef, '');
});

test('Outputs: an artifact id that is not a string never becomes a row', () => {
  const section = model.buildSection('outputs', wrapper({ items: [{ artifact_id: '', display_name: 'x' }, { artifact_id: 7, display_name: 'y' }, null, 'z'], total_count: 0 }), (k, d) => d);
  assert.deepEqual(section.rows.map((row) => row.kind), ['note']);
});

test('Changes: +added \u2212deleted with the working-tree scope named; closed by default', () => {
  const changes = byKey(build(), 'changes');
  assert.equal(changes.valueText, '+412 \u221237');
  assert.deepEqual(changes.parts, [{ text: '+412', tone: 'add' }, { text: '\u221237', tone: 'del' }]);
  assert.equal(changes.open, false);
  assert.ok(changes.rows.some((row) => row.text === 'Working tree' && /6 files/.test(row.meta)), 'the scope is named');
  assert.ok(changes.rows.some((row) => row.surface === 'changes'));
});

test('Changes: unmeasurable counts fall back to the file count, never to zero', () => {
  const jt = (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d);
  const unmeasured = model.buildSection('changes', wrapper({ file_count: 3, additions: null, deletions: null, ref: 'main', head: null, scope: 'working_tree' }), jt);
  assert.equal(unmeasured.valueText, '3 files');
  assert.equal(unmeasured.parts, null);
  const clean = model.buildSection('changes', wrapper({ file_count: 0, additions: 0, deletions: 0, ref: 'main', head: 'a', scope: 'working_tree' }), jt);
  assert.equal(clean.valueText, 'No changes');
  const unknown = model.buildSection('changes', wrapper({ file_count: null, additions: null, deletions: null, ref: null, head: null, scope: 'working_tree' }), jt);
  assert.equal(unknown.valueText, 'Unknown');
});

test('Changes: a non-Git workspace says so; an unavailable section is a word', () => {
  const nonGit = model.buildSection('changes', { state: 'not_applicable', reason: 'not_a_git_repository', sampled_at: null, data: null }, (k, d) => d);
  assert.equal(nonGit.valueText, 'Not a Git repository');
  assert.deepEqual(nonGit.rows, []);
  const off = model.buildSection('changes', { state: 'unavailable', reason: 'feature_disabled', sampled_at: null, data: null }, (k, d) => d);
  assert.equal(off.valueText, 'Unavailable');
  const other = model.buildSection('environment', { state: 'not_applicable', reason: 'x', sampled_at: null, data: null }, (k, d) => d);
  assert.equal(other.valueText, 'Not applicable');
});

test('Background tasks: running count with a live dot, partial-coverage line, open when anything is active', () => {
  const tasks = byKey(build(), 'background_tasks');
  assert.equal(tasks.valueText, '1 running');
  assert.deepEqual(tasks.dot, { tone: 'active', pulse: true });
  assert.equal(tasks.open, true);
  assert.equal(tasks.rows[0].text, 'Workspace tests');
  assert.equal(tasks.rows[0].meta, 'Running');
  assert.ok(tasks.rows.some((row) => row.text === '12 finished' && row.surface === 'background_tasks'));
  assert.ok(tasks.rows.some((row) => row.kind === 'note' && row.text === "Some sources aren't connected yet."));
});

test('Background tasks: empty connected sources say None yet without claiming complete counts', () => {
  const jt = (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d);
  const unknown = model.buildSection('background_tasks', wrapper({ scope: 'session_and_direct_children', counts: { active: null, waiting: null, failed: null, completed: null }, coverage: 'partial', unsupported_sources: ['session_runtime', 'linked_chat_turn'], items: [] }), jt);
  assert.equal(unknown.valueText, 'None yet');
  assert.equal(unknown.dot, null);
  assert.equal(unknown.defaultOpen, false);
  const quiet = model.buildSection('background_tasks', wrapper({ counts: { active: 0, waiting: 0, failed: 0, completed: 0 }, coverage: 'complete', unsupported_sources: [], items: [] }), jt);
  assert.equal(quiet.valueText, 'None yet');
  assert.equal(quiet.rows.some((row) => row.kind === 'note'), false, 'complete coverage has no partial line');
  const idle = model.buildSection('background_tasks', wrapper({ counts: { active: 0, waiting: 0, failed: 0, completed: 12 }, coverage: 'complete', unsupported_sources: [], items: [] }), jt);
  assert.equal(idle.valueText, 'None running');
  const failing = model.buildSection('background_tasks', wrapper({ counts: { active: 0, waiting: 0, failed: 2, completed: 0 }, coverage: 'complete', unsupported_sources: [], items: [] }), jt);
  assert.equal(failing.valueText, '2 failed');
  assert.equal(failing.dot.tone, 'error');
});

test('Background tasks: rows are deduplicated by operation id and capped', () => {
  const items = [];
  for (let n = 0; n < 9; n += 1) items.push({ source_kind: 'session_runtime', operation_id: `op_${n % 7}`, state: n % 2 ? 'queued' : 'completed' });
  const section = model.buildSection('background_tasks', wrapper({ counts: { active: 0, waiting: 4, failed: 0, completed: 3 }, coverage: 'complete', unsupported_sources: [], items }), (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d));
  const taskRows = section.rows.filter((row) => row.key.startsWith('task:'));
  assert.equal(new Set(taskRows.map((row) => row.key)).size, taskRows.length, 'no operation twice');
  assert.ok(taskRows.length <= model.MAX_BACKGROUND_ROWS);
  assert.equal(section.valueText, '4 waiting');
});

test('stale data keeps its value with the muted word and no live dot', () => {
  const vm = build({
    summary: summary({
      context: wrapper({ used_tokens: 26000, capacity_tokens: 32000, available_tokens: 6000, measurement: 'actual', scope: 'request' }, 'stale'),
    }),
  });
  const ctx = byKey(vm, 'context');
  assert.equal(ctx.state, 'stale');
  assert.equal(ctx.valueText, '81% \u00b7 stale');
  assert.equal(ctx.dot, null, 'a stale reading is never an alert');
});

test('disclosures: persisted values win; defaults apply only where null; overrides win for an unconfirmed toggle', () => {
  const defaults = build();
  assert.deepEqual(defaults.sections.map((section) => [section.key, section.open]), [
    ['environment', true], ['context', false], ['outputs', true], ['changes', false], ['background_tasks', true],
  ]);
  const persisted = build({ workspaceView: { disclosures: { environment: false, context: true, outputs: false, changes: true, background_tasks: false } } });
  assert.deepEqual(persisted.sections.map((section) => section.open), [false, true, false, true, false]);
  const partial = build({ workspaceView: { disclosures: { context: true } } });
  assert.equal(byKey(partial, 'context').open, true);
  assert.equal(byKey(partial, 'environment').open, true, 'an unset key still takes its default');
  const override = build({ workspaceView: { disclosures: { context: false } }, overrides: { context: true, changes: true } });
  assert.equal(byKey(override, 'context').open, true);
  assert.equal(byKey(override, 'changes').open, true);
  const junk = build({ workspaceView: { disclosures: { context: 'yes', outputs: 1 } } });
  assert.equal(byKey(junk, 'context').open, false, 'non-boolean persisted values are ignored');
  assert.equal(byKey(junk, 'outputs').open, true);
});

test('Background tasks default closed when nothing is active', () => {
  const idle = build({
    summary: summary({
      background_tasks: wrapper({ scope: 'session_and_direct_children', counts: { active: 0, waiting: 0, failed: 0, completed: 12 }, coverage: 'complete', unsupported_sources: [], items: [] }),
    }),
  });
  assert.equal(byKey(idle, 'background_tasks').open, false);
});

test('formatTokens: compact, never invents a number', () => {
  assert.equal(model.formatTokens(0), '0');
  assert.equal(model.formatTokens(742), '742');
  assert.equal(model.formatTokens(1000), '1k');
  assert.equal(model.formatTokens(18400), '18.4k');
  assert.equal(model.formatTokens(131072), '131k');
  assert.equal(model.formatTokens(2500000), '2.5M');
  assert.equal(model.formatTokens(null), '');
  assert.equal(model.formatTokens(-5), '');
  assert.equal(model.formatTokens(1.5), '');
  assert.equal(model.formatTokens('12'), '');
});

test('copy resolves through the supplied translator with parameters', () => {
  const seen = [];
  const jt = (key, fallback, params) => { seen.push(key); return `[${key}]${params ? JSON.stringify(params) : ''}`; };
  const vm = model.buildRailViewModel({ summary: summary(), sessionId: SID, jt });
  assert.ok(seen.every((key) => /^(chat\.sessionRail\.|composer\.runMode\.)/.test(key)), `only expected namespaces: ${[...new Set(seen)].filter((k) => !/^(chat\.sessionRail\.|composer\.runMode\.)/.test(k))}`);
  assert.match(byKey(vm, 'background_tasks').valueText, /chat\.sessionRail\.tasks\.running/);
});

/* ── Row 59 checkpoint 5a-2 (R4): linked chat turns ───────────────────────────────────────────── */

const render = require('../renderer/chat/renderer-session-rail-render.js');

const plainJt = (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d);

function linkedItem(overrides = {}) {
  return {
    source_kind: 'linked_chat_turn', operation_id: 'work_1', session_id: 'sess_child', state: 'running',
    started_at: '2026-10-15T10:00:00.000Z', finished_at: null, output_ref: null, title: 'Fix the flaky test', ...overrides,
  };
}

test('Background tasks: needs_attention is its own labelled phase, never Unknown', () => {
  const section = model.buildSection('background_tasks', wrapper({
    counts: { active: 0, waiting: 0, failed: 1, completed: 0 }, coverage: 'partial', unsupported_sources: ['workspace_test', 'session_runtime'],
    items: [linkedItem({ state: 'needs_attention' }), linkedItem({ operation_id: 'work_2', state: 'weird_state' })],
  }), plainJt);
  const [attention, unknown] = section.rows.filter((row) => row.key.startsWith('task:'));
  assert.equal(attention.meta, 'Needs attention');
  assert.deepEqual(attention.dot, { tone: 'warn', pulse: false });
  assert.equal(unknown.meta, 'Unknown');
  assert.equal(unknown.dot, null);
});

test('Background tasks: a linked chat row shows the child title and carries the child to open', () => {
  const section = model.buildSection('background_tasks', wrapper({
    counts: { active: 1, waiting: null, failed: null, completed: null }, coverage: 'partial', unsupported_sources: ['workspace_test', 'session_runtime'],
    items: [linkedItem(), linkedItem({ operation_id: 'work_3', title: null, state: 'completed' })],
  }), plainJt);
  const [titled, untitled] = section.rows.filter((row) => row.key.startsWith('task:'));
  assert.equal(titled.text, 'Fix the flaky test');
  assert.equal(titled.meta, 'Running');
  assert.equal(titled.sessionRef, 'sess_child');
  assert.equal(titled.surface, 'background_tasks', 'a rail without openSession still opens the task detail');
  assert.equal(titled.title, 'Linked chat: Fix the flaky test (Running)');
  assert.equal(untitled.text, 'Linked chat', 'a missing title falls back to the source label');
  assert.equal(untitled.sessionRef, 'sess_child');
  const ordinary = model.buildSection('background_tasks', wrapper({
    counts: { active: 1, waiting: null, failed: null, completed: null }, coverage: 'partial', unsupported_sources: [],
    items: [{ source_kind: 'workspace_test', operation_id: 'r1', state: 'running', title: 'ignored' }],
  }), plainJt).rows[0];
  assert.equal(ordinary.text, 'Workspace tests');
  assert.equal('sessionRef' in ordinary, false);
});

test('rail markup: a linked row exposes data-rail-session, the title is escaped, ordinary rows have none', () => {
  const section = model.buildSection('background_tasks', wrapper({
    counts: { active: 2, waiting: null, failed: null, completed: null }, coverage: 'partial', unsupported_sources: [],
    items: [linkedItem({ title: '<img src=x onerror=alert(1)>' }), { source_kind: 'workspace_test', operation_id: 'r1', state: 'running' }],
  }), plainJt);
  const html = render.bodyHtml(section);
  assert.match(html, /data-rail-session="sess_child"/);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal((html.match(/data-rail-session=/g) || []).length, 1);
  assert.equal((html.match(/data-rail-surface="background_tasks"/g) || []).length, 2, 'every task row keeps its detail surface');
});
