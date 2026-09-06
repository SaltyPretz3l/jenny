'use strict';

// chatgptPlanUsage.* IPC namespace: renderer read + live push of the ChatGPT
// plan-usage meter (composer footer ring). Composes the persisted store
// (services/backend/chatgpt-plan-usage-store.js), attaches the already-
// composed chatgptAuthService (Stage 7 plugin auth owner, see
// services/main/plugins-ipc-registration.js), and forwards `changed` / auth /
// backend-engine-status changes as one push channel. Flag-off or a missing
// backendService registers nothing -- byte-identical rollback. See
// docs/plans "ChatGPT plan-usage meter" W2.

const path = require('node:path');

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { createChatGptPlanUsageStore } = require('../backend/chatgpt-plan-usage-store');

const PLAN_USAGE_FILE_NAME = 'chatgpt-plan-usage.json';

function noop() {}

function serializePayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch (_error) {
    return null;
  }
}

function engineIsChatgpt(backendService, shellConfigService) {
  if (String(backendService?.currentEngineType || '').trim().toLowerCase() === 'chatgpt') {
    return true;
  }
  let preferredEngineType = '';
  try {
    preferredEngineType = shellConfigService?.getState?.()?.preferredEngineType || '';
  } catch (_error) {
    // Fall through with the empty default.
  }
  return String(preferredEngineType).trim().toLowerCase() === 'chatgpt';
}

function buildAccountPayload(authStatus) {
  if (!authStatus || authStatus.state !== 'signed_in') {
    return null;
  }
  return {
    email: String(authStatus.email || ''),
    plan_type: String(authStatus.planType || ''),
  };
}

// registerChatGptPlanUsageIpc(ipcMain, { backendService, shellConfigService,
// sendBridgeEvent, app, log }) -> teardown function.
function registerChatGptPlanUsageIpc(ipcMainLike, {
  backendService,
  shellConfigService = null,
  sendBridgeEvent = noop,
  app,
  log = null,
} = {}) {
  const flagOff = backendService?.featureFlags?.chatgpt_plan_meter === false;
  if (!backendService || flagOff) {
    return noop;
  }

  const filePath = path.join(app.getPath('userData'), PLAN_USAGE_FILE_NAME);
  const store = createChatGptPlanUsageStore({
    filePath,
    getAccountId: () => {
      try {
        return backendService?.chatgptAuthService?.getAccountId?.() || '';
      } catch (_error) {
        return '';
      }
    },
    getFeatureFlags: () => backendService?.featureFlags || {},
    logger: log,
  });
  backendService.chatgptPlanUsageStore = store;

  if (backendService.chatgptAuthService) {
    store.attachAuthService(backendService.chatgptAuthService);
  }

  function buildPayload() {
    let authStatus = null;
    try {
      authStatus = backendService?.chatgptAuthService?.getStatus?.() || null;
    } catch (_error) {
      // Fall through with authStatus left null.
    }
    return {
      ok: true,
      provider_id: 'chatgpt',
      engine_active: engineIsChatgpt(backendService, shellConfigService),
      account: buildAccountPayload(authStatus),
      snapshot: store.getSnapshot(),
    };
  }

  // backend-status fires on every model-lifecycle transition for every user;
  // only a payload that actually differs from the last one sent is pushed,
  // so an Ollama-only session never triggers a renderer repaint from here.
  let lastPushedSerialized = null;
  function pushSnapshot({ force = false } = {}) {
    const payload = buildPayload();
    const serialized = serializePayload(payload);
    if (!force && serialized !== null && serialized === lastPushedSerialized) {
      return;
    }
    lastPushedSerialized = serialized;
    sendBridgeEvent('chatgptPlanUsage.onSnapshot', payload);
  }

  registerIpcInvokeHandlers(ipcMainLike, {
    'chatgptPlanUsage.getSnapshot': () => buildPayload(),
  });

  const unsubscribeStore = store.onChange(() => pushSnapshot());
  const unsubscribeAuth = typeof backendService.chatgptAuthService?.onStatusChange === 'function'
    ? backendService.chatgptAuthService.onStatusChange(() => pushSnapshot())
    : noop;
  // Best-effort: backendService is an EventEmitter emitting 'backend-status'
  // on every engine/status recompute (see services/main/backend-service-wiring.js).
  // No dedicated engine-change event exists, so this is the cheapest available
  // hook for keeping engine_active current; a backendService without on/off
  // (e.g. a test double) simply skips this push source.
  const backendStatusHandler = () => pushSnapshot();
  const canSubscribeBackendStatus = typeof backendService.on === 'function'
    && typeof backendService.off === 'function';
  if (canSubscribeBackendStatus) {
    backendService.on('backend-status', backendStatusHandler);
  }

  let torndown = false;
  function teardown() {
    if (torndown) {
      return;
    }
    torndown = true;
    try { unsubscribeStore(); } catch (_error) { /* best-effort */ }
    try { unsubscribeAuth(); } catch (_error) { /* best-effort */ }
    if (canSubscribeBackendStatus) {
      try { backendService.off('backend-status', backendStatusHandler); } catch (_error) { /* best-effort */ }
    }
    store.dispose();
  }
  return teardown;
}

module.exports = {
  registerChatGptPlanUsageIpc,
};
