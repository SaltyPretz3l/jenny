'use strict';

// Test stand-in for the right stack that hosts the artifact panel in the real app
// (renderer/chat/renderer-chat-right-stack.js). The rail only tells its layout host what to show;
// this stub applies the panel's mode stamp and hidden state the way the stack does, so a test can
// drive the rail or the artifact manager without building a workbench. `presented` keeps every call.

function createPanelHostStub(options = {}) {
  const presented = [];
  const serves = typeof options.serves === 'function' ? options.serves : () => false;
  return {
    presented,
    serves,
    present(info) {
      presented.push(info);
      const { panel, visible, mode } = info;
      if (panel) {
        panel.classList.toggle('code-review-mode', mode === 'code_review');
        panel.dataset.artifactReviewMode = mode;
        panel.classList.toggle('hidden', !visible);
      }
      return true;
    },
  };
}

module.exports = { createPanelHostStub };
