/* global window, document, ResizeObserver */

(function () {
  const root = document.getElementById('diagram-root');
  let resizeObserver = null;
  let activeRequestId = '';
  const parentOrigin = resolveParentOrigin();

  function resolveParentOrigin() {
    const origin = String(window.location?.origin || '').trim();
    return origin && origin !== 'null' ? origin : '*';
  }

  function postToParent(payload) {
    window.parent.postMessage(payload, parentOrigin);
  }

  function disconnectResizeObserver() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  function measureHeight() {
    return Math.max(
      Math.ceil(document.documentElement?.scrollHeight || 0),
      Math.ceil(document.body?.scrollHeight || 0),
      Math.ceil(root?.scrollHeight || 0),
      60
    );
  }

  function observeHeight(requestId, target) {
    disconnectResizeObserver();
    if (!target || typeof ResizeObserver !== 'function') {
      return;
    }
    resizeObserver = new ResizeObserver(function () {
      postToParent({
        type: 'height',
        requestId,
        height: measureHeight(),
      });
    });
    resizeObserver.observe(target);
  }

  function normalizeMermaidLabelContainers(svgRoot, labelStyles) {
    if (!svgRoot || !labelStyles) {
      return;
    }
    const containerFill = sanitizeSimpleColor(labelStyles.containerFill);
    const containerStroke = sanitizeSimpleColor(labelStyles.containerStroke);
    const textColor = sanitizeSimpleColor(labelStyles.textColor);
    if (!containerFill && !containerStroke && !textColor) {
      return;
    }

    svgRoot.querySelectorAll('rect.basic.label-container, polygon.label-container').forEach((node) => {
      if (containerFill) {
        node.setAttribute('fill', containerFill);
        node.style.fill = containerFill;
      }
      if (containerStroke) {
        node.setAttribute('stroke', containerStroke);
        node.style.stroke = containerStroke;
      }
    });

    svgRoot.querySelectorAll('.node .label text, .node .label tspan').forEach((node) => {
      if (!textColor) {
        return;
      }
      node.setAttribute('fill', textColor);
      node.style.fill = textColor;
    });

    svgRoot.querySelectorAll('.node .label foreignObject div, .node .label span, .node .label p').forEach((node) => {
      if (!textColor || !node?.style) {
        return;
      }
      node.style.color = textColor;
    });
  }

  function sanitizeSimpleColor(value) {
    const token = String(value || '').trim();
    if (!token) {
      return '';
    }
    if (/^#[0-9a-f]{3,8}$/i.test(token)) {
      return token;
    }
    if (/^(?:rgb|hsl)a?\s*\(/i.test(token)) {
      return token;
    }
    if (/^[a-z]{3,20}$/i.test(token)) {
      return token;
    }
    return '';
  }

  async function renderDiagram(payload) {
    const requestId = String(payload?.requestId || '').trim();
    const source = String(payload?.source || '');
    const config = payload?.config && typeof payload.config === 'object'
      ? payload.config
      : {};
    const labelStyles = payload?.labelStyles && typeof payload.labelStyles === 'object'
      ? payload.labelStyles
      : null;

    activeRequestId = requestId;
    root.innerHTML = '';
    disconnectResizeObserver();

    if (!requestId || !source.trim()) {
      postToParent({
        type: 'rendered',
        requestId,
        ok: false,
        error: 'Mermaid source is empty.',
      });
      return;
    }

    if (!window.mermaid || typeof window.mermaid.initialize !== 'function' || typeof window.mermaid.render !== 'function') {
      postToParent({
        type: 'rendered',
        requestId,
        ok: false,
        error: 'Mermaid runtime is unavailable.',
      });
      return;
    }

    try {
      window.mermaid.initialize(Object.assign({}, config, {
        startOnLoad: false,
        securityLevel: 'strict',
      }));
      const renderResult = await Promise.resolve(
        window.mermaid.render(`diagram-${requestId}`, source)
      );
      const svg = typeof renderResult === 'string'
        ? renderResult
        : (renderResult && typeof renderResult.svg === 'string' ? renderResult.svg : '');
      if (!svg.trim()) {
        throw new Error('Mermaid returned an empty diagram.');
      }
      root.innerHTML = svg;
      const svgNode = root.querySelector('svg');
      normalizeMermaidLabelContainers(svgNode, labelStyles);
      observeHeight(requestId, svgNode || root);
      postToParent({
        type: 'rendered',
        requestId,
        ok: true,
        height: measureHeight(),
      });
    } catch (error) {
      if (activeRequestId !== requestId) {
        return;
      }
      postToParent({
        type: 'rendered',
        requestId,
        ok: false,
        error: String(error && error.message || error || 'Mermaid render failed.'),
      });
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) {
      return;
    }
    if (parentOrigin !== '*' && event.origin !== parentOrigin) {
      return;
    }
    const payload = event?.data;
    if (!payload || payload.type !== 'render') {
      return;
    }
    renderDiagram(payload);
  });

  // Announce only after the receiver exists. The parent also listens for load
  // and sends exactly once on whichever signal arrives first.
  postToParent({ type: 'mermaid-frame-ready' });

  window.addEventListener('beforeunload', disconnectResizeObserver);
})();
