'use strict';

// "Switch project" from the Workspace: the renderer names a project id, the
// main process resolves its folder from the project store and hands the path
// to the coordinator's trusted prepareTarget. The renderer never sends a path,
// so prepareTarget stays un-exposed over preload.

const assert = require('node:assert/strict');
const test = require('node:test');

const { prepareProjectTarget } = require('../services/projects/workspace-project-switch');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');

function harness(projects, { missing = [] } = {}) {
  const calls = [];
  const folderExists = async (rootPath) => { calls.push(['exists', rootPath]); return !missing.includes(rootPath); };
  const coordinator = {
    async prepareTarget(rootPath) { calls.push(['target', rootPath]); return { prepared: true, transitionId: 't1' }; },
    async prepareClear() { calls.push(['clear']); return { prepared: true, transitionId: 't2' }; },
  };
  const projectService = { get: (id) => projects[id] || null };
  return { calls, coordinator, projectService, folderExists };
}

test('a project with a folder switches the Workspace to that folder', async () => {
  const h = harness({ project_a: { id: 'project_a', root_path: 'D:\\Projects\\Ascend' } });
  const result = await prepareProjectTarget({ ...h, payload: { project_id: 'project_a' } });
  assert.deepEqual(result, { prepared: true, transitionId: 't1' });
  assert.deepEqual(h.calls, [['exists', 'D:\\Projects\\Ascend'], ['target', 'D:\\Projects\\Ascend']]);
});

test('General clears the Workspace folder instead of targeting a path', async () => {
  const h = harness({});
  const result = await prepareProjectTarget({ ...h, payload: { project_id: GENERAL_PROJECT_ID } });
  assert.equal(result.prepared, true);
  assert.deepEqual(h.calls, [['clear']]);
});

test('malformed, unknown and folderless projects are blocked without touching the coordinator', async () => {
  const h = harness({ project_nofolder: { id: 'project_nofolder', root_path: null } });
  for (const [payload, code] of [
    [undefined, 'invalid_project_request'],
    [{ project_id: 'project_a', extra: true }, 'invalid_project_request'],
    [{ project_id: 'not valid' }, 'invalid_project_id'],
    [{ project_id: 'project_missing' }, 'project_not_found'],
    [{ project_id: 'project_nofolder' }, 'project_root_unavailable'],
  ]) {
    const result = await prepareProjectTarget({ ...h, payload });
    assert.equal(result.prepared, false, code);
    assert.equal(result.blocked, true, code);
    assert.equal(result.code, code);
  }
  assert.deepEqual(h.calls, []);
});

test('a project whose folder is gone is blocked with workspace_folder_missing and the Workspace is left alone', async () => {
  const h = harness(
    { project_moved: { id: 'project_moved', root_path: 'D:\\Projects\\Moved' } },
    { missing: ['D:\\Projects\\Moved'] },
  );
  const result = await prepareProjectTarget({ ...h, payload: { project_id: 'project_moved' } });
  assert.equal(result.prepared, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'workspace_folder_missing');
  assert.deepEqual(h.calls, [['exists', 'D:\\Projects\\Moved']], 'the coordinator is never asked');
});

test('the default folder probe checks the real disk: a deleted folder is missing, a live one opens', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-switch-missing-'));
  try {
    const live = path.join(base, 'Live');
    fs.mkdirSync(live);
    const gone = path.join(base, 'Gone');
    const calls = [];
    const coordinator = { async prepareTarget(rootPath) { calls.push(rootPath); return { prepared: true }; } };
    const projectService = { get: (id) => ({
      project_live: { id: 'project_live', root_path: live },
      project_gone: { id: 'project_gone', root_path: gone },
    })[id] || null };
    const blocked = await prepareProjectTarget({ projectService, coordinator, payload: { project_id: 'project_gone' } });
    assert.equal(blocked.code, 'workspace_folder_missing');
    const opened = await prepareProjectTarget({ projectService, coordinator, payload: { project_id: 'project_live' } });
    assert.equal(opened.prepared, true);
    assert.deepEqual(calls, [live]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
