'use strict';

const readline = require('node:readline');
const { readPassword } = require('./cli');

function createPrompts({ input = process.stdin, output = process.stdout } = {}) {
  const say = (message) => output.write(message + '\n');
  async function ask(label, fallback = '') {
    if (!input.isTTY || !output.isTTY) throw new Error('interactive_terminal_required');
    const suffix = fallback ? ' [' + fallback + ']' : '';
    const answer = await new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output, terminal: true });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        rl.close();
        if (error) reject(error); else resolve(value);
      };
      rl.once('SIGINT', () => finish(new Error('setup_cancelled')));
      rl.once('close', () => finish(new Error('setup_cancelled')));
      rl.question(label + suffix + ': ', (value) => finish(null, value));
    });
    const value = answer.trim() || fallback;
    if (value.length > 2048 || /\p{Cc}/u.test(value)) throw new Error('invalid_input');
    return value;
  }
  async function yes(label, fallback = false) {
    const answer = (await ask(label + ' (yes/no)', fallback ? 'yes' : 'no')).toLowerCase();
    if (!['yes', 'y', 'no', 'n'].includes(answer)) throw new Error('answer_yes_or_no');
    return ['yes', 'y'].includes(answer);
  }
  return { say, ask, yes, secret: (prompt) => readPassword({ input, output, prompt }) };
}

module.exports = { createPrompts };
