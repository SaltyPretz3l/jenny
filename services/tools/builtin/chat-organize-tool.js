'use strict';

// `chat_organize` (row 94 P1): rename, pin or archive one chat for the user. See chat-manage-tool-support.js.
const { createChatManageTool } = require('./chat-manage-tool-support');

module.exports = createChatManageTool({
  name: 'chat_organize', label: 'Chat: organize', method: 'organize',
  actions: ['rename', 'pin', 'unpin', 'archive', 'unarchive'],
});
