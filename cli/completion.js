'use strict';

// `jenny completion bash|zsh|powershell`: a static word list (commands,
// verbs, flags) generated from the grammar, so the shell and the parser can
// never disagree about a flag's name.

const { COMMANDS, COMMAND_VERBS, OPTIONS } = require('./arguments');
const { EXIT_CODES } = require('./exit-codes');

const SHELLS = Object.freeze(['bash', 'zsh', 'powershell']);

function words() {
  const flags = Object.entries(OPTIONS).flatMap(([name, option]) => [`--${name}`, ...(option.short ? [`-${option.short}`] : [])]);
  const verbs = [...new Set(Object.values(COMMAND_VERBS).flat())];
  return [...COMMANDS, ...verbs, ...flags];
}

function script(shell) {
  const list = words();
  if (shell === 'bash') {
    return [
      '# jenny bash completion: eval "$(jenny completion bash)"',
      '_jenny_completion() {',
      '  local cur="${COMP_WORDS[COMP_CWORD]}"',
      `  COMPREPLY=($(compgen -W "${list.join(' ')}" -- "$cur"))`,
      '}',
      'complete -F _jenny_completion jenny',
    ].join('\n');
  }
  if (shell === 'zsh') {
    return [
      '#compdef jenny',
      '# jenny zsh completion: eval "$(jenny completion zsh)"',
      '_jenny_completion() {',
      `  compadd -- ${list.join(' ')}`,
      '}',
      'compdef _jenny_completion jenny',
    ].join('\n');
  }
  return [
    '# jenny PowerShell completion: jenny completion powershell | Out-String | Invoke-Expression',
    'Register-ArgumentCompleter -Native -CommandName jenny -ScriptBlock {',
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    `  @(${list.map((word) => `'${word}'`).join(', ')}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {`,
    "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    '  }',
    '}',
  ].join('\n');
}

function runCompletion({ shell, stdout, stderr }) {
  if (!SHELLS.includes(shell)) {
    stderr.write(`jenny completion needs one of: ${SHELLS.join(', ')}.\n`);
    return EXIT_CODES.USAGE;
  }
  stdout.write(`${script(shell)}\n`);
  return EXIT_CODES.OK;
}

module.exports = { SHELLS, runCompletion, words };
