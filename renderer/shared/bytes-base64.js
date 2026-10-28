/* renderer/shared/bytes-base64.js - one base64 <-> Uint8Array codec for the
 * Workspace IDE document panes (PDF and DOCX). Native Uint8Array.fromBase64 /
 * #toBase64 where the engine has them (Electron); otherwise atob/btoa, with
 * the encode loop applying String.fromCharCode to 8K chunks (spreading 32K
 * arguments is ~7x slower). Loaded lazily with the document runtimes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBytesBase64 = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const CHUNK = 0x2000;

  // Throws on malformed input in both paths.
  function decodeBase64(base64) {
    const text = String(base64 || '');
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
    const binary = globalRef.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function encodeBase64(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK)));
    }
    return globalRef.btoa(chunks.join(''));
  }

  return { decodeBase64, encodeBase64 };
});
