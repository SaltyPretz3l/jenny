/* renderer/features/renderer-ide-pdf-runtime.js - pdf.js module loading and
 * byte codecs for the Workspace IDE PDF pane (renderer-ide-pdf-host.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/bytes-base64'));
    return;
  }
  root.rendererIdePdfRuntime = factory(root.rendererBytesBase64);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (bytesBase64) {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function repoUrl(relativePath, documentRef = globalRef.document) {
    return new URL(relativePath, documentRef.baseURI).href;
  }

  function createPdfjsLoader({ importModule = (url) => import(url), resolveUrl = repoUrl } = {}) {
    let pending = null;
    return function loadPdfjs() {
      if (!pending) {
        // The viewer destructures globalThis.pdfjsLib at module evaluation;
        // it cannot be imported concurrently with the core that creates it.
        pending = importModule(resolveUrl('node_modules/pdfjs-dist/build/pdf.mjs'))
          .then(async (pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc = resolveUrl('node_modules/pdfjs-dist/build/pdf.worker.mjs');
            const viewer = await importModule(resolveUrl('node_modules/pdfjs-dist/web/pdf_viewer.mjs'));
            return { pdfjs, viewer };
          }).catch((error) => { pending = null; throw error; });
      }
      return pending;
    };
  }

  // The codecs live in renderer/shared/bytes-base64.js (shared with the DOCX
  // pane); re-exported here for the host and its tests.
  const { decodeBase64, encodeBase64 } = bytesBase64;

  function createQuietL10n() {
    return {
      getLanguage: () => 'en-us',
      getDirection: () => 'ltr',
      get: async (id, _args, fallback) => fallback || id,
      translate: async () => {},
      translateOnce: async () => {},
      pause: () => {},
      resume: () => {},
      destroy: async () => {},
    };
  }

  // pdf.js reads highlight colors only from this option; without it every
  // new highlight throws in getNonHCMColorName (highlightColorNames is null).
  // Same palette as the Firefox viewer's annotationEditorHighlightColors.
  const PDF_HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F';
  // Largest page canvas in pixels (pdf.js defaults to 2^25): past it pdf.js
  // CSS-scales the page and renders only the visible area at full detail, so
  // several open PDFs at high zoom do not each hold 128 MB canvases.
  const MAX_CANVAS_PIXELS = 16_777_216;

  // One document's pdf.js viewer stack: event bus, link service (external
  // links off), find controller and viewer, plus the editor-mode values.
  function createViewerParts({ pdfjs, viewer }, { container, viewerElement }) {
    const eventBus = new viewer.EventBus();
    const linkService = new viewer.PDFLinkService({ eventBus, externalLinkTarget: 0 });
    // Not a constructor option in pdf.js 6.x: it is a public field that
    // defaults to true, so it must be assigned after construction or URI
    // annotations become live document-controlled links.
    linkService.externalLinkEnabled = false;
    const findController = new viewer.PDFFindController({ eventBus, linkService });
    const pdfViewer = new viewer.PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: pdfjs.AnnotationEditorType.NONE,
      annotationEditorHighlightColors: PDF_HIGHLIGHT_COLORS,
      removePageBorders: false,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
      l10n: createQuietL10n(),
    });
    linkService.setViewer(pdfViewer);
    const types = pdfjs.AnnotationEditorType;
    const modeValues = { none: types.NONE, highlight: types.HIGHLIGHT, freetext: types.FREETEXT, ink: types.INK };
    return { eventBus, linkService, pdfViewer, modeValues };
  }

  return { createPdfjsLoader, createQuietL10n, createViewerParts, decodeBase64, encodeBase64, repoUrl };
});
