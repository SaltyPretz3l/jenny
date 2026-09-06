/* global self, importScripts */

(function bootstrapMonacoWorker() {
  // The window side passes the resolved AMD base explicitly (?vs=...) so the
  // worker never guesses. The fallback resolves the app root two levels up
  // from this script (renderer/frames/) - resolving 'node_modules/...'
  // against self.location.href put node_modules UNDER renderer/frames/ and
  // every importScripts failed (Monaco then silently degraded to
  // main-thread workers).
  function getSearchParams() {
    try {
      return new URL(self.location.href).searchParams;
    } catch (_error) {
      return null;
    }
  }

  function getVsBaseUrl(params) {
    const fromQuery = params ? params.get('vs') : '';
    if (fromQuery) {
      return fromQuery.endsWith('/') ? fromQuery : `${fromQuery}/`;
    }
    try {
      return new URL('../../node_modules/monaco-editor/min/vs/', self.location.href).toString();
    } catch (_error) {
      return '../../node_modules/monaco-editor/min/vs/';
    }
  }

  // Language workers live in separate AMD bundles that workerMain's loader
  // would fetch() on demand - but Electron file:// pages carry a real
  // 'file://' origin, so module URLs classify as same-origin and the loader
  // prefers fetch()+eval, which cannot read file: URLs. Pre-importing the
  // bundle registers its AMD define, so the on-demand require resolves
  // locally and never reaches fetch. workerMain.js already bundles the base
  // editor worker (label 'editorWorkerService'), which needs nothing extra.
  const LANGUAGE_WORKER_BUNDLES = {
    json: 'language/json/jsonWorker.js',
    css: 'language/css/cssWorker.js',
    scss: 'language/css/cssWorker.js',
    less: 'language/css/cssWorker.js',
    html: 'language/html/htmlWorker.js',
    handlebars: 'language/html/htmlWorker.js',
    razor: 'language/html/htmlWorker.js',
    typescript: 'language/typescript/tsWorker.js',
    javascript: 'language/typescript/tsWorker.js',
  };

  const params = getSearchParams();
  const vsBaseUrl = getVsBaseUrl(params);
  const workerMainUrl = new URL('base/worker/workerMain.js', vsBaseUrl).toString();
  const monacoEnvironment = self.MonacoEnvironment && typeof self.MonacoEnvironment === 'object'
    ? self.MonacoEnvironment
    : {};

  monacoEnvironment.baseUrl = vsBaseUrl;
  self.MonacoEnvironment = monacoEnvironment;

  importScripts(workerMainUrl);

  const label = params ? String(params.get('label') || '') : '';
  const languageBundle = LANGUAGE_WORKER_BUNDLES[label];
  if (languageBundle) {
    importScripts(new URL(languageBundle, vsBaseUrl).toString());
  }
})();
