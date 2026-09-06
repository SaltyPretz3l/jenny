'use strict';

const fs = require('node:fs');
const {
  normalizeIdentifier,
  normalizeTerminalStatus,
  sanitizeStructure,
  truncateUtf8,
} = require('../../services/backend/generated-chat-lifecycle-contract');

function structureValue(item) {
  if (item.kind === 'value') return item.value;
  if (item.kind === 'array') return Array.from({ length: item.size }, (_, index) => index);
  if (item.kind === 'bytes') return { text: '会'.repeat(item.size) };
  let value = { leaf: true };
  for (let index = 0; index < item.depth; index += 1) value = { child: value };
  return value;
}

const corpus = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = {
  identifiers: corpus.identifier_values.map((value) => normalizeIdentifier(value)),
  terminals: corpus.terminal_values.map((value) => normalizeTerminalStatus(value)),
  truncations: corpus.truncate_cases.map((item) => truncateUtf8(item.value, item.bytes)),
  structures: corpus.structure_cases.map((item) => sanitizeStructure(structureValue(item))),
};
process.stdout.write(JSON.stringify(result));
