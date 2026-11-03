'use strict';

// `chat_configure` (row 94 P1): move one chat to a project or set its model, reasoning effort or run mode. Always asks and is
// never always-allow (tool-permission-migrations.js); the sidecar shows the card even in Auto. Auto as a run mode
// is a permission change and is refused here, one layer above the port, because the preferences patch does not.
const { createChatManageTool } = require('./chat-manage-tool-support');

const forbiddenAuto = (action, value) => action === 'set_run_mode'
  && typeof value === 'string' && value.trim().toLowerCase() === 'auto';

module.exports = createChatManageTool({
  name: 'chat_configure', label: 'Chat: configure', method: 'configure',
  actions: ['move_to_project', 'set_model', 'set_effort', 'set_run_mode'], forbidden: forbiddenAuto,
});
