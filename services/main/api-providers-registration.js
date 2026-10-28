'use strict';

// Registers the apiProviders.* IPC (row 78): the Settings > Models "API
// providers" group. The service owns every rule; this module only builds it
// over the real secure store, validates that each payload is a plain object and
// maps the single-object payloads onto the service calls. A payload is never
// logged: setKey carries the secret.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { createApiProviderService } = require('../backend/api-provider-service');

function noop() {}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const INVALID_REQUEST = Object.freeze({ ok: false, code: 'invalid_request' });

// Wraps a handler so a non-object payload is refused before it reaches the service.
const withPayload = (handler) => (_event, payload) => (
  isPlainObject(payload) ? handler(payload) : { ...INVALID_REQUEST }
);

function registerApiProviders(ipcMainLike, {
  backendService,
  shellConfigService = backendService?.configService || null,
  sendBridgeEvent = noop,
  authorization = {},
  log = noop,
  fetchImpl,
  lookup,
} = {}) {
  let disposed = false;
  const service = createApiProviderService({
    shellConfigService,
    secureStore: backendService?.secureStore || null,
    backendService,
    sendBridgeEvent: (channel, payload) => { if (!disposed) sendBridgeEvent(channel, payload); },
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(lookup ? { lookup } : {}),
    log,
  });
  service.purgeOrphanKeys();

  registerIpcInvokeHandlers(ipcMainLike, {
    'apiProviders.getState': () => service.getState(),
    'apiProviders.addInstance': withPayload((request) => service.addInstance(request)),
    'apiProviders.removeInstance': withPayload(({ instanceId }) => service.removeInstance(instanceId)),
    'apiProviders.renameInstance': withPayload(({ instanceId, label }) => service.renameInstance(instanceId, label)),
    'apiProviders.setKey': withPayload(({ instanceId, key }) => service.setKey(instanceId, key)),
    'apiProviders.clearKey': withPayload(({ instanceId }) => service.clearKey(instanceId)),
    'apiProviders.discover': withPayload(({ instanceId }) => service.discover(instanceId)),
    'apiProviders.setModelEnabled': withPayload(({ instanceId, modelId, enabled }) => (
      service.setModelEnabled(instanceId, modelId, enabled))),
    'apiProviders.setModelPin': withPayload(({ instanceId, modelId, pin }) => service.setModelPin(instanceId, modelId, pin)),
    'apiProviders.acknowledgeNotice': withPayload(({ instanceId }) => service.acknowledgeNotice(instanceId)),
  }, authorization);

  // Handlers stay registered like the other core owners'; a late mutation just stops pushing.
  return { service, dispose: () => { disposed = true; } };
}

module.exports = { registerApiProviders };
