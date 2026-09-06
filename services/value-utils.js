function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ensureArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

module.exports = {
  ensureArray,
  isPlainObject,
};
