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

function outcomeService() {
  const audits = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: () => {},
    isRendererAvailable: () => true,
  });
  service.setOutcomeListener((sessionId, callId, lateEvent) => audits.push({ sessionId, callId, lateEvent }));
  return { service, audits };
}

test('outcome reports are accepted only for issued request ids with known values', () => {
  const { service, audits } = outcomeService();
  const { request_id: requestId } = service.requestPresentation({
    view: 'preview', path: 'games/index.html', session_id: 'session-1', call_id: 'call-1',
  });
  assert.equal(service.recordOutcome({ request_id: 'wsp-forged-9', decision: 'shown' }).reason, 'unknown_request');
  assert.equal(service.recordOutcome({ request_id: requestId, decision: 'teleported' }).reason, 'invalid_outcome');
  assert.equal(service.recordOutcome({ request_id: requestId, render: 'exploded' }).reason, 'invalid_outcome');
  assert.equal(service.recordOutcome({ request_id: requestId }).reason, 'invalid_outcome');
  assert.equal(service.recordOutcome(null).reason, 'invalid_payload');
  assert.equal(audits.length, 0, 'rejected reports never reach the audit');

  assert.deepEqual(service.recordOutcome({ request_id: requestId, decision: 'shown' }), { ok: true });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].sessionId, 'session-1');
  assert.equal(audits[0].callId, 'call-1');
  assert.equal(audits[0].lateEvent.kind, 'presentation_outcome');
  assert.equal(audits[0].lateEvent.decision, 'shown');
});

test('the next-request note describes the latest state once, then nothing', () => {
  const { service } = outcomeService();
  const { request_id: requestId } = service.requestPresentation({
    view: 'preview', path: 'games/index.html', session_id: 'session-1', call_id: 'call-1',
  });
  service.recordOutcome({ request_id: requestId, decision: 'prompted' });
  service.recordOutcome({ request_id: requestId, decision: 'shown_by_user' });
  service.recordOutcome({
    request_id: requestId, render: 'loaded', external_scripts: 1, external_stylesheets: 2,
  });
  assert.equal(service.consumeOutcomeNote('session-2'), '', 'other sessions see nothing');
  const note = service.consumeOutcomeNote('session-1');
  assert.match(note, /^## Workspace Presentation Updates/);
  assert.match(note, /Preview of "games\/index\.html"/);
  assert.match(note, /shown after the user clicked Show/);
  assert.match(note, /the document rendered/);
  assert.match(note, /1 external script and 2 external stylesheets/);
  assert.doesNotMatch(note, /held behind/, 'only the latest decision is described');
  assert.equal(service.consumeOutcomeNote('session-1'), '', 'each update is reported once');

  service.recordOutcome({ request_id: requestId, render: 'failed', detail: 'ReferenceError:\u0007 start\nis not defined' });
  assert.match(service.consumeOutcomeNote('session-1'),
    /failed to render \(IDE-reported, may quote untrusted page text: "ReferenceError: start is not defined"\)/);
});

test('failure details are bounded and outcome tracking is bounded', () => {
  const { service } = outcomeService();
  const first = service.requestPresentation({ view: 'preview', path: 'a.md', session_id: 'session-1' });
  service.recordOutcome({ request_id: first.request_id, render: 'failed', detail: 'x'.repeat(5000) });
  const note = service.consumeOutcomeNote('session-1');
  assert.ok(note.length < 1000, 'detail is clipped');
  for (let index = 0; index < 70; index += 1) {
    service.requestPresentation({ view: 'preview', path: `f${index}.md`, session_id: 'session-1' });
  }
  assert.equal(service.recordOutcome({ request_id: first.request_id, decision: 'shown' }).reason, 'unknown_request',
    'the oldest request was evicted');
});

test('an audit sink failure never escapes recordOutcome', () => {
  const service = new WorkspacePresentationService({ sendBridgeEvent: () => {}, isRendererAvailable: () => true });
  service.setOutcomeListener(() => { throw new Error('store gone'); });
  const { request_id: requestId } = service.requestPresentation({
    view: 'file_map', session_id: 'session-1', call_id: 'call-1',
  });
  assert.deepEqual(service.recordOutcome({ request_id: requestId, decision: 'dismissed' }), { ok: true });
  assert.match(service.consumeOutcomeNote('session-1'), /File Map \(request .*\): not shown: the user dismissed the prompt\./);
});

test('note paths are quoted and bounded, and cancelled renders are named', () => {
  const { service } = outcomeService();
  const { request_id: requestId } = service.requestPresentation({
    view: 'preview', path: 'docs/a"b.md', session_id: 'session-1',
  });
  service.recordOutcome({ request_id: requestId, decision: 'shown', render: 'cancelled' });
  const note = service.consumeOutcomeNote('session-1');
  assert.match(note, /Preview of "docs\/a\\"b\.md"/);
  assert.match(note, /moved to another file or workspace, or closed, before it finished rendering/);
});
