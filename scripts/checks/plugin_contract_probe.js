'use strict';

const fs = require('node:fs');
const { validate } = require('../../services/plugins/contracts/generated-plugin-contracts.js');

const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = cases.map((item) => validate(item.contract, item.value));
process.stdout.write(JSON.stringify(results));
