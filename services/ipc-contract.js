/**
 * Type-safe IPC contract for the Jenny preload bridge.
 *
 * JENNY_SHELL_BRIDGE_DESCRIPTORS below is the single runtime authority for
 * the JennyShellBridge surface. Its rows live per domain in
 * services/ipc-contract/descriptors-*.js: add a method to its domain module.
 * The list below fixes the composition order (the bridge's key order) and
 * loading fails if two domain modules define the same method path.
 *
 * @module ipc-contract
 */

const { composeBridgeDescriptors, invokeMethod } = require('./ipc-contract/bridge-methods');

// Static requires (not a directory scan) so the esbuild preload bundle sees
// every domain module.
const JENNY_SHELL_BRIDGE_DESCRIPTORS = composeBridgeDescriptors([
  ['sessions', require('./ipc-contract/descriptors-sessions')],
  ['shell', require('./ipc-contract/descriptors-shell')],
  ['main-requests', require('./ipc-contract/descriptors-main-requests')],
  ['diagnostics', require('./ipc-contract/descriptors-diagnostics')],
  ['cloud', require('./ipc-contract/descriptors-cloud')],
  ['preferences', require('./ipc-contract/descriptors-preferences')],
  ['workspace', require('./ipc-contract/descriptors-workspace')],
  ['settings', require('./ipc-contract/descriptors-settings')],
  ['artifacts', require('./ipc-contract/descriptors-artifacts')],
  ['memory-companion', require('./ipc-contract/descriptors-memory-companion')],
  ['local-engines', require('./ipc-contract/descriptors-local-engines')],
  ['chat', require('./ipc-contract/descriptors-chat')],
  ['chat-workspace', require('./ipc-contract/descriptors-chat-workspace')],
  ['addons', require('./ipc-contract/descriptors-addons')],
  ['tools-data', require('./ipc-contract/descriptors-tools-data')],
  ['team', require('./ipc-contract/descriptors-team')],
]);

// Channels only the preload itself invokes: main registers handlers for them
// like any invoke path, but createJennyShellBridge never exposes them to the
// page, which paints untrusted model output. A path here must be one the page
// cannot forge through any public method.
const JENNY_PRELOAD_INTERNAL_DESCRIPTORS = Object.freeze({
  // Paths webUtils resolved from real dropped Files: user-granted like a
  // picker selection, so main skips the workspace-root check for them.
  'attachments.prepareDroppedPaths': invokeMethod('attachments:prepare-dropped-paths'),
});

function getBridgeDescriptor(methodPath) {
  const key = String(methodPath || '').trim();
  return JENNY_SHELL_BRIDGE_DESCRIPTORS[key] || JENNY_PRELOAD_INTERNAL_DESCRIPTORS[key] || null;
}

function getBridgeChannel(methodPath, expectedKind = '') {
  const descriptor = getBridgeDescriptor(methodPath);
  if (!descriptor) {
    throw new Error(`Unknown Jenny IPC bridge path: ${methodPath}`);
  }
  if (expectedKind && descriptor.kind !== expectedKind) {
    throw new Error(
      `Jenny IPC bridge path "${methodPath}" must be "${expectedKind}", received "${descriptor.kind}".`
    );
  }
  return descriptor.channel;
}

function assignBridgeMethod(target, methodPath, value) {
  const segments = String(methodPath || '').split('.').filter(Boolean);
  if (!segments.length) {
    throw new Error('Jenny IPC bridge paths must not be empty.');
  }
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== 'object') {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function subscribeToBridgeChannel(ipcRenderer, channel, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError(`Jenny IPC bridge listener for "${channel}" must be a function.`);
  }
  const wrapped = (_, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function createJennyShellBridge({
  ipcRenderer,
  subscribe = subscribeToBridgeChannel,
  localImplementations = {},
} = {}) {
  if (!ipcRenderer) {
    throw new Error('createJennyShellBridge requires ipcRenderer.');
  }
  if (typeof subscribe !== 'function') {
    throw new TypeError('createJennyShellBridge requires subscribe to be a function.');
  }
  const bridge = {};
  for (const [methodPath, descriptor] of Object.entries(JENNY_SHELL_BRIDGE_DESCRIPTORS)) {
    let bridgeMethod;
    if (descriptor.kind === 'invoke') {
      bridgeMethod = (...args) => ipcRenderer.invoke(descriptor.channel, ...args);
    } else if (descriptor.kind === 'send') {
      bridgeMethod = (...args) => ipcRenderer.send(descriptor.channel, ...args);
    } else if (descriptor.kind === 'subscribe') {
      bridgeMethod = (listener) => subscribe(ipcRenderer, descriptor.channel, listener);
    } else if (descriptor.kind === 'local') {
      const impl = localImplementations[descriptor.impl];
      // Fail-soft when the hosting context did not provide the implementation
      // (e.g. test harnesses): the method exists but reports no result.
      bridgeMethod = typeof impl === 'function' ? impl : () => '';
    } else {
      throw new Error(`Unsupported Jenny IPC bridge method kind: ${descriptor.kind}`);
    }
    assignBridgeMethod(bridge, methodPath, bridgeMethod);
  }
  return bridge;
}

function registerIpcInvokeHandlers(
  ipcMainLike,
  handlersByPath = {},
  { authorize = null, unauthorizedResult = null } = {}
) {
  if (!ipcMainLike || typeof ipcMainLike.handle !== 'function') {
    throw new TypeError('registerIpcInvokeHandlers requires an ipcMain-like object with handle().');
  }
  const registeredChannels = [];
  for (const [methodPath, handler] of Object.entries(handlersByPath)) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Jenny IPC bridge handler for "${methodPath}" must be a function.`);
    }
    const channel = getBridgeChannel(methodPath, 'invoke');
    const registeredHandler = typeof authorize === 'function'
      ? (event, ...args) => {
          let allowed = false;
          try {
            allowed = authorize(event, { methodPath, channel }) === true;
          } catch (_error) {
            /* authorization failures are denials */
          }
          if (!allowed) {
            return typeof unauthorizedResult === 'function'
              ? unauthorizedResult({ methodPath, channel })
              : { ok: false, authorized: false, code: 'ipc_sender_unauthorized' };
          }
          return handler(event, ...args);
        }
      : handler;
    ipcMainLike.handle(channel, registeredHandler);
    registeredChannels.push(channel);
  }
  return registeredChannels;
}

function listBridgeMethodPaths({ kind = '' } = {}) {
  return Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS)
    .filter((methodPath) => !kind || JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath].kind === kind)
    .sort();
}

module.exports = {
  JENNY_PRELOAD_INTERNAL_DESCRIPTORS,
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  createJennyShellBridge,
  getBridgeChannel,
  getBridgeDescriptor,
  listBridgeMethodPaths,
  registerIpcInvokeHandlers,
  subscribeToBridgeChannel,
};
