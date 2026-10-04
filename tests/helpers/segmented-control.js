'use strict';

// Reads and drives an inventory segmented control (a radiogroup of buttons,
// addressed by data-inv-segmented) the way a test used to read a <select>.
const segmentedControl = require('../../renderer/inventory/segmented-control.js');

function segmentedGroup(doc, id) {
  return doc.querySelector(`[data-inv-segmented="${id}"]`);
}

function segmentedValue(doc, id) {
  const selected = segmentedGroup(doc, id)?.querySelector('.inv-segmented-option[aria-checked="true"]');
  return selected ? selected.getAttribute('data-value') : null;
}

function segmentedOptions(doc, id) {
  return [...segmentedGroup(doc, id).querySelectorAll('.inv-segmented-option')]
    .map((option) => ({ value: option.getAttribute('data-value'), label: option.textContent }));
}

// What a click or arrow key does: marks the option and dispatches inv-segmented-change.
function chooseSegmented(doc, id, value) {
  segmentedControl.select(segmentedGroup(doc, id), value);
}

module.exports = { segmentedGroup, segmentedValue, segmentedOptions, chooseSegmented };
