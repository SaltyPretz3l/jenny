/* Home ask mini-composer config: the model trigger + panel that let an ask
 * start its chat with an explicit model / reasoning effort / tool set instead
 * of whatever the last chat happened to leave behind. Three contracts drive it:
 *  - The draft is renderer-local and DELIBERATELY not persisted (same call as
 *    the artifact wrap toggle); the manager applies it exactly once, to the
 *    session an ask starts.
 *  - It lives inside the built-once `.home-info-strip__ask` region (W13: on
 *    the ask line's own `.home-ask__meta` row), so the manager's 30s clock
 *    repaint — which rewrites the strip chrome via innerHTML — cannot eat a
 *    half-configured draft any more than a half-typed question.
 *  - The panel is NEVER rebuilt while it is open. A rebuild wipes every
 *    control the user is touching, and their focus with it; the two paths that
 *    used to do it (a model catalog resolving, and the 30s sync re-seeding an
 *    untouched draft) now reseed the live controls in place instead.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardAskConfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const CHIP_DOM_ID = 'homeAskConfigChip';
  const POPOVER_DOM_ID = 'homeAskConfigPopover';
  const MODEL_FIELD_ID = 'homeAskConfigModel';
  const EFFORT_FIELD_ID = 'homeAskConfigEffort';
  // Long Ollama tags would push the trigger past the ask line's meta row; the
  // full name stays in the title + aria-label.
  const CHIP_LABEL_MAX = 22;
  const DEFAULT_MODEL_LABEL = 'Default model';
  // The ask line's meta row; a bare region (unit harnesses) hosts it directly.
  const META_ROW_SELECTOR = '.home-ask__meta';
  const MODEL_SELECT_SELECTOR = '[data-ask-config="model"]';
  const EFFORT_SELECT_SELECTOR = '[data-ask-config="effort"]';
  /* Rapid open/close used to issue one catalog IPC per open. The TTL keeps the
   * "a model pulled mid-session appears without a remount" property (30s is
   * shorter than any realistic pull) while collapsing a burst to one call. */
  const MODEL_CATALOG_TTL_MS = 30000;
  const TRIGGER_LABEL_CLASS = 'home-ask__model-label';

  /* A quantization tail says nothing about WHICH model this is
   * ("qwen3.8:27b-ud-iq3-s") and is exactly what the chip's ellipsis eats. Drop
   * a RECOGNIZED tail and NOTHING else: an unfamiliar suffix ("ornith:9b-48k")
   * is kept, an untagged id untouched; the full id survives in title/aria. */
  const QUANT_ANCHOR_RE = /^(?:i?q\d+(?:_[a-z0-9]+)*|f16|fp16|bf16|f32|fp32)$/i;
  // Segments that only MODIFY an anchor (k/s/m/l sizes, ud/imat markers).
  // Dropped ONLY when the trailing run they sit in terminates at an anchor.
  const QUANT_MODIFIER_RE = /^(?:k|s|m|l|xs|xl|xxl|ud|i|imat|[01])$/i;

  function formatModelDisplayName(modelId) {
    const id = String(modelId || '').trim();
    const colon = id.lastIndexOf(':');
    if (colon <= 0 || colon === id.length - 1) {
      return id;
    }
    const segments = id.slice(colon + 1).split('-');
    let end = segments.length;
    let anchored = false;
    while (end > 0) {
      const segment = segments[end - 1];
      if (QUANT_ANCHOR_RE.test(segment)) {
        anchored = true;
      } else if (!QUANT_MODIFIER_RE.test(segment)) {
        break;
      }
      end -= 1;
    }
    // No anchor = never a quant tail; all-consumed = nothing BUT one.
    if (!anchored || end === 0) {
      return id;
    }
    return `${id.slice(0, colon)}:${segments.slice(0, end).join('-')}`;
  }

  function noop() {}

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function truncateLabel(value) {
    const text = String(value || '');
    return text.length > CHIP_LABEL_MAX ? `${text.slice(0, CHIP_LABEL_MAX - 1)}…` : text;
  }

  function capabilityKey(modelId, engineType) {
    return `${String(engineType || '').trim().toLowerCase() || '*'}::${String(modelId || '').trim()}`;
  }

  function modelListEntries(payload) {
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.models)) return payload.models;
    return [];
  }

  function createAskConfigController(deps = {}) {
    const documentRef = deps.documentRef || windowRef.document || null;
    const shell = deps.shell || null;
    const getState = typeof deps.getState === 'function' ? deps.getState : () => ({});
    const getRuntimePreferences = typeof deps.getRuntimePreferences === 'function'
      ? deps.getRuntimePreferences
      : () => ({ preferredModel: '', reasoningEffort: 'default' });
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const modules = deps.modules || {};
    const inventory = deps.inventory || windowRef.inventory || null;
    const profiles = modules.reasoningEffortProfiles || windowRef.reasoningEffortProfiles || null;
    const formatUtils = modules.lifecycleFormatUtils || windowRef.rendererLifecycleFormatUtils || null;
    const composerModel = modules.composerV2Model || windowRef.rendererComposerV2Model || null;
    const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : () => Date.now();

    const categories = Array.isArray(composerModel?.TOOL_TOGGLE_CATEGORIES)
      ? composerModel.TOOL_TOGGLE_CATEGORIES
      : [];
    const configKeys = asObject(composerModel?.TOOL_CATEGORY_CONFIG_KEYS) || {};
    const sessionKeys = asObject(composerModel?.TOOL_CATEGORY_SESSION_KEYS) || {};
    const automaticEffort = String(profiles?.AUTOMATIC_REASONING_EFFORT || 'default');

    const modelCapabilities = new Map();
    let models = [];
    let regionEl = null;
    let chipEl = null;
    let popoverEl = null;
    let draft = null;
    let touched = false;
    let disposed = false;
    let modelsFetching = false;
    // F11: `ensure()` and `sync()` both run on EVERY Home paint and every 30s
    // clock tick. Without this the trigger took three DOM writes per tick to
    // restate text it already had.
    let lastTriggerKey = null;
    let modelsFetchedAt = 0;

    function normalizeEffort(value) {
      return typeof profiles?.normalizeReasoningEffort === 'function'
        ? profiles.normalizeReasoningEffort(value)
        : String(value || automaticEffort);
    }

    function normalizeModel(value) {
      return typeof formatUtils?.normalizeModelToken === 'function'
        ? formatUtils.normalizeModelToken(value)
        : String(value || '').trim();
    }

    // Global tool defaults, read the composer's way (state.features.tools
    // keyed by TOOL_CATEGORY_CONFIG_KEYS); an absent/non-boolean key is ON.
    function seedToolOverrides() {
      const toolSettings = asObject(getState()?.features?.tools) || {};
      const overrides = {};
      for (const category of categories) {
        const configKey = configKeys[category.id];
        overrides[category.id] = configKey && typeof toolSettings[configKey] === 'boolean'
          ? toolSettings[configKey]
          : true;
      }
      return overrides;
    }

    function seedDraft() {
      const preferences = getRuntimePreferences() || {};
      return {
        preferredModel: normalizeModel(preferences.preferredModel),
        reasoningEffort: normalizeEffort(preferences.reasoningEffort),
        toolOverrides: seedToolOverrides(),
      };
    }

    function getDraft() {
      if (!draft) {
        draft = seedDraft();
      }
      return draft;
    }

    /** Session-shaped tool override map for the chat an ask starts. */
    function getSessionToolOverrides() {
      const current = getDraft().toolOverrides;
      const overrides = {};
      for (const category of categories) {
        const sessionKey = sessionKeys[category.id];
        if (sessionKey) {
          overrides[sessionKey] = current[category.id] !== false;
        }
      }
      return overrides;
    }

    function capabilitiesFor(modelId) {
      const id = String(modelId || '').trim();
      for (const [key, capabilities] of modelCapabilities) {
        if (key.endsWith(`::${id}`)) {
          return capabilities;
        }
      }
      return null;
    }

    function effortOptions(modelId) {
      if (typeof profiles?.buildReasoningEffortOptions !== 'function') {
        return [];
      }
      return profiles.buildReasoningEffortOptions(modelId, capabilitiesFor(modelId));
    }

    function modelOptions(selectedValue) {
      if (typeof formatUtils?.buildModelOptionsArray !== 'function') {
        return [{ value: '', label: DEFAULT_MODEL_LABEL }];
      }
      return formatUtils
        .buildModelOptionsArray(models, selectedValue, { compact: true, annotateMissingSelected: false })
        .map((option) => ({ value: option.value, label: option.label, disabled: option.disabled === true }));
    }

    /* `model`/`full` stay the UNTOUCHED id; `display` is the chip's label. */
    function chipText() {
      const current = getDraft();
      const modelLabel = current.preferredModel || DEFAULT_MODEL_LABEL;
      const short = current.preferredModel
        ? formatModelDisplayName(current.preferredModel)
        : DEFAULT_MODEL_LABEL;
      const effort = current.reasoningEffort;
      if (!effort || effort === automaticEffort) {
        return { full: modelLabel, display: short, model: modelLabel, effort: '' };
      }
      const label = profiles?.REASONING_EFFORT_LABELS?.[effort] || effort;
      return {
        full: `${modelLabel} · ${label}`,
        display: `${short} · ${label}`,
        model: modelLabel,
        effort: label,
      };
    }

    function updateChipLabel() {
      if (!chipEl) return;
      const text = chipText();
      // Skip the writes when nothing moved (F11): three DOM mutations on every
      // paint and every clock tick, to restate a label that had not changed.
      const key = `${text.display}\u0000${text.model}\u0000${text.effort}`;
      if (key === lastTriggerKey) return;
      lastTriggerKey = key;
      const labelSlot = chipEl.querySelector(`.${TRIGGER_LABEL_CLASS}`);
      if (labelSlot) {
        labelSlot.textContent = truncateLabel(text.display);
      }
      const description = text.effort
        ? `Ask settings: ${text.model}, ${text.effort} reasoning effort`
        : `Ask settings: ${text.model}`;
      chipEl.setAttribute('aria-label', description);
      chipEl.setAttribute('title', `${description}. Applies to the chat this ask starts.`);
    }

    function toolTogglesMarkup() {
      const toggleSwitch = inventory && typeof inventory.toggleSwitch === 'function'
        ? inventory.toggleSwitch
        : null;
      if (!toggleSwitch || !categories.length) {
        return '';
      }
      const current = getDraft().toolOverrides;
      const rows = categories.map((category) => toggleSwitch({
        id: `home-ask-tool-${category.id}`,
        label: category.label,
        checked: current[category.id] !== false,
        className: 'home-ask-config__toggle',
      }));
      return '<div class="home-ask-config__tools" role="group" aria-label="Tools for this ask">'
        + rows.join('')
        + '</div>';
    }

    function effortFieldMarkup() {
      const selectField = inventory && typeof inventory.selectField === 'function'
        ? inventory.selectField
        : null;
      const current = getDraft();
      const options = effortOptions(current.preferredModel);
      // Mirrors the composer's capability gate: one option means the model
      // exposes no effort ladder, so the control is hidden rather than shown
      // as a picker with a single useless entry.
      const supported = options.length > 1;
      if (!selectField || !supported) {
        return '';
      }
      return selectField({
        id: EFFORT_FIELD_ID,
        label: 'Reasoning effort',
        value: current.reasoningEffort,
        options,
        ariaLabel: 'Reasoning effort for this ask',
        className: 'home-ask-config__field',
        dataset: { 'ask-config': 'effort' },
      });
    }

    function renderEffortHost() {
      const host = popoverEl?.querySelector?.('.home-ask-config__effort');
      if (!host) return;
      const markup = effortFieldMarkup();
      host.innerHTML = markup;
      host.hidden = !markup;
    }

    function popoverBodyMarkup() {
      const selectField = inventory && typeof inventory.selectField === 'function'
        ? inventory.selectField
        : null;
      const current = getDraft();
      const modelField = selectField
        ? selectField({
          id: MODEL_FIELD_ID,
          label: 'Model',
          value: current.preferredModel,
          options: modelOptions(current.preferredModel),
          ariaLabel: 'Model for this ask',
          className: 'home-ask-config__field',
          dataset: { 'ask-config': 'model' },
        })
        : '';
      return '<div class="home-ask-config__row">'
        + modelField
        + '<div class="home-ask-config__effort"></div>'
        + '</div>'
        + toolTogglesMarkup()
        + '<div class="inv-popover-footer">'
        + 'Applies to the chat this ask starts — defaults live in Settings.'
        + '</div>';
    }

    /* Runs on OPEN ONLY. Everything that used to call this while the panel was
     * open now goes through reseedOpenPanel() instead. */
    function renderPopoverBody() {
      if (!popoverEl) return;
      popoverEl.innerHTML = popoverBodyMarkup();
      renderEffortHost();
    }

    /* Repopulate the model picker's options IN PLACE and restore the selection.
     * Deliberately narrow: the effort picker, the tool toggles, and whatever
     * the user has focused are all left exactly as they are (F2).
     * (The option markup comes from the primitive so it stays byte-identical
     * to the initial render - and so this module never hand-writes control
     * markup, which check_no_raw_html_primitives reads even in comments.) */
    function repopulateModelOptions() {
      const select = popoverEl?.querySelector?.(MODEL_SELECT_SELECTOR);
      const optionsMarkup = inventory?.selectField?.optionsMarkup;
      if (!select || typeof optionsMarkup !== 'function') return;
      const current = getDraft();
      select.innerHTML = optionsMarkup(modelOptions(current.preferredModel), current.preferredModel);
      select.value = current.preferredModel;
    }

    /* An untouched draft re-seeded under an OPEN panel: push the new values
     * into the live controls rather than rebuilding the panel around them. */
    function reseedOpenPanel() {
      repopulateModelOptions();
      const current = getDraft();
      const effort = popoverEl?.querySelector?.(EFFORT_SELECT_SELECTOR);
      if (effort) {
        effort.value = current.reasoningEffort;
      }
      const setChecked = inventory?.toggleSwitch?.setChecked;
      if (typeof setChecked !== 'function') return;
      for (const category of categories) {
        const track = popoverEl?.querySelector?.(`#home-ask-tool-${category.id} [role="switch"]`)
          || popoverEl?.querySelector?.(`#home-ask-tool-${category.id}`);
        if (track) {
          setChecked(track, current.toolOverrides[category.id] !== false);
        }
      }
    }

    function isOpen() {
      return Boolean(popoverEl) && popoverEl.hidden !== true;
    }

    function handleChipClick(event) {
      const target = event?.target;
      if (!chipEl || !popoverEl || !target?.closest || !target.closest(`#${CHIP_DOM_ID}`)) {
        return;
      }
      event.preventDefault?.();
      if (!isOpen()) {
        // The ONLY caller of renderPopoverBody: a rebuild while open would blow
        // away the control the user is interacting with, and their focus with
        // it. Everything else reseeds the live controls (F2).
        renderPopoverBody();
        void ensureModels();
      }
      inventory?.popover?.toggle?.(popoverEl, { trigger: chipEl, focus: false });
    }

    function handleFieldChange(event) {
      const target = event?.target;
      const field = String(target?.dataset?.askConfig || '');
      if (!field) return;
      const current = getDraft();
      if (field === 'model') {
        current.preferredModel = normalizeModel(target.value);
        // A model swap changes the effort ladder; re-normalize against the new
        // one so an unsupported carry-over cannot ride into the session.
        current.reasoningEffort = typeof profiles?.normalizeReasoningEffortForModel === 'function'
          ? profiles.normalizeReasoningEffortForModel(
            current.reasoningEffort,
            current.preferredModel,
            capabilitiesFor(current.preferredModel)
          )
          : current.reasoningEffort;
        renderEffortHost();
      } else if (field === 'effort') {
        current.reasoningEffort = normalizeEffort(target.value);
      } else {
        return;
      }
      touched = true;
      updateChipLabel();
    }

    function handleToggleChange(event) {
      const id = String(event?.detail?.id || '');
      if (!id.startsWith('home-ask-tool-')) return;
      const categoryId = id.slice('home-ask-tool-'.length);
      if (!categories.some((category) => category.id === categoryId)) return;
      getDraft().toolOverrides[categoryId] = event.detail.checked === true;
      touched = true;
    }

    /* Not a one-shot latch: a popover OPEN past the TTL refetches, so a model
     * pulled mid-session still appears without a remount (F12). */
    async function ensureModels() {
      const listModels = shell?.models?.list;
      if (modelsFetching || typeof listModels !== 'function') {
        return;
      }
      if (modelsFetchedAt && (nowMs() - modelsFetchedAt) < MODEL_CATALOG_TTL_MS) {
        return;
      }
      modelsFetching = true;
      try {
        const payload = await listModels();
        if (disposed || !payload || payload.available === false) return;
        models = modelListEntries(payload);
        modelCapabilities.clear();
        for (const entry of models) {
          const id = String(typeof entry === 'string' ? entry : entry?.id || '').trim();
          if (!id) continue;
          const engineType = String(entry?.engine_type || entry?.engineType || '').trim();
          modelCapabilities.set(capabilityKey(id, engineType), entry?.capabilities || null);
        }
        modelsFetchedAt = nowMs();
        // NEVER rebuild the body here: this resolves ~100ms after the open, so
        // a rebuild wiped every control the user had already reached for, and
        // their focus with it (F2). Only the model options are stale.
        if (isOpen()) {
          repopulateModelOptions();
        }
        updateChipLabel();
      } catch (error) {
        // Settings owns user-visible catalog errors; a chip that cannot list
        // models still configures effort and tools.
        appendClientLog('WARN', 'home.ask_config_model_list_failed', {
          message: String(error?.message || error || ''),
        });
      } finally {
        modelsFetching = false;
      }
    }

    /** Build the model trigger + panel into the built-once ask region. */
    function ensure(askRegionEl) {
      if (!askRegionEl || disposed) return null;
      if (regionEl === askRegionEl && chipEl && popoverEl) {
        updateChipLabel();
        if (isOpen()) void ensureModels();
        return chipEl;
      }
      const actionButton = inventory && typeof inventory.actionButton === 'function'
        ? inventory.actionButton
        : null;
      const popover = inventory && typeof inventory.popover === 'function' ? inventory.popover : null;
      if (!actionButton || !popover) {
        return null;
      }
      const ownerDocument = askRegionEl.ownerDocument || documentRef;
      if (!ownerDocument) return null;
      detachListeners();
      const host = ownerDocument.createElement('div');
      host.className = 'home-ask-config';
      // A plain-text trigger, not a chip: the model name is INFORMATION and
      // has to stay legible at rest, and the hero already carries enough
      // bordered capsules. `plain: true` means this element takes no .btn
      // chrome at all — the stylesheet owns every pixel of it.
      host.innerHTML = actionButton({
        plain: true,
        domId: CHIP_DOM_ID,
        className: 'home-ask__model',
        trustedHtml: `<span class="${TRIGGER_LABEL_CLASS}"></span>`
          + '<span class="home-ask__model-caret" aria-hidden="true">&#9662;</span>',
        ariaHaspopup: 'dialog',
        ariaExpanded: false,
        ariaControls: POPOVER_DOM_ID,
      })
        + popover({
          id: 'home-ask-config',
          domId: POPOVER_DOM_ID,
          ariaLabel: 'Ask settings',
          className: 'home-ask__panel',
        });
      // On the meta row, at its FRONT (ahead of the hint and the send button)
      // when the strip built one; a bare region (unit harnesses) hosts it
      // directly. Either way it stays in the built-once region, safe from the
      // 30s repaint.
      const mount = askRegionEl.querySelector?.(META_ROW_SELECTOR) || askRegionEl;
      if (typeof mount.prepend === 'function') {
        mount.prepend(host);
      } else {
        mount.insertBefore(host, mount.firstChild || null);
      }
      regionEl = askRegionEl;
      lastTriggerKey = null;
      chipEl = ownerDocument.getElementById(CHIP_DOM_ID);
      popoverEl = ownerDocument.getElementById(POPOVER_DOM_ID);
      inventory?.popover?.initPopoverHandlers?.(ownerDocument);
      inventory?.toggleSwitch?.initToggleHandlers?.(ownerDocument);
      host.addEventListener('click', handleChipClick);
      host.addEventListener('change', handleFieldChange);
      host.addEventListener('inv-toggle-change', handleToggleChange);
      updateChipLabel();
      void ensureModels();
      return chipEl;
    }

    function detachListeners() {
      const host = regionEl?.querySelector?.('.home-ask-config');
      if (host) {
        host.removeEventListener('click', handleChipClick);
        host.removeEventListener('change', handleFieldChange);
        host.removeEventListener('inv-toggle-change', handleToggleChange);
      }
      regionEl = null;
      chipEl = null;
      popoverEl = null;
      lastTriggerKey = null;
    }

    /* Re-seed from the live runtime pair ONLY while the draft is untouched. A
     * user who has picked a model keeps it across every Home repaint (and
     * across a chat switch) until they change it themselves. */
    function sync() {
      if (disposed) return;
      if (!touched) {
        draft = seedDraft();
        // Same rule as the catalog resolve: sync() runs on every 30s repaint,
        // so rebuilding here wiped the panel under the user just as reliably.
        if (isOpen()) {
          reseedOpenPanel();
        }
      }
      if (isOpen()) void ensureModels();
      updateChipLabel();
    }

    function dispose() {
      disposed = true;
      detachListeners();
    }

    return {
      ensure,
      sync,
      dispose,
      getDraft,
      getSessionToolOverrides,
      isTouched: () => touched,
    };
  }

  /* Turns one ask into a configured chat. The order is load-bearing:
   *   1. resolve the composer's REAL send control first, so a chat surface
   *      that cannot send never gets a session created against it and the
   *      pill keeps the user's text;
   *   2. create the session carrying the draft's model + effort;
   *   3. write the session's tool overrides BEFORE the send, so the turn that
   *      goes out is the one the user configured;
   *   4. prefill through the manager's existing composer write;
   *   5. click the composer's own send control - the send path is never
   *      reimplemented here.
   */
  function createAskLauncher(deps = {}) {
    const documentRef = deps.documentRef || windowRef.document || null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const askConfig = deps.askConfig || null;
    const handleCreateSession = typeof deps.handleCreateSession === 'function' ? deps.handleCreateSession : null;
    const setSessionToolOverrides = typeof deps.setSessionToolOverrides === 'function'
      ? deps.setSessionToolOverrides
      : null;
    const getCurrentSessionId = typeof deps.getCurrentSessionId === 'function'
      ? deps.getCurrentSessionId
      : () => '';
    const prefillComposer = typeof deps.prefillComposer === 'function' ? deps.prefillComposer : () => false;
    const navigateOnly = typeof deps.navigateOnly === 'function' ? deps.navigateOnly : () => false;
    const sendControlId = String(deps.sendControlId || 'sendButton');

    function sendControl() {
      return documentRef?.getElementById?.(sendControlId) || null;
    }

    async function applyDraftToSession() {
      const draft = askConfig?.getDraft?.() || null;
      // Captured BEFORE the create so the write below can prove it is landing
      // on the NEW session (F8). `handleCreateSession` resolving is not the
      // same claim as the active session having switched, and the overrides
      // are session-scoped: writing them against a stale id silently
      // reconfigures whatever chat the user was last in.
      const previousSessionId = String(getCurrentSessionId() || '').trim();
      if (handleCreateSession) {
        await handleCreateSession(draft
          ? {
            preferences: {
              preferred_model: draft.preferredModel,
              reasoning_effort: draft.reasoningEffort,
            },
          }
          : {});
      }
      const sessionId = String(getCurrentSessionId() || '').trim();
      const overrides = askConfig?.getSessionToolOverrides?.() || null;
      if (!sessionId || sessionId === previousSessionId) {
        appendClientLog('WARN', 'home.ask_session_unchanged', {
          reason: sessionId ? 'session_id_unchanged' : 'missing_session_id',
        });
        return;
      }
      if (!overrides || !setSessionToolOverrides) {
        return;
      }
      // Non-fatal: a chat that starts with the wrong tool set is recoverable
      // from the composer, whereas losing the question is not.
      try {
        await setSessionToolOverrides(sessionId, overrides);
      } catch (error) {
        appendClientLog('WARN', 'home.ask_tool_overrides_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }

    /* Second latch, deliberately not the keydown handler's. This one holds even
     * if a future caller reaches startAsk without going through the ask line's
     * key/click delegation — the window it guards spans two IPC round-trips,
     * and a second pass through it creates a second session and a second
     * send (F1). The empty-text navigate is outside it: it creates nothing. */
    let inFlight = false;

    async function startAsk(text, options = {}) {
      const body = String(text || '');
      const wantsSend = options.send !== false;
      if (!body.trim()) {
        return navigateOnly();
      }
      if (inFlight) {
        appendClientLog('WARN', 'home.ask_already_in_flight', { reason: 'concurrent_ask' });
        return false;
      }
      if (wantsSend && !sendControl()) {
        appendClientLog('WARN', 'home.ask_send_unavailable', { reason: 'missing_send_control' });
        return false;
      }
      inFlight = true;
      try {
        try {
          await applyDraftToSession();
        } catch (error) {
          appendClientLog('WARN', 'home.ask_session_create_failed', {
            message: String(error?.message || error || ''),
          });
          return false;
        }
        if (!prefillComposer(body)) {
          return false;
        }
        if (!wantsSend) {
          return true;
        }
        const trigger = sendControl();
        if (!trigger || trigger.disabled === true) {
          // The text is already safe in the composer, so this is not a loss -
          // report success and let the user press send.
          appendClientLog('WARN', 'home.ask_send_unavailable', { reason: 'send_control_blocked' });
          return true;
        }
        trigger.click();
        return true;
      } finally {
        inFlight = false;
      }
    }

    return { startAsk };
  }

  return {
    createAskConfigController,
    createAskLauncher,
    formatModelDisplayName,
    CHIP_DOM_ID,
    POPOVER_DOM_ID,
    MODEL_FIELD_ID,
    EFFORT_FIELD_ID,
  };
});
