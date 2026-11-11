'use strict';

// Tools that ask the user from inside their own execution, through the approval path the
// bridge hands them as `context.authorize`. A refusal returns to the tool, which reports it to
// the model; it never writes a terminal result that ends the call.
const MID_TOOL_CONSENT_TOOLS = new Set(['session_message', 'browser']);

module.exports = { MID_TOOL_CONSENT_TOOLS };
