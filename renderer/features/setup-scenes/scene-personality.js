/**
 * renderer/features/setup-scenes/scene-personality.js
 *
 * Setup scene - personality and name. Renders the shared personality form and
 * saves through the same `personality.save` IPC Settings uses, so the wizard
 * and Settings cannot drift. The name is also mirrored into the setup state
 * when the host provides `applyAssistantIdentity`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupScenePersonality = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var identityForm = resolveDependency
    ? resolveDependency('personalityForm', '../personality-form') : null;

  function buildBodyHtml(viewState) {
    return ''
      + '<div class="setup-scene-body">'
      + '<div class="personality-grid">'
      + (identityForm ? identityForm.render(viewState, {
        idPrefix: 'setup-personality',
        compact: true,
      }) : '')
      + '</div></div>';
  }

  function readInputs(rootEl, fallback) {
    return identityForm
      ? identityForm.read(rootEl, { idPrefix: 'setup-personality', fallback: fallback })
      : fallback;
  }

  function createScene(deps) {
    var d = deps || {};
    var setupState = d.state || {};
    var applyAssistantIdentity = typeof d.applyAssistantIdentity === 'function' ? d.applyAssistantIdentity : null;
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(); };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : function () {};
    var showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};

    var modalId = 'setup-personality';
    var rootEl = null;
    var unbindClicks = null;

    var windowRef = d.windowRef || (typeof window !== 'undefined' ? window : null);
    var identity = setupState.assistantIdentity || {};
    var viewState = {
      agentName: identity.agentName || 'Jenny',
      personality: '',
      user: '',
    };
    /*
     * What the workspace held when this step opened. Re-running setup must not
     * wipe a personality the owner already wrote: an untouched field is omitted
     * from the save payload entirely (a missing key leaves that file alone),
     * and if the load fails the baseline stays '' so both fields stay omitted.
     */
    var baseline = { personality: '', user: '' };

    function personalityApi() {
      var shell = windowRef && windowRef.jennyShell ? windowRef.jennyShell : null;
      return shell && shell.personality ? shell.personality : null;
    }

    async function loadExisting() {
      var api = personalityApi();
      if (!api || typeof api.getState !== 'function') return;
      try {
        var snapshot = await api.getState();
        if (!rootEl) return;
        var current = identityForm ? identityForm.normalize(snapshot) : null;
        if (!current) return;
        baseline = { personality: current.personality, user: current.user };
        // The load resolves after mount, so anything already typed wins over
        // the disk copy for that field.
        var typed = readInputs(rootEl, viewState);
        viewState = {
          agentName: typed.agentName !== viewState.agentName ? typed.agentName : (current.agentName || viewState.agentName),
          personality: typed.personality !== viewState.personality ? typed.personality : current.personality,
          user: typed.user !== viewState.user ? typed.user : current.user,
        };
        render();
      } catch (error) {
        // The form stays usable on its seeded values; the save path still omits
        // untouched fields, so a failed load can never blank the files.
        appendClientLog('WARN', 'setup.personality_load_failed', {
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    function render() {
      if (!rootEl) return;
      var actions = [
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'save', label: 'Save', variant: 'primary' },
        { id: 'skip', label: 'Skip for now', variant: 'ghost' },
      ];
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: 'Personality and name',
        eyebrow: sceneUtils.setupStepEyebrow('personality'),
        summary: 'Give the assistant a name and say how it should sound. '
          + 'You can change this any time in Settings.',
        bodyHtml: buildBodyHtml(viewState),
        actions: actions,
      }) : '';
      rootEl.innerHTML = html;
    }

    /** Only fields the owner actually changed travel in the save payload. */
    function buildSavePayload(next) {
      var payload = { agentName: next.agentName };
      if (next.personality !== baseline.personality) payload.personality = next.personality;
      if (next.user !== baseline.user) payload.user = next.user;
      return payload;
    }

    async function handleSave() {
      var next = readInputs(rootEl, viewState);
      viewState = next;
      try {
        var api = personalityApi();
        if (!api || typeof api.save !== 'function') {
          throw new Error('The personality save bridge is unavailable.');
        }
        var result = await api.save(buildSavePayload(next));
        if (!result || result.ok !== true) {
          throw new Error('The personality save was not acknowledged.');
        }
        if (typeof applyAssistantIdentity === 'function') {
          await applyAssistantIdentity({ agentName: next.agentName });
        }
        await markStep('personality', 'done');
        showToastMessage('Personality saved.');
        closeModal();
      } catch (error) {
        appendClientLog('WARN', 'setup.personality_save_failed', {
          message: error && error.message ? error.message : String(error),
        });
        showShellErrorToast('Could not save personality.', { title: 'Setup Step Failed' });
      }
    }

    async function handleSkip() {
      try {
        await markStep('personality', 'skipped');
        closeModal();
      } catch (_error) { /* toasted */ }
    }

    /*
     * Wizard preset picks always fill silently: the note starts empty here, so
     * there is never owner-written text to protect. Settings owns the
     * Replace/Keep confirm for the case where there is.
     */
    function onVoiceChange(event) {
      if (!rootEl || !identityForm) return;
      var detail = (event && event.detail) || {};
      var sentence = identityForm.PRESETS[String(detail.value || '')];
      if (!sentence) return;
      var noteEl = rootEl.querySelector('#' + identityForm.fieldId('setup-personality', 'note'));
      if (noteEl) noteEl.value = sentence;
      viewState = readInputs(rootEl, viewState);
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        render();
        loadExisting();
        if (rootEl && typeof rootEl.addEventListener === 'function') {
          rootEl.addEventListener('inv-segmented-change', onVoiceChange);
        }
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: closeModal,
              save: handleSave,
              skip: handleSkip,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.personality_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
      },
      dispose: function dispose() {
        if (typeof unbindClicks === 'function') {
          unbindClicks();
          unbindClicks = null;
        }
        if (rootEl && typeof rootEl.removeEventListener === 'function') {
          rootEl.removeEventListener('inv-segmented-change', onVoiceChange);
        }
        rootEl = null;
      },
    };
  }

  return {
    createScene: createScene,
  };
});
