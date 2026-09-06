(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(globalThis); return; }
  root.rendererMemorySettingsUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const MAX_RENDERED_MEMORIES = 200;
  const MAX_STATUS_REASONS = 8;
  const MAX_STATUS_REASON_INPUTS = 32;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function boundedCount(value, fallback = null) {
    return typeof value === 'number'
      && Number.isInteger(value)
      && value >= 0
      && value <= 1_000_000_000
      ? value
      : fallback;
  }

  function hasOwn(source, key) {
    return Object.prototype.hasOwnProperty.call(source, key);
  }

  function normalizeMemoryStatus(raw) {
    if (!isPlainObject(raw) || typeof raw.available !== 'boolean') return null;
    if (raw.counts !== undefined && !isPlainObject(raw.counts)) return null;
    if (raw.storage !== undefined && !isPlainObject(raw.storage)) return null;
    if (raw.degraded_reasons !== undefined && !Array.isArray(raw.degraded_reasons)) return null;
    const rawCounts = isPlainObject(raw.counts) ? raw.counts : {};
    const approved = boundedCount(rawCounts.approved);
    const pending = boundedCount(rawCounts.pending);
    if (raw.available && (approved === null || pending === null)) return null;
    const rawStorage = isPlainObject(raw.storage) ? raw.storage : {};
    for (const [source, key] of [
      [rawCounts, 'quarantined'],
      [rawStorage, 'physical_bytes'],
      [rawStorage, 'capacity_bytes'],
    ]) {
      if (hasOwn(source, key) && boundedCount(source[key]) === null) return null;
    }
    if (hasOwn(raw, 'schema_version') && raw.schema_version !== null && boundedCount(raw.schema_version) === null) return null;
    if (hasOwn(raw, 'recall_index') && typeof raw.recall_index !== 'string') return null;
    if (hasOwn(rawStorage, 'state')
      && (typeof rawStorage.state !== 'string' || !rawStorage.state.trim() || rawStorage.state.length > 40)) return null;
    const reasons = [];
    const rawReasons = Array.isArray(raw.degraded_reasons) ? raw.degraded_reasons : [];
    for (let index = 0; index < Math.min(rawReasons.length, MAX_STATUS_REASON_INPUTS); index += 1) {
      const rawReason = rawReasons[index];
      if (typeof rawReason !== 'string') return null;
      const reason = rawReason.trim().slice(0, 64);
      if (reason && !reasons.includes(reason)) reasons.push(reason);
      if (reasons.length >= MAX_STATUS_REASONS) break;
    }
    return {
      available: raw.available,
      schemaVersion: boundedCount(raw.schema_version),
      recallIndex: String(raw.recall_index || '').trim().slice(0, 40),
      counts: {
        approved,
        pending,
        quarantined: boundedCount(rawCounts.quarantined, 0),
      },
      storage: {
        state: String(rawStorage.state || 'unavailable').trim().slice(0, 40),
        physicalBytes: boundedCount(rawStorage.physical_bytes),
        capacityBytes: boundedCount(rawStorage.capacity_bytes),
      },
      preserved: raw.preserved === true,
      repairRequired: raw.repair_required === true,
      degradedReasons: reasons,
    };
  }

  function buildMemoryHealthMessages(status) {
    if (!status) return ['Memory health details are unavailable.'];
    const messages = [];
    for (const reason of status.degradedReasons) {
      if (reason === 'CMP-MEM-0008') {
        const count = status.counts.quarantined || 0;
        messages.push(`${count} memory ${count === 1 ? 'record needs' : 'records need'} review in Diagnostics.`);
      } else if (reason === 'CMP-MEM-0007') {
        const capacity = status.storage.capacityBytes;
        messages.push(capacity === null
          ? 'Memory storage has reached its capacity; open Diagnostics for repair guidance.'
          : `Memory storage has reached its ${Math.ceil(capacity / (1024 * 1024))} MB capacity.`);
      } else if (reason === 'recall_index_unavailable') {
        messages.push('Fast recall indexing is unavailable; bounded fallback recall remains active.');
      } else if (reason === 'recall_partial') {
        messages.push('The most recent recall completed with partial results.');
      } else {
        messages.push('Memory health needs attention; open Diagnostics for details.');
      }
    }
    if (!status.available && !messages.length) {
      messages.push(status.repairRequired
        ? 'Memory is unavailable and requires repair; open Diagnostics for guidance.'
        : 'Memory health details are unavailable.');
    } else if (!status.available && !messages.includes('Memory health details are unavailable.')) {
      messages.unshift('Memory health details are unavailable.');
    }
    return [...new Set(messages)];
  }

  function safeDomId(value) {
    const raw = String(value || 'unknown');
    const stem = raw.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 88) || 'unknown';
    let hash = 2166136261;
    for (let index = 0; index < raw.length; index += 1) {
      hash ^= raw.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${stem}-${(hash >>> 0).toString(36)}`;
  }

  function createMemorySettingsRenderer(deps) {
    const { state, escapeHtml = (value) => String(value || '') } = deps || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const actionButton = root.inventoryActionButton;
    const textField = root.inventoryTextField;
    const selectField = root.inventorySelectField;
    const toggleSwitch = root.inventoryToggleSwitch?.toggleSwitch;
    const badge = root.inventoryBadge;
    const collapsible = root.inventoryCollapsible || {};
    const settingsFoundation = root.rendererSettingsFoundation || {};
    const settingsSupport = root.rendererSettingsSupport || {};
    const kindOptions = Array.isArray(deps?.kindOptions) ? deps.kindOptions : [];
    const button = (options) => typeof actionButton === 'function' ? actionButton(options) : '';
    let scheduledPendingFocusKey = '';

    function captureControlFocus(dom) {
      const active = root.document?.activeElement;
      if (!active || !dom.memorySection?.contains(active)) return null;
      let selector = '';
      if (['memoryManagerSearchInput', 'memoryManagerKindFilter', 'pendingMemorySort'].includes(active.id)) {
        selector = `#${active.id}`;
      } else if (active.matches?.('[data-inv-toggle="memoryCaptureSuggestions"]')) {
        selector = '[data-inv-toggle="memoryCaptureSuggestions"]';
      }
      return selector ? {
        selector,
        selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      } : null;
    }

    function restoreControlFocus(dom, snapshot) {
      if (!snapshot) return;
      const control = dom.memorySection?.querySelector(snapshot.selector);
      if (!control || typeof control.focus !== 'function') return;
      try { control.focus({ preventScroll: true }); } catch (_error) { control.focus(); }
      if (snapshot.selectionStart !== null && typeof control.setSelectionRange === 'function') {
        control.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
      }
    }

    function renderControls(dom) {
      const focusSnapshot = captureControlFocus(dom);
      if (dom.memoryCapturePreferenceHost && typeof toggleSwitch === 'function') {
        dom.memoryCapturePreferenceHost.innerHTML = toggleSwitch({
          id: 'memoryCaptureSuggestions', label: 'Offer local memory suggestions',
          checked: state.features?.memory?.captureSuggestions !== false,
          description: 'At most one suggestion per completed turn; approval is always required.',
          descriptionId: 'memoryCaptureSuggestionsDescription',
        });
      }
      if (dom.pendingMemorySortHost && typeof selectField === 'function') {
        dom.pendingMemorySortHost.innerHTML = selectField({
          id: 'pendingMemorySort', label: 'Sort', value: state.memoryManager.pendingSort,
          options: [{ value: 'newest', label: 'Newest' }, { value: 'oldest', label: 'Oldest' }, { value: 'confidence', label: 'Highest confidence' }],
        });
      }
      if (dom.memoryKindFilterHost && typeof selectField === 'function') {
        dom.memoryKindFilterHost.innerHTML = selectField({ id: 'memoryManagerKindFilter', label: 'Kind', value: state.memoryManager.filter, options: kindOptions });
      }
      if (dom.memorySearchHost && typeof textField === 'function') {
        dom.memorySearchHost.innerHTML = textField({ id: 'memoryManagerSearchInput', label: 'Search', value: state.memoryManager.searchQuery, placeholder: 'Search approved memories', maxLength: 120 });
      }
      restoreControlFocus(dom, focusSnapshot);
    }

    function provenanceMarkup(memory, { allowRemove = false, identity = '' } = {}) {
      if (memory.provenance === 'source_removed') {
        return '<p class="memory-provenance memory-provenance--removed">Source removed; memory retained.</p>';
      }
      const excerpt = String(memory.source_excerpt || '').slice(0, 240);
      const session = String(memory.session_id || '').slice(0, 80);
      const date = String(memory.updated_at || memory.created_at || '').slice(0, 64);
      if (!excerpt && !session && !date) return '';
      const panelId = `memory-source-${safeDomId(identity || memory.id || memory.content_fingerprint)}`;
      const triggerText = `Source · ${date ? date.slice(0, 10) : 'Date unavailable'}`;
      const trigger = typeof collapsible.trigger === 'function'
        ? collapsible.trigger({ id: panelId, className: 'memory-provenance-trigger', children: escapeHtml(triggerText) })
        : '';
      const content = '<div class="memory-provenance-meta">'
        + `<span>${escapeHtml(date || 'Date unavailable')}</span>`
        + (session ? `<span>Session ${escapeHtml(session)}</span>` : '')
        + '</div>'
        + (excerpt ? `<q>${escapeHtml(excerpt)}</q>` : '')
        + (allowRemove ? button({ id: `remove-provenance-${safeDomId(memory.id)}`, label: 'Remove source', variant: 'ghost', size: 'sm', dataset: { 'memory-action': 'remove-provenance', 'memory-id': String(memory.id) } }) : '');
      const panel = typeof collapsible.content === 'function'
        ? collapsible.content({ id: panelId, className: 'memory-provenance-panel', children: content })
        : content;
      return `<div class="memory-provenance">${trigger}${panel}</div>`;
    }

    function kindBadge(kind) {
      const text = deps.getKindLabel(kind);
      return typeof badge === 'function'
        ? badge({ tone: 'muted', size: 'sm', text })
        : `<span>${escapeHtml(text)}</span>`;
    }

    function approvedMarkup(memory) {
      const editing = Number(state.memoryManager.editingMemoryId) === Number(memory.id);
      const pendingAction = state.memoryManager.pendingActionById.get(Number(memory.id)) || '';
      const title = deps.getFieldValue(memory, 'title');
      const lessonText = deps.getFieldValue(memory, 'lesson_text');
      const actions = editing
        ? button({ id: `save-memory-${memory.id}`, label: pendingAction === 'save' ? 'Saving…' : 'Save', variant: 'primary', disabled: Boolean(pendingAction) || !deps.hasDraftChanges(memory), dataset: { 'memory-action': 'save', 'memory-id': String(memory.id) } })
          + button({ id: `cancel-memory-${memory.id}`, label: 'Cancel', variant: 'ghost', disabled: Boolean(pendingAction), dataset: { 'memory-action': 'cancel', 'memory-id': String(memory.id) } })
        : button({ id: `edit-memory-${memory.id}`, label: 'Edit', variant: 'secondary', size: 'sm', dataset: { 'memory-action': 'edit', 'memory-id': String(memory.id) } })
          + button({ id: `delete-memory-${memory.id}`, label: pendingAction === 'delete' ? 'Deleting…' : 'Delete', variant: 'danger', size: 'sm', disabled: Boolean(pendingAction), dataset: { 'memory-action': 'delete', 'memory-id': String(memory.id) } });
      const body = editing && typeof textField === 'function'
        ? textField({ id: `memoryTitle${memory.id}`, label: 'Title', value: title, maxLength: 120, spellcheck: true, dataset: { 'memory-draft-field': 'title', 'memory-id': String(memory.id) } })
          + textField({ id: `memoryLesson${memory.id}`, label: 'Memory', value: lessonText, maxLength: 240, multiline: true, spellcheck: true, dataset: { 'memory-draft-field': 'lesson_text', 'memory-id': String(memory.id) } })
        : `<div class="memory-record-heading">${kindBadge(memory.lesson_kind)}<strong class="memory-record-title">${escapeHtml(memory.title)}</strong></div><p>${escapeHtml(memory.lesson_text)}</p>`;
      return `<article class="memory-record" role="listitem" data-memory-id="${memory.id}"><div class="memory-record-main">`
        + body + provenanceMarkup(memory, { allowRemove: true, identity: `approved-${memory.id}` })
        + `</div><div class="memory-record-actions">${actions}</div></article>`;
    }

    function pendingMarkup(candidate) {
      const key = deps.buildPendingKey(candidate.session_id, candidate.content_fingerprint);
      const pendingAction = state.memoryManager.pendingReviewActionByKey.get(key) || '';
      const identity = `pending-${key}`;
      return `<article class="memory-record" role="listitem" data-pending-memory-key="${escapeHtml(key)}"><div class="memory-record-main">`
        + `<div class="memory-record-heading">${kindBadge(candidate.lesson_kind)}<strong class="memory-record-title">${escapeHtml(candidate.title)}</strong></div><p>${escapeHtml(candidate.lesson_text)}</p>`
        + provenanceMarkup(candidate, { identity }) + `</div><div class="memory-record-actions">`
        + button({ id: `approve-${safeDomId(key)}`, label: pendingAction === 'approve' ? 'Approving…' : 'Approve', variant: 'primary', size: 'sm', disabled: Boolean(pendingAction), dataset: { 'pending-memory-action': 'approve', 'session-id': candidate.session_id, fingerprint: candidate.content_fingerprint } })
        + button({ id: `dismiss-${safeDomId(key)}`, label: pendingAction === 'discard' ? 'Dismissing…' : 'Dismiss', variant: 'ghost', size: 'sm', disabled: Boolean(pendingAction), dataset: { 'pending-memory-action': 'discard', 'session-id': candidate.session_id, fingerprint: candidate.content_fingerprint } })
        + '</div></article>';
    }

    function renderStatus(dom, approvedFallback, pendingFallback) {
      const snapshot = state.memoryManager.statusSnapshot;
      const statusUnavailable = state.memoryManager.statusUnavailable === true;
      const status = statusUnavailable && snapshot?.available === true ? null : snapshot;
      const countStatus = statusUnavailable ? null : status;
      const approved = countStatus?.counts.approved ?? approvedFallback;
      const pending = countStatus?.counts.pending ?? pendingFallback;
      if (dom.approvedMemoryCount) dom.approvedMemoryCount.textContent = String(approved);
      if (dom.pendingMemoryCount) dom.pendingMemoryCount.textContent = String(pending);
      const approvedUnavailable = state.memoryManager.unavailable === true;
      const pendingUnavailable = state.memoryManager.pendingUnavailable === true;
      const listUnavailable = approvedUnavailable || pendingUnavailable;
      const allListsUnavailable = approvedUnavailable && pendingUnavailable;
      const degraded = Boolean(status && (status.degradedReasons.length || status.repairRequired)) || listUnavailable;
      const loading = state.memoryManager.statusLoading === true && !state.memoryManager.statusLoaded;
      settingsFoundation.applyBadgeState?.(dom.memoryBadge, loading
        ? { state: 'loading', srLabel: 'Loading memory status' }
        : status?.available
          ? { state: degraded ? 'warn' : 'success', text: listUnavailable ? 'Partial' : `${approved} saved` }
          : { state: 'error', text: 'Unavailable' });
      const tone = status?.available && !allListsUnavailable ? (degraded ? 'warning' : 'success') : 'danger';
      const message = loading
        ? 'Loading memory status...'
        : allListsUnavailable
          ? 'Memory data is unavailable.'
          : `${approved} approved · ${pending} pending${listUnavailable ? ' · partially available' : status?.available ? '' : ' · health details unavailable'}`;
      if (typeof settingsSupport.renderStatusRowContainer === 'function') {
        settingsSupport.renderStatusRowContainer(dom.memorySummary, settingsSupport.buildSettingsSummaryModel({
          tone, label: 'Memory', message, badgeText: status?.available ? (degraded ? 'Degraded' : 'Ready') : 'Unavailable', spinner: loading,
        }), escapeHtml);
      } else if (dom.memorySummary) {
        dom.memorySummary.textContent = message;
      }
      const healthMessages = loading || (status?.available && !degraded) ? [] : buildMemoryHealthMessages(status);
      if (listUnavailable) healthMessages.push('Some memory records could not be loaded.');
      if (dom.memoryHealthNote) {
        dom.memoryHealthNote.hidden = healthMessages.length === 0;
        dom.memoryHealthNote.innerHTML = healthMessages.length
          ? `<ul class="memory-health-list" role="list">${healthMessages.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
          : '';
      }
    }

    function applyPendingFocus(dom) {
      const focusKey = String(state.memoryManager.pendingFocusKey || '');
      if (!focusKey
        || state.memoryManager.pendingFocusAppliedKey === focusKey
        || scheduledPendingFocusKey === focusKey
        || !dom.memorySection?.classList.contains('settings-section-active')
        || state.memoryManager.pendingLoading
        || !state.memoryManager.pendingLoaded) {
        return;
      }
      scheduledPendingFocusKey = focusKey;
      const schedule = typeof root.requestAnimationFrame === 'function'
        ? root.requestAnimationFrame.bind(root)
        : (callback) => callback();
      schedule(() => {
        if (typeof deps?.canFocus === 'function' && !deps.canFocus()) return;
        scheduledPendingFocusKey = '';
        if (state.memoryManager.pendingFocusKey !== focusKey
          || state.memoryManager.pendingFocusAppliedKey === focusKey
          || !dom.memorySection?.classList.contains('settings-section-active')) {
          return;
        }
        const target = [...(dom.pendingMemoryList?.querySelectorAll?.('[data-pending-memory-key]') || [])]
          .find((node) => node.dataset.pendingMemoryKey === focusKey)
          || dom.memoryPageHeading;
        if (!target || typeof target.focus !== 'function') return;
        target.tabIndex = -1;
        try { target.focus({ preventScroll: false }); } catch (_error) { target.focus(); }
        state.memoryManager.pendingFocusAppliedKey = focusKey;
      });
    }

    function renderMemoryPage() {
      const dom = getDom() || {};
      if (!dom.memorySection) return;
      renderControls(dom);
      const memories = Array.isArray(state.memoryManager.memories) ? state.memoryManager.memories : [];
      const query = String(state.memoryManager.searchQuery || '').trim().toLowerCase();
      const kind = String(state.memoryManager.filter || 'all');
      const filteredAll = memories.filter((memory) => (kind === 'all' || memory.lesson_kind === kind) && (!query || deps.searchText(memory).includes(query)));
      const pendingAll = deps.sortPending(state.memoryManager.pendingCandidates, state.memoryManager.pendingSort);
      const approvedLimit = Math.max(Number(state.memoryManager.approvedVisibleLimit) || MAX_RENDERED_MEMORIES, MAX_RENDERED_MEMORIES);
      const basePendingLimit = Math.max(Number(state.memoryManager.pendingVisibleLimit) || MAX_RENDERED_MEMORIES, MAX_RENDERED_MEMORIES);
      const pendingFocusIndex = pendingAll.findIndex((candidate) => (
        deps.buildPendingKey(candidate.session_id, candidate.content_fingerprint)
          === state.memoryManager.pendingFocusKey
      ));
      const pendingLimit = pendingFocusIndex >= basePendingLimit
        ? Math.ceil((pendingFocusIndex + 1) / MAX_RENDERED_MEMORIES) * MAX_RENDERED_MEMORIES
        : basePendingLimit;
      const filtered = filteredAll.slice(0, approvedLimit);
      const pending = pendingAll.slice(0, pendingLimit);
      renderStatus(dom, memories.length, pendingAll.length);
      if (dom.approvedMemoryStatus) dom.approvedMemoryStatus.textContent = state.memoryManager.loading ? 'Loading approved memories…' : state.memoryManager.unavailable ? state.memoryManager.status : memories.length && !filtered.length ? 'No approved memories match these filters.' : state.memoryManager.status;
      if (dom.pendingMemoryStatus) dom.pendingMemoryStatus.textContent = state.memoryManager.pendingLoading ? 'Loading pending review…' : state.memoryManager.pendingStatus;
      if (dom.approvedMemoryList) dom.approvedMemoryList.innerHTML = filtered.length ? filtered.map(approvedMarkup).join('') : '<div class="memory-page-empty" role="listitem">No approved memories to show.</div>';
      if (dom.pendingMemoryList) dom.pendingMemoryList.innerHTML = pending.length ? pending.map(pendingMarkup).join('') : '<div class="memory-page-empty" role="listitem">No pending candidates to review.</div>';
      if (dom.approvedMemoryMoreHost) dom.approvedMemoryMoreHost.innerHTML = filtered.length < filteredAll.length
        ? button({ id: 'show-more-approved-memories', label: `Show ${Math.min(MAX_RENDERED_MEMORIES, filteredAll.length - filtered.length)} more`, variant: 'secondary', dataset: { 'memory-page-action': 'show-more-approved' } }) : '';
      if (dom.pendingMemoryMoreHost) dom.pendingMemoryMoreHost.innerHTML = pending.length < pendingAll.length
        ? button({ id: 'show-more-pending-memories', label: `Show ${Math.min(MAX_RENDERED_MEMORIES, pendingAll.length - pending.length)} more`, variant: 'secondary', dataset: { 'memory-page-action': 'show-more-pending' } }) : '';
      applyPendingFocus(dom);
    }

    return { renderMemoryPage };
  }

  return {
    createMemorySettingsRenderer,
    normalizeMemoryStatus,
    buildMemoryHealthMessages,
    MAX_RENDERED_MEMORIES,
  };
});
