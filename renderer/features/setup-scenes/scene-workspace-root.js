/**
 * renderer/features/setup-scenes/scene-workspace-root.js
 *
 * Workspace-root chooser using the injected root-transition facade.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneWorkspaceRoot = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var textField = resolveDependency
    ? resolveDependency('inventoryTextField', '../../inventory/text-field')
    : (root && root.inventoryTextField);

  function buildBodyHtml(currentPath, status, inlineError) {
    var path = String(currentPath || '').trim();
    var workspaceStatus = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
    var statusMessage = String(workspaceStatus.message || jt('setup.workspaceRoot.projectLocationHint', 'This is where Jenny treats files as your project.'));
    var inputHtml = textField ? textField({
      id: 'setup-workspace-root-path',
      label: jt('setup.workspaceRoot.currentLabel', 'Current workspace root'),
      value: path,
      placeholder: jt('setup.workspaceRoot.noneChosen', 'No workspace root chosen yet.'),
      readonly: true,
      dataset: { ltr: 'true' },
      hint: statusMessage,
    }) : '<p>' + sceneUtils.escapeHtml(jt('setup.workspaceRoot.textFieldUnavailable', 'No inventory text field available.')) + '</p>';
    return ''
      + '<div class="setup-scene-body">'
      + inputHtml
      + '<p class="setup-scene-note">' + sceneUtils.escapeHtml(jt('setup.workspaceRoot.pickFolderNote', 'Pick a folder. You can change this later in Settings.')) + '</p>'
      + (inlineError
        ? '<p class="setup-workspace-inline-error" role="alert">' + sceneUtils.escapeHtml(inlineError) + '</p>'
        : '')
      + '</div>';
  }

  function projectWorkspaceRootPayload(result, previousPath) {
    var source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    var workspaceRoot = source.workspaceRoot && typeof source.workspaceRoot === 'object'
      && !Array.isArray(source.workspaceRoot)
      ? source.workspaceRoot
      : source;
    var transition = source.transition && typeof source.transition === 'object'
      && !Array.isArray(source.transition)
      ? source.transition
      : source;
    var context = transition.context && typeof transition.context === 'object'
      && !Array.isArray(transition.context)
      ? transition.context
      : {};
    var contextOwnsPath = Object.prototype.hasOwnProperty.call(context, 'rootPath');
    var path = String(
      contextOwnsPath
        ? context.rootPath || ''
        : workspaceRoot.workspaceRoot || workspaceRoot.path || previousPath || ''
    ).trim();
    var status = workspaceRoot.workspaceRootStatus || workspaceRoot.status || null;
    if (!status || typeof status !== 'object' || Array.isArray(status) || contextOwnsPath) {
      status = path
        ? { state: 'ready', message: jt('setup.workspaceRoot.configured', 'Workspace root is configured.') }
        : { state: 'missing', message: jt('setup.workspaceRoot.notConfigured', 'No workspace root is configured yet.') };
    }
    return { path: path, status: status };
  }

  function createScene(deps) {
    var d = deps || {};
    var setupState = d.state || {};
    var workspaceRootService = d.workspaceRootService || null;
    var chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function'
      ? d.chooseWorkspaceRoot
      : (d.workspaceRootService && typeof d.workspaceRootService.choose === 'function'
        ? function chooseFromService() { return d.workspaceRootService.choose(); }
        : null);
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(); };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};

    var modalId = 'setup-workspace-root';
    var unbind = null;
    var rootEl = null;
    var generation = 0;
    var actionInFlight = false;
    var inlineError = '';

    function staleGeneration(myGeneration) {
      return !rootEl || generation !== myGeneration;
    }

    function applyWorkspaceRootPayload(result) {
      var projection = projectWorkspaceRootPayload(result, setupState.toolsWorkspaceRoot);
      setupState.toolsWorkspaceRoot = projection.path;
      setupState.toolsWorkspaceRootConfigured = projection.status.state === 'ready';
      setupState.workspaceRootStatus = projection.status;
      return setupState.workspaceRootStatus;
    }

    function render() {
      if (!rootEl) return;
      var actions = [
        { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary', disabled: actionInFlight },
        setupState.toolsWorkspaceRoot
          ? { id: 'clear', label: jt('common.clear', 'Clear'), variant: 'secondary', disabled: actionInFlight }
          : null,
        { id: 'browse', label: actionInFlight ? jt('setup.workspaceRoot.working', 'Working…') : jt('setup.workspaceRoot.chooseFolder', 'Choose folder…'), variant: 'primary', disabled: actionInFlight },
        { id: 'skip', label: jt('setup.workspaceRoot.skipForNow', 'Skip for now'), variant: 'ghost', disabled: actionInFlight },
      ].filter(Boolean);
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: jt('setup.workspaceRoot.title', 'Choose workspace root'),
        eyebrow: sceneUtils.setupStepEyebrow('workspaceRoot'),
        summary: jt('setup.workspaceRoot.summary', 'Tell Jenny where your project lives.'),
        bodyHtml: buildBodyHtml(setupState.toolsWorkspaceRoot || '', setupState.workspaceRootStatus, inlineError),
        actions: actions,
      }) : '';
      rootEl.innerHTML = html;
    }

    async function refreshWorkspaceRootState() {
      var myGeneration = generation;
      if (!workspaceRootService || typeof workspaceRootService.getState !== 'function') {
        return;
      }
      try {
        var snapshot = await workspaceRootService.getState();
        if (staleGeneration(myGeneration)) {
          return;
        }
        applyWorkspaceRootPayload(snapshot);
        render();
      } catch (error) {
        if (staleGeneration(myGeneration)) {
          return;
        }
        appendClientLog('WARN', 'setup.workspace_root_state_failed', {
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    async function handleBrowse() {
      if (actionInFlight) return;
      var myGeneration = ++generation;
      actionInFlight = true;
      inlineError = '';
      render();
      if (typeof chooseWorkspaceRoot !== 'function') {
        inlineError = jt('setup.workspaceRoot.pickerUnavailable', 'Workspace picker is unavailable.');
        actionInFlight = false;
        render();
        return;
      }
      try {
        var result = await chooseWorkspaceRoot();
        if (staleGeneration(myGeneration)) {
          return;
        }
        var canceled = result && (result.canceled === true || result.cancelled === true);
        if (canceled) {
          return;
        }
        if (result?.blocked === true) {
          inlineError = String(result.message || result.error || jt('setup.workspaceRoot.changeInProgress', 'The workspace root change is already in progress.'));
          render();
          return;
        }
        var transition = result?.transition || result;
        if (transition?.committed === false && transition?.noop !== true) {
          inlineError = String(transition.message || transition.error || jt('setup.workspaceRoot.notChanged', 'The workspace root was not changed.'));
          render();
          return;
        }
        var nextStatus = applyWorkspaceRootPayload(result);
        if (!nextStatus || nextStatus.state !== 'ready') {
          inlineError = String(nextStatus?.message || jt('setup.workspaceRoot.chooseExistingFolder', 'Choose an existing folder before completing setup.'));
          render();
          return;
        }
        await markStep('workspaceRoot', 'done');
        if (staleGeneration(myGeneration)) {
          return;
        }
        showToastMessage(jt('setup.workspaceRoot.saved', 'Workspace root saved.'));
        closeModal();
      } catch (error) {
        if (staleGeneration(myGeneration)) {
          return;
        }
        appendClientLog('WARN', 'setup.workspace_root_choose_failed', {
          message: error && error.message ? error.message : String(error),
        });
        inlineError = String(error && error.message ? error.message : jt('setup.workspaceRoot.saveFailed', 'Could not save workspace root.'));
      } finally {
        if (!staleGeneration(myGeneration)) {
          actionInFlight = false;
          render();
        }
      }
    }

    async function handleSkip() {
      if (actionInFlight) return;
      var myGeneration = ++generation;
      actionInFlight = true;
      inlineError = '';
      render();
      try {
        await markStep('workspaceRoot', 'skipped');
        if (staleGeneration(myGeneration)) {
          return;
        }
        closeModal();
      } catch (error) {
        if (staleGeneration(myGeneration)) {
          return;
        }
        inlineError = String(error && error.message ? error.message : jt('setup.workspaceRoot.skipFailed', 'Could not skip this setup step.'));
      } finally {
        if (!staleGeneration(myGeneration)) {
          actionInFlight = false;
          render();
        }
      }
    }

    async function handleClear() {
      if (actionInFlight) return;
      var myGeneration = ++generation;
      actionInFlight = true;
      inlineError = '';
      render();
      if (!workspaceRootService || typeof workspaceRootService.clear !== 'function') {
        inlineError = jt('setup.workspaceRoot.clearingUnavailable', 'Workspace clearing is unavailable.');
        actionInFlight = false;
        render();
        return;
      }
      try {
        var result = await workspaceRootService.clear();
        if (staleGeneration(myGeneration)) {
          return;
        }
        var canceled = result && (result.canceled === true || result.cancelled === true);
        if (canceled || result?.blocked === true) {
          if (result?.blocked === true) {
            inlineError = String(result.message || result.error || jt('setup.workspaceRoot.changeInProgress', 'The workspace root change is already in progress.'));
          }
          return;
        }
        var transition = result?.transition || result;
        if (transition?.committed === false && transition?.noop !== true) {
          inlineError = String(transition.message || transition.error || jt('setup.workspaceRoot.notCleared', 'The workspace root was not cleared.'));
          return;
        }
        applyWorkspaceRootPayload(result);
        render();
        try {
          await markStep('workspaceRoot', 'pending');
        } catch (_error) { /* markStep owns its persistence toast */ }
        if (staleGeneration(myGeneration)) {
          return;
        }
        showToastMessage(jt('setup.workspaceRoot.cleared', 'Workspace root cleared.'));
      } catch (error) {
        if (staleGeneration(myGeneration)) {
          return;
        }
        appendClientLog('WARN', 'setup.workspace_root_clear_failed', {
          message: error && error.message ? error.message : String(error),
        });
        inlineError = String(error && error.message ? error.message : jt('setup.workspaceRoot.clearFailed', 'Could not clear workspace root.'));
      } finally {
        if (!staleGeneration(myGeneration)) {
          actionInFlight = false;
          render();
        }
      }
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        generation += 1;
        render();
        refreshWorkspaceRootState();
        unbind = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: function () { if (!actionInFlight) closeModal(); },
              browse: handleBrowse,
              clear: handleClear,
              skip: handleSkip,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.workspace_root_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
      },
      dispose: function dispose() {
        generation += 1;
        if (typeof unbind === 'function') {
          unbind();
          unbind = null;
        }
        rootEl = null;
        actionInFlight = false;
        inlineError = '';
      },
    };
  }

  return { createScene: createScene, projectWorkspaceRootPayload: projectWorkspaceRootPayload };
});
