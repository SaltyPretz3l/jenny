'use strict';

function downloadDisposition(value) {
  const name = [...String(value || 'attachment').toWellFormed()].map((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127 || ['\\', '/', '"'].includes(character) ? '_' : character;
  }).join('').slice(0, 240);
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_') || 'attachment';
  const encoded = encodeURIComponent(name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = { downloadDisposition };
