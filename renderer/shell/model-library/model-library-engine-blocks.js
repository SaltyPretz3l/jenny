/**
 * Model Library › engine blocks (UMD).
 *
 * The optional blocks under the model grid that each follow a kill switch:
 * the Image engine (`tools_image_generate_enabled`) and the managed NInfer
 * runtime (`ninfer`, row 54). The section controller owns the grid; this
 * helper owns the two block controllers (creation behind their flags, a
 * rebind on every parent render, teardown) so the section stays under its
 * line ceiling and both blocks follow one lifecycle.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.modelLibraryEngineBlocks = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var IMAGE_ENGINE_HOST_ID = 'modelLibraryImageEngineHost';
  var NINFER_HOST_ID = 'modelLibraryNinferHost';

  function resolveImageEngineModule() {
    return (root && root.modelLibraryImageEngine)
      || (typeof require === 'function' ? require('./model-library-image-engine') : null);
  }

  function resolveNinferModule() {
    return (root && root.modelLibraryNinfer)
      || (typeof require === 'function' ? require('./model-library-ninfer') : null);
  }

  // deps: { windowRef, documentRef, imageEngineEnabled(), ninferEnabled(), ninfer: { onState, onUse } }
  function createModelLibraryEngineBlocks(deps) {
    var d = deps || {};
    var disposed = false;
    var imageEngineEnabled = typeof d.imageEngineEnabled === 'function' ? d.imageEngineEnabled : function () { return false; };
    var ninferEnabled = typeof d.ninferEnabled === 'function' ? d.ninferEnabled : function () { return false; };
    var blocks = {
      imageEngine: { controller: null, enabled: imageEngineEnabled, hostId: IMAGE_ENGINE_HOST_ID, create: createImageEngine },
      ninfer: { controller: null, enabled: ninferEnabled, hostId: NINFER_HOST_ID, create: createNinfer },
    };

    function createImageEngine() {
      var module = resolveImageEngineModule();
      if (!module || typeof module.createModelLibraryImageEngineController !== 'function') return null;
      return module.createModelLibraryImageEngineController({
        windowRef: d.windowRef, documentRef: d.documentRef, isEnabled: imageEngineEnabled, hostId: IMAGE_ENGINE_HOST_ID,
      });
    }

    function createNinfer() {
      var module = resolveNinferModule();
      if (!module || typeof module.createModelLibraryNinferController !== 'function') return null;
      var ninferDeps = d.ninfer || {};
      return module.createModelLibraryNinferController({
        windowRef: d.windowRef, documentRef: d.documentRef, isEnabled: ninferEnabled, hostId: NINFER_HOST_ID,
        onState: ninferDeps.onState, onUse: ninferDeps.onUse,
      });
    }

    // The host divs the section renders into its extras host (NInfer sits
    // above the Image engine: a chat engine before the image one).
    function hostsHtml() {
      return (ninferEnabled() ? '<div id="' + NINFER_HOST_ID + '"></div>' : '')
        + (imageEngineEnabled() ? '<div id="' + IMAGE_ENGINE_HOST_ID + '"></div>' : '');
    }

    function controllerFor(block) {
      if (disposed || !block.enabled()) return null;
      if (!block.controller) block.controller = block.create();
      return block.controller;
    }

    function renderBlock(block) {
      var controller = controllerFor(block);
      if (!controller) {
        // The flag went off: drop the controller and its bridge subscription.
        if (block.controller) block.controller.dispose();
        block.controller = null;
        return;
      }
      controller.bind();
      controller.render();
    }

    function render() {
      renderBlock(blocks.ninfer);
      renderBlock(blocks.imageEngine);
    }

    function ninfer() {
      return controllerFor(blocks.ninfer);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      Object.keys(blocks).forEach(function (key) {
        if (blocks[key].controller) blocks[key].controller.dispose();
        blocks[key].controller = null;
      });
    }

    return { hostsHtml: hostsHtml, render: render, ninfer: ninfer, dispose: dispose };
  }

  return { createModelLibraryEngineBlocks: createModelLibraryEngineBlocks, NINFER_HOST_ID: NINFER_HOST_ID, IMAGE_ENGINE_HOST_ID: IMAGE_ENGINE_HOST_ID };
});
