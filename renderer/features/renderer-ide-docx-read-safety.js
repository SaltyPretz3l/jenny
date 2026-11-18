/* renderer/features/renderer-ide-docx-read-safety.js - the DOCX Read view's
 * handling of untrusted document output (renderer-ide-docx-views.js): which
 * resources a docx-preview render may keep, which blob URLs it leaves to
 * revoke, and links that never navigate the window. Pure DOM helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxReadSafety = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The CSP allows file: images and inline styles: a crafted style
  // (docx-preview copies VML style text verbatim) or a linked picture could
  // reach a network share or probe local files. Only blob: and data:
  // resources survive; links keep their href because clicks never navigate.
  const SAFE_URL = /^\s*['"]?\s*(blob:|data:)/i;
  const HAS_RESOURCE = /url\(|@import/i;

  function cleanCss(text) {
    return text.replace(/url\(([^)]*)\)/gi, (match, target) => (SAFE_URL.test(target) ? match : 'none'))
      .replace(/@import[^;]*;?/gi, '');
  }

  function neutralizeExternalResources(rootElement) {
    for (const element of rootElement.querySelectorAll('[style]')) {
      const style = element.getAttribute('style');
      if (HAS_RESOURCE.test(style)) element.setAttribute('style', cleanCss(style));
    }
    for (const element of rootElement.querySelectorAll('style')) {
      if (HAS_RESOURCE.test(element.textContent)) element.textContent = cleanCss(element.textContent);
    }
    for (const element of rootElement.querySelectorAll('[src], [href], [*|href]')) {
      if (element.localName === 'a') continue;
      for (const attribute of [...element.attributes]) {
        if ((attribute.localName === 'src' || attribute.localName === 'href') && !SAFE_URL.test(attribute.value)) {
          element.removeAttributeNode(attribute);
        }
      }
    }
  }

  // docx-preview never revokes its blob URLs: img src, the SVG image href of
  // VML pictures, and picture bullets inside style text.
  function collectBlobUrls(node) {
    const urls = new Set();
    if (node?.nodeType !== 1) return urls;
    for (const element of [node, ...node.querySelectorAll('[src^="blob:"], [href^="blob:"], style')]) {
      for (const name of ['src', 'href']) {
        const value = element.getAttribute(name);
        if (value?.startsWith('blob:')) urls.add(value);
      }
      if (element.localName === 'style') (element.textContent.match(/blob:[^)"'\s]+/g) || []).forEach((url) => urls.add(url));
    }
    return urls;
  }

  // Click and auxclick on the shadow root: `#anchor` hrefs scroll inside the
  // document; nothing else navigates.
  function handleReadLink(event) {
    const anchor = event.target?.closest?.('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') || '';
    if (event.type !== 'click' || !href.startsWith('#') || href.length < 2) return;
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch (_error) {
      /* use it as written */
    }
    const scope = anchor.getRootNode();
    let target = scope.getElementById?.(id) || null;
    try {
      target ||= scope.querySelector?.(`[name="${id.replace(/["\\]/g, '\\$&')}"]`);
    } catch (_error) {
      /* a name no selector can express */
    }
    target?.scrollIntoView?.({ block: 'start' });
  }

  return { collectBlobUrls, handleReadLink, neutralizeExternalResources };
});
