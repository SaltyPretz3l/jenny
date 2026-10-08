'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const taskBoardTool = require('../services/tools/builtin/task-board-tool');

function task(index, overrides = {}) {
  return {
    id: `task-${index}`,
    label: `Task ${index}`,
    body: '',
    status: 'active',
    sourceKind: 'agent_task',
    projectId: 'project_a',
    ...overrides,
  };
}

const PROJECT_A = Object.freeze({ projectAuthority: Object.freeze({ project_id: 'project_a' }) });
const PROJECT_B = Object.freeze({ projectAuthority: Object.freeze({ project_id: 'project_b' }) });

function ctx(configService, base = PROJECT_A) {
  return { configService, ...base };
}

function createConfigService(followUps, { persist = true } = {}) {
  const state = { followUps: structuredClone(followUps) };
  let nextId = state.followUps.length + 1;
  const service = {
    upsertCalls: 0,
    getState: () => structuredClone(state),
    upsertFollowUp(input) {
      service.upsertCalls += 1;
      if (persist) state.followUps.push(task(nextId++, input));
      return service.getState();
    },
    updateFollowUp(id, patch) {
      if (!persist) return service.getState();
      const existing = state.followUps.find((entry) => entry.id === id);
      if (existing) Object.assign(existing, patch);
      return service.getState();
    },
    activateFollowUp(id) {
      if (persist) state.followUps.find((entry) => entry.id === id).status = 'active';
      return service.getState();
    },
    resolveFollowUp(id) {
      if (persist) state.followUps.find((entry) => entry.id === id).status = 'resolved';
      return service.getState();
    },
    deleteFollowUp(id) {
      service.deletedIds = (service.deletedIds || []).concat(id);
      if (persist) state.followUps = state.followUps.filter((entry) => entry.id !== id);
      return service.getState();
    },
  };
  return service;
}

test('the 201st open agent task of a project is refused at the 200-task cap', async () => {
  const configService = createConfigService(Array.from({ length: 200 }, (_, index) => task(index)));

  const result = await taskBoardTool.execute({ action: 'add', title: 'Overflow' }, ctx(configService));

  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'task_limit_reached');
  assert.match(result.content, /200 open agent tasks in this project/);
  assert.equal(configService.upsertCalls, 0);
});

test('list renders at most 200 rows and a trailer for hidden tasks', async () => {
  const configService = createConfigService(Array.from({ length: 201 }, (_, index) => task(index)));

  const result = await taskBoardTool.execute({ action: 'list' }, ctx(configService));
  const lines = result.content.split('\n');

  assert.equal(result.isError, false);
  assert.equal(lines.length, 201);
  assert.equal(lines[199].startsWith('- id=task-199'), true);
  assert.equal(lines[200], '... and 1 more');
  assert.equal(result.metadata.count, 201);
});

test('blocked task updates and completion report persistence_failed', async () => {
  const configService = createConfigService([task(1)], { persist: false });

  const updated = await taskBoardTool.execute({
    action: 'update',
    id: 'task-1',
    title: 'Changed',
    notes: 'Changed notes',
    status: 'resolved',
  }, ctx(configService));
  const completed = await taskBoardTool.execute({ action: 'complete', id: 'task-1' }, ctx(configService));

  assert.equal(updated.isError, true);
  assert.equal(updated.metadata.reason, 'persistence_failed');
  assert.equal(completed.isError, true);
  assert.equal(completed.metadata.reason, 'persistence_failed');
});

test('a blank title is refused before any write instead of being saved as a placeholder', async () => {
  const configService = createConfigService([task(1)]);

  const result = await taskBoardTool.execute({ action: 'update', id: 'task-1', title: '   ' }, ctx(configService));

  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'invalid_title');
  assert.equal(configService.getState().followUps[0].label, 'Task 1');
});

