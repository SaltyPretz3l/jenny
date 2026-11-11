/**
 * Persisted UI state and tuning: workspace / chat / window UI state, the
 * appearance relay, model / engine / compaction tuning and the next-turn
 * context summary.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'workspace.getState': invokeMethod('workspace:get-state'),
  'workspace.updateState': invokeMethod('workspace:update-state'),
  'chatUi.getState': invokeMethod('chat-ui:get-state'),
  'chatUi.updateSettings': invokeMethod('chat-ui:update-settings'),
  'windowUi.getState': invokeMethod('window-ui:get-state'),
  'windowUi.updateSettings': invokeMethod('window-ui:update-settings'),
  // Row 88 D6: a chatUi / windowUi / workspaceIde preferences commit from any writer (Settings,
  // the Jenny chat's settings_change, undo) pushes the new state, so an open Settings page and
  // the shell repaint at once instead of on the 15 s poll. Renderer handlers are idempotent.
  'chatUi.onChanged': subscribeMethod('chat-ui:changed'),
  'windowUi.onChanged': subscribeMethod('window-ui:changed'),
  // Row 88 D8: the appearance relay. Palette, typography, font scale and chat width live in the
  // renderer's localStorage; main reads and applies them only through this one-shot request and
  // the renderer's reply (wire in services/primary-settings-contract.js). Main fails closed.
  'appearance.onRelayRequest': subscribeMethod('appearance:relay-request'),
  'appearance.respondRelay': invokeMethod('appearance:relay-respond'),
  'modelTuning.getState': invokeMethod('model-tuning:get-state'),
  'modelTuning.update': invokeMethod('model-tuning:update'),
  'engineTuning.getState': invokeMethod('engine-tuning:get-state'),
  'engineTuning.update': invokeMethod('engine-tuning:update'),
  'engineTuning.reset': invokeMethod('engine-tuning:reset'),
  'compaction.getTuning': invokeMethod('compaction:get-tuning'),
  'compaction.setTuning': invokeMethod('compaction:set-tuning'),
  'chat.getNextTurnContextSummary': invokeMethod('chat:next-turn-context-summary'),
});
