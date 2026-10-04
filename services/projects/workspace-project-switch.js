'use strict';

// "Switch project" from the Workspace. The renderer names a project id; the
// main process resolves that project's folder from the store and hands the
// path to the coordinator's trusted prepareTarget. General means "no folder"
// and clears the root. The renderer never sends a path, so prepareTarget stays
// un-exposed over preload. A project whose folder is gone from disk is refused
// with `workspace_folder_missing` (the renderer offers "Locate folder", which
// rebinds the same project through projects.chooseRoot).

const fs = require('node:fs');

const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./project-schema');

function blocked(code) {
  return { prepared: false, canceled: false, changed: false, blocked: true, code };
}

async function defaultFolderExists(rootPath) {
  try {
    return (await fs.promises.stat(rootPath)).isDirectory();
  } catch (_error) {
    return false;
  }
}

async function prepareProjectTarget({
  projectService, coordinator, payload, folderExists = defaultFolderExists,
} = {}) {
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
  const exists = await Promise.resolve()
    .then(() => folderExists(project.root_path))
    .then((value) => value === true, () => false);
  if (!exists) return blocked('workspace_folder_missing');
  return coordinator.prepareTarget(project.root_path);
}

module.exports = { prepareProjectTarget };
