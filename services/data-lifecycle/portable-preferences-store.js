'use strict';

const path = require('path');
const { FileJsonStore } = require('../backend/file-json-store');

const PORTABLE_PREFERENCES_VERSION = 1;
const PORTABLE_PREFERENCES_RELATIVE_PATH = path.join('data-lifecycle', 'portable-preferences.json');
const APPEARANCE_KEYS = Object.freeze([
  'paletteId',
  'typographyId',
  'motionId',
  'surfaceEffectId',
  'composerHoloId',
  'spriteHoloId',
  'threadStyleId',
  'timelineStyleId',
  'fontScaleId',
  'chatWidthId',
  'explicitMotion',
]);
const LOCAL_ENGINE_TYPES = Object.freeze(['ollama', 'vllm']);

function pickJsonScalar(source, key) {
  const value = source?.[key];
  if (typeof value === 'string') return value.slice(0, 128);
  if (typeof value === 'boolean') return value;
  if (Number.isFinite(value)) return value;
  return undefined;
}

function normalizeAppearance(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of APPEARANCE_KEYS) {
    const normalized = pickJsonScalar(source, key);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function normalizePortablePreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const chatZoomPercent = Number(source.chatZoomPercent);
  const updatedAt = typeof source.updated_at === 'string'
    && source.updated_at.length <= 64
    && Number.isFinite(Date.parse(source.updated_at))
    ? source.updated_at
    : new Date().toISOString();
  return {
    schema_version: PORTABLE_PREFERENCES_VERSION,
    updated_at: updatedAt,
    appearance: normalizeAppearance(source.appearance),
    ...(Number.isFinite(chatZoomPercent)
      ? { chatZoomPercent: Math.max(85, Math.min(135, Math.round(chatZoomPercent / 5) * 5)) }
      : {}),
    ...(typeof source.preferredModel === 'string' && source.preferredModel.trim()
      ? { preferredModel: source.preferredModel.trim().slice(0, 160) }
      : {}),
  };
}

function pickBoundedText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function projectPortableShellConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const reminders = Array.isArray(source.proactive?.reminders)
    ? source.proactive.reminders.slice(0, 50).map((item) => ({
        id: pickBoundedText(item?.id, 160),
        label: pickBoundedText(item?.label, 160),
        prompt: pickBoundedText(item?.prompt, 4000),
        enabled: item?.enabled !== false,
      })).filter((item) => item.id && item.label)
    : [];
  const preferredEngineType = LOCAL_ENGINE_TYPES.includes(source.preferredEngineType)
    ? source.preferredEngineType
    : 'ollama';
  const result = {
    preferredEngineType,
    chatUi: {
      zoomPercent: Math.max(85, Math.min(135, Math.round(Number(source.chatUi?.zoomPercent) / 5) * 5 || 100)),
    },
    proactive: {
      reminders,
    },
  };
  if (source.home?.scratchpad && typeof source.home.scratchpad === 'object') {
    const encoded = JSON.stringify(source.home.scratchpad);
    if (Buffer.byteLength(encoded, 'utf8') <= 64 * 1024) {
      result.home = { scratchpad: JSON.parse(encoded) };
    }
  }
  return result;
}

class PortablePreferencesStore {
  constructor(userDataPath, { store = null, logger = null } = {}) {
    if (!String(userDataPath || '').trim()) {
      throw new TypeError('PortablePreferencesStore requires userDataPath.');
    }
    this.filePath = path.join(path.resolve(userDataPath), PORTABLE_PREFERENCES_RELATIVE_PATH);
    this.store = store || new FileJsonStore(this.filePath, { logger });
  }

  read() {
    const state = this.store.readWithStatus(null);
    if (state.missing) return null;
    if (state.corrupted || !state.value || state.value.schema_version > PORTABLE_PREFERENCES_VERSION) {
      return null;
    }
    return normalizePortablePreferences(state.value);
  }

  sync(preferences) {
    const patch = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? preferences
      : {};
    const current = this.read() || {};
    const next = normalizePortablePreferences({
      ...current,
      ...patch,
      appearance: Object.hasOwn(patch, 'appearance')
        ? patch.appearance
        : current.appearance,
      updated_at: new Date().toISOString(),
    });
    this.store.writeImmediate(next);
    return next;
  }
}

module.exports = {
  PortablePreferencesStore,
  normalizePortablePreferences,
  projectPortableShellConfig,
};
