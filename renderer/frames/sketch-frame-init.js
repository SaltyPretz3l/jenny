/* global window, document, ResizeObserver */

/*
 * The sandboxed sketch frame's own script (sketch-frame.html, served by
 * services/sketch-frame-protocol.js). It is the only code that talks to the page that embeds the
 * frame. The drawing core is the `jennySketch` global from sketch-frame.bundle.js.
 *
 * In:  { type: 'theme', palette }                                colours for the next draw; redraws the current one
 *      { type: 'render', requestId, source, previous, earlier }  draw this source. `earlier` is up to four
 *                                                                { source, positions } of the conversation's earlier
 *                                                                drawings, nearest first, for a follow-up (plan 5.5)
 *      { type: 'export', requestId, kind }                       kind: svg | png | excalidraw
 *      { type: 'markup', requestId, on, picture }                drawing mode on or off; `picture` lets a question
 *                                                                about the marks carry the marked-up picture
 *      { type: 'ask-result', requestId, askId, ok }              the page took (or refused) a question
 *      { type: 'outline', requestId }                            the structure of the drawing that is up (board cards)
 * Out: { type: 'sketch-frame-ready' }                            once, when this script has its listener
 *      { type: 'rendered', requestId, ok: true, height, width, problems, counts, positions }
 *      { type: 'rendered', requestId, ok: false, reason, problems }
 *      { type: 'height', requestId, height }                     whenever the drawing's height changes
 *      { type: 'open-file', requestId, path, line }              a node that names a file was clicked
 *      { type: 'export', requestId, kind, ok, name, text | base64 }
 *      { type: 'ask', requestId, askId, text, pngBase64? }       a question about the person's marks
 *      { type: 'markup', requestId, on }                         drawing mode changed inside the frame
 *      { type: 'outline', requestId, ok: true, nodes: [{ id, label, group }], groups: [{ id, label, parent }],
 *        edges: [{ from, to, label, dashed }] }                  plain bounded data only; or { type, requestId, ok: false }
 *
 * The frame has an opaque origin and no way to name its parent's, so it posts with '*'. What it
 * posts is only what it was sent or what the person did in it; the page checks every field again
 * (renderer-sketch-frame-messages.js). The viewer's own toolbar is hidden (theme-override.css): the
 * page's action row drives export and drawing mode through the messages above.
 */
