'use strict';

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

const normalizeId = normalizeString;

module.exports = { normalizeId, normalizeString, normalizeText };
