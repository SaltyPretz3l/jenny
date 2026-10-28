const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../renderer/shell/renderer-chats-panel-model');
const panel = require('../renderer/shell/renderer-chats-panel');

const NOW = new Date(Date.UTC(2026, 9, 21, 12, 0, 0));
const iso = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
const GENERAL = 'project_general';

function chat(id, minutesAgo, project, extra = {}) {
  const session = { id, title: `Chat ${id}`, updated_at: iso(minutesAgo), created_at: iso(minutesAgo + 500), pinned: false, archived_at: null, ...extra };
  if (project) session.project_id = project;
  return session;
}

function child(id, parentId, project, updatedAgo, extra = {}) {
  return chat(id, updatedAgo, project, {
    spawned_from: { parent_session_id: parentId, proposal_id: `proposal_${id}`, created_at: iso(updatedAgo + 100) },
    ...extra,
  });
}

function build(sessions, options = {}) {
  return model.buildChatsViewModel({ sessions, groupMode: 'project', now: NOW, ...options });
}

const projectGroups = (view) => view.groups.filter((group) => group.kind === 'project');
const idsOf = (group) => group.items.map((item) => item.id);

const TWO_PROJECTS = [chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b'), chat('g1', 3)];

test('the panel re-exports the model builder unchanged', () => {
  assert.equal(panel.buildChatsViewModel, model.buildChatsViewModel);
  assert.deepEqual([model.PAGE_SIZE, model.MAX_VISIBLE, model.SEARCH_LIMIT, model.PROJECT_PAGE, model.PROJECT_PAGE_STEP], [100, 500, 200, 5, 50]);
});

test('date mode is the default and keeps the date groups', () => {
  const view = model.buildChatsViewModel({ sessions: TWO_PROJECTS, now: NOW, projects: [{ id: 'p_a', name: 'A' }] });
  assert.equal(view.grouping, 'date');
  assert.equal(view.groupByAvailable, true);
  assert.deepEqual(view.groups.map((group) => group.key), ['recent_today']);
  assert.equal(view.groups[0].kind, undefined);
  assert.deepEqual(view.visibleSessions.map((s) => s.id), ['a1', 'b1', 'g1']);
  assert.equal(view.hasMore, false);
});

test('project grouping applies only with two or more projects, no filter and project mode', () => {
  assert.equal(build(TWO_PROJECTS).grouping, 'project');
  const one = build([chat('a1', 1, 'p_a'), chat('a2', 2, 'p_a')]);
  assert.equal(one.grouping, 'date');
  assert.equal(one.groupByAvailable, false);
  const filtered = build(TWO_PROJECTS, { projectId: 'p_a' });
  assert.equal(filtered.grouping, 'date');
  assert.equal(filtered.groupByAvailable, true, 'the button availability ignores the filter');
  assert.equal(build(TWO_PROJECTS, { groupMode: 'date' }).grouping, 'date');
});

test('the current Workspace project counts toward the two-project rule in recent scope without a query', () => {
  const sessions = [chat('a1', 1, 'p_a'), chat('a2', 2, 'p_a')];
  const view = build(sessions, { currentProjectId: 'p_b', projects: [{ id: 'p_b', name: 'B' }, { id: 'p_a', name: 'A' }] });
  assert.equal(view.grouping, 'project');
  assert.equal(view.groupByAvailable, false);
  assert.equal(build(sessions, { currentProjectId: 'p_b', query: 'chat' }).grouping, 'date');
  const archived = sessions.map((s) => ({ ...s, archived_at: iso(1) }));
  assert.equal(build(archived, { scope: 'archived', currentProjectId: 'p_b' }).grouping, 'date');
});

test('projects are ordered by the projects list, unlisted ids before General, newest first', () => {
  const sessions = [
    chat('g1', 1), chat('a1', 5, 'p_a'), chat('x1', 30, 'p_x'), chat('y1', 10, 'p_y'), chat('b1', 50, 'p_b'),
  ];
  const listed = build(sessions, { projects: [{ id: 'p_b', name: 'B' }, { id: 'p_a', name: 'A' }, { id: GENERAL, name: 'General' }] });
  assert.deepEqual(projectGroups(listed).map((g) => g.projectId), ['p_b', 'p_a', 'p_y', 'p_x', GENERAL]);
  assert.deepEqual(projectGroups(listed).map((g) => g.label).slice(0, 2), ['B', 'A']);
  const bare = build(sessions);
  assert.deepEqual(projectGroups(bare).map((g) => g.projectId), ['p_a', 'p_y', 'p_x', 'p_b', GENERAL], 'no list: newest chat first, General last');
});

test('label falls back to projectName(id) and then to the General/Project defaults', () => {
  const view = build(TWO_PROJECTS, { projectName: (id) => `fallback ${id}`, projects: [{ id: 'p_a', name: 'Alpha' }] });
  const labels = Object.fromEntries(projectGroups(view).map((g) => [g.projectId, g.label]));
  assert.deepEqual(labels, { p_a: 'Alpha', p_b: 'fallback p_b', [GENERAL]: 'fallback project_general' });
  const defaults = Object.fromEntries(projectGroups(build(TWO_PROJECTS)).map((g) => [g.projectId, g.label]));
  assert.deepEqual(defaults, { p_a: 'Project', p_b: 'Project', [GENERAL]: 'General' });
});

test('pinned and primary chats lead in a Pinned group and are not counted by their project', () => {
  const sessions = [
    chat('a1', 1, 'p_a'), chat('a2', 2, 'p_a', { pinned: true }), chat('b1', 3, 'p_b'),
    chat('jenny', 9000, undefined, { session_role: 'primary' }),
  ];
  const view = build(sessions);
  const first = view.groups[0];
  assert.equal(first.key, 'recent_pinned');
  assert.equal(first.kind, undefined);
  assert.deepEqual(idsOf(first), ['jenny', 'a2']);
  assert.equal(projectGroups(view).some((g) => g.projectId === GENERAL), false, 'the primary chat adds no General project');
  const a = projectGroups(view).find((g) => g.projectId === 'p_a');
  assert.deepEqual(idsOf(a), ['a1']);
  assert.equal(a.count, 1);
  assert.equal(view.visibleCount, view.visibleSessions.length);
});

test('a project shows five newest roots, then Show more steps, then Show less', () => {
  const sessions = [chat('b1', 1, 'p_b')];
  for (let i = 0; i < 12; i += 1) sessions.push(chat(`a${i}`, 10 + i, 'p_a'));
  const view = build(sessions);
  const a = projectGroups(view).find((g) => g.projectId === 'p_a');
  assert.deepEqual([a.count, a.rootIds.length, a.shownRoots, a.remaining, a.canShowLess], [12, 12, 5, 7, false]);
  assert.deepEqual(idsOf(a), ['a0', 'a1', 'a2', 'a3', 'a4']);
  const more = build(sessions, { projectLimits: new Map([['p_a', 10]]) });
  const a2 = projectGroups(more).find((g) => g.projectId === 'p_a');
  assert.deepEqual([a2.shownRoots, a2.remaining, a2.canShowLess], [10, 2, false]);
  const all = build(sessions, { projectLimits: new Map([['p_a', 60]]) });
  const a3 = projectGroups(all).find((g) => g.projectId === 'p_a');
  assert.deepEqual([a3.shownRoots, a3.remaining, a3.canShowLess], [12, 0, true]);
  const small = projectGroups(all).find((g) => g.projectId === 'p_b');
  assert.deepEqual([small.shownRoots, small.canShowLess], [1, false]);
  assert.equal(all.hasMore, false);
  assert.equal(all.remaining, 0);
});

test('linked children are emitted under their root and counted, without using the root limit', () => {
  const sessions = [chat('b1', 1, 'p_b')];
  for (let i = 0; i < 6; i += 1) sessions.push(chat(`a${i}`, 10 + i, 'p_a'));
  sessions.push(child('k1', 'a0', 'p_a', 200), child('k2', 'a0', 'p_a', 201));
  const view = build(sessions);
  const a = projectGroups(view).find((g) => g.projectId === 'p_a');
  assert.equal(a.count, 8);
  assert.equal(a.rootIds.length, 6);
  assert.deepEqual(idsOf(a), ['a0', 'k2', 'k1', 'a1', 'a2', 'a3', 'a4'].filter((id) => idsOf(a).includes(id)));
  assert.equal(idsOf(a).length, 7, 'five roots plus the two children of the first');
  assert.equal(a.sessionIds.length, 8);
  const hidden = build(sessions.map((s) => (s.id === 'a0' ? { ...s, children_expanded: false } : s)));
  assert.equal(idsOf(projectGroups(hidden).find((g) => g.projectId === 'p_a')).includes('k1'), false);
});

test('a collapsed project mounts no rows and rolls up its tone: approval, then streaming, then unread', () => {
  const sessions = [chat('a1', 1, 'p_a'), chat('a2', 2, 'p_a', { unread_message_count: 2 }), chat('b1', 3, 'p_b')];
  const tone = (options) => projectGroups(build(sessions, { collapsedProjects: { p_a: true }, ...options })).find((g) => g.projectId === 'p_a');
  const quiet = tone({ collapsedProjects: { p_a: true } });
  assert.deepEqual([quiet.collapsed, quiet.items, quiet.shownRoots, quiet.remaining, quiet.canShowLess], [true, [], 0, 0, false]);
  assert.equal(quiet.tone, 'unread');
  assert.deepEqual(quiet.sessionIds.slice().sort(), ['a1', 'a2']);
  assert.equal(tone({ runtimeState: (id) => (id === 'a1' ? 'streaming' : '') }).tone, 'streaming');
  assert.equal(tone({ runtimeState: (id) => (id === 'a1' ? 'streaming' : 'approval') }).tone, 'approval');
  const noUnread = projectGroups(build([chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b')], { collapsedProjects: { p_a: true } })).find((g) => g.projectId === 'p_a');
  assert.equal(noUnread.collapsed, true);
  assert.equal(noUnread.tone, '');
  const open = projectGroups(build(sessions, { runtimeState: () => 'approval' })).find((g) => g.projectId === 'p_a');
  assert.equal(open.tone, '', 'an open project has no roll-up tone');
});

test('a query opens every project and lifts the per-project limit', () => {
  const sessions = [chat('b1', 1, 'p_b')];
  for (let i = 0; i < 9; i += 1) sessions.push(chat(`a${i}`, 10 + i, 'p_a'));
  const view = build(sessions, { query: 'chat', collapsedProjects: { p_a: true, p_b: true } });
  assert.equal(view.grouping, 'project');
  const a = projectGroups(view).find((g) => g.projectId === 'p_a');
  assert.deepEqual([a.collapsed, a.items.length, a.remaining, a.canShowLess, a.shownRoots], [false, 9, 0, false, 9]);
  assert.equal(view.capped, false);
  const narrow = build(sessions, { query: 'Chat a3' });
  assert.equal(narrow.grouping, 'date', 'one matching project falls back to the flat search list');
});

test('pinned chats never count toward the two-project rule', () => {
  const sessions = [chat('a1', 1, 'p_a'), chat('a2', 2, 'p_a'), chat('b1', 3, 'p_b', { pinned: true })];
  const view = build(sessions);
  assert.equal(view.grouping, 'date', 'one unpinned project is not worth a header');
  assert.equal(view.groupByAvailable, false);
});

test('a project past the 500-row cap stops offering more', () => {
  const sessions = Array.from({ length: 520 }, (_, index) => chat(`a${index}`, index + 1, 'p_a')).concat(chat('b1', 1, 'p_b'));
  const view = build(sessions, { projectLimits: new Map([['p_a', 505]]) });
  const alpha = projectGroups(view).find((group) => group.projectId === 'p_a');
  assert.deepEqual([alpha.shownRoots, alpha.remaining], [500, 0]);
});

test('the current project with no chats shows an empty open header in recent scope only', () => {
  const options = { currentProjectId: 'p_new', projects: [{ id: 'p_new', name: 'New' }, { id: 'p_a', name: 'A' }, { id: 'p_b', name: 'B' }] };
  const view = build([chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b')], options);
  const [first] = projectGroups(view);
  assert.deepEqual([first.projectId, first.count, first.items, first.collapsed, first.current], ['p_new', 0, [], false, true]);
  // The user may still collapse the current project; a Workspace switch is what opens it again.
  const collapsedCurrent = build([chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b')], { ...options, currentProjectId: 'p_a', collapsedProjects: { p_a: true } });
  const currentGroup = projectGroups(collapsedCurrent).find((g) => g.projectId === 'p_a');
  assert.deepEqual([currentGroup.current, currentGroup.collapsed, currentGroup.items], [true, true, []]);
  const queried = build([chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b')], { ...options, query: 'chat' });
  assert.equal(projectGroups(queried).some((g) => g.projectId === 'p_new'), false);
  const archived = [chat('a1', 1, 'p_a', { archived_at: iso(1) }), chat('b1', 2, 'p_b', { archived_at: iso(1) })];
  const archivedView = build(archived, { ...options, scope: 'archived' });
  assert.equal(projectGroups(archivedView).some((g) => g.projectId === 'p_new'), false);
  assert.equal(projectGroups(archivedView)[0].key, 'archived_project:p_a');
});

test('a child nests only under a parent in its own project; otherwise it is a root with a project origin', () => {
  const sessions = [
    chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b'),
    child('same', 'a1', 'p_a', 3),
    child('cross', 'a1', 'p_b', 4),
  ];
  const view = build(sessions);
  const a = projectGroups(view).find((g) => g.projectId === 'p_a');
  const b = projectGroups(view).find((g) => g.projectId === 'p_b');
  assert.deepEqual(idsOf(a), ['a1', 'same']);
  assert.deepEqual(idsOf(b), ['b1', 'cross']);
  assert.equal(view.nodes.get('same').parentId, 'a1');
  assert.equal(view.nodes.get('cross').depth, 0);
  assert.equal(view.nodes.get('cross').origin.kind, 'project');
  assert.equal(a.count, 2);
});

test('visibleSessions follows group order and emptyKind is empty whenever a project group exists', () => {
  const view = build(TWO_PROJECTS, { projects: [{ id: 'p_b', name: 'B' }] });
  assert.deepEqual(view.visibleSessions.map((s) => s.id), ['b1', 'a1', 'g1']);
  assert.equal(view.visibleCount, 3);
  assert.equal(view.emptyKind, '');
  assert.equal(view.matchedCount, 3);
  assert.equal(view.noHistory, false);
});

test('groupByAvailable counts projects with chats in the scope, ignoring filter and query', () => {
  assert.equal(build(TWO_PROJECTS, { query: 'Chat a1' }).groupByAvailable, true);
  assert.equal(build([chat('a1', 1, 'p_a')], { currentProjectId: 'p_b' }).groupByAvailable, false);
  const mixed = [chat('a1', 1, 'p_a'), chat('b1', 2, 'p_b', { archived_at: iso(1) })];
  assert.equal(build(mixed).groupByAvailable, false);
  assert.equal(build(mixed, { scope: 'archived' }).groupByAvailable, false);
});

test('project mode at 5,000 chats across 20 projects mounts five roots a project and stays cheap', () => {
  const sessions = Array.from({ length: 5000 }, (_, index) => chat(`c${index}`, index + 1, `p_${index % 20}`));
  const projects = Array.from({ length: 20 }, (_, index) => ({ id: `p_${index}`, name: `Project ${index}` }));
  build(sessions, { projects });
  const startedAt = process.hrtime.bigint();
  const view = build(sessions, { projects });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.equal(view.grouping, 'project');
  assert.equal(view.visibleCount, 20 * 5, 'only the first page of each project mounts');
  assert.equal(projectGroups(view).reduce((sum, group) => sum + group.count, 0), 5000);
  // About 6 ms measured on the owner's machine; the budget only catches a quadratic regression.
  assert.ok(elapsedMs < 250, `project-mode model took ${elapsedMs.toFixed(1)} ms`);
});
