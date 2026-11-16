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
  // A line block (a file preview's rows) tokenizes as one document so state
  // carries across lines; past this size it falls back to line-by-line.
  const MAX_BLOCK_CHARS = 200000;
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
    variable: 'tok-variable', identifier: 'tok-variable', property: 'tok-property', attribute: 'tok-property',
    tag: 'tok-tag', metatag: 'tok-tag', operator: 'tok-operator', operators: 'tok-operator',
    regexp: 'tok-regexp', constant: 'tok-constant', annotation: 'tok-annotation', predefined: 'tok-function',
  });

  // Grammars a language hands its embedded regions to (HTML's <script> and
  // <style>); a block is settled only once these are loaded too.
  const EMBEDDED_LANGUAGES = Object.freeze({ html: ['javascript', 'css'] });

  const extensionToLanguage = new Map();
  const knownLanguages = new Set(Object.values(COMMON));
  const memo = new Map();
  const issuedStreamUnitTokens = new WeakMap();
  const readyGrammars = new Set();
  const grammarLoads = new Set();
  let decorationRoot = null;
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
    // A registered Monaco id ("rust", "csharp") resolved earlier must survive a
    // second pass; read as a path it would look like an unknown extension.
    if (knownLanguages.has(raw)) return raw;
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
    const normalized = normalize(type);
    if (normalized === 'type.identifier' || normalized.startsWith('type.identifier.')) return 'tok-type';
    if (normalized === 'string.key' || normalized.startsWith('string.key.')) return 'tok-property';
    if (normalized === 'attribute.value' || normalized.startsWith('attribute.value.')) return 'tok-string';
    if (normalized === 'attribute.name' || normalized.startsWith('attribute.name.')) return 'tok-property';
    if (normalized === 'keyword.flow' || normalized.startsWith('keyword.flow.')
      || normalized === 'keyword.control' || normalized.startsWith('keyword.control.')) return 'tok-keyword';
    const segment = normalized.split('.')[0];
    return TOKEN_CLASS[segment] || 'tok-default';
  }

  function cache(key, value) {
    if (memo.has(key)) memo.delete(key);
    memo.set(key, value);
    while (memo.size > MAX_MEMO_ENTRIES) memo.delete(memo.keys().next().value);
  }

  // Monaco loads each language's tokenizer lazily: the first editor.tokenize()
  // only STARTS that load and answers one untyped token per line. Tokens are
  // trusted (memoized, node settled) only after colorize(), which awaits the
  // lazy tokenizer, resolved for the language; then the root is re-decorated.
  // JSON registers its tokenizer when a model of that language first exists.
  function grammarReady(languageId) {
    if (readyGrammars.has(languageId) || typeof monacoApi?.editor?.colorize !== 'function') return true;
    if (!grammarLoads.has(languageId)) {
      grammarLoads.add(languageId);
      const api = monacoApi;
      const generation = lifecycleGeneration;
      Promise.resolve().then(async () => {
        if (languageId === 'json') {
          api.editor.createModel?.('', languageId)?.dispose?.();
          await api.languages?.json?.getWorker?.();
        }
        await api.editor.colorize('', languageId, {});
      }).catch(() => {}).then(() => {
        if (disposed || generation !== lifecycleGeneration) return;
        readyGrammars.add(languageId);
        decorateCodeBlocks(decorationRoot);
      });
    }
    return false;
  }

  // Unknown or absent languages settle on their plain fallback; a known one
  // settles only once its grammar is ready.
  function grammarSettled(languageIdInput) {
    const languageId = normalize(languageIdInput);
    return !languageId || !knownLanguages.has(languageId) || grammarReady(languageId);
  }

  // Every grammar the block needs, its embedded ones included. All loads start
  // together: each call kicks off its own lazy load.
  function blockGrammarsReady(languageId) {
    let ready = grammarReady(languageId);
    for (const nested of EMBEDDED_LANGUAGES[languageId] || []) {
      if (knownLanguages.has(nested)) ready = grammarReady(nested) && ready;
    }
    return ready;
  }

  function tokensFromRaw(text, rawTokens) {
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
    return tokens.length ? tokens : defaultTokens(text);
  }

  function highlightLine(textInput, languageIdInput) {
    const text = String(textInput == null ? '' : textInput);
    const languageId = normalize(languageIdInput);
    if (!monacoApi?.editor?.tokenize || !languageId || !knownLanguages.has(languageId) || text.length > MAX_LINE_CHARS
      || !grammarReady(languageId)) {
      return defaultTokens(text);
    }
    const key = `${languageId}\0${text}`;
    const cached = memo.get(key);
    if (cached) return cached.map((token) => ({ ...token }));
    let rawTokens;
    try { rawTokens = monacoApi.editor.tokenize(text, languageId)?.[0]; } catch (_error) { return defaultTokens(text); }
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) return defaultTokens(text);
    const normalizedTokens = tokensFromRaw(text, rawTokens);
    cache(key, normalizedTokens);
    return normalizedTokens.map((token) => ({ ...token }));
  }

  // One token list per line, tokenized as a single document: a line inside an
  // HTML <script> or a multi-line comment colors by its context, not as a
  // fresh first line. A block that starts mid-file (a windowed preview) starts
  // from the grammar's initial state. Lines over MAX_LINE_CHARS stay plain, as
  // line by line. Not memoized (a block is one-off and can be large).
  function highlightLines(linesInput, languageIdInput) {
    const lines = (Array.isArray(linesInput) ? linesInput : []).map((line) => String(line == null ? '' : line));
    const languageId = normalize(languageIdInput);
    const lineByLine = () => lines.map((line) => highlightLine(line, languageId));
    if (!monacoApi?.editor?.tokenize || !languageId || !knownLanguages.has(languageId)
      || !blockGrammarsReady(languageId)) {
      return lineByLine();
    }
    const text = lines.join('\n');
    if (text.length > MAX_BLOCK_CHARS) return lineByLine();
    let rawLines;
    try { rawLines = monacoApi.editor.tokenize(text, languageId); } catch (_error) { return lineByLine(); }
    if (!Array.isArray(rawLines) || rawLines.length !== lines.length) return lineByLine();
    return lines.map((line, index) => (line.length > MAX_LINE_CHARS ? defaultTokens(line) : tokensFromRaw(line, rawLines[index])));
  }

  function languageHintForNode(codeNode) {
    const className = String(codeNode?.getAttribute?.('class') || '');
    const match = className.match(/(?:^|\s)language-([^\s]+)/i);
    return match ? match[1] : '';
  }

  // A node is settled once Monaco tokenized it. The cold fallback ('default')
  // is provisional: the warm-up decoration pass must still replace it.
  function isSettled(node) {
    const mark = node?.getAttribute?.('data-code-highlighted');
    return mark === 'tokenized' || (mark === 'default' && !monacoApi);
  }

  // A diff line's changed-word mark (renderer-file-diff-view.js) as a [start, end) text range,
  // so a rewrite keeps it.
  function markedRange(node) {
    const mark = node.querySelector?.(':scope > mark.diff-word');
    if (!mark) return null;
    let start = 0;
    for (const child of node.childNodes) {
      if (child === mark) break;
      start += (child.textContent || '').length;
    }
    return [start, start + (mark.textContent || '').length];
  }

  function writeTokens(node, tokens) {
    const doc = node?.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return false;
    const range = markedRange(node);
    const fragment = doc.createDocumentFragment();
    let position = 0;
    let markNode = null;
    const append = (cls, text, marked) => {
      const span = doc.createElement('span');
      span.className = `tok ${cls}`;
      span.textContent = text;
      if (!marked) {
        markNode = null;
        fragment.appendChild(span);
        return;
      }
      if (!markNode) {
        markNode = doc.createElement('mark');
        markNode.className = 'diff-word';
        fragment.appendChild(markNode);
      }
      markNode.appendChild(span);
    };
    for (const token of tokens) {
      const text = String(token.text == null ? '' : token.text);
      const start = position;
      position += text.length;
      if (!range || range[1] <= start || range[0] >= position) {
        append(token.cls, text, false);
        continue;
      }
      const from = Math.max(range[0], start) - start;
      const to = Math.min(range[1], position) - start;
      if (from > 0) append(token.cls, text.slice(0, from), false);
      append(token.cls, text.slice(from, to), true);
      if (to < text.length) append(token.cls, text.slice(to), false);
    }
    node.replaceChildren(fragment);
    return true;
  }

  function replaceLineNode(node, text, languageId) {
    if (!node || isSettled(node)) return false;
    if (!writeTokens(node, highlightLine(text, languageId))) return false;
    node.setAttribute('data-code-highlighted', monacoApi && grammarSettled(languageId) ? 'tokenized' : 'default');
    return true;
  }

  // A [data-code-highlight-block] container's line nodes decorate together
  // (see highlightLines). Returns how many line nodes were written.
  function decorateLineBlock(block) {
    const nodes = Array.from(block.querySelectorAll('[data-code-highlight-line]'));
    if (nodes.length === 0 || nodes.every(isSettled)) return 0;
    const languageId = normalize(block.dataset?.languageId || nodes[0].dataset?.languageId || '');
    // The rows already show their plain text. Leave them until Monaco and every
    // grammar the block needs are loaded (each load re-runs this pass) rather
    // than rewriting every row, and dropping the reader's selection, per load.
    if (!monacoApi || (languageId && knownLanguages.has(languageId) && !blockGrammarsReady(languageId))) return 0;
    const tokenLines = highlightLines(nodes.map((node) => node.textContent || ''), languageId);
    let written = 0;
    nodes.forEach((node, index) => {
      if (!writeTokens(node, tokenLines[index] || defaultTokens(node.textContent))) return;
      node.setAttribute('data-code-highlighted', 'tokenized');
      written += 1;
    });
    return written;
  }

  function decorateCodeNode(codeNode, languageHint) {
    if (!codeNode || isSettled(codeNode)) return false;
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
      codeNode.setAttribute('data-code-highlighted', monacoApi && grammarSettled(languageId) ? 'tokenized' : 'default');
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
    rootNode.querySelectorAll('.tool-call-section code[data-language-id]').forEach((codeNode) => {
      if (decorateCodeNode(codeNode, codeNode.dataset?.languageId || '')) decorated += 1;
    });
    const blocks = new Set();
    rootNode.querySelectorAll('[data-code-highlight-line]').forEach((lineNode) => {
      const block = lineNode.closest?.('[data-code-highlight-block]');
      if (block) blocks.add(block);
      else if (replaceLineNode(lineNode, lineNode.textContent || '', lineNode.dataset?.languageId || '')) decorated += 1;
    });
    blocks.forEach((block) => { decorated += decorateLineBlock(block); });
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
    decorationRoot = settings.root || null;
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
    readyGrammars.clear();
    grammarLoads.clear();
    decorationRoot = null;
    warmPromise = null;
  }

  return {
    MAX_LANGUAGE_ENTRIES, MAX_MEMO_ENTRIES, MAX_LINE_CHARS, MAX_BODY_LINES, MAX_BLOCK_CHARS,
    warmCodeHighlighting, getLanguageId, getLanguageDot, mapTokenClass, highlightLine, highlightLines,
    decorateCodeNode, decorateCodeBlocks, decorateStreamModel, disposeCodeHighlighting,
  };
});
