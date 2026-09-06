'use strict';

/* WorkspacePresentationService (services/workspace-presentation-service.js):
 * one-shot main→renderer push. Covers the dispatch wire shape (snake_case,
 * workspace-relative path, request_id), the synchronous no-ack contract,
 * fail-closed behavior on invalid views/paths, renderer-unavailable handling,
 * and never throwing across the seam when the send itself throws. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WorkspacePresentationService,
  normalizeRelativePosixPath,
  VALID_VIEWS,
} = require('../services/workspace-presentation-service');

test('valid request dispatches one workspacePresentation.onRequest event with a redacted payload', () => {
  const sent = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (methodPath, payload) => sent.push({ methodPath, payload }),
    isRendererAvailable: () => true,
  });
  const result = service.requestPresentation({ view: 'preview', path: 'docs\\readme.md' });
  assert.equal(result.delivered, true);
  assert.ok(result.request_id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].methodPath, 'workspacePresentation.onRequest');
  assert.equal(sent[0].payload.view, 'preview');
  assert.equal(sent[0].payload.path, 'docs/readme.md', 'POSIX workspace-relative on the wire');
  assert.equal(sent[0].payload.request_id, result.request_id);
  assert.equal(sent[0].payload.source, 'tool');
});

test('invalid views and unsafe paths fail closed without dispatching', () => {
  const sent = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (methodPath, payload) => sent.push({ methodPath, payload }),
    isRendererAvailable: () => true,
  });
  assert.deepEqual(VALID_VIEWS, ['preview', 'file_map', 'change_diff']);
  assert.equal(service.requestPresentation({ view: 'editor' }).reason, 'unsupported_view');
  assert.equal(service.requestPresentation({ view: 'preview', path: '../up.md' }).reason, 'unsafe_path');
  assert.equal(service.requestPresentation({ view: 'preview', path: 'C:/x.md' }).reason, 'unsafe_path');
  assert.equal(sent.length, 0);
});

test('change_diff dispatches bounded session/workspace/change identity once', () => {
  const sent = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (methodPath, payload) => sent.push({ methodPath, payload }),
    isRendererAvailable: () => true,
  });
  const workspaceId = `root_${'a'.repeat(24)}`;
  const result = service.requestPresentation({
    view: 'change_diff',
    path: 'src/app.js',
    session_id: 'session-1',
    workspace_id: workspaceId,
    change_id: 'change:turn:tool:1',
  });

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, {
    view: 'change_diff',
    path: 'src/app.js',
    request_id: result.request_id,
    source: 'tool',
    session_id: 'session-1',
    workspace_id: workspaceId,
    change_id: 'change:turn:tool:1',
  });
});

test('change_diff rejects incomplete, unsafe, and malformed identities without dispatch', () => {
  const sent = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (...args) => sent.push(args),
    isRendererAvailable: () => true,
  });
  const workspaceId = `root_${'a'.repeat(24)}`;
  const base = { view: 'change_diff', path: 'src/app.js', session_id: 'session-1', workspace_id: workspaceId };
  assert.equal(service.requestPresentation({ ...base, path: '../escape.js' }).reason, 'unsafe_path');
  assert.equal(service.requestPresentation({ ...base, session_id: '' }).reason, 'invalid_change_diff');
  assert.equal(service.requestPresentation({ ...base, workspace_id: 'root_other' }).reason, 'invalid_change_diff');
  assert.equal(service.requestPresentation({ ...base, change_id: 'bad id' }).reason, 'invalid_change_diff');
  assert.equal(sent.length, 0);
});

test('renderer unavailable / throwing send return structured results, never throw', () => {
  const gone = new WorkspacePresentationService({
    sendBridgeEvent: () => {},
    isRendererAvailable: () => false,
  });
  assert.equal(gone.requestPresentation({ view: 'file_map' }).reason, 'renderer_unavailable');

  const throwing = new WorkspacePresentationService({
    sendBridgeEvent: () => { throw new Error('window destroyed'); },
    isRendererAvailable: () => true,
  });
  const result = throwing.requestPresentation({ view: 'file_map' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'dispatch_failed');
});

test('normalizeRelativePosixPath: relative POSIX only', () => {
  assert.equal(normalizeRelativePosixPath('a\\b.md'), 'a/b.md');
  assert.equal(normalizeRelativePosixPath('./a/./b.md'), 'a/b.md');
  for (const bad of ['/abs.md', 'C:/x.md', '../up.md', 'a\0b', 'map://workspace', 42, '']) {
    assert.equal(normalizeRelativePosixPath(bad), '');
  }
});

test('request ids are unique across dispatches', () => {
  const service = new WorkspacePresentationService({
    sendBridgeEvent: () => {},
    isRendererAvailable: () => true,
  });
  const a = service.requestPresentation({ view: 'file_map' });
  const b = service.requestPresentation({ view: 'file_map' });
  assert.notEqual(a.request_id, b.request_id);
});
