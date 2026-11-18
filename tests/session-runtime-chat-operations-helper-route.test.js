'use strict';

// new-test-file: the chat gateway's route wiring had no test of its own (only executionOptionsFor, in the digest file).
// Row 179: a cloud turn gains one local helper admission route only while the local subagent engine is ready.

const test = require('node:test');
const assert = require('node:assert/strict');

const { localHelperRoutes } = require('../services/backend/session-runtime-chat-operations');
const { captureRuntimeRoute, isRuntimeRoute } = require('../services/session-runtime/lanes');

const cloud = captureRuntimeRoute({ engine_type: 'api-provider', provider_id: 'api-provider',
  configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
const local = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
  configuration_revision: 'config:1', resource_class: 'local', requires_gpu: true });

function service(ready) {
  return {
    currentEngineType: 'api-provider',
    configService: { getState: () => ({ localEngines: { openaiCompatible: { port: 8034 } } }) },
    getLocalSubagentEngineStatus: () => ({ ready }),
  };
}

test('a cloud turn with a ready helper gets one captured local openai-compatible route', () => {
  const routes = localHelperRoutes(service(true), cloud);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].engine_type, 'openai-compatible');
  assert.equal(routes[0].resource_class, 'local');
  assert.equal(isRuntimeRoute(routes[0]), true);
});

test('no helper route without a ready helper, on a local turn, or without the status hook', () => {
  assert.deepEqual(localHelperRoutes(service(false), cloud), []);
  assert.deepEqual(localHelperRoutes(service(true), local), []);
  assert.deepEqual(localHelperRoutes({ currentEngineType: 'api-provider' }, cloud), []);
  assert.deepEqual(localHelperRoutes(null, cloud), []);
});
