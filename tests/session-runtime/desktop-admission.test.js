'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManagedService, waitForChatStreamEvent } = require('../helpers/managed-sidecar-runtime-helpers');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { createChatStreamBridge } = require('../../services/chat-stream-bridge');
const { createControllerHarness } = require('../helpers/send-controller-harness');
const { createStreamHandlerLifecycle } = require('../../renderer/chat/renderer-stream-handler-lifecycle');
const { waitFor } = require('../helpers/session-runtime-chat-adapter-harness');

test('real application and stdio producer emit one canonical admission before content through both bridge formats', async t => {
  t.after(cleanupTrackedResources);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-desktop-admission-'));
  trackDirectory(profile);
  const service = createManagedService(profile, { featureFlags: { session_runtime: true } });
  await service.start();
  const session = await service.createSession({ title: 'Durable desktop' });
  const app = new RuntimeApplicationService({ getRuntime: () => service.sessionRuntime });
  const events = []; const sent = [];
  const bridge = createChatStreamBridge({ sendBridgeEvent: (method, payload) => sent.push({ method, payload }),
    isStreamEnvelopeV2Enabled: () => true, log() {} });
  service.on('chat-stream', payload => { events.push(payload); bridge.handleEvent(payload); });
  const terminal = waitForChatStreamEvent(service, payload => payload.type === 'complete' || payload.type === 'error', 10000);
  const ack = await app.submit({ idempotency_key: 'desktop_fixture', session_id: session.data.id, prompt: 'Say hello.', preferred_model: 'mock-v1' });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  await terminal;
  await waitFor(() => service.sessionRuntime.store.get(ack.work_id).status === 'completed', 'runtime complete');
  const target = service.projectApplicationService.createProject({ name: 'After completed send' });
  const assignment = service.projectApplicationService.assignSessionProject({
    session_id: session.data.id, project_id: target.project.id,
  });
  assert.equal(assignment.ok, true, JSON.stringify({ assignment,
    actor: service.sessionTurnActors.hasActiveLifecycle(session.data.id),
    runtime: service.sessionRuntime.hasSessionWork(session.data.id),
    records: service.sessionStore.listSessionRecords().map(row => ({ id: row.id, active_turn: row.active_turn,
      pending_question_batch: row.pending_question_batch })) }));
  const started = events.filter(row => row.type === 'started');
  assert.equal(started.length, 1);
  const identity = started[0].runtimeAdmission;
  assert.equal(identity.work_id, ack.work_id); assert.equal(identity.turn_id, ack.turn_id);
  assert.equal(identity.idempotency_key, 'desktop_fixture');
  const user = service.sessionStore.getSessionMessages(session.data.id).find(row => row.role === 'user');
  assert.equal(identity.user_message_id, user.id);
  const envelope = sent.find(row => row.method === 'chat.onStreamEnvelope' && row.payload.eventKind === 'started');
  assert.deepEqual(envelope.payload.payload.runtimeAdmission, identity);
  assert.ok(events.indexOf(started[0]) < events.findIndex(row => row.type === 'delta'));
  bridge.resetStream(identity.stream_id); await service.stop();
});

for (const envelope of [false, true]) test(`ordered production mailbox binds admission before content (${envelope ? 'v2' : 'legacy'})`, async t => {
  let captured; let acknowledge;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: { submit: payload => {
    captured = payload; return new Promise(resolve => { acknowledge = resolve; }); } } } });
  t.after(h.restore);
  const sending = h.controller.startPromptSend('hello'); await new Promise(resolve => setImmediate(resolve));
  const seen = []; let listener;
  const handle = async payload => {
    seen.push(payload.type || payload.eventKind);
    assert.equal(h.state.messagesBySession.get('session-1')[0].id, 'authoritative_user');
    if ((payload.type || payload.eventKind) === 'started') await new Promise(resolve => setImmediate(resolve));
    return { buffered: false, terminal: false };
  };
  const lifecycle = createStreamHandlerLifecycle({ state: h.state, normalizeId: value => String(value || ''),
    appendClientLog() {}, handleStreamPayload: handle, handleStreamEnvelope: handle,
    pendingStreamCommitQueue: { dispose() {} }, runtime: { disposeRenderQueue() {} },
    approvalToastSessionIds: new Set(), reasoningStreamMerger: { clearAll() {} },
    isRowModelEnabled: () => false, getLiveStateStore: () => null,
    isStreamEnvelopeV2Enabled: () => envelope, clearBufferedStreamEvents() {} });
  lifecycle.registerStreamHandler({ chat: { onStream: fn => { listener = fn; return () => {}; },
    onStreamEnvelope: fn => { listener = fn; return () => {}; } } });
  const receipt = { work_id: 'work_x', turn_id: 'turn_x', session_id: 'session-1', stream_id: 'stream_x',
    user_message_id: 'authoritative_user', idempotency_key: captured.idempotency_key };
  const base = { sessionId: 'session-1', turnId: 'turn_x', streamId: 'stream_x' };
  const first = listener({ ...base, ...(envelope ? { eventKind: 'started', payload: { runtimeAdmission: receipt } } : { type: 'started', runtimeAdmission: receipt }) });
  const second = listener({ ...base, ...(envelope ? { eventKind: 'delta', payload: { content: 'hello' } } : { type: 'delta', content: 'hello' }) });
  await Promise.all([first, second]); assert.deepEqual(seen, ['started', 'delta']);
  acknowledge({ ok: true, work_id: 'work_x', turn_id: 'turn_x', session_id: 'session-1' }); await sending;
  lifecycle.dispose(); h.controller.dispose();
});

