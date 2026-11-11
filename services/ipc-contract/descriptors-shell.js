/**
 * Models and engine settings, shell status and lifecycle, system stats,
 * reminders and notifications.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod, sendMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'models.list': invokeMethod('models:list'),
  // Raw installed Ollama tags (engine-scoped to ollama), independent of the chat
  // engine — feeds the Model Library's Ollama source.
  'models.listOllamaTags': invokeMethod('models:list-ollama-tags'),
  'models.load': invokeMethod('models:load'),
  'models.unload': invokeMethod('models:unload'),
  'models.delete': invokeMethod('models:delete'),
  // Engine settings snapshot (shell-config localEngines + preferredEngineType)
  // for the Settings → Offline "Local engines" panel and its ChatGPT connect card.
  'engines.getSettings': invokeMethod('engines:get-settings'),
  'engines.updateSettings': invokeMethod('engines:update-settings'),
  'status.get': invokeMethod('status:get'),
  'lifecycle.onProgress': subscribeMethod('lifecycle:progress'),
  'lifecycle.signalReady': sendMethod('renderer:ready'),
  'system.getStats': invokeMethod('system:get-stats'),
  // Manual, forced, throttle-bypassed refresh from a titlebar metric-strip click.
  // The sample controller rate-limits it; the 2s system.onStats push is unchanged,
  // so this does not introduce renderer polling.
  'system.refreshStats': invokeMethod('system:refresh-stats'),
  // Renderer watchers (title-bar read-out, open health popover) announce that
  // the stats are on screen; main runs the 2s tick only while one is watching
  // and drops to 15s otherwise. Payload: { source, watched }.
  'system.setStatsWatch': invokeMethod('system:set-stats-watch'),
  'system.onStats': subscribeMethod('system:stats'),
  'safety.onUnattendedPause': subscribeMethod('safety:unattended-pause'),
  'reminders.onFired': subscribeMethod('reminders:fired'),
  'reminders.onOpen': subscribeMethod('reminders:open'),
  'reminders.snooze': invokeMethod('reminders:snooze'),
  'notifications.notify': sendMethod('notifications:notify'),
  'notifications.onOpen': subscribeMethod('notifications:open'),
});
