'use strict';

// The team chat reaction allowlist (row 123 slice 2b-1, TEAM_CHAT_SPEC "API and
// realtime"). One small data module: the host validates `team.chat.react`
// against it and the renderer picker (slice 2b-2) reuses the same list. Each
// entry is one exact code-point string. No skin-tone modifier and no ZWJ
// sequence is listed; a variation selector (U+FE0F) appears only where the
// emoji needs it to render as a picture. A client that sends the same picture
// without the selector is refused, never normalized.
//
// The final contents are an owner pick in a later review. A stored record keeps
// whatever emoji it was reacted with: the schema accepts any short non-ASCII
// key on load, so changing this list never corrupts a channel.

const REACTION_EMOJI = Object.freeze([
  '\u{1F44D}', // thumbs up
  '\u{1F44E}', // thumbs down
  '❤️', // red heart
  '\u{1F602}', // face with tears of joy
  '\u{1F389}', // party popper
  '\u{1F62E}', // face with open mouth
  '\u{1F622}', // crying face
  '\u{1F64F}', // folded hands
  '\u{1F525}', // fire
  '\u{1F440}', // eyes
  '✅', // check mark button
  '❌', // cross mark
  '\u{1F680}', // rocket
  '\u{1F4AF}', // hundred points
  '\u{1F44F}', // clapping hands
  '\u{1F914}', // thinking face
  '\u{1F60D}', // heart eyes
  '\u{1F605}', // grinning face with sweat
  '\u{1F64C}', // raising hands
  '\u{1F4AA}', // flexed biceps
  '\u{1F44C}', // OK hand
  '\u{1F60A}', // smiling face with smiling eyes
  '\u{1F60E}', // smiling face with sunglasses
  '\u{1F91D}', // handshake
  '⭐', // star
  '✨', // sparkles
  '\u{1F4A1}', // light bulb
  '⚠️', // warning
  '\u{1F3AF}', // bullseye
  '\u{1F62D}', // loudly crying face
  '\u{1F92F}', // exploding head
  '\u{1F973}', // partying face
  '\u{1F601}', // beaming face
  '\u{1F609}', // winking face
  '\u{1F642}', // slightly smiling face
  '\u{1F62C}', // grimacing face
  '\u{1F937}', // person shrugging
  '\u{1F494}', // broken heart
  '\u{1F4CC}', // pushpin
  '☕', // hot beverage
  '\u{1F41B}', // bug
]);

const ALLOWED = new Set(REACTION_EMOJI);

function isReactionEmoji(value) {
  return typeof value === 'string' && ALLOWED.has(value);
}

module.exports = { REACTION_EMOJI, isReactionEmoji };
