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
  'chat.compactNow': invokeMethod('chat:compact-now'),
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
  // backgroundJobs.*: visibility, kill and the finished-job output tail for
  // backgrounded run_command jobs (W2-2). Snapshots push over the bridge-event
  // bus (main-workspace window only); kill and readOutput are
  // trusted-sender-authorized in services/main/ipc-registration/workspace-ipc.js.
  'backgroundJobs.getState': invokeMethod('background-jobs:get-state'),
  'backgroundJobs.kill': invokeMethod('background-jobs:kill'),
  'backgroundJobs.readOutput': invokeMethod('background-jobs:read-output'),
  'backgroundJobs.onChanged': subscribeMethod('background-jobs:changed'),
});
