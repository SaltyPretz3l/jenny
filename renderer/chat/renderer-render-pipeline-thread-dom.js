/* renderer/chat/renderer-render-pipeline-thread-dom.js
 * Owns recursive thread DOM rendering and the rail measurement/observer
 * lifecycle. buildArticle is supplied per call to avoid a compile-time
 * article-markup dependency.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
root.rendererRenderPipelineThreadDomUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const timelineOrientationUtils = (typeof globalThis !== 'undefined' && globalThis.rendererChatTimelineOrientationUtils)
    || (typeof require === 'function' ? require('./renderer-chat-timeline-orientation-utils') : null)
    || {};
  const buildTimeDividerMarkup = typeof timelineOrientationUtils.buildTimeDividerMarkup === 'function'
    ? timelineOrientationUtils.buildTimeDividerMarkup
    : function fallbackBuildTimeDividerMarkup() { return ''; };

  function createThreadDomPipeline(deps) {
    const {
      state = {},
      dom = {},
      callbacks = {},
    } = deps || {};
    const { chatTimeline = null } = dom;
    const {
      escapeHtml = (value) => String(value || ''),
      shouldShowThreadToggle = () => false,
      isThreadBranchOpen = () => true,
      appendClientLog = () => {},
    } = callbacks;

    function toThreadDomIdToken(value) {
      const normalized = String(value || '').trim();
      return Array.from(normalized, (character) => character.codePointAt(0).toString(16)).join('-');
    }

    function buildThreadToggleMarkup(node, expanded, childContainerId) {
      if (!shouldShowThreadToggle(node)) {
        return '';
      }
      const childCount = Array.isArray(node.children) ? node.children.length : 0;
      const summaryLabel = `${expanded ? 'Collapse' : 'Expand'} ${childCount} nested item${childCount === 1 ? '' : 's'}`;
      return `
        <button
          class="chat-thread-toggle"
          type="button"
          data-thread-toggle="${escapeHtml(node.id)}"
          aria-expanded="${expanded ? 'true' : 'false'}"
          aria-controls="${escapeHtml(childContainerId)}"
          aria-label="${escapeHtml(summaryLabel)}"
          title="${escapeHtml(summaryLabel)}"
        >
          <span class="chat-thread-toggle-count" aria-hidden="true">${escapeHtml(String(childCount))}</span>
        </button>
      `;
    }

    function renderThreadChildren(nodes, depth, sessionId, forcedOpenIds, buildArticle, renderOptions) {
      const childNodes = Array.isArray(nodes) ? nodes : [];
      if (!childNodes.length) {
        return '';
      }
      return childNodes.map(function renderChildNode(node) {
        return renderThreadNode(node, depth, sessionId, forcedOpenIds, buildArticle, renderOptions);
      }).join('');
    }

    // Finding 3: settled-root markup memoization key. Walks node + every
    // descendant collecting the subtree's content fingerprints, expansion
    // bits, and divider labels, then folds in the session-global fields
    // (computed once per renderThreadTree call by the caller and passed
    // through renderOptions.sessionGlobals unchanged at every depth). Pure
    // — no DOM reads, no side effects — so it's safe to call speculatively
    // before deciding whether a cache hit is possible.
    function collectRootMarkupKeyParts(node, sessionId, forcedOpenIds, renderOptions, parts) {
      if (!node || !node.message) {
        return;
      }
      const messageId = String(node.id || node.message?.id || '').trim();
      const messageFingerprintById = renderOptions && renderOptions.messageFingerprintById;
      const contentFingerprint = messageFingerprintById && typeof messageFingerprintById.get === 'function'
        ? String(messageFingerprintById.get(messageId) || '')
        : '';
      const canToggle = shouldShowThreadToggle(node);
      const expanded = !canToggle || isThreadBranchOpen(node, sessionId, forcedOpenIds);
      const dividerByMessageId = renderOptions && renderOptions.dividerByMessageId;
      const divider = dividerByMessageId && typeof dividerByMessageId.get === 'function'
        ? dividerByMessageId.get(messageId)
        : null;
      const dividerLabel = divider ? `${String(divider.label || '')}|${String(divider.ariaLabel || '')}` : '';
      parts.push(`${messageId}:${contentFingerprint}:${canToggle ? (expanded ? '1' : '0') : 'x'}:${dividerLabel}`);
      const children = Array.isArray(node.children) ? node.children : [];
      for (let index = 0; index < children.length; index += 1) {
        collectRootMarkupKeyParts(children[index], sessionId, forcedOpenIds, renderOptions, parts);
      }
    }

    function computeRootMarkupKey(node, sessionId, forcedOpenIds, renderOptions) {
      const parts = [];
      collectRootMarkupKeyParts(node, sessionId, forcedOpenIds, renderOptions, parts);
      const sessionGlobals = (renderOptions && renderOptions.sessionGlobals) || {};
      const globalParts = [
        String(sessionGlobals.sessionId || ''),
        String(sessionGlobals.latestReplyAssistantMessageId || ''),
        String(sessionGlobals.followUpDisabledReason || ''),
        String(sessionGlobals.regenerateRequestFingerprint || ''),
        // Review fix: the latest settled turn's phase flips to review_artifact
        // when the split review panel is visible; fold the bool so a toggle
        // busts the key (false in the common case -> no key perturbation).
        sessionGlobals.artifactReviewVisible ? 'ar1' : 'ar0',
      ];
      return globalParts.join('|') + '|' + parts.join('|');
    }

    function renderThreadNode(node, depth, sessionId, forcedOpenIds, buildArticle, renderOptions) {
      if (!node || !node.message) {
        return '';
      }
      const normalizedDepth = Math.max(0, Number(depth) || 0);
      const nodeId = String(node.id || node.message?.id || '').trim();

      // Finding 3: root-level-only memoization tier. Never memoize the
      // active/streaming root — it is rebuilt fresh every full render (as
      // before) so its content is never one render stale. Settled roots
      // reuse a cached HTML string keyed on every markup-affecting input;
      // a key mismatch (content/expansion/divider/session-global change)
      // falls straight through to the normal build-fresh path below.
      const markupCache = renderOptions && renderOptions.markupCache;
      // Review fix (memo-key completeness): a root subject to an ambient UI
      // mode the content key does not capture must never be memoized, or it is
      // served stale when that mode changes.
      //  - selectionModeActive: every root grows selection chrome -> suspend
      //    the whole cache this render.
      //  - editingMessageId (a USER root id): that root swaps its bubble for
      //    the inline editor -> exclude just that root.
      const selectionModeActive = Boolean(renderOptions && renderOptions.selectionModeActive === true);
      const editingMessageId = String((renderOptions && renderOptions.editingMessageId) || '');
      const isMemoEligibleRoot = normalizedDepth === 0
        && markupCache
        && !selectionModeActive
        && nodeId
        && nodeId !== String((renderOptions && renderOptions.activeTurnRootMessageId) || '')
        && nodeId !== editingMessageId;
      let rootMarkupKey = '';
      if (isMemoEligibleRoot) {
        rootMarkupKey = computeRootMarkupKey(node, sessionId, forcedOpenIds, renderOptions);
        const cached = markupCache.get(nodeId);
        if (cached && cached.key === rootMarkupKey) {
          return cached.html;
        }
      }

      const articleHtml = buildArticle(node.message);
      if (!articleHtml) {
        return '';
      }
      const resultHtml = buildThreadNodeMarkup(node, normalizedDepth, sessionId, forcedOpenIds, buildArticle, renderOptions, articleHtml);
      if (isMemoEligibleRoot) {
        markupCache.set(nodeId, { key: rootMarkupKey, html: resultHtml });
      }
      return resultHtml;
    }

    function buildThreadNodeMarkup(node, normalizedDepth, sessionId, forcedOpenIds, buildArticle, renderOptions, articleHtml) {
      const role = String(node.role || '').trim();
      const parentId = String(node.parentId || '').trim();
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const isToolParent = node.kind === 'tool_use' && hasChildren;
      const canToggle = shouldShowThreadToggle(node);
      const expanded = !canToggle || isThreadBranchOpen(node, sessionId, forcedOpenIds);
      const childContainerId = `thread-children-${toThreadDomIdToken(node.id) || 'default'}`;
      const childRenderOptions = renderOptions?.suppressOwnLeadingDivider === true
        ? { ...renderOptions, suppressOwnLeadingDivider: false }
        : renderOptions;
      const childrenMarkup = hasChildren && expanded
        ? renderThreadChildren(node.children, normalizedDepth + 1, sessionId, forcedOpenIds, buildArticle, childRenderOptions)
        : '';
      const dividerByMessageId = renderOptions && renderOptions.dividerByMessageId;
      const divider = dividerByMessageId && typeof dividerByMessageId.get === 'function'
        ? dividerByMessageId.get(String(node.id || node.message?.id || '').trim())
        : null;
      // Compat anchors paint nothing; their coalesced row list owns the divider.
      const dividerMarkup = divider
        && renderOptions?.suppressOwnLeadingDivider !== true
        && articleHtml.indexOf('data-thread-compat-anchor="true"') === -1
        ? buildTimeDividerMarkup(divider, { escapeHtml })
        : '';
      // Envelope-sibling compat nodes render no visible article of their own
      // (the coalesced turn article carries the content). When the rendered
      // subtree below holds no real <article> either, a collapse toggle would
      // control nothing visible — drop it so it cannot strand a bright toggle
      // dot below the coalesced turn. Only decided while expanded: a collapsed
      // node renders empty childrenMarkup, which must not be read as "nothing
      // visible" or the expand control for real content would vanish.
      const compatOnlySubtree = expanded
        && articleHtml.indexOf('data-thread-compat-enveloped="true"') !== -1
        && childrenMarkup.indexOf('<article') === -1;

      if (!parentId && role === 'user') {
        return dividerMarkup + `
          <div
            class="chat-thread-node chat-thread-root chat-thread-root-user"
            data-thread-depth="${normalizedDepth}"
            data-thread-parent=""
            data-thread-message-id="${escapeHtml(node.id)}"
            data-thread-collapsed="false"
          >
            ${articleHtml}
            ${
              hasChildren
                ? `
                  <div
                    class="chat-thread-children"
                    id="${escapeHtml(childContainerId)}"
                    data-thread-depth="${normalizedDepth + 1}"
                    data-thread-parent="${escapeHtml(node.id)}"
                    data-thread-collapsed="false"
                  >
                    ${childrenMarkup}
                  </div>
                `
                : ''
            }
          </div>
        `;
      }

      const nodeKind = node.kind === 'tool_use'
        ? (String(node.message?.tool_call?.status || '') === 'pending_approval' ? 'tool-pending' : 'tool')
        : node.kind === 'interactive_round_recap' ? 'interactive'
        : node.kind === 'proactive_suggestion' ? 'proactive'
        : node.kind === 'slash_command_output' ? 'slash-output'
        : 'response';

      return dividerMarkup + `
        <div
          class="chat-thread-node ${parentId ? 'chat-thread-node-nested' : 'chat-thread-root chat-thread-root-assistant'}${isToolParent ? ' chat-thread-node-tool-parent' : ''}"
          data-thread-depth="${normalizedDepth}"
          data-thread-parent="${escapeHtml(parentId)}"
          data-thread-message-id="${escapeHtml(node.id)}"
          data-thread-collapsed="${canToggle && !expanded ? 'true' : 'false'}"
          data-thread-node-kind="${nodeKind}"
        >
          <div class="chat-thread-node-row">
            ${compatOnlySubtree ? '' : buildThreadToggleMarkup(node, expanded, childContainerId)}
            <div class="chat-thread-node-article">
              ${articleHtml}
            </div>
          </div>
          ${
            hasChildren
              ? `
                <div
                  class="chat-thread-children"
                  id="${escapeHtml(childContainerId)}"
                  data-thread-depth="${normalizedDepth + 1}"
                  data-thread-parent="${escapeHtml(node.id)}"
                  data-thread-collapsed="${canToggle && !expanded ? 'true' : 'false'}"
                  ${canToggle && !expanded ? 'hidden' : ''}
                >
                  ${childrenMarkup}
                </div>
              `
              : ''
          }
        </div>
      `;
    }

    function renderThreadTree(threadTree, sessionId, forcedOpenIds, buildArticle, renderOptions) {
      const roots = Array.isArray(threadTree?.roots) ? threadTree.roots : [];
      const html = roots.map(function renderRootNode(node) {
        return renderThreadNode(node, 0, sessionId, forcedOpenIds, buildArticle, renderOptions);
      }).join('');
      // Finding 3: bound the markup cache to the roots actually rendered
      // this pass — a root that scrolled out of the transcript (rare;
      // history is only ever appended/regenerated, not trimmed mid-session)
      // must not linger forever.
      const markupCache = renderOptions && renderOptions.markupCache;
      if (markupCache && typeof markupCache.forEach === 'function') {
        const liveRootIds = new Set(roots.map((node) => String(node?.id || '').trim()).filter(Boolean));
        const staleRootIds = [];
        markupCache.forEach(function collectStaleRootId(_entry, rootId) {
          if (!liveRootIds.has(rootId)) {
            staleRootIds.push(rootId);
          }
        });
        for (let index = 0; index < staleRootIds.length; index += 1) {
          markupCache.delete(staleRootIds[index]);
        }
      }
      return html;
    }

    /**
     * Measure dot positions, centre each dot with its primary content
     * landmark, and set --_rail-top / --_rail-height on each thread root
     * so the CSS rail line spans from the first dot to the last.
     */
    const _dotLandmarkSelector =
      '.reasoning-row-block, .reasoning-row-header, .tool-call-header, .chat-bubble, .interactive-card, .proactive-suggestion-block, .slash-command-output';

    // B2: small timer-based debounce around the ResizeObserver-driven rail
    // measurement. Streaming + expand/collapse oscillation can fire the
    // observer every frame; a plain rAF guard coalesces only adjacent
    // frames, which isn't enough. 80 ms ≈ 5 frames @ 60 Hz — short enough
    // that the rail still visibly tracks a manual window-resize drag,
    // long enough that bursts of layout-driven fires collapse to one
    // measurement.
    const RAIL_RESIZE_DEBOUNCE_MS = 80;

    let _railResizeObserver = null;
    let _railResizeRafId = 0;
    let _railResizeDebounceTimer = 0;
    const _dirtyRailRoots = new Set();
    const MAX_RAIL_MEASUREMENT_WARNINGS = 3;
    let _railMeasurementWarningCount = 0;

    let _disposed = false;

    function cancelPendingRailResizeRaf() {
      if (_railResizeRafId) {
        // AGENTS.md §5 (async lifecycle safety): a pending rAF must be
        // cancelled before a new observer is wired up or the pipeline is
        // torn down, or the next tick mutates DOM that may already be
        // detached or owned by a fresh pipeline instance.
        globalThis.cancelAnimationFrame(_railResizeRafId);
        _railResizeRafId = 0;
      }
    }

    function cancelPendingRailResizeDebounce() {
      if (_railResizeDebounceTimer) {
        // Symmetric with cancelPendingRailResizeRaf: a queued debounce
        // timer must not fire against a stale root set after dispose or
        // reattach.
        globalThis.clearTimeout(_railResizeDebounceTimer);
        _railResizeDebounceTimer = 0;
      }
    }

    function isMountedRailRoot(root) {
      if (!root || !chatTimeline) return false;
      if (typeof root.matches === 'function' && !root.matches('.chat-thread-root')) return false;
      if (typeof chatTimeline.contains === 'function' && !chatTimeline.contains(root)) return false;
      return true;
    }

    function enqueueRailRoot(target) {
      const candidate = target?.target || target;
      const root = typeof candidate?.matches !== 'function'
        ? candidate
        : candidate.matches('.chat-thread-root')
          ? candidate
          : candidate.closest?.('.chat-thread-root');
      if (!isMountedRailRoot(root)) {
        return false;
      }
      _dirtyRailRoots.add(root);
      return true;
    }

    function enqueueRailRoots(targets) {
      if (targets === undefined || targets === null) {
        const roots = chatTimeline?.querySelectorAll?.('.chat-thread-root') || [];
        for (const root of roots) enqueueRailRoot(root);
        return;
      }
      const isIterable = typeof targets !== 'string' && typeof targets?.[Symbol.iterator] === 'function';
      const candidates = isIterable ? targets : [targets];
      for (const candidate of candidates) enqueueRailRoot(candidate);
    }

    function takeDirtyRailRoots() {
      const roots = [];
      for (const root of _dirtyRailRoots) {
        if (isMountedRailRoot(root)) roots.push(root);
      }
      _dirtyRailRoots.clear();
      return roots;
    }

    function readStyleProperty(style, propertyName) {
      return typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue(propertyName)
        : style._props?.get?.(propertyName) || '';
    }

    function writeStylePropertyIfChanged(style, propertyName, value) {
      const currentValue = readStyleProperty(style, propertyName);
      if (currentValue !== value) {
        if (typeof style.setProperty === 'function') {
          style.setProperty(propertyName, value);
        } else if (propertyName === 'top') {
          style.top = value;
        }
      }
    }

    function warnRailMeasurementFailure(phase, error) {
      if (_railMeasurementWarningCount >= MAX_RAIL_MEASUREMENT_WARNINGS) return;
      _railMeasurementWarningCount += 1;
      const normalizedPhase = phase === 'write' ? 'write' : 'read';
      const errorName = String(error?.name || 'Error')
        .replace(/[^A-Za-z0-9_$.-]/g, '')
        .slice(0, 64) || 'Error';
      appendClientLog('WARN', 'chat.thread_rail_measurement_failed', {
        phase: normalizedPhase,
        errorName,
        occurrence: _railMeasurementWarningCount,
        suppressed: _railMeasurementWarningCount === MAX_RAIL_MEASUREMENT_WARNINGS,
      });
    }

    function scheduleRailResizeUpdate(targets) {
      if (_disposed) return;
      enqueueRailRoots(targets);
      if (_dirtyRailRoots.size === 0) return;
      cancelPendingRailResizeDebounce();
      _railResizeDebounceTimer = globalThis.setTimeout(function onDebounceExpire() {
        _railResizeDebounceTimer = 0;
        if (_disposed) return;
        if (_railResizeRafId) return;
        _railResizeRafId = globalThis.requestAnimationFrame(function railResizeTick() {
          _railResizeRafId = 0;
          if (_disposed) return;
          updateThreadRailExtents(takeDirtyRailRoots());
        });
      }, RAIL_RESIZE_DEBOUNCE_MS);
    }

    /**
     * Finding 2: synchronous first-paint rail measurement. The full-render
     * path calls this directly (no 80 ms debounce, no rAF) so
     * --_rail-top/--_rail-height are set before the browser paints —
     * eliminating the CSS-default height:0 -> snap window. The debounced
     * scheduleRailResizeUpdate above is unchanged and keeps handling
     * subsequent ResizeObserver-driven resizes.
     */
    function measureThreadRailExtentsNow() {
      if (_disposed) return;
      if (!chatTimeline) return;
      enqueueRailRoots();
      updateThreadRailExtents(takeDirtyRailRoots());
    }

    function updateThreadRailExtents(rootsToMeasure) {
      if (_disposed) return;
      if (!chatTimeline) return;
      const roots = rootsToMeasure === undefined
        ? Array.from(chatTimeline.querySelectorAll('.chat-thread-root'))
        : Array.from(rootsToMeasure || []).filter(isMountedRailRoot);

      // B1: split into a single read+compute pass followed by a single
      // write pass. Previously the per-root loop wrote `dot.style.top`
      // (Phase 1) immediately before re-reading getBoundingClientRect on
      // the next row/landmark/dot, forcing a synchronous layout each
      // iteration. Deferring all writes until measurements are done
      // eliminates that thrash.
      const plans = [];
      for (const root of roots) {
        try {
        const rootRect = root.getBoundingClientRect();
        const dotCenters = [];
        const dotWrites = [];

        /* Phase 1: toggle buttons — JS-positioned to first content landmark.
           Response nodes top-align; all other kinds centre-align. */
        const toggleDots = root.querySelectorAll('.chat-thread-toggle');
        for (let i = 0; i < toggleDots.length; i++) {
          const dot = toggleDots[i];
          if (dot.offsetParent === null) continue;
          const row = dot.closest('.chat-thread-node-row');
          if (!row) continue;
          const article = row.querySelector('.chat-thread-node-article');
          const landmark = article
            ? article.querySelector(_dotLandmarkSelector)
            : null;

          if (landmark) {
            const threadNode = dot.closest('.chat-thread-node');
            const nodeKind = threadNode ? threadNode.dataset.threadNodeKind : '';
            const rowRect = row.getBoundingClientRect();
            const lmRect = landmark.getBoundingClientRect();
            const dotHalf = dot.offsetHeight / 2;

            if (nodeKind === 'response') {
              /* Top-align: dot centre sits at landmark top edge. */
              const lmTop = lmRect.top - rowRect.top;
              dotWrites.push({ dot, top: Math.round(lmTop) });
              dotCenters.push(lmRect.top + dotHalf - rootRect.top);
            } else {
              /* Centre-align (tool, interactive, etc.) */
              const lmCenter = lmRect.top + lmRect.height / 2 - rowRect.top;
              dotWrites.push({ dot, top: Math.round(lmCenter - dotHalf) });
              dotCenters.push(lmRect.top + lmRect.height / 2 - rootRect.top);
            }
          } else {
            dotWrites.push({ dot, top: null });
            const dotRect = dot.getBoundingClientRect();
            dotCenters.push(dotRect.top + dotRect.height / 2 - rootRect.top);
          }
        }

        /* Phase 2: per-row dots — CSS-positioned, measure only. */
        const rowDots = root.querySelectorAll(
          '.chat-thread-node-nested .chat-thread-node-article .chat-row .chat-row-node-dot'
        );
        for (let j = 0; j < rowDots.length; j++) {
          const dot = rowDots[j];
          if (dot.offsetParent === null) continue;
          const dotRect = dot.getBoundingClientRect();
          /* Belt-and-suspenders: skip if CSS still hides it (display:none guard). */
          if (dotRect.width === 0 && dotRect.height === 0) continue;
          dotCenters.push(dotRect.top + dotRect.height / 2 - rootRect.top);
        }

        /* Sort ascending — the two passes may interleave vertically across
           different nesting depths, so sorting gives the true top/bottom. */
        dotCenters.sort(function (a, b) { return a - b; });

        plans.push({ root, dotWrites, dotCenters });
        } catch (error) {
          warnRailMeasurementFailure('read', error);
        }
      }

      // Write pass: every DOM mutation happens after every measurement.
      for (let p = 0; p < plans.length; p++) {
        try {
          const plan = plans[p];
          for (let w = 0; w < plan.dotWrites.length; w++) {
            const write = plan.dotWrites[w];
            if (write.top === null) {
              if (write.dot.style.top) write.dot.style.removeProperty('top');
            } else {
              writeStylePropertyIfChanged(write.dot.style, 'top', write.top + 'px');
            }
          }
          if (plan.dotCenters.length < 2) {
            writeStylePropertyIfChanged(plan.root.style, '--_rail-height', '0px');
            if (readStyleProperty(plan.root.style, '--_rail-top')) {
              plan.root.style.removeProperty('--_rail-top');
            }
            continue;
          }
          const firstCenter = plan.dotCenters[0];
          const lastCenter = plan.dotCenters[plan.dotCenters.length - 1];
          writeStylePropertyIfChanged(plan.root.style, '--_rail-top', Math.round(firstCenter) + 'px');
          writeStylePropertyIfChanged(
            plan.root.style,
            '--_rail-height',
            Math.round(Math.max(0, lastCenter - firstCenter)) + 'px'
          );
        } catch (error) {
          warnRailMeasurementFailure('write', error);
        }
      }
    }

    /**
     * Attach a ResizeObserver to each thread root so expanding/collapsing
     * thinking panels or tool details automatically re-measures the rail.
     */
    function attachRailResizeObserver() {
      if (_disposed) return;
      if (_railResizeObserver) _railResizeObserver.disconnect();
      // A rAF or debounce timer queued by the previous observer may still
      // fire after the disconnect above and call updateThreadRailExtents
      // on an outdated root set. Cancel both before wiring the new
      // observer.
      cancelPendingRailResizeRaf();
      cancelPendingRailResizeDebounce();
      _dirtyRailRoots.clear();
      if (!chatTimeline) return;
      _railResizeObserver = new ResizeObserver(scheduleRailResizeUpdate);
      var roots = chatTimeline.querySelectorAll('.chat-thread-root');
      for (var k = 0; k < roots.length; k++) {
        _railResizeObserver.observe(roots[k]);
      }
      syncTimelineBusyState();
    }

    function refreshRailRootObservation(nextRoot, previousRoot) {
      if (_disposed || !_railResizeObserver) return;
      if (previousRoot && previousRoot !== nextRoot) {
        _railResizeObserver.unobserve?.(previousRoot);
        _dirtyRailRoots.delete(previousRoot);
      }
      if (!isMountedRailRoot(nextRoot)) return;
      _railResizeObserver.observe(nextRoot);
      scheduleRailResizeUpdate(nextRoot);
    }

    /**
     * E4: keep the role="log" timeline container's aria-busy state in sync
     * with the presence of any in-flight streaming bubble. Screen readers
     * honour aria-busy on a live container to suppress "items added"
     * announcements while the timeline is updating.
     */
    function syncTimelineBusyState() {
      if (!chatTimeline) return;
      var nextValue = chatTimeline.querySelector('.chat-bubble-streaming') ? 'true' : 'false';
      if (chatTimeline.getAttribute('aria-busy') !== nextValue) {
        chatTimeline.setAttribute('aria-busy', nextValue);
      }
    }

    function dispose() {
      if (_disposed) return;
      _disposed = true;
      cancelPendingRailResizeRaf();
      cancelPendingRailResizeDebounce();
      _dirtyRailRoots.clear();
      if (_railResizeObserver) {
        _railResizeObserver.disconnect();
        _railResizeObserver = null;
      }
    }

    return {
      renderThreadTree,
      renderThreadNode,
      computeRootMarkupKey,
      updateThreadRailExtents,
      measureThreadRailExtentsNow,
      scheduleRailResizeUpdate,
      attachRailResizeObserver,
      refreshRailRootObservation,
      syncTimelineBusyState,
      dispose,
    };
  }

  return { createThreadDomPipeline };
});
