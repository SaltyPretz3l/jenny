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

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var textField = resolveDependency
    ? resolveDependency('inventoryTextField', '../../inventory/text-field')
    : (root && root.inventoryTextField);

  function buildBodyHtml(currentPath, status, inlineError) {
    var path = String(currentPath || '').trim();
    var workspaceStatus = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
    var statusMessage = String(workspaceStatus.message || 'This is where Jenny treats files as your project.');
    var inputHtml = textField ? textField({
      id: 'setup-workspace-root-path',
      label: 'Current workspace root',
      value: path,
      placeholder: 'No workspace root chosen yet.',
      readonly: true,
      hint: statusMessage,
    }) : '<p>No inventory text field available.</p>';
    return ''
      + '<div class="setup-scene-body">'
      + inputHtml
      + '<p class="setup-scene-note">Pick a folder. You can change this later in Settings.</p>'
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
        ? { state: 'ready', message: 'Workspace root is configured.' }
        : { state: 'missing', message: 'No workspace root is configured yet.' };
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
        { id: 'cancel', label: 'Cancel', variant: 'secondary', disabled: actionInFlight },
        setupState.toolsWorkspaceRoot
          ? { id: 'clear', label: 'Clear', variant: 'secondary', disabled: actionInFlight }
          : null,
        { id: 'browse', label: actionInFlight ? 'Working…' : 'Choose folder…', variant: 'primary', disabled: actionInFlight },
        { id: 'skip', label: 'Skip for now', variant: 'ghost', disabled: actionInFlight },
      ].filter(Boolean);
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: 'Choose workspace root',
        eyebrow: sceneUtils.setupStepEyebrow('workspaceRoot'),
        summary: 'Tell Jenny where your project lives.',
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
        inlineError = 'Workspace picker is unavailable.';
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
          inlineError = String(result.message || result.error || 'The workspace root change is already in progress.');
          render();
          return;
        }
        var transition = result?.transition || result;
        if (transition?.committed === false && transition?.noop !== true) {
          inlineError = String(transition.message || transition.error || 'The workspace root was not changed.');
          render();
          return;
        }
        var nextStatus = applyWorkspaceRootPayload(result);
        if (!nextStatus || nextStatus.state !== 'ready') {
          inlineError = String(nextStatus?.message || 'Choose an existing folder before completing setup.');
          render();
          return;
        }
        await markStep('workspaceRoot', 'done');
        if (staleGeneration(myGeneration)) {
          return;
        }
        showToastMessage('Workspace root saved.');
        closeModal();
      } catch (error) {
        if (staleGeneration(myGeneration)) {
          return;
        }
        appendClientLog('WARN', 'setup.workspace_root_choose_failed', {
          message: error && error.message ? error.message : String(error),
        });
        inlineError = String(error && error.message ? error.message : 'Could not save workspace root.');
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
        inlineError = String(error && error.message ? error.message : 'Could not skip this setup step.');
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
        inlineError = 'Workspace clearing is unavailable.';
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
            inlineError = String(result.message || result.error || 'The workspace root change is already in progress.');
          }
          return;
        }
        var transition = result?.transition || result;
        if (transition?.committed === false && transition?.noop !== true) {
          inlineError = String(transition.message || transition.error || 'The workspace root was not cleared.');
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
        showToastMessage('Workspace root cleared.');
      } catch (error) {
        if (staleGeneration(myGeneration)) {
          return;
        }
        appendClientLog('WARN', 'setup.workspace_root_clear_failed', {
          message: error && error.message ? error.message : String(error),
        });
        inlineError = String(error && error.message ? error.message : 'Could not clear workspace root.');
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
