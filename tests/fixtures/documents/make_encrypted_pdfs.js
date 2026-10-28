'use strict';

// Generate the password-protected PDF fixtures for the encrypted save round
// trip (row 65 W4, tests/renderer-ide-pdf-encrypted-save.test.js). The repo has
// no qpdf/pikepdf/pypdf, and PyMuPDF picks random IVs and keys, so this writes
// the standard security handler by hand with fixed salts, keys and IVs: every
// run produces the same bytes. Re-run with
// `node tests/fixtures/documents/make_encrypted_pdfs.js`; the outputs are
// committed and the tests never run this script.
//
//   encrypted-rc4.pdf    V2 R3, RC4 128-bit
//   encrypted-aes256.pdf V5 R6, AESV3 (AES-256)
//
// Both use the user password "secret" and carry one page of text plus an empty
// AcroForm text field named "note" (the shape annotated.pdf has).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const USER_PASSWORD = Buffer.from('secret', 'latin1');
const OWNER_PASSWORD = Buffer.from('jenny-fixture-owner', 'latin1');
const PERMISSIONS = -4; // Every permission; bits 1-2 must be clear.
const FILE_ID = crypto.createHash('md5').update('jenny encrypted PDF fixture').digest();
const PAGE_TEXT = 'Password-protected fixture page';

// PDF 32000-1 7.6.3.3 Algorithm 2 padding string.
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const sha = (bits, ...parts) => crypto.createHash(`sha${bits}`).update(Buffer.concat(parts)).digest();
const derive = (label, length) => sha(256, Buffer.from(`jenny fixture ${label}`)).subarray(0, length);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let index = 0, i = 0, j = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[index] = data[index] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function aes(mode, key, iv, data, padding) {
  const cipher = crypto.createCipheriv(mode, key, iv);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

const padPassword = (password) => Buffer.concat([password, PAD]).subarray(0, 32);
const int32le = (value) => { const out = Buffer.alloc(4); out.writeInt32LE(value); return out; };

// RC4 R3 rounds: the key XOR i for i = 1..19 after the first pass.
function rc4Rounds(key, data) {
  let out = rc4(key, data);
  for (let round = 1; round <= 19; round += 1) out = rc4(key.map((byte) => byte ^ round), out);
  return out;
}

function rc4Handler() {
  const length = 16;
  // Algorithm 3: the O entry.
  let ownerHash = md5(padPassword(OWNER_PASSWORD));
  for (let round = 0; round < 50; round += 1) ownerHash = md5(ownerHash);
  const owner = rc4Rounds(ownerHash.subarray(0, length), padPassword(USER_PASSWORD));
  // Algorithm 2: the file key.
  let key = md5(padPassword(USER_PASSWORD), owner, int32le(PERMISSIONS), FILE_ID);
  for (let round = 0; round < 50; round += 1) key = md5(key.subarray(0, length));
  key = key.subarray(0, length);
  // Algorithm 5: the U entry (16 bytes, then 16 arbitrary bytes).
  const user = Buffer.concat([rc4Rounds(key, md5(PAD, FILE_ID)), derive('rc4 U tail', 16)]);
  return {
    dict: `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${PERMISSIONS} /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`,
    encrypt(num, gen, data) {
      const objectKey = md5(key, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]));
      return rc4(objectKey.subarray(0, Math.min(length + 5, 16)), data);
    },
  };
}

// Algorithm 2.B (ISO 32000-2 7.6.4.3.4): the R6 hash.
function hashR6(password, salt, userKey) {
  let k = sha(256, password, salt, userKey);
  let e = Buffer.alloc(0);
  for (let round = 0; round < 64 || e.at(-1) > round - 32; round += 1) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([password, k, userKey])));
    e = aes('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32), k1, false);
    const remainder = e.subarray(0, 16).reduce((sum, byte) => sum + byte, 0) % 3;
    k = sha([256, 384, 512][remainder], e);
  }
  return k.subarray(0, 32);
}

function aes256Handler() {
  const fileKey = derive('aes256 file key', 32);
  const zeroIv = Buffer.alloc(16);
  const [uValidation, uKey, oValidation, oKey] = ['U validation', 'U key', 'O validation', 'O key']
    .map((label) => derive(`aes256 ${label} salt`, 8));
  const user = Buffer.concat([hashR6(USER_PASSWORD, uValidation, Buffer.alloc(0)), uValidation, uKey]);
  const userEncrypted = aes('aes-256-cbc', hashR6(USER_PASSWORD, uKey, Buffer.alloc(0)), zeroIv, fileKey, false);
  const owner = Buffer.concat([hashR6(OWNER_PASSWORD, oValidation, user), oValidation, oKey]);
  const ownerEncrypted = aes('aes-256-cbc', hashR6(OWNER_PASSWORD, oKey, user), zeroIv, fileKey, false);
  const perms = aes('aes-256-ecb', fileKey, null, Buffer.concat([
    int32le(PERMISSIONS), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('Tadb'), derive('aes256 perms tail', 4),
  ]), false);
  const hex = (bytes) => `<${bytes.toString('hex')}>`;
  return {
    dict: `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${PERMISSIONS}`
      + ' /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF'
      + ` /O ${hex(owner)} /U ${hex(user)} /OE ${hex(ownerEncrypted)} /UE ${hex(userEncrypted)} /Perms ${hex(perms)} >>`,
    encrypt(num, gen, data) {
      const iv = derive(`aes256 iv ${num} ${gen} ${data.toString('hex')}`, 16);
      return Buffer.concat([iv, aes('aes-256-cbc', fileKey, iv, data, true)]);
    },
  };
}

function buildPdf(handler) {
  const str = (num, text) => `<${handler.encrypt(num, 0, Buffer.from(text, 'latin1')).toString('hex')}>`;
  const content = Buffer.from(`BT /F1 14 Tf 72 700 Td (${PAGE_TEXT}) Tj ET\n`, 'latin1');
  const encryptedContent = handler.encrypt(4, 0, content);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R'
      + ' /Resources << /Font << /F1 6 0 R >> >> /Annots [7 0 R] >>',
    Buffer.concat([Buffer.from(`<< /Length ${encryptedContent.length} >>\nstream\n`), encryptedContent, Buffer.from('\nendstream')]),
    `<< /Fields [7 0 R] /DA ${str(5, '/Helv 0 Tf 0 g')} /DR << /Font << /Helv 8 0 R >> >> >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${str(7, 'note')} /Rect [72 560 400 590] /F 4 /P 3 0 R`
      + ` /DA ${str(7, '/Helv 12 Tf 0 g')} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    handler.dict, // The Encrypt dictionary itself is never encrypted.
  ];
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = objects.map((body, index) => {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    const at = offset;
    offset += chunk.length;
    return at;
  });
  const id = FILE_ID.toString('hex');
  chunks.push(Buffer.from([
    'xref', `0 ${objects.length + 1}`, '0000000000 65535 f\r',
    ...offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n\r`),
    'trailer', `<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt ${objects.length} 0 R /ID [<${id}> <${id}>] >>`,
    'startxref', String(offset), '%%EOF', '',
  ].join('\n')));
  return Buffer.concat(chunks);
}

function main() {
  for (const [name, handler] of [['encrypted-rc4.pdf', rc4Handler()], ['encrypted-aes256.pdf', aes256Handler()]]) {
    const bytes = buildPdf(handler);
    fs.writeFileSync(path.join(__dirname, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}

if (require.main === module) main();
