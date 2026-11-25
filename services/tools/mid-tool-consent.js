'use strict';

// Tools that ask the user from inside their own execution, through the approval path the
// bridge hands them as `context.authorize`. A refusal returns to the tool, which reports it to
// the model; it never writes a terminal result that ends the call.
const MID_TOOL_CONSENT_TOOLS = new Set(['session_message', 'browser', 'computer']);
// Tools that wait on something other than the model (a build) and hold the turn's clocks while they do, through
// `context.suspendTurnClocks`. They ask nobody, so a declined card is recorded the ordinary way (row 197).
const TURN_CLOCK_TOOLS = new Set(['run_view_restart']);

module.exports = { MID_TOOL_CONSENT_TOOLS, TURN_CLOCK_TOOLS };
