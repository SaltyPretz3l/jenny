/* renderer/features/renderer-ide-theme-bridge.js - palette-aware Monaco theme.
 * Reads the active palette's CSS custom properties off :root, builds a
 * monaco 'jenny' theme (editor surfaces, line numbers, selection, minimap,
 * diff insert/remove tints) and re-applies it whenever data-palette changes
 * (MutationObserver). Monaco standalone themes are GLOBAL: once the IDE
 * applies 'jenny', every Monaco surface (including the artifact editor)
 * follows the app palette instead of the load-time vs-dark default. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeThemeBridge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const JENNY_MONACO_THEME = 'jenny';

  // Semantic slot -> CSS custom property. Sources are plain hex/rgba values
  // in the palette files; tokens that resolve through color-mix()/var()
  // chains fall back to probe-element resolution at read time.
  const PALETTE_VAR_MAP = {
    base: '--bg-base',
    surface: '--bg-surface',
    panel: '--bg-panel',
    textPrimary: '--text-primary',
    textSecondary: '--text-secondary',
    textMuted: '--text-muted',
    accent: '--accent',
    line: '--line',
    danger: '--text-danger-emphasis',
    success: '--text-success-soft',
    // Optional per-palette syntax token colors. Palettes that omit these
    // resolve to null, so buildJennyMonacoTheme leaves rules empty and Monaco
    // keeps its built-in vs/vs-dark syntax for that palette.
    syntaxKeyword: '--syntax-keyword',
    syntaxString: '--syntax-string',
    syntaxComment: '--syntax-comment',
    syntaxNumber: '--syntax-number',
    syntaxFunction: '--syntax-function',
    syntaxType: '--syntax-type',
    syntaxVariable: '--syntax-variable',
    syntaxConstant: '--syntax-constant',
  };

  // Parses #hex, rgb()/rgba() (comma or space syntax) and color(srgb ...)
  // (how Chromium serializes resolved color-mix()). Returns {r,g,b,a} or null.
  function parseCssColor(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }
    const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(raw);
    if (hexMatch) {
      const hex = hexMatch[1];
      if (hex.length === 3 || hex.length === 4) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
          a: hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1,
        };
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
      }
      return null;
    }
    const parseAlpha = (token) => {
      if (token === undefined || token === '') {
        return 1;
      }
      const text = String(token).trim();
      const numeric = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
      return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 1;
    };
    const rgbMatch = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(raw);
    if (rgbMatch) {
      return {
        r: Math.round(Number(rgbMatch[1])),
        g: Math.round(Number(rgbMatch[2])),
        b: Math.round(Number(rgbMatch[3])),
        a: parseAlpha(rgbMatch[4]),
      };
    }
    const srgbMatch = /^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i.exec(raw);
    if (srgbMatch) {
      return {
        r: Math.round(Number(srgbMatch[1]) * 255),
        g: Math.round(Number(srgbMatch[2]) * 255),
        b: Math.round(Number(srgbMatch[3]) * 255),
        a: parseAlpha(srgbMatch[4]),
      };
    }
    return null;
  }

  // Monaco theme colors take #rrggbb / #rrggbbaa strings. alphaOverride
  // replaces the parsed alpha (used for derived tints like selection).
  function toMonacoHex(color, alphaOverride) {
    if (!color) {
      return '';
    }
    const channel = (value) => Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
    const alpha = alphaOverride === undefined
      ? (typeof color.a === 'number' ? color.a : 1)
      : alphaOverride;
    const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
    return alpha >= 1 ? base : `${base}${channel(alpha * 255)}`;
  }

  // Monaco token rules want a bare 6-digit RRGGBB (no leading '#', no alpha).
  // Forcing alpha to 1 guarantees toMonacoHex emits #rrggbb (never #rrggbbaa);
  // a null color yields '' so ruleFor skips it.
  function toRuleColor(color) {
    return toMonacoHex(color, 1).replace('#', '');
  }

  function relativeLuminance(color) {
    if (!color) {
      return 0;
    }
    return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  }

  // Pure theme-data builder over already-resolved palette colors. Slots that
  // failed to resolve are skipped so Monaco inherits the base theme's value
  // for them instead of receiving an invalid color string.
  function buildJennyMonacoTheme(resolved = {}) {
    const {
      base, surface, panel, textPrimary, textSecondary, textMuted,
      accent, line, danger, success,
      syntaxKeyword, syntaxString, syntaxComment, syntaxNumber,
      syntaxFunction, syntaxType, syntaxVariable, syntaxConstant,
    } = resolved;
    const colors = {};
    const put = (key, value) => {
      if (value) {
        colors[key] = value;
      }
    };
    put('editor.background', toMonacoHex(base));
    put('editor.foreground', toMonacoHex(textPrimary));
    put('editorGutter.background', toMonacoHex(base));
    put('editorLineNumber.foreground', toMonacoHex(textMuted));
    put('editorLineNumber.activeForeground', toMonacoHex(textSecondary));
    put('editorCursor.foreground', toMonacoHex(accent));
    put('editor.selectionBackground', toMonacoHex(accent, 0.3));
    put('editor.inactiveSelectionBackground', toMonacoHex(accent, 0.16));
    put('editor.lineHighlightBackground', toMonacoHex(textPrimary, 0.05));
    put('editor.findMatchBackground', toMonacoHex(accent, 0.35));
    put('editor.findMatchHighlightBackground', toMonacoHex(accent, 0.18));
    put('editorWidget.background', toMonacoHex(panel));
    put('editorWidget.border', toMonacoHex(line));
    put('editorSuggestWidget.background', toMonacoHex(panel));
    put('editorHoverWidget.background', toMonacoHex(panel));
    put('minimap.background', toMonacoHex(base));
    put('scrollbarSlider.background', toMonacoHex(textMuted, 0.18));
    put('scrollbarSlider.hoverBackground', toMonacoHex(textMuted, 0.28));
    put('scrollbarSlider.activeBackground', toMonacoHex(textMuted, 0.38));
    put('diffEditor.insertedTextBackground', toMonacoHex(success, 0.2));
    put('diffEditor.removedTextBackground', toMonacoHex(danger, 0.2));
    put('diffEditor.insertedLineBackground', toMonacoHex(success, 0.1));
    put('diffEditor.removedLineBackground', toMonacoHex(danger, 0.1));
    put('focusBorder', toMonacoHex(accent, 0.55));
    // W2 chrome: sticky-scroll header, bracket/indent guides.
    put('editorStickyScroll.background', toMonacoHex(base));
    put('editorStickyScrollHover.background', toMonacoHex(panel));
    put('editorIndentGuide.background1', toMonacoHex(textMuted, 0.16));
    put('editorIndentGuide.activeBackground1', toMonacoHex(textMuted, 0.4));
    // Column rulers: tinted off the palette's line slot so the vertical guides
    // are visible but unobtrusive on every palette (inert when rulers: []).
    put('editorRuler.foreground', toMonacoHex(line, 0.35));
    put('editorBracketHighlight.foreground1', toMonacoHex(accent));
    put('editorBracketHighlight.foreground2', toMonacoHex(success));
    put('editorBracketHighlight.foreground3', toMonacoHex(textSecondary));
    // editor.lineHighlightBackground used surface as a fallback tone when
    // textPrimary is unavailable.
    if (!colors['editor.lineHighlightBackground'] && surface) {
      colors['editor.lineHighlightBackground'] = toMonacoHex(surface);
    }
    // Syntax token rules: only emitted for palettes that define --syntax-*.
    // Scopes are prefix-matched by Monaco (e.g. 'keyword' covers
    // 'keyword.control'), so a single rule per base scope is enough. Palettes
    // without syntax vars leave rules empty -> Monaco's inherited vs-dark.
    const rules = [];
    const ruleFor = (token, color, extra) => {
      const foreground = toRuleColor(color);
      if (foreground) {
        rules.push(Object.assign({ token, foreground }, extra || {}));
      }
    };
    ruleFor('comment', syntaxComment, { fontStyle: 'italic' });
    ruleFor('string', syntaxString);
    // No dedicated --syntax-regexp slot: regexp literals reuse the string color.
    ruleFor('regexp', syntaxString);
    ruleFor('keyword', syntaxKeyword);
    ruleFor('number', syntaxNumber);
    ruleFor('type', syntaxType);
    ruleFor('function', syntaxFunction);
    ruleFor('variable', syntaxVariable);
    ruleFor('constant', syntaxConstant);
    return {
      base: base && relativeLuminance(base) > 0.5 ? 'vs' : 'vs-dark',
      inherit: true,
      rules,
      colors,
    };
  }

  function createIdeThemeBridge(deps) {
    const documentRef = deps?.documentRef
      || (globalRef.window && globalRef.window.document)
      || globalRef.document
      || null;
    const appendClientLog = typeof deps?.appendClientLog === 'function'
      ? deps.appendClientLog
      : () => {};

    let monacoApi = null;
    let observer = null;
    let lastAppliedSignature = '';

    // Resolves every PALETTE_VAR_MAP slot from the live computed style.
    // Unparseable values (color-mix chains) go through one hidden probe
    // element so the engine resolves them to a concrete rgb()/color(srgb).
    function resolvePaletteColors() {
      const rootEl = documentRef?.documentElement || null;
      const view = documentRef?.defaultView || globalRef.window || null;
      if (!rootEl || typeof view?.getComputedStyle !== 'function') {
        return {};
      }
      const computed = view.getComputedStyle(rootEl);
      const resolved = {};
      let probe = null;
      for (const [slot, varName] of Object.entries(PALETTE_VAR_MAP)) {
        const raw = String(computed.getPropertyValue(varName) || '').trim();
        let parsed = raw ? parseCssColor(raw) : null;
        if (!parsed && raw && documentRef.body) {
          if (!probe) {
            probe = documentRef.createElement('div');
            probe.style.display = 'none';
            documentRef.body.appendChild(probe);
          }
          probe.style.color = '';
          probe.style.color = raw;
          parsed = parseCssColor(String(view.getComputedStyle(probe).color || ''));
        }
        resolved[slot] = parsed;
      }
      probe?.remove?.();
      return resolved;
    }

    function applyTheme() {
      if (typeof monacoApi?.editor?.defineTheme !== 'function'
        || typeof monacoApi.editor.setTheme !== 'function') {
        return false;
      }
      const themeData = buildJennyMonacoTheme(resolvePaletteColors());
      const signature = `${themeData.base}|${JSON.stringify(themeData.colors)}|${JSON.stringify(themeData.rules)}`;
      if (signature === lastAppliedSignature) {
        return true;
      }
      try {
        monacoApi.editor.defineTheme(JENNY_MONACO_THEME, themeData);
        monacoApi.editor.setTheme(JENNY_MONACO_THEME);
        lastAppliedSignature = signature;
        appendClientLog('INFO', 'ide.theme_applied', {
          base: themeData.base,
          palette: String(documentRef?.documentElement?.dataset?.palette || ''),
        });
        return true;
      } catch (error) {
        appendClientLog('WARN', 'ide.theme_apply_failed', {
          message: String(error?.message || error || ''),
        });
        try {
          monacoApi.editor.setTheme('vs-dark');
        } catch (_error) {
          /* keep whatever theme is active */
        }
        return false;
      }
    }

    function startObserver() {
      if (observer || !documentRef?.documentElement) {
        return;
      }
      const ObserverCtor = deps?.mutationObserverCtor
        || documentRef.defaultView?.MutationObserver
        || globalRef.MutationObserver
        || null;
      if (typeof ObserverCtor !== 'function') {
        return;
      }
      observer = new ObserverCtor(() => {
        applyTheme();
      });
      observer.observe(documentRef.documentElement, {
        attributes: true,
        attributeFilter: ['data-palette'],
      });
    }

    // Called by the editor host once Monaco actually booted (never on the
    // jsdom/loader-failure fallback path).
    function handleMonacoReady(api) {
      monacoApi = api || null;
      if (!monacoApi) {
        return false;
      }
      const applied = applyTheme();
      startObserver();
      return applied;
    }

    function dispose() {
      observer?.disconnect?.();
      observer = null;
      monacoApi = null;
      lastAppliedSignature = '';
    }

    return {
      applyTheme,
      dispose,
      handleMonacoReady,
    };
  }

  return {
    JENNY_MONACO_THEME,
    buildJennyMonacoTheme,
    createIdeThemeBridge,
    parseCssColor,
    toMonacoHex,
  };
});
