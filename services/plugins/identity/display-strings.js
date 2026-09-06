'use strict';

// Pure validation for any publisher/plugin/contribution DISPLAY string (the
// human-readable name shown in the Plugin Manager, trust chrome, and consent
// surfaces). This is deliberately separate from the closed contract-schema
// string formats in config/plugins/v1/ (which are ASCII stable identifiers,
// e.g. publisher_id): a display string must welcome real-world Unicode names
// while still refusing the handful of codepoint classes that let hostile
// package metadata spoof Jenny's trust chrome — bidi overrides that reorder
// glyphs, zero-width characters that hide/split a reserved word, control
// characters, and exact reuse of a small reserved-label set ("Jenny",
// "official", ...). PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Sandboxed
// plugin-view contract": "Publisher/plugin/contribution display strings are
// NFC-normalized and reject controls, bidi overrides, zero-width spoofing,
// and reserved Jenny/official labels."
//
// No fs/net/child_process. Every input is treated as hostile.

// Mirrors the codepoint classes the generated contract validator rejects for
// nfc_check-enabled string formats (scripts/generate_plugin_contracts_emitters.py),
// duplicated here rather than imported so this module has zero dependency on
// the generated contract artifact (kept import-fanout at 0 and lets it run
// before any contract exists).
const BIDI_OVERRIDE_CODEPOINTS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);
const ZERO_WIDTH_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

const MAX_DISPLAY_STRING_UTF8_BYTES = 120;

// Reserved labels a plugin/publisher/contribution display string may never
// exactly become (after NFC normalization, casefold, and whitespace
// collapse), so a plugin cannot name itself "Jenny", "Official", or a close
// variant to imitate Jenny-owned trust chrome. This is an EXACT-match denylist
// on the whole normalized string, not a substring ban: "Jennyfer's Toolbox" is
// a legitimate name and must not be rejected merely for containing "jenny".
const RESERVED_DISPLAY_LABELS = new Set([
  'jenny',
  'jenny official',
  'official jenny',
  'jenny team',
  'jenny core',
  'jenny platform',
  'jenny plugin',
  'jenny plugins',
  'official',
  'official plugin',
  'verified',
  'verified publisher',
  'trusted',
  'trusted publisher',
]);

/**
 * @param {string} value
 * @returns {boolean} true if `value` contains a control, bidi-override, or
 *   zero-width code point.
 */
function hasForbiddenCodepoint(value) {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
    if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
    if (BIDI_OVERRIDE_CODEPOINTS.has(codePoint) || ZERO_WIDTH_CODEPOINTS.has(codePoint)) return true;
  }
  return false;
}

/**
 * Canonicalizes a display string for reserved-label comparison: NFC, casefold
 * (simple lowercase, sufficient for the ASCII-centric reserved list), trim,
 * and collapse internal whitespace runs to one space. This makes "  Jenny  "
 * and "JENNY" both match the reserved entry "jenny" without treating that as
 * a general substring ban.
 * @param {string} value
 */
function normalizeForReservedLabelCheck(value) {
  return value.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Validates one publisher/plugin/contribution display string. Returns a
 * bounded structured verdict; never throws on hostile input.
 * @param {unknown} rawValue
 * @returns {{ok:true,value:string}|{ok:false,code:string,byte_count?:number}}
 */
function validateDisplayString(rawValue) {
  if (typeof rawValue !== 'string') {
    return { ok: false, code: 'not_string' };
  }
  if (rawValue.length === 0) {
    return { ok: false, code: 'empty_display_string' };
  }
  const byteCount = Buffer.byteLength(rawValue, 'utf8');
  if (byteCount > MAX_DISPLAY_STRING_UTF8_BYTES) {
    return { ok: false, code: 'display_string_too_long', byte_count: byteCount };
  }
  if (hasForbiddenCodepoint(rawValue)) {
    return { ok: false, code: 'forbidden_codepoint' };
  }
  if (rawValue.normalize('NFC') !== rawValue) {
    return { ok: false, code: 'not_nfc_normalized' };
  }
  if (RESERVED_DISPLAY_LABELS.has(normalizeForReservedLabelCheck(rawValue))) {
    return { ok: false, code: 'reserved_display_label' };
  }
  return { ok: true, value: rawValue };
}

module.exports = {
  MAX_DISPLAY_STRING_UTF8_BYTES,
  hasForbiddenCodepoint,
  normalizeForReservedLabelCheck,
  validateDisplayString,
};
