/**
 * One-shot main->renderer requests and the renderer's replies: the display
 * media picker, workspace presentation, app_view and terminal_run.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // displayMediaPicker.*: main-process getDisplayMedia source picker. onRequest
  // pushes the enumerated screen/window sources for the renderer picker UI;
  // onCancel fires if the request is superseded/aborted before a pick is made;
  // respond carries the user's pick (or null to cancel) back to the pending
  // session.setDisplayMediaRequestHandler callback.
  'displayMediaPicker.onRequest': subscribeMethod('display-media-picker:request'),
  'displayMediaPicker.onCancel': subscribeMethod('display-media-picker:cancel'),
  'displayMediaPicker.respond': invokeMethod('display-media-picker:respond'),
  // workspacePresentation.onRequest: ONE-SHOT main→renderer push from the
  // `workspace_present` builtin tool (services/workspace-presentation-service.js).
  // Deliberately a live event, never transcript metadata, so a presentation
  // request can never replay on reload/rehydrate. Emitted via sendBridgeEvent,
  // which is structurally main-workspace-window-only (secondary windows
  // never receive it). Payload: { view, path, request_id, source } —
  // snake_case wire keys, workspace-relative path only.
  'workspacePresentation.onRequest': subscribeMethod('workspace-presentation:request'),
  // workspacePresentation.reportOutcome: renderer→main report of what the IDE
  // did with one onRequest push ({ request_id, decision?, render?, detail?,
  // external_scripts?, external_stylesheets? }). Main accepts it only for
  // request ids it issued, behind the trusted-sender authorizer.
  'workspacePresentation.reportOutcome': invokeMethod('workspace-presentation:report-outcome'),
  // appView.* (row 94 P3): the `app_view` tool's ONE-SHOT main->renderer push ({ request_id, caller_session_id, action,
  // ...target }, services/app-view-service.js), the renderer's decision for it, and the renderer's current layout
  // (ids and booleans only) for app_view's `state`. Live events, never transcript metadata.
  'appView.onRequest': subscribeMethod('app-view:request'),
  'appView.reportOutcome': invokeMethod('app-view:report-outcome'),
  'appView.reportLayout': invokeMethod('app-view:report-layout'),
  // terminalTools.* (row 94 P4): `terminal_run`'s ONE-SHOT main->renderer push ({ request_id, command }, sent only
  // after the user approved that exact command, services/terminal-tools-service.js) and the renderer's report of the
  // terminal it used ({ request_id, ok, session_id?, reason? }).
  'terminalTools.onRunRequest': subscribeMethod('terminal-tools:run-request'),
  'terminalTools.reportRun': invokeMethod('terminal-tools:report-run'),
});
