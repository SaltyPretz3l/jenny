// Tune drawer row grammar: label (with a hover/focus tooltip), a one-line
// description and an optional note on the left, a fixed-width control on the
// right; plus the field copy, the Memory/Replies/Advanced sections and the
// custom context window control. Pure markup: the drawer owns state and events.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererModelTuningRows = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // The sidecar's own auto-compact ratio (sidecar/ai/context/token_budget.py).
  var RATIO_DEFAULT = 0.9;
  var CONTEXT_BOUNDS = { min: 2048, max: 262144 };
  var CUSTOM_CONTEXT = 'custom';
  var ADVANCED_KEYS = ['topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty'];

  function num(value) {
    return Number(value).toLocaleString(globalThis.jennyI18n?.tag?.());
  }

  // label, description and tooltip per field; tooltips name the live bounds.
  function fieldCopy(key, bounds) {
    var b = { min: num(bounds?.min), max: num(bounds?.max) };
    switch (key) {
      case 'contextLength': return {
        label: jt('models.tuning.contextWindow', 'Context window'),
        desc: jt('models.tuning.desc.contextLength', 'How much of the chat the model can see at once.'),
        tip: jt('models.tuning.tip.contextLength', 'How much of the conversation, files and tool output the model can read at once, in tokens (256K is about 190,000 words). Larger remembers more but uses more VRAM. Choose Custom to type any size from {min} to {max}.', b),
      };
      case 'ratio': return {
        label: jt('models.tuning.summarizeAt', 'Summarize at'),
        desc: jt('models.tuning.desc.ratio', 'Older turns are summarized when the window is this full.'),
        tip: jt('models.tuning.tip.ratio', 'When the chat fills this share of the context window, Jenny summarizes older turns to make room. Lower summarizes sooner. {min}–{max}%, default 90%.', b),
      };
      case 'temperature': return {
        label: jt('models.tuning.temperature', 'Temperature'),
        desc: jt('models.tuning.desc.temperature', 'Lower is focused and repeatable, higher is more varied.'),
        tip: jt('models.tuning.tip.temperature', 'How random each word choice is. 0 always picks the most likely word; around 0.7 suits chat; above 1 gets loose. Range {min}–{max}.', b),
      };
      case 'maxOutputTokens': return {
        label: jt('models.tuning.maximumOutput', 'Maximum output'),
        desc: jt('models.tuning.desc.maxOutputTokens', 'Longest reply, in tokens, before it stops.'),
        tip: jt('models.tuning.tip.maxOutputTokens', 'The most tokens one reply may use before the model is stopped (a token is about ¾ of a word). Empty uses the model default. Range {min}–{max}.', b),
      };
      case 'topP': return {
        label: jt('models.tuning.topP', 'Top P'),
        desc: jt('models.tuning.desc.topP', 'Picks only from the likeliest words, adding up to P.'),
        tip: jt('models.tuning.tip.topP', 'Nucleus sampling: the model picks only from the most likely next words whose chances add up to P. 1 turns it off; 0.9 trims unlikely words. Range {min}–{max}.', b),
      };
      case 'topK': return {
        label: jt('models.tuning.topK', 'Top K'),
        desc: jt('models.tuning.desc.topK', 'Picks only from the K likeliest words.'),
        tip: jt('models.tuning.tip.topK', 'The model picks only from the K most likely next words. 0 turns it off; 20–40 is typical. Range {min}–{max}.', b),
      };
      case 'minP': return {
        label: jt('models.tuning.minP', 'Min P'),
        desc: jt('models.tuning.desc.minP', 'Drops words far less likely than the best one.'),
        tip: jt('models.tuning.tip.minP', 'Drops any word less than P times as likely as the top choice. 0 turns it off; 0.05 is a common, tidy setting. Range {min}–{max}.', b),
      };
      case 'repetitionPenalty': return {
        label: jt('models.tuning.repetitionPenalty', 'Repetition penalty'),
        desc: jt('models.tuning.desc.repetitionPenalty', 'Above 1 repeats itself less.'),
        tip: jt('models.tuning.tip.repetitionPenalty', 'Makes words already used less likely. 1 is off; 1.05–1.15 curbs loops; below 1 encourages repeats. Range {min}–{max}.', b),
      };
      case 'presencePenalty': return {
        label: jt('models.tuning.presencePenalty', 'Presence penalty'),
        desc: jt('models.tuning.desc.presencePenalty', 'Above 0 moves on to new words and topics.'),
        tip: jt('models.tuning.tip.presencePenalty', 'A flat push away from any word that has already appeared. 0 is off; positive values add variety, negative values stick to the topic. Range {min}–{max}.', b),
      };
      default: return { label: key, desc: '', tip: '' };
    }
  }

  // actionButton has no `hidden` option: the attribute goes on the button's own tag.
  function hiddenHtml(html) {
    return String(html).replace(/^<(\w+)/, '<$1 hidden');
  }

  // One row. controlHtml and noteHtml-free strings arrive escaped by the caller
  // only where noted: label/desc/tip/note are plain text and escaped here.
  function rowHtml(o) {
    var esc = o.escapeHtml;
    var key = String(o.key || '');
    var revert = o.revertable && typeof o.actionButton === 'function'
      ? hiddenHtml(o.actionButton({
        id: 'revert-model-tuning-field', plain: true, className: 'model-tuning-row-revert', label: '↺',
        ariaLabel: jt('models.tuning.revertAria', 'Clear {field} to use the default', { field: o.label }),
        title: jt('models.tuning.revertTitle', 'Clear to use the default'),
        dataset: { 'model-tuning-revert': key },
      }))
      : '';
    return '<div class="model-tuning-row' + (o.wide ? ' model-tuning-row--wide' : '') + '" data-model-tuning-row="' + esc(key) + '"' + (o.hidden ? ' hidden' : '') + '>'
      + '<div class="model-tuning-row-text"><div class="model-tuning-row-title">'
      + '<span class="model-tuning-row-label"' + (o.labelId ? ' id="' + esc(o.labelId) + '"' : '')
      + (o.tip ? ' data-tooltip="' + esc(o.tip) + '"' : '') + '>' + esc(o.label) + '</span>'
      + '<span class="model-tuning-row-changed" data-model-tuning-changed hidden>' + esc(jt('models.tuning.changed', 'Changed')) + '</span>'
      + revert
      + '</div>'
      + (o.desc ? '<p class="model-tuning-row-desc">' + esc(o.desc) + '</p>' : '')
      + '<p class="model-tuning-row-note" data-model-tuning-note>' + esc(o.note || '') + '</p>'
      + '</div>'
      + '<div class="model-tuning-row-control' + (o.stack ? ' model-tuning-row-control--stack' : '') + '">' + (o.controlHtml || '') + '</div>'
      + '</div>';
  }

  function sectionHtml(esc, title, status, body, attrs) {
    return '<section class="model-tuning-section"' + (attrs || '') + '>'
      + '<h4 class="model-tuning-section-title">' + esc(title) + '</h4>'
      + (status != null ? '<p class="model-tuning-section-status" data-model-tuning-section-status>' + esc(status) + '</p>' : '')
      + body + '</section>';
  }

  function isPresetContext(steps, value) {
    return !value || steps.indexOf(Number(value)) >= 0;
  }

  function contextControlHtml(ctx, value) {
    var steps = ctx.contextSteps;
    var custom = !isPresetContext(steps, value);
    var bounds = ctx.contextBounds || CONTEXT_BOUNDS;
    var label = jt('models.tuning.contextWindow', 'Context window');
    return ctx.selectField({
      id: 'modelTuningContextLength', label: '', ariaLabel: label,
      value: custom ? CUSTOM_CONTEXT : String(value || ''),
      options: [{ value: '', label: jt('models.tuning.modelDefault', 'Model default') }]
        .concat(steps.map(function (step) { return { value: String(step), label: ctx.formatContextLength(step) }; }))
        .concat([{ value: CUSTOM_CONTEXT, label: jt('models.tuning.contextCustom', 'Custom…') }]),
      disabled: ctx.disabled,
      dataset: { 'model-tuning-field': 'contextLength' },
    })
      + '<span class="model-tuning-context-custom" data-model-tuning-context-custom' + (custom ? '' : ' hidden') + '>'
      + ctx.numberInput({
        id: 'modelTuningContextCustom', label: '',
        ariaLabel: jt('models.tuning.contextCustomAria', 'Custom context window, in tokens'),
        value: custom ? String(value) : '', min: bounds.min, max: bounds.max, step: 1, allowEmpty: true,
        placeholder: jt('models.tuning.contextCustomPlaceholder', 'Tokens'), disabled: ctx.disabled,
        dataset: { 'model-tuning-field': 'contextCustom' },
      })
      + '</span>';
  }

  function ratioPercent(ratio) {
    return ratio == null || ratio === '' ? '' : String(Math.round(Number(ratio) * 100));
  }

  function fieldRow(ctx, key) {
    var bounds = key === 'ratio'
      ? { min: Math.round(ctx.ratioBounds.min * 100), max: Math.round(ctx.ratioBounds.max * 100) }
      : key === 'contextLength' ? (ctx.contextBounds || CONTEXT_BOUNDS) : ctx.profileBounds(key);
    var copy = fieldCopy(key, bounds);
    var control;
    if (key === 'contextLength') {
      control = contextControlHtml(ctx, ctx.contextValue);
    } else {
      // Integer fields step by 1: a numeric input takes its step BASE from
      // min, so a 256 step against min=1 makes every round value (4096,
      // 8192) step-mismatched and walks the spinner down to 3841.
      var integerField = key === 'maxOutputTokens' || key === 'topK' || key === 'ratio';
      var value = key === 'ratio' ? ratioPercent(ctx.ratioValue) : ctx.profile[key];
      control = ctx.numberInput({
        id: 'modelTuning' + key[0].toUpperCase() + key.slice(1), label: '', ariaLabel: copy.label,
        value: value == null ? '' : String(value), min: bounds.min, max: bounds.max,
        step: integerField ? 1 : 0.01, allowEmpty: true,
        placeholder: key === 'ratio'
          ? jt('models.tuning.ratioPlaceholder', 'Default ({percent}%)', { percent: Math.round(RATIO_DEFAULT * 100) })
          : jt('models.tuning.modelDefault', 'Model default'),
        disabled: ctx.disabled,
        dataset: { 'model-tuning-field': key },
      });
    }
    return rowHtml({
      escapeHtml: ctx.escapeHtml, actionButton: ctx.actionButton, key: key,
      label: copy.label, desc: copy.desc, tip: copy.tip, controlHtml: control,
      note: key === 'contextLength' ? ctx.contextNote : '', revertable: key !== 'contextLength',
      stack: key === 'contextLength',
    });
  }

  // Memory (context + summarize) and Replies (temperature, maximum output and
  // the Advanced sampling fold). ctx.showContext drops the context row.
  function tuningSectionsHtml(ctx) {
    var esc = ctx.escapeHtml;
    var memory = (ctx.showContext ? fieldRow(ctx, 'contextLength') : '') + fieldRow(ctx, 'ratio');
    var setCount = ADVANCED_KEYS.filter(function (key) { return ctx.profile[key] != null && String(ctx.profile[key]) !== ''; }).length;
    var fold = '<details class="model-tuning-fold" data-model-tuning-fold' + (ctx.advancedOpen ? ' open' : '') + '>'
      + '<summary class="model-tuning-fold-summary">' + esc(jt('models.tuning.advancedSampling', 'Advanced sampling'))
      + (setCount ? ' <span class="model-tuning-fold-count">' + esc(jtn('models.tuning.advancedSet', setCount, { count: setCount }, '{count} set', '{count} set')) + '</span>' : '')
      + '</summary>'
      + ADVANCED_KEYS.map(function (key) { return fieldRow(ctx, key); }).join('')
      + '</details>';
    return sectionHtml(esc, jt('models.tuning.memory', 'Memory'), null, memory)
      + sectionHtml(esc, jt('models.tuning.replies', 'Replies'), null,
        fieldRow(ctx, 'temperature') + fieldRow(ctx, 'maxOutputTokens') + fold);
  }

  function advancedHasValues(profile) {
    return ADVANCED_KEYS.some(function (key) { return profile && profile[key] != null && String(profile[key]) !== ''; });
  }

  // The context window the inputs hold: '' (model default), a token count, or
  // null when there is no context row. A custom entry reads the number field.
  function readContextValue(host) {
    var select = host?.querySelector?.('#modelTuningContextLength');
    if (!select) return null;
    if (select.value !== CUSTOM_CONTEXT) return String(select.value || '').trim();
    return String(host.querySelector('#modelTuningContextCustom')?.value || '').trim();
  }

  function contextValueInvalid(host, bounds) {
    var select = host?.querySelector?.('#modelTuningContextLength');
    if (!select || select.value !== CUSTOM_CONTEXT) return false;
    var value = Number(readContextValue(host));
    var b = bounds || CONTEXT_BOUNDS;
    return !Number.isSafeInteger(value) || value < b.min || value > b.max;
  }

  function contextInvalidText(bounds) {
    var b = bounds || CONTEXT_BOUNDS;
    return jt('models.tuning.contextCustomInvalid', 'Enter a whole number of tokens from {min} to {max}.', { min: num(b.min), max: num(b.max) });
  }

  return {
    ADVANCED_KEYS: ADVANCED_KEYS,
    CONTEXT_BOUNDS: CONTEXT_BOUNDS,
    CUSTOM_CONTEXT: CUSTOM_CONTEXT,
    RATIO_DEFAULT: RATIO_DEFAULT,
    advancedHasValues: advancedHasValues,
    contextInvalidText: contextInvalidText,
    contextValueInvalid: contextValueInvalid,
    fieldCopy: fieldCopy,
    hiddenHtml: hiddenHtml,
    ratioPercent: ratioPercent,
    readContextValue: readContextValue,
    rowHtml: rowHtml,
    sectionHtml: sectionHtml,
    tuningSectionsHtml: tuningSectionsHtml,
  };
});
