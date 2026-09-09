'use strict';

const espree = require('espree');
const { scanHtml } = require('./ledger-html-scan.js');

const DOM_TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'innerHTML']);
const DOM_ATTRIBUTE_PROPERTIES = new Set(['title', 'ariaLabel', 'placeholder', 'alt']);
const IDENTITY_PROPERTIES = new Set(['className', 'id', 'htmlFor', 'name', 'type', 'rel', 'href', 'src']);
const IDENTITY_ATTRIBUTES = new Set(['class', 'id', 'htmlfor', 'name', 'type', 'rel', 'href', 'src']);
const CONFIG_PROPERTIES = new Set([
  'label', 'title', 'description', 'hint', 'helpText', 'placeholder', 'ariaLabel',
  'summary', 'confirmLabel', 'cancelLabel', 'closeLabel', 'message', 'detail',
  'buttons', 'eyebrow', 'emptyText', 'tooltip',
]);
const WIRE_PROPERTIES = new Set([
  'kind', 'type', 'mode', 'status', 'state', 'role', 'tone', 'variant', 'source',
  'method', 'event', 'channel', 'key', 'id', 'action',
]);
const IPC_PROPERTIES = new Set(['message', 'reason', 'label', 'title', 'detail', 'summary']);
const TOOL_RESULT_PROPERTIES = new Set([...IPC_PROPERTIES, 'content']);
const MAIN_DIALOG_PROPERTIES = new Set(['title', 'message', 'detail', 'buttons']);
const MODEL_PROPERTIES = new Set([
  'prompt', 'systemPrompt', 'system_prompt', 'instructions', 'toolDescription', 'description',
]);
const LOG_NAMES = new Set([
  'appendClientLog', 'log', 'warn', 'error', 'info', 'debug', '_emitServiceLog',
  'emitServiceLog', 'logEvent',
]);
const DISPLAY_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'data-tooltip']);
const COMPARISON_METHODS = new Set(['includes', 'startsWith', 'indexOf']);
const COMPARISON_OPERATORS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=']);
const FORMAT_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']);
const INTL_FORMATTERS = new Set(['DateTimeFormat', 'NumberFormat', 'RelativeTimeFormat']);
const TOAST_NAMES = new Set([
  'showToastMessage', 'showShellErrorToast', 'showComposerActionError',
  'showSessionActionError', 'showToast', 'toast',
]);
const DISPLAY_ERROR_NAMES = new Set([
  'showError', 'renderError', 'displayError', 'notifyError', 'toastError',
  'reportError', 'presentError', 'setError', 'pushError', 'announceError',
]);
const SELECTOR_NAMES = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches']);
const PROPER_NOUNS = new Set([
  'Jenny', 'Ollama', 'vLLM', 'MCP', 'GGUF', 'Monaco', 'Mermaid', 'KaTeX',
  'GitHub', 'Codex', 'ChatGPT', 'llama-server', 'Python', 'PowerShell',
]);
const KEYBOARD_CHORD_RE = /^((Ctrl|Shift|Alt|Cmd|Meta|Win)\+)+([A-Za-z0-9]|F\d{1,2}|Enter|Esc|Escape|Tab|Space|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|[`~!@#$%^&*()\-_=+\u005b\]{};:'",.<>/?\\|])$/;
const TEMPLATE_PROSE_MARKER = '{expr}';
const TEMPLATE_WORD_LEADING_CHARS = new Set(['(', '[', '"', "'"]);
const TEMPLATE_WORD_TRAILING_CHARS = new Set([')', ']', '"', "'", '?', ':', '.', ',', '!', '…']);

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function calleeName(callee) {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression') return propertyName(callee.property);
  return null;
}

function parseSource(source, file) {
  const base = { ecmaVersion: 'latest', loc: true, range: true, sourceType: 'script' };
  try {
    return espree.parse(source, base);
  } catch (scriptError) {
    if (!file.startsWith('renderer/')) throw scriptError;
    return espree.parse(source, { ...base, sourceType: 'module' });
  }
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string') children.push(item);
      }
    } else if (value && typeof value.type === 'string') {
      children.push(value);
    }
  }
  return children.sort((left, right) => (left.range?.[0] ?? 0) - (right.range?.[0] ?? 0));
}

function isFunction(node) {
  return node?.type === 'FunctionDeclaration'
    || node?.type === 'FunctionExpression'
    || node?.type === 'ArrowFunctionExpression';
}

function indexDeclarations(ast) {
  const declarations = new Map();
  function add(scope, name, declarator) {
    if (!name) return;
    const byName = declarations.get(scope) || new Map();
    const entries = byName.get(name) || [];
    entries.push(declarator);
    byName.set(name, entries);
    declarations.set(scope, byName);
  }
  function visit(node, scope) {
    const nextScope = node.type === 'Program' || isFunction(node) ? node : scope;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      add(nextScope, node.id.name, node);
    }
    for (const child of childNodes(node)) visit(child, nextScope);
  }
  visit(ast, ast);
  return declarations;
}

function indexParents(ast) {
  const parents = new WeakMap();
  function visit(node) {
    for (const child of childNodes(node)) {
      parents.set(child, node);
      visit(child);
    }
  }
  visit(ast);
  return parents;
}

function templateText(node) {
  let result = '';
  for (let index = 0; index < node.quasis.length; index += 1) {
    result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
    if (node.expressions[index]) result += '{expr}';
  }
  return result;
}

function alphabeticOutsideParameters(text) {
  return /[A-Za-z]{2}/.test(String(text).replace(/\{[^{}]*\}/g, ''));
}

function proseText(value) {
  return String(value).replace(/\$?\{[^{}]*\}/g, '');
}

function hasFreeStandingTemplateWord(value) {
  return String(value).split(/\s+/u).some((token) => {
    let candidate = token;
    if (TEMPLATE_WORD_LEADING_CHARS.has(candidate[0])) candidate = candidate.slice(1);

    const trailingChar = candidate.at(-1);
    const strippedTrailing = TEMPLATE_WORD_TRAILING_CHARS.has(trailingChar)
      ? trailingChar
      : null;
    if (strippedTrailing) candidate = candidate.slice(0, -1);

    const markerAtStart = candidate.startsWith(TEMPLATE_PROSE_MARKER);
    const markerAtEnd = candidate.endsWith(TEMPLATE_PROSE_MARKER);
    if (markerAtStart !== markerAtEnd) {
      candidate = markerAtStart
        ? candidate.slice(TEMPLATE_PROSE_MARKER.length)
        : candidate.slice(0, -TEMPLATE_PROSE_MARKER.length);
    }

    if (!/^[\p{L}'’]+$/u.test(candidate)) return false;
    const letterCount = candidate.match(/\p{L}/gu)?.length ?? 0;
    return letterCount >= (strippedTrailing === '?' || strippedTrailing === ':' ? 2 : 3);
  });
}

function isProseText(value, node = null) {
  if (node?.type === 'TemplateLiteral' && node.expressions.length > 0) {
    return hasFreeStandingTemplateWord(value);
  }
  return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(proseText(value));
}

function isKeyboardChord(value) {
  return KEYBOARD_CHORD_RE.test(String(value));
}

function isMarkupFragment(value) {
  return /[<>]|="/.test(String(value));
}

function isQuotedHtml(value) {
  return /<[A-Za-z][^>]*>[\s\S]*<\/\s*[A-Za-z][^>]*>/.test(String(value));
}

function isUrlOrPath(value) {
  const text = String(value).trim();
  return text.includes('://') || /^(?:\/|\.\/|\.\.\/)/.test(text);
}

function isCssOrSelector(value) {
  const text = proseText(value).trim();
  const selectorAtom = String.raw`(?:[.#][A-Za-z_][\w-]*|\[[^\]\r\n]+\])`;
  const selectorOnly = new RegExp(
    `^${selectorAtom}(?:\\s*(?:[>+~]\\s*)?${selectorAtom})*$`
  );
  if (selectorOnly.test(text)) return true;
  if (/^<[A-Za-z][\w:-]*(?:\s|>|\/)/.test(text)) return true;
  if (/^(?:var\(\s*--[a-z][\w-]*\s*\)|rgba\(|calc\()/i.test(text)) return true;
  return /(?:^|[;{])\s*(?:--[a-z][\w-]*|[a-z][a-z0-9-]*)\s*:\s*[^;{}]+;/
    .test(text);
}

function isCssClassList(value) {
  return /^[a-z0-9_-]+(\s+[a-z0-9_-]+)+$/.test(proseText(value).trim());
}

function isParamsProseText(value) {
  const words = proseText(value).match(/\p{L}+/gu) || [];
  return words.length >= 2 || (words.length === 1 && words[0].length >= 3);
}

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') return templateText(node);
  return null;
}

function staticTranslationDefault(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return { text: node.value, via: 'literal' };
  }
  if (node?.type === 'TemplateLiteral') {
    if (node.expressions.length) return { error: 'default template literal must not contain expressions' };
    return { text: templateText(node), via: 'template' };
  }
  function concatenateLiterals(part) {
    if (part?.type === 'Literal' && typeof part.value === 'string') return part.value;
    if (part?.type !== 'BinaryExpression' || part.operator !== '+') return null;
    const left = concatenateLiterals(part.left);
    const right = concatenateLiterals(part.right);
    return left === null || right === null ? null : left + right;
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const text = concatenateLiterals(node);
    if (text !== null) return { text, via: 'concat' };
  }
  return { error: 'default must be a static string literal or concatenation of plain string literals' };
}

function scanJavaScript({ source, file, addCatalog, errors = [], remainders = [] }) {
  const ast = parseSource(source, file);
  const electronFile = file === 'main.js' || file.startsWith('services/');
  const declarations = indexDeclarations(ast);
  const parents = indexParents(ast);
  const occurrences = [];
  const handledProperties = new WeakSet();
  const emittedNodes = new WeakSet();
  const modelToolFile = file.startsWith('services/tools/');
  const remainderTexts = new Set(
    remainders.filter((entry) => entry.file === file).map((entry) => entry.text)
  );
  let sequence = 0;

  function emit(kind, item, disposition = 'pending') {
    if (file.startsWith('renderer/frames/')) disposition = 'excluded:frames';
    if (isKeyboardChord(item.text)) disposition = 'excluded:chord';
    emittedNodes.add(item.node);
    occurrences.push({
      file,
      kind,
      text: item.text,
      start: item.node.range[0],
      line: item.node.loc.start.line,
      via: item.via,
      disposition,
      sequence: sequence += 1,
    });
  }

  function resolveIdentifier(node, scope) {
    const scopes = scope === ast ? [ast] : [scope, ast];
    for (const candidateScope of scopes) {
      const candidates = declarations.get(candidateScope)?.get(node.name) || [];
      const preceding = candidates.filter((item) => item.range[0] < node.range[0]);
      if (preceding.length) return preceding.at(-1).init;
    }
    return null;
  }

  function extract(node, scope, overrideVia = null, resolving = false) {
    if (!node) return [];
    if (node.type === 'Literal' && typeof node.value === 'string') {
      return [{ node, text: node.value, via: overrideVia || 'literal' }];
    }
    if (node.type === 'TemplateLiteral') {
      const text = templateText(node);
      if (!alphabeticOutsideParameters(text)) return [];
      return [{ node, text, via: overrideVia || 'template' }];
    }
    if (node.type === 'ConditionalExpression') {
      return [
        ...extract(node.consequent, scope, overrideVia || 'conditional', resolving),
        ...extract(node.alternate, scope, overrideVia || 'conditional', resolving),
      ];
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      return [
        ...extract(node.left, scope, overrideVia || 'concat', resolving),
        ...extract(node.right, scope, overrideVia || 'concat', resolving),
      ].filter((item) => /[A-Za-z]{2}/.test(item.text));
    }
    if (node.type === 'ArrayExpression') {
      return node.elements.flatMap((element) => extract(element, scope, overrideVia || 'array', resolving));
    }
    if (node.type === 'Identifier' && !resolving) {
      const resolved = resolveIdentifier(node, scope);
      return resolved ? extract(resolved, scope, 'identifier', true) : [];
    }
    return [];
  }

  function emitValue(kind, value, scope, disposition = 'pending') {
    for (const item of extract(value, scope)) emit(kind, item, disposition);
  }

  function emitWireValue(value, scope, pendingKind = 'config_copy', excludedKind = 'structural') {
    for (const item of extract(value, scope)) {
      const serviceSentence = file.startsWith('services/')
        && /^[A-Z][^\s]*[.!?]$/.test(item.text);
      if (/\s/.test(item.text) || serviceSentence) emit(pendingKind, item);
      else emit(excludedKind, item, 'excluded:wire');
    }
  }

  function emitHtmlValue(value, scope) {
    for (const item of extract(value, scope)) {
      if (/^\s*["']?\s*(?:title|aria-label|placeholder|alt|data-tooltip)\s*=\s*["']?\s*$/i.test(item.text)) {
        continue;
      }
      if (/^\s*(?:class|role|aria-[\w-]+|tabindex|type|data-[\w-]+|id|style|href|src|rel|name)\s*=/i.test(item.text)) {
        continue;
      }
      const fragments = scanHtml({
        source: item.text,
        file,
        errors,
        addCatalog: (key, text) => addCatalog(
          key,
          text,
          file,
          item.node.range[0],
          item.node.loc.start.line
        ),
      });
      for (const fragment of fragments) {
        if (fragment.kind === 'html_text' && !alphabeticOutsideParameters(fragment.text)) continue;
        emit(
          fragment.kind === 'html_attr' ? 'dom_attr' : 'dom_text',
          { ...item, text: fragment.text },
          fragment.disposition
        );
      }
    }
  }

  function isMainTranslatorObject(node, scope) {
    if (node?.type !== 'Identifier') return false;
    if (['i18n', 'i18nMain'].includes(node.name)) return true;
    const initializer = resolveIdentifier(node, scope);
    return initializer?.type === 'CallExpression' && calleeName(initializer.callee) === 'createI18nMain';
  }

  function translationType(call, scope) {
    const callee = call.callee;
    if (callee.type === 'Identifier') {
      if (callee.name === 'jt') return 'singular';
      if (callee.name === 'jtn') return 'plural';
      if (file.startsWith('services/') && callee.name === 't') return 'singular';
      return null;
    }
    if (callee.type !== 'MemberExpression' || callee.object?.type !== 'Identifier') return null;
    const name = propertyName(callee.property);
    if (file.startsWith('services/') && name === 't' && isMainTranslatorObject(callee.object, scope)) {
      return 'singular';
    }
    if (callee.object.name !== 'jennyI18n') return null;
    if (name === 't' || name === 'jt') return 'singular';
    if (name === 'tn' || name === 'jtn') return 'plural';
    return null;
  }

  function recordTranslation(call, scope) {
    const type = translationType(call, scope);
    if (!type) return false;
    const keyArgument = call.arguments[0];
    if (keyArgument?.type !== 'Literal' || typeof keyArgument.value !== 'string') {
      errors.push(`${file}:${(keyArgument || call).loc.start.line}: translation key must be a plain string literal`);
      return true;
    }
    const key = keyArgument.value;
    const slots = type === 'singular'
      ? [[1, key]]
      : [[3, `${key}#one`], [4, `${key}#other`]];
    const defaults = [];
    for (const [argumentIndex, catalogKey] of slots) {
      const argument = call.arguments[argumentIndex];
      const result = staticTranslationDefault(argument);
      if (result.error) {
        errors.push(`${file}:${(argument || call).loc.start.line}: translation ${result.error}`);
      } else {
        defaults.push({ argument, catalogKey, ...result });
      }
    }
    if (defaults.length !== slots.length) return true;
    for (const item of defaults) {
      addCatalog(item.catalogKey, item.text, file, item.argument.range[0], item.argument.loc.start.line);
      emit('translation', { node: item.argument, text: item.text, via: item.via }, 'migrated');
    }
    processTranslationParams(call.arguments[2], scope);
    return true;
  }

  function allLeafStrings(node, scope, skipTranslations = false) {
    if (!node) return [];
    if (skipTranslations && node.type === 'CallExpression' && translationType(node, scope)) return [];
    if (node.type === 'Literal' && typeof node.value === 'string') {
      return [{ node, text: node.value, via: 'literal' }];
    }
    if (node.type === 'TemplateLiteral') {
      const text = templateText(node);
      return alphabeticOutsideParameters(text) ? [{ node, text, via: 'template' }] : [];
    }
    return childNodes(node).flatMap((child) => allLeafStrings(child, scope, skipTranslations));
  }

  function translationParamLeaves(node) {
    if (!node) return [];
    if (node.type === 'Literal' && typeof node.value === 'string') return [node];
    if (node.type === 'TemplateLiteral') return [node];
    if (node.type === 'ConditionalExpression') {
      return [...translationParamLeaves(node.consequent), ...translationParamLeaves(node.alternate)];
    }
    if (node.type === 'LogicalExpression' && node.operator === '||') {
      return [...translationParamLeaves(node.left), ...translationParamLeaves(node.right)];
    }
    return [];
  }

  function processTranslationParams(params, scope, resolving = false) {
    if (params?.type === 'Identifier' && !resolving) {
      processTranslationParams(resolveIdentifier(params, scope), scope, true);
      return;
    }
    if (params?.type !== 'ObjectExpression') return;
    for (const property of params.properties) {
      if (property.type !== 'Property') continue;
      const name = propertyName(property.key);
      if (property.value?.type === 'ObjectExpression') {
        processTranslationParams(property.value, scope);
        continue;
      }
      const leaves = translationParamLeaves(property.value);
      if (WIRE_PROPERTIES.has(name)) {
        for (const leaf of leaves) {
          const text = staticString(leaf);
          if (text && alphabeticOutsideParameters(text)) {
            emit('structural', { node: leaf, text, via: proseVia(leaf) }, 'excluded:wire');
          }
        }
        continue;
      }
      if (IDENTITY_PROPERTIES.has(name) || name === 'dataset') {
        for (const leaf of leaves) {
          const text = staticString(leaf);
          if (text && alphabeticOutsideParameters(text)) {
            emit('dom_identity', { node: leaf, text, via: proseVia(leaf) }, 'excluded:dom_identity');
          }
        }
        continue;
      }
      for (const leaf of leaves) {
        processProse(leaf, {
          allowElectron: true,
          kind: electronFile ? 'ipc_message' : 'prose',
          knownCopy: true,
        });
      }
    }
  }

  function isLogCall(call) {
    const name = calleeName(call.callee) || '';
    return [...LOG_NAMES].some((candidate) => candidate.toLowerCase() === name.toLowerCase())
      || /^(?:warn|log|debug|trace)/i.test(name)
      || (call.callee.type === 'MemberExpression' && call.callee.object?.name === 'console');
  }

  function isInvariantCall(call) {
    const name = calleeName(call.callee) || '';
    if (call.type === 'NewExpression') return /Error$/.test(name);
    return /^(?:assert|invariant)/i.test(name);
  }

  function isDisplayErrorCall(call) {
    return call.type === 'CallExpression' && DISPLAY_ERROR_NAMES.has(calleeName(call.callee));
  }

  function isToastCall(call) {
    const name = calleeName(call.callee) || '';
    return TOAST_NAMES.has(name) || /^show[A-Z]\w*(Toast|Error|Notice|Message)$/.test(name);
  }

  function isNativeDialog(call) {
    return ['alert', 'confirm', 'prompt'].includes(calleeName(call.callee));
  }

  function isJennyLocaleTag(node) {
    // Accepts `jennyI18n.tag()` and the guarded `globalThis.jennyI18n?.tag?.()`
    // form modules use so a bare node require() without the runtime still formats.
    const call = node?.type === 'ChainExpression' ? node.expression : node;
    if (call?.type !== 'CallExpression' || call.callee?.type !== 'MemberExpression') return false;
    if (propertyName(call.callee.property) !== 'tag') return false;
    const object = call.callee.object;
    return object?.name === 'jennyI18n'
      || (object?.type === 'MemberExpression' && object.object?.name === 'globalThis'
        && propertyName(object.property) === 'jennyI18n');
  }

  function isFormatCall(node) {
    const callee = node.callee;
    if (callee?.type !== 'MemberExpression') return false;
    const name = propertyName(callee.property);
    return FORMAT_METHODS.has(name)
      || (callee.object?.name === 'Intl' && INTL_FORMATTERS.has(name));
  }

  function shouldAuditLocale(node) {
    const first = node.arguments[0];
    if (isJennyLocaleTag(first)) return false;
    return !first
      || (first.type === 'Identifier' && first.name === 'undefined')
      || (first.type === 'Literal' && typeof first.value === 'string')
      || (first.type === 'ArrayExpression' && first.elements.length === 0);
  }

  function processSpecialObject(
    object,
    properties,
    kind,
    scope,
    disposition = 'pending',
    wireTokens = false
  ) {
    if (object?.type !== 'ObjectExpression') return;
    for (const property of object.properties) {
      if (property.type !== 'Property') continue;
      const name = propertyName(property.key);
      if (!properties.has(name)) continue;
      handledProperties.add(property);
      if (wireTokens) emitWireValue(property.value, scope, kind, kind);
      else emitValue(kind, property.value, scope, disposition);
    }
  }

  function processAssignment(node, scope) {
    if (node.left?.type !== 'MemberExpression') return;
    const name = propertyName(node.left.property);
    if (DOM_TEXT_PROPERTIES.has(name)) {
      if (name === 'innerHTML') emitHtmlValue(node.right, scope);
      else emitValue('dom_text', node.right, scope);
      return;
    }
    if (DOM_ATTRIBUTE_PROPERTIES.has(name)) {
      emitValue('dom_attr', node.right, scope);
      return;
    }
    const dataset = node.left.object?.type === 'MemberExpression'
      && propertyName(node.left.object.property) === 'dataset';
    if (IDENTITY_PROPERTIES.has(name) || dataset) {
      if (name === 'className') {
        const items = extract(node.right, scope);
        for (const item of items) {
          if (!isCssClassList(item.text)) emit('dom_identity', item, 'excluded:dom_identity');
        }
        return;
      }
      emitValue('dom_identity', node.right, scope, 'excluded:dom_identity');
    }
  }

  function processCall(node, scope) {
    const name = calleeName(node.callee);
    if (electronFile) {
      if (['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showSaveDialog'].includes(name)) {
        for (const argument of node.arguments) {
          processSpecialObject(argument, MAIN_DIALOG_PROPERTIES, 'main_dialog', scope);
        }
      }
      if (file.startsWith('services/') && ['reject', 'resolve'].includes(name)) {
        processSpecialObject(node.arguments[0], IPC_PROPERTIES, 'ipc_message', scope, 'pending', true);
      }
      return false;
    }
    if (isInvariantCall(node)) {
      const items = extract(node.arguments[0], scope);
      for (const item of items) {
        emit('prose', item, 'excluded:invariant');
      }
      if (items.length) return true;
    }
    if (isLogCall(node)) {
      for (const argument of node.arguments) {
        for (const item of allLeafStrings(argument, scope, true)) {
          emit('diagnostic', item, 'excluded:log');
        }
      }
      return true;
    }
    if (isFormatCall(node) && shouldAuditLocale(node)
      && !/(?:jenny-?i18n|i18n-utils)\.js$/i.test(file)) {
      emit('format_locale', {
        node,
        text: source.slice(node.range[0], node.range[1]),
        via: 'literal',
      });
    }
    if (isDisplayErrorCall(node)) emitValue('prose', node.arguments[0], scope);
    else if (isToastCall(node)) emitValue('toast', node.arguments[0], scope);
    if (isNativeDialog(node)) emitValue('native_dialog', node.arguments[0], scope);
    if (name === 'insertAdjacentHTML') emitHtmlValue(node.arguments[1], scope);
    if (name === 'createTextNode') emitValue('dom_text', node.arguments[0], scope);
    if (['append', 'prepend', 'replaceChildren'].includes(name)) {
      for (const argument of node.arguments) emitValue('dom_text', argument, scope);
    }
    if (name === 'setAttribute') {
      const attribute = staticString(node.arguments[0])?.toLowerCase();
      if (['title', 'aria-label', 'placeholder', 'alt', 'data-tooltip'].includes(attribute)) {
        emitValue('dom_attr', node.arguments[1], scope);
      } else if (attribute === 'class') {
        const items = extract(node.arguments[1], scope);
        for (const item of items) {
          if (!isCssClassList(item.text)) emit('dom_identity', item, 'excluded:dom_identity');
        }
      } else if (attribute?.startsWith('data-') || IDENTITY_ATTRIBUTES.has(attribute)) {
        emitValue('dom_identity', node.arguments[1], scope, 'excluded:dom_identity');
      }
    }
    if (name === 'createElement') {
      emitValue('dom_identity', node.arguments[0], scope, 'excluded:dom_identity');
    }
    const memberObjectName = node.callee?.type === 'MemberExpression'
      ? propertyName(node.callee.object?.property)
      : null;
    if (memberObjectName === 'classList'
      || SELECTOR_NAMES.has(name) || name === 'getElementById') {
      for (const argument of node.arguments) {
        const items = extract(argument, scope);
        for (const item of items) {
          if (memberObjectName !== 'classList' || !isCssClassList(item.text)) {
            emit('dom_identity', item, 'excluded:dom_identity');
          }
        }
      }
    }
    return false;
  }

  function processProperty(node, scope) {
    if (electronFile || handledProperties.has(node) || node.type !== 'Property') return;
    const name = propertyName(node.key);
    if (!name) return;
    if (isComparisonVocabulary(node.value)) return;
    const modelPath = /\/(?:tools|context)\/|\/prompt/i.test(`/${file}`);
    if (modelPath && MODEL_PROPERTIES.has(name)) {
      emitValue('model_facing', node.value, scope, 'excluded:model_facing');
      return;
    }
    if (WIRE_PROPERTIES.has(name)) {
      emitWireValue(node.value, scope);
      return;
    }
    if (CONFIG_PROPERTIES.has(name)) emitValue('config_copy', node.value, scope);
  }

  function proseVia(node) {
    const found = { array: false, concat: false, property: false, argument: false };
    let current = node;
    let parent = parents.get(current);
    while (parent) {
      if (parent.type === 'ReturnStatement'
        || (parent.type === 'ArrowFunctionExpression' && parent.body === current)) {
        return 'return';
      }
      if (parent.type === 'ArrayExpression') found.array = true;
      if (parent.type === 'BinaryExpression' && parent.operator === '+') found.concat = true;
      if (parent.type === 'Property' && parent.value === current) found.property = true;
      if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
        const name = calleeName(parent.callee);
        if (['push', 'unshift'].includes(name)) found.array = true;
        else found.argument = true;
      }
      if (isFunction(parent) || parent.type.endsWith('Statement')) break;
      current = parent;
      parent = parents.get(current);
    }
    if (found.array) return 'array';
    if (found.concat) return 'concat';
    if (found.property) return 'property';
    if (found.argument) return 'argument';
    if (node.type === 'TemplateLiteral') return 'template';
    return 'property';
  }

  function isComparisonOperand(node) {
    let current = node;
    let parent = parents.get(current);
    while (parent?.type === 'BinaryExpression' && parent.operator === '+') {
      current = parent;
      parent = parents.get(current);
    }
    if (parent?.type === 'BinaryExpression' && COMPARISON_OPERATORS.has(parent.operator)) return true;
    if (parent?.type === 'SwitchCase' && parent.test === current) return true;
    if (parent?.type !== 'CallExpression' || !parent.arguments.includes(current)) return false;
    return COMPARISON_METHODS.has(calleeName(parent.callee));
  }

  function isComparisonVocabulary(node) {
    let parent = parents.get(node);
    while (parent) {
      if (parent.type === 'VariableDeclarator') {
        return parent.id?.type === 'Identifier'
          && /^[A-Z][A-Z0-9_]*_(?:HINTS|VOCABULARY|KEYWORDS|MATCHERS|ALIASES)$/.test(parent.id.name);
      }
      if (isFunction(parent) || parent.type.endsWith('Statement')) break;
      parent = parents.get(parent);
    }
    return false;
  }

  function isProseContextExcluded(node) {
    const modelPath = /\/(?:tools|context)\/|\/prompt/i.test(`/${file}`);
    let current = node;
    let parent = parents.get(current);
    while (parent) {
      if (parent.type === 'ExpressionStatement' && parent.directive) return true;
      if (parent.type === 'Property') {
        if (parent.key === current) return true;
        const name = propertyName(parent.key);
        if (WIRE_PROPERTIES.has(name) || IDENTITY_PROPERTIES.has(name) || name === 'dataset') return true;
        if (modelPath && MODEL_PROPERTIES.has(name)) return true;
      }
      if (parent.type === 'AssignmentExpression' && parent.right === current
        && parent.left?.type === 'MemberExpression') {
        const name = propertyName(parent.left.property);
        const dataset = parent.left.object?.type === 'MemberExpression'
          && propertyName(parent.left.object.property) === 'dataset';
        if (IDENTITY_PROPERTIES.has(name) || dataset) return true;
      }
      if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
        const name = calleeName(parent.callee);
        if (SELECTOR_NAMES.has(name) || name === 'getElementById' || name === 'RegExp') return true;
        if (name === 'setAttribute') {
          const attribute = staticString(parent.arguments[0])?.toLowerCase();
          if (attribute?.startsWith('data-') || IDENTITY_ATTRIBUTES.has(attribute)) return true;
        }
      }
      if (parent.type === 'MemberExpression' && parent.property === current) return true;
      if (isFunction(parent) || parent.type.endsWith('Statement')) break;
      current = parent;
      parent = parents.get(current);
    }
    return false;
  }

  function emitProseMarkup(item, kind = 'prose') {
    const attributeRe = /\b(title|aria-label|placeholder|alt|data-tooltip)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let attributeMatch;
    while ((attributeMatch = attributeRe.exec(item.text))) {
      const text = attributeMatch[2] ?? attributeMatch[3] ?? '';
      if (!DISPLAY_ATTRIBUTES.has(attributeMatch[1].toLowerCase())) continue;
      if (!isProseText(text, item.node) && !isKeyboardChord(text)) continue;
      emit(kind, { ...item, text, via: 'html_attr' });
    }

    const text = item.text
      .replace(/\b[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, ' ')
      .replace(/\b[\w:-]+\s*=\s*(?:"[^"]*|'[^']*)$/i, ' ')
      .replace(/<\/?[a-z][^<>]*>?/gi, ' ')
      .replace(/^[^<>]*>/, ' ')
      .replace(/<[^<>]*$/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[A-Za-z]{2}/.test(proseText(text))) return;
    if (isProseText(text, item.node) || isKeyboardChord(text)) emit(kind, { ...item, text });
  }

  function emitProseHtml(item, kind = 'prose') {
    const fragments = scanHtml({
      source: item.text,
      file,
      errors,
      addCatalog: (key, text) => addCatalog(
        key,
        text,
        file,
        item.node.range[0],
        item.node.loc.start.line
      ),
    });
    for (const fragment of fragments) {
      if (!isProseText(fragment.text, item.node) && !isKeyboardChord(fragment.text)) continue;
      emit(kind, { ...item, text: fragment.text }, fragment.disposition);
    }
  }

  function processProse(node, { allowElectron = false, kind = 'prose', knownCopy = false } = {}) {
    if ((electronFile && !allowElectron) || emittedNodes.has(node)) return;
    if (node.type !== 'TemplateLiteral'
      && !(node.type === 'Literal' && typeof node.value === 'string')) return;
    const text = staticString(node);
    if (!text) return;
    const item = { node, text, via: proseVia(node) };
    if (isKeyboardChord(text)) {
      emit(kind, item, 'excluded:chord');
      return;
    }
    if (isComparisonVocabulary(node) && alphabeticOutsideParameters(text)) {
      emit(kind, item, 'excluded:comparison');
      return;
    }
    if (isComparisonOperand(node) && isProseText(text, node)) {
      emit(kind, item, 'excluded:comparison');
      return;
    }
    if (isQuotedHtml(text)) {
      emitProseHtml(item, kind);
      return;
    }
    if (isMarkupFragment(text)) {
      emitProseMarkup(item, kind);
      return;
    }
    const isProse = knownCopy ? isParamsProseText(text) : isProseText(text, node);
    if (!isProse || PROPER_NOUNS.has(text) || isUrlOrPath(text)
      || isProseContextExcluded(node)) return;
    if (isCssOrSelector(text)) return;
    emit(kind, item);
  }

  function visit(node, scope, suppressed = false) {
    const nextScope = node.type === 'Program' || isFunction(node) ? node : scope;
    const isTranslation = node.type === 'CallExpression'
      ? recordTranslation(node, nextScope)
      : false;
    if (suppressed) {
      for (const child of childNodes(node)) visit(child, nextScope, true);
      return;
    }
    if (!electronFile && node.type === 'AssignmentExpression') processAssignment(node, nextScope);
    const callable = node.type === 'CallExpression' || node.type === 'NewExpression';
    let suppressChildren = callable ? (isTranslation || processCall(node, nextScope)) : false;
    if (!electronFile && node.type === 'ThrowStatement') {
      for (const item of allLeafStrings(node.argument, nextScope, true)) {
        emit('prose', item, 'excluded:invariant');
      }
      suppressChildren = true;
    }
    if (node.type === 'Property') processProperty(node, nextScope);
    if (file.startsWith('services/') && node.type === 'ReturnStatement') {
      processSpecialObject(
        node.argument,
        modelToolFile ? TOOL_RESULT_PROPERTIES : IPC_PROPERTIES,
        'ipc_message',
        nextScope,
        modelToolFile ? 'excluded:model' : 'pending',
        !modelToolFile
      );
    }
    if (file.startsWith('services/') && node.type === 'ThrowStatement'
      && node.argument?.type === 'NewExpression' && calleeName(node.argument.callee) === 'Error') {
      processSpecialObject(
        node.argument.arguments[0],
        modelToolFile ? TOOL_RESULT_PROPERTIES : IPC_PROPERTIES,
        'ipc_message',
        nextScope,
        modelToolFile ? 'excluded:model' : 'pending',
        !modelToolFile
      );
    }
    if (node.type === 'Literal' && typeof node.value === 'string'
      && remainderTexts.has(node.value) && !emittedNodes.has(node)) {
      emit('config_copy', { node, text: node.value, via: 'literal' });
    }
    processProse(node);
    for (const child of childNodes(node)) visit(child, nextScope, suppressChildren);
  }

  visit(ast, ast);
  return occurrences;
}

module.exports = { scanJavaScript };
