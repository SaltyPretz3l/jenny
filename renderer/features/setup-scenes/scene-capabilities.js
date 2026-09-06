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

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var toggleModule = resolveDependency
    ? resolveDependency('inventoryToggleSwitch', '../../inventory/toggle-switch') : null;
  var toggleSwitch = toggleModule
    ? (typeof toggleModule === 'function' ? toggleModule : toggleModule.toggleSwitch) : null;
  var initToggleHandlers = toggleModule && toggleModule.initToggleHandlers;

  // Each field drives both rendering and Save read-back.
  // target: which patch bucket the value lands in ('tools' or 'featureOverrides').
  // section: consequence-based visual group heading. `defaultChecked` is true
  // only for local, non-mutating computation; network, file mutation, and
  // workspace mutation require the user to opt in before Save.
  var FIELDS = [
    { id: 'capPythonToggle', key: 'pythonRuntime', target: 'tools', section: 'local', defaultChecked: true,
      label: 'Python runtime', description: 'Local · Runs Python for data work and quick scripts.' },
    { id: 'capImageReadToggle', key: 'imageRead', target: 'tools', section: 'local', defaultChecked: true,
      label: 'Image reading', description: 'Local · Lets Jenny inspect images you share.' },
    { id: 'capTodoToggle', key: 'todo', target: 'tools', section: 'local', defaultChecked: true,
      label: 'To-do tracking', description: 'Local · Tracks multi-step work as a checklist.' },
    { id: 'capWebToggle', key: 'web', target: 'tools', section: 'network', defaultChecked: false,
      label: 'Web search', description: 'Network · Sends your query to a search service.' },
    { id: 'capBrowserToggle', key: 'browser', target: 'tools', section: 'network', defaultChecked: false,
      label: 'Web browsing', description: 'Network · Opens and reads web pages.' },
  ];

  var SECTIONS = [
    { key: 'local', title: 'Local computation' },
    { key: 'network', title: 'Network access' },
    { key: 'workspace', title: 'Workspace changes' },
  ];

  function escapeHtml(value) {
    return sceneUtils && sceneUtils.escapeHtml
      ? sceneUtils.escapeHtml(value)
      : String(value == null ? '' : value);
  }

  function renderGroup(section) {
    if (!toggleSwitch) return '';
    var toggles = FIELDS
      .filter(function (f) { return f.section === section.key; })
      .map(function (f) {
        return toggleSwitch({ id: f.id, label: f.label, description: f.description, checked: f.defaultChecked === true });
      })
      .join('');
    if (!toggles) return '';
    return ''
      + '<section class="setup-cap-group">'
      + '<h3 class="setup-cap-group-title">' + escapeHtml(section.title) + '</h3>'
      + '<div class="setup-cap-group-toggles">' + toggles + '</div>'
      + '</section>';
  }

  function buildBodyHtml() {
    return ''
      + '<div class="setup-scene-body setup-cap-body">'
      + SECTIONS.map(renderGroup).join('')
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

    var modalId = 'setup-capabilities';
    var rootEl = null;
    var unbindClicks = null;
    var saveInFlight = false;

    function readToggles() {
      var tools = {};
      var featureOverrides = {};
      FIELDS.forEach(function (f) {
        var el = rootEl && rootEl.querySelector('[data-inv-toggle="' + f.id + '"]');
        var on = el ? el.getAttribute('aria-checked') === 'true' : f.defaultChecked === true;
        if (f.target === 'tools') {
          tools[f.key] = on;
        } else {
          featureOverrides[f.key] = on;
        }
      });
      return { tools: tools, featureOverrides: featureOverrides };
    }

    function render() {
      if (!rootEl) return;
      var actions = [
        { id: 'cancel', label: 'Cancel', variant: 'secondary', disabled: saveInFlight },
        { id: 'save', label: 'Save', variant: 'primary', disabled: saveInFlight },
        { id: 'skip', label: 'Skip for now', variant: 'ghost', disabled: saveInFlight },
      ];
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: 'Tools & capabilities',
        eyebrow: sceneUtils.setupStepEyebrow('capabilities'),
        summary: 'Review what Jenny may do. Network access and file changes stay off unless you enable them.',
        bodyHtml: buildBodyHtml(),
        actions: actions,
      }) : '';
      rootEl.innerHTML = html;
    }

    async function handleSave() {
      if (saveInFlight) return;
      saveInFlight = true;
      var patch = readToggles();
      render();
      try {
        await persistFeatureSettings(patch);
        await markStep('capabilities', 'done');
        showToastMessage('Capabilities saved.');
        closeModal();
      } catch (error) {
        appendClientLog('WARN', 'setup.capabilities_save_failed', {
          message: error && error.message ? error.message : String(error),
        });
        showShellErrorToast('Could not save capabilities.', { title: 'Setup Step Failed' });
        if (rootEl) {
          saveInFlight = false;
          render();
        }
      }
    }

    async function handleSkip() {
      try {
        await markStep('capabilities', 'skipped');
      } catch (_error) { /* markStep already reports the persistence failure */ }
      closeModal();
    }

    return {
      mount: function mount(rootElement) {
        saveInFlight = false;
        rootEl = rootElement;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: closeModal,
              save: handleSave,
              skip: handleSkip,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.capabilities_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
        if (typeof initToggleHandlers === 'function') {
          initToggleHandlers(rootEl);
        }
      },
      dispose: function dispose() {
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
