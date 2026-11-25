'use strict';

// The shape of a lease request (row 123, slice 4a-1). Pure: no state, no clock. Split out of the
// scheduler facade, which is at its size ceiling.

const { isId } = require('../ids');
const { isPrintable, normalizeAllowedNodes } = require('./state');

// The request normalized, or null when any field is not acceptable.
function readLeaseRequest(input, limits) {
  if (!input || typeof input !== 'object') return null;
  const { conversationKey, memberId, model, wantsVision, retryAnyway = false } = input;
  const allowedNodes = normalizeAllowedNodes(input.allowedNodes, limits);
  if (!isPrintable(conversationKey, limits.maxConversationKeyLength) || !isId('member', memberId)) return null;
  if (!isPrintable(model, limits.maxModelIdLength) || typeof wantsVision !== 'boolean') return null;
  if (typeof retryAnyway !== 'boolean' || allowedNodes === undefined) return null;
  return { conversationKey, memberId, model, wantsVision, retryAnyway, allowedNodes };
}

module.exports = { readLeaseRequest };
