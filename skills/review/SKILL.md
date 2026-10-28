---
name: Code Review
description: Review the uncommitted changes in the current project for bugs, security problems and data loss, and report each finding with report_findings so it shows as a list the user can act on.
command: review
whenToUse: Use when the user invokes /review or asks for a code review of their changes.
allowedTools:
  - git_status
  - git_diff
  - git_log
  - git_show
  - read_file
  - glob_files
  - grep_search
  - report_findings
---
# Code Review

Review the user's changes the way a careful senior engineer reviews a pull request, then report the
findings with the `report_findings` tool. The user sees them as a list with Fix buttons, so the tool
call is the review; do not write the findings out again in the reply.

## Scope

- Default: the uncommitted work in the project, both unstaged and staged.
- Text after `/review` narrows or changes the scope, for example a path ("src/cart.js"), a commit
  ("the last commit"), or a branch ("against main"). Follow it.
- Keep the review read-only. Do not edit files, run commands, or fix anything unless the user asks
  afterwards.

## Steps

1. Call `git_status` to see which files changed, including untracked ones.
2. Call `git_diff` for the unstaged changes, then `git_diff` with `staged: true` for the staged ones.
   For a commit use `git_show`; for a branch use `git_diff` with `ref` set to it.
3. Read the changed files with `read_file` where the diff alone does not show enough context, for
   example to check how a changed function is called. Read untracked files in full.
4. Call `report_findings` once with every finding. If there is nothing worth reporting, do not call
   it; say the changes look correct and name what you checked.
5. Reply in one or two sentences: how many findings, and which to fix first. Do not repeat them.

## What counts as a finding

Report problems that would make the code do the wrong thing:

- logic errors, off-by-one mistakes, wrong conditions, missing `await`, unhandled errors;
- crashes on inputs the code will actually see (empty lists, missing keys, zero, null);
- security problems (injection, secrets in code or logs, unchecked paths, unsafe permissions);
- data loss or corruption, race conditions, resource leaks;
- a change that breaks a caller, a test, or a documented contract.

Do not report style, formatting, naming, missing comments, or anything a linter or formatter would
catch. Do not report problems in code the change did not touch unless the change makes them worse.

## Writing each finding

- `severity`: `high` when it breaks behaviour or security for real users, `medium` when it breaks
  in an edge case that will happen, `low` when it is a minor risk.
- `title`: one short line naming the problem, for example "subtotal skips the first item".
- `body`: two or three plain sentences: what goes wrong, when, and the smallest fix.
- `file` and `line`: the workspace-relative path and the line in the new version of the file where
  the problem is. Use `end_line` for a range.
- One finding per problem. Merge duplicates. Order does not matter; the tool sorts them.
- Use `scope` for what you reviewed, for example "working tree vs HEAD".
