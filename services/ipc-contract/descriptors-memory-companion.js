/**
 * Project memory, harness inspection, proactive reminders, companion
 * follow-ups and the off-transcript generators (suggestions, commit message,
 * handoff note).
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'memory.status': invokeMethod('memory:status'),
  'memory.save': invokeMethod('memory:save'),
  'memory.listApproved': invokeMethod('memory:list-approved'),
  'memory.listPending': invokeMethod('memory:list-pending'),
  'memory.update': invokeMethod('memory:update'),
  'memory.delete': invokeMethod('memory:delete'),
  'memory.deletePending': invokeMethod('memory:delete-pending'),
  // The chat chip's Undo: { sessionId, operationId } only; the project comes from the session.
  'memory.undo': invokeMethod('memory:undo'),
  'memory.acceptPending': invokeMethod('memory:accept-pending'),
  // The Settings Undo names the listed row's project (the chat chip's memory.undo takes a session).
  'memory.undoChange': invokeMethod('memory:undo-change'),
  // Settings > Memory page (row 58 W4): one `{ projectId, ... }` request each;
  // the project is the listed row's or tab's (null = every project where allowed).
  'memory.listArchived': invokeMethod('memory:list-archived'),
  'memory.restore': invokeMethod('memory:restore'),
  'memory.erase': invokeMethod('memory:erase'),
  'memory.clearForgotten': invokeMethod('memory:clear-forgotten'),
  'memory.listOperations': invokeMethod('memory:list-operations'),
  'memory.setAlwaysOn': invokeMethod('memory:set-always-on'),
  'memory.exportMarkdown': invokeMethod('memory:export-markdown'),
  // `{ name: 'USER.md' | 'MEMORY.md' }` only; opens in the OS default app.
  'memory.openContextFile': invokeMethod('memory:open-context-file'),
  'harness.inspect': invokeMethod('harness:inspect'),
  'proactive.getState': invokeMethod('proactive:get-state'),
  'proactive.chooseWorkspaceRoot': invokeMethod('proactive:choose-workspace-root'),
  'proactive.clearWorkspaceRoot': invokeMethod('proactive:clear-workspace-root'),
  'proactive.upsertReminder': invokeMethod('proactive:upsert-reminder'),
  'proactive.deleteReminder': invokeMethod('proactive:delete-reminder'),
  'companion.getState': invokeMethod('companion:get-state'),
  'companion.setMode': invokeMethod('companion:set-mode'),
  'companion.addFollowUp': invokeMethod('companion:add-follow-up'),
  'companion.updateFollowUp': invokeMethod('companion:update-follow-up'),
  'companion.deferFollowUp': invokeMethod('companion:defer-follow-up'),
  'companion.activateFollowUp': invokeMethod('companion:activate-follow-up'),
  'companion.resolveFollowUp': invokeMethod('companion:resolve-follow-up'),
  'companion.archiveFollowUp': invokeMethod('companion:archive-follow-up'),
  'companion.unarchiveFollowUp': invokeMethod('companion:unarchive-follow-up'),
  'companion.deleteFollowUp': invokeMethod('companion:delete-follow-up'),
  'suggestions.generate': invokeMethod('suggestions:generate'),
  // One-shot, off-transcript local-model commit-message generation from a
  // staged diff (Source Control panel "Write message"). Backed by the backend
  // service (sidecar), so the handler is registered with the auxiliary
  // backend-aware handlers, not the git-service-only workspaceGit block.
  'commit.generateMessage': invokeMethod('commit:generate-message'),
  // /handoff: an off-transcript handoff note drafted by the local model from
  // the chat's prepared history; resolves { ok, note | reason }, never throws.
  'handoff.generateNote': invokeMethod('handoff:generate-note'),
});
