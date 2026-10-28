'use strict';

// Live approvals of commands and writes carry the exact presentation the backend builds
// (services/backend/chat-stream-tool-approval.js); a card without one fails closed. Fixtures
// that model a live approval build it the same way instead of hand-writing the object.
const { buildExactApprovalPresentation } = require('../../services/backend/chat-stream-tool-approval');

function exactApprovalFor(toolName, input = {}) {
  return buildExactApprovalPresentation(toolName, input);
}

// A live `tool_approval_needed` / `tool_use` event with the exact presentation attached.
function withExactApproval(event) {
  const exact = exactApprovalFor(event.toolName, event.input || {});
  return exact ? { ...event, exact_approval: exact } : { ...event };
}

// A renderer pending-approval entry as handleApprovalNeeded stores it for a live request.
function livePendingApproval(entry) {
  const exact = exactApprovalFor(entry.toolName, entry.input || {});
  return exact ? { ...entry, exactApproval: exact } : { ...entry };
}

module.exports = { exactApprovalFor, livePendingApproval, withExactApproval };
