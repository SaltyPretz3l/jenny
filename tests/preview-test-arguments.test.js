'use strict';

/* `preview_test` rejects arguments it does not recognise.
 *
 * A model that sent `interactions` instead of `events` used to get a
 * successful zero-interaction result and then claimed it had clicked
 * (overnight Linux QA of 1.3.0). Nothing may open a browser for such a call. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-preview-args-'));
  trackDirectory(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
  return fs.realpathSync(root);
}

function execute(root, input) {
  const opened = [];
  const context = {
    browserSessionService: {
      async open(options) {
        opened.push(options);
        return { session_id: options.sessionId, console_messages: [], page_errors: [] };
      },
      // The tool treats a service without its full surface as unavailable.
      async click() { return { status: 'clicked' }; },
      async type() { return { status: 'typed' }; },
      async hover() { return { status: 'hovered' }; },
      async focus() { return { status: 'focused' }; },
      async press() { return { status: 'pressed' }; },
      async inspect() { return { console_messages: [], page_errors: [] }; },
      async screenshot() { return { buffer: Buffer.from('png'), width: 2, height: 2, thumbnail: null }; },
      async close() {
        return { closed: true };
      },
    },
    workingDirectory: root,
    pathPolicy: {
      resolvePath: (relPath) => path.resolve(root, relPath),
      assertInsideRoot: async (resolved) => fs.realpathSync(resolved),
    },
    logger: () => {},
  };
  return createPreviewTestTool().execute(input, context).then((result) => ({ result, opened }));
}

test('unknown top-level arguments fail before opening a browser', async () => {
  const root = makeWorkspace();
  for (const extra of [
    { interactions: [{ type: 'click', target: '#start' }] },
    { viewprot: 'mobile' },
  ]) {
    const { result, opened } = await execute(root, { path: 'index.html', ...extra });
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'unknown_argument');
    assert.equal(opened.length, 0);
    assert.match(result.content, /events/);
  }
});

test('unknown event arguments cannot silently change the requested interaction', async () => {
  const root = makeWorkspace();
  const { result, opened } = await execute(root, {
    path: 'index.html',
    events: [{ action: 'type', selector: '#name', value: 'lost text' }],
  });
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'unknown_event_argument');
  assert.equal(opened.length, 0);
  assert.match(result.content, /text/);
});

test('unknown event arguments list every allowed key including key', async () => {
  const root = makeWorkspace();
  const { result } = await execute(root, {
    path: 'index.html',
    events: [{ action: 'press', keycode: 'Enter' }],
  });
  assert.equal(result.metadata.reason, 'unknown_event_argument');
  assert.match(result.content, /action, selector, key, text, press_enter/);
  assert.match(result.content, /hover/);
});

test('a press key of " " normalizes to Space before the allowlist check', () => {
  const { normalizePreviewEvent } = require('../services/tools/builtin/preview-test-arguments');
  assert.equal(normalizePreviewEvent({ action: 'press', key: ' ' }).event.key, 'Space');
  assert.equal(normalizePreviewEvent({ action: 'press', key: 'Spacebar' }).event.key, 'Space');
  assert.equal(normalizePreviewEvent({ action: 'press', key: '' }).failure.reason, 'invalid_event');
  assert.equal(normalizePreviewEvent({ action: 'press', key: 'enter' }).failure.reason, 'invalid_event');
});

test('press accepts the key argument and omits selector', async () => {
  const root = makeWorkspace();
  const { result, opened } = await execute(root, {
    path: 'index.html',
    events: [{ action: 'press', key: 'Tab' }],
  });
  assert.equal(result.isError, false);
  assert.equal(opened.length, 1);
});
