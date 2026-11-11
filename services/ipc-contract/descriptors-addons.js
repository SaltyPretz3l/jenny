/**
 * Performance metrics, the command sandbox and the optional add-ons and
 * runtimes: PDF add-on, dictation, image engine and NInfer.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // performance.*: live inference metrics, GPU-pressure warnings and their two
  // settings (row 59 checkpoint 6). Closed `{schema_version:1, ...}` requests answered
  // with `{ok, ...}` or `{ok:false, code, reason}`; trusted-sender authorized in
  // services/main/performance-ipc-registration.js. onChanged carries only invalidations
  // `{session_id: null|string, terminal, scope}`, at most four a second per session;
  // the renderer refetches. Desktop only (no hosted route).
  'performance.getSnapshot': invokeMethod('performance:get-snapshot'),
  'performance.updateSettings': invokeMethod('performance:update-settings'),
  'performance.dismissWarning': invokeMethod('performance:dismiss-warning'),
  'performance.onChanged': subscribeMethod('performance:changed'),
  'commandSandbox.getState': invokeMethod('command-sandbox:get-state'),
  'commandSandbox.setEnabled': invokeMethod('command-sandbox:set-enabled'),
  // Row 106: exactly { mode: 'copy'|'synced' }; 'synced' is refused under the kill switch.
  'commandSandbox.setMode': invokeMethod('command-sandbox:set-mode'),
  'commandSandbox.retry': invokeMethod('command-sandbox:retry'),
  'commandSandbox.onChanged': subscribeMethod('command-sandbox:changed'),
  // pdfAddon.*: the optional PDF reading add-on (PyMuPDF, AGPL-3.0) in Settings >
  // Tools. install/installFromFile take exactly { licenseAccepted: true }; the
  // wheel for installFromFile comes from a main-owned dialog, never a renderer
  // path. Trusted-sender-authorized in services/main/pdf-addon-ipc-registration.js.
  'pdfAddon.getState': invokeMethod('pdf-addon:get-state'),
  'pdfAddon.install': invokeMethod('pdf-addon:install'),
  'pdfAddon.installFromFile': invokeMethod('pdf-addon:install-from-file'),
  'pdfAddon.cancel': invokeMethod('pdf-addon:cancel'),
  'pdfAddon.remove': invokeMethod('pdf-addon:remove'),
  'pdfAddon.onChanged': subscribeMethod('pdf-addon:changed'),
  // dictation.*: push-to-talk speech input (row 84). getState/setup/cancel/remove/
  // onChanged manage the downloaded speech model (state: not_installed | downloading |
  // verifying | ready | failed); prepare() warms the engine and transcribe(ArrayBuffer of
  // 16 kHz mono PCM16, 0.2-120 s) answers { ok, text, durationMs, engineMs } or
  // { ok: false, reason }. The renderer never sees a model path. Trusted-sender-authorized
  // in services/main/dictation-ipc-registration.js; desktop only.
  'dictation.getState': invokeMethod('dictation:get-state'),
  'dictation.setup': invokeMethod('dictation:setup'),
  'dictation.cancel': invokeMethod('dictation:cancel'),
  'dictation.remove': invokeMethod('dictation:remove'),
  'dictation.onChanged': subscribeMethod('dictation:changed'),
  'dictation.prepare': invokeMethod('dictation:prepare'),
  'dictation.transcribe': invokeMethod('dictation:transcribe'),
  // Windows only: opens the OS microphone privacy page (fixed URL); { ok } or { ok: false, reason }.
  'dictation.openMicrophoneSettings': invokeMethod('dictation:open-microphone-settings'),
  // imageEngine.*: native image generation in the Model Library. Install/remove
  // require confirmation; runtime and folder picks use main-owned dialogs.
  // Trusted-sender-authorized in services/main/image-engine-ipc-registration.js.
  'imageEngine.getState': invokeMethod('image-engine:get-state'),
  'imageEngine.install': invokeMethod('image-engine:install'),
  'imageEngine.cancelInstall': invokeMethod('image-engine:cancel-install'),
  'imageEngine.remove': invokeMethod('image-engine:remove'),
  'imageEngine.chooseRuntime': invokeMethod('image-engine:choose-runtime'),
  'imageEngine.clearRuntime': invokeMethod('image-engine:clear-runtime'),
  'imageEngine.chooseModelFolder': invokeMethod('image-engine:choose-model-folder'),
  'imageEngine.scanModels': invokeMethod('image-engine:scan-models'),
  'imageEngine.saveModelSet': invokeMethod('image-engine:save-model-set'),
  'imageEngine.listModelSets': invokeMethod('image-engine:list-model-sets'),
  'imageEngine.chooseComfyFolder': invokeMethod('image-engine:choose-comfy-folder'),
  'imageEngine.checkComfyFolder': invokeMethod('image-engine:check-comfy-folder'),
  'imageEngine.saveComfySet': invokeMethod('image-engine:save-comfy-set'),
  'imageEngine.removeModelSet': invokeMethod('image-engine:remove-model-set'),
  'imageEngine.setDefaultModelSet': invokeMethod('image-engine:set-default-model-set'),
  'imageEngine.reconcile': invokeMethod('image-engine:reconcile'),
  'imageEngine.forceClear': invokeMethod('image-engine:force-clear'),
  'imageEngine.onChanged': subscribeMethod('image-engine:changed'),
  // ninfer.*: the managed NInfer runtime (row 54, RTX 5090 only). Flag off or an
  // ineligible GPU answers getState with { eligible: false, reason } and every
  // action with ninfer_unavailable. Trusted-sender-authorized in
  // services/main/ninfer-ipc-registration.js; onChanged says only what moved.
  'ninfer.getState': invokeMethod('ninfer:get-state'),
  'ninfer.setup': invokeMethod('ninfer:setup'),
  'ninfer.cancelSetup': invokeMethod('ninfer:cancel-setup'),
  'ninfer.remove': invokeMethod('ninfer:remove'),
  'ninfer.start': invokeMethod('ninfer:start'),
  'ninfer.stop': invokeMethod('ninfer:stop'),
  'ninfer.restart': invokeMethod('ninfer:restart'),
  'ninfer.dismissSuggestion': invokeMethod('ninfer:dismiss-suggestion'),
  'ninfer.updateSettings': invokeMethod('ninfer:update-settings'),
  'ninfer.onChanged': subscribeMethod('ninfer:changed'),
  // browserUse.*: the browser panel beside a chat (row 114). Payloads are closed:
  // { session_id } or, for show/setBounds, { session_id, bounds: { x, y, width, height } }.
  // Answers are { ok, ... } or { ok: false, reason } (browser_unavailable, no_page,
  // invalid_payload). Trusted-sender-authorized in services/main/browser-use-ipc-registration.js;
  // onChanged pushes { session_id, open, mode, url, title, loading, busy, action, target, asking, waiting, crashed,
  // user_touched, closed_reason, failed, note, pending_url, can_back, can_forward, zoom, find, signed_in } and, once
  // for a shortcut pressed in the page, command ('focus_address' or 'open_find').
  'browserUse.getState': invokeMethod('browser-use:get-state'),
  'browserUse.show': invokeMethod('browser-use:show'),
  'browserUse.setBounds': invokeMethod('browser-use:set-bounds'),
  'browserUse.hide': invokeMethod('browser-use:hide'),
  'browserUse.capture': invokeMethod('browser-use:capture'),
  'browserUse.takeOver': invokeMethod('browser-use:take-over'),
  'browserUse.handBack': invokeMethod('browser-use:hand-back'),
  'browserUse.close': invokeMethod('browser-use:close'),
  'browserUse.navigate': invokeMethod('browser-use:navigate'),
  'browserUse.zoom': invokeMethod('browser-use:zoom'),
  'browserUse.find': invokeMethod('browser-use:find'),
  'browserUse.stopFind': invokeMethod('browser-use:stop-find'),
  'browserUse.siteInfo': invokeMethod('browser-use:site-info'),
  'browserUse.removeSite': invokeMethod('browser-use:remove-site'),
  'browserUse.revealDownload': invokeMethod('browser-use:reveal-download'),
  'browserUse.configure': invokeMethod('browser-use:configure'),
  'browserUse.toggleSound': invokeMethod('browser-use:toggle-sound'),
  'browserUse.setAdBlock': invokeMethod('browser-use:set-ad-block'),
  'browserUse.onChanged': subscribeMethod('browser-use:changed'),
  'appSound.getState': invokeMethod('app-sound:get-state'),
  'appSound.setMuted': invokeMethod('app-sound:set-muted'),
  'appSound.onChanged': subscribeMethod('app-sound:changed'),
});
