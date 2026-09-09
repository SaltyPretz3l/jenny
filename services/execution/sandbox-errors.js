'use strict';
const { TOOL_ERROR_CODES } = require('../backend/error-codes');
function sandboxError(reason) {
  return Object.assign(new Error(reason), { code: TOOL_ERROR_CODES.EXECUTION_FAILED, reason });
}
function digest(value) {
  return require('node:crypto').createHash('sha256').update(
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  ).digest('hex');
}
module.exports = { sandboxError, digest };