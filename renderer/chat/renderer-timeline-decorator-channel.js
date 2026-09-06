/* renderer/chat/renderer-timeline-decorator-channel.js */
/* Resolves the patched chat entry once per dispatch and shares one scope object with decorators; subscribers self-gate on the supplied flags. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTimelineDecoratorChannel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTimelineDecoratorChannel(options) {
    const opts = options || {};
    const chatTimeline = opts.chatTimeline || null;
    const subscribers = [];

    // Single patched-root resolver (promoted verbatim from
    // render-effects.resolvePatchedFollowUpRoot) so every subscriber shares one
    // querySelector instead of each resolving the same node.
    function resolvePatchedRoot(messageId) {
      const id = String(messageId || '').trim();
      if (!id || /["\\]/.test(id) || !chatTimeline || typeof chatTimeline.querySelector !== 'function') {
        return null;
      }
      try {
        return chatTimeline.querySelector('.chat-entry[data-message-id="' + id + '"]');
      } catch (_error) {
        return null;
      }
    }

    function subscribe(name, run) {
      if (typeof run !== 'function') {
        return function noopUnsubscribe() {};
      }
      const entry = { name: String(name || ''), run };
      subscribers.push(entry);
      return function unsubscribe() {
        const index = subscribers.indexOf(entry);
        if (index !== -1) {
          subscribers.splice(index, 1);
        }
      };
    }

    function dispatch(input) {
      const base = input || {};
      const patchedMessageId = String(base.patchedMessageId || '').trim();
      const scope = {
        root: chatTimeline,
        patchedMessageId,
        // Resolved exactly once here; shared by reference with every subscriber.
        patchedRoot: patchedMessageId ? resolvePatchedRoot(patchedMessageId) : null,
        fullRender: !patchedMessageId,
        decorateFollowUps: base.decorateFollowUps === true,
        syncViewport: base.syncViewport === true,
      };
      for (let i = 0; i < subscribers.length; i += 1) {
        subscribers[i].run(scope);
      }
      return scope;
    }

    return { subscribe, dispatch, resolvePatchedRoot };
  }

  return { createTimelineDecoratorChannel };
});
