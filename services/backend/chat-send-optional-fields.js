'use strict';

// The session-scoped optional fields of a managed chat.send, assembled in one
// place (extracted from managed-sidecar-chat.js, which sits at the line cap).
// Each builder returns {} when its field does not apply, so an absent field is
// omitted from the wire rather than sent as null.

const { buildApprovedPlanSendFields } = require('./approved-plan-context');
const { buildProposeSendFields } = require('./propose-mode');
const { PRIMARY_SESSION_ROLE, isPrimaryRole, primaryChatEnabled } = require('./primary-session');
const { activeUseRequestFields } = require('../workspace-active-use-tracker');

// Row 69: whether this turn is the profile's Jenny chat. The primary_chat kill
// switch (JENNY_ENABLE_PRIMARY_CHAT=0) turns every primary behaviour off, so the
// chat is then sent like any other.
function isPrimaryChatTurn(service, summary) {
  return primaryChatEnabled(service?.featureFlags) && isPrimaryRole(summary);
}

// The closed `session_role` field a chat.send carries for the primary chat (omitted for every other
// chat); the sidecar parses it onto ChatRequestContext.session_role.
function primaryChatRoleFields(service, summary) {
  return isPrimaryChatTurn(service, summary) ? { session_role: PRIMARY_SESSION_ROLE } : {};
}

// Owner D3: the safety policy captured with the turn (session runtime) or the
// live chatUi state rides every chat.send (omitted when unknown).
function safetyRequestFields(service, captured) {
  const chatUi = captured ? null : service?.configService?.getChatUiState?.();
  return captured ? { ...captured } : (chatUi ? { safety_mode: chatUi.safetyMode, auto_approve_streak_cap: chatUi.autoApproveStreakCap } : {});
}

function buildChatSendOptionalFields(service, {
  sessionId, sessionSummary, sessionMessages, planMode, workspaceRoot, safetyPolicy,
}) {
  return {
    ...activeUseRequestFields(service, workspaceRoot),
    ...buildApprovedPlanSendFields(planMode, sessionMessages),
    ...buildProposeSendFields(service, sessionId, sessionSummary),
    ...primaryChatRoleFields(service, sessionSummary),
    ...safetyRequestFields(service, safetyPolicy),
  };
}

module.exports = {
  buildChatSendOptionalFields,
  isPrimaryChatTurn,
  primaryChatRoleFields,
  safetyRequestFields,
};
