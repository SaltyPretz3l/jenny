(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.chatThinkingUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _stringUtils = typeof globalThis !== 'undefined' && typeof globalThis.stringUtils !== 'undefined'
    ? globalThis.stringUtils
    : typeof require === 'function' ? require('../shared/string-utils')
    : null;
  if (!_stringUtils || typeof _stringUtils.stripInlineMarkdownLabel !== 'function') {
    throw new Error('chatThinkingUtils: renderer/shared/string-utils.js must load before this module');
  }
  const { stripInlineMarkdownLabel } = _stringUtils;

  const scrollUtils = (typeof globalThis !== 'undefined' && globalThis.chatScrollUtils)
    || (typeof require === 'function' ? require('./chat-scroll-utils') : null)
    || {};
  const DEFAULT_SCROLL_THRESHOLD = scrollUtils.DEFAULT_SCROLL_FOLLOW_THRESHOLD || 48;
  const PAUSE_REASON_READER_AWAY = 'reader_away';
  const PAUSE_REASON_REASONING_EXPANDED = 'reasoning_expanded';
  const LEADING_BLOCK_MARKER_RE = /^(?:#{1,6}|[-*+>])\s+/u;
  // A prettified body can open with a fence line or a one-word filler
  // paragraph ("Okay."); the header wants the first line that says something.
  const HEADER_SKIP_LINE_RE = /^(?:```|~~~|(?:okay|ok|hmm+|hm+|wait|alright|right|yes|no|well|so)[.!?,…]*$)/iu;

  function getReasoningEntries(message) {
    return message && message.reasoning && Array.isArray(message.reasoning.entries)
      ? message.reasoning.entries
      : [];
  }

  function getThinkingSummary(message) {
    const entries = getReasoningEntries(message);
    const latestEntry = entries[entries.length - 1];
    return latestEntry ? String(latestEntry.text || '') : '';
  }

  function getReasoningPhases(message) {
    return Array.isArray(message?.reasoning_phases) ? message.reasoning_phases : [];
  }

  function getReasoningPhaseField(phase, fieldName) {
    if (!phase || typeof phase !== 'object') {
      return '';
    }
    const snakeCaseFieldName = String(fieldName || '')
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase();
    return phase[fieldName] != null ? phase[fieldName] : phase[snakeCaseFieldName];
  }

  function isRenderableReasoningPhase(message, phase) {
    if (String(getReasoningPhaseField(phase, 'phaseKind')).trim() !== 'reasoning') {
      return false;
    }
    if (String(getReasoningPhaseField(phase, 'summary')).trim()) {
      return true;
    }
    const thinkingId = String(getReasoningPhaseField(phase, 'thinkingId')).trim();
    if (
      thinkingId
      && getReasoningEntries(message).some(
        (entry) => String(entry?.thinkingId || entry?.thinking_id || '').trim() === thinkingId
      )
    ) {
      return true;
    }
    return String(message?.status || '').trim() === 'streaming'
      && getReasoningPhaseField(phase, 'completed') !== true;
  }

  function getReasoningPhaseIdentity(phase) {
    return {
      phaseId: String(getReasoningPhaseField(phase, 'phaseId') || '').trim(),
      thinkingId: String(getReasoningPhaseField(phase, 'thinkingId') || '').trim(),
    };
  }

  function countThinkingIds(phases) {
    const counts = new Map();
    for (const phase of phases) {
      const { thinkingId } = getReasoningPhaseIdentity(phase);
      if (!thinkingId) continue;
      counts.set(thinkingId, (counts.get(thinkingId) || 0) + 1);
    }
    return counts;
  }

  function getReasoningPhaseKey(phase, thinkingIdCounts, index) {
    const { phaseId, thinkingId } = getReasoningPhaseIdentity(phase);
    if (thinkingId && (thinkingIdCounts.get(thinkingId) || 0) <= 1) {
      return thinkingId;
    }
    return phaseId || (thinkingId ? `${thinkingId}:${index + 1}` : `phase_${index + 1}`);
  }

  function getRenderableReasoningPhaseGroups(message) {
    const phases = getReasoningPhases(message)
      .filter((phase) => isRenderableReasoningPhase(message, phase));
    const thinkingIdCounts = countThinkingIds(phases);
    return phases
      .map((phase, index) => ({
        ...getReasoningPhaseIdentity(phase),
        phaseKey: getReasoningPhaseKey(phase, thinkingIdCounts, index),
        entries: [],
      }));
  }

  function shouldShowThinkingToggle(message) {
    if (!message || message.role !== 'assistant') {
      return false;
    }

    const hasEntries = getReasoningEntries(message).length > 0;
    if (hasEntries && String(message.reasoning?.source || '') === 'provider') {
      return true;
    }
    return getRenderableReasoningPhaseGroups(message).length > 0;
  }

  /**
   * Index of `reasoning` phases by stable phase keys, used by both renderers
   * to look up phase metadata (iteration, summary, tokens_per_second, etc.).
   */
  function groupReasoningPhaseMetadata(message) {
    const phases = getReasoningPhases(message)
      .filter((phase) => String(getReasoningPhaseField(phase, 'phaseKind')).trim() === 'reasoning');
    const thinkingIdCounts = countThinkingIds(phases);
    const byPhaseKey = new Map();
    for (let i = 0; i < phases.length; i += 1) {
      const phase = phases[i];
      const { phaseId, thinkingId } = getReasoningPhaseIdentity(phase);
      const phaseKey = getReasoningPhaseKey(phase, thinkingIdCounts, i);
      const keys = [phaseKey, phaseId, thinkingId].filter(Boolean);
      if (!phaseId && !thinkingId) {
        keys.push('');
      }
      for (const key of keys) {
        const storedPhase = byPhaseKey.get(key);
        const incomingPhaseIsLive = getReasoningPhaseField(phase, 'completed') !== true;
        if (
          !storedPhase
          || (
            getReasoningPhaseField(storedPhase, 'completed') === true
            && incomingPhaseIsLive
          )
        ) {
          byPhaseKey.set(key, phase);
        }
      }
    }
    return byPhaseKey;
  }

  // Optional dependency: repairs whitespace-starved thinking text at display
  // time. Soft fallback keeps harnesses that never
  // load the script on the raw join path.
  const _prettifyUtils = (typeof globalThis !== 'undefined' && globalThis.reasoningPrettifyUtils)
    || (typeof require === 'function' ? require('./reasoning-prettify-utils') : null)
    || {};
  const prettifyReasoningMarkdown = typeof _prettifyUtils.prettifyReasoningMarkdown === 'function'
    ? _prettifyUtils.prettifyReasoningMarkdown
    : null;
  const isProseBoundary = typeof _prettifyUtils.isProseBoundary === 'function'
    ? _prettifyUtils.isProseBoundary
    : () => false;
  const PRETTIFY_CACHE_LIMIT = 64;
  const prettifyCache = new Map();

  function getCachedPrettifiedEntry(cacheKey) {
    const cached = prettifyCache.get(cacheKey);
    if (cached) {
      prettifyCache.delete(cacheKey);
      prettifyCache.set(cacheKey, cached);
    }
    return cached;
  }

  function setCachedPrettifiedEntry(cacheKey, rawText, prettified) {
    prettifyCache.delete(cacheKey);
    prettifyCache.set(cacheKey, { rawText, prettified });
    if (prettifyCache.size > PRETTIFY_CACHE_LIMIT) {
      prettifyCache.delete(prettifyCache.keys().next().value);
    }
  }

  function prettifyReasoningEntry(rawText, cacheKey) {
    const cached = getCachedPrettifiedEntry(cacheKey);
    if (cached?.rawText === rawText) return cached.prettified;

    let prettified = '';
    const isStrictAppend = cached?.rawText
      && rawText.length > cached.rawText.length
      && rawText.startsWith(cached.rawText);
    const rawBoundary = isStrictAppend ? cached.rawText.lastIndexOf('\n\n') : -1;
    // Safety is judged with the prettifier's own code segmentation: the prefix
    // must end outside code with balanced quotes in its trailing prose segment.
    if (rawBoundary >= 0 && isProseBoundary(cached.rawText.slice(0, rawBoundary))) {
      const remainderStart = rawBoundary + 2;
      // Prettify rules are block-local past a paragraph break, so the text
      // after the last \n\n can be repaired standalone. The leading break
      // makes the standalone remainder judge sparseness the way the full
      // text does (formatted, not a newline-free wall).
      const prettifyRemainder = (text) => prettifyReasoningMarkdown(`\n\n${text}`).replace(/^\n+/, '');
      const previousRemainder = prettifyRemainder(cached.rawText.slice(remainderStart));
      if (cached.prettified.endsWith(previousRemainder)) {
        const prettifiedPrefix = previousRemainder
          ? cached.prettified.slice(0, -previousRemainder.length)
          : cached.prettified;
        prettified = prettifiedPrefix + prettifyRemainder(rawText.slice(remainderStart));
      }
    }
    if (!prettified) prettified = prettifyReasoningMarkdown(rawText);
    setCachedPrettifiedEntry(cacheKey, rawText, prettified);
    return prettified;
  }

  /**
   * Concatenate reasoning entries into the markdown body string used by both
   * the v1 thinking panel and the v2 reasoning row.
   */
  function joinReasoningEntriesMarkdown(entries, options) {
    const prettify = prettifyReasoningMarkdown;
    return (Array.isArray(entries) ? entries : [])
      .map((entry, index) => ({
        cacheKey: typeof options?.scope === 'string'
          ? `${options.scope}::${String(entry?.id || '').trim() || index}`
          : String(entry?.id || '').trim() || index,
        rawText: String(entry?.text || '').trim(),
      }))
      .filter(({ rawText }) => Boolean(rawText))
      .map(({ cacheKey, rawText }) => (prettify
        ? prettifyReasoningEntry(rawText, cacheKey)
        : rawText))
      .join('\n\n')
      .trim();
  }

  /**
   * Derive a short summary line from reasoning entries.  Matches the v1
   * behavior: walk all lines from the start until we find one with actual
   * word content (skipping bare quotes/punctuation that some reasoning models
   * emit as the opening token), strip leading markdown list/heading markers,
   * cap at 120 chars.
   */
  function summaryFromEntries(entries, fallback = 'Reasoning') {
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      const text = String(entry?.text || '').trim();
      if (!text) continue;
      const lines = text.split(/\r?\n/u);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (!/\p{L}|\p{N}/u.test(line)) continue;
        if (HEADER_SKIP_LINE_RE.test(line) && lines.length > 1) continue;
        const cleaned = line.replace(LEADING_BLOCK_MARKER_RE, '');
        if (cleaned) return cleaned.slice(0, 120);
      }
    }
    return fallback;
  }

  /**
   * Flatten markdown decoration out of a one-line reasoning label. GPT-style
   * reasoning summaries lead with a bold title (`**Testing sandbox**`) which
   * the plain-text row header would otherwise show verbatim. Reasoning-surface
   * name for the shared conservative flattener — see stringUtils
   * .stripInlineMarkdownLabel for the identifier-preservation rules.
   */
  function markdownToPlainReasoningLabel(text) {
    return stripInlineMarkdownLabel(text);
  }

  /**
   * Group reasoning entries by their thinkingId into sequential phases.
   * Entries without a thinkingId are grouped into a single default phase.
   * Returns Array<{ thinkingId: string, entries: Entry[] }>.
   */
  function groupReasoningByPhase(entries) {
    if (!Array.isArray(entries) || !entries.length) {
      return [];
    }
    const groups = [];
    let currentGroup = null;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const tid = String(entry && entry.thinkingId || '');
      if (!currentGroup || currentGroup.thinkingId !== tid) {
        currentGroup = { thinkingId: tid, entries: [] };
        groups.push(currentGroup);
      }
      currentGroup.entries.push(entry);
    }
    return groups;
  }

  class ThinkingPanelController {
    constructor() {
      this.bottomThreshold = DEFAULT_SCROLL_THRESHOLD;
      this.phaseExpansionState = new Map();
      // 2026-08-29: the viewport attribution latch owns reader scroll intent;
      // this pause covers historical expansion, so live-tail phases are exempt.
      this.followExemptPhaseKeys = new Set();
      this.autoScrollPauseReasons = new Set();
      this.reasoningExpansionPauseSuppressed = false;
      // Compatibility surface for the one historical direct assignment.
      // New code should use pauseAutoScroll()/resumeAutoScroll().
      Object.defineProperty(this, 'autoScrollPaused', {
        configurable: true,
        enumerable: true,
        get: () => this.autoScrollPauseReasons.size > 0,
        set: (paused) => {
          if (paused) this.pauseAutoScroll(PAUSE_REASON_REASONING_EXPANDED);
          else this.resumeAutoScroll();
        },
      });
    }

    pauseAutoScroll(reason = PAUSE_REASON_REASONING_EXPANDED) {
      const normalizedReason = String(reason || PAUSE_REASON_REASONING_EXPANDED);
      if (normalizedReason === PAUSE_REASON_REASONING_EXPANDED) {
        this.reasoningExpansionPauseSuppressed = false;
      }
      this.autoScrollPauseReasons.add(normalizedReason);
    }

    resumeAutoScroll(reason) {
      if (reason === undefined) {
        this.autoScrollPauseReasons.clear();
        // Sending or activating a chat explicitly follows the next turn even
        // when an older disclosure remains open. A later deliberate reasoning
        // interaction restores the expansion pause.
        this.reasoningExpansionPauseSuppressed = true;
        return;
      }
      this.autoScrollPauseReasons.delete(String(reason || ''));
    }

    syncReasoningExpansionPause({ userInitiated = false } = {}) {
      if (userInitiated) this.reasoningExpansionPauseSuppressed = false;
      for (const key of [...this.followExemptPhaseKeys]) {
        if (this.phaseExpansionState.get(key) !== true) this.followExemptPhaseKeys.delete(key);
      }
      const hasExpandedPhase = Array.from(this.phaseExpansionState.entries()).some(
        ([key, expanded]) => expanded === true && !this.followExemptPhaseKeys.has(key)
      );
      if (hasExpandedPhase && !this.reasoningExpansionPauseSuppressed) {
        this.pauseAutoScroll(PAUSE_REASON_REASONING_EXPANDED);
      }
      else this.resumeAutoScroll(PAUSE_REASON_REASONING_EXPANDED);
      return hasExpandedPhase;
    }

    /** Check if a specific phase is expanded (composite key). */
    isPhaseExpanded(messageId, thinkingId, defaultExpanded = false) {
      const key = _phaseKey(messageId, thinkingId);
      if (!key) {
        return defaultExpanded === true;
      }
      if (this.phaseExpansionState.has(key)) {
        return this.phaseExpansionState.get(key) === true;
      }
      return defaultExpanded === true;
    }

    /** Toggle a specific phase. Returns true if now expanded. */
    togglePhaseExpanded(messageId, thinkingId, defaultExpanded = false, options = {}) {
      const key = _phaseKey(messageId, thinkingId);
      if (!key) {
        return false;
      }
      const nextExpanded = !this.isPhaseExpanded(messageId, thinkingId, defaultExpanded);
      this.phaseExpansionState.set(key, nextExpanded);
      if (nextExpanded && options.liveStreamingTail === true) {
        this.followExemptPhaseKeys.add(key);
      } else if (!nextExpanded) {
        this.followExemptPhaseKeys.delete(key);
      }
      this.syncReasoningExpansionPause({ userInitiated: true });
      return nextExpanded;
    }

    /** Legacy: check if ANY phase of a message is expanded. */
    isExpanded(messageId) {
      const prefix = String(messageId || '') + '::';
      for (const [key, expanded] of this.phaseExpansionState.entries()) {
        if (expanded === true && (key.startsWith(prefix) || key === String(messageId || ''))) {
          return true;
        }
      }
      return false;
    }

    /** Legacy: toggle using message-only key (for backward compat). */
    toggleExpanded(messageId) {
      const normalizedMessageId = String(messageId || '');
      if (!normalizedMessageId) {
        return false;
      }
      if (this.isExpanded(normalizedMessageId)) {
        this.clearExpanded(normalizedMessageId);
        return false;
      }
      return this.togglePhaseExpanded(normalizedMessageId, '');
    }

    clearExpanded(messageId) {
      const normalizedMessageId = String(messageId || '');
      if (!normalizedMessageId) {
        return false;
      }
      const prefix = `${normalizedMessageId}::`;
      let removed = false;
      for (const key of [...this.phaseExpansionState.keys()]) {
        if (key.startsWith(prefix) || key === normalizedMessageId) {
          this.phaseExpansionState.delete(key);
          removed = true;
        }
      }
      for (const key of [...this.followExemptPhaseKeys]) {
        if (key.startsWith(prefix) || key === normalizedMessageId) {
          this.followExemptPhaseKeys.delete(key);
        }
      }
      this.syncReasoningExpansionPause({ userInitiated: true });
      return removed;
    }

    prune(activeMessageIds) {
      const activeIds = new Set((Array.isArray(activeMessageIds) ? activeMessageIds : []).map(String));
      for (const key of [...this.phaseExpansionState.keys()]) {
        const msgId = key.split('::')[0];
        if (!activeIds.has(msgId)) {
          this.phaseExpansionState.delete(key);
        }
      }
      for (const key of [...this.followExemptPhaseKeys]) {
        const msgId = key.split('::')[0];
        if (!activeIds.has(msgId)) {
          this.followExemptPhaseKeys.delete(key);
        }
      }
      this.syncReasoningExpansionPause();
    }

    handleScroll(metrics) {
      const scrollTop = Number(metrics && metrics.scrollTop) || 0;
      const scrollHeight = Number(metrics && metrics.scrollHeight) || 0;
      const clientHeight = Number(metrics && metrics.clientHeight) || 0;
      const nearBottom = scrollHeight - (scrollTop + clientHeight) <= this.bottomThreshold;
      if (nearBottom) this.resumeAutoScroll(PAUSE_REASON_READER_AWAY);
      else this.pauseAutoScroll(PAUSE_REASON_READER_AWAY);
      return nearBottom;
    }

    shouldAutoScroll() {
      return this.autoScrollPauseReasons.size === 0;
    }

    /**
     * True while the timeline reader has scrolled away from the live edge
     * (the `reader_away` pause set by handleScroll and cleared when follow
     * re-latches). The live reasoning window reads it to stop eliding text
     * above a detached reader (HB-024).
     */
    isReaderAway() {
      return this.autoScrollPauseReasons.has(PAUSE_REASON_READER_AWAY);
    }

    /**
     * Drop every live-tail follow exemption. A transcript view switch is a
     * deliberate reasoning interaction (2026-08-29 review fix); its caller is
     * the switch's `announceChange`, after `resetSessionOverrides`. After it,
     * an expanded phase — live tail included — pauses auto-scroll again.
     */
    clearFollowExemptions() {
      this.followExemptPhaseKeys.clear();
    }

    autoCollapseAll() {
      this.phaseExpansionState.clear();
      this.followExemptPhaseKeys.clear();
      this.reasoningExpansionPauseSuppressed = false;
      this.resumeAutoScroll(PAUSE_REASON_REASONING_EXPANDED);
    }

    getPhaseToggleA11y(messageId, thinkingId, expanded) {
      const panelId = `reasoning-panel-${String(messageId || '')}-${String(thinkingId || 'default')}`;
      return {
        panelId,
        ariaControls: panelId,
        ariaExpanded: expanded ? 'true' : 'false',
      };
    }
  }

  function _phaseKey(messageId, thinkingId) {
    return `${String(messageId || '')}::${String(thinkingId || '')}`;
  }

  function clearLiveReasoningShimmer(chatTimeline) {
    if (!chatTimeline) return;
    const shimmerMains = chatTimeline.querySelectorAll('.reasoning-row-main.shimmer-active');
    shimmerMains.forEach((node) => {
      node.classList.remove('shimmer-active');
    });
  }

  // Resolves which reasoning row a LIVE status label may write to. Scoped to
  // the active message's article when an id is supplied (thinking ids can
  // repeat across settled messages); within the scope the LAST streaming row
  // wins, else the last match — never the timeline-wide first match, which is
  // how live labels used to land on an earlier settled row.
  function resolveLiveReasoningStatusRow(chatTimeline, options) {
    const { thinkingId, activeMessageId, escapeSelectorValue } = options || {};
    if (!chatTimeline || !thinkingId) return null;
    const esc = typeof escapeSelectorValue === 'function'
      ? escapeSelectorValue
      : (value) => String(value || '');
    const selector = `.reasoning-row-block[data-thinking-id="${esc(thinkingId)}"]`;
    const normalizedActiveMessageId = String(activeMessageId || '').trim();
    const activeMessage = normalizedActiveMessageId
      ? chatTimeline.querySelector(
        `.chat-entry[data-message-id="${esc(normalizedActiveMessageId)}"]`
      )
      : null;
    const matches = (activeMessage || chatTimeline).querySelectorAll(selector);
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (matches[index].getAttribute('data-reasoning-status') === 'streaming') {
        return matches[index];
      }
    }
    return matches[matches.length - 1] || null;
  }

  function syncLiveReasoningStatusLabel(chatTimeline, options = {}) {
    const { thinkingText, thinkingId } = options;
    const el = resolveLiveReasoningStatusRow(chatTimeline, options);
    if (!el || !thinkingId) return;
    const cleanedText = String(thinkingText || '').trim();
    const iterMatch = cleanedText.match(/^Starting iteration (\d+)\/(\d+)/);
    if (iterMatch) {
      if (el.getAttribute('data-reasoning-iteration') !== iterMatch[1]) {
        el.setAttribute('data-reasoning-iteration', iterMatch[1]);
      }
      return;
    }
    const main = el.querySelector('.reasoning-row-main');
    if (!main || !cleanedText) return;
    // Live deltas use the same plain-text heading grammar as settled rows.
    const labelText = markdownToPlainReasoningLabel(cleanedText);
    if (!labelText) return;
    if (main.textContent !== labelText) main.textContent = labelText;
    if (!main.classList.contains('shimmer-active')) main.classList.add('shimmer-active');
  }

  return {
    syncLiveReasoningStatusLabel,
    clearLiveReasoningShimmer,
    ThinkingPanelController,
    getReasoningEntries,
    getThinkingSummary,
    groupReasoningByPhase,
    groupReasoningPhaseMetadata,
    getRenderableReasoningPhaseGroups,
    joinReasoningEntriesMarkdown,
    markdownToPlainReasoningLabel,
    resolveLiveReasoningStatusRow,
    shouldShowThinkingToggle,
    summaryFromEntries,
  };
});
