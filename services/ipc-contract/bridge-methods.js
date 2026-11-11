/**
 * Descriptor builders shared by the services/ipc-contract/descriptors-*.js
 * domain tables, and the composition that merges those tables into
 * JENNY_SHELL_BRIDGE_DESCRIPTORS (services/ipc-contract.js).
 */

function createBridgeMethod(kind, channel) {
  return Object.freeze({
    kind,
    channel,
  });
}

const invokeMethod = (channel) => createBridgeMethod('invoke', channel);
const subscribeMethod = (channel) => createBridgeMethod('subscribe', channel);
const sendMethod = (channel) => createBridgeMethod('send', channel);
// 'local' methods run entirely inside the preload context (no IPC channel):
// needed for Electron APIs that must receive renderer-world objects directly,
// e.g. webUtils.getPathForFile(File).
const localMethod = (impl) => Object.freeze({ kind: 'local', impl });

// Merges [domainName, descriptorTable] pairs in list order, so the composed
// key order is the domain order followed by each table's own order. A method
// path defined by two domains is a contract error, never a silent override.
function composeBridgeDescriptors(domainTables) {
  const composed = {};
  const ownerByPath = new Map();
  for (const [domainName, table] of domainTables) {
    for (const [methodPath, descriptor] of Object.entries(table)) {
      if (ownerByPath.has(methodPath)) {
        throw new Error(
          `Jenny IPC bridge path "${methodPath}" is defined by both the "${ownerByPath.get(methodPath)}" `
            + `and "${domainName}" descriptor modules.`
        );
      }
      ownerByPath.set(methodPath, domainName);
      composed[methodPath] = descriptor;
    }
  }
  return Object.freeze(composed);
}

module.exports = {
  composeBridgeDescriptors,
  invokeMethod,
  localMethod,
  sendMethod,
  subscribeMethod,
};
