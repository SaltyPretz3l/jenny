/*
 * Bounded runtime-state preservation for structural transcript morphs.
 *
 * Generated markup remains authoritative. Components opt in only when they
 * have a stable source fingerprint; matching components retain their live DOM
 * identity, while small presentation states and focus are captured/restored
 * around the morph. A failed restore is isolated to that component.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComponentPreservationRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CAPTURE_CAP = 64;
  const IDENTITY_ATTRIBUTES = Object.freeze([
    'data-row-id',
    'data-message-id',
    'data-thread-message-id',
    'data-tool-call-id',
    'data-call-id',
    'data-attachment-id',
  ]);

  function hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function matchesSafe(node, selector) {
    try { return Boolean(node?.matches?.(selector)); } catch (_error) { return false; }
  }

  function queryAllSafe(rootNode, selector) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return [];
    try { return Array.from(rootNode.querySelectorAll(selector)); } catch (_error) { return []; }
  }

  function collectSelfAndDescendants(rootNode, selector) {
    const nodes = matchesSafe(rootNode, selector) ? [rootNode] : [];
    return nodes.concat(queryAllSafe(rootNode, selector));
  }

  function readIdentity(node) {
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      for (const attribute of IDENTITY_ATTRIBUTES) {
        const value = String(current.getAttribute?.(attribute) || '').trim();
        if (value) return `${attribute}:${value}`;
      }
    }
    return '';
  }

  function readMediaSource(node) {
    const declaredSource = String(node?.getAttribute?.('src') || '').trim();
    const childSources = queryAllSafe(node, 'source')
      .map((source) => String(source.getAttribute?.('src') || source.src || '').trim())
      .filter(Boolean);
    if (declaredSource || childSources.length) {
      return [declaredSource, ...childSources].filter(Boolean).join('\x1f');
    }
    return String(node?.currentSrc || node?.src || '').trim();
  }

  function readCodeSource(node) {
    return String(node?.querySelector?.('code')?.textContent || node?.textContent || '').trim();
  }

  function readDetailsSource(node) {
    const summary = String(node?.querySelector?.('summary')?.textContent || '').trim();
    return `${summary}\x1f${String(node?.textContent || '').trim()}`;
  }

  function makeDefaultDefinitions() {
    return [
      {
        name: 'mermaid',
        selector: '.markdown-mermaid-block[data-mermaid-source]',
        preserveIdentity: true,
        source(node) { return String(node.getAttribute('data-mermaid-source') || '').trim(); },
      },
      {
        name: 'code',
        selector: '.markdown-code-block',
        preserveIdentity: true,
        source: readCodeSource,
      },
      {
        name: 'media',
        selector: 'audio, video',
        preserveIdentity: true,
        source: readMediaSource,
      },
      {
        name: 'details',
        selector: 'details',
        preserveIdentity: true,
        source: readDetailsSource,
      },
      {
        name: 'user-questions',
        selector: '.user-questions-block[data-question-ref]',
        preserveIdentity: true,
        source(node) { return String(node.getAttribute('data-question-ref') || '').trim(); },
        capture(node) {
          return queryAllSafe(node, '[data-user-question-id]').map((question) => {
            const otherToggle = question.querySelector?.('[data-user-question-other-toggle]');
            const otherInput = question.querySelector?.('[data-user-question-other-input]');
            const freeText = question.querySelector?.('[data-user-question-free-text]');
            return {
              id: String(question.getAttribute('data-user-question-id') || ''),
              checked: queryAllSafe(question, '[data-user-question-option]:checked').map((input) => String(input.value || '')),
              otherChecked: otherToggle?.checked === true,
              otherText: otherInput ? String(otherInput.value || '') : null,
              freeText: freeText ? String(freeText.value || '') : null,
            };
          });
        },
        restore(node, state) {
          const questions = queryAllSafe(node, '[data-user-question-id]');
          for (const saved of Array.isArray(state) ? state : []) {
            const question = questions.find((candidate) => candidate.getAttribute('data-user-question-id') === saved?.id);
            if (!question) continue;
            const checked = new Set(Array.isArray(saved.checked) ? saved.checked.map(String) : []);
            for (const input of queryAllSafe(question, '[data-user-question-option]')) input.checked = checked.has(String(input.value || ''));
            const otherToggle = question.querySelector?.('[data-user-question-other-toggle]');
            const otherInput = question.querySelector?.('[data-user-question-other-input]');
            const freeText = question.querySelector?.('[data-user-question-free-text]');
            if (otherToggle) otherToggle.checked = saved.otherChecked === true;
            if (otherInput && typeof saved.otherText === 'string') {
              otherInput.value = saved.otherText;
              otherInput.disabled = otherToggle?.checked !== true;
            }
            if (freeText && typeof saved.freeText === 'string') freeText.value = saved.freeText;
          }
        },
      },
      {
        name: 'expanded-row',
        selector: '.tool-call-row[data-expanded]',
        preserveIdentity: false,
        source(node) { return readIdentity(node); },
        capture(node) { return node.getAttribute('data-expanded') === 'true'; },
        restore(node, expanded) {
          // A replacement row rendered collapsed and lazy (details not
          // materialized) has an empty body: forcing it open would show an
          // expanded header over nothing. That shape only arises when the old
          // row's expansion was status-driven (awaiting approval) rather than
          // the user's, whose toggle the renderer already honours.
          if (expanded && node.getAttribute('data-tool-details-materialized') === 'false') return;
          node.setAttribute('data-expanded', expanded ? 'true' : 'false');
          for (const toggle of queryAllSafe(node, '[aria-expanded]')) {
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          }
          for (const body of queryAllSafe(node, '.tool-call-row-body')) {
            if (expanded) body.removeAttribute('inert');
            else body.setAttribute('inert', '');
          }
        },
      },
    ];
  }

  function definitionKey(definition, node) {
    if (!definition || !node) return '';
    let source;
    try { source = String(definition.source?.(node) || '').trim(); } catch (_error) { return ''; }
    if (!source) return '';
    return `component:${definition.name}:${hashText(source)}`;
  }

  function findDefinition(definitions, node, identityOnly) {
    for (const definition of definitions) {
      if (identityOnly && definition.preserveIdentity !== true) continue;
      if (matchesSafe(node, definition.selector)) return definition;
    }
    return null;
  }

  function captureFocus(rootNode) {
    const doc = rootNode?.ownerDocument || null;
    const active = doc?.activeElement || null;
    if (!active || active === doc.body || !(rootNode === active || rootNode?.contains?.(active))) {
      return null;
    }
    const messageIdentityNode = active.closest?.('[data-message-id]') || null;
    const chatEntry = messageIdentityNode?.closest?.('.chat-entry') || null;
    let anchor = chatEntry && (chatEntry === rootNode || rootNode?.contains?.(chatEntry))
      ? chatEntry
      : active;
    while (anchor && anchor !== rootNode && !readIdentity(anchor)) anchor = anchor.parentElement;
    if (!anchor) anchor = rootNode;
    const path = [];
    for (let node = active; node && node !== anchor; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, node));
    }
    return {
      active,
      anchorIdentity: readIdentity(anchor),
      path,
      tagName: String(active.tagName || ''),
      action: String(active.getAttribute?.('data-action') || active.getAttribute?.('data-message-action') || ''),
    };
  }

  function findByIdentity(rootNode, identity) {
    if (!identity) return rootNode;
    const splitAt = identity.indexOf(':');
    const attribute = identity.slice(0, splitAt);
    const value = identity.slice(splitAt + 1);
    return collectSelfAndDescendants(rootNode, `[${attribute}]`)
      .find((node) => String(node.getAttribute?.(attribute) || '') === value) || null;
  }

  function restoreFocus(rootNode, focusState) {
    if (!focusState) return;
    const doc = rootNode?.ownerDocument || null;
    if (focusState.active?.isConnected && (rootNode === focusState.active || rootNode?.contains?.(focusState.active))) {
      return;
    }
    const anchor = findByIdentity(rootNode, focusState.anchorIdentity) || rootNode;
    let target = anchor;
    for (const index of focusState.path) {
      target = target?.children?.[index] || null;
      if (!target) break;
    }
    if (
      !target
      || (focusState.tagName && String(target.tagName || '') !== focusState.tagName)
      || (focusState.action && String(target.getAttribute?.('data-action') || target.getAttribute?.('data-message-action') || '') !== focusState.action)
    ) {
      target = focusState.action
        ? queryAllSafe(anchor, '[data-action], [data-message-action]').find((candidate) => (
          String(candidate.getAttribute?.('data-action') || candidate.getAttribute?.('data-message-action') || '')
            === focusState.action
        )) || anchor
        : anchor;
    }
    if (!target || typeof target.focus !== 'function') return;
    const hadTabindex = target.hasAttribute?.('tabindex') === true;
    const priorTabindex = target.getAttribute?.('tabindex');
    if (!hadTabindex) target.setAttribute?.('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (_error) { target.focus(); }
    if (!hadTabindex) target.removeAttribute?.('tabindex');
    else if (priorTabindex !== null) target.setAttribute?.('tabindex', priorTabindex);
  }

  function createComponentPreservationRegistry(options = {}) {
    const captureCap = Number.isFinite(options.captureCap)
      ? Math.max(1, Math.trunc(options.captureCap))
      : DEFAULT_CAPTURE_CAP;
    const definitions = makeDefaultDefinitions();
    let disposed = false;

    function register(definition) {
      if (disposed || !definition || !definition.name || !definition.selector) return () => {};
      definitions.push(definition);
      return function unregister() {
        const index = definitions.indexOf(definition);
        if (index >= 0) definitions.splice(index, 1);
      };
    }

    function getNodeKey(node) {
      if (disposed || !node || node.nodeType !== 1) return '';
      const definition = findDefinition(definitions, node, true);
      return definitionKey(definition, node);
    }

    function shouldRetainNode(currentNode, nextNode) {
      const currentKey = getNodeKey(currentNode);
      return Boolean(currentKey && currentKey === getNodeKey(nextNode));
    }

    function capture(rootNode) {
      if (disposed || !rootNode) return null;
      const entries = [];
      for (const definition of definitions) {
        if (typeof definition.capture !== 'function' || typeof definition.restore !== 'function') continue;
        const occurrences = new Map();
        for (const node of collectSelfAndDescendants(rootNode, definition.selector)) {
          if (entries.length >= captureCap) break;
          const baseKey = definitionKey(definition, node);
          if (!baseKey) continue;
          const ordinal = occurrences.get(baseKey) || 0;
          occurrences.set(baseKey, ordinal + 1);
          try {
            entries.push({ definition, key: `${baseKey}:${ordinal}`, value: definition.capture(node) });
          } catch (_error) { /* one component must not suppress later captures */ }
        }
      }
      return { entries, focus: captureFocus(rootNode) };
    }

    function restore(rootNode, snapshot, options = {}) {
      if (disposed || !rootNode || !snapshot) return;
      const onError = typeof options.onError === 'function' ? options.onError : null;
      for (const definition of definitions) {
        if (typeof definition.restore !== 'function') continue;
        const occurrences = new Map();
        const byKey = new Map();
        for (const node of collectSelfAndDescendants(rootNode, definition.selector)) {
          const baseKey = definitionKey(definition, node);
          if (!baseKey) continue;
          const ordinal = occurrences.get(baseKey) || 0;
          occurrences.set(baseKey, ordinal + 1);
          byKey.set(`${baseKey}:${ordinal}`, node);
        }
        for (const entry of snapshot.entries || []) {
          if (entry.definition !== definition) continue;
          const node = byKey.get(entry.key);
          if (!node) continue;
          try { definition.restore(node, entry.value); } catch (error) { onError?.(error, definition.name); }
        }
      }
      try { restoreFocus(rootNode, snapshot.focus); } catch (error) { onError?.(error, 'focus'); }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      definitions.length = 0;
    }

    return { capture, dispose, getNodeKey, register, restore, shouldRetainNode };
  }

  return { DEFAULT_CAPTURE_CAP, createComponentPreservationRegistry, hashText };
});
