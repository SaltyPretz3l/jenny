'use strict';

const path = require('node:path');
const { AutomationService } = require('../automation-service');
const { VersionedWorkspaceFileService } = require('../versioned-workspace-file-service');

// Reuse the existing bounded automation projections and task schema. This
// facade has no scheduler, watcher, timer, or authority to start an automation.
function createProjectAutomationService(service, { authority, owner, rootContext, configService }) {
  owner.requireCurrent(authority);
  if (!authority.root_path) return null;
  const reader = new VersionedWorkspaceFileService({ rootContext });
  const expectedFile = path.join(authority.root_path, '.jenny', 'scheduled_tasks.json');
  const scoped = new AutomationService({
    userDataPath: service.userDataPath,
    configService,
    logger: service.logger,
    nowProvider: service.nowProvider,
    fsImpl: { promises: { async readFile(filePath) {
      owner.requireCurrent(authority);
      if (filePath !== expectedFile) throw new Error('Automation source is outside the captured project.');
      const result = await reader.readText({ path: '.jenny/scheduled_tasks.json' });
      owner.requireCurrent(authority);
      return result.content;
    } } },
  });
  const call = async (method, args) => {
    owner.requireCurrent(authority);
    const result = await scoped[method](...args);
    owner.requireCurrent(authority);
    return result;
  };
  return Object.freeze({
    listAutomations: () => call('listAutomations', []),
    readAutomation: id => call('readAutomation', [id]),
  });
}

module.exports = { createProjectAutomationService };
