'use strict';

const { APPLICATION_TURN_AUTO_RESUME, isUnattendedApplicationTurn } = require('../../backend/application-turns');
const { peekToolLookupMessages } = require('../../backend/chat-stream-tool-payload-utils');

/**
 * Whether nobody typed the turn this call belongs to (a wake, a scheduled check, a digest). The
 * turn's anchor is the newest user row. Such a turn may close the chat's page and nothing else,
 * so a message from another chat can free a page but never drive one. A transcript that cannot
 * be read counts as unattended, which only leaves close.
 */
function isUnattendedTurn(context, sessionId) {
  try {
    const messages = peekToolLookupMessages(context.backendService, sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user' || message.kind) continue;
      // A resume carries on the turn before it, so it is whatever that turn was.
      if (message.application_turn !== APPLICATION_TURN_AUTO_RESUME) return isUnattendedApplicationTurn(message.application_turn);
    }
    return false;
  } catch (_error) {
    return true;
  }
}

module.exports = { isUnattendedTurn };
