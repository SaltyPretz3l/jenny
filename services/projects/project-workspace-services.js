'use strict';

const { WorkspaceGitService } = require('../workspace-git-service');
const { createProjectAutomationService } = require('./project-automation-service');

function createScopedRootContext(owner, authority) {
  const context = Object.freeze({ rootPath: authority.root_path || '', rootId: authority.root_id,
    generation: authority.root_revision, phase: 'ready' });
  return Object.freeze({
    captureContext() { owner.requireCurrent(authority); return context; },
    isCurrent(candidate) {
      try { owner.requireCurrent(authority); return candidate === context; } catch { return false; }
    },
    acquireOperation() {
      owner.requireCurrent(authority);
      let released = false;
      return Object.freeze({
        acquired: true, context, signal: null,
        isCurrent() {
          if (released) return false;
          try { owner.requireCurrent(authority); return true; } catch { return false; }
        },
        release() { if (released) return false; released = true; return true; },
      });
    },
  });
}

function createScopedConfig(configService, owner, authority) {
  const followUps = {};
  for (const method of ['upsertFollowUp', 'updateFollowUp', 'activateFollowUp', 'resolveFollowUp']) {
    if (typeof configService?.[method] !== 'function') continue;
    followUps[method] = (...args) => { owner.requireCurrent(authority); return configService[method](...args); };
  }
  return Object.freeze({
    ...followUps,
    getToolsWorkspaceRoot() { owner.requireCurrent(authority); return authority.root_path || ''; },
    getState() {
      owner.requireCurrent(authority);
      return { ...configService?.getState?.(), toolsWorkspaceRoot: authority.root_path };
    },
  });
}

// These objects own no watcher, subprocess or durable data. Weak captures live
// only as long as admitted callers; shared execution owners keep their locks.
function createProjectWorkspaceServiceResolver(service, { gitFactory = options => new WorkspaceGitService(options) } = {}) {
  const captures = new WeakMap();
  return (authority, { sessionId = '' } = {}) => {
    const owner = service.projectAuthority;
    owner.requireCurrent(authority);
    const cached = captures.get(authority);
    if (cached?.sessionId === sessionId) return cached.bundle;
    const captured = Object.freeze({ ...authority });
    const configService = createScopedConfig(service.configService, owner, captured);
    const rootContext = createScopedRootContext(owner, captured);
    const workspaceGitService = gitFactory({
      configService,
      rootContextProvider: () => rootContext,
      featureFlagProvider: () => ({ ...service.featureFlags,
        workspace_git: service.hostMode !== 'server' && service.commandSandbox?.enabled !== true
          && service.configService?.getState?.()?.commandSandbox?.enabled !== true
          && service.featureFlags?.workspace_git === true }),
      logger: (level, event, details) => service._emitServiceLog?.(level, event, details),
    });
    const artifactService = sessionId && service.artifactService?.forSessionAuthority
      ? service.artifactService.forSessionAuthority(captured, sessionId) : null;
    const workspaceTestRunnerService = service.hostMode !== 'server'
      && service.workspaceTestRunnerService?.forProjectAuthority
      ? service.workspaceTestRunnerService.forProjectAuthority(captured, owner, {
        isAllowed: () => service.hostMode !== 'server' && service.commandSandbox?.enabled !== true
          && service.configService?.getState?.()?.commandSandbox?.enabled !== true,
      }) : null;
    const automationService = service.hostMode !== 'server' && service.automationService && captured.root_path
      ? createProjectAutomationService(service.automationService, { authority: captured, owner, rootContext, configService })
      : null;
    const bundle = Object.freeze({ configService, workspaceGitService, artifactService, workspaceTestRunnerService, automationService,
      homeAssistantService: service.homeAssistantService || null });
    captures.set(authority, { sessionId, bundle });
    return bundle;
  };
}

module.exports = { createProjectWorkspaceServiceResolver, createScopedRootContext };
