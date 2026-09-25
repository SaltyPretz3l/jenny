const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  createManagedService,
  waitForChatStreamEvent,
} = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar stores the canonical effort and clamps only the outgoing request', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reasoning-support-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  let status = await service.refreshStatusSnapshot();
  assert.equal(status.reasoning_effort_support, 'unsupported');

  const created = await service.createSession({
    title: 'Reasoning Support Session',
    preferences: {
      // qwen3.8 is the Ollama family that accepts a graded level (CMP-AI-0005 self-heals others).
      preferred_model: 'qwen3.8:9b',
      reasoning_effort: 'high',
    },
  });
  assert.equal(created.data.reasoning_effort, 'high');

  await service.setSessionPreferences(created.data.id, {
    preferred_model: 'llama3.2',
    reasoning_effort: 'high',
  });

  const sessions = await service.listSessions();
  const managedSession = sessions.data.find((session) => session.id === created.data.id);
  assert.ok(managedSession);
  assert.equal(managedSession.reasoning_effort, 'high');

  await service.loadModel('qwen3.8:9b');
  status = await service.refreshStatusSnapshot();
  assert.equal(status.reasoning_effort_support, 'supported');
  assert.equal(status.active_model_capabilities.thinking, true);
  assert.equal(status.active_model_reasoning_support, 'supported');

  await service.setSessionPreferences(created.data.id, {
    preferred_model: 'qwen3.8:9b',
    reasoning_effort: 'xhigh',
  });
  const sessionsAfterXhigh = await service.listSessions();
  const xhighSession = sessionsAfterXhigh.data.find((session) => session.id === created.data.id);
  assert.ok(xhighSession);
  assert.equal(xhighSession.reasoning_effort, 'xhigh');

  const chatSendCalls = [];
  const originalChatSend = service.sidecarClient.chatSend.bind(service.sidecarClient);
  service.sidecarClient.chatSend = async (params, options = {}) => {
    chatSendCalls.push(params);
    return originalChatSend(params, options);
  };
  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Show the request effort.',
    preferredModel: 'qwen3.8:9b',
    reasoningEffort: 'xhigh',
  });
  await completed;
  assert.equal(chatSendCalls[0].reasoning_effort, 'xhigh');
  assert.equal(service.sessionStore.getSession(created.data.id).reasoning_effort, 'xhigh');

  await service.loadModel('llama3.2');
  status = await service.refreshStatusSnapshot();
  assert.equal(status.reasoning_effort_support, 'unsupported');
  assert.equal(Boolean(status.active_model_capabilities.thinking), false);

  await service.stop();
});

test('unsupported active model omits request effort without rewriting a stored no-override choice', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reasoning-request-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();
  await service.loadModel('llama3.2');
  const created = await service.createSession({
    title: 'Stored Reasoning Choice',
    preferences: { reasoning_effort: 'medium' },
  });
  const baselineUpdatedAt = created.data.updated_at;

  await service.refreshStatusSnapshot();
  await service.listSessions();
  const beforeSend = service.sessionStore.getSession(created.data.id);
  assert.equal(beforeSend.preferred_model, '');
  assert.equal(beforeSend.reasoning_effort, 'medium');
  assert.equal(beforeSend.updated_at, baselineUpdatedAt);

  const chatSendCalls = [];
  const originalChatSend = service.sidecarClient.chatSend.bind(service.sidecarClient);
  service.sidecarClient.chatSend = async (params, options = {}) => {
    chatSendCalls.push(params);
    return originalChatSend(params, options);
  };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Send with the active model.',
    reasoningEffort: 'medium',
  });
  await completed;

  assert.equal(Object.hasOwn(chatSendCalls[0], 'reasoning_effort'), false);
  const afterSend = service.sessionStore.getSession(created.data.id);
  assert.equal(afterSend.reasoning_effort, 'medium');
  assert.notEqual(afterSend.updated_at, baselineUpdatedAt);

  await service.stop();
});
