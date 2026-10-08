'use strict';

// The production wiring in services/projects/application-execution-composition.js:
// a chat move re-stamps its agent tasks, and a project delete re-homes the
// project's remaining agent tasks to General and deletes the project's note.
// Every other hook test injects fakes; this one drives a real BackendService.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { ShellConfigService } = require('../services/shell-config-service');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function stampOf(configService, id) {
  return configService.getState().followUps.find((entry) => entry.id === id)?.projectId;
}

test('moving a chat re-stamps its agent tasks and deleting a project re-homes tasks and deletes the note', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-hooks-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const backend = new BackendService({ userDataPath, safeStorage: createFakeSafeStorage(), configService });
  try {
    const application = backend.projectApplicationService;
    const created = application.createProject({ name: 'Hooks' });
    assert.equal(created.ok, true, JSON.stringify(created));
    const projectId = created.project.id;
    const session = backend.sessionStore.createSession({ title: 'Hooked chat' });
    configService.upsertFollowUp({ id: 'chat-task', label: 'From chat', sourceKind: 'agent_task', sessionId: session.id });
    configService.upsertFollowUp({ id: 'rail-task', label: 'From rail', sourceKind: 'agent_task', sessionId: '', projectId });

    const moved = application.assignSessionProject({ session_id: session.id, project_id: projectId });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(stampOf(configService, 'chat-task'), projectId);

    // The delete moves the project's memories through the sidecar; a bare host has none.
    backend.sidecarClient = { connected: true, dispose() {}, request: async () => ({ moved: 0, merged: 0, pending_moved: 0 }) };
    const deletedNotes = [];
    backend.projectNotesService = { deleteProjectNotes: (id) => { deletedNotes.push(id); return { ok: true }; } };
    const deleted = await application.deleteProject({ project_id: projectId });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(stampOf(configService, 'chat-task'), GENERAL_PROJECT_ID);
    assert.equal(stampOf(configService, 'rail-task'), GENERAL_PROJECT_ID);
    assert.deepEqual(deletedNotes, [projectId]);
  } finally {
    backend.dispose();
  }
});

test('a failing task re-stamp does not keep the note alive, and a refused note delete does not fail the project delete', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-hooks-fail-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const backend = new BackendService({ userDataPath, safeStorage: createFakeSafeStorage(), configService });
  try {
    const application = backend.projectApplicationService;
    const projectId = application.createProject({ name: 'Fragile' }).project.id;
    backend.sidecarClient = { connected: true, dispose() {}, request: async () => ({ moved: 0, merged: 0, pending_moved: 0 }) };
    configService.restampAgentTasksForProject = () => { throw new Error('restamp exploded'); };
    const deletedNotes = [];
    backend.projectNotesService = { deleteProjectNotes: (id) => { deletedNotes.push(id); return { ok: false, reason: 'write_failed' }; } };
    const deleted = await application.deleteProject({ project_id: projectId });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.deepEqual(deletedNotes, [projectId], 'the note delete still ran after the re-stamp threw');
    assert.equal(backend.projectService.get(projectId), null);
  } finally {
    backend.dispose();
  }
});
