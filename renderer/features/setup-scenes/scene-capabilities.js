/**
 * renderer/features/setup-scenes/scene-capabilities.js
 *
 * First-run setup scene - "Tools & capabilities". Lets a new user opt into the
 * tool capabilities Jenny may use. Consequence-bearing network and
 * workspace-mutation choices start off. Persists choices via the same path Settings uses
 * (`features.updateSettings`, injected as `persistFeatureSettings`), batching
 * `tools` + `featureOverrides` into a single patch, then marks the step done.
 *
 * Toggle UI is rendered through the inventory `toggleSwitch` string builder, so
 * this file contains no raw HTML form primitives (policy-safe).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneCapabilities = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var toggleModule = resolveDependency
    ? resolveDependency('inventoryToggleSwitch', '../../inventory/toggle-switch') : null;
  var toggleSwitch = toggleModule
    ? (typeof toggleModule === 'function' ? toggleModule : toggleModule.toggleSwitch) : null;
  var asyncFence = resolveDependency('rendererAsyncFence', '../../shared/async-fence');

  // Each field drives both rendering and Save read-back.
  // target: which patch bucket the value lands in ('tools' or 'featureOverrides').
  // section: consequence-based visual group heading. `defaultChecked` is true
  // only for local, non-mutating computation; network, file mutation, and
  // workspace mutation require the user to opt in before Save.
  var FIELDS = [
    { id: 'capPythonToggle', key: 'pythonRuntime', target: 'tools', section: 'local', defaultChecked: true,
      label: jt('setup.capabilities.pythonRuntime', 'Python runtime'), description: jt('setup.capabilities.pythonRuntimeDescription', 'Local · Runs Python for data work and quick scripts.') },
    { id: 'capImageReadToggle', key: 'imageRead', target: 'tools', section: 'local', defaultChecked: true,
      label: jt('setup.capabilities.imageReading', 'Image reading'), description: jt('setup.capabilities.imageReadingDescription', 'Local · Lets Jenny inspect images you share.') },
    { id: 'capTodoToggle', key: 'todo', target: 'tools', section: 'local', defaultChecked: true,
      label: jt('setup.capabilities.todoTracking', 'To-do tracking'), description: jt('setup.capabilities.todoTrackingDescription', 'Local · Tracks multi-step work as a checklist.') },
    { id: 'capWebToggle', key: 'web', target: 'tools', section: 'network', defaultChecked: false,
      label: jt('setup.capabilities.webSearch', 'Web search'), description: jt('setup.capabilities.webSearchDescription', 'Network · Sends your query to a search service.') },
    { id: 'capBrowserToggle', key: 'browser', target: 'tools', section: 'network', defaultChecked: false,
      label: jt('setup.capabilities.webBrowsing', 'Web browsing'), description: jt('setup.capabilities.webBrowsingDescription', 'Network · Opens and reads web pages.') },
  ];

  var SECTIONS = [
    { key: 'local', title: jt('setup.capabilities.localComputation', 'Local computation') },
    { key: 'network', title: jt('setup.capabilities.networkAccess', 'Network access') },
    { key: 'workspace', title: jt('setup.capabilities.workspaceChanges', 'Workspace changes') },
  ];

  function escapeHtml(value) {
    return sceneUtils && sceneUtils.escapeHtml
      ? sceneUtils.escapeHtml(value)
      : String(value == null ? '' : value);
  }

  function renderGroup(section, draft, disabled) {
    if (!toggleSwitch) return '';
    var toggles = FIELDS
      .filter(function (f) { return f.section === section.key; })
      .map(function (f) {
        return toggleSwitch({ id: f.id, label: f.label, description: f.description, checked: draft[f.key], disabled: disabled });
      })
      .join('');
    if (!toggles) return '';
    return ''
      + '<section class="setup-cap-group">'
      + '<h3 class="setup-cap-group-title">' + escapeHtml(section.title) + '</h3>'
      + '<div class="setup-cap-group-toggles">' + toggles + '</div>'
      + '</section>';
  }

  function buildBodyHtml(draft, disabled, errorText) {
    return ''
      + '<div class="setup-scene-body setup-cap-body">'
      + (errorText ? '<p role="alert">' + escapeHtml(errorText) + '</p>' : '')
      + SECTIONS.map(function (section) { return renderGroup(section, draft, disabled); }).join('')
      + '</div>';
  }

  function createScene(deps) {
    var d = deps || {};
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(); };
    var persistFeatureSettings = typeof d.persistFeatureSettings === 'function'
      ? d.persistFeatureSettings
      : function () { return Promise.resolve(null); };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : function () {};
    var showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var getFeatureSettings = d.getFeatureSettings;
    var gate = asyncFence.createGenerationGate();
    var fence = asyncFence.createDisposalFence();
    var draft = {};
    var loading = false;
    var loadError = '';
    var revisit = d.state && d.state.steps && d.state.steps.capabilities === 'done';

    var modalId = 'setup-capabilities';
    var rootEl = null;
    var unbindClicks = null;
    var saveInFlight = false;

    function readToggles() {
      var tools = {};
      var featureOverrides = {};
      FIELDS.forEach(function (f) {
        var on = draft[f.key] === true;
        if (f.target === 'tools') {
          tools[f.key] = on;
        } else {
          featureOverrides[f.key] = on;
        }
      });
      return { tools: tools, featureOverrides: featureOverrides };
    }

    function render() {
      if (!rootEl || fence.isDisposed()) return;
      var actions = [
        { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary', disabled: saveInFlight },
        { id: 'save', label: loading ? jt("models.library.loading", "Loading…") : jt('common.save', 'Save'), variant: 'primary', disabled: saveInFlight || loading || !!loadError },
        { id: 'skip', label: jt('setup.capabilities.skipForNow', 'Skip for now'), variant: 'ghost', disabled: saveInFlight },
      ];
      if (loadError) actions.push({ id: 'retry', label: jt("common.retry", "Retry"), variant: 'secondary' });
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: jt('setup.capabilities.title', 'Tools & capabilities'),
        eyebrow: sceneUtils.setupStepEyebrow('capabilities'),
        summary: jt('setup.capabilities.summary', 'Review what Jenny may do. Network access and file changes stay off unless you enable them.'),
        bodyHtml: buildBodyHtml(draft, saveInFlight || loading || !!loadError, loadError),
        actions: actions,
      }) : '';
      rootEl.innerHTML = html;
    }

    function isCurrent(token) {
      return !fence.isDisposed() && gate.isCurrent(token);
    }

    function validSettings(result) {
      return result && result.ok !== false && FIELDS.every(function (f) {
        return result[f.target] && typeof result[f.target][f.key] === 'boolean';
      });
    }

    async function loadSettings() {
      if (loading) return;
      loading = true;
      loadError = '';
      var token = gate.capture();
      render();
      try {
        if (typeof getFeatureSettings !== 'function') throw new Error('Settings bridge unavailable');
        var result = await getFeatureSettings();
        if (!isCurrent(token)) return;
        if (!validSettings(result)) throw new Error('Invalid settings response');
        FIELDS.forEach(function (f) { draft[f.key] = result[f.target][f.key]; });
      } catch (_error) {
        if (!isCurrent(token)) return;
        loadError = jt("sceneCapabilities.couldNotLoadSavedPermissionsRetryBeforeMakingChanges", "Could not load saved permissions. Retry before making changes.");
        appendClientLog('WARN', 'setup.capabilities_load_failed', { reason: 'settings_unavailable' });
      }
      loading = false;
      render();
    }

    function handleToggle(event) {
      if (loading || saveInFlight || loadError || fence.isDisposed()) return;
      var detail = event.detail || {};
      var field = FIELDS.find(function (f) { return f.id === detail.id; });
      if (field && typeof detail.checked === 'boolean') draft[field.key] = detail.checked;
    }

    async function handleSave() {
      if (saveInFlight || loading || loadError || fence.isDisposed()) return;
      saveInFlight = true;
      var token = gate.capture();
      var patch = readToggles();
      render();
      try {
        var result = await persistFeatureSettings(patch);
        if (!isCurrent(token)) return;
        if (!validSettings(result) || !FIELDS.every(function (f) {
          return result[f.target][f.key] === patch[f.target][f.key];
        })) throw new Error('Permissions were not acknowledged');
        await markStep('capabilities', 'done');
        if (!isCurrent(token)) return;
        showToastMessage(jt('setup.capabilities.saved', 'Capabilities saved.'));
        closeModal();
      } catch (_error) {
        if (!isCurrent(token)) return;
        appendClientLog('WARN', 'setup.capabilities_save_failed', {
          reason: 'save_not_completed',
        });
        showShellErrorToast(jt('setup.capabilities.saveFailed', 'Could not save capabilities.'), { title: jt('setup.capabilities.failureTitle', 'Setup Step Failed') });
        if (rootEl) {
          saveInFlight = false;
          render();
        }
      }
    }

    async function handleSkip() {
      if (saveInFlight || fence.isDisposed()) return;
      var token = gate.capture();
      saveInFlight = true;
      render();
      try {
        await markStep('capabilities', 'skipped');
        if (isCurrent(token)) closeModal();
      } catch (_error) {
        if (!isCurrent(token)) return;
        saveInFlight = false;
        render();
      }
    }

    return {
      mount: function mount(rootElement) {
        gate.bump();
        fence = asyncFence.createDisposalFence();
        loading = false;
        loadError = '';
        FIELDS.forEach(function (f) { draft[f.key] = f.defaultChecked === true; });
        saveInFlight = false;
        rootEl = rootElement;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: closeModal,
              save: handleSave,
              skip: handleSkip,
              retry: loadSettings,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.capabilities_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
        // Inventory owns the document-level click handler; a local handler
        // would flip every click twice. Only observe its semantic event here.
        rootEl.addEventListener('inv-toggle-change', handleToggle);
        if (revisit) loadSettings();
      },
      dispose: function dispose() {
        fence.dispose();
        gate.bump();
        if (rootEl) rootEl.removeEventListener('inv-toggle-change', handleToggle);
        if (typeof unbindClicks === 'function') {
          unbindClicks();
          unbindClicks = null;
        }
        rootEl = null;
      },
    };
  }

  return { createScene: createScene, FIELDS: FIELDS, SECTIONS: SECTIONS };
});
