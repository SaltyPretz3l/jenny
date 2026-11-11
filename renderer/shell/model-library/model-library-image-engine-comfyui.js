/**
 * Model Library › Image engine › ComfyUI (UMD): pure markup and payload helpers
 * for the ComfyUI block and the Model sets list. No path leaves the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../../inventory/action-button'),
      require('../../inventory/status-row'),
      require('../../inventory/select-field')
    );
    return;
  }
  root.modelLibraryImageEngineComfyui = factory(root.inventoryActionButton, root.inventoryStatusRow, root.inventorySelectField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, statusRow, selectField) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var SLOT_PREFIX = 'comfy:';
  // A UNC, relative or device path.
  var NETWORK_REASONS = ['image_engine_path_rejected', 'root_not_local_path'];

  if (typeof actionButton !== 'function' || typeof actionButton.escapeHtml !== 'function'
    || typeof statusRow !== 'function' || typeof selectField !== 'function') {
    throw new Error('model-library-image-engine-comfyui: missing required dependency');
  }
  var escapeHtml = actionButton.escapeHtml;

  function gigabytes(bytes) {
    var value = Number(bytes);
    return Number.isFinite(value) && value > 0 ? (value / 1073741824).toFixed(1) : '0.0';
  }

  function sizeLabel(bytes) {
    return jt('models.library.imageEngine.gigabytes', '{size} GB', { size: gigabytes(bytes) });
  }

  function quantOf(name) {
    var match = /(Q\d[A-Z0-9_]*|IQ\d[A-Z0-9_]*|BF16|F16|F32|FP8|INT8|NVFP4|W4A8)/i.exec(String(name || ''));
    return match ? match[1].toUpperCase() : '';
  }

  function networkMessage() {
    return jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.');
  }

  // The three files a recipe needs, with the sentence that names each.
  var SLOTS = [
    { id: 'diffusion', folder: 'diffusion_models' },
    { id: 'text_encoder', folder: 'text_encoders' },
    { id: 'vae', folder: 'vae' },
  ];

  function slotLabel(slot) {
    if (slot === 'diffusion') return jt('models.library.imageEngine.slotDiffusion', 'Diffusion model');
    return slot === 'text_encoder' ? jt('models.library.imageEngine.slotEncoder', 'Text encoder') : jt('models.library.imageEngine.slotVae', 'VAE');
  }

  function matchLabel(slot, count) {
    if (slot === 'diffusion') return jt('models.library.imageEngine.comfyui.matchDiffusion', '{count} diffusion models match', { count: count });
    return slot === 'text_encoder' ? jt('models.library.imageEngine.comfyui.matchEncoder', '{count} text encoders match', { count: count })
      : jt('models.library.imageEngine.comfyui.matchVae', '{count} VAEs match', { count: count });
  }

  function candidates(recipe, slot) {
    return recipe && recipe.slots && Array.isArray(recipe.slots[slot]) ? recipe.slots[slot] : [];
  }

  // The user's pick while it names a found file, else the first match.
  function pickName(picks, recipeId, slot, list) {
    var want = picks[recipeId] && picks[recipeId][slot];
    if (list.some(function (file) { return file.name === want; })) return want;
    return list.length ? list[0].name : '';
  }

  function chosenBytes(picks, recipeId, recipe) {
    return SLOTS.reduce(function (total, slot) {
      var list = candidates(recipe, slot.id);
      var name = pickName(picks, recipeId, slot.id, list);
      var file = list.filter(function (entry) { return entry.name === name; })[0];
      return total + (file && Number.isFinite(Number(file.size_bytes)) ? Number(file.size_bytes) : 0);
    }, 0);
  }

  // The add-set payload, or null while a slot is empty. Names only.
  function savePayload(comfyui, picks, recipeId) {
    var health = comfyui && comfyui.health;
    var recipe = health && health.recipes ? health.recipes[recipeId] : null;
    if (!recipe) return null;
    var payload = { recipe: recipeId };
    for (var i = 0; i < SLOTS.length; i += 1) {
      var name = pickName(picks, recipeId, SLOTS[i].id, candidates(recipe, SLOTS[i].id));
      if (!name) return null;
      payload[SLOTS[i].id] = name;
    }
    return payload;
  }

  // `comfy:<recipe>:<slot>` rides on the slot attribute of a picker.
  function parseSlot(attribute) {
    var parts = String(attribute || '').split(':');
    return parts.length === 3 && parts[0] + ':' === SLOT_PREFIX ? { recipe: parts[1], slot: parts[2] } : null;
  }

  function saveFailureMessage(reason) {
    switch (reason) {
      case 'unknown_recipe':
      case 'recipe_file_mismatch':
      case 'file_missing':
        return jt('models.library.imageEngine.comfyui.saveStale', 'Those files changed since the check. Check again.');
      case 'too_many_sets': return jt('models.library.imageEngine.saveTooMany', 'Remove a saved set first (16 at most).');
      default: return jt('models.library.imageEngine.saveFailed', 'The model set could not be saved.');
    }
  }

  function chooseFailureMessage(reason) {
    if (reason === 'cancelled') return '';
    if (NETWORK_REASONS.indexOf(reason) >= 0) return networkMessage();
    if (reason === 'comfyui_folder_invalid') return jt('models.library.imageEngine.comfyui.refused', 'That is not a ComfyUI portable folder. Pick the folder that holds run_nvidia_gpu.bat.');
    return jt('models.library.imageEngine.scanFailed', 'Could not read that folder.');
  }

  function empty(text) {
    return '<span class="model-library-folders-empty">' + escapeHtml(text) + '</span>';
  }

  function subtitle(text) {
    return '<span class="model-library-image-engine-subtitle">' + escapeHtml(text) + '</span>';
  }

  function statusOf(health, checking) {
    if (checking) return { tone: 'pending', spinner: true, message: jt('models.library.imageEngine.comfyui.checking', 'Checking the folder…') };
    if (!health) return { tone: 'default', message: jt('models.library.imageEngine.comfyui.notSetUp', 'Not set up') };
    if (!health.ok) {
      return { tone: 'danger', message: NETWORK_REASONS.indexOf(health.reason) >= 0 ? networkMessage()
        : jt('models.library.imageEngine.comfyui.notPortable', 'Not a ComfyUI portable folder · python_embeded and ComfyUI\\main.py were not found') };
    }
    var recipes = health.recipes || {};
    var old = Object.keys(recipes).filter(function (id) { return recipes[id].version_ok === false; })[0];
    if (old) {
      return { tone: 'warning', message: jt('models.library.imageEngine.comfyui.tooOld', 'ComfyUI {version} · {recipe} needs {min} or newer',
        { version: health.version, recipe: recipes[old].label, min: recipes[old].min_version }) };
    }
    return { tone: 'success', message: health.version
      ? jt('models.library.imageEngine.comfyui.ready', 'ComfyUI {version} · portable', { version: health.version })
      : jt('models.library.imageEngine.comfyui.readyUnknown', 'ComfyUI · portable') };
  }

  function folderLine(ctx, health) {
    return '<div class="model-library-image-engine-folder">'
      + (health ? '<code class="model-library-folders-path">' + escapeHtml(health.folder) + '</code>' : '')
      + ctx.button('choose-comfy-folder', health ? jt('models.library.imageEngine.comfyui.changeFolder', 'Change folder…') : jt('models.library.imageEngine.comfyui.chooseFolder', 'Choose ComfyUI folder…'))
      + (health ? ctx.button('check-comfy-folder', jt('models.library.imageEngine.comfyui.checkAgain', 'Check again'), 'ghost') : '')
      + '</div>';
  }

  function recipeLine(ctx, id, recipe) {
    var meta;
    var action = '';
    var pickers = '';
    var steps = recipe.steps;
    var size = sizeLabel(chosenBytes(ctx.picks, id, recipe));
    var missing = SLOTS.filter(function (slot) { return !candidates(recipe, slot.id).length; })[0];
    var several = SLOTS.filter(function (slot) { return candidates(recipe, slot.id).length > 1; });
    var add = function (extra) { return ctx.button('add-comfy-set', jt('models.library.imageEngine.comfyui.addSet', 'Add set'), extra ? 'secondary' : 'primary', Object.assign({ dataset: { 'image-engine-action': 'add-comfy-set', 'image-engine-set': id } }, extra)); };
    if (recipe.version_ok === false) {
      meta = jt('models.library.imageEngine.comfyui.updateFirst', 'Update ComfyUI first (update\\update_comfyui.bat), then Check again.');
    } else if (recipe.added) {
      var saved = (ctx.sets || []).filter(function (set) { return set.backend === 'comfyui' && set.recipe === id; })[0];
      meta = jt('models.library.imageEngine.comfyui.added', 'Added · {size} · {steps} steps, fixed', { size: saved ? sizeLabel(setBytes(saved)) : size, steps: steps });
    } else if (missing) {
      meta = jt('models.library.imageEngine.comfyui.missing', '{slot} missing · add it to models\\{folder}', { slot: slotLabel(missing.id), folder: missing.folder });
      action = add({ disabled: true });
    } else {
      meta = several.length
        ? jt('models.library.imageEngine.comfyui.pickOne', '{matches} · pick one · {size}', { matches: several.map(function (slot) { return matchLabel(slot.id, candidates(recipe, slot.id).length); }).join(', '), size: size })
        : jt('models.library.imageEngine.comfyui.allFound', 'All 3 files found · {size} · {steps} steps, fixed', { size: size, steps: steps });
      action = add();
      pickers = several.length ? '<div class="model-library-image-engine-slots">' + several.map(function (slot) {
        var list = candidates(recipe, slot.id);
        return selectField({
          id: 'imageEngineComfy-' + id + '-' + slot.id, label: slotLabel(slot.id), value: pickName(ctx.picks, id, slot.id, list),
          options: list.map(function (file) { return { value: file.name, label: file.name + ' · ' + sizeLabel(file.size_bytes) }; }),
          disabled: ctx.pending, dataset: { 'image-engine-slot': SLOT_PREFIX + id + ':' + slot.id },
        });
      }).join('') + '</div>' : '';
    }
    return '<div class="model-library-image-engine-recipe"><div class="model-library-image-engine-recipe-text">'
      + '<span class="model-library-image-engine-set-name">' + escapeHtml(recipe.label || id) + '</span>'
      + '<span class="model-library-image-engine-set-meta">' + escapeHtml(meta) + '</span></div>' + action + '</div>' + pickers
      + (recipe.truncated ? empty(jt('models.library.imageEngine.truncated', 'The folder has more files than Jenny lists. Move the model files nearer the top.')) : '');
  }

  // ctx: { comfyui, sets, picks, checking, pending, button }
  function blockMarkup(ctx) {
    var comfyui = ctx.comfyui;
    if (!comfyui || comfyui.enabled !== true) return '';
    var health = comfyui.health || null;
    var status = statusOf(health, ctx.checking);
    var html = subtitle(jt('models.library.imageEngine.comfyui.title', 'ComfyUI'))
      + statusRow({ tone: status.tone, spinner: status.spinner === true, compact: true, label: jt('models.library.imageEngine.statusLabel', 'Status'),
        message: status.message, className: 'model-library-image-engine-status model-library-image-engine-comfy-status' })
      + folderLine(ctx, health);
    if (!health) return html + empty(jt('models.library.imageEngine.comfyui.chooseHint', 'Choose the ComfyUI_windows_portable folder you already use. Jenny reads its models folder and never changes it.'));
    if (!health.ok) return html + empty(jt('models.library.imageEngine.comfyui.invalidHint', 'Pick the folder that holds run_nvidia_gpu.bat. Installs made with git are not supported yet.'));
    var recipes = health.recipes || {};
    return html + Object.keys(recipes).map(function (id) { return recipeLine(ctx, id, recipes[id]); }).join('')
      + empty(jt('models.library.imageEngine.comfyui.footnote', 'For each image Jenny starts this ComfyUI in the background without custom nodes, then closes it. A ComfyUI window you have open is left alone.'));
  }

  // A ComfyUI set with no stored label reads as its recipe and quant.
  function setLabel(set, recipes, familyLabel) {
    if (set.label) return set.label;
    var quant = quantOf(set.files && set.files.diffusion ? set.files.diffusion.name : '');
    var base = set.backend === 'comfyui' ? (recipes && recipes[set.recipe] && recipes[set.recipe].label) || String(set.recipe || '') : familyLabel(set.family);
    return quant ? base + ' · ' + quant : base;
  }

  function setBytes(set) {
    var files = set.files || {};
    return Object.keys(files).reduce(function (total, slot) {
      var entry = files[slot];
      return total + (entry && Number.isFinite(Number(entry.size_bytes)) ? Number(entry.size_bytes) : 0);
    }, 0);
  }

  // ctx: { sets, defaultId, recipes, familyLabel, button }
  function setsMarkup(ctx) {
    var html = subtitle(jt('models.library.imageEngine.setsTitle', 'Model sets'));
    if (!ctx.sets.length) return html + empty(jt('models.library.imageEngine.noSets', 'No sets yet · a set is one diffusion model, its text encoder and its VAE.'));
    return html + '<div class="model-library-image-engine-sets">' + ctx.sets.map(function (set) {
      var isDefault = set.id === ctx.defaultId;
      var engine = set.backend === 'comfyui' ? jt('models.library.imageEngine.comfyui.title', 'ComfyUI') : jt('models.library.imageEngine.sdcppTitle', 'stable-diffusion.cpp');
      return '<div class="model-library-image-engine-set" data-image-engine-set="' + escapeHtml(set.id) + '">'
        + '<div class="model-library-image-engine-set-text">'
        + '<span class="model-library-image-engine-set-name">' + escapeHtml(setLabel(set, ctx.recipes, ctx.familyLabel)) + '</span>'
        + '<span class="model-library-image-engine-set-meta">' + escapeHtml(jt('models.library.imageEngine.comfyui.setMeta', '{engine} · {size}', { engine: engine, size: sizeLabel(setBytes(set)) }))
        + (isDefault ? ' · <span class="model-library-image-engine-default">' + escapeHtml(jt('models.library.imageEngine.default', 'Default')) + '</span>' : '')
        + '</span></div>'
        + (isDefault ? '<span></span>' : ctx.button('make-default', jt('models.library.imageEngine.makeDefault', 'Make default'), 'ghost', { dataset: { 'image-engine-action': 'make-default', 'image-engine-set': set.id } }))
        + ctx.button('remove-set', jt('common.remove', 'Remove'), 'ghost', { dataset: { 'image-engine-action': 'remove-set', 'image-engine-set': set.id } })
        + '</div>';
    }).join('') + '</div>'
      + empty(jt('models.library.imageEngine.defaultNote', 'Jenny uses the default set when you ask for an image.'));
  }

  return {
    blockMarkup: blockMarkup, setsMarkup: setsMarkup, quantOf: quantOf, savePayload: savePayload, parseSlot: parseSlot, saveFailureMessage: saveFailureMessage, chooseFailureMessage: chooseFailureMessage,
  };
});
