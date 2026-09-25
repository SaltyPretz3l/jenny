'use strict';
function quotaState(calls = []) {
  return { schema_version: 1, enabled: true,
    policy: { web_per_turn: 2, code_per_turn: 2, session_calls: 20, cooldown_ms: 30000 },
    session_baseline: 3, admissions: calls.map(call => ({ call_id: call.call_id, tool_id: call.tool_id,
      arguments_sha256: 'a'.repeat(64), web: call.tool_id === 'web_search',
      code: call.tool_id === 'code_search', web_refunded: false })),
    cooldowns: { schema_version: 1, namespace: 'tool_quota', captured_at_ms: 100000, entries: [] } };
}
module.exports = { quotaState };
