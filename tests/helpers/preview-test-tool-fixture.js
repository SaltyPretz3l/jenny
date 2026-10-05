'use strict';

/* Shared `preview_test` fixtures: a temp workspace with index.html, a stub
 * BrowserSessionService that records calls (open/click/type/eval/inspect/
 * screenshot/close), the tool context, and a call filter. Used by
 * tests/preview-test-tool.test.js and tests/preview-test-evidence.test.js. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPreviewTestTool } = require('../../services/tools/builtin/preview-test-tool');
const { trackDirectory } = require('./resource-cleanup');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-preview-test-'));
  trackDirectory(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
  fs.writeFileSync(path.join(root, 'notes.md'), '# nope', 'utf8');
  return fs.realpathSync(root);
}

function stubService(overrides = {}) {
  const calls = [];
  const service = {
    calls,
    async open(options) {
      calls.push(['open', options]);
      if (overrides.openError) {
        throw overrides.openError;
      }
      return overrides.openResult || {
        session_id: options.sessionId,
        console_messages: [],
        page_errors: [],
      };
    },
    async click(sessionId, options) {
      calls.push(['click', sessionId, options]);
      return overrides.clickResult || { status: 'clicked' };
    },
    async type(sessionId, options) {
      calls.push(['type', sessionId, options]);
      return overrides.typeResult || { status: 'typed' };
    },
    async inspect(sessionId) {
      calls.push(['inspect', sessionId]);
      if (overrides.inspectError) {
        throw overrides.inspectError;
      }
      return overrides.inspectResult || { console_messages: [], page_errors: [] };
    },
    async screenshot(sessionId) {
      calls.push(['screenshot', sessionId]);
      if (overrides.screenshotError) {
        throw overrides.screenshotError;
      }
      return overrides.screenshotResult || {
        buffer: Buffer.from('png'),
        width: 2,
        height: 2,
        thumbnail: null,
      };
    },
    async eval(sessionId, options) {
      calls.push(['eval', sessionId, options]);
      if (overrides.evalHandler) {
        return overrides.evalHandler(options, callsOf({ calls }, 'eval').length);
      }
      return { status: 'evaluated', result: { scripts: [], stylesheets: [], media: [] } };
    },
    async close(sessionId) {
      calls.push(['close', sessionId]);
      return { closed: true };
    },
  };
  return service;
}

function makeContext(root, service, overrides = {}) {
  return {
    browserSessionService: service,
    workingDirectory: root,
    pathPolicy: {
      resolvePath(relPath) {
        return path.resolve(root, relPath);
      },
      async assertInsideRoot(resolved) {
        const real = fs.realpathSync(resolved);
        const relative = path.relative(root, real);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('outside root');
        }
        return real;
      },
    },
    logger: () => {},
    ...overrides,
  };
}

function makeTool(overrides = {}) {
  return createPreviewTestTool(overrides);
}

function callsOf(service, kind) {
  return service.calls.filter(([name]) => name === kind);
}

module.exports = { callsOf, makeContext, makeTool, makeWorkspace, stubService };
