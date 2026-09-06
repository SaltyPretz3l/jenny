'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SidecarClient } = require('../services/backend/sidecar-client');

test('modelsList forwards an optional exact-model inspection request', async () => {
  const client = new SidecarClient();
  let request = null;
  client.request = async (method, params) => {
    request = { method, params };
    return { models: [] };
  };

  await client.modelsList('ollama', { inspectModelId: 'ornith15:9b-q6-256k' });

  assert.equal(request.method, 'models.list');
  assert.equal(request.params.engine_type, 'ollama');
  assert.equal(request.params.inspect_model_id, 'ornith15:9b-q6-256k');
});

test('modelsList omits inspection metadata for existing callers', async () => {
  const client = new SidecarClient();
  let params = null;
  client.request = async (_method, value) => {
    params = value;
    return { models: [] };
  };

  await client.modelsList('ollama');

  assert.equal(Object.hasOwn(params, 'inspect_model_id'), false);
});
