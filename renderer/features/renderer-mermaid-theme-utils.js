/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMermaidThemeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Return true if the value looks like a simple CSS color (hex, rgb/a, hsl/a, named). */
  function isSimpleColor(value) {
    if (!value) return false;
    var v = value.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return true;
    if (/^(?:rgb|hsl)a?\s*\(/.test(v)) return true;
    if (/^[a-z]{3,20}$/i.test(v)) return true; // named colors
    return false;
  }

  function parseColorToChannels(value) {
    if (!value || typeof document === 'undefined') return null;
    var doc = document;
    if (!doc || !doc.body || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return null;
    }
    var probe = doc.createElement('div');
    probe.style.color = '';
    probe.style.color = String(value || '').trim();
    if (!probe.style.color) {
      return null;
    }
    probe.style.display = 'none';
    doc.body.appendChild(probe);
    var resolved = window.getComputedStyle(probe).color;
    probe.remove();
    var match = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:[/,\s]+([0-9.]+))?\s*\)$/i.exec(String(resolved || '').trim());
    if (!match) {
      return null;
    }
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(match[1]) || 0))),
      g: Math.max(0, Math.min(255, Math.round(Number(match[2]) || 0))),
      b: Math.max(0, Math.min(255, Math.round(Number(match[3]) || 0))),
      a: Math.max(0, Math.min(1, match[4] == null ? 1 : Number(match[4]) || 0)),
    };
  }

  function channelToHex(value) {
    return Math.max(0, Math.min(255, Math.round(value || 0))).toString(16).padStart(2, '0');
  }

  function alphaToHex(value) {
    return channelToHex((Math.max(0, Math.min(1, value == null ? 1 : value)) * 255));
  }

  function channelsToHex(channels, includeAlpha) {
    if (!channels) return '';
    var hex = '#' + channelToHex(channels.r) + channelToHex(channels.g) + channelToHex(channels.b);
    if (includeAlpha && channels.a < 1) {
      return hex + alphaToHex(channels.a);
    }
    return hex;
  }

  function compositeChannels(topChannels, bottomChannels) {
    if (!topChannels) return bottomChannels || null;
    if (!bottomChannels || topChannels.a >= 1) {
      return {
        r: topChannels.r,
        g: topChannels.g,
        b: topChannels.b,
        a: 1,
      };
    }
    var alpha = Math.max(0, Math.min(1, topChannels.a));
    return {
      r: Math.round((topChannels.r * alpha) + (bottomChannels.r * (1 - alpha))),
      g: Math.round((topChannels.g * alpha) + (bottomChannels.g * (1 - alpha))),
      b: Math.round((topChannels.b * alpha) + (bottomChannels.b * (1 - alpha))),
      a: 1,
    };
  }

  function resolveHexColor(computed, props, fallback, compositeBaseHex) {
    var compositeBase = parseColorToChannels(compositeBaseHex || '');
    for (var i = 0; i < props.length; i++) {
      var raw = String(computed.getPropertyValue(props[i]) || '').trim();
      if (!raw) continue;
      var channels = parseColorToChannels(raw);
      if (channels) {
        return channelsToHex(compositeChannels(channels, compositeBase), false);
      }
    }
    var fallbackChannels = parseColorToChannels(fallback);
    return fallbackChannels ? channelsToHex(compositeChannels(fallbackChannels, compositeBase), false) : String(fallback || '');
  }

  function blendHexColors(baseHex, overlayHex, overlayAlpha) {
    var base = parseColorToChannels(baseHex);
    var overlay = parseColorToChannels(overlayHex);
    if (!base || !overlay) {
      return String(baseHex || overlayHex || '');
    }
    var alpha = Math.max(0, Math.min(1, overlayAlpha == null ? 0.5 : overlayAlpha));
    return channelsToHex({
      r: Math.round((overlay.r * alpha) + (base.r * (1 - alpha))),
      g: Math.round((overlay.g * alpha) + (base.g * (1 - alpha))),
      b: Math.round((overlay.b * alpha) + (base.b * (1 - alpha))),
      a: 1,
    }, false);
  }

  function getMermaidPaletteMode(docRoot, computed) {
    var paletteId = String(docRoot?.dataset?.palette || '').trim().toLowerCase();
    // Deterministic light override set. Every other registered palette
    // declares color-scheme: dark (including signal), so the computed
    // colorScheme fallback below only decides unknown/future palettes.
    if (paletteId === 'paper' || paletteId === 'woolly' || paletteId === 'jenny-day') {
      return 'light';
    }
    var colorScheme = String(computed?.colorScheme || '').trim().toLowerCase();
    if (colorScheme.indexOf('light') !== -1 && colorScheme.indexOf('dark') === -1) {
      return 'light';
    }
    return 'dark';
  }

  function buildThemeConfig() {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !window.getComputedStyle) {
      return {
        key: 'fallback',
        config: {
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          darkMode: true,
        },
        labelStyles: {
          containerFill: '#1a2231',
          containerStroke: '#2a3a50',
          textColor: '#f3f4fc',
        },
        edgeStyles: {
          lineColor: '#16e9ff',
          clusterFill: '#1a2231',
          clusterBorder: '#2a3a50',
        },
      };
    }
    const docRoot = document.documentElement || document.body;
    const computed = window.getComputedStyle(docRoot);
    const paletteMode = getMermaidPaletteMode(docRoot, computed);
    const isLightPalette = paletteMode === 'light';
    const baseSurface = resolveHexColor(computed, ['--bg-surface'], isLightPalette ? '#f6f2eb' : '#171a27');
    const background = resolveHexColor(computed, ['--surface-input-background', '--surface-input-background-strong', '--bg-surface'], isLightPalette ? '#fbf8f2' : '#171a27', baseSurface);
    const surfaceCard = resolveHexColor(computed, ['--surface-input-background-strong', '--bg-panel', '--surface-input-background'], isLightPalette ? '#fffaf5' : '#1b1f2b', background);
    const surfaceAlt = resolveHexColor(computed, ['--bg-panel', '--surface-input-background-strong'], isLightPalette ? '#efe9df' : '#222636', background);
    const text = resolveHexColor(computed, ['--text-primary'], isLightPalette ? '#1f2635' : '#f3f4fc');
    const border = resolveHexColor(computed, ['--border-default', '--widget-tool-border'], isLightPalette ? '#cdd4e0' : '#2a3a50', background);
    // WS1 spec (WS1_MERMAID_THEMING_SPEC.md, Option A "accent-tinted nodes"):
    // nodeAccent is the palette's identity accent; on light palettes the raw
    // accent fails the 3:1 line gate, so the line accent is text-darkened.
    const nodeAccent = resolveHexColor(computed, ['--accent', '--accent-cyan'], isLightPalette ? '#3568f0' : '#6d82ff');
    const cyanAccent = resolveHexColor(computed, ['--accent-cyan', '--accent'], isLightPalette ? '#157ec7' : '#16e9ff');
    const lineAccent = isLightPalette ? blendHexColors(nodeAccent, text, 0.3) : cyanAccent;
    // A palette that declares --mermaid-node-label-* wins over the formulas.
    const declaredNodeFill = resolveHexColor(computed, ['--mermaid-node-label-bg'], '', background);
    const declaredNodeBorder = resolveHexColor(computed, ['--mermaid-node-label-border'], '', declaredNodeFill || surfaceCard);
    const declaredNodeText = resolveHexColor(computed, ['--mermaid-node-label-text'], '');
    const nodeFill = declaredNodeFill || blendHexColors(surfaceCard, nodeAccent, isLightPalette ? 0.1 : 0.18);
    const nodeBorder = declaredNodeBorder || blendHexColors(border, nodeAccent, 0.6);
    const nodeText = declaredNodeText || text;
    const secondaryColor = blendHexColors(surfaceAlt, nodeAccent, isLightPalette ? 0.1 : 0.18);
    const tertiaryColor = blendHexColors(background, nodeAccent, isLightPalette ? 0.05 : 0.08);
    const lineColor = blendHexColors(background, lineAccent, isLightPalette ? 0.85 : 0.78);
    const softBorderColor = blendHexColors(border, nodeAccent, 0.35);
    const zoomRaw = Number.parseFloat(String(computed.getPropertyValue('--chat-zoom-factor') || '').trim());
    const zoomFactor = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
    const fontSize = Math.round(Math.max(11, Math.min(20, 13 * zoomFactor))) + 'px';
    return {
      key: [
        paletteMode,
        'zoom:' + zoomFactor,
        background,
        surfaceCard,
        surfaceAlt,
        text,
        nodeAccent,
        cyanAccent,
        border,
        nodeFill,
        nodeBorder,
        nodeText,
      ].join('|'),
      config: {
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        darkMode: !isLightPalette,
        themeVariables: {
          background,
          primaryColor: nodeFill,
          primaryTextColor: nodeText,
          primaryBorderColor: nodeBorder,
          lineColor,
          secondaryColor,
          tertiaryColor,
          noteBkgColor: secondaryColor,
          noteTextColor: text,
          noteBorderColor: softBorderColor,
          edgeLabelBackground: surfaceCard,
          clusterBkg: tertiaryColor,
          clusterBorder: softBorderColor,
          textColor: text,
          secondaryTextColor: text,
          tertiaryTextColor: text,
          fontSize,
          fontFamily: 'inherit',
        },
      },
      labelStyles: {
        containerFill: nodeFill,
        containerStroke: nodeBorder,
        textColor: nodeText,
      },
      // Backs normalizeMermaidEdgeAndClusterColors — reuses the same
      // lineColor/clusterBkg/clusterBorder values already computed above for
      // themeVariables, so there is no separate color formula to keep in sync.
      edgeStyles: {
        lineColor,
        clusterFill: tertiaryColor,
        clusterBorder: softBorderColor,
      },
    };
  }

  function normalizeMermaidLabelContainers(svgRoot, labelStyles) {
    if (!svgRoot || !labelStyles) {
      return;
    }
    var containerFill = String(labelStyles.containerFill || '').trim();
    var containerStroke = String(labelStyles.containerStroke || '').trim();
    var textColor = String(labelStyles.textColor || '').trim();
    containerFill = isSimpleColor(containerFill) ? containerFill : '';
    containerStroke = isSimpleColor(containerStroke) ? containerStroke : '';
    textColor = isSimpleColor(textColor) ? textColor : '';
    if (!containerFill && !containerStroke && !textColor) {
      return;
    }

    // Mermaid 11 draws cylinders/stadiums as <path> and circles as <circle>
    // with the same `basic label-container` classes as rects and polygons.
    svgRoot.querySelectorAll('rect.basic.label-container, polygon.label-container, path.basic.label-container, circle.basic.label-container').forEach(function applyContainerStyle(node) {
      if (containerFill) {
        node.setAttribute('fill', containerFill);
        node.style.fill = containerFill;
      }
      if (containerStroke) {
        node.setAttribute('stroke', containerStroke);
        node.style.stroke = containerStroke;
      }
    });

    svgRoot.querySelectorAll('.node .label text, .node .label tspan').forEach(function applySvgTextStyle(node) {
      if (!textColor) {
        return;
      }
      node.setAttribute('fill', textColor);
      node.style.fill = textColor;
    });

    svgRoot.querySelectorAll('.node .label foreignObject div, .node .label span, .node .label p').forEach(function applyHtmlTextStyle(node) {
      if (!textColor || !node || !node.style) {
        return;
      }
      node.style.color = textColor;
    });
  }

  // Mermaid's default (unstyled) edges, arrowhead markers, and subgraph/
  // cluster backgrounds carry NO inline fill/stroke of their own — their
  // color comes solely from the `<style>` block mermaid.render() embeds in
  // the SVG (e.g. `.flowchart-link { stroke: lineColor; fill: none; }`,
  // `.cluster rect { fill: clusterBkg; stroke: clusterBorder; }`). The direct
  // render path sanitizes that SVG with DOMPurify's FORBID_TAGS including
  // 'style' (an unscoped <style> tag dropped via innerHTML would leak
  // page-wide onto any other ".node"/".cluster" element), which strips this
  // rule along with it. Left unset, the SVG fill/stroke initial values
  // (fill:black, stroke:none) take over: near-invisible dark-on-dark edges,
  // a solid black blob on light palettes, a black subgraph slab. Bake the
  // resolved palette colors in as attributes wherever mermaid left none —
  // the same technique normalizeMermaidLabelContainers already uses for node
  // label containers. An element that already carries an explicit `fill`/
  // `stroke` attribute (a user classDef/linkStyle, or an intentionally
  // unfilled shape like a lollipop's transparent circle) is left untouched;
  // a custom `style="fill:...`" attribute (mermaid's own bake-in for
  // classDef/linkStyle overrides) always wins the CSS cascade regardless of
  // what plain attribute we set, so it is never at risk of being clobbered.
  function normalizeMermaidEdgeAndClusterColors(svgRoot, edgeStyles) {
    if (!svgRoot || !edgeStyles) {
      return;
    }
    var lineColor = String(edgeStyles.lineColor || '').trim();
    var clusterFill = String(edgeStyles.clusterFill || '').trim();
    var clusterBorder = String(edgeStyles.clusterBorder || '').trim();
    lineColor = isSimpleColor(lineColor) ? lineColor : '';
    clusterFill = isSimpleColor(clusterFill) ? clusterFill : '';
    clusterBorder = isSimpleColor(clusterBorder) ? clusterBorder : '';

    if (lineColor) {
      svgRoot.querySelectorAll('.flowchart-link, .edgePath .path, path[marker-start], path[marker-end]')
        .forEach(function applyEdgeColor(edgePath) {
          if (!edgePath.getAttribute('fill')) {
            edgePath.setAttribute('fill', 'none');
          }
          if (!edgePath.getAttribute('stroke')) {
            edgePath.setAttribute('stroke', lineColor);
          }
        });

      svgRoot.querySelectorAll('marker path, marker circle, marker polygon, marker line')
        .forEach(function applyMarkerColor(shape) {
          if (!shape.getAttribute('fill')) {
            shape.setAttribute('fill', lineColor);
          }
          if (!shape.getAttribute('stroke')) {
            shape.setAttribute('stroke', lineColor);
          }
        });
    }

    if (clusterFill || clusterBorder) {
      svgRoot.querySelectorAll('.cluster rect, .cluster polygon').forEach(function applyClusterColor(shape) {
        if (clusterFill && !shape.getAttribute('fill')) {
          shape.setAttribute('fill', clusterFill);
        }
        if (clusterBorder && !shape.getAttribute('stroke')) {
          shape.setAttribute('stroke', clusterBorder);
        }
      });
    }
  }

  return {
    isSimpleColor,
    parseColorToChannels,
    channelToHex,
    alphaToHex,
    channelsToHex,
    compositeChannels,
    resolveHexColor,
    blendHexColors,
    getMermaidPaletteMode,
    buildThemeConfig,
    normalizeMermaidLabelContainers,
    normalizeMermaidEdgeAndClusterColors,
  };
});
