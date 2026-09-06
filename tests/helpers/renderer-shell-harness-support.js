const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const EXCLUDED_SCRIPT_SOURCES = new Set([
  'renderer/shared/startup-audit-renderer-probe.js',
  'renderer/app.js',
]);

function isExcludedScriptSource(src) {
  return !src
    || src.startsWith('node_modules/')
    || src.startsWith('vendor/')
    || EXCLUDED_SCRIPT_SOURCES.has(src);
}

function extractRendererScriptOrder(html) {
  const uncommentedHtml = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const pattern = /<script\s+[^>]*src="([^"]+)"[^>]*><\/script>/gi;
  const sources = [];
  let match;
  while ((match = pattern.exec(uncommentedHtml)) !== null) {
    const src = match[1];
    if (isExcludedScriptSource(src)) {
      continue;
    }
    sources.push(src);
  }
  return sources;
}

// CommonJS evaluates and caches this module once per process, so index.html is read once.
const SCRIPT_ORDER = extractRendererScriptOrder(
  fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
);

function createCanvasContext() {
  const calls = [];
  return {
    __calls: calls,
    beginPath() {},
    clearRect() {},
    closePath() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    drawImage() {},
    fill() {},
    fillRect() {},
    fillText(text, x, y) {
      calls.push({ type: 'fillText', text: String(text || ''), x: Number(x || 0), y: Number(y || 0) });
    },
    lineTo() {},
    measureText(text) {
      return { width: String(text || '').length * 8 };
    },
    moveTo() {},
    roundRect() {},
    arc() {},
    restore() {},
    save() {},
    scale() {},
    setTransform() {},
    stroke() {},
    translate() {},
    globalAlpha: 1,
    fillStyle: '#000',
    shadowBlur: 0,
    shadowColor: 'transparent',
    font: '12px sans-serif',
    textBaseline: 'alphabetic',
  };
}

function createPretextLayoutMock() {
  return {
    prepare(text, font) {
      return {
        text: String(text || ''),
        font: String(font || ''),
        _wordWidths: String(text || '').length * 8,
      };
    },
    layout(prepared, maxWidth, lineHeight) {
      const totalWidth = Number(prepared?._wordWidths || 0);
      const safeWidth = Math.max(Number(maxWidth) || 0, 1);
      const safeLineHeight = Math.max(Number(lineHeight) || 0, 0);
      if (!totalWidth || !safeLineHeight) {
        return { height: 0 };
      }
      const lineCount = Math.max(1, Math.ceil(totalWidth / safeWidth));
      return { height: lineCount * safeLineHeight };
    },
    clearCache() {},
  };
}

function normalizeLocalModelId(entry) {
  return typeof entry === 'string'
    ? String(entry || '').trim()
    : (entry && typeof entry === 'object' && !Array.isArray(entry)
      ? String(entry.id || entry.name || entry.model || '').trim()
      : '');
}

function createSchedulerStub(options, state) {
  return {
    scheduler: {
      async getState() {
        if (typeof options.scheduler?.getState === 'function') return options.scheduler.getState({ state });
        return {
          upcoming: [], running: [], generatedAt: '', relevant: false,
          lifecycle: { phase: 'idle', relevant: false, qualifyingTaskCount: 0, reason: 'no_qualifying_tasks', error: '' },
        };
      },
    },
  };
}

function createUpdatesStub(options, state, addListener, emitUpdatesChanged) {
  return {
    async getState() {
      state.updatesGetStateCalls += 1;
      if (typeof options.updates?.getState === 'function') {
        const payload = await options.updates.getState({ state });
        if (payload && typeof payload === 'object') {
          state.updatesState = { ...state.updatesState, ...payload };
        }
      }
      return state.updatesState;
    },
    async check() {
      state.updatesCheckCalls += 1;
      let payload = null;
      if (typeof options.updates?.check === 'function') {
        payload = await options.updates.check({ state });
        if (payload && typeof payload !== 'object') {
          payload = null;
        }
      }
      // Mirror the real UpdateService: every check pushes a changed event.
      if (typeof emitUpdatesChanged === 'function') {
        await emitUpdatesChanged(payload);
      } else if (payload) {
        state.updatesState = { ...state.updatesState, ...payload };
      }
      return state.updatesState;
    },
    onChanged(listener) {
      return addListener('updates', listener);
    },
  };
}

module.exports = {
  SCRIPT_ORDER,
  createCanvasContext,
  createPretextLayoutMock,
  createSchedulerStub,
  createUpdatesStub,
  extractRendererScriptOrder,
  isExcludedScriptSource,
  normalizeLocalModelId,
};
