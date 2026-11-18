/**
 * Chat streaming and the composer: attachments, spellcheck, clipboard, save
 * dialog and background jobs.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod, localMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'chat.startStream': invokeMethod('chat:start-stream'),
  'chat.editAndRegenerate': invokeMethod('chat:edit-and-regenerate'),
  'chat.retryUnsavedReply': invokeMethod('chat:retry-unsaved-reply'),
  'chat.discardUnsavedReply': invokeMethod('chat:discard-unsaved-reply'),
  'chat.getActiveTurnState': invokeMethod('chat:get-active-turn-state'),
  'chat.cancelStream': invokeMethod('chat:cancel-stream'),
  'chat.offerSteer': invokeMethod('chat:offer-steer'),
  'chat.withdrawSteer': invokeMethod('chat:withdraw-steer'),
  'chat.compactNow': invokeMethod('chat:compact-now'),
  'chat.firstSession': invokeMethod('chat:first-session'),
  'chat.hasPendingUserQuestions': invokeMethod('chat:has-pending-user-questions'),
  'chat.answerUserQuestions': invokeMethod('chat:answer-user-questions'),
  'chat.declineUserQuestions': invokeMethod('chat:decline-user-questions'),
  'chat.onStream': subscribeMethod('chat:stream'),
  'attachments.pick': invokeMethod('attachments:pick'),
  'attachments.prepare': invokeMethod('attachments:prepare'),
  'attachments.getPathForFile': localMethod('getPathForFile'),
  // Takes the dropped File objects (not path strings): the preload resolves
  // them with webUtils and sends only those paths, so a drop outside the
  // workspace attaches like a picker selection while the page itself can
  // never name a path (see JENNY_PRELOAD_INTERNAL_DESCRIPTORS).
  'attachments.prepareDroppedFiles': localMethod('prepareDroppedFiles'),
  'attachments.saveImageAsset': invokeMethod('attachments:save-image-asset'),
  'attachments.releaseAssets': invokeMethod('attachments:release-assets'),
  // spellcheck.*: composer spellcheck bridge (services/main/spellcheck-menu-bridge.js).
  // `params.misspelledWord` / `params.dictionarySuggestions` are reachable only
  // from the main-process `webContents.on('context-menu')` event, and Blink
  // emits that event only for an UNCANCELLED DOM contextmenu — a renderer
  // `preventDefault()` silently kills this whole surface.
  // onContext pushes ONLY that slice — { misspelled_word, dictionary_suggestions,
  // x, y }, snake_case wire keys — on every right-click, including a cleared
  // payload when nothing is misspelled so the renderer's bounded wait always
  // resolves. replaceMisspelling/addToDictionary are the two natively-owned
  // corrections; both validate a bounded (<=256 char) word and resolve
  // { ok, code } rather than throwing across the seam.
  'spellcheck.onContext': subscribeMethod('spellcheck:context'),
  'spellcheck.replaceMisspelling': invokeMethod('spellcheck:replace-misspelling'),
  'spellcheck.addToDictionary': invokeMethod('spellcheck:add-to-dictionary'),
  'clipboard.writeText': invokeMethod('clipboard:write-text'),
  // F4/F5/F6: save-file IPC for renderer-built content
  'dialog.saveFile': invokeMethod('dialog:save-file'),
  // backgroundJobs.*: visibility, kill, the output tail (live while running,
  // row 138) and Clear finished for backgrounded run_command jobs (W2-2).
  // Snapshots push over the bridge-event bus (main-workspace window only);
  // kill, readOutput and clearFinished are trusted-sender-authorized in
  // services/main/ipc-registration/workspace-ipc.js.
  // Live snapshots carry `serving` ({ url, host, port, sinceMs } or null): a loopback address the job printed that answers a TCP probe (row 176).
  'backgroundJobs.getState': invokeMethod('background-jobs:get-state'),
  'backgroundJobs.kill': invokeMethod('background-jobs:kill'),
  'backgroundJobs.readOutput': invokeMethod('background-jobs:read-output'),
  'backgroundJobs.clearFinished': invokeMethod('background-jobs:clear-finished'),
  'backgroundJobs.onChanged': subscribeMethod('background-jobs:changed'),
  // sketch.openFile: may a drawing's file node open this path? Checked against the session's own project root
  // (services/main/sketch-ipc-registration.js); resolves { ok, relativePath, line, projectId } or { ok: false, reason }.
  'sketch.openFile': invokeMethod('sketch:open-file'),
});