(function () {
  'use strict';

  var root = document.getElementById('sketch-root');
  var api = window.jennySketch || null;
  var bounds = (api && api.SKETCH_BOUNDS) || { chars: 16384, lines: 400 };
  var MAX_PROBLEMS = 50;
  var MAX_REQUEST_ID = 128;
  var MAX_EARLIER = 4;
  var MAX_PATH = 1024;
  var MAX_ASK_TEXT = 8000;
  var ASK_TIMEOUT_MS = 4000;
  var EXPORT_KINDS = { svg: true, png: true, excalidraw: true };
  var OUTLINE_MAX = { nodes: 120, groups: 50, edges: 400, id: 64, label: 400 };
  var resizeObserver = null;
  var markupObserver = null;
  var active = null;
  var generation = 0;
  var askSequence = 0;
  var asks = {};
  var sendPicture = false;

  function post(payload) {
    window.parent.postMessage(payload, '*');
  }

  function measureHeight() {
    var box = root && typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    return Math.max(Math.ceil((box && box.height) || 0), Math.ceil((root && root.scrollHeight) || 0), 0);
  }

  function stopObserving() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (markupObserver) {
      markupObserver.disconnect();
      markupObserver = null;
    }
  }

  function observeHeight(requestId) {
    if (!root || typeof ResizeObserver !== 'function') {
      return;
    }
    resizeObserver = new ResizeObserver(function () {
      post({ type: 'height', requestId: requestId, height: measureHeight() });
    });
    resizeObserver.observe(root);
  }

  function listProblems(value) {
    return Array.isArray(value) ? value.slice(0, MAX_PROBLEMS) : [];
  }

  function refuse(requestId, reason, problems) {
    stopObserving();
    if (root) {
      root.replaceChildren();
    }
    post({ type: 'rendered', requestId: requestId, ok: false, reason: String(reason || 'error'), problems: listProblems(problems) });
  }

  function overBounds(source) {
    if (source.length > bounds.chars) {
      return 'too_long';
    }
    var lines = 1;
    for (var index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
      lines += 1;
      if (lines > bounds.lines) {
        return 'too_many_lines';
      }
    }
    return '';
  }

  function positionsOf(laidOut) {
    try {
      return api && typeof api.previousLayout === 'function' ? api.previousLayout(laidOut) : null;
    } catch (_error) {
      return null;
    }
  }

  /* ── What the viewer may ask of its surroundings ── */

  function viewerHost(requestId) {
    return {
      // Web links and editor links are never opened from a drawing (plan 5.2).
      openLink: function () {},
      openFile: function (file) {
        var path = file && typeof file.path === 'string' ? file.path : '';
        if (!path || path.length > MAX_PATH) {
          return;
        }
        var line = file && typeof file.line === 'number' && file.line > 0 && Math.floor(file.line) === file.line ? file.line : null;
        post({ type: 'open-file', requestId: requestId, path: path, line: line });
      },
      // Resolves true once the page has put the question in the message box, false if it could not.
      ask: function (message) {
        var text = message && typeof message.text === 'string' ? message.text.slice(0, MAX_ASK_TEXT) : '';
        if (!text.trim()) {
          return Promise.resolve(false);
        }
        var askId = 'ask-' + (++askSequence);
        var payload = { type: 'ask', requestId: requestId, askId: askId, text: text };
        if (sendPicture && message && typeof message.image === 'string' && message.image) {
          payload.pngBase64 = message.image;
        }
        return new Promise(function (resolve) {
          var timer = setTimeout(function () {
            delete asks[askId];
            resolve(false);
          }, ASK_TIMEOUT_MS);
          asks[askId] = function (ok) {
            clearTimeout(timer);
            delete asks[askId];
            resolve(ok === true);
          };
          post(payload);
        });
      },
    };
  }

  function viewerFrame() {
    return root ? root.querySelector('.frame') : null;
  }

  /** Drawing mode is the viewer's own `drawing` class; this is what its Draw and Done buttons do. */
  function setMarkup(on) {
    var frame = viewerFrame();
    if (!frame) {
      return;
    }
    frame.classList.toggle('drawing', on);
    var tooltip = frame.querySelector('.tooltip');
    if (tooltip) {
      tooltip.setAttribute('hidden', '');
    }
    var note = on ? null : frame.querySelector('.note-input');
    if (note && typeof note.blur === 'function') {
      note.blur();
    }
  }

  /** Tells the page when drawing mode changes, so its button follows the frame's own Done and Escape. */
  function watchMarkup(requestId) {
    var frame = viewerFrame();
    var Observer = window.MutationObserver;
    if (!frame || typeof Observer !== 'function') {
      return;
    }
    var was = frame.classList.contains('drawing');
    markupObserver = new Observer(function () {
      var now = frame.classList.contains('drawing');
      if (now !== was) {
        was = now;
        post({ type: 'markup', requestId: requestId, on: now });
      }
    });
    markupObserver.observe(frame, { attributes: true, attributeFilter: ['class'] });
  }

  /**
   * The viewer's question box is a form. A sandboxed frame without allow-forms never gets its
   * submit event, so Enter and the send button raise that event here; nothing is ever submitted.
   */
  function wireAskForm() {
    var form = root ? root.querySelector('form.drawbar-ask') : null;
    var input = form ? form.querySelector('input') : null;
    var send = form ? form.querySelector('button') : null;
    if (!form || !input || !send) {
      return;
    }
    var raise = function (event) {
      event.preventDefault();
      if (send.disabled) {
        return;
      }
      var submit = document.createEvent('Event');
      submit.initEvent('submit', false, true);
      form.dispatchEvent(submit);
    };
    send.addEventListener('click', raise);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        raise(event);
      }
    });
  }

  function exportDrawing(requestId, kind) {
    var svg = root ? root.querySelector('.canvas > svg') : null;
    var laidOut = active && active.laidOut;
    var failed = function () {
      post({ type: 'export', requestId: requestId, kind: kind, ok: false });
    };
    if (!svg || !laidOut || !api) {
      failed();
      return;
    }
    Promise.resolve()
      .then(function () {
        if (kind === 'svg') {
          return { text: api.toSvgString(svg) };
        }
        if (kind === 'png') {
          return Promise.resolve(api.toPngBase64(svg)).then(function (base64) { return { base64: base64 }; });
        }
        return { text: api.toExcalidraw(laidOut) };
      })
      .then(function (body) {
        if (!active || active.requestId !== requestId) {
          return;
        }
        var title = laidOut.title && Array.isArray(laidOut.title.lines) ? laidOut.title.lines.join(' ') : undefined;
        var answer = { type: 'export', requestId: requestId, kind: kind, ok: true, name: typeof api.slug === 'function' ? api.slug(title) : 'sketch' };
        if (typeof body.base64 === 'string') {
          answer.base64 = body.base64;
        } else {
          answer.text = String(body.text);
        }
        post(answer);
      })
      .catch(failed);
  }

  /* ── The outline: the structure of the drawing that is up, as plain bounded data (a board card breaks it apart) ── */

  function clip(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function outlineOf(laidOut) {
    var nodes = laidOut && laidOut.nodes;
    var groups = laidOut && laidOut.groups;
    var edges = laidOut && laidOut.edges;
    if (!Array.isArray(nodes) || !Array.isArray(groups) || !Array.isArray(edges)) {
      return null;
    }
    if (nodes.length > OUTLINE_MAX.nodes || groups.length > OUTLINE_MAX.groups || edges.length > OUTLINE_MAX.edges) {
      return null;
    }
    var known = {};
    var outNodes = [];
    for (var n = 0; n < nodes.length; n += 1) {
      var node = nodes[n];
      var id = node && typeof node === 'object' ? clip(node.id, OUTLINE_MAX.id) : '';
      if (!id || Object.prototype.hasOwnProperty.call(known, id)) {
        return null;
      }
      known[id] = true;
      outNodes.push({ id: id, label: clip(node.label, OUTLINE_MAX.label), group: clip(node.group, OUTLINE_MAX.id) });
    }
    var outGroups = [];
    for (var g = 0; g < groups.length; g += 1) {
      var group = groups[g];
      var groupId = group && typeof group === 'object' ? clip(group.id, OUTLINE_MAX.id) : '';
      if (!groupId) {
        return null;
      }
      outGroups.push({ id: groupId, label: clip(group.label, OUTLINE_MAX.label), parent: clip(group.parent, OUTLINE_MAX.id) });
    }
    var outEdges = [];
    for (var e = 0; e < edges.length; e += 1) {
      var edge = edges[e];
      var from = edge && typeof edge === 'object' ? clip(edge.from, OUTLINE_MAX.id) : '';
      var to = edge && typeof edge === 'object' ? clip(edge.to, OUTLINE_MAX.id) : '';
      if (Object.prototype.hasOwnProperty.call(known, from) && Object.prototype.hasOwnProperty.call(known, to)) {
        outEdges.push({ from: from, to: to, label: clip(edge.label, OUTLINE_MAX.label), dashed: edge.style === 'dashed' });
      }
    }
    return { nodes: outNodes, groups: outGroups, edges: outEdges };
  }

  function answerOutline(requestId, laidOut) {
    var outline;
    try {
      outline = outlineOf(laidOut);
    } catch (_error) {
      outline = null;
    }
    if (!outline) {
      post({ type: 'outline', requestId: requestId, ok: false });
      return;
    }
    post({ type: 'outline', requestId: requestId, ok: true, nodes: outline.nodes, groups: outline.groups, edges: outline.edges });
  }

  /* ── Drawing ── */

  /** The positions a follow-up starts from: the page's own, or the nearest earlier drawing that shares its nodes. */
  function previousFor(request) {
    if (request.previous || !request.earlier.length || typeof api.pickPrevious !== 'function') {
      return Promise.resolve(request.previous);
    }
    return Promise.resolve()
      .then(function () { return api.pickPrevious(request.source, request.earlier); })
      .then(function (picked) { return picked && typeof picked === 'object' ? picked : null; })
      .catch(function () { return null; });
  }

  function draw(request) {
    var mine = ++generation;
    var requestId = request.requestId;
    request.laidOut = null;
    if (!root || !api || typeof api.render !== 'function') {
      refuse(requestId, 'unavailable');
      return;
    }
    if (!request.source.trim()) {
      refuse(requestId, 'empty');
      return;
    }
    var over = overBounds(request.source);
    if (over) {
      refuse(requestId, over);
      return;
    }
    previousFor(request)
      .then(function (previous) {
        var options = { host: viewerHost(requestId) };
        if (previous) {
          options.previous = previous;
        }
        return api.render(root, request.source, options);
      })
      .then(function (result) {
        if (mine !== generation) {
          return;
        }
        if (!result || result.kind !== 'drawn') {
          refuse(requestId, result && result.kind === 'mermaid' ? 'mermaid' : result && result.reason, result && result.problems);
          return;
        }
        request.laidOut = result.laidOut || null;
        stopObserving();
        observeHeight(requestId);
        watchMarkup(requestId);
        wireAskForm();
        post({
          type: 'rendered',
          requestId: requestId,
          ok: true,
          height: measureHeight(),
          width: Math.ceil(Number(result.laidOut && result.laidOut.width) || 0),
          problems: listProblems(result.problems),
          counts: result.counts || null,
          positions: positionsOf(result.laidOut),
        });
      })
      .catch(function () {
        if (mine === generation) {
          refuse(requestId, 'error');
        }
      });
  }

  function readEarlier(value) {
    var list = [];
    for (var index = 0; Array.isArray(value) && index < value.length && list.length < MAX_EARLIER; index += 1) {
      var item = value[index];
      if (!item || typeof item.source !== 'string' || !item.source.trim() || overBounds(item.source)) {
        continue;
      }
      list.push({ source: item.source, positions: item.positions && typeof item.positions === 'object' ? item.positions : null });
    }
    return list;
  }

  function readRequest(payload) {
    var requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (!requestId || requestId.length > MAX_REQUEST_ID || typeof payload.source !== 'string') {
      return null;
    }
    var previous = payload.previous && typeof payload.previous === 'object' ? payload.previous : null;
    return { requestId: requestId, source: payload.source, previous: previous, earlier: readEarlier(payload.earlier), laidOut: null };
  }

  /** A message about the drawing that is up: it must name that drawing's request. */
  function aboutActive(payload) {
    if (!active || !active.laidOut || payload.requestId !== active.requestId) {
      return;
    }
    if (payload.type === 'export') {
      if (typeof payload.kind === 'string' && EXPORT_KINDS[payload.kind] === true) {
        exportDrawing(active.requestId, payload.kind);
      }
    } else if (payload.type === 'outline') {
      answerOutline(active.requestId, active.laidOut);
    } else if (payload.type === 'markup') {
      sendPicture = payload.picture === true;
      setMarkup(payload.on === true);
    } else if (payload.type === 'ask-result') {
      var settle = typeof payload.askId === 'string' && Object.prototype.hasOwnProperty.call(asks, payload.askId) ? asks[payload.askId] : null;
      if (settle) {
        settle(payload.ok === true);
      }
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var payload = event.data && typeof event.data === 'object' ? event.data : null;
    if (!payload) {
      return;
    }
    if (payload.type === 'theme') {
      if (api && typeof api.setPalette === 'function') {
        api.setPalette(payload.palette && typeof payload.palette === 'object' ? payload.palette : null);
      }
      if (active) {
        // The redraw makes a new viewer, which starts out of drawing mode: say so, or the page's button stays pressed.
        var shown = viewerFrame();
        if (shown && shown.classList.contains('drawing')) {
          post({ type: 'markup', requestId: active.requestId, on: false });
        }
        draw(active);
      }
      return;
    }
    if (payload.type !== 'render') {
      aboutActive(payload);
      return;
    }
    var request = readRequest(payload);
    if (!request) {
      return;
    }
    active = request;
    sendPicture = false;
    draw(request);
  });

  // Announce only after the listener exists; the page sends its theme and the source when it hears this.
  post({ type: 'sketch-frame-ready' });

  window.addEventListener('beforeunload', stopObserving);
})();
