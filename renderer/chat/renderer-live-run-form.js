/* renderer/chat/renderer-live-run-form.js - the Live panel's run-command form, its exact-text confirm and the notices it
 * shows while the program is not running (row 197).
 *
 * The form turns six plain fields into the command shape the main process validates; the confirm block shows the
 * exact words that will run, with invisible characters made visible, before anything is saved. The panel owns the bridge
 * and the view record and hands both in through `ui`; every word that came from the bridge is set as text. Loaded lazily
 * with the Live panel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tool-approval-facts'));
    return;
  }
  root.rendererLiveRunForm = factory(root.toolApprovalFacts);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (approvalFacts) {
  'use strict';

  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);

  const showInvisible = (text) => (approvalFacts?.showInvisible ? approvalFacts.showInvisible(text) : String(text));
  const FIELD_IDS = Object.freeze({ build: 'lvBuild', program: 'lvProgram', args: 'lvArgs', cwd: 'lvCwd', env: 'lvEnv', watch: 'lvWatch' });
  const MULTILINE = Object.freeze({ args: true, env: true });

  // The field each store refusal concerns; the rest are about the command as a whole ('form').
  const REASON_FIELD = Object.freeze({
    build_invalid: 'build', program_invalid: 'program', program_not_anchored: 'program', args_invalid: 'args', cwd_invalid: 'cwd', watch_invalid: 'watch',
    reserved_env_key: 'env', plaintext_secret: 'env', env_invalid: 'env',
  });

  function reasonText(reason) {
    switch (reason) {
      case 'build_invalid': return jt('chat.liveView.reason.build_invalid', 'The build step is too long or has a character that is not allowed.');
      case 'program_invalid': return jt('chat.liveView.reason.program_invalid', 'Enter the program to run.');
      case 'program_not_anchored': return jt('chat.liveView.reason.program_not_anchored', 'Start the path with a drive letter, such as C:\\Tools\\game.exe, or use a path inside the project.');
      case 'args_invalid': return jt('chat.liveView.reason.args_invalid', 'An argument is too long or has a character that is not allowed, or there are too many.');
      case 'cwd_invalid': return jt('chat.liveView.reason.cwd_invalid', 'Use a folder inside the project, written without a drive letter or “..”.');
      case 'watch_invalid': return jt('chat.liveView.reason.watch_invalid', 'Use folders inside the project, separated by commas.');
      case 'reserved_env_key': return jt('chat.liveView.reason.reserved_env_key', 'That name is set by Jenny and cannot be changed here.');
      case 'plaintext_secret': return jt('chat.liveView.reason.plaintext_secret', 'Do not put passwords or keys here. Jenny does not keep secrets in a run command.');
      case 'env_invalid': return jt('chat.liveView.reason.env_invalid', 'Write each line as NAME=value, with a name of letters, digits and underscores.');
      case 'command_invalid': return jt('chat.liveView.reason.command_invalid', 'The command could not be read. Check each field.');
      case 'binding_invalid': return jt('chat.liveView.reason.binding_invalid', 'The project folder is not available. Open the project and try again.');
      case 'store_newer': return jt('chat.liveView.reason.store_newer', 'The saved commands come from a newer Jenny, so this one cannot be changed.');
      case 'too_many_projects': return jt('chat.liveView.reason.too_many_projects', 'Too many projects have a run command. Remove one first.');
      case 'write_failed': return jt('chat.liveView.reason.write_failed', 'The command could not be saved. Try again.');
      case 'run_active': return jt('chat.liveView.reason.run_active', 'Stop the program to change its command.');
      case 'no_project': return jt('chat.liveView.reason.no_project', 'Open a chat in a project to run its program.');
      default: return jt('chat.liveView.reason.other', 'The command was not accepted.');
    }
  }

  const lines = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLines = (text, count) => String(text || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-count);

  // The saved command as the six fields show it.
  function valuesFromCommand(command) {
    const c = command || {};
    return {
      build: c.build || '',
      program: c.program || '',
      args: (c.args || []).join('\n'),
      cwd: c.cwd || '',
      env: Object.entries(c.env || {}).map(([name, value]) => `${name}=${value}`).join('\n'),
      watch: (c.watch || []).join(', '),
    };
  }

  // The six fields as a command, or { field, reason } for the first one that cannot be read.
  function parseValues(values) {
    const v = values || {};
    const program = String(v.program || '').trim();
    if (!program) return { ok: false, field: 'program', reason: 'program_invalid' };
    const env = {};
    for (const line of lines(v.env)) {
      const at = line.indexOf('=');
      if (at < 1) return { ok: false, field: 'env', reason: 'env_invalid' };
      env[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    return {
      ok: true,
      command: {
        build: String(v.build || '').trim(),
        program,
        args: String(v.args || '').split(/\r?\n/).filter((arg) => arg.trim() !== ''),
        cwd: String(v.cwd || '').trim(),
        env,
        watch: String(v.watch || '').split(',').map((folder) => folder.trim()).filter(Boolean),
      },
    };
  }

  const quoted = (text) => (/\s/u.test(text) ? `"${text}"` : text);

  // What the owner confirms, one line each. Every line goes through showInvisible.
  function confirmLines(command) {
    const c = command || {};
    const none = jt('chat.liveView.confirm.none', '(none)');
    const envText = Object.entries(c.env || {}).map(([name, value]) => `${name}=${value}`).join(' ');
    return [
      `${jt('chat.liveView.confirm.build', 'Build:')}  ${c.build || none}`,
      `${jt('chat.liveView.confirm.start', 'Start:')}  ${[c.program, ...(c.args || [])].map(quoted).join(' ')}`,
      `${jt('chat.liveView.confirm.in', 'In:')}     ${c.cwd || jt('chat.liveView.confirm.projectFolder', 'project folder')}`,
      `${jt('chat.liveView.confirm.env', 'Env:')}    ${envText || none}`,
    ].map(showInvisible);
  }

  function fieldSpecs() {
    return [
      { name: 'build', label: jt('chat.liveView.form.build', 'Build step (optional)') },
      { name: 'program', label: jt('chat.liveView.form.program', 'Program') },
      { name: 'args', label: jt('chat.liveView.form.args', 'Arguments'), hint: jt('chat.liveView.form.argsHint', 'One argument per line.') },
      { name: 'cwd', label: jt('chat.liveView.form.cwd', 'Working folder (optional)') },
      { name: 'env', label: jt('chat.liveView.form.env', 'Environment (optional)'), hint: jt('chat.liveView.form.envHint', 'One NAME=value per line.') },
      // Nothing reads the folders yet, so the field is greyed out with its reason (kept so a saved value still shows).
      { name: 'watch', label: jt('chat.liveView.form.watch', 'Restart when these folders change (optional)'), disabled: true,
        hint: jt('chat.liveView.form.watchNotYet', "Not used yet. Today the program restarts after Jenny's own changes, while \"Restart after Jenny's changes\" is on.") },
    ];
  }

  // The six fields, each with an empty line for its refusal; the values go in through the primitive.
  function fieldsHtml(textField, values) {
    return fieldSpecs().map((spec) => `<div class="lv-field">${textField({
      id: FIELD_IDS[spec.name], label: spec.label, value: values[spec.name] || '', hint: spec.hint,
      multiline: MULTILINE[spec.name] === true, rows: 2, spellcheck: false, disabled: spec.disabled === true, dataset: { 'lv-field': spec.name },
    })}<p class="lv-field-error hidden" role="alert" data-lv-error="${spec.name}"></p></div>`).join('');
  }

  const readValues = (host) => Object.fromEntries(Object.keys(FIELD_IDS).map((name) => [name, host.querySelector(`[data-lv-field="${name}"]`)?.value || '']));

  function showErrors(host, errors) {
    host.querySelectorAll('[data-lv-error]').forEach((node) => {
      const text = errors?.[node.dataset.lvError] || '';
      node.textContent = text;
      node.classList.toggle('hidden', !text);
    });
  }

  function againLine(reason) {
    if (reason === 'rebind') return jt('chat.liveView.again.rebind', 'The project folder changed, so confirm the command again.');
    if (reason === 'worktree') return jt('chat.liveView.again.worktree', 'This chat is in another worktree, so confirm the command again.');
    return reason === 'restore' ? jt('chat.liveView.again.restore', 'Your profile was restored, so confirm the command again.') : '';
  }

  /* ui = { windowRef, view, el(tag, class, text), textButton(action, label, variant), call(method, payload), update(),
   *   flash(text), applyGet(reply), body() -> the panel body, stillStage(look) -> nodes, isResting() -> bool, insert(payload) } */
  function createLiveRunForm(ui) {
    const { view } = ui;

    function formNodes() {
      const saved = view.command.status === 'none' ? null : view.command.command;
      const card = ui.el('div', 'lv-card');
      const heading = view.command.status === 'none' ? jt('chat.liveView.noCommand.title', 'No run command yet') : jt('chat.liveView.form.heading', 'Run command');
      card.append(ui.el('strong', '', heading), ui.el('p', '', jt('chat.liveView.noCommand.body', 'Tell Jenny how to start your program. It runs in its own window, behind this one.')));
      const why = view.command.status === 'needs_confirmation' ? againLine(view.command.reason) : '';
      if (why) card.append(ui.el('p', 'lv-note', why));
      const form = ui.el('div', 'lv-form');
      form.innerHTML = fieldsHtml(ui.windowRef.inventoryTextField, view.values || valuesFromCommand(saved));
      const formError = ui.el('p', ['lv-field-error', 'hidden']);
      formError.dataset.lvError = 'form';
      formError.setAttribute('role', 'alert');
      const actions = ui.el('div', 'lv-actions');
      actions.append(ui.textButton('review', jt('chat.liveView.reviewConfirm', 'Review and confirm'), 'primary'));
      card.append(form, formError, actions);
      return [card];
    }

    function confirmNodes() {
      const card = ui.el('div', 'lv-card');
      const block = ui.el('div', 'lv-confirm');
      const actions = ui.el('div', 'lv-actions');
      actions.append(ui.textButton('confirm', jt('chat.liveView.confirm.confirm', 'Confirm'), 'primary'), ui.textButton('amend', jt('chat.liveView.confirm.edit', 'Edit')));
      block.append(ui.el('pre', 'lv-mono', confirmLines(view.parsed).join('\n')),
        ui.el('p', 'lv-note', jt('chat.liveView.confirm.note', 'Jenny may restart this command after it changes your code. It is asked for again if the project folder moves.')), actions);
      card.append(block);
      return [card];
    }

    function notice({ title, text = '', mono, error = false, buttons = [], note = '' }) {
      const box = ui.el('div', ['bu-message', 'lv-notice']);
      box.append(ui.el('strong', '', title));
      if (text) box.append(ui.el('p', 'lv-note', text));
      if (mono) box.append(ui.el('pre', `lv-mono${error ? ' lv-error' : ''}`, mono));
      if (buttons.length) {
        const row = ui.el('div', 'lv-actions');
        row.append(...buttons);
        box.append(row);
      }
      if (note) box.append(ui.el('span', 'lv-note', note));
      return box;
    }

    // The words under a program that is not running (or is stopping), for the states that have any.
    function stoppedNodes(run) {
      const exit = run.exitCode;
      const withCode = (text, bare) => (exit === null || exit === undefined ? bare : text);
      const show = () => ui.textButton('show', jt('chat.liveView.showWindow', 'Show window'));
      const again = () => ui.textButton('run', jt('chat.liveView.runAgain', 'Run again'));
      const out = view.output.lines;
      switch (run.state) {
        case 'build_failed': return [...ui.stillStage('dim'), notice({
          title: withCode(jt('chat.liveView.buildFailed', 'Build failed (exit code {code})', { code: exit }), jt('chat.liveView.buildFailedBare', 'Build failed')),
          mono: lastLines(run.buildTail, 5).join('\n'), error: true,
          buttons: [ui.textButton('send-error', jt('chat.liveView.sendError', 'Send the error to Jenny'), 'primary'), again()],
          note: jt('chat.liveView.sendErrorNote', 'The error goes into your message box; nothing is sent until you send it.'),
        })];
        case 'ended_early': return run.reason === 'helper_unavailable' ? [notice({
          title: run.helperBuildHint === false ? jt('chat.liveView.helperMissingPackaged', "Jenny's screen helper is missing. Reinstall Jenny.")
            : jt('chat.liveView.helperMissingSource', "Jenny's screen helper is missing, so it cannot show this window. Build it with npm run build:computer-helper."),
          buttons: [again()],
        })] : [notice({
          title: withCode(jt('chat.liveView.endedEarly', 'The program ended before showing a window (exit code {code}).', { code: exit }), jt('chat.liveView.endedEarlyBare', 'The program ended before showing a window.')),
          mono: out.slice(-3).join('\n'), buttons: [again()],
        })];
        case 'no_window': return [notice({ title: jt('chat.liveView.noWindow', 'Running, but no window has appeared after 15 seconds.'), mono: out.slice(-5).join('\n') })];
        case 'minimized': return [notice({ title: jt('chat.liveView.minimized', 'The window is minimised, so there is no picture.'), buttons: [show()] })];
        case 'closed': return [...ui.stillStage('still'), notice({
          title: withCode(jt('chat.liveView.closed', 'The program closed (exit code {code}).', { code: exit }), jt('chat.liveView.closedBare', 'The program closed.')),
          buttons: [ui.textButton('run', jt('chat.liveView.run', 'Run'))],
        })];
        case 'stopping': return [...ui.stillStage('still'), notice({ title: jt('chat.liveView.stopping', 'Stopping…') })];
        default: return [...ui.stillStage('still'), notice({
          title: jt('chat.liveView.closeRefused', 'The program did not close. It may be asking a question in its window.'),
          buttons: [show(), ui.textButton('force', jt('chat.liveView.forceStop', 'Force stop'), 'danger')],
        })];
      }
    }

    function review() {
      const values = readValues(ui.body());
      const parsed = parseValues(values);
      view.values = values;
      view.errors = parsed.ok ? {} : { [parsed.field]: reasonText(parsed.reason) };
      if (!parsed.ok) { showErrors(ui.body(), view.errors); return; }
      view.parsed = parsed.command;
      go('confirm');
    }

    function go(screen) {
      view.screen = screen;
      view.seq += 1;
      ui.update();
    }

    async function save() {
      if (!view.parsed) return;
      const reply = await ui.call('confirmCommand', { projectId: view.projectId, command: view.parsed });
      if (reply.ok === true) { ui.applyGet(reply); return; }
      view.errors = { [REASON_FIELD[reply.reason] || 'form']: reasonText(reply.reason) };
      go('form');
    }

    // Edit run command: refused while a run is live.
    function edit() {
      if (!ui.isResting()) { ui.flash(reasonText('run_active')); return; }
      view.values = null;
      view.errors = {};
      go('form');
    }

    // The failed build's tail goes into the message box; nothing is sent.
    function sendError(run) {
      const head = jt('chat.liveView.sendError.head', 'The build failed (exit code {code}):', { code: run.exitCode ?? '?' });
      ui.insert({ text: `${head}\n\n\`\`\`\n${lastLines(run.buildTail, 200).join('\n')}\n\`\`\`` });
    }

    return { formNodes, confirmNodes, stoppedNodes, notice, review, go, save, edit, sendError };
  }

  return { createLiveRunForm, lastLines, parseValues, reasonText, showErrors, valuesFromCommand };
});
