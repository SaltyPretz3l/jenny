'use strict';

// Desktop (OS) notification preferences, nested under windowUi.notifications.
// The normalizer is total and idempotent: any input yields a full object of
// booleans, so a partial patch (updateWindowUiSettings shallow-merges and the
// nested object is replaced whole) still resolves every field from defaults.
// No CONFIG_VERSION bump accompanies it (same precedent as layout.railWidth).

const NOTIFICATION_CATEGORIES = Object.freeze([
  'replies',
  'failures',
  'permissions',
  'questions',
  'reminders',
]);

const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: true,
  onlyWhenUnfocused: true,
  sound: true,
  replyPreview: false,
  categories: Object.freeze({
    replies: true,
    failures: true,
    permissions: true,
    questions: true,
    reminders: true,
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Own properties only: an inherited field (a crafted prototype) never counts.
function readBoolean(source, key, fallback) {
  const value = Object.hasOwn(source, key) ? source[key] : undefined;
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNotificationSettings(value) {
  const source = isPlainObject(value) ? value : {};
  const categorySource = isPlainObject(source.categories) ? source.categories : {};
  const categories = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    categories[category] = readBoolean(
      categorySource,
      category,
      DEFAULT_NOTIFICATION_SETTINGS.categories[category]
    );
  }
  return {
    enabled: readBoolean(source, 'enabled', DEFAULT_NOTIFICATION_SETTINGS.enabled),
    onlyWhenUnfocused: readBoolean(
      source,
      'onlyWhenUnfocused',
      DEFAULT_NOTIFICATION_SETTINGS.onlyWhenUnfocused
    ),
    sound: readBoolean(source, 'sound', DEFAULT_NOTIFICATION_SETTINGS.sound),
    replyPreview: readBoolean(source, 'replyPreview', DEFAULT_NOTIFICATION_SETTINGS.replyPreview),
    categories,
  };
}

module.exports = {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
  normalizeNotificationSettings,
};
