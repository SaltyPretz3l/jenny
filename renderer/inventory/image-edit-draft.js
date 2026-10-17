(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./action-button'));
  else root.inventoryImageEditDraft = factory(root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton) {
  'use strict';
  function createCard(doc, labels) {
    const card = doc.createElement('div'); card.className = 'image-edit-draft';
    card.innerHTML = '<div class="image-edit-draft-preview"><img alt=""><canvas aria-hidden="true"></canvas></div><span></span>'
      + actionButton({ label: labels.remove, title: labels.remove, plain: true, dataset: { 'image-edit-remove': 'true' } });
    card.querySelector('img').alt = labels.preview;
    return { root: card, image: card.querySelector('img'), canvas: card.querySelector('canvas'), text: card.querySelector('span'), remove: card.querySelector('button') };
  }
  return { createCard };
});
