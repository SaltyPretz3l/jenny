'use strict';

const protocol = require('./protocol');
const { BINARY_NAME, resolveHelperBinary } = require('./helper-binary');
const { createComputerHelperHost } = require('./host');

module.exports = { BINARY_NAME, createComputerHelperHost, protocol, resolveHelperBinary };
