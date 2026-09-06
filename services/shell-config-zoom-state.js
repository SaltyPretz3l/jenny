// UI zoom/scaling normalizers and bounds.

const CHAT_UI_ZOOM_DEFAULT = 100;
const CHAT_UI_ZOOM_MIN = 85;
const CHAT_UI_ZOOM_MAX = 135;
const CHAT_UI_ZOOM_STEP = 5;
// Overall app zoom (Electron webContents.setZoomFactor). Distinct from chat
// zoom: this magnifies the entire renderer frame uniformly (fonts + surfaces).
const APP_ZOOM_DEFAULT = 100;
const APP_ZOOM_MIN = 80;
const APP_ZOOM_MAX = 150;
const APP_ZOOM_STEP = 5;

function clampSteppedPercent(value, { min, max, step, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, parsed));
  const stepped = Math.round(clamped / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

function normalizeChatUiZoomPercent(value) {
  return clampSteppedPercent(value, {
    min: CHAT_UI_ZOOM_MIN,
    max: CHAT_UI_ZOOM_MAX,
    step: CHAT_UI_ZOOM_STEP,
    fallback: CHAT_UI_ZOOM_DEFAULT,
  });
}

function normalizeChatUiSettings(value = {}, legacyState = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    zoomPercent: normalizeChatUiZoomPercent(
      source.zoomPercent
      ?? source.zoom_percent
      ?? legacyState.chatZoomPercent
      ?? legacyState.chat_zoom_percent
    ),
  };
}

function normalizeWindowUiZoomPercent(value) {
  return clampSteppedPercent(value, {
    min: APP_ZOOM_MIN,
    max: APP_ZOOM_MAX,
    step: APP_ZOOM_STEP,
    fallback: APP_ZOOM_DEFAULT,
  });
}

function normalizeWindowUiSettings(value = {}, legacyState = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    appZoomPercent: normalizeWindowUiZoomPercent(
      source.appZoomPercent
      ?? source.app_zoom_percent
      ?? legacyState.appZoomPercent
    ),
  };
}

module.exports = {
  CHAT_UI_ZOOM_DEFAULT,
  CHAT_UI_ZOOM_MIN,
  CHAT_UI_ZOOM_MAX,
  CHAT_UI_ZOOM_STEP,
  APP_ZOOM_DEFAULT,
  APP_ZOOM_MIN,
  APP_ZOOM_MAX,
  APP_ZOOM_STEP,
  clampSteppedPercent,
  normalizeChatUiZoomPercent,
  normalizeChatUiSettings,
  normalizeWindowUiZoomPercent,
  normalizeWindowUiSettings,
};