test('a task added from one project is invisible to another project and reads as not_found', async () => {
  const configService = createConfigService([]);
  const added = await taskBoardTool.execute({ action: 'add', title: 'Only for A' }, ctx(configService, PROJECT_A));
  const taskId = added.metadata.task_id;

  const listedA = await taskBoardTool.execute({ action: 'list' }, ctx(configService, PROJECT_A));
  const listedB = await taskBoardTool.execute({ action: 'list' }, ctx(configService, PROJECT_B));
  assert.equal(listedA.metadata.count, 1);
  assert.equal(listedB.metadata.count, 0);
  assert.equal(listedB.content, 'No agent tasks found.');

  const missing = await taskBoardTool.execute({ action: 'complete', id: taskId }, ctx(configService, PROJECT_B));
  const genuinelyMissing = await taskBoardTool.execute({ action: 'complete', id: 'task-does-not-exist' }, ctx(configService, PROJECT_B));
  const crossUpdate = await taskBoardTool.execute({ action: 'update', id: taskId, title: 'Hijack' }, ctx(configService, PROJECT_B));
  assert.equal(missing.isError, true);
  assert.equal(missing.metadata.reason, 'not_found');
  assert.equal(crossUpdate.metadata.reason, 'not_found');
  assert.equal(genuinelyMissing.metadata.reason, 'not_found');
  assert.equal(missing.content, genuinelyMissing.content.replace('task-does-not-exist', taskId));
  assert.equal(crossUpdate.content, missing.content);
  assert.equal(missing.summary, genuinelyMissing.summary);
  const stored = configService.getState().followUps.find((entry) => entry.id === taskId);
  assert.equal(stored.label, 'Only for A');
  assert.equal(stored.status, 'active');
});

test('add stamps the context project and session on the persisted follow-up', async () => {
  const configService = createConfigService([]);
  let payload = null;
  const original = configService.upsertFollowUp;
  configService.upsertFollowUp = (input) => {
    payload = input;
    return original(input);
  };

  const result = await taskBoardTool.execute({ action: 'add', title: 'Stamp me' }, {
    ...ctx(configService, PROJECT_B),
    sessionId: 'session_1',
  });

  assert.equal(result.isError, false);
  assert.equal(payload.projectId, 'project_b');
  assert.equal(payload.sessionId, 'session_1');
  assert.equal(result.metadata.project_id, 'project_b');
});

test('resolved tasks do not count toward the add cap', async () => {
  const configService = createConfigService(
    Array.from({ length: 200 }, (_, index) => task(index, { status: 'resolved' }))
  );

  const added = await taskBoardTool.execute({ action: 'add', title: 'Still room' }, ctx(configService));
  const listed = await taskBoardTool.execute({ action: 'list' }, ctx(configService));

  assert.equal(added.isError, false);
  assert.equal(configService.upsertCalls, 1);
  assert.equal(listed.metadata.count, 201);
  // The new open task is listed first; the resolved tail is what gets cut, newest first.
  const lines = listed.content.split('\n');
  assert.match(lines[0], /title=Still room \| status=active/u);
  assert.match(lines[1], /id=task-199 \| .* status=resolved/u);
  assert.equal(lines.at(-1), '... and 1 more');
  assert.equal(lines.some((line) => line.includes('id=task-0 |')), false);
});

test('completing a task prunes the project resolved tail beyond the newest 200', async () => {
  const configService = createConfigService([
    ...Array.from({ length: 200 }, (_, index) => task(index, { status: 'resolved' })),
    task(900, { status: 'resolved', projectId: 'project_b' }),
    task(901, { status: 'active' }),
  ]);

  const result = await taskBoardTool.execute({ action: 'complete', id: 'task-901' }, ctx(configService));
  assert.equal(result.isError, false);
  // Oldest resolved row of project A goes (store order: no stamps); project B's and the newly resolved one stay.
  assert.deepEqual(configService.deletedIds, ['task-0']);
  const ids = configService.getState().followUps.map((entry) => entry.id);
  assert.equal(ids.includes('task-900'), true);
  assert.equal(ids.includes('task-901'), true);
  assert.equal(ids.filter((id) => id !== 'task-900').length, 200);
});

test('deferred tasks count as open toward the cap', async () => {
  const configService = createConfigService(
    Array.from({ length: 200 }, (_, index) => task(index, { status: 'deferred' }))
  );

  const result = await taskBoardTool.execute({ action: 'add', title: 'Overflow' }, ctx(configService));

  assert.equal(result.metadata.reason, 'task_limit_reached');
});

test('open tasks in another project do not count toward this project cap', async () => {
  const configService = createConfigService(
    Array.from({ length: 200 }, (_, index) => task(index, { projectId: 'project_b' }))
  );

  const added = await taskBoardTool.execute({ action: 'add', title: 'Fits in A' }, ctx(configService, PROJECT_A));

  assert.equal(added.isError, false);
});

