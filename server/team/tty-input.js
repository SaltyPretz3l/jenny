'use strict';

// One line typed on an interactive terminal (slices 1h and 3-13/3-14): the owner password of `owner-init`, the
// archive passphrase of `import-conversations`, the backup password of `team-export` and `team-restore` (no
// echo), and the team name `team-delete` asks for (echoed). The terminal is put in raw mode, so nothing is read
// from a pipe or a file: a stream that is not a TTY is refused before a byte is read. Ctrl-C cancels, Enter ends
// the line, backspace and DEL edit it, other characters below a space are dropped, and a line reaches 1024
// characters at most. End of input before Enter is a refusal, never an empty answer. The prompt and the echo go
// to `output` (standard error by default), never standard output. Nothing here logs.

const { StringDecoder } = require('node:string_decoder');

const MAX_CHARACTERS = 1024;

function inputError(reason, message) {
  return Object.assign(new Error(message), { reason });
}

function isTerminalInput(input) {
  return input?.isTTY === true && typeof input.setRawMode === 'function';
}

/** True when `input` is a terminal this reader takes and `output` (where the prompt goes) is a terminal too. */
function isTerminalPair(input, output) {
  return isTerminalInput(input) && output?.isTTY === true;
}

function readTerminalLine({ input = process.stdin, output = process.stderr, prompt = '', echo = false } = {}) {
  if (!isTerminalInput(input)) {
    return Promise.reject(inputError('tty_required', 'An interactive TTY is required.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let value = '';
    const decoder = new StringDecoder('utf8');
    const wasRaw = Boolean(input.isRaw);
    const finish = (error, result = '') => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(result);
    };
    const onEnd = () => finish(inputError('input_closed', 'Input ended.'));
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') return finish(inputError('input_cancelled', 'Input cancelled.'));
        if (character === '\u0004' && value.length === 0) return onEnd();
        if (character === '\n' || character === '\r') return finish(null, value);
        if (character === '\b' || character === '\u007f') {
          if (echo && value.length > 0) output.write('\b \b');
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          if (value.length >= MAX_CHARACTERS) return finish(inputError('input_too_long', 'Secret input limit exceeded.'));
          value += character;
          if (echo) output.write(character);
        }
      }
    };
    try {
      output.write(prompt);
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      input.on('end', onEnd);
    } catch (error) {
      finish(error);
    }
  });
}

/** A secret line, not echoed (the owner password, a passphrase, the backup password). */
function readPassword({ input = process.stdin, output = process.stderr, prompt = 'Password: ' } = {}) {
  return readTerminalLine({ input, output, prompt, echo: false });
}

module.exports = { MAX_CHARACTERS, isTerminalInput, isTerminalPair, readPassword, readTerminalLine };
