'use strict';

// The terminal's ask port for the TTY decider (Jenny CLI plan, decision 4):
// how an approval, a plan or a question batch is shown and how a typed answer
// is read. The formatting and parsing are pure; `createReadlineAsk` is the
// thin readline shell around them. A withdrawn request aborts the pending
// question and resolves to undefined, which the decider treats as a denial.

const INPUT_LIMIT = 600;
const PLAN_STEP_LIMIT = 20;
const CHOICE_WORDS = Object.freeze({
  y: 'allow', yes: 'allow', a: 'allow', allow: 'allow', once: 'allow',
  r: 'allow_run', run: 'allow_run', always: 'allow_run',
  n: 'deny', no: 'deny', d: 'deny', deny: 'deny',
});

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function choiceLegend({ oneOff = false, plan = false } = {}) {
  if (plan) return '[y]es, proceed with this plan / [n]o';
  if (oneOff) return '[y]es once / [n]o';
  return '[y]es once / [r]un: allow for the rest of this run / [n]o';
}

// A typed choice, or null when it is not one. `allow_run` collapses to a
// one-off allow where the request cannot be remembered (a one-off tool, a plan).
function parseChoice(answer, { oneOff = false, plan = false } = {}) {
  const choice = CHOICE_WORDS[String(answer ?? '').trim().toLowerCase()];
  if (!choice) return null;
  if (choice === 'allow_run' && (oneOff || plan)) return 'allow';
  return choice;
}

function formatInput(input) {
  if (input === undefined || input === null) return null;
  try { return clip(JSON.stringify(input), INPUT_LIMIT); } catch (_error) { return clip(String(input), INPUT_LIMIT); }
}

function formatRequest(request) {
  const lines = [];
  if (request.kind === 'plan_proposal') {
    const plan = request.plan || {};
    lines.push(`[plan] ${clip(plan.title || request.summary || request.toolName || 'plan', 200)}`.trimEnd());
    const steps = Array.isArray(plan.steps) ? plan.steps.slice(0, PLAN_STEP_LIMIT) : [];
    steps.forEach((step, index) => lines.push(`  ${index + 1}. ${clip(typeof step === 'string' ? step : step?.title || step?.text || '', 200)}`));
    if (plan.summary) lines.push(`  ${clip(plan.summary, 400)}`);
    return lines;
  }
  if (request.kind === 'user_questions') {
    const count = Array.isArray(request.questions) ? request.questions.length : 0;
    lines.push(`[questions] Jenny asks ${count} question${count === 1 ? '' : 's'} (an empty answer declines)`);
    return lines;
  }
  lines.push(`[approval] ${request.toolName}${request.summary ? `: ${clip(request.summary, 400)}` : ''}${request.one_off_only ? ' (this exact call only)' : ''}`);
  const input = formatInput(request.input);
  if (input) lines.push(`  input: ${input}`);
  return lines;
}

function formatQuestion(question, index) {
  const lines = [`${index}. ${clip(question.prompt, 400)}`];
  const options = Array.isArray(question.options) ? question.options : [];
  options.forEach((option, optionIndex) => lines.push(`   ${optionIndex + 1}) ${clip(option, 200)}`));
  if (options.length) {
    const hints = [question.multi_select ? 'numbers, comma-separated' : 'a number'];
    if (question.allow_other) hints.push('or your own answer');
    lines.push(`   (${hints.join(' ')})`);
  }
  return lines;
}

// The answer value for one question, or null when the line is empty or names
// no listed option: a number picks by position, a label by exact text, free
// text only where the question allows it. Multi-select answers are arrays.
function parseAnswer(line, question) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  const options = Array.isArray(question.options) ? question.options : [];
  if (!options.length) return text;
  const parts = question.multi_select ? text.split(',').map((part) => part.trim()).filter(Boolean) : [text];
  const values = [];
  for (const part of parts) {
    const number = /^\d+$/u.test(part) ? Number(part) : NaN;
    if (number >= 1 && number <= options.length) { values.push(options[number - 1]); continue; }
    const label = options.find((option) => option.toLowerCase() === part.toLowerCase());
    if (label) { values.push(label); continue; }
    if (question.allow_other) { values.push(part); continue; }
    return null;
  }
  if (!values.length) return null;
  return question.multi_select ? [...new Set(values)] : values[0];
}

// ask(request, { signal }) over a readline interface. `write` prints one line
// of prompt text; `beforePrompt` lets the caller end an open answer line first.
function createReadlineAsk({ rl, write, beforePrompt = () => {} }) {
  if (!rl || typeof rl.question !== 'function') throw new TypeError('A readline interface is required.');
  if (typeof write !== 'function') throw new TypeError('A write function is required.');

  const question = (query, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(undefined); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      rl.off('close', onClose);
      resolve(value);
    };
    const onAbort = () => { write('(withdrawn)'); finish(undefined); };
    const onClose = () => finish(undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.once('close', onClose);
    rl.question(query, signal ? { signal } : {}, (answer) => finish(answer));
  });

  async function askQuestions(request, signal) {
    const answers = [];
    const questions = Array.isArray(request.questions) ? request.questions : [];
    for (const [index, item] of questions.entries()) {
      for (const line of formatQuestion(item, index + 1)) write(line);
      for (;;) {
        const raw = await question('? ', signal);
        if (raw === undefined) return undefined;
        const value = parseAnswer(raw, item);
        if (value !== null) { answers.push({ id: item.id, value }); break; }
        if (!String(raw).trim()) return null;
        write('Pick a listed option (or press Enter to decline).');
      }
    }
    return { answers };
  }

  async function ask(request, { signal } = {}) {
    beforePrompt();
    for (const line of formatRequest(request)) write(line);
    if (request.kind === 'user_questions') return askQuestions(request, signal);
    const context = { oneOff: request.one_off_only === true, plan: request.kind === 'plan_proposal' };
    const legend = choiceLegend(context);
    for (;;) {
      const raw = await question(`${legend} `, signal);
      if (raw === undefined) return undefined;
      const choice = parseChoice(raw, context);
      if (choice) return choice;
      write(`Answer ${legend}.`);
    }
  }

  return ask;
}

module.exports = { choiceLegend, createReadlineAsk, formatQuestion, formatRequest, parseAnswer, parseChoice };
