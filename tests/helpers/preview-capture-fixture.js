'use strict';

// Deterministic native-capture boundary; all downstream owners are production.
const { BrowserSessionService } = require('../../services/browser-session-service');
const { ArtifactWorkspaceService } = require('../../services/artifact-workspace-service');
const { ToolExecutor } = require('../../services/tools/tool-executor');
const { ToolPathPolicy } = require('../../services/tools/tool-path-policy');
const { createPreviewTestTool } = require('../../services/tools/builtin/preview-test-tool');
const { executeElectronToolRequest } = require('../../services/backend/electron-tool-bridge');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=', 'base64');

async function capture(root, options = {}) {
  const configService = { getState: () => ({ toolsWorkspaceRoot: root }) };
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
    ? { createBinaryArtifact: async () => { throw new Error('Cache unavailable'); } }
    : new ArtifactWorkspaceService({ configService });
  const toolExecutor = new ToolExecutor({
    registry: { getTool: () => tool }, logger: () => {}, configService,
    pathPolicy: new ToolPathPolicy({ fs: require('node:fs/promises'), path: require('node:path') }),
    browserSessionService, artifactService,
  });
  const result = await executeElectronToolRequest({ configService, toolExecutor }, {
    params: { tool_name: 'preview_test', tool_call_id: 'capture_1', plan_mode: false,
      arguments: { path: 'index.html', screenshot: options.screenshot !== false,
        viewport: options.viewport || 'desktop', wait_ms: 0,
        events: [{ action: 'click', selector: '#inspect' }] } },
    sessionId: 'visual_review', streamId: 'stream_1',
  });
  return { result, calls };
}

module.exports = { capture, PNG };
if (require.main === module) {
  capture(process.argv[2]).then((result) => process.stdout.write(JSON.stringify(result)));
}
