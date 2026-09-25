'use strict';

// "Switch project" from the Workspace. The renderer names a project id; the
// main process resolves that project's folder from the store and hands the
// path to the coordinator's trusted prepareTarget. General means "no folder"
// and clears the root. The renderer never sends a path, so prepareTarget stays
// un-exposed over preload.

const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./project-schema');

function blocked(code) {
  return { prepared: false, canceled: false, changed: false, blocked: true, code };
}

async function prepareProjectTarget({ projectService, coordinator, payload } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).join(',') !== 'project_id') {
    return blocked('invalid_project_request');
  }
  const projectId = normalizeProjectId(payload.project_id);
  if (!projectId || projectId !== payload.project_id) return blocked('invalid_project_id');
  if (!coordinator) return blocked('transition_controller_unavailable');
  if (projectId === GENERAL_PROJECT_ID) return coordinator.prepareClear();
  const project = typeof projectService?.get === 'function' ? projectService.get(projectId) : null;
  if (!project) return blocked('project_not_found');
  if (typeof project.root_path !== 'string' || !project.root_path.trim()) return blocked('project_root_unavailable');
  return coordinator.prepareTarget(project.root_path);
}

module.exports = { prepareProjectTarget };
