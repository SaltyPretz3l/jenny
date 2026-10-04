/* renderer/chat/renderer-render-pipeline-render-signatures.js
 * The two render signatures of the message renderer
 * (renderer-render-pipeline-message-renderer.js): the structural signature
 * over the raw source messages that gates the canonical-transcript and
 * thread-tree rebuild, and the ambient-UI signature folded into the message
 * render signature. Split out of the renderer at its 1015-line cap;
 * behaviour unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineRenderSignatures = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // #15: cheap structural signature over the RAW source messages, used to skip
  // the two heavy O(n) builds (canonical transcript + thread tree) when the
  // transcript STRUCTURE is unchanged. Settled content is excluded; STREAMING
  // messages contribute their content/reasoning growth (the delta commit
  // replaces the message object). The signature MUST capture every
  // projection-affecting field that changes by OBJECT REPLACEMENT, or the cached
  // canonical array serves a stale ref and suppresses the re-projection: the
  // tool lifecycle status (handleApprovalNeeded flips 'running' ->
  // 'pending_approval', which keys the approval_gap row; omitting it hid the live
  // approve/deny prompt) and `send_failure` (the user bubble's "Failed to send"
  // chip; omitting it left the chip stale). Keep this field set reconciled with
  // buildToolCall/ToolResultSignature.
  function buildSourceStructureSignature(list) {
    const messages = Array.isArray(list) ? list : [];
    const parts = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      const kind = String(message.kind || '');
      const status = String(message.status || '');
      const fields = [
        String(message.id || ''),
        String(message.role || ''),
        kind,
        status,
        String(message.finalizedAt || ''),
        String(message.timestamp || ''),
        String(message.model_used || ''),
        String(message.terminal_status || ''),
        String(message.runtime_status || ''),
        String(message.streamId || ''),
        String(message.parent_stream_id || ''),
        Array.isArray(message.phases) ? message.phases.length : 0,
        Array.isArray(message.reasoning_phases) ? message.reasoning_phases.length : 0,
        Array.isArray(message.tool_steps) ? message.tool_steps.length : 0,
        Array.isArray(message.attachments) ? message.attachments.length : 0,
        String((message.tool_call && message.tool_call.status) || ''),
        String((message.tool_result && message.tool_result.status) || ''),
        String((message.send_failure && message.send_failure.state) || ''),
        String(message.send_failure && message.send_failure.dismissed ? '1' : ''),
      ];
      // Streaming content/reasoning growth is deliberately NOT part of this
      // signature (CTL-012): growth frames are structure-stable cache HITS.
      // Object-replacement staleness is handled on the hit path by the
      // CTL-004 ref refresh (refreshCanonicalMessageRefs /
      // refreshCanonicalThreadTreeRefs), and the render decision rides the
      // fixed-size object-revision fingerprints, so every replacement delta
      // still paints without rebuilding the whole-transcript
      // canonical array + thread tree per token frame. Anti-freeze contract
      // pinned in tests/renderer-render-pipeline-settled-refresh.test.js.
      if (kind === 'interactive_round_recap' && message.interactive_round_recap) {
        fields.push(JSON.stringify(message.interactive_round_recap));
      }
      parts.push(fields.join('|'));
    }
    return parts.join('\n');
  }

  // `deps`: the renderer's state bag and its isPaneSelecting() predicate.
  // Returns buildAmbientUiSignature(paneSessionId).
  function createAmbientUiSignature(deps) {
    const { state = {}, isPaneSelecting = () => false } = deps || {};

    // Ambient UI state that article rendering reads (edit target, selection
    // mode + selected set) but that lives on state.ui, NOT on any message object,
    // so it is invisible to the content-only render fingerprints. Entering edit
    // swaps the user bubble for the inline editor (article-markup) and selection
    // mounts per-row handles/chrome — both only during a full markup build. The
    // controllers trigger these via a plain renderAll()/renderMessages() with no
    // force, so without folding this into messageRenderSignature the whole-
    // transcript no-op guard held on a settled timeline and the editor/handles
    // never mounted. Idle (no edit target, selection off) yields a stable empty
    // suffix, so this is byte-inert for untouched transcripts. Selection folds the
    // MEMBERSHIP (sorted ids), not just the size — deselect-A-then-select-B keeps
    // size 1 but must re-render the moved selected chrome.
    function buildAmbientUiSignature(paneSessionId) {
      const ui = (state && state.ui) || {};
      const editingId = String(ui.editingMessageId || '');
      const selectionActive = isPaneSelecting() === true;
      let selectedSignature = '';
      if (selectionActive && ui.selectedMessageIdsBySession
        && typeof ui.selectedMessageIdsBySession.get === 'function') {
        const set = ui.selectedMessageIdsBySession.get(paneSessionId);
        if (set && typeof set.forEach === 'function') {
          const ids = [];
          set.forEach((id) => { ids.push(String(id)); });
          ids.sort();
          selectedSignature = ids.join(',');
        }
      }
      return 'E:' + editingId + '\u001dB:' + (ui.branchCommitting === true ? '1' : '')
        + '\u001dS:' + (selectionActive ? '1' : '') + '\u001dSEL:' + selectedSignature;
    }

    return buildAmbientUiSignature;
  }

  return { buildSourceStructureSignature, createAmbientUiSignature };
});
