'use strict';

// Deterministic native-capture boundary; all downstream owners are production.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BrowserSessionService } = require('../../services/browser-session-service');
const { ArtifactWorkspaceService } = require('../../services/artifact-workspace-service');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const {
  SessionExecutionAuthority,
} = require('../../services/backend/session-execution-authority');
const {
  initializeApplicationProjects,
} = require('../../services/projects/application-project-scope');
const { ToolExecutor } = require('../../services/tools/tool-executor');
const { ToolPathPolicy } = require('../../services/tools/tool-path-policy');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { createPreviewTestTool } = require('../../services/tools/builtin/preview-test-tool');
const { executeElectronToolRequest } = require('../../services/backend/electron-tool-bridge');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=', 'base64');

async function capture(root, options = {}) {
  const configService = { getState: () => ({ toolsWorkspaceRoot: root }) };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-preview-capture-'));
  const sessionStore = new ElectronSessionStore(path.join(profile, 'sessions.json'));
  const service = {
    _emitServiceLog() {},
    configService,
    featureFlags: {},
    sessionStore,
  };
  initializeApplicationProjects(service, { userDataPath: profile });
  const createdProject = service.projectService.create({ name: 'Preview capture' });
  if (!createdProject.ok) throw new Error(`Preview project creation failed: ${createdProject.reason}`);
  const boundProject = service.projectService.bindRoot(createdProject.project.id, root);
  if (!boundProject.ok) throw new Error(`Preview project binding failed: ${boundProject.reason}`);
  sessionStore.createSessionWithId('visual_review', {
    title: 'Visual review',
    projectId: boundProject.project.id,
  });
  const calls = [];
  const session = {
    sessionId: 'preview', consoleMessages: [], pageErrors: [],
    webContents: { capturePage: async () => {
      calls.push('capture');
      if (options.captureError) throw new Error('Capture failed');
      return { toPNG: () => PNG };
    } },
  };
  const browserSessionService = {
    reserveSlot: () => ({ ok: true }),
    open: async () => { calls.push('open'); return { status: 'open' }; },
    inspect: async () => ({ console_messages: [], page_errors: [] }),
    click: async () => { calls.push('click'); return { status: 'clicked' }; },
    close: async () => { calls.push('close'); },
    screenshot: BrowserSessionService.prototype.screenshot.bind({
      _runSessionOperation: async (_id, _opts, operation) => operation(session, null),
      _currentUrl: () => 'file:///fixture.html',
    }),
  };
  const tool = createPreviewTestTool({ setTimeoutImpl: (callback) => { callback(); return null; } });
  const artifactService = options.saveError
    ? {
        forSessionAuthority() { return this; },
        createBinaryArtifact: async () => { throw new Error('Cache unavailable'); },
      }
    : new ArtifactWorkspaceService({
        configService,
        projectAuthorityProvider: () => service.projectAuthority,
      });
  service.artifactService = artifactService;
  const permissionStore = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  const sessionExecutionAuthority = new SessionExecutionAuthority({
    projectAuthority: service.projectAuthority,
    permissionStore,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: service.resolveProjectWorkspaceServices,
  });
  const executionAuthority = sessionExecutionAuthority.captureSession('visual_review', {
    requestId: 'stream_1',
    mode: 'act',
    readOnly: true,
  });
  const toolExecutor = new ToolExecutor({
    registry: { getTool: () => tool }, permissionStore, logger: () => {}, configService,
    pathPolicy: new ToolPathPolicy({ fs: require('node:fs/promises'), path: require('node:path') }),
    browserSessionService, artifactService,
  });
  try {
    const result = await executeElectronToolRequest({ configService, toolExecutor }, {
      params: { tool_name: 'preview_test', tool_call_id: 'capture_1', plan_mode: false,
        arguments: { path: 'index.html', screenshot: options.screenshot !== false,
          viewport: options.viewport || 'desktop', wait_ms: 0,
          events: [{ action: 'click', selector: '#inspect' }] } },
      sessionId: 'visual_review', streamId: 'stream_1', executionAuthority,
    });
    return { result, calls };
  } finally {
    sessionExecutionAuthority.close(executionAuthority);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

module.exports = { capture, PNG };
if (require.main === module) {
  capture(process.argv[2]).then((result) => process.stdout.write(JSON.stringify(result)));
}
