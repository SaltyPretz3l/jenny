'use strict';

// Provider-descriptor-facing name for the bounded pre-output auth retry. The
// Stage 7 descriptor allowlist contains only the ChatGPT subscription provider,
// so the frozen implementation remains the compatibility authority while the
// managed-chat caller no longer depends on a provider-specific module name.
const compatibility = require('./chatgpt-auth-turn-retry');

module.exports = {
  ...compatibility,
  isProviderAuthRejection: compatibility.isChatgptAuthRejection,
  sendManagedChatWithProviderAuthRetry: compatibility.sendManagedChatWithAuthRetry,
};
