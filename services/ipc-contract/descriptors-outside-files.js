/**
 * Files opened from outside the Workspace ("Open with Jenny", "File: Open
 * File..."; row 137). Main holds each file behind an opaque grant id: every
 * call names the id, never a path.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'outsideFiles.takePending': invokeMethod('outside-files:take-pending'),
  'outsideFiles.readText': invokeMethod('outside-files:read-text'),
  'outsideFiles.writeText': invokeMethod('outside-files:write-text'),
  'outsideFiles.readImage': invokeMethod('outside-files:read-image'),
  'outsideFiles.setOpenSet': invokeMethod('outside-files:set-open-set'),
  'outsideFiles.reveal': invokeMethod('outside-files:reveal'),
  'outsideFiles.attach': invokeMethod('outside-files:attach'),
  'outsideFiles.pick': invokeMethod('outside-files:pick'),
  'outsideFiles.onRequest': subscribeMethod('outside-files:request'),
  'outsideFiles.onChange': subscribeMethod('outside-files:changed'),
});
