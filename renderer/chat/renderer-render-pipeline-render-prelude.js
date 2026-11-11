/* renderer/chat/renderer-render-pipeline-render-prelude.js
 * What renderMessages settles before it picks a render lane: the timeline
 * environment (transcript view, root display flags), the follow-up gate and
 * the canonical transcript + thread tree cache. Split out of
 * renderer-render-pipeline-message-renderer.js, which composes it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineRenderPrelude = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // CTL-004: pure ref-refresh helpers for the #15 structural-signature cache
  // hit path below -- see renderer-render-pipeline-projection-cache.js for
  // the mechanism. Loaded the same way as the sibling UMD modules above so
  // it resolves off the already-loaded global in the browser (this module
  // loads after projection-cache.js in index.html) or via require() in Node.
  const projectionCacheRefreshUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineProjectionCacheUtils)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-projection-cache') : null)
    || {};
  function asFn(value, fallback) {
    return typeof value === 'function' ? value : fallback;
  }

  function createRenderPrelude(deps) {
    const {
      state,
      chatTimeline,
      uiRuntime,
      isSendBusy,
      isSendPreflightPending,
      buildSourceStructureSignature,
      buildCanonicalTranscriptMessages,
      buildTranscriptThreadTree,
      buildInteractiveRecapModel,
    } = deps;
    // CTL-004: refresh the #15 cache's object refs on a structural-signature
    // hit (see the call site below); fall back to identity if the sibling
    // module didn't resolve so a cache hit still degrades to "reuse as-is"
    // (the pre-fix behavior) rather than throwing.
    const refreshCanonicalMessageRefs = asFn(
      projectionCacheRefreshUtils.refreshCanonicalMessageRefs,
      (cachedMessages) => (Array.isArray(cachedMessages) ? cachedMessages : [])
    );
    const refreshCanonicalThreadTreeRefs = asFn(
      projectionCacheRefreshUtils.refreshCanonicalThreadTreeRefs,
      (threadTree) => threadTree
    );
    // Shared id-index builder so a cache hit indexes sourceMessages once for
    // both refreshes; null fallback makes each refresh build its own.
    const buildCanonicalMessageIdIndex = asFn(
      projectionCacheRefreshUtils.buildMessageIdIndex,
      () => null
    );

    function syncTimelineEnvironment(transcriptView, paneSessionId, forceFullRender) {
      // The pane's timeline carries the view for the stylesheet (per pane, not
      // per document: split view shows two sessions). Written only on change.
      if (chatTimeline.dataset && chatTimeline.dataset.transcriptView !== transcriptView) {
        const previousView = chatTimeline.dataset.transcriptView || '';
        chatTimeline.dataset.transcriptView = transcriptView;
        // Pane-scoped notice (cluster control, search overlay): a switch or a
        // pane session change, never a per-delta write.
        const EventCtor = chatTimeline.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
        if (typeof EventCtor === 'function') {
          chatTimeline.dispatchEvent(new EventCtor('transcript-view-rendered', {
            detail: { view: transcriptView, previousView, sessionId: paneSessionId },
          }));
        }
      }
      // A forced render wants fresh markup: settled roots cache message-keyed
      // HTML that cannot see ambient state (e.g. a materialized tool disclosure).
      if (forceFullRender) {
        uiRuntime.threadRootMarkupCache?.clear();
      }
      // Reflect shared display flags onto the root dataset so the pure row
      // builders read them without threading state through the whole render
      // pipeline. Per document only: per-pane state such as the transcript
      // view travels through render options instead.
      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        const featureFlags = state?.features?.featureFlags || state?.featureFlags || {};
        // chat_render_content_visibility (Ht-D) rides the dataset channel, but
        // OFF means the attribute is ABSENT (not 'false') so the CSS
        // attribute-selector rule in chat-thread.css is inert and markup
        // stays byte-identical pre-Ht-D — jsdom-pinnable per the design spec.
        if (featureFlags.chat_render_content_visibility === true) {
          if (document.documentElement.dataset.chatContentVisibility !== 'on') {
            document.documentElement.dataset.chatContentVisibility = 'on';
          }
        } else if (document.documentElement.dataset.chatContentVisibility !== undefined) {
          delete document.documentElement.dataset.chatContentVisibility;
        }
      }
    }

    function resolveFollowUpDisabledReason() {
      if (state.ui?.branchCommitting === true) {
        return jt('chat.messageRenderer.waitForBranch', 'Wait for the branch to finish before trying that.');
      }
      if (isSendBusy() || isSendPreflightPending()) {
        return jt('shell.fallback.waitForCurrentResponse', 'Wait for the current response to finish before trying that.');
      }
      if (!state.auth?.authenticated) {
        return jt('chat.messageRenderer.signInBeforeTrying', 'Sign in before trying that.');
      }
      // model_unavailable keeps follow-up actions live: regenerate /
      // edit-and-resend retry the model load, matching the composer gates
      // in renderer-render-pipeline-chrome.js and renderer-send-utils.js.
      if (!['ready', 'model_unavailable'].includes(String(state.backend?.phase || '').trim())) {
        return jt('chat.messageRenderer.waitForBackend', 'Wait for Jenny to finish connecting before trying that.');
      }
      return '';
    }

    function resolveCanonicalTranscript(sourceMessages, paneSessionId, forceFullRender) {
      // #15: reuse the canonical transcript + thread tree across renders whose
      // source structure is unchanged (text-streaming frames, chrome-only
      // renders, thread/recap toggles). Both builds are pure structural
      // transforms whose output arrays hold the live message refs, so cached
      // results stay content-current; the per-render fingerprints + structureHash
      // below still drive the actual render decision. forceFullRender bypasses
      // the cache.
      const sourceStructureSignature = paneSessionId
        + '\n#\n' + buildSourceStructureSignature(sourceMessages);
      let messages;
      let threadTree;
      if (
        !forceFullRender
        && uiRuntime.canonicalBuildSignature === sourceStructureSignature
        && Array.isArray(uiRuntime.cachedCanonicalMessages)
        && uiRuntime.cachedThreadTree
      ) {
        // CTL-004: a structural-signature match only guarantees STRUCTURE
        // parity (same ids, same order) -- it does NOT guarantee the cached
        // arrays' object refs are current, because every settled-content
        // update here is an OBJECT REPLACEMENT, not an in-place mutation.
        // Refresh both cached views to the CURRENT source objects by id
        // (cheap O(n), no rebuild) so the fingerprint pass below sees fresh
        // content instead of a frozen-in-time ref.
        const sourceMessageIdIndex = buildCanonicalMessageIdIndex(sourceMessages);
        messages = refreshCanonicalMessageRefs(
          uiRuntime.cachedCanonicalMessages, sourceMessages, sourceMessageIdIndex
        );
        threadTree = refreshCanonicalThreadTreeRefs(
          uiRuntime.cachedThreadTree, sourceMessages, sourceMessageIdIndex
        );
        uiRuntime.cachedCanonicalMessages = messages;
        uiRuntime.cachedThreadTree = threadTree;
      } else {
        messages = buildCanonicalTranscriptMessages(sourceMessages);
        threadTree = buildTranscriptThreadTree(messages, { buildInteractiveRecapViewModel: buildInteractiveRecapModel });
        uiRuntime.cachedCanonicalMessages = messages;
        uiRuntime.cachedThreadTree = threadTree;
        uiRuntime.canonicalBuildSignature = sourceStructureSignature;
      }
      return { messages, threadTree };
    }

    return { syncTimelineEnvironment, resolveFollowUpDisabledReason, resolveCanonicalTranscript };
  }

  return { createRenderPrelude };
});
