'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PersonalityWorkspaceService } = require('../services/personality-workspace-service');
const {
  CLIP_MARKER,
  SECTION_BUDGETS,
  compilePersonalitySections,
} = require('../services/personality-workspace-compile');

const PROJECT = 'project_alpha';

async function createWorkspace(t) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-personality-notes-'));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const workspacePath = path.join(userDataPath, 'personality', 'default-workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  return { userDataPath, workspacePath };
}

function notesService(byProject, calls = []) {
  return {
    get(projectId) {
      calls.push(projectId);
      const entry = byProject[projectId];
      if (entry instanceof Error) throw entry;
      if (entry && entry.ok === false) return entry;
      return { ok: true, note: { text: entry ?? '', revision: 1, updatedAt: null, updatedBy: 'user', journal: [] } };
    },
  };
}

async function seededService(t, notes) {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const service = new PersonalityWorkspaceService({
    userDataPath,
    projectNotesProvider: notes === undefined ? undefined : () => notes,
  });
  await service.ensureSeeded();
  await fs.writeFile(path.join(workspacePath, 'PERSONALITY.md'), 'Be direct.');
  await fs.writeFile(path.join(workspacePath, 'USER.md'), 'Brendan, CST.');
  await fs.writeFile(path.join(workspacePath, 'MEMORY.md'), 'General-only note.');
  return service;
}

test('a project chat fills the Notes slot with its notes page', async (t) => {
  const page = 'Ship the v9 store first.\nThen the tool.';
  const service = await seededService(t, notesService({ [PROJECT]: page }));

  const wire = await service.getCompiledContext({ projectId: PROJECT });

  assert.equal(wire, compilePersonalitySections({
    personality: 'Be direct.', user: 'Brendan, CST.', memory: page,
  }).content);
  assert.match(wire, /### Notes\n\nShip the v9 store first\.\nThen the tool\.$/);
  assert.doesNotMatch(wire, /General-only note/);
});

test('a long notes page is clipped by the Notes budget exactly like a file body', async (t) => {
  const page = 'n'.repeat(SECTION_BUDGETS.memory + 500);
  const service = await seededService(t, notesService({ [PROJECT]: page }));

  const wire = await service.getCompiledContext({ projectId: PROJECT });

  assert.equal(wire, compilePersonalitySections({
    personality: 'Be direct.', user: 'Brendan, CST.', memory: page,
  }).content);
  const notes = wire.split('### Notes\n\n')[1];
  assert.equal(notes.length, SECTION_BUDGETS.memory);
  assert.ok(notes.endsWith(CLIP_MARKER));
});

test('a project without a notes page, a failed read or no notes service leaves Notes empty', async (t) => {
  const failures = [
    notesService({}),
    notesService({ [PROJECT]: { ok: false, reason: 'note_unavailable' } }),
    notesService({ [PROJECT]: new Error('disk gone') }),
    undefined,
  ];
  for (const notes of failures) {
    const service = await seededService(t, notes);
    const wire = await service.getCompiledContext({ projectId: PROJECT });
    assert.equal(wire, compilePersonalitySections({ personality: 'Be direct.', user: 'Brendan, CST.' }).content);
    assert.doesNotMatch(wire, /### Notes/);
  }
});

test('General keeps MEMORY.md and never reads a project notes page', async (t) => {
  const calls = [];
  const service = await seededService(t, notesService({ project_general: 'PAGE' }, calls));

  const wire = await service.getCompiledContext({ projectId: 'project_general' });

  assert.match(wire, /### Notes\n\nGeneral-only note\.$/);
  assert.deepEqual(calls, []);
});

test('the Settings preview for a project shows the same Notes body the request carries', async (t) => {
  const service = await seededService(t, notesService({ [PROJECT]: 'Project page.' }));

  const state = await service.getState({ agentName: 'Jenny', projectId: PROJECT });

  assert.deepEqual(state.compiled.sections.map((section) => section.id), ['personality', 'user', 'memory']);
  assert.ok(state.compiled.text.endsWith(await service.getCompiledContext({ projectId: PROJECT })));
});
