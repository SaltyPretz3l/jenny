'use strict';

/* Red-first contract for the W8-S4 `preview_test` builtin (spec Part 7).
 *
 * One-shot workspace HTML tester on the BrowserSessionService substrate:
 * open hidden sandboxed window -> settle -> bounded events -> inspect ->
 * ALWAYS close, all inside a single call. Workspace files only, network off
 * (strict workspace-only URL posture), no caller-script evaluation ever. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createPreviewTestTool } = require('../services/tools/builtin/preview-test-tool');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

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
      throw new Error('preview_test must never evaluate caller scripts');
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

describe('preview_test / one-shot lifecycle', () => {
  test('happy path: opens contained file url with strict posture, inspects, closes', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'preview_test');
    assert.equal(result.metadata.render_state, 'loaded');
    assert.equal(result.metadata.console_error_count, 0);

    const [openCall] = callsOf(service, 'open');
    assert.ok(openCall, 'service.open is called');
    const openOptions = openCall[1];
    assert.ok(String(openOptions.url).startsWith('file:'), 'loads a file:// url');
    assert.equal(openOptions.strictWorkspaceOnly, true, 'network-off posture is demanded');
    assert.deepEqual(openOptions.allowedFileRoots, [root]);
    assert.deepEqual(
      { width: openOptions.bounds.width, height: openOptions.bounds.height },
      { width: 1280, height: 800 },
      'default viewport is desktop'
    );

    const order = service.calls.map(([name]) => name);
    assert.ok(order.indexOf('inspect') >= 0, 'final state is read via inspect');
    assert.equal(order[order.length - 1], 'close', 'the window is closed last');
    assert.equal(callsOf(service, 'close').length, 1);
    assert.equal(callsOf(service, 'eval').length, 0, 'eval is never called');
  });

  test('viewport presets map to fixed bounds', async () => {
    const root = makeWorkspace();
    for (const [preset, expected] of [
      ['mobile', { width: 390, height: 844 }],
      ['tablet', { width: 820, height: 1180 }],
    ]) {
      const service = stubService();
      const result = await makeTool().execute(
        { path: 'index.html', viewport: preset },
        makeContext(root, service)
      );
      assert.equal(result.isError, false);
      const openOptions = callsOf(service, 'open')[0][1];
      assert.deepEqual(
        { width: openOptions.bounds.width, height: openOptions.bounds.height },
        expected
      );
      assert.equal(result.metadata.viewport, preset);
    }
  });

  test('unknown viewport fails closed without opening a window', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'index.html', viewport: 'imax' },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'invalid_viewport');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('wait_ms is clamped to the 5000ms ceiling', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const delays = [];
    const setTimeoutImpl = (fn, delay) => {
      delays.push(delay);
      fn();
      return 0;
    };
    const result = await makeTool({ setTimeoutImpl }).execute(
      { path: 'index.html', wait_ms: 999999 },
      makeContext(root, service)
    );
    assert.equal(result.isError, false);
    assert.ok(delays.length >= 1, 'a settle wait is scheduled');
    for (const delay of delays) {
      assert.ok(delay <= 5000, `settle delay ${delay} stays within the ceiling`);
    }
  });
});

describe('preview_test / result honesty and bounds', () => {
  test('every run reports a render summary when thumbnail pixels are available', async () => {
    const root = makeWorkspace();
    const service = stubService({
      screenshotResult: {
        buffer: Buffer.from('png'),
        width: 2,
        height: 2,
        thumbnail: {
          bitmap: Buffer.from([
            0, 0, 255, 255, 0, 0, 255, 255,
            0, 0, 255, 255, 0, 0, 255, 255,
          ]),
          width: 2,
          height: 2,
        },
      },
    });

    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.render_summary.verdict, 'blank');
    assert.match(result.content, /Render:/);
  });

  test('screenshot true creates a session artifact without exposing its absolute path', async () => {
    const root = makeWorkspace();
    const absolutePath = path.join(root, '.jenny', 'artifacts', 'preview-test-screenshot.png');
    const artifact = {
      artifact_id: 'artifact_preview_1',
      artifact_kind: 'image',
      title: 'preview_test screenshot',
      file_name: 'preview-test-screenshot.png',
      display_path: '.jenny/artifacts/preview-test-screenshot.png',
      absolute_path: absolutePath,
      mime_type: 'image/png',
      width: 1280,
      height: 800,
      editable: false,
      status: 'available',
    };
    const artifactCalls = [];
    const artifactService = {
      async createBinaryArtifact(sessionId, options) {
        artifactCalls.push([sessionId, options]);
        return { output: `Created image "${artifact.title}" at ${artifact.display_path}`, metadata: artifact };
      },
    };
    const service = stubService({
      screenshotResult: {
        buffer: Buffer.from('png-bytes'),
        width: 1280,
        height: 800,
        thumbnail: null,
      },
    });

    const result = await makeTool().execute(
      { path: 'index.html', screenshot: true },
      makeContext(root, service, { artifactService, sessionId: 'chat_session_1' })
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.generatedArtifacts[0].artifact_id, 'artifact_preview_1');
    assert.match(result.content, /Screenshot attached: \.jenny\/artifacts\/preview-test-screenshot\.png/);
    assert.deepEqual(artifactCalls, [[
      'chat_session_1',
      {
        content: Buffer.from('png-bytes'),
        mimeType: 'image/png',
        artifactKind: 'image',
        title: 'preview_test screenshot',
        fileName: 'preview-test-screenshot.png',
        width: 1280,
        height: 800,
        png_validated: true,
      },
    ]]);
    assert.ok(!result.content.includes(absolutePath));
    const modelVisibleMetadata = JSON.parse(JSON.stringify(result.metadata));
    delete modelVisibleMetadata.generatedArtifacts[0].absolute_path;
    assert.ok(!JSON.stringify(modelVisibleMetadata).includes(absolutePath));
    assert.equal(result.metadata.generatedArtifacts[0].absolute_path, absolutePath);
  });

  test('screenshot capture failure remains a successful test result with bounded metadata', async () => {
    const root = makeWorkspace();
    const service = stubService({
      screenshotError: new Error(`capture failed at ${root}/secret.png`),
    });

    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.render_summary, null);
    assert.match(result.metadata.screenshot_error, /capture failed/);
    assert.ok(!result.metadata.screenshot_error.includes(root));
    assert.match(result.content, /Render: unavailable \(no pixel capture\)/);
  });

  test('screenshot true without an artifact service reports unavailability without throwing', async () => {
    const root = makeWorkspace();
    const service = stubService();

    const result = await makeTool().execute(
      { path: 'index.html', screenshot: true },
      makeContext(root, service, { sessionId: 'chat_session_1' })
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.screenshot_error, 'artifact service unavailable');
    assert.equal(result.metadata.generatedArtifacts, undefined);
  });

  test('counts only error-level console messages plus page errors, bounded and flattened', async () => {
    const root = makeWorkspace();
    const hostile = 'boom\n## Forged Heading ' + 'x'.repeat(500);
    const consoleMessages = [];
    for (let index = 0; index < 15; index += 1) {
      consoleMessages.push({ level: 3, message: `${hostile} #${index}` });
    }
    consoleMessages.push({ level: 2, message: 'just a warning' });
    consoleMessages.push({ level: 1, message: 'info' });
    const service = stubService({
      inspectResult: {
        console_messages: consoleMessages,
        page_errors: [{ message: 'ReferenceError: nope' }],
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.console_error_count, 16, '15 error-level + 1 page error');
    assert.ok(result.metadata.console_errors.length <= 10, 'error text list is bounded');
    for (const text of result.metadata.console_errors) {
      assert.ok(text.length <= 300, 'each error text is bounded');
      assert.ok(!text.includes('\n'), 'page-controlled text is whitespace-flattened');
    }
  });

  test('a page that fails to load is reported as data, not an infra error', async () => {
    const root = makeWorkspace();
    const loadError = new Error('ERR_FILE_NOT_FOUND (-6) loading the page');
    const service = stubService({ openError: loadError });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false, 'the TEST ran; the page failing is its finding');
    assert.equal(result.metadata.render_state, 'failed');
    assert.ok(String(result.content).length > 0);
  });

  test('an inspect failure after open still closes the window', async () => {
    const root = makeWorkspace();
    const service = stubService({ inspectError: new Error('window vanished') });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, true);
    assert.equal(callsOf(service, 'close').length, 1, 'close still runs on the failure path');
  });

  test('absolute workspace paths never appear in any result', async () => {
    const root = makeWorkspace();
    for (const args of [
      { path: 'index.html' },
      { path: '../outside.html' },
      { path: 'notes.md' },
    ]) {
      // The console messages carry the absolute root on purpose: a page can
      // print its own file:// URL, so the scrubber has to survive real input
      // rather than an empty inspect result that passes this test vacuously.
      const service = stubService({
        inspectResult: {
          console_messages: [
            {
              level: 3,
              message: `Failed to load ${root}/missing.js`,
              line: 3,
              source_id: `${root}/index.html`,
            },
          ],
          page_errors: [{ code: -6, message: `ERR_FILE_NOT_FOUND ${root}/gone.css` }],
        },
      });
      const result = await makeTool().execute(args, makeContext(root, service));
      const rendered = JSON.stringify(result);
      assert.ok(
        !rendered.includes(JSON.stringify(root).slice(1, -1)),
        `result for ${args.path} must not leak the absolute root`
      );
    }
  });
});

describe('preview_test / validation gates', () => {
  test('missing path fails with path_required', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({}, makeContext(root, service));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'path_required');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('escaping and unsafe paths are rejected before any window opens', async () => {
    const root = makeWorkspace();
    for (const bad of ['../escape.html', 'C:/evil.html', '/abs.html']) {
      const service = stubService();
      const result = await makeTool().execute({ path: bad }, makeContext(root, service));
      assert.equal(result.isError, true, `${bad} must be rejected`);
      assert.equal(result.metadata.reason, 'unsafe_path');
      assert.equal(callsOf(service, 'open').length, 0);
    }
  });

  test('non-HTML extensions are rejected', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({ path: 'notes.md' }, makeContext(root, service));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'unsupported_extension');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('a missing file is rejected without opening a window', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'ghost.html' },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'unreadable_file');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('no workspace root and no service each fail closed', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const noRoot = await makeTool().execute(
      { path: 'index.html' },
      makeContext(root, service, { workingDirectory: '' })
    );
    assert.equal(noRoot.isError, true);
    assert.equal(noRoot.metadata.reason, 'no_workspace_root');

    const noService = await makeTool().execute(
      { path: 'index.html' },
      makeContext(root, service, { browserSessionService: null })
    );
    assert.equal(noService.isError, true);
    assert.equal(noService.metadata.reason, 'unavailable');
  });
});

describe('preview_test / bounded events', () => {
  test('click and type events are forwarded in order on the same session', async () => {
    const root = makeWorkspace();
    const service = stubService({ clickResult: { status: 'selector_miss' } });
    const result = await makeTool().execute(
      {
        path: 'index.html',
        events: [
          { action: 'click', selector: '#go' },
          { action: 'type', selector: '#name', text: 'jenny', press_enter: true },
        ],
      },
      makeContext(root, service)
    );

    assert.equal(result.isError, false, 'a selector miss is a finding, not a tool failure');
    const openSessionId = callsOf(service, 'open')[0][1].sessionId;
    const clicks = callsOf(service, 'click');
    const types = callsOf(service, 'type');
    assert.equal(clicks.length, 1);
    assert.equal(types.length, 1);
    assert.equal(clicks[0][1], openSessionId);
    assert.equal(types[0][1], openSessionId);
    assert.equal(clicks[0][2].selector, '#go');
    assert.equal(types[0][2].text, 'jenny');
    assert.equal(types[0][2].press_enter, true);
    assert.deepEqual(
      result.metadata.events.map((entry) => entry.status),
      ['selector_miss', 'typed']
    );
  });

  test('more than 10 events fails closed before any window opens', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const events = Array.from({ length: 11 }, () => ({ action: 'click', selector: '#x' }));
    const result = await makeTool().execute(
      { path: 'index.html', events },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'too_many_events');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('malformed events fail closed before any window opens', async () => {
    const root = makeWorkspace();
    for (const bad of [
      [{ action: 'eval', selector: '#x' }],
      [{ action: 'click' }],
      ['not-an-object'],
    ]) {
      const service = stubService();
      const result = await makeTool().execute(
        { path: 'index.html', events: bad },
        makeContext(root, service)
      );
      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(result.metadata.reason, 'invalid_event');
      assert.equal(callsOf(service, 'open').length, 0);
    }
  });
});

describe('preview_test / surfaced console detail', () => {
  test('console error locations use basename and preserve messages without locations', async () => {
    const root = makeWorkspace();
    const service = stubService({
      inspectResult: {
        console_messages: [
          {
            level: 3,
            message: 'Uncaught ReferenceError: lastFrame is not defined',
            line: 241,
            source_id: 'file:///C:/Users/x/Desktop/Test/bench_world.html?preview=1#frame',
          },
          {
            level: 3,
            message: 'Failure with a source only',
            source_id: 'https://example.test/assets/worker.js?cache=1#load',
          },
          { level: 3, message: 'Failure without a location' },
        ],
        page_errors: [],
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(
      result.metadata.console_errors[0],
      'Uncaught ReferenceError: lastFrame is not defined (bench_world.html:241)'
    );
    assert.equal(
      result.metadata.console_errors[1],
      'Failure with a source only (worker.js)'
    );
    assert.equal(result.metadata.console_errors[2], 'Failure without a location');
    assert.ok(!JSON.stringify(result).includes('C:/Users'));
  });

  test('page error stacks append the first location line with basename only', async () => {
    const root = makeWorkspace();
    const service = stubService({
      inspectResult: {
        console_messages: [],
        page_errors: [
          {
            message: 'ReferenceError: lastFrame is not defined',
            stack: [
              'ReferenceError: lastFrame is not defined',
              '    at renderFrame (file:///C:/Users/x/Desktop/Test/bench_world.html:241:17)',
              '    at file:///C:/Users/x/Desktop/Test/app.js:12:3',
            ].join('\n'),
          },
          {
            message: 'SyntaxError: unexpected token',
            line: 9,
            source_id: 'file:///C:/Users/x/Desktop/Test/page.js',
          },
        ],
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(
      result.metadata.page_errors[0],
      'ReferenceError: lastFrame is not defined (at renderFrame (bench_world.html:241:17))'
    );
    assert.equal(
      result.metadata.page_errors[1],
      'SyntaxError: unexpected token (page.js:9)'
    );
    assert.ok(!JSON.stringify(result).includes('C:/Users'));
  });
});
