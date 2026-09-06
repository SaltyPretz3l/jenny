'use strict';

const ledger = require('../../../config/plugins/stage7-budgets.json');

const limits = ledger.limits;
const VIEW_LIMITS = Object.freeze({
  max_message_utf8_bytes: limits.bridge_request_bytes,
  max_response_utf8_bytes: limits.bridge_response_bytes,
  max_depth: limits.bridge_depth,
  max_nodes: limits.bridge_nodes,
  max_object_keys: limits.bridge_object_keys,
  max_array_items: limits.bridge_array_items,
  max_messages_per_second: limits.bridge_messages_per_second,
  max_queue_length: limits.bridge_queue,
});

module.exports = Object.freeze({
  STAGE7_LIMITS: Object.freeze({ ...limits }),
  VIEW_LIMITS,
});
