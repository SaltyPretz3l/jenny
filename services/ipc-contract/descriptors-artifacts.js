/**
 * Artifact preview staging, artifact file actions and chat image actions.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // artifactFrame.stage: one-shot document staging for the sandboxed HTML
  // preview frame (renderer-html-artifact-frame-utils.js ->
  // services/artifact-frame-protocol.js). Returns { ok, url } where url is a
  // single-use jenny-artifact:// URL the factory assigns to iframe.src.
  'artifactFrame.stage': invokeMethod('artifact-frame:stage'),
  'artifacts.read': invokeMethod('artifacts:read'),
  'artifacts.save': invokeMethod('artifacts:save'),
  'artifacts.saveAs': invokeMethod('artifacts:save-as'),
  'artifacts.copyImage': invokeMethod('artifacts:copy-image'),
  // Desktop image actions accept session/artifact identifiers only; never paths.
  'artifacts.capabilities': invokeMethod('artifacts:capabilities'),
  'artifacts.openWith': invokeMethod('artifacts:open-with'),
  'artifacts.reveal': invokeMethod('artifacts:reveal'),
  'artifacts.openExternal': invokeMethod('artifacts:open-external'),
  'artifacts.delete': invokeMethod('artifacts:delete'),
  'artifacts.deleteSession': invokeMethod('artifacts:delete-session'),
  // Non-artifact chat images (attachments, tool output): session ID plus
  // { kind: 'attachment' | 'tool', id } only; never paths.
  'chatImages.copyImage': invokeMethod('chat-images:copy-image'),
  'chatImages.saveAs': invokeMethod('chat-images:save-as'),
  'chatImages.reveal': invokeMethod('chat-images:reveal'),
});
