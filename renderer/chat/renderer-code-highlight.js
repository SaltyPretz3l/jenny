(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCodeHighlight = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LANGUAGE_ENTRIES = 128;
  const MAX_MEMO_ENTRIES = 2000;
  const MAX_LINE_CHARS = 400;
  const MAX_BODY_LINES = 400;
  const COMMON = Object.freeze({
    js: 'javascript', jsx: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
    py: 'python', python: 'python', css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown', xml: 'xml',
    json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    sh: 'shell', bash: 'shell', shell: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell', powershell: 'powershell',
    sql: 'sql', txt: 'plaintext', text: 'plaintext', plaintext: 'plaintext', none: 'plaintext',
  });
  const DOTS = Object.freeze({
    javascript: '#EF9F27', typescript: '#EF9F27', python: '#378ADD',
    css: '#7F77DD', scss: '#7F77DD', less: '#7F77DD',
    html: '#D85A30', markdown: '#D85A30', xml: '#D85A30',
    json: '#1D9E75', yaml: '#1D9E75', toml: '#1D9E75',
    shell: '#5F5E5A', bat: '#5F5E5A', powershell: '#5F5E5A', sql: '#D4537E',
  });
  const TOKEN_CLASS = Object.freeze({
    comment: 'tok-comment', string: 'tok-string', number: 'tok-number', keyword: 'tok-keyword',
    type: 'tok-type', function: 'tok-function', delimiter: 'tok-delimiter', invalid: 'tok-invalid',
  });

  const extensionToLanguage = new Map();
  const knownLanguages = new Set(Object.values(COMMON));
  const memo = new Map();
  const issuedStreamUnitTokens = new WeakMap();
  let monacoApi = null;
  let warmPromise = null;
  let lifecycleGeneration = 0;
  let disposed = false;
  let loggedFailure = false;

  function normalize(value) { return String(value || '').trim().toLowerCase(); }

  function getLanguageId(pathOrFence) {
    const raw = normalize(pathOrFence).replace(/^language-/, '');
    if (!raw) return '';
    if (COMMON[raw]) return COMMON[raw];
    const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const basename = raw.slice(slash + 1);
    const dot = basename.lastIndexOf('.');
    const extension = dot >= 0 ? basename.slice(dot) : `.${basename}`;
    const bareExtension = extension.slice(1);
    return COMMON[bareExtension] || extensionToLanguage.get(extension) || extensionToLanguage.get(bareExtension) || '';
  }

  function getLanguageDot(languageId) {
    return DOTS[normalize(languageId)] || 'var(--tl-status-muted)';
  }

  function defaultTokens(text) { return [{ text: String(text == null ? '' : text), cls: 'tok-default' }]; }

  function mapTokenClass(type) {
    const segment = normalize(type).split('.')[0];
    return TOKEN_CLASS[segment] || 'tok-default';
  }

  function cache(key, value) {
    if (memo.has(key)) memo.delete(key);
    memo.set(key, value);
    while (memo.size > MAX_MEMO_ENTRIES) memo.delete(memo.keys().next().value);
  }

  function highlightLine(textInput, languageIdInput) {
    const text = String(textInput == null ? '' : textInput);
    const languageId = normalize(languageIdInput);
    if (!monacoApi?.editor?.tokenize || !languageId || !knownLanguages.has(languageId) || text.length > MAX_LINE_CHARS) {
      return defaultTokens(text);
    }
    const key = `${languageId}\0${text}`;
    const cached = memo.get(key);
    if (cached) return cached.map((token) => ({ ...token }));
    let rawTokens;
    try { rawTokens = monacoApi.editor.tokenize(text, languageId)?.[0]; } catch (_error) { return defaultTokens(text); }
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) return defaultTokens(text);
    const tokens = [];
    let consumed = 0;
    for (let index = 0; index < rawTokens.length; index += 1) {
      const start = Math.max(0, Number(rawTokens[index]?.offset) || 0);
      const end = index + 1 < rawTokens.length ? Math.max(start, Number(rawTokens[index + 1]?.offset) || start) : text.length;
      if (start > consumed) {
        tokens.push({ text: text.slice(consumed, start), cls: 'tok-default' });
      }
      tokens.push({ text: text.slice(start, end), cls: mapTokenClass(rawTokens[index]?.type) });
      consumed = end;
    }
    const normalizedTokens = tokens.length ? tokens : defaultTokens(text);
    cache(key, normalizedTokens);
    return normalizedTokens.map((token) => ({ ...token }));
  }

  function languageHintForNode(codeNode) {
    const className = String(codeNode?.getAttribute?.('class') || '');
    const match = className.match(/(?:^|\s)language-([^\s]+)/i);
    return match ? match[1] : '';
  }

  function replaceLineNode(node, text, languageId) {
    const doc = node?.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return false;
    const fragment = doc.createDocumentFragment();
    for (const token of highlightLine(text, languageId)) {
      const span = doc.createElement('span');
      span.className = `tok ${token.cls}`;
      span.textContent = token.text;
      fragment.appendChild(span);
    }
    node.replaceChildren(fragment);
    node.setAttribute('data-code-highlighted', monacoApi ? 'tokenized' : 'default');
    return true;
  }

  function decorateCodeNode(codeNode, languageHint) {
    if (!codeNode) return false;
    const languageId = getLanguageId(languageHint || languageHintForNode(codeNode));
    const text = String(codeNode.textContent || '');
    const lines = text.split('\n');
    if (lines.length > MAX_BODY_LINES) {
      replaceLineNode(codeNode, text, '');
    } else {
      const doc = codeNode.ownerDocument;
      const fragment = doc?.createDocumentFragment?.();
      if (!fragment) return false;
      lines.forEach((line, index) => {
        for (const token of highlightLine(line, languageId)) {
          const span = doc.createElement('span');
          span.className = `tok ${token.cls}`;
          span.textContent = token.text;
          fragment.appendChild(span);
        }
        if (index < lines.length - 1) fragment.appendChild(doc.createTextNode('\n'));
      });
      codeNode.replaceChildren(fragment);
      codeNode.setAttribute('data-code-highlighted', monacoApi ? 'tokenized' : 'default');
    }
    codeNode.setAttribute('data-language-id', languageId);
    return true;
  }

  function decorateCodeBlocks(rootNode) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return 0;
    let decorated = 0;
    rootNode.querySelectorAll('.markdown-code-block code').forEach((codeNode) => {
      const languageId = getLanguageId(languageHintForNode(codeNode));
      if (decorateCodeNode(codeNode, languageId)) decorated += 1;
      const wrapper = codeNode.closest?.('.markdown-code-block');
      const label = wrapper?.querySelector?.('.markdown-code-language');
      if (label) {
        label.style.setProperty('--lang-dot', getLanguageDot(languageId));
        label.setAttribute('data-language-id', languageId);
      }
    });
    rootNode.querySelectorAll('[data-code-highlight-line]').forEach((lineNode) => {
      if (replaceLineNode(lineNode, lineNode.textContent || '', lineNode.dataset?.languageId || '')) decorated += 1;
    });
    return decorated;
  }

  function issueStreamUnit(unit) {
    const token = {};
    unit.highlightReuseToken = token;
    issuedStreamUnitTokens.set(token, {
      html: String(unit.html || ''),
      fingerprint: String(unit.fingerprint || ''),
      sourceHtml: String(unit.sourceHtml || ''),
      sourceFingerprint: String(unit.sourceFingerprint || ''),
    });
  }

  function isIssuedStreamUnit(unit) {
    const issued = unit && issuedStreamUnitTokens.get(unit.highlightReuseToken);
    return !!issued
      && issued.html === String(unit.html || '')
      && issued.fingerprint === String(unit.fingerprint || '')
      && issued.sourceHtml === String(unit.sourceHtml || '')
      && issued.sourceFingerprint === String(unit.sourceFingerprint || '');
  }

  function decorateStreamModel(model, previousUnits, options) {
    const units = Array.isArray(model?.units) ? model.units : [];
    const previous = Array.isArray(previousUnits) ? previousUnits : [];
    const fingerprintHtml = options?.fingerprintHtml;
    const doc = options?.document || (typeof document !== 'undefined' ? document : null);
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      const prior = previous[index];
      const sourceUnchanged = (model.changedStartIndex === -1 || index < model.changedStartIndex)
        && prior && typeof prior.html === 'string'
        && String(prior.sourceFingerprint || prior.fingerprint || '') === String(unit.sourceFingerprint || '');
      if (sourceUnchanged && isIssuedStreamUnit(prior)) {
        unit.html = prior.html;
        unit.fingerprint = String(prior.fingerprint || unit.fingerprint || '');
        unit.highlightReuseToken = prior.highlightReuseToken;
        continue;
      }
      if (sourceUnchanged) {
        model.changedStartIndex = model.changedStartIndex === -1
          ? index
          : Math.min(model.changedStartIndex, index);
      }
      if (String(unit.html || '').includes('<code') && doc?.createElement) {
        const template = doc.createElement('template');
        template.innerHTML = unit.html;
        decorateCodeBlocks(template.content);
        unit.html = template.innerHTML;
        if (typeof fingerprintHtml === 'function') unit.fingerprint = fingerprintHtml(unit.html);
      }
      issueStreamUnit(unit);
    }
    return model;
  }

  function buildLanguageMap(monaco) {
    extensionToLanguage.clear();
    knownLanguages.clear();
    Object.values(COMMON).forEach((languageId) => knownLanguages.add(languageId));
    for (const language of monaco?.languages?.getLanguages?.() || []) {
      const id = normalize(language?.id);
      if (!id) continue;
      knownLanguages.add(id);
      for (const extension of Array.isArray(language?.extensions) ? language.extensions : []) {
        if (extensionToLanguage.size >= MAX_LANGUAGE_ENTRIES) return;
        const key = normalize(extension);
        if (key && !extensionToLanguage.has(key)) extensionToLanguage.set(key, id);
      }
    }
  }

  function warmCodeHighlighting(options) {
    if (warmPromise) return warmPromise;
    const settings = options || {};
    disposed = false;
    const generation = ++lifecycleGeneration;
    const ensureMonaco = settings.monacoUtils?.ensureMonacoEditorApi;
    if (typeof ensureMonaco !== 'function') return Promise.resolve(false);
    const pendingWarm = Promise.resolve().then(() => ensureMonaco(settings.log)).then((monaco) => {
      if (disposed || generation !== lifecycleGeneration || !monaco?.editor?.tokenize) return false;
      monacoApi = monaco;
      buildLanguageMap(monaco);
      const decorated = decorateCodeBlocks(settings.root);
      settings.log?.('INFO', 'renderer.code_highlight_warm_complete', {
        languages: knownLanguages.size, extensions: extensionToLanguage.size, decorated,
      });
      return true;
    }).catch((error) => {
      if (!disposed && generation === lifecycleGeneration && !loggedFailure) {
        loggedFailure = true;
        settings.log?.('WARN', 'renderer.code_highlight_warm_failed', {
          message: String(error?.message || 'Monaco tokenization unavailable.').slice(0, 240),
        });
      }
      return false;
    }).finally(() => { if (warmPromise === pendingWarm) warmPromise = null; });
    warmPromise = pendingWarm;
    return warmPromise;
  }

  function disposeCodeHighlighting() {
    disposed = true;
    lifecycleGeneration += 1;
    monacoApi = null;
    extensionToLanguage.clear();
    knownLanguages.clear();
    Object.values(COMMON).forEach((languageId) => knownLanguages.add(languageId));
    memo.clear();
    warmPromise = null;
  }

  return {
    MAX_LANGUAGE_ENTRIES, MAX_MEMO_ENTRIES, MAX_LINE_CHARS, MAX_BODY_LINES,
    warmCodeHighlighting, getLanguageId, getLanguageDot, highlightLine,
    decorateCodeNode, decorateCodeBlocks, decorateStreamModel, disposeCodeHighlighting,
  };
});