test('unbackfilled tasks without a project are visible to no project', async () => {
  const configService = createConfigService([task(1, { projectId: '' }), task(2, { projectId: undefined })]);

  const listed = await taskBoardTool.execute({ action: 'list' }, ctx(configService, PROJECT_A));
  const completed = await taskBoardTool.execute({ action: 'complete', id: 'task-1' }, ctx(configService, PROJECT_A));

  assert.equal(listed.metadata.count, 0);
  assert.equal(completed.metadata.reason, 'not_found');
});

test('a request without a project fails closed for every action and writes nothing', async () => {
  const configService = createConfigService([task(1)]);
  const noProject = [{}, { projectAuthority: null }, { projectAuthority: { project_id: '' } }];

  for (const base of noProject) {
    for (const input of [
      { action: 'list' },
      { action: 'add', title: 'Nope' },
      { action: 'update', id: 'task-1', title: 'Nope' },
      { action: 'complete', id: 'task-1' },
    ]) {
      const result = await taskBoardTool.execute(input, { configService, ...base });
      assert.equal(result.isError, true, input.action);
      assert.equal(result.metadata.reason, 'project_unavailable');
      assert.equal(result.summary, 'Task board unavailable');
    }
  }
  assert.equal(configService.upsertCalls, 0);
  assert.equal(configService.getState().followUps[0].status, 'active');
  assert.equal(configService.getState().followUps[0].label, 'Task 1');
});

test('every successful action reports the project in metadata', async () => {
  const configService = createConfigService([]);
  const added = await taskBoardTool.execute({ action: 'add', title: 'Meta' }, ctx(configService));
  const id = added.metadata.task_id;
  const results = [
    added,
    await taskBoardTool.execute({ action: 'update', id, notes: 'n' }, ctx(configService)),
    await taskBoardTool.execute({ action: 'complete', id }, ctx(configService)),
    await taskBoardTool.execute({ action: 'list' }, ctx(configService)),
  ];

  for (const result of results) assert.equal(result.metadata.project_id, 'project_a');
});

test('completing the oldest-created task never prunes that task; the resolved tail goes by resolution time', async () => {
  const configService = createConfigService([
    task(0, { status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }),
    ...Array.from({ length: 200 }, (_, index) => task(index + 1, {
      status: 'resolved', createdAt: '2026-02-01T00:00:00.000Z', resolvedAt: `2026-03-01T00:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60)).padStart(2, '0')}.000Z`,
    })),
  ]);
  const result = await taskBoardTool.execute({ action: 'complete', id: 'task-0' }, ctx(configService));
  assert.equal(result.isError, false, result.content);
  // task-1 has the earliest resolvedAt (00:00:00); the just-completed task-0 is kept whatever its stamps.
  assert.deepEqual(configService.deletedIds, ['task-1']);
  const completed = configService.getState().followUps.find((entry) => entry.id === 'task-0');
  assert.equal(completed.status, 'resolved');
  // Listing shows the resolved tail by resolution time, newest first.
  const listed = await taskBoardTool.execute({ action: 'list' }, ctx(configService));
  const ids = listed.content.split('\n').map((line) => (line.match(/id=(task-\d+)/u) || [])[1]).filter(Boolean);
  // Stamps are 00:<index % 60>:<index / 60>, so index 179 (minute 59, second 2) is the newest.
  assert.equal(ids[0], 'task-180');
  assert.equal(ids.includes('task-1'), false);
});

test('reopening a resolved task counts against the open cap like add', async () => {
  const configService = createConfigService([
    ...Array.from({ length: 200 }, (_, index) => task(index)),
    task(500, { status: 'resolved' }),
  ]);
  const reopened = await taskBoardTool.execute({ action: 'update', id: 'task-500', status: 'active' }, ctx(configService));
  assert.equal(reopened.isError, true);
  assert.equal(reopened.metadata.reason, 'task_limit_reached');
  assert.equal(configService.getState().followUps.find((entry) => entry.id === 'task-500').status, 'resolved');
  // A title edit on the resolved task is not a reopen and still goes through.
  const retitled = await taskBoardTool.execute({ action: 'update', id: 'task-500', title: 'Still resolved' }, ctx(configService));
  assert.equal(retitled.isError, false, retitled.content);
});