test('canonical creation binds only valid unbound draft images before durable Send', async t => {
  t.after(cleanupTrackedResources);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-desktop-image-create-')); trackDirectory(profile);
  const service = createManagedService(profile, { featureFlags: { session_runtime: true } });
  const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
  service.attachmentAssetStore = new AttachmentAssetStore({ rootDir: path.join(profile, 'attachments'), nativeImage: null });
  const { ensureSessionAttachmentAuthority } = require('../../services/projects/session-attachment-authority');
  const authority = ensureSessionAttachmentAuthority(service);
  const image = service.attachmentAssetStore.saveImageBufferSync(Buffer.from('controlled-image-bytes'),
    { displayName: 'draft.png', mimeType: 'image/png', sourceKind: 'paste' });
  authority.registerImportedImages(authority.captureImportScope(), [image]);
  const created = await service.createSession({ title: 'With image', initialPrompt: 'Unsent draft', linkedTaskId: 'task_image', draftImageAttachments: [image] });
  assert.equal(authority.authorizeManagedSend([image], { requestedSessionId: created.data.id, resolvedSessionId: created.data.id }).count, 1);
  const canonical = service.sessionStore.getSession(created.data.id);
  assert.equal(canonical.composer_draft, 'Unsent draft');
  assert.equal(canonical.linked_task_id, 'task_image');
  const count = service.sessionStore.listSessions().length;
  await assert.rejects(service.createSession({ title: 'Foreign reuse', draftImageAttachments: [image] }), /not authorized/);
  assert.equal(service.sessionStore.listSessions().length, count, 'invalid image must not create a canonical session');
  await assert.rejects(service.createSession({ draftImageAttachments: [{ kind: 'text' }] }), /session_draft_images_invalid/);
});


test('failed image binding rolls back only the new conversation and releases the full batch', async t => {
  t.after(cleanupTrackedResources);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-desktop-image-rollback-')); trackDirectory(profile);
  const service = createManagedService(profile);
  const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
  service.attachmentAssetStore = new AttachmentAssetStore({ rootDir: path.join(profile, 'attachments'), nativeImage: null });
  const { ensureSessionAttachmentAuthority } = require('../../services/projects/session-attachment-authority');
  const authority = ensureSessionAttachmentAuthority(service);
  const images = ['a', 'b'].map(name => service.attachmentAssetStore.saveImageBufferSync(Buffer.from(`image-${name}`),
    { displayName: `${name}.png`, mimeType: 'image/png', sourceKind: 'file' }));
  authority.registerImportedImages(authority.captureImportScope(), images);
  const existing = await service.createSession({ title: 'Keep existing' });
  const capture = service.projectAuthority.captureSession;
  service.projectAuthority.captureSession = () => { throw new Error('controlled authority failure'); };
  await assert.rejects(service.createSession({ draftImageAttachments: images }), /controlled authority failure/);
  service.projectAuthority.captureSession = capture;
  assert.deepEqual(service.sessionStore.listSessions().map(row => row.id), [existing.data.id]);
  const retry = await service.createSession({ draftImageAttachments: images });
  assert.equal(authority.authorizeManagedSend(images, { requestedSessionId: retry.data.id, resolvedSessionId: retry.data.id }).count, 2);
});
